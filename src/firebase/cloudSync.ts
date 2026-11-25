import { authService } from '../authService.js';
import { socialService } from '../socialService.js';
import { squadMultiplayer } from '../squadMultiplayer.js';
import {
  DEV_DEMO_ENABLED,
  FIREBASE_CONFIG,
  getFirebaseServices,
  isFirebaseConfigured,
  runFirebaseDiagnostics,
} from '../firebaseConfig.js';
import firestoreRulesRaw from '../../firestore.rules?raw';
import databaseRulesRaw from '../../database.rules.json?raw';
import '../apkBridge.js';

type CloudRequestDetail = {
  id: string;
  action: string;
  payload?: Record<string, unknown>;
};

const AUTH_ACTIONS = new Set([
  'init',
  'signInEmail',
  'createAccount',
  'playAsGuest',
  'signInGuest',
  'signInGoogle',
  'sendPasswordReset',
  'upgradeGuest',
  'signOut',
]);

function emitBus(type: string, detail: Record<string, unknown>) {
  document.dispatchEvent(new CustomEvent(type, { detail }));
}

function logFirebaseClientConnection() {
  const services = getFirebaseServices();
  const hostname =
    typeof window !== 'undefined' && window.location ? window.location.hostname : 'unknown';
  const inIframe = typeof window !== 'undefined' ? window.top !== window.self : false;
  console.info('[CloudSync] Firebase client connection check:', {
    configured: isFirebaseConfigured(),
    projectId: FIREBASE_CONFIG.projectId,
    authDomain: FIREBASE_CONFIG.authDomain,
    firestoreDatabaseId: FIREBASE_CONFIG.firestoreDatabaseId,
    authReady: Boolean(services.auth),
    liveFirestore: services.liveFirestore,
    liveRtdb: services.liveRtdb,
    hostname,
    inIframe,
  });
}

// Forward live state changes from Auth, Social/Squads, and Multiplayer Match over sealed document events
let lastSignedInUid: string | null = null;
let lastLoggedAuthSummary = '';

authService.subscribe((state: Record<string, unknown>) => {
  const summaryKey = JSON.stringify({
    ready: Boolean(state.ready),
    signedIn: Boolean(state.signedIn),
    uid: state.uid || null,
    authProvider: state.authProvider || null,
    isAnonymous: Boolean(state.isAnonymous),
    sandboxMode: Boolean(state.sandboxMode),
    lastAuthErrorCode: state.lastAuthErrorCode || null,
  });
  if (summaryKey !== lastLoggedAuthSummary) {
    lastLoggedAuthSummary = summaryKey;
    console.info('[CloudSync] Auth state changed:', {
      ready: Boolean(state.ready),
      signedIn: Boolean(state.signedIn),
      uid: state.uid || null,
      authProvider: state.authProvider || null,
      isAnonymous: Boolean(state.isAnonymous),
      sandboxMode: Boolean(state.sandboxMode),
      statusLabel: state.statusLabel || null,
      ...(state.lastAuthErrorCode ? { errorCode: state.lastAuthErrorCode, error: state.lastAuthError } : {}),
    });
  }

  emitBus('ar:cloud:state', state);
  const uid = (state.uid as string) || null;
  if (uid && uid !== lastSignedInUid) {
    lastSignedInUid = uid;
    socialService.startForUser();
  } else if (!uid && lastSignedInUid) {
    lastSignedInUid = null;
    squadMultiplayer.leaveMatch(true);
    socialService.stop();
  }
});

socialService.subscribe((snapshot: Record<string, unknown>) => {
  emitBus('ar:social:state', snapshot);
});

squadMultiplayer.subscribe((eventType: string, payload: unknown) => {
  emitBus('ar:match:event', { eventType, payload });
});

