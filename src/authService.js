import {
  setPersistence,
  indexedDBLocalPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  inMemoryPersistence,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInAnonymously,
  linkWithCredential,
  EmailAuthProvider,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  onAuthStateChanged,
  updateProfile,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore';
import {
  FIREBASE_CONFIG,
  getFirebaseServices,
  isFirebaseConfigured,
  isRtdbConfigured,
  isSandboxMode,
  isSimBroadcastEnabled,
  SIM_CHANNEL_NAME,
  SANDBOX_STORAGE_KEYS,
  CLOUD_CACHE_STORAGE_KEYS,
  OperationType,
  handleFirestoreError,
  testFirestoreConnection,
} from './firebaseConfig.js';

// Excludes visually confusing characters 0, O, 1, I
export const FRIEND_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SIM_USERS_KEY = SANDBOX_STORAGE_KEYS.users;
const SIM_SESSION_KEY = SANDBOX_STORAGE_KEYS.session;
const SIM_CODES_KEY = SANDBOX_STORAGE_KEYS.friendCodes;
const RESERVED_NAME_PREFIX_RE = /^(admin|system|warbrite|dev)/i;

export function generateFriendCode(rng = Math.random) {
  let code = '';
  for (let i = 0; i < 4; i++) {
    const idx = Math.floor(rng() * FRIEND_CODE_ALPHABET.length) % FRIEND_CODE_ALPHABET.length;
    code += FRIEND_CODE_ALPHABET[idx];
  }
  return `ARC-${code}`;
}

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return ch;
    }
  });
}

export function validateChampionName(raw) {
  const trimmed = String(raw || '').trim();
  const cleaned = trimmed.replace(/[^a-zA-Z0-9_]/g, '');
  if (!/^[a-zA-Z0-9_]{3,12}$/.test(trimmed) || cleaned.length < 3 || cleaned.length > 12) {
    return { valid: false, cleaned: cleaned.slice(0, 12), error: 'Champion Name must be 3–12 letters, numbers, or underscores.' };
  }
  if (RESERVED_NAME_PREFIX_RE.test(cleaned)) {
    return { valid: false, cleaned: cleaned.slice(0, 12), error: 'That name prefix is reserved (Admin, System, Warbrite, Dev).' };
  }
  return { valid: true, cleaned, error: null };
}

export function sanitizeChampionId(raw) {
  if (raw === 'TIDECALLER' || raw === 'MAGE') return 'TIDECALLER';
  if (raw === 'SHADOW' || raw === 'ASSASSIN') return 'SHADOW';
  return 'BERSERKER';
}

export function sanitizeUnlockedChampions(raw) {
  const list = Array.isArray(raw) ? raw.map(sanitizeChampionId) : [];
  const unique = Array.from(new Set(list));
  if (!unique.includes('BERSERKER')) unique.unshift('BERSERKER');
  return unique.slice(0, 5);
}

export function mergeProfileConflict(localProfile, remoteProfile) {
  if (!remoteProfile || typeof remoteProfile !== 'object') return { ...localProfile };
  if (!localProfile || typeof localProfile !== 'object') return { ...remoteProfile };

  const localUpdated = Number(localProfile.updatedAtMs || 0);
  const remoteUpdated = Number(remoteProfile.updatedAtMs || 0);
  const localScore = (Number(localProfile.level) || 1) * 100000 + (Number(localProfile.xp) || 0);
  const remoteScore = (Number(remoteProfile.level) || 1) * 100000 + (Number(remoteProfile.xp) || 0);
  const preferRemote = remoteScore > localScore || (remoteScore === localScore && remoteUpdated > localUpdated);

  const lc = localProfile.careerStats || {};
  const rc = remoteProfile.careerStats || {};

  const lt = localProfile.statTiers || {};
  const rt = remoteProfile.statTiers || {};
  const mergedStatTiers = {};
  const allowedStatKeys = new Set(['PWR', 'FOC', 'AGI', 'VIT', 'maxHealth', 'movementSpeed', 'attackPower']);
  const allStatKeys = new Set([...Object.keys(lt), ...Object.keys(rt)]);
  if (allStatKeys.size === 0) {
    allStatKeys.add('maxHealth');
    allStatKeys.add('movementSpeed');
    allStatKeys.add('attackPower');
  }
  for (const k of allStatKeys) {
    if (!allowedStatKeys.has(k)) continue;
    mergedStatTiers[k] = Math.max(0, Math.min(25, Math.floor(Math.max(Number(lt[k]) || 0, Number(rt[k]) || 0))));
  }

  const localLevel = Number(localProfile.level) || 1;
  const remoteLevel = Number(remoteProfile.level) || 1;
  const mergedLevel = Math.max(localLevel, remoteLevel);
  const mergedXp =
    localLevel === remoteLevel
      ? Math.max(Number(localProfile.xp) || 0, Number(remoteProfile.xp) || 0)
      : remoteLevel > localLevel
        ? Number(remoteProfile.xp) || 0
        : Number(localProfile.xp) || 0;

  return {
    ...(preferRemote ? localProfile : remoteProfile),
    ...(preferRemote ? remoteProfile : localProfile),
    displayName: (preferRemote ? remoteProfile.displayName : localProfile.displayName) || localProfile.displayName || 'ArcaneHero',
    displayNameLower: String((preferRemote ? remoteProfile.displayName : localProfile.displayName) || 'arcanehero').toLowerCase(),
    friendCode: remoteProfile.friendCode || localProfile.friendCode || generateFriendCode(),
    level: mergedLevel,
    xp: mergedXp,
    coins: Math.max(Number(localProfile.coins) || 0, Number(remoteProfile.coins) || 0),
    crystals: Math.max(Number(localProfile.crystals) || 0, Number(remoteProfile.crystals) || 0),
    gems: Math.max(Number(localProfile.gems) || 0, Number(remoteProfile.gems) || 0),
    unlockedChampions: Array.from(
      new Set([
        ...sanitizeUnlockedChampions(localProfile.unlockedChampions),
        ...sanitizeUnlockedChampions(remoteProfile.unlockedChampions),
      ])
    ).slice(0, 5),
    selectedChampion: sanitizeChampionId(preferRemote ? remoteProfile.selectedChampion : localProfile.selectedChampion),
    unlockedRunes: Array.from(new Set([...(localProfile.unlockedRunes || []), ...(remoteProfile.unlockedRunes || [])])).slice(0, 12),
    equippedRune: (preferRemote ? remoteProfile.equippedRune : localProfile.equippedRune) ?? localProfile.equippedRune ?? null,
    unlockedTrails: Array.from(new Set([...(localProfile.unlockedTrails || ['DEFAULT']), ...(remoteProfile.unlockedTrails || ['DEFAULT'])])).slice(0, 12),
    equippedTrail: (preferRemote ? remoteProfile.equippedTrail : localProfile.equippedTrail) || 'DEFAULT',
    statTiers: mergedStatTiers,
    careerStats: {
      wins: Math.max(Number(lc.wins) || 0, Number(rc.wins) || 0),
      elims: Math.max(Number(lc.elims) || 0, Number(rc.elims) || 0),
      matches: Math.max(Number(lc.matches) || 0, Number(rc.matches) || 0),
      damageDealt: Math.max(Number(lc.damageDealt) || 0, Number(rc.damageDealt) || 0),
      revives: Math.max(Number(lc.revives) || 0, Number(rc.revives) || 0),
      top10: Math.max(Number(lc.top10) || 0, Number(rc.top10) || 0),
    },
    hudLayouts: {
      portrait: (preferRemote ? remoteProfile.hudLayouts?.portrait : localProfile.hudLayouts?.portrait) || localProfile.hudLayouts?.portrait || remoteProfile.hudLayouts?.portrait || null,
      landscape: (preferRemote ? remoteProfile.hudLayouts?.landscape : localProfile.hudLayouts?.landscape) || localProfile.hudLayouts?.landscape || remoteProfile.hudLayouts?.landscape || null,
    },
    updatedAtMs: Math.max(localUpdated, remoteUpdated, Date.now()),
  };
}

function readJsonStorage(key, fallback) {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonStorage(key, value) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {
    // Ignore storage quota errors in restricted WebViews
  }
}

function hashSimPassword(pw) {
  let h = 2166136261;
  const str = `AR_SIM_PW|${String(pw || '')}`;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0;
  }
  return `sim_${h.toString(16)}`;
}

function createSimChannel() {
  if (!isSimBroadcastEnabled()) return null;
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(SIM_CHANNEL_NAME);
  } catch {
    return null;
  }
}

function buildDefaultUserDoc(uid, displayName, authProvider, friendCode, seedLocal = {}) {
  const safeName = validateChampionName(displayName).cleaned || `Arcane_${uid.slice(-4).toUpperCase()}`;
  const now = Date.now();
  return {
    uid,
    displayName: safeName,
    displayNameLower: safeName.toLowerCase(),
    friendCode,
    authProvider,
    isPublic: true,
    createdAtMs: now,
    updatedAtMs: now,
    level: Math.max(1, Math.min(100, Math.floor(Number(seedLocal.level) || 1))),
    xp: Math.max(0, Math.floor(Number(seedLocal.xp) || 0)),
    coins: Math.max(0, Math.floor(Number(seedLocal.coins ?? seedLocal.gold) || 0)),
    crystals: Math.max(0, Math.floor(Number(seedLocal.crystals ?? seedLocal.astralCrystals) || 0)),
    gems: Math.max(0, Math.floor(Number(seedLocal.gems) || 0)),
    unlockedChampions: sanitizeUnlockedChampions(seedLocal.unlockedChampions || seedLocal.unlockedFighters),
    selectedChampion: sanitizeChampionId(seedLocal.selectedChampion || seedLocal.selectedFighter),
    unlockedRunes: Array.isArray(seedLocal.unlockedRunes) ? seedLocal.unlockedRunes.slice(0, 12) : [],
    equippedRune: seedLocal.equippedRune || null,
    unlockedTrails: Array.isArray(seedLocal.unlockedTrails) ? seedLocal.unlockedTrails.slice(0, 12) : ['DEFAULT'],
    equippedTrail: seedLocal.equippedTrail || 'DEFAULT',
    statTiers:
      seedLocal.statTiers && typeof seedLocal.statTiers === 'object' && Object.keys(seedLocal.statTiers).length > 0
        ? seedLocal.statTiers
        : { maxHealth: 0, movementSpeed: 0, attackPower: 0 },
    careerStats: {
      wins: Math.max(0, Math.floor(Number(seedLocal.careerStats?.wins ?? seedLocal.wins) || 0)),
      elims: Math.max(0, Math.floor(Number(seedLocal.careerStats?.elims ?? seedLocal.eliminations) || 0)),
      matches: Math.max(0, Math.floor(Number(seedLocal.careerStats?.matches ?? seedLocal.matches) || 0)),
      damageDealt: Math.max(0, Math.floor(Number(seedLocal.careerStats?.damageDealt) || 0)),
      revives: Math.max(0, Math.floor(Number(seedLocal.careerStats?.revives) || 0)),
      top10: Math.max(0, Math.floor(Number(seedLocal.careerStats?.top10) || 0)),
    },
    hudLayouts: {
      portrait: seedLocal.hudLayouts?.portrait || seedLocal.hudLayoutPortrait || null,
      landscape: seedLocal.hudLayouts?.landscape || seedLocal.hudLayoutLandscape || null,
    },
  };
}

export function formatFriendlyAuthError(err) {
  const code = String(err?.code || '').toLowerCase();
  const msg = String(err?.message || '');
  const host =
    typeof window !== 'undefined' && window.location && window.location.hostname
      ? window.location.hostname
      : 'this domain';

  if (code === 'auth/unauthorized-domain') {
    return `Domain "${host}" is not authorized yet. In Firebase Console → Authentication → Settings → Authorized domains, add "${host}".`;
  }
  if (code === 'auth/operation-not-allowed' || code === 'auth/admin-restricted-operation' || code === 'auth/restricted-operation') {
    return 'This sign-in provider is disabled in Firebase Console. Go to Authentication → Sign-in method and enable Email/Password, Google, and Anonymous.';
  }
  if (code === 'auth/email-already-in-use' || code === 'auth/credential-already-in-use') {
    return 'That email is already linked to an Arcane account. Switch to Sign In or tap Forgot Password.';
  }
  if (code === 'auth/wrong-password' || code === 'auth/invalid-credential' || code === 'auth/invalid-login-credentials') {
    return "Incorrect email or password — or switch to Create Account if you haven't registered yet.";
  }
  if (code === 'auth/user-not-found') {
    return 'No Arcane account found with that email. Switch to Create Account to register.';
  }
  if (code === 'auth/weak-password') {
    return 'Password is too weak — please use at least 6 characters.';
  }
  if (code === 'auth/invalid-email') {
    return 'Please enter a valid email address.';
  }
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return 'Google Sign-In popup was closed before completing. Tap Google Sign-In again to retry.';
  }
  if (code === 'auth/popup-blocked') {
    const inIframe = typeof window !== 'undefined' && window.top !== window.self;
    return inIframe
      ? 'Your browser blocked the Google Sign-In popup. Allow popups, open the app in a new tab, or use Email / Play as Guest.'
      : 'Your browser blocked the Google Sign-In popup. Allow popups or tap Google Sign-In again.';
  }
  if (code === 'auth/network-request-failed') {
    return 'Network error — check your mobile data or Wi-Fi connection and try again.';
  }
  if (code === 'auth/too-many-requests') {
    return 'Too many login attempts. Please wait a minute and try again.';
  }
  if (code === 'permission-denied' || msg.toLowerCase().includes('permission-denied') || msg.toLowerCase().includes('missing or insufficient permissions')) {
    return 'Firestore permission denied. Open Settings → Save Data, tap "Copy firestore.rules", and publish it in Firebase Console → Firestore → Rules.';
  }
  return err instanceof Error ? err.message : 'Authentication failed. Please try again.';
}

function shouldFallbackToSandbox(err) {
  // Never fall back silently into Local Sandbox Mode when live Firebase is configured;
  // surface exact actionable setup messages instead.
  if (isFirebaseConfigured()) return false;
  const code = String(err?.code || '');
  return (
    code === 'auth/operation-not-allowed' ||
    code === 'auth/admin-restricted-operation' ||
    code === 'auth/restricted-operation' ||
    code === 'auth/configuration-not-found' ||
    code === 'auth/unauthorized-domain' ||
    code === 'auth/api-key-not-valid' ||
    code === 'auth/internal-error'
  );
}