// Sealed Document Event Bridge (Zero game-state globals exposed on window)
document.addEventListener('ar:cloud:request', async (ev: Event) => {
  const custom = ev as CustomEvent<CloudRequestDetail>;
  const detail = custom.detail;
  if (!detail || !detail.id) return;
  const p = detail.payload || {};
  let result: Record<string, unknown> = { ok: false, error: 'Unknown action' };

  try {
    switch (detail.action) {
      // --- Auth & Cloud Profile ---
      case 'init':
        result = { ok: true, state: await authService.init() };
        break;
      case 'getState':
        result = { ok: true, state: authService.getState(), social: socialService.getSnapshot() };
        break;
      case 'signInEmail':
        result = (await authService.signInWithEmail(p.email, p.password)) as Record<string, unknown>;
        break;
      case 'createAccount':
        result = (await authService.createAccount(
          p.championName,
          p.email,
          p.password,
          p.confirmPassword,
          (p.seedLocal as Record<string, unknown>) || {}
        )) as Record<string, unknown>;
        break;
      case 'playAsGuest':
      case 'signInGuest':
        result = (await authService.playAsGuest(
          String(p.preferredName || ''),
          (p.seedLocal as Record<string, unknown>) || {}
        )) as Record<string, unknown>;
        break;
      case 'signInGoogle':
        result = (await authService.signInWithGoogle(
          (p.seedLocal as Record<string, unknown>) || {}
        )) as Record<string, unknown>;
        break;
      case 'sendPasswordReset':
        result = (await authService.sendPasswordReset(p.email)) as Record<string, unknown>;
        break;
      case 'upgradeGuest':
        result = (await authService.upgradeGuestToEmail(
          p.email,
          p.password,
          String(p.newName || '')
        )) as Record<string, unknown>;
        if (result.ok) await socialService.syncMemberProfile();
        break;
      case 'signOut':
        squadMultiplayer.leaveMatch(true);
        socialService.stop();
        result = (await authService.signOutUser()) as Record<string, unknown>;
        break;
      case 'syncProfile':
        result = (await authService.syncProfile(p)) as Record<string, unknown>;
        if (result.ok) await socialService.syncMemberProfile();
        break;
      case 'submitMatch': {
        const prof = (p.profile as Record<string, unknown>) || p;
        result = (await authService.syncProfile(prof)) as Record<string, unknown>;
        if (result.ok) await socialService.syncMemberProfile();
        break;
      }
      case 'updateDisplayName':
        result = (await authService.updateDisplayName(String(p.displayName || p.newName || ''))) as Record<string, unknown>;
        if (result.ok) await socialService.syncMemberProfile();
        break;
      case 'atomicSpend': {
        const currency = String(p.currency || '');
        const amt = Math.max(0, Math.floor(Number(p.amount || 0)));
        const unlockField = typeof p.unlockField === 'string' ? p.unlockField : null;
        const equipField =
          unlockField === 'unlockedChampions'
            ? 'selectedChampion'
            : unlockField === 'unlockedRunes'
              ? 'equippedRune'
              : unlockField === 'unlockedTrails'
                ? 'equippedTrail'
                : null;
        result = (await authService.spendCurrencyTransaction({
          costCoins: Number(p.costCoins || (currency === 'coins' ? amt : 0)),
          costCrystals: Number(p.costCrystals || (currency === 'crystals' ? amt : 0)),
          costGems: Number(p.costGems || (currency === 'gems' ? amt : 0)),
          costXp: Number(p.costXp || (currency === 'xp' ? amt : 0)),
          unlockField,
          unlockId: typeof p.unlockId === 'string' ? p.unlockId : null,
          equipField,
          statKey: typeof p.statKey === 'string' ? p.statKey : null,
          nextTier: p.nextTier !== undefined ? Number(p.nextTier) : null,
          patch: (p.patch as Record<string, unknown>) || {},
        })) as Record<string, unknown>;
        break;
      }
      case 'resetLocalCache':
        result = authService.resetLocalCacheAndHud() as Record<string, unknown>;
        break;
      case 'getDevFlags':
        result = { ok: true, devDemoEnabled: Boolean(DEV_DEMO_ENABLED) };
        break;
      case 'runFirebaseDiagnostics':
        result = { ok: true, diagnostics: await runFirebaseDiagnostics() };
        break;
      case 'getFirebaseRulesText':
        result = {
          ok: true,
          firestoreRules: firestoreRulesRaw,
          databaseRules: databaseRulesRaw,
        };
        break;

      // --- Friends, Presence, Leaderboard & 4-Slot Squads ---
      case 'refreshFriends':
        result = { ok: true, social: await socialService.refreshFriends() };
        break;
      case 'searchPlayer':
        result = (await socialService.searchPlayer(p.query)) as Record<string, unknown>;
        break;
      case 'sendFriendRequest':
        result = (await socialService.sendFriendRequest(p.query)) as Record<string, unknown>;
        break;
      case 'acceptFriendRequest':
        result = (await socialService.acceptFriendRequest(p.fromUid)) as Record<string, unknown>;
        break;
      case 'declineFriendRequest':
        result = (await socialService.declineFriendRequest(p.fromUid)) as Record<string, unknown>;
        break;
      case 'removeFriend':
        result = (await socialService.removeFriend(p.friendUid)) as Record<string, unknown>;
        break;
      case 'fetchLeaderboard':
        result = (await socialService.fetchLeaderboard(
          p.sortBy === 'eliminations' ? 'eliminations' : 'wins'
        )) as Record<string, unknown>;
        break;
      case 'ensureOwnSquad':
        result = { ok: true, squad: await socialService.ensureOwnSquad() };
        break;
      case 'joinSquadByCode':
        result = (await socialService.joinSquadByCode(p.code)) as Record<string, unknown>;
        break;
      case 'inviteFriend':
        result = (await socialService.inviteFriendToSquad(p.targetUid)) as Record<string, unknown>;
        break;
      case 'respondInvite':
        result = (await socialService.respondToInvite(p.squadId, Boolean(p.accept))) as Record<string, unknown>;
        break;
      case 'toggleReady':
        result = (await socialService.toggleReady()) as Record<string, unknown>;
        break;
      case 'syncChampion':
        await socialService.syncSelectedChampion(p.championId);
        result = { ok: true };
        break;
      case 'promoteLeader':
        result = (await socialService.promoteLeader(p.targetUid)) as Record<string, unknown>;
        break;
      case 'kickMember':
        result = (await socialService.kickMember(p.targetUid)) as Record<string, unknown>;
        break;
      case 'leaveSquad':
        result = (await socialService.leaveSquad(p.createFreshOwn !== false)) as Record<string, unknown>;
        break;
      case 'updatePresence':
        await socialService.updatePresence(String(p.state || 'online'));
        result = { ok: true };
        break;
      case 'setSquadPrivacy':
        result = (await socialService.setSquadPrivacy(Boolean(p.isPrivate))) as Record<string, unknown>;
        break;
      case 'addSandboxTestMate':
        result = (await socialService.addSandboxTestMate(
          String(p.name || 'NovaTide'),
          String(p.championId || 'TIDECALLER')
        )) as Record<string, unknown>;
        break;

      // --- Real-Time Friend-Squad Match Multiplayer ---
      case 'createSquadMatch': {
        const sq = socialService.currentSquad;
        const created = (await squadMultiplayer.createMatch(sq)) as Record<string, unknown>;
        if (created.ok && created.matchId) {
          await socialService.setActiveMatchId(created.matchId);
          await socialService.updatePresence('in_match');
        }
        result = created;
        break;
      }
      case 'joinSquadMatch': {
        const joined = (await squadMultiplayer.joinMatch(String(p.matchId || ''))) as Record<string, unknown>;
        if (joined.ok) {
          await socialService.updatePresence('in_match');
        }
        result = joined;
        break;
      }
      case 'pushPlayerState':
        squadMultiplayer.pushPlayerState(p.state || p, Boolean(p.force));
        result = { ok: true };
        break;
      case 'pushDropPin':
        squadMultiplayer.pushDropPin(Number(p.x || 0), Number(p.y || 0));
        result = { ok: true };
        break;
      case 'pushQuickComm':
        squadMultiplayer.pushQuickComm(String(p.commId || 'enemy'));
        result = { ok: true };
        break;
      case 'pushAoiBots':
        squadMultiplayer.pushAoiBots(
          Array.isArray(p.bots) ? p.bots : [],
          Array.isArray(p.livingHumans) ? p.livingHumans : []
        );
        result = { ok: true };
        break;
      case 'pushWorldState':
        squadMultiplayer.pushWorldState(p.worldState || p, Boolean(p.force));
        result = { ok: true };
        break;
      case 'pushIntent':
        squadMultiplayer.pushIntent(p.intent || p);
        result = { ok: true };
        break;
      case 'pushFx':
        squadMultiplayer.pushFx(p.fx || p);
        result = { ok: true };
        break;
      case 'setMatchStatus':
        await squadMultiplayer.setMatchStatus(String(p.status || 'active'));
        if (p.status === 'finished') {
          await socialService.setActiveMatchId(null);
          await socialService.updatePresence('in_squad');
        }
        result = { ok: true };
        break;
      case 'leaveSquadMatch':
        squadMultiplayer.leaveMatch(p.clearToken !== false);
        await socialService.setActiveMatchId(null);
        await socialService.updatePresence('in_squad');
        result = { ok: true };
        break;
      case 'checkReconnectToken':
        result = { ok: true, matchId: squadMultiplayer.readReconnectToken() };
        break;
    }
  } catch (err) {
    const errObj = err as { code?: string; message?: string } | null;
    const code = typeof errObj?.code === 'string' ? errObj.code : 'cloudsync-exception';
    const message = err instanceof Error ? err.message : 'CloudSync error';
    console.error(`[CloudSync] Action "${detail.action}" threw an exception:`, { code, message });
    result = { ok: false, code, error: message };
  }

  if (AUTH_ACTIONS.has(detail.action) && result && result.ok === false) {
    console.warn(`[CloudSync] Auth action "${detail.action}" failed:`, {
      code: result.code || 'unknown',
      error: result.error || 'Authentication failed',
    });
  }

  emitBus('ar:cloud:response', { id: detail.id, result });
});

// Mark bridge ready so any early UI requests dispatched before ES module load can replay immediately
if (typeof document !== 'undefined' && document.documentElement) {
  document.documentElement.dataset.arCloudReady = '1';
}
emitBus('ar:cloud:ready', { state: authService.getState() });

// Log Firebase client wiring and initialize Auth session persistence immediately on startup
logFirebaseClientConnection();
authService
  .init()
  .then((initState: Record<string, unknown>) => {
    console.info('[CloudSync] Auth initialization settled:', {
      ready: Boolean(initState?.ready),
      signedIn: Boolean(initState?.signedIn),
      uid: initState?.uid || null,
      sandboxMode: Boolean(initState?.sandboxMode),
      statusLabel: initState?.statusLabel || null,
      ...(initState?.lastAuthErrorCode ? { errorCode: initState.lastAuthErrorCode } : {}),
    });
  })
  .catch((err: unknown) => {
    const errObj = err as { code?: string; message?: string } | null;
    console.error('[CloudSync] Startup authService.init() rejected:', {
      code: errObj?.code || 'init-rejected',
      message: err instanceof Error ? err.message : String(err),
    });
  });