function shouldFallbackToRedirect(err) {
  const code = String(err?.code || '').toLowerCase();
  return (
    code === 'auth/popup-blocked' ||
    code === 'auth/operation-not-supported-in-this-environment' ||
    code === 'auth/web-storage-unsupported' ||
    code === 'auth/internal-error'
  );
}

function withAuthTimeout(promise, ms, fallbackValue = null) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallbackValue), ms)),
  ]);
}

function logAuthError(context, err) {
  const code = String(err?.code || 'unknown');
  const message = err instanceof Error ? err.message : String(err || 'Unknown auth error');
  const hostname =
    typeof window !== 'undefined' && window.location ? window.location.hostname : 'unknown';
  const inIframe =
    typeof window !== 'undefined' ? window.top !== window.self : false;
  console.error(`[FirebaseAuth] ${context} failed:`, {
    code,
    message,
    hostname,
    authDomain: FIREBASE_CONFIG.authDomain,
    projectId: FIREBASE_CONFIG.projectId,
    inIframe,
  });
  return code;
}

class AuthServiceImpl {
  constructor() {
    this.user = null;
    this.profile = null;
    this.ready = false;
    this.lastSyncedAt = 0;
    this.lastAuthError = null;
    this.lastAuthErrorCode = null;
    this.sandboxAuth = !isFirebaseConfigured();
    this.sandboxRtdb = !isRtdbConfigured();
    this._ensurePromises = new Map();
    this._bgPersistPromises = new Map();
    this._pendingAuthSeed = null;
    this._initPromise = null;
    this.listeners = new Set();
    this.channel = createSimChannel();
    if (this.channel) {
      this.channel.onmessage = (ev) => {
        if (ev?.data?.type === 'auth:profile_updated' && this.user && ev.data.uid === this.user.uid) {
          this.profile = mergeProfileConflict(this.profile, ev.data.profile);
          this._emit();
        }
      };
    }
  }

  _persistCloudCache(profile) {
    if (!profile || this.sandboxAuth) return;
    writeJsonStorage(CLOUD_CACHE_STORAGE_KEYS.profile, profile);
    writeJsonStorage(CLOUD_CACHE_STORAGE_KEYS.meta, { lastSyncedAt: this.lastSyncedAt || Date.now() });
  }

  getState() {
    const isSandbox = this.sandboxAuth;
    const provider = this.profile?.authProvider || (this.user?.isAnonymous ? 'anonymous' : 'password');
    let statusLabel = this.sandboxAuth ? 'Local Sandbox' : 'Live Cloud Ready';
    if (!this.sandboxAuth && this.user) {
      statusLabel = this.user.isAnonymous
        ? 'Live Cloud · Guest'
        : provider === 'google'
          ? 'Live Cloud · Google'
          : 'Live Cloud · Email';
    } else if (this.user && this.sandboxAuth) {
      statusLabel = this.user.isAnonymous ? 'Local Sandbox (Guest)' : 'Local Sandbox';
    }
    return {
      ready: this.ready,
      configured: isFirebaseConfigured(),
      rtdbConfigured: isRtdbConfigured(),
      sandboxMode: isSandbox,
      sandboxAuth: this.sandboxAuth,
      signedIn: Boolean(this.user),
      isAnonymous: Boolean(this.user?.isAnonymous),
      uid: this.user?.uid || null,
      email: this.user?.email || null,
      displayName: this.profile?.displayName || this.user?.displayName || null,
      friendCode: this.profile?.friendCode || null,
      authProvider: provider,
      profile: this.profile,
      lastSyncedAt: this.lastSyncedAt,
      lastAuthError: this.lastAuthError,
      lastAuthErrorCode: this.lastAuthErrorCode,
      statusLabel,
    };
  }

  subscribe(fn) {
    this.listeners.add(fn);
    fn(this.getState());
    return () => this.listeners.delete(fn);
  }

  _emit() {
    const snap = this.getState();
    this.listeners.forEach((fn) => {
      try {
        fn(snap);
      } catch {
        // isolate subscriber errors
      }
    });
  }

  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._initOnce();
    return this._initPromise;
  }

  async _initOnce() {
    const { auth } = getFirebaseServices();
    if (!auth || this.sandboxAuth) {
      console.warn('[FirebaseAuth] Auth SDK unavailable or sandbox active; restoring local sandbox session.', {
        hasAuth: Boolean(auth),
        sandboxAuth: this.sandboxAuth,
        configured: isFirebaseConfigured(),
      });
      this._restoreSandboxSession();
      this.ready = true;
      this._emit();
      return this.getState();
    }

    // Configure auth persistence with bounded timeout so strict WebViews/iframes never stall
    try {
      await withAuthTimeout(
        setPersistence(auth, indexedDBLocalPersistence)
          .catch((e1) => {
            console.warn('[FirebaseAuth] indexedDBLocalPersistence unavailable, falling back to browserLocalPersistence:', e1?.code || e1?.message);
            return setPersistence(auth, browserLocalPersistence);
          })
          .catch((e2) => {
            console.warn('[FirebaseAuth] browserLocalPersistence unavailable, falling back to browserSessionPersistence:', e2?.code || e2?.message);
            return setPersistence(auth, browserSessionPersistence);
          })
          .catch((e3) => {
            console.warn('[FirebaseAuth] browserSessionPersistence unavailable, falling back to inMemoryPersistence:', e3?.code || e3?.message);
            return setPersistence(auth, inMemoryPersistence);
          }),
        1500,
        null
      );
    } catch (persistErr) {
      logAuthError('setPersistence', persistErr);
    }

    // Verify Firestore connectivity asynchronously (non-blocking)
    testFirestoreConnection();

    // Complete mobile Chrome Google signInWithRedirect return concurrently without blocking onAuthStateChanged
    withAuthTimeout(
      getRedirectResult(auth)
        .then(async (redirectResult) => {
          if (redirectResult && redirectResult.user) {
            const fbUser = redirectResult.user;
            console.info('[FirebaseAuth] Redirect sign-in completed:', {
              uid: fbUser.uid,
              providerId: 'google',
            });
            this.sandboxAuth = false;
            this.lastAuthError = null;
            this.lastAuthErrorCode = null;
            this.user = {
              uid: fbUser.uid,
              email: fbUser.email || null,
              displayName: fbUser.displayName || null,
              isAnonymous: Boolean(fbUser.isAnonymous),
              providerId: 'google',
            };
            await this._ensureCloudProfile(fbUser, fbUser.displayName || null);
            this._emit();
          }
          return redirectResult;
        })
        .catch((err) => {
          this.lastAuthErrorCode = logAuthError('getRedirectResult', err);
          this.lastAuthError = formatFriendlyAuthError(err);
          this._emit();
          return null;
        }),
      3000,
      null
    );

    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        this.ready = true;
        this._emit();
        resolve(this.getState());
      };

      onAuthStateChanged(
        auth,
        async (fbUser) => {
          console.info('[FirebaseAuth] onAuthStateChanged:', {
            signedIn: Boolean(fbUser),
            uid: fbUser?.uid || null,
            isAnonymous: Boolean(fbUser?.isAnonymous),
            providers: fbUser?.providerData?.map((p) => p.providerId) || [],
          });
          if (fbUser) {
            this.sandboxAuth = false;
            this.lastAuthError = null;
            this.lastAuthErrorCode = null;
            this.user = {
              uid: fbUser.uid,
              email: fbUser.email || null,
              displayName: fbUser.displayName || null,
              isAnonymous: Boolean(fbUser.isAnonymous),
              providerId: fbUser.isAnonymous
                ? 'anonymous'
                : fbUser.providerData?.some((p) => p.providerId === 'google.com')
                  ? 'google'
                  : 'password',
            };
            await this._ensureCloudProfile(fbUser);
          } else {
            if (!isFirebaseConfigured()) {
              const simSess = readJsonStorage(SIM_SESSION_KEY, null);
              if (simSess && simSess.uid) {
                this._restoreSandboxSession();
              } else {
                this.user = null;
                this.profile = null;
              }
            } else {
              this.user = null;
              this.profile = null;
            }
          }
          done();
          this._emit();
        },
        (observerErr) => {
          this.lastAuthErrorCode = logAuthError('onAuthStateChanged', observerErr);
          this.lastAuthError = formatFriendlyAuthError(observerErr);
          done();
          this._emit();
        }
      );

      setTimeout(() => {
        if (!settled) {
          console.warn('[FirebaseAuth] Initial onAuthStateChanged took >2200ms; unlocking UI while listener stays active.');
        }
        done();
      }, 2200);
    });
  }

  _restoreSandboxSession() {
    const sess = readJsonStorage(SIM_SESSION_KEY, null);
    if (!sess || !sess.uid) {
      this.user = null;
      this.profile = null;
      return;
    }
    const users = readJsonStorage(SIM_USERS_KEY, {});
    const record = users[sess.uid];
    if (!record) {
      this.user = null;
      this.profile = null;
      return;
    }
    this.sandboxAuth = true;
    this.user = {
      uid: record.uid,
      email: record.email || null,
      displayName: record.profile.displayName,
      isAnonymous: record.profile.authProvider === 'anonymous',
      providerId: record.profile.authProvider,
    };
    this.profile = record.profile;
  }

  _claimSandboxFriendCode(uid, displayName) {
    const codes = readJsonStorage(SIM_CODES_KEY, {});
    for (let attempt = 0; attempt < 25; attempt++) {
      const code = generateFriendCode();
      if (!codes[code]) {
        codes[code] = { uid, displayName };
        writeJsonStorage(SIM_CODES_KEY, codes);
        return code;
      }
    }
    const fallback = `ARC-${uid.slice(-4).toUpperCase().replace(/[^A-Z2-9]/g, 'X').padEnd(4, 'X')}`;
    codes[fallback] = { uid, displayName };
    writeJsonStorage(SIM_CODES_KEY, codes);
    return fallback;
  }

  async _claimFirestoreFriendCode(db, uid, displayName) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = generateFriendCode();
      const codeRef = doc(db, 'friendCodes', code);
      try {
        const snap = await withAuthTimeout(getDoc(codeRef), 3500, '__timeout__');
        if (snap === '__timeout__') break;
        if (!snap.exists()) {
          await withAuthTimeout(
            setDoc(codeRef, {
              uid,
              displayName,
              createdAt: serverTimestamp(),
            }),
            3500,
            null
          );
          return code;
        }
      } catch {
        // Retry with another unique ARC-XXXX code or fall back to deterministic local code
      }
    }
    return this._claimSandboxFriendCode(uid, displayName);
  }

  async _ensureCloudProfile(fbUser, preferredName = null, seedLocal = {}, opts = {}) {
    const uid = fbUser.uid;
    if (this._ensurePromises.has(uid)) {
      return this._ensurePromises.get(uid);
    }
    const pending = this._pendingAuthSeed;
    this._pendingAuthSeed = null;
    const effPreferredName = preferredName || pending?.preferredName || null;
    const effSeedLocal =
      seedLocal && Object.keys(seedLocal).length > 0 ? seedLocal : pending?.seedLocal || {};
    const isNewAccount = Boolean(opts?.isNewAccount || pending?.isNewAccount);

    const task = this._ensureCloudProfileCore(fbUser, effPreferredName, effSeedLocal, isNewAccount).finally(() => {
      if (this._ensurePromises.get(uid) === task) {
        this._ensurePromises.delete(uid);
      }
    });
    this._ensurePromises.set(uid, task);
    return task;
  }

  _persistNewProfileInBackground(db, uid, docData) {
    if (!db || !uid || !docData) return;
    if (this._bgPersistPromises.has(uid)) return;
    const ref = doc(db, 'users', uid);
    const task = (async () => {
      try {
        // Reserve unique friendCode in Firestore (fall back to another if taken)
        let claimedCode = docData.friendCode;
        try {
          const codeRef = doc(db, 'friendCodes', claimedCode);
          const codeSnap = await withAuthTimeout(getDoc(codeRef), 3500, '__timeout__');
          if (codeSnap && codeSnap !== '__timeout__' && !codeSnap.exists()) {
            await withAuthTimeout(
              setDoc(codeRef, {
                uid,
                displayName: docData.displayName,
                createdAt: serverTimestamp(),
              }),
              3500,
              null
            );
          } else if (codeSnap && codeSnap !== '__timeout__' && codeSnap.exists() && codeSnap.data()?.uid !== uid) {
            claimedCode = await this._claimFirestoreFriendCode(db, uid, docData.displayName);
          }
        } catch {
          // Non-blocking: continue creating users/{uid}
        }

        const finalDoc = claimedCode !== docData.friendCode ? { ...docData, friendCode: claimedCode } : docData;
        if (this.user?.uid === uid) {
          this.profile = mergeProfileConflict(this.profile || finalDoc, finalDoc);
          this.profile.friendCode = claimedCode;
          this._persistCloudCache(this.profile);
        }

        const existingSnap = await withAuthTimeout(getDoc(ref), 3500, '__timeout__');
        if (existingSnap && existingSnap !== '__timeout__' && !existingSnap.exists()) {
          await withAuthTimeout(
            setDoc(ref, {
              ...finalDoc,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            }),
            5000,
            null
          );
          if (this.user?.uid === uid) {
            this.lastSyncedAt = Date.now();
            this._emit();
          }
        }
      } catch {
        // Never block or break an active signed-in session if background write retries later
      } finally {
        if (this._bgPersistPromises.get(uid) === task) {
          this._bgPersistPromises.delete(uid);
        }
      }
    })();
    this._bgPersistPromises.set(uid, task);
  }

  async _ensureCloudProfileCore(fbUser, preferredName = null, seedLocal = {}, isNewAccount = false) {
    const { db } = getFirebaseServices();
    const uid = fbUser.uid;
    const provider = fbUser.isAnonymous
      ? 'anonymous'
      : fbUser.providerData?.some((p) => p.providerId === 'google.com')
        ? 'google'
        : 'password';
    const rawCandidate = String(preferredName || fbUser.displayName || seedLocal.displayName || '')
      .replace(/[^a-zA-Z0-9_]/g, '')
      .slice(0, 12);
    const validCandidate = validateChampionName(rawCandidate);
    const fallbackName = validCandidate.valid
      ? validCandidate.cleaned
      : `Arcane_${uid.slice(-4).replace(/[^a-zA-Z0-9]/g, 'X').toUpperCase()}`;

    if (!db) {
      const code = this._claimSandboxFriendCode(uid, fallbackName);
      this.profile = buildDefaultUserDoc(uid, fallbackName, provider, code, seedLocal);
      return this.profile;
    }

    // Fast path for brand-new accounts (Create Account / Play as Guest):
    // Return immediately (<1s total sign-in) and persist friendCode + users/{uid} in the background.
    if (isNewAccount) {
      const quickCode = this._claimSandboxFriendCode(uid, fallbackName);
      const docData = buildDefaultUserDoc(uid, fallbackName, provider, quickCode, seedLocal);
      this.profile = docData;
      this._persistCloudCache(docData);
      this._persistNewProfileInBackground(db, uid, docData);
      return this.profile;
    }

    const userPath = `users/${uid}`;
    const ref = doc(db, 'users', uid);
    try {
      const snap = await withAuthTimeout(getDoc(ref), 2800, '__timeout__');
      if (snap && snap !== '__timeout__' && snap.exists()) {
        const remote = snap.data();
        const remoteNormalized = {
          ...remote,
          displayName: remote.displayName || remote.playerName || fallbackName,
          displayNameLower: (remote.displayNameLower || remote.displayName || remote.playerName || fallbackName).toLowerCase(),
          coins: Number(remote.coins ?? remote.gold ?? 0),
          crystals: Number(remote.crystals ?? remote.astralCrystals ?? 0),
          gems: Number(remote.gems ?? 0),
          unlockedChampions: sanitizeUnlockedChampions(remote.unlockedChampions || remote.unlockedFighters),
          selectedChampion: sanitizeChampionId(remote.selectedChampion || remote.selectedFighter),
          careerStats: remote.careerStats || {
            wins: Number(remote.wins || 0),
            elims: Number(remote.eliminations || 0),
            matches: Number(remote.matches || 0),
            damageDealt: 0,
            revives: 0,
            top10: 0,
          },
          hudLayouts: remote.hudLayouts || {
            landscape: remote.hudLayoutLandscape || null,
            portrait: remote.hudLayoutPortrait || null,
          },
          friendCode: remote.friendCode || this._claimSandboxFriendCode(uid, remote.displayName || fallbackName),
          authProvider: remote.authProvider || provider,
        };
        this.profile = mergeProfileConflict(
          seedLocal.displayName ? buildDefaultUserDoc(uid, fallbackName, provider, remoteNormalized.friendCode, seedLocal) : remoteNormalized,
          remoteNormalized
        );
        this.lastSyncedAt = Date.now();
        this._persistCloudCache(this.profile);
        return this.profile;
      }

      // First-time Google/Email doc missing OR Firestore slow: enter lobby immediately and sync in background
      const cached = readJsonStorage(CLOUD_CACHE_STORAGE_KEYS.profile, null);
      if (snap === '__timeout__' && cached && cached.uid === uid) {
        this.profile = cached;
        return this.profile;
      }
      const friendCode = this._claimSandboxFriendCode(uid, fallbackName);
      const docData = buildDefaultUserDoc(uid, fallbackName, provider, friendCode, seedLocal);
      this.profile = docData;
      this._persistCloudCache(docData);
      this._persistNewProfileInBackground(db, uid, docData);
      return this.profile;
    } catch (err) {
      try {
        handleFirestoreError(err, OperationType.WRITE, userPath);
      } catch {
        // Keep login non-blocking even if Firestore rules need publishing; surface clear message in diagnostics
        const code = this._claimSandboxFriendCode(uid, fallbackName);
        this.profile = buildDefaultUserDoc(uid, fallbackName, provider, code, seedLocal);
        this._persistCloudCache(this.profile);
        return this.profile;
      }
    }
  }

  _saveSandboxAccount(uid, email, password, profile) {
    const users = readJsonStorage(SIM_USERS_KEY, {});
    users[uid] = {
      uid,
      email: email ? String(email).trim().toLowerCase() : null,
      passwordHash: password ? hashSimPassword(password) : users[uid]?.passwordHash || null,
      profile,
    };
    writeJsonStorage(SIM_USERS_KEY, users);
    writeJsonStorage(SIM_SESSION_KEY, { uid, ts: Date.now() });
    this.sandboxAuth = true;
    this.user = {
      uid,
      email: users[uid].email,
      displayName: profile.displayName,
      isAnonymous: profile.authProvider === 'anonymous',
      providerId: profile.authProvider,
    };
    this.profile = profile;
    if (this.channel) {
      this.channel.postMessage({ type: 'auth:profile_updated', uid, profile });
    }
    this._emit();
  }

  async signInWithEmail(email, password) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) return { ok: false, error: 'Please enter a valid email address.' };
    if (!password || String(password).length < 6) return { ok: false, error: 'Password must be at least 6 characters.' };

    const { auth } = getFirebaseServices();
    if (auth && !this.sandboxAuth) {
      try {
        const cred = await signInWithEmailAndPassword(auth, cleanEmail, password);
        this.user = {
          uid: cred.user.uid,
          email: cred.user.email,
          displayName: cred.user.displayName,
          isAnonymous: false,
          providerId: 'password',
        };
        await this._ensureCloudProfile(cred.user);
        this._emit();
        return { ok: true, state: this.getState() };
      } catch (err) {
        const code = logAuthError('signInWithEmail', err);
        this.lastAuthErrorCode = code;
        this.lastAuthError = formatFriendlyAuthError(err);
        if (!shouldFallbackToSandbox(err)) {
          return { ok: false, code, error: this.lastAuthError };
        }
        this.sandboxAuth = true;
      }
    }

    // Local Sandbox Sign-In
    const users = readJsonStorage(SIM_USERS_KEY, {});
    const found = Object.values(users).find((u) => u.email === cleanEmail);
    if (!found) {
      return { ok: false, error: 'No local sandbox account found for that email. Switch to Create Account.' };
    }
    if (found.passwordHash && found.passwordHash !== hashSimPassword(password)) {
      return { ok: false, error: 'Incorrect email or password.' };
    }
    this._saveSandboxAccount(found.uid, found.email, null, found.profile);
    return { ok: true, sandbox: true, state: this.getState() };
  }

  async createAccount(championName, email, password, confirmPassword, seedLocal = {}) {
    const nameCheck = validateChampionName(championName);
    if (!nameCheck.valid) return { ok: false, error: nameCheck.error };
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) return { ok: false, error: 'Please enter a valid email address.' };
    if (!password || String(password).length < 6) return { ok: false, error: 'Password must be at least 6 characters.' };
    if (confirmPassword !== undefined && password !== confirmPassword) {
      return { ok: false, error: 'Passwords do not match.' };
    }

    const { auth } = getFirebaseServices();
    if (auth && !this.sandboxAuth) {
      try {
        this._pendingAuthSeed = { preferredName: nameCheck.cleaned, seedLocal, isNewAccount: true };
        const cred = await createUserWithEmailAndPassword(auth, cleanEmail, password);
        updateProfile(cred.user, { displayName: nameCheck.cleaned }).catch(() => null);
        this.user = {
          uid: cred.user.uid,
          email: cred.user.email,
          displayName: nameCheck.cleaned,
          isAnonymous: false,
          providerId: 'password',
        };
        await this._ensureCloudProfile(cred.user, nameCheck.cleaned, seedLocal, { isNewAccount: true });
        this._emit();
        return { ok: true, state: this.getState() };
      } catch (err) {
        this._pendingAuthSeed = null;
        const code = logAuthError('createAccount', err);
        this.lastAuthErrorCode = code;
        this.lastAuthError = formatFriendlyAuthError(err);
        if (!shouldFallbackToSandbox(err)) {
          return { ok: false, code, error: this.lastAuthError };
        }
        this.sandboxAuth = true;
      }
    }

    // Local Sandbox Create Account
    const users = readJsonStorage(SIM_USERS_KEY, {});
    if (Object.values(users).some((u) => u.email === cleanEmail)) {
      return { ok: false, error: 'That email is already registered in this browser.' };
    }
    const uid = `sim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const code = this._claimSandboxFriendCode(uid, nameCheck.cleaned);
    const profile = buildDefaultUserDoc(uid, nameCheck.cleaned, 'password', code, seedLocal);
    this._saveSandboxAccount(uid, cleanEmail, password, profile);
    return { ok: true, sandbox: true, state: this.getState() };
  }

  async playAsGuest(preferredName = '', seedLocal = {}) {
    const trimmed = String(preferredName || '').trim();
    let finalName = '';
    if (trimmed) {
      const check = validateChampionName(trimmed);
      if (!check.valid) return { ok: false, error: check.error };
      finalName = check.cleaned;
    } else {
      const suffix = Math.floor(1000 + Math.random() * 9000);
      finalName = `Arcane_${suffix}`;
    }

    const { auth } = getFirebaseServices();
    if (auth && !this.sandboxAuth) {
      try {
        this._pendingAuthSeed = { preferredName: finalName, seedLocal, isNewAccount: true };
        const cred = await signInAnonymously(auth);
        updateProfile(cred.user, { displayName: finalName }).catch(() => null);
        this.user = {
          uid: cred.user.uid,
          email: null,
          displayName: finalName,
          isAnonymous: true,
          providerId: 'anonymous',
        };
        await this._ensureCloudProfile(cred.user, finalName, seedLocal, { isNewAccount: true });
        this._emit();
        return { ok: true, state: this.getState() };
      } catch (err) {
        this._pendingAuthSeed = null;
        const code = logAuthError('playAsGuest', err);
        this.lastAuthErrorCode = code;
        this.lastAuthError = formatFriendlyAuthError(err);
        if (!shouldFallbackToSandbox(err)) {
          return { ok: false, code, error: this.lastAuthError };
        }
        this.sandboxAuth = true;
      }
    }

    const uid = `guest_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const code = this._claimSandboxFriendCode(uid, finalName);
    const profile = buildDefaultUserDoc(uid, finalName, 'anonymous', code, seedLocal);
    this._saveSandboxAccount(uid, null, null, profile);
    return { ok: true, sandbox: true, state: this.getState() };
  }

  async signInWithGoogle(seedLocal = {}) {
    // 1. Native Android APK WebView Hook (when running inside native wrapper)
    const bridge = typeof window !== 'undefined' ? window.ArcaneNativeBridge : null;
    if (bridge && bridge.isNativeApk && typeof bridge.signInWithGoogle === 'function') {
      try {
        const nativeRes = await bridge.signInWithGoogle();
        if (nativeRes && nativeRes.ok) {
          const uid = nativeRes.uid || `apk_${Date.now().toString(36)}`;
          const name = validateChampionName(nativeRes.displayName || 'ArcaneAPK').cleaned || 'ArcaneAPK';
          const code = this._claimSandboxFriendCode(uid, name);
          const profile = buildDefaultUserDoc(uid, name, 'google', code, seedLocal);
          this._saveSandboxAccount(uid, nativeRes.email || null, null, profile);
          return { ok: true, nativeApk: true, state: this.getState() };
        }
        return { ok: false, error: nativeRes?.error || 'Google Sign-In cancelled.' };
      } catch (err) {
        return { ok: false, error: formatFriendlyAuthError(err) };
      }
    }

    // 2. Live Web & Mobile Chrome: try signInWithPopup first, then auto-fallback to signInWithRedirect
    const { auth } = getFirebaseServices();
    if (auth && !this.sandboxAuth) {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      try {
        const cred = await signInWithPopup(auth, provider);
        this.sandboxAuth = false;
        this.user = {
          uid: cred.user.uid,
          email: cred.user.email || null,
          displayName: cred.user.displayName || null,
          isAnonymous: false,
          providerId: 'google',
        };
        await this._ensureCloudProfile(cred.user, cred.user.displayName || null, seedLocal);
        this._emit();
        return { ok: true, state: this.getState() };
      } catch (popupErr) {
        const popupCode = logAuthError('signInWithGoogle(popup)', popupErr);
        if (shouldFallbackToRedirect(popupErr) && typeof window !== 'undefined' && window.top === window.self) {
          try {
            console.info('[FirebaseAuth] Falling back from popup to signInWithRedirect:', { popupCode });
            await signInWithRedirect(auth, provider);
            return { ok: true, redirecting: true };
          } catch (redirErr) {
            const redirCode = logAuthError('signInWithGoogle(redirect)', redirErr);
            this.lastAuthErrorCode = redirCode;
            this.lastAuthError = formatFriendlyAuthError(redirErr);
            return { ok: false, code: redirCode, error: this.lastAuthError };
          }
        }
        if (!shouldFallbackToSandbox(popupErr)) {
          this.lastAuthErrorCode = popupCode;
          this.lastAuthError = formatFriendlyAuthError(popupErr);
          return { ok: false, code: popupCode, error: this.lastAuthError };
        }
      }
    }

    // 3. Offline / Unconfigured Sandbox Fallback
    const uid = `google_sim_${Date.now().toString(36)}`;
    const name = validateChampionName(seedLocal.displayName || 'ArcanePro').cleaned || 'ArcanePro';
    const code = this._claimSandboxFriendCode(uid, name);
    const profile = buildDefaultUserDoc(uid, name, 'google', code, seedLocal);
    this._saveSandboxAccount(uid, 'champion@arcane.local', null, profile);
    return {
      ok: true,
      sandbox: true,
      message: 'Signed in via Local Sandbox Preview.',
      state: this.getState(),
    };
  }

  async sendPasswordReset(email) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) return { ok: false, error: 'Enter your email address first.' };
    const { auth } = getFirebaseServices();
    if (auth && !this.sandboxAuth) {
      try {
        await sendPasswordResetEmail(auth, cleanEmail);
        return { ok: true, message: `Password reset email sent to ${cleanEmail}.` };
      } catch (err) {
        const code = logAuthError('sendPasswordReset', err);
        if (!shouldFallbackToSandbox(err)) {
          return { ok: false, code, error: formatFriendlyAuthError(err) };
        }
      }
    }
    return { ok: true, sandbox: true, message: `Sandbox mode: password reset instructions simulated for ${cleanEmail}.` };
  }

  async upgradeGuestToEmail(email, password, newName = '') {
    if (!this.user) return { ok: false, error: 'Sign in as Guest first.' };
    if (!this.user.isAnonymous) return { ok: false, error: 'Account is already permanently secured.' };
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) return { ok: false, error: 'Please enter a valid email address.' };
    if (!password || String(password).length < 6) return { ok: false, error: 'Password must be at least 6 characters.' };

    let displayName = this.profile?.displayName || this.user.displayName || 'ArcaneHero';
    if (newName && newName.trim()) {
      const check = validateChampionName(newName);
      if (!check.valid) return { ok: false, error: check.error };
      displayName = check.cleaned;
    }

    const { auth, db } = getFirebaseServices();
    if (auth && auth.currentUser && !this.sandboxAuth) {
      try {
        const credential = EmailAuthProvider.credential(cleanEmail, password);
        const linked = await linkWithCredential(auth.currentUser, credential);
        await updateProfile(linked.user, { displayName }).catch(() => null);
        this.user = {
          uid: linked.user.uid,
          email: linked.user.email,
          displayName,
          isAnonymous: false,
          providerId: 'password',
        };
        if (this.profile) {
          this.profile = {
            ...this.profile,
            displayName,
            displayNameLower: displayName.toLowerCase(),
            authProvider: 'password',
            updatedAtMs: Date.now(),
          };
          this._persistCloudCache(this.profile);
          if (db) {
            const userRef = doc(db, 'users', linked.user.uid);
            await withAuthTimeout(
              updateDoc(userRef, {
                displayName,
                displayNameLower: displayName.toLowerCase(),
                authProvider: 'password',
                updatedAtMs: Date.now(),
                updatedAt: serverTimestamp(),
              }).catch(() =>
                setDoc(userRef, {
                  ...this.profile,
                  createdAt: serverTimestamp(),
                  updatedAt: serverTimestamp(),
                })
              ),
              5000,
              null
            );
          }
        } else {
          await this._ensureCloudProfile(linked.user, displayName);
        }
        this._emit();
        return { ok: true, state: this.getState() };
      } catch (err) {
        const code = logAuthError('upgradeGuestToEmail', err);
        if (!shouldFallbackToSandbox(err)) {
          return { ok: false, code, error: formatFriendlyAuthError(err) };
        }
      }
    }

    // Local Sandbox Guest Upgrade (preserves 100% of UID, currencies, upgrades, friends, HUD layouts)
    const users = readJsonStorage(SIM_USERS_KEY, {});
    if (Object.values(users).some((u) => u.email === cleanEmail && u.uid !== this.user.uid)) {
      return { ok: false, error: 'That email is already linked to another account.' };
    }
    const upgradedProfile = {
      ...(this.profile || buildDefaultUserDoc(this.user.uid, displayName, 'password', generateFriendCode())),
      displayName,
      displayNameLower: displayName.toLowerCase(),
      authProvider: 'password',
      updatedAtMs: Date.now(),
    };
    this._saveSandboxAccount(this.user.uid, cleanEmail, password, upgradedProfile);
    return { ok: true, sandbox: true, state: this.getState() };
  }

  async signOutUser() {
    const { auth } = getFirebaseServices();
    if (auth && auth.currentUser) {
      await signOut(auth).catch(() => null);
    }
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(SIM_SESSION_KEY);
    } catch {}
    this.user = null;
    this.profile = null;
    this._emit();
    return { ok: true, state: this.getState() };
  }

  async syncProfile(localData) {
    if (!this.user) return { ok: false, error: 'Not signed in.', mode: 'local' };
    const uid = this.user.uid;
    if (this._ensurePromises.has(uid)) {
      await this._ensurePromises.get(uid).catch(() => null);
    }
    if (this._bgPersistPromises.has(uid)) {
      await this._bgPersistPromises.get(uid).catch(() => null);
    }
    const friendCode = this.profile?.friendCode || this._claimSandboxFriendCode(uid, localData.displayName || localData.playerName || 'ArcaneHero');
    const localNorm = buildDefaultUserDoc(
      uid,
      localData.displayName || localData.playerName || this.profile?.displayName || 'ArcaneHero',
      this.profile?.authProvider || (this.user.isAnonymous ? 'anonymous' : 'password'),
      friendCode,
      localData
    );
    const merged = mergeProfileConflict(localNorm, this.profile);
    merged.updatedAtMs = Date.now();
    this.profile = merged;

    const { db, auth } = getFirebaseServices();
    if (db && auth?.currentUser && !this.sandboxAuth) {
      const ref = doc(db, 'users', uid);
      try {
        const snap = await getDoc(ref);
        if (!snap.exists()) {
          await setDoc(ref, {
            ...merged,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          this._emit();
          return { ok: true, action: 'created', profile: merged };
        }
        const remote = snap.data();
        const finalMerged = mergeProfileConflict(merged, remote);
        this.profile = finalMerged;
        await updateDoc(ref, {
          displayName: finalMerged.displayName,
          displayNameLower: finalMerged.displayNameLower,
          level: finalMerged.level,
          xp: finalMerged.xp,
          coins: finalMerged.coins,
          crystals: finalMerged.crystals,
          gems: finalMerged.gems,
          unlockedChampions: finalMerged.unlockedChampions,
          selectedChampion: finalMerged.selectedChampion,
          unlockedRunes: finalMerged.unlockedRunes,
          equippedRune: finalMerged.equippedRune,
          unlockedTrails: finalMerged.unlockedTrails,
          equippedTrail: finalMerged.equippedTrail,
          statTiers: finalMerged.statTiers,
          careerStats: finalMerged.careerStats,
          hudLayouts: finalMerged.hudLayouts,
          isPublic: true,
          updatedAt: serverTimestamp(),
        });
        this.lastSyncedAt = Date.now();
        this._persistCloudCache(finalMerged);
        this._emit();
        return { ok: true, action: 'updated', profile: finalMerged, lastSyncedAt: this.lastSyncedAt };
      } catch (err) {
        this._persistCloudCache(merged);
        try {
          handleFirestoreError(err, OperationType.WRITE, `users/${uid}`);
        } catch {
          // Persist locally so gameplay is never interrupted, without flipping sandboxAuth
        }
        this._emit();
        return {
          ok: false,
          action: 'cached_offline',
          profile: merged,
          error: formatFriendlyAuthError(err),
        };
      }
    }

    // Persist in local sandbox user store (keeps Friends/Leaderboard/Reload in sync)
    this.lastSyncedAt = Date.now();
    this._saveSandboxAccount(uid, this.user.email, null, merged);
    return { ok: true, action: 'sandbox_saved', profile: merged, lastSyncedAt: this.lastSyncedAt };
  }

  async updateDisplayName(newName) {
    if (!this.user) return { ok: false, error: 'Sign in first to edit your Champion Name.' };
    const check = validateChampionName(newName);
    if (!check.valid) return { ok: false, error: check.error };
    const clean = check.cleaned;
    const lower = clean.toLowerCase();
    const uid = this.user.uid;

    const { auth, db } = getFirebaseServices();
    if (auth && auth.currentUser && db && !this.sandboxAuth) {
      try {
        await updateProfile(auth.currentUser, { displayName: clean }).catch(() => null);
        await updateDoc(doc(db, 'users', uid), {
          displayName: clean,
          displayNameLower: lower,
          updatedAtMs: Date.now(),
          updatedAt: serverTimestamp(),
        });
        this.user = { ...this.user, displayName: clean };
        if (this.profile) {
          this.profile = { ...this.profile, displayName: clean, displayNameLower: lower, updatedAtMs: Date.now() };
          this.lastSyncedAt = Date.now();
          this._persistCloudCache(this.profile);
        }
        this._emit();
        return { ok: true, displayName: clean, state: this.getState() };
      } catch (err) {
        return { ok: false, error: formatFriendlyAuthError(err) };
      }
    }

    const updatedProfile = {
      ...(this.profile || buildDefaultUserDoc(uid, clean, 'anonymous', generateFriendCode())),
      displayName: clean,
      displayNameLower: lower,
      updatedAtMs: Date.now(),
    };
    const codes = readJsonStorage(SIM_CODES_KEY, {});
    if (updatedProfile.friendCode && codes[updatedProfile.friendCode]) {
      codes[updatedProfile.friendCode].displayName = clean;
      writeJsonStorage(SIM_CODES_KEY, codes);
    }
    this.lastSyncedAt = Date.now();
    this._saveSandboxAccount(uid, this.user.email, null, updatedProfile);
    return { ok: true, sandbox: true, displayName: clean, state: this.getState() };
  }

  /**
   * @param {{
   *   costCoins?: number,
   *   costCrystals?: number,
   *   costGems?: number,
   *   costXp?: number,
   *   unlockField?: string | null,
   *   unlockId?: string | null,
   *   equipField?: string | null,
   *   statKey?: string | null,
   *   nextTier?: number | null,
   *   patch?: Record<string, unknown>
   * }} [options]
   */
  async spendCurrencyTransaction({
    costCoins = 0,
    costCrystals = 0,
    costGems = 0,
    costXp = 0,
    unlockField = null,
    unlockId = null,
    equipField = null,
    statKey = null,
    nextTier = null,
    patch = {},
  } = {}) {
    const cCoins = Math.max(0, Math.floor(Number(costCoins) || 0));
    const cCrystals = Math.max(0, Math.floor(Number(costCrystals) || 0));
    const cGems = Math.max(0, Math.floor(Number(costGems) || 0));
    const cXp = Math.max(0, Math.floor(Number(costXp) || 0));
    const allowedUnlockFields = new Set(['unlockedChampions', 'unlockedRunes', 'unlockedTrails']);
    const allowedEquipFields = new Set(['selectedChampion', 'equippedRune', 'equippedTrail']);
    const allowedStatKeys = new Set(['PWR', 'FOC', 'AGI', 'VIT', 'maxHealth', 'movementSpeed', 'attackPower']);

    const computeNextPatch = (cur) => {
      const mergedPatch = { ...(patch && typeof patch === 'object' ? patch : {}) };
      if (unlockField && allowedUnlockFields.has(unlockField) && typeof unlockId === 'string' && unlockId.trim()) {
        const cleanId = unlockId.trim().slice(0, 32);
        const existingArr = Array.isArray(cur[unlockField]) ? cur[unlockField] : [];
        mergedPatch[unlockField] = Array.from(new Set([...existingArr, cleanId]));
      }
      if (equipField && allowedEquipFields.has(equipField) && typeof unlockId === 'string' && unlockId.trim()) {
        mergedPatch[equipField] = unlockId.trim().slice(0, 32);
      }
      if (statKey && allowedStatKeys.has(statKey) && Number.isFinite(Number(nextTier))) {
        const clampedTier = Math.max(0, Math.min(25, Math.floor(Number(nextTier))));
        mergedPatch.statTiers = {
          ...(cur.statTiers && typeof cur.statTiers === 'object' ? cur.statTiers : {}),
          [statKey]: clampedTier,
        };
      }
      return mergedPatch;
    };

    if (!this.user) {
      return { ok: true, localOnly: true };
    }
    const uid = this.user.uid;
    const { db, auth } = getFirebaseServices();
    if (db && auth?.currentUser && !this.sandboxAuth) {
      const ref = doc(db, 'users', uid);
      try {
        const resultProfile = await runTransaction(db, async (tx) => {
          const snap = await tx.get(ref);
          if (!snap.exists()) {
            throw new Error('Cloud profile not initialized.');
          }
          const cur = snap.data();
          const curCoins = Number(cur.coins || 0);
          const curCrystals = Number(cur.crystals || 0);
          const curGems = Number(cur.gems || 0);
          const curXp = Number(cur.xp || 0);
          if (curCoins < cCoins || curCrystals < cCrystals || curGems < cGems || (cXp > 0 && curXp < cXp)) {
            throw new Error('Insufficient currency balance.');
          }
          const resolvedPatch = computeNextPatch(cur);
          const next = {
            ...resolvedPatch,
            coins: curCoins - cCoins,
            crystals: curCrystals - cCrystals,
            gems: curGems - cGems,
            ...(cXp > 0 ? { xp: Math.max(0, curXp - cXp) } : {}),
            updatedAtMs: Date.now(),
            updatedAt: serverTimestamp(),
          };
          tx.update(ref, next);
          return {
            ...cur,
            ...resolvedPatch,
            coins: curCoins - cCoins,
            crystals: curCrystals - cCrystals,
            gems: curGems - cGems,
            ...(cXp > 0 ? { xp: Math.max(0, curXp - cXp) } : {}),
            updatedAtMs: Date.now(),
          };
        });
        this.profile = resultProfile;
        this.lastSyncedAt = Date.now();
        this._persistCloudCache(resultProfile);
        this._emit();
        return { ok: true, transactional: true, profile: resultProfile };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Transaction failed.' };
      }
    }

    // Atomic local sandbox balance verification + update
    const cur = this.profile || buildDefaultUserDoc(uid, this.user.displayName || 'ArcaneHero', 'anonymous', generateFriendCode());
    const curCoins = Number(cur.coins || 0);
    const curCrystals = Number(cur.crystals || 0);
    const curGems = Number(cur.gems || 0);
    const curXp = Number(cur.xp || 0);
    if (curCoins < cCoins || curCrystals < cCrystals || curGems < cGems || (cXp > 0 && curXp < cXp)) {
      return { ok: false, error: 'Insufficient currency balance.' };
    }
    const resolvedPatch = computeNextPatch(cur);
    const nextProfile = {
      ...cur,
      ...resolvedPatch,
      coins: curCoins - cCoins,
      crystals: curCrystals - cCrystals,
      gems: curGems - cGems,
      ...(cXp > 0 ? { xp: Math.max(0, curXp - cXp) } : {}),
      updatedAtMs: Date.now(),
    };
    this.lastSyncedAt = Date.now();
    this._saveSandboxAccount(uid, this.user.email, null, nextProfile);
    return { ok: true, sandbox: true, profile: nextProfile };
  }

  resetLocalCacheAndHud() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(CLOUD_CACHE_STORAGE_KEYS.profile);
        localStorage.removeItem(CLOUD_CACHE_STORAGE_KEYS.meta);
        const toRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && (k.startsWith('arcane_cloud_cache_') || k.startsWith('arcane_royale_hud_'))) {
            toRemove.push(k);
          }
        }
        toRemove.forEach((k) => localStorage.removeItem(k));
      }
    } catch {}
    return { ok: true };
  }
}

export const authService = new AuthServiceImpl();
