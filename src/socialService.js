import {
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  writeBatch,
  serverTimestamp as fsServerTimestamp,
} from 'firebase/firestore';
import {
  ref as rtdbRef,
  set as rtdbSet,
  update as rtdbUpdate,
  remove as rtdbRemove,
  onValue,
  onDisconnect,
  serverTimestamp as rtdbServerTimestamp,
} from 'firebase/database';
import {
  getFirebaseServices,
  isSimBroadcastEnabled,
  SIM_CHANNEL_NAME,
  SANDBOX_STORAGE_KEYS,
  OperationType,
  handleFirestoreError,
} from './firebaseConfig.js';
import {
  FRIEND_CODE_ALPHABET,
  authService,
  sanitizeChampionId,
} from './authService.js';

const SIM_USERS_KEY = SANDBOX_STORAGE_KEYS.users;
const SIM_CODES_KEY = SANDBOX_STORAGE_KEYS.friendCodes;
const SIM_FRIENDS_KEY = SANDBOX_STORAGE_KEYS.friends;
const SIM_REQUESTS_KEY = SANDBOX_STORAGE_KEYS.requests;
const SIM_PRESENCE_KEY = SANDBOX_STORAGE_KEYS.presence;
const SIM_SQUADS_KEY = SANDBOX_STORAGE_KEYS.squads;
const SIM_INVITES_KEY = SANDBOX_STORAGE_KEYS.invites;

export const INVITE_TTL_MS = 45000;
export const MAX_SQUAD_SIZE = 4;

export function generateRoomCode(rng = Math.random) {
  let code = '';
  for (let i = 0; i < 4; i++) {
    const idx = Math.floor(rng() * FRIEND_CODE_ALPHABET.length) % FRIEND_CODE_ALPHABET.length;
    code += FRIEND_CODE_ALPHABET[idx];
  }
  return `SQ-${code}`;
}

function readJson(key, fallback) {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, val) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(val));
  } catch {}
}

function makeChannel() {
  if (!isSimBroadcastEnabled()) return null;
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(SIM_CHANNEL_NAME);
  } catch {
    return null;
  }
}

class SocialServiceImpl {
  constructor() {
    this.presenceState = 'online';
    this.currentSquadId = null;
    this.currentSquad = null;
    this.friends = [];
    this.friendRequests = [];
    this.incomingInvites = [];
    this.friendPresence = {};
    this.listeners = new Set();
    this.rtdbUnsubs = [];
    this.squadUnsub = null;
    this.inviteUnsub = null;
    this.presenceUnsub = null;
    this.channel = makeChannel();

    if (this.channel) {
      this.channel.onmessage = (ev) => {
        const msg = ev?.data;
        if (!msg || !msg.type) return;
        if (msg.type.startsWith('social:') || msg.type.startsWith('squad:')) {
          this._refreshFromSandbox();
        }
      };
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => this._markOfflineSync());
      window.addEventListener('storage', (ev) => {
        if (
          ev.key === SIM_SQUADS_KEY ||
          ev.key === SIM_INVITES_KEY ||
          ev.key === SIM_FRIENDS_KEY ||
          ev.key === SIM_REQUESTS_KEY ||
          ev.key === SIM_PRESENCE_KEY
        ) {
          this._refreshFromSandbox();
        }
      });
    }
  }

  _broadcast(type, payload = {}) {
    if (this.channel) {
      try {
        this.channel.postMessage({ type, ...payload, ts: Date.now() });
      } catch {}
    }
  }

  subscribe(fn) {
    this.listeners.add(fn);
    fn(this.getSnapshot());
    return () => this.listeners.delete(fn);
  }

  getSnapshot() {
    const auth = authService.getState();
    const now = Date.now();
    const activeInvites = (this.incomingInvites || []).filter((inv) => now - (inv.createdAt || 0) < INVITE_TTL_MS);
    const mergedFriends = (this.friends || []).map((f) => {
      const pres = this.friendPresence[f.uid] || { state: 'offline', championId: 'BERSERKER', level: 1 };
      return {
        ...f,
        status: pres.state || 'offline',
        championId: sanitizeChampionId(pres.championId || f.championId),
        level: Number(pres.level || f.level || 1),
        squadId: pres.squadId || null,
      };
    });
    return {
      uid: auth.uid,
      friendCode: auth.friendCode,
      friends: mergedFriends,
      friendRequests: this.friendRequests || [],
      unreadCount: (this.friendRequests?.length || 0) + activeInvites.length,
      incomingInvites: activeInvites,
      squad: this.currentSquad,
      squadId: this.currentSquadId,
    };
  }

  _emit() {
    const snap = this.getSnapshot();
    this.listeners.forEach((fn) => {
      try {
        fn(snap);
      } catch {}
    });
  }

  // ==========================================
  // A. GHOST-FREE PRESENCE (RTDB + SANDBOX)
  // ==========================================
  async startForUser() {
    this.stop();
    const auth = authService.getState();
    if (!auth.uid || !auth.profile) return;

    const { rtdb } = getFirebaseServices();
    if (rtdb && !auth.sandboxAuth) {
      this._startRtdbPresence(rtdb, auth);
      this._subscribeRtdbInvites(rtdb, auth.uid);
    } else {
      this._writeSandboxPresence('online');
      this._refreshFromSandbox();
    }

    await this.refreshFriends();
    await this.ensureOwnSquad();
  }

  stop() {
    this.rtdbUnsubs.forEach((u) => {
      try {
        u();
      } catch {}
    });
    this.rtdbUnsubs = [];
    if (this.squadUnsub) {
      try {
        this.squadUnsub();
      } catch {}
      this.squadUnsub = null;
    }
    if (this.inviteUnsub) {
      try {
        this.inviteUnsub();
      } catch {}
      this.inviteUnsub = null;
    }
    if (this.presenceUnsub) {
      try {
        this.presenceUnsub();
      } catch {}
      this.presenceUnsub = null;
    }
    this._markOfflineSync();
  }

  _startRtdbPresence(rtdb, auth) {
    const connRef = rtdbRef(rtdb, '.info/connected');
    const presRef = rtdbRef(rtdb, `presence/${auth.uid}`);
    this.presenceUnsub = onValue(connRef, (snap) => {
      if (snap.val() !== true) return;
      onDisconnect(presRef).set({
        state: 'offline',
        squadId: null,
        lastSeen: rtdbServerTimestamp(),
      });
      this.updatePresence(this.presenceState);
    });
  }

  async updatePresence(state = 'online') {
    this.presenceState = state;
    const auth = authService.getState();
    if (!auth.uid || !auth.profile) return;
    const payload = {
      state,
      squadId: this.currentSquadId || null,
      championId: sanitizeChampionId(auth.profile.selectedChampion),
      level: Number(auth.profile.level || 1),
      displayName: auth.profile.displayName || 'ArcaneHero',
      updatedAt: Date.now(),
    };

    const { rtdb } = getFirebaseServices();
    if (rtdb && !auth.sandboxAuth) {
      try {
        await rtdbSet(rtdbRef(rtdb, `presence/${auth.uid}`), {
          ...payload,
          updatedAt: rtdbServerTimestamp(),
        });
        return;
      } catch {}
    }
    this._writeSandboxPresence(state, payload);
  }

  _writeSandboxPresence(state, customPayload = null) {
    const auth = authService.getState();
    if (!auth.uid) return;
    const map = readJson(SIM_PRESENCE_KEY, {});
    map[auth.uid] = customPayload || {
      state,
      squadId: this.currentSquadId || null,
      championId: sanitizeChampionId(auth.profile?.selectedChampion),
      level: Number(auth.profile?.level || 1),
      displayName: auth.profile?.displayName || 'ArcaneHero',
      updatedAt: Date.now(),
    };
    writeJson(SIM_PRESENCE_KEY, map);
    this._broadcast('social:presence');
  }

  _markOfflineSync() {
    const auth = authService.getState();
    if (!auth.uid) return;
    const map = readJson(SIM_PRESENCE_KEY, {});
    if (map[auth.uid]) {
      map[auth.uid] = { ...map[auth.uid], state: 'offline', squadId: null, lastSeen: Date.now() };
      writeJson(SIM_PRESENCE_KEY, map);
    }
  }

  // ==========================================
  // B. FRIENDS & REQUESTS (FIRESTORE + SANDBOX)
  // ==========================================
  async refreshFriends() {
    const auth = authService.getState();
    if (!auth.uid) return this.getSnapshot();
    const { db, rtdb, auth: fbAuth } = getFirebaseServices();

    if (db && !auth.sandboxAuth && fbAuth?.currentUser?.uid === auth.uid) {
      try {
        const [fSnap, rSnap] = await Promise.all([
          getDocs(collection(db, 'users', auth.uid, 'friends')),
          getDocs(collection(db, 'users', auth.uid, 'friendRequests')),
        ]);
        this.friends = fSnap.docs.map((d) => ({ uid: d.id, ...d.data() }));
        this.friendRequests = rSnap.docs.map((d) => ({ fromUid: d.id, ...d.data() }));
        if (rtdb) {
          this.rtdbUnsubs.forEach((u) => {
            try {
              u();
            } catch {}
          });
          this.rtdbUnsubs = this.friends.map((f) =>
            onValue(rtdbRef(rtdb, `presence/${f.uid}`), (snap) => {
              this.friendPresence[f.uid] = snap.val() || { state: 'offline' };
              this._emit();
            })
          );
        }
        this._emit();
        return this.getSnapshot();
      } catch (err) {
        try {
          handleFirestoreError(err, OperationType.LIST, `users/${auth.uid}/friends`);
        } catch {}
      }
    }

    this._refreshFromSandbox();
    return this.getSnapshot();
  }

  _refreshFromSandbox() {
    const auth = authService.getState();
    if (!auth.uid) return;
    const friendsMap = readJson(SIM_FRIENDS_KEY, {});
    const reqsMap = readJson(SIM_REQUESTS_KEY, {});
    const presMap = readJson(SIM_PRESENCE_KEY, {});
    const invMap = readJson(SIM_INVITES_KEY, {});
    const squadsMap = readJson(SIM_SQUADS_KEY, {});

    this.friends = Object.values(friendsMap[auth.uid] || {});
    this.friendRequests = Object.values(reqsMap[auth.uid] || {});
    this.friendPresence = presMap;
    const now = Date.now();
    this.incomingInvites = Object.values(invMap[auth.uid] || {}).filter(
      (inv) => now - (inv.createdAt || 0) < INVITE_TTL_MS
    );

    if (this.currentSquadId) {
      const sq = squadsMap[this.currentSquadId] || null;
      if (sq && sq.members && sq.members[auth.uid]) {
        this.currentSquad = sq;
      } else {
        this.currentSquadId = null;
        this.currentSquad = null;
      }
    }
    this._emit();
  }

  async searchPlayer(rawQuery) {
    const auth = authService.getState();
    const q = String(rawQuery || '').trim();
    if (!q) return { ok: false, error: 'Enter a Friend Code (ARC-XXXX) or Champion Name.' };

    const upper = q.toUpperCase();
    const { db } = getFirebaseServices();
    if (db && !auth.sandboxAuth) {
      try {
        if (upper.startsWith('ARC-')) {
          const snap = await getDoc(doc(db, 'friendCodes', upper));
          if (!snap.exists()) return { ok: false, error: `No player found with code ${upper}.` };
          const d = snap.data();
          if (d.uid === auth.uid) return { ok: false, error: 'You cannot add yourself.' };
          return { ok: true, target: { uid: d.uid, displayName: d.displayName, friendCode: upper } };
        }
        const qSnap = await getDocs(
          query(
            collection(db, 'users'),
            where('isPublic', '==', true),
            where('displayNameLower', '==', q.toLowerCase()),
            limit(1)
          )
        );
        if (qSnap.empty) return { ok: false, error: `No champion named "${q}" found.` };
        const d = qSnap.docs[0].data();
        if (d.uid === auth.uid) return { ok: false, error: 'You cannot add yourself.' };
        return { ok: true, target: { uid: d.uid, displayName: d.displayName, friendCode: d.friendCode || '' } };
      } catch (err) {
        try {
          handleFirestoreError(err, OperationType.GET, 'friendCodes');
        } catch {}
      }
    }

    // Local Sandbox Lookup
    const codes = readJson(SIM_CODES_KEY, {});
    const users = readJson(SIM_USERS_KEY, {});
    if (upper.startsWith('ARC-')) {
      const entry = codes[upper];
      if (!entry) return { ok: false, error: `No player found with code ${upper}.` };
      if (entry.uid === auth.uid) return { ok: false, error: 'You cannot add yourself.' };
      return { ok: true, target: { uid: entry.uid, displayName: entry.displayName, friendCode: upper } };
    }
    const found = Object.values(users).find((u) => u.profile?.displayNameLower === q.toLowerCase());
    if (!found) return { ok: false, error: `No champion named "${q}" found.` };
    if (found.uid === auth.uid) return { ok: false, error: 'You cannot add yourself.' };
    return { ok: true, target: { uid: found.uid, displayName: found.profile.displayName, friendCode: found.profile.friendCode } };
  }

  async sendFriendRequest(queryText) {
    const auth = authService.getState();
    if (!auth.uid || !auth.profile) return { ok: false, error: 'Sign in to add friends.' };
    const found = await this.searchPlayer(queryText);
    if (!found.ok) return found;
    const target = found.target;

    if (this.friends.some((f) => f.uid === target.uid)) {
      return { ok: false, error: `${target.displayName} is already on your Friends list.` };
    }

    const { db } = getFirebaseServices();
    if (db && !auth.sandboxAuth) {
      const reqRef = doc(db, 'users', target.uid, 'friendRequests', auth.uid);
      try {
        const existing = await getDoc(reqRef);
        if (existing.exists()) return { ok: false, error: 'Friend request already sent.' };
        await setDoc(reqRef, {
          fromUid: auth.uid,
          fromName: auth.profile.displayName,
          fromCode: auth.profile.friendCode || '',
          createdAt: fsServerTimestamp(),
        });
        return { ok: true, message: `Friend request sent to ${target.displayName}!` };
      } catch (err) {
        try {
          handleFirestoreError(err, OperationType.CREATE, `users/${target.uid}/friendRequests/${auth.uid}`);
        } catch (wrapped) {
          return { ok: false, error: wrapped instanceof Error ? wrapped.message : 'Request failed.' };
        }
      }
    }

    const reqsMap = readJson(SIM_REQUESTS_KEY, {});
    reqsMap[target.uid] = reqsMap[target.uid] || {};
    if (reqsMap[target.uid][auth.uid]) return { ok: false, error: 'Friend request already sent.' };
    reqsMap[target.uid][auth.uid] = {
      fromUid: auth.uid,
      fromName: auth.profile.displayName,
      fromCode: auth.profile.friendCode || '',
      createdAt: Date.now(),
    };
    writeJson(SIM_REQUESTS_KEY, reqsMap);
    this._broadcast('social:request', { targetUid: target.uid });
    return { ok: true, message: `Friend request sent to ${target.displayName}!` };
  }

  async acceptFriendRequest(fromUid) {
    const auth = authService.getState();
    if (!auth.uid || !auth.profile) return { ok: false, error: 'Not signed in.' };
    const req = this.friendRequests.find((r) => r.fromUid === fromUid);
    if (!req) return { ok: false, error: 'Friend request not found.' };

    const { db } = getFirebaseServices();
    if (db && !auth.sandboxAuth) {
      try {
        const batch = writeBatch(db);
        batch.set(doc(db, 'users', auth.uid, 'friends', fromUid), {
          uid: fromUid,
          displayName: req.fromName,
          friendCode: req.fromCode || '',
          since: fsServerTimestamp(),
        });
        batch.set(doc(db, 'users', fromUid, 'friends', auth.uid), {
          uid: auth.uid,
          displayName: auth.profile.displayName,
          friendCode: auth.profile.friendCode || '',
          since: fsServerTimestamp(),
        });
        batch.delete(doc(db, 'users', auth.uid, 'friendRequests', fromUid));
        await batch.commit();
        await this.refreshFriends();
        return { ok: true, message: `${req.fromName} added to your Friends!` };
      } catch (err) {
        try {
          handleFirestoreError(err, OperationType.WRITE, `users/${auth.uid}/friends/${fromUid}`);
        } catch (wrapped) {
          return { ok: false, error: wrapped instanceof Error ? wrapped.message : 'Accept failed.' };
        }
      }
    }

    const friendsMap = readJson(SIM_FRIENDS_KEY, {});
    friendsMap[auth.uid] = friendsMap[auth.uid] || {};
    friendsMap[fromUid] = friendsMap[fromUid] || {};
    friendsMap[auth.uid][fromUid] = {
      uid: fromUid,
      displayName: req.fromName,
      friendCode: req.fromCode || '',
      since: Date.now(),
    };
    friendsMap[fromUid][auth.uid] = {
      uid: auth.uid,
      displayName: auth.profile.displayName,
      friendCode: auth.profile.friendCode || '',
      since: Date.now(),
    };
    writeJson(SIM_FRIENDS_KEY, friendsMap);

    const reqsMap = readJson(SIM_REQUESTS_KEY, {});
    if (reqsMap[auth.uid]) delete reqsMap[auth.uid][fromUid];
    writeJson(SIM_REQUESTS_KEY, reqsMap);
    this._broadcast('social:friends');
    this._refreshFromSandbox();
    return { ok: true, message: `${req.fromName} added to your Friends!` };
  }

  async declineFriendRequest(fromUid) {
    const auth = authService.getState();
    if (!auth.uid) return { ok: false };
    const { db } = getFirebaseServices();
    if (db && !auth.sandboxAuth) {
      try {
        await deleteDoc(doc(db, 'users', auth.uid, 'friendRequests', fromUid));
        await this.refreshFriends();
        return { ok: true };
      } catch {}
    }
    const reqsMap = readJson(SIM_REQUESTS_KEY, {});
    if (reqsMap[auth.uid]) delete reqsMap[auth.uid][fromUid];
    writeJson(SIM_REQUESTS_KEY, reqsMap);
    this._broadcast('social:request');
    this._refreshFromSandbox();
    return { ok: true };
  }

  async removeFriend(friendUid) {
    const auth = authService.getState();
    if (!auth.uid) return { ok: false };
    const { db } = getFirebaseServices();
    if (db && !auth.sandboxAuth) {
      try {
        const batch = writeBatch(db);
        batch.delete(doc(db, 'users', auth.uid, 'friends', friendUid));
        batch.delete(doc(db, 'users', friendUid, 'friends', auth.uid));
        await batch.commit();
        await this.refreshFriends();
        return { ok: true };
      } catch {}
    }
    const friendsMap = readJson(SIM_FRIENDS_KEY, {});
    if (friendsMap[auth.uid]) delete friendsMap[auth.uid][friendUid];
    if (friendsMap[friendUid]) delete friendsMap[friendUid][auth.uid];
    writeJson(SIM_FRIENDS_KEY, friendsMap);
    this._broadcast('social:friends');
    this._refreshFromSandbox();
    return { ok: true };
  }

  // ==========================================
  // C. GLOBAL TOP-50 LEADERBOARD (FIRESTORE users)
  // ==========================================
  async fetchLeaderboard(sortBy = 'wins') {
    const auth = authService.getState();
    const { db } = getFirebaseServices();
    const orderField = sortBy === 'eliminations' ? 'careerStats.elims' : 'careerStats.wins';

    if (db && !auth.sandboxAuth) {
      try {
        const q = query(
          collection(db, 'users'),
          where('isPublic', '==', true),
          orderBy(orderField, 'desc'),
          limit(50)
        );
        const snap = await getDocs(q);
        const entries = snap.docs.map((d) => {
          const data = d.data();
          const cs = data.careerStats || {};
          return {
            uid: String(data.uid || d.id),
            playerName: String(data.displayName || data.playerName || 'CHAMPION'),
            champion: sanitizeChampionId(data.selectedChampion || data.selectedFighter),
            level: Number(data.level || 1),
            wins: Number(cs.wins ?? data.wins ?? 0),
            eliminations: Number(cs.elims ?? data.eliminations ?? 0),
            matches: Number(cs.matches ?? data.matches ?? 0),
          };
        });
        return { ok: true, source: 'cloud', entries };
      } catch (err) {
        try {
          handleFirestoreError(err, OperationType.LIST, 'users');
        } catch {}
      }
    }

    // Merge local sandbox users cleanly
    const simUsers = readJson(SIM_USERS_KEY, {});
    const entries = Object.values(simUsers).map((u) => {
      const p = u.profile || {};
      const cs = p.careerStats || {};
      return {
        uid: u.uid,
        playerName: p.displayName || 'CHAMPION',
        champion: sanitizeChampionId(p.selectedChampion),
        level: Number(p.level || 1),
        wins: Number(cs.wins || 0),
        eliminations: Number(cs.elims || 0),
        matches: Number(cs.matches || 0),
      };
    });
    return { ok: true, source: 'local', entries };
  }

  // ==========================================
  // D. 4-SLOT SQUAD ROOMS & REAL-TIME INVITES
  // ==========================================
  _buildMemberEntry(auth, slotIndex = 0, ready = true) {
    return {
      uid: auth.uid,
      displayName: auth.profile?.displayName || 'ArcaneHero',
      championId: sanitizeChampionId(auth.profile?.selectedChampion),
      level: Number(auth.profile?.level || 1),
      ready: Boolean(ready),
      colorIndex: slotIndex % 4,
      joinedAt: Date.now(),
    };
  }

  async ensureOwnSquad() {
    const auth = authService.getState();
    if (!auth.uid || !auth.profile) return null;
    if (this.currentSquadId && this.currentSquad?.members?.[auth.uid]) {
      return this.currentSquad;
    }
    const squadId = generateRoomCode();
    const squad = {
      squadId,
      roomCode: squadId,
      leaderUid: auth.uid,
      activeMatchId: null,
      isPrivate: false,
      createdAt: Date.now(),
      members: {
        [auth.uid]: this._buildMemberEntry(auth, 0, true),
      },
    };
    return this._saveAndSubscribeSquad(squad);
  }

  async setSquadPrivacy(isPrivate) {
    const auth = authService.getState();
    if (!this.currentSquad || this.currentSquad.leaderUid !== auth.uid) {
      return { ok: false, error: 'Only the Squad Leader can change privacy.' };
    }
    const nextVal = Boolean(isPrivate);
    const { rtdb } = getFirebaseServices();
    if (rtdb && !auth.sandboxAuth) {
      await rtdbUpdate(rtdbRef(rtdb, `squads/${this.currentSquadId}`), { isPrivate: nextVal }).catch(() => null);
      return { ok: true, isPrivate: nextVal };
    }
    const squads = readJson(SIM_SQUADS_KEY, {});
    const sq = squads[this.currentSquadId] || this.currentSquad;
    sq.isPrivate = nextVal;
    squads[this.currentSquadId] = sq;
    writeJson(SIM_SQUADS_KEY, squads);
    this.currentSquad = sq;
    this._broadcast('squad:update', { squadId: this.currentSquadId });
    this._emit();
    return { ok: true, isPrivate: nextVal };
  }

  async _saveAndSubscribeSquad(squad) {
    const auth = authService.getState();
    this.currentSquadId = squad.squadId;
    this.currentSquad = squad;
    const { rtdb } = getFirebaseServices();

    if (rtdb && !auth.sandboxAuth) {
      try {
        const sRef = rtdbRef(rtdb, `squads/${squad.squadId}`);
        await rtdbSet(sRef, squad);
        onDisconnect(rtdbRef(rtdb, `squads/${squad.squadId}/members/${auth.uid}`)).remove();
        this._subscribeRtdbSquad(rtdb, squad.squadId);
        await this.updatePresence('in_squad');
        this._emit();
        return squad;
      } catch {}
    }

    const map = readJson(SIM_SQUADS_KEY, {});
    map[squad.squadId] = squad;
    writeJson(SIM_SQUADS_KEY, map);
    this._broadcast('squad:update', { squadId: squad.squadId });
    this._writeSandboxPresence('in_squad');
    this._emit();
    return squad;
  }

  _subscribeRtdbSquad(rtdb, squadId) {
    if (this.squadUnsub) {
      try {
        this.squadUnsub();
      } catch {}
    }
    const auth = authService.getState();
    this.squadUnsub = onValue(rtdbRef(rtdb, `squads/${squadId}`), (snap) => {
      const val = snap.val();
      if (!val || !val.members || !val.members[auth.uid]) {
        this.currentSquad = null;
        this.currentSquadId = null;
        this.ensureOwnSquad();
        return;
      }
      this.currentSquad = val;
      this._emit();
    });
  }

  _subscribeRtdbInvites(rtdb, uid) {
    if (this.inviteUnsub) {
      try {
        this.inviteUnsub();
      } catch {}
    }
    this.inviteUnsub = onValue(rtdbRef(rtdb, `invites/${uid}`), (snap) => {
      const val = snap.val() || {};
      const now = Date.now();
      this.incomingInvites = Object.values(val).filter((inv) => now - (inv.createdAt || 0) < INVITE_TTL_MS);
      this._emit();
    });
  }

  async joinSquadByCode(rawCode) {
    const auth = authService.getState();
    if (!auth.uid || !auth.profile) return { ok: false, error: 'Sign in to join a squad.' };
    const code = String(rawCode || '').trim().toUpperCase();
    if (!/^SQ-[A-Z2-9]{4}$/.test(code)) return { ok: false, error: 'Room code must look like SQ-XXXX.' };
    if (code === this.currentSquadId) return { ok: true, message: `Already in squad ${code}.` };

    const { rtdb } = getFirebaseServices();
    if (rtdb && !auth.sandboxAuth) {
      return new Promise((resolve) => {
        onValue(
          rtdbRef(rtdb, `squads/${code}`),
          async (snap) => {
            const sq = snap.val();
            if (!sq || !sq.members) {
              resolve({ ok: false, error: `Squad room ${code} not found.` });
              return;
            }
            if (sq.isPrivate && sq.leaderUid !== auth.uid && !this.friends.some((f) => f.uid === sq.leaderUid)) {
              resolve({ ok: false, error: 'This squad is set to Friends Only.' });
              return;
            }
            const count = Object.keys(sq.members).length;
            if (count >= MAX_SQUAD_SIZE && !sq.members[auth.uid]) {
              resolve({ ok: false, error: 'Squad is already full (4/4).' });
              return;
            }
            await this.leaveSquad(false);
            const member = this._buildMemberEntry(auth, count, false);
            await rtdbSet(rtdbRef(rtdb, `squads/${code}/members/${auth.uid}`), member);
            onDisconnect(rtdbRef(rtdb, `squads/${code}/members/${auth.uid}`)).remove();
            this.currentSquadId = code;
            this._subscribeRtdbSquad(rtdb, code);
            await this.updatePresence('in_squad');
            resolve({ ok: true, squadId: code });
          },
          { onlyOnce: true }
        );
      });
    }

    const squads = readJson(SIM_SQUADS_KEY, {});
    const target = squads[code];
    if (!target || !target.members) return { ok: false, error: `Squad room ${code} not found.` };
    if (target.isPrivate && target.leaderUid !== auth.uid && !this.friends.some((f) => f.uid === target.leaderUid)) {
      return { ok: false, error: 'This squad is set to Friends Only.' };
    }
    const memberKeys = Object.keys(target.members);
    if (memberKeys.length >= MAX_SQUAD_SIZE && !target.members[auth.uid]) {
      return { ok: false, error: 'Squad is already full (4/4).' };
    }
    await this.leaveSquad(false);
    target.members[auth.uid] = this._buildMemberEntry(auth, memberKeys.length, false);
    squads[code] = target;
    writeJson(SIM_SQUADS_KEY, squads);
    this.currentSquadId = code;
    this.currentSquad = target;
    this._broadcast('squad:update', { squadId: code });
    this._writeSandboxPresence('in_squad');
    this._emit();
    return { ok: true, squadId: code };
  }

  async inviteFriendToSquad(targetUid) {
    const auth = authService.getState();
    if (!auth.uid || !auth.profile) return { ok: false, error: 'Not signed in.' };
    if (!this.currentSquad) await this.ensureOwnSquad();
    const sq = this.currentSquad;
    if (Object.keys(sq.members || {}).length >= MAX_SQUAD_SIZE) {
      return { ok: false, error: 'Squad is full (4/4).' };
    }
    const invite = {
      squadId: sq.squadId,
      roomCode: sq.roomCode || sq.squadId,
      fromUid: auth.uid,
      fromName: auth.profile.displayName,
      fromChampion: sanitizeChampionId(auth.profile.selectedChampion),
      createdAt: Date.now(),
    };
    const { rtdb } = getFirebaseServices();
    if (rtdb && !auth.sandboxAuth) {
      try {
        await rtdbSet(rtdbRef(rtdb, `invites/${targetUid}/${sq.squadId}`), invite);
        return { ok: true, message: 'Squad invite sent!' };
      } catch {}
    }
    const invMap = readJson(SIM_INVITES_KEY, {});
    invMap[targetUid] = invMap[targetUid] || {};
    invMap[targetUid][sq.squadId] = invite;
    writeJson(SIM_INVITES_KEY, invMap);
    this._broadcast('squad:invite', { targetUid });
    return { ok: true, message: 'Squad invite sent!' };
  }

  async respondToInvite(squadId, accept) {
    const auth = authService.getState();
    if (!auth.uid) return { ok: false };
    const { rtdb } = getFirebaseServices();
    if (rtdb && !auth.sandboxAuth) {
      await rtdbRemove(rtdbRef(rtdb, `invites/${auth.uid}/${squadId}`)).catch(() => null);
    } else {
      const invMap = readJson(SIM_INVITES_KEY, {});
      if (invMap[auth.uid]) delete invMap[auth.uid][squadId];
      writeJson(SIM_INVITES_KEY, invMap);
    }
    this.incomingInvites = this.incomingInvites.filter((i) => i.squadId !== squadId);
    this._emit();
    if (accept) {
      return this.joinSquadByCode(squadId);
    }
    return { ok: true };
  }

  async toggleReady() {
    const auth = authService.getState();
    if (!auth.uid || !this.currentSquad?.members?.[auth.uid]) return { ok: false };
    const nextReady = !this.currentSquad.members[auth.uid].ready;
    return this._updateMemberFields(auth.uid, { ready: nextReady });
  }

  async syncSelectedChampion(championId) {
    const auth = authService.getState();
    if (!auth.uid || !this.currentSquad?.members?.[auth.uid]) return;
    // Allow smooth champion switching without forcing un-ready
    await this._updateMemberFields(auth.uid, { championId: sanitizeChampionId(championId) });
    await this.updatePresence(this.presenceState);
  }

  async syncMemberProfile() {
    const auth = authService.getState();
    if (!auth.uid || !auth.profile || !this.currentSquad?.members?.[auth.uid]) return;
    await this._updateMemberFields(auth.uid, {
      displayName: auth.profile.displayName || 'ArcaneHero',
      championId: sanitizeChampionId(auth.profile.selectedChampion),
      level: Number(auth.profile.level || 1),
    });
    await this.updatePresence(this.presenceState);
  }

  async _updateMemberFields(memberUid, patch) {
    if (!this.currentSquadId || !this.currentSquad?.members?.[memberUid]) return { ok: false };
    const auth = authService.getState();
    const { rtdb } = getFirebaseServices();
    if (rtdb && !auth.sandboxAuth) {
      try {
        await rtdbUpdate(rtdbRef(rtdb, `squads/${this.currentSquadId}/members/${memberUid}`), patch);
        return { ok: true };
      } catch {}
    }
    const squads = readJson(SIM_SQUADS_KEY, {});
    const sq = squads[this.currentSquadId] || this.currentSquad;
    if (sq?.members?.[memberUid]) {
      sq.members[memberUid] = { ...sq.members[memberUid], ...patch };
      squads[this.currentSquadId] = sq;
      writeJson(SIM_SQUADS_KEY, squads);
      this.currentSquad = sq;
      this._broadcast('squad:update', { squadId: this.currentSquadId });
      this._emit();
    }
    return { ok: true };
  }

  async promoteLeader(targetUid) {
    const auth = authService.getState();
    if (!this.currentSquad || this.currentSquad.leaderUid !== auth.uid) return { ok: false, error: 'Leader only.' };
    if (!this.currentSquad.members?.[targetUid]) return { ok: false };
    const { rtdb } = getFirebaseServices();
    if (rtdb && !auth.sandboxAuth) {
      await rtdbUpdate(rtdbRef(rtdb, `squads/${this.currentSquadId}`), { leaderUid: targetUid });
      await rtdbUpdate(rtdbRef(rtdb, `squads/${this.currentSquadId}/members/${targetUid}`), { ready: true });
      return { ok: true };
    }
    const squads = readJson(SIM_SQUADS_KEY, {});
    const sq = squads[this.currentSquadId] || this.currentSquad;
    sq.leaderUid = targetUid;
    if (sq.members[targetUid]) sq.members[targetUid].ready = true;
    squads[this.currentSquadId] = sq;
    writeJson(SIM_SQUADS_KEY, squads);
    this.currentSquad = sq;
    this._broadcast('squad:update', { squadId: this.currentSquadId });
    this._emit();
    return { ok: true };
  }

  async kickMember(targetUid) {
    const auth = authService.getState();
    if (!this.currentSquad || this.currentSquad.leaderUid !== auth.uid || targetUid === auth.uid) {
      return { ok: false };
    }
    const { rtdb } = getFirebaseServices();
    if (rtdb && !auth.sandboxAuth) {
      await rtdbRemove(rtdbRef(rtdb, `squads/${this.currentSquadId}/members/${targetUid}`));
      return { ok: true };
    }
    const squads = readJson(SIM_SQUADS_KEY, {});
    const sq = squads[this.currentSquadId] || this.currentSquad;
    if (sq?.members) delete sq.members[targetUid];
    squads[this.currentSquadId] = sq;
    writeJson(SIM_SQUADS_KEY, squads);
    this.currentSquad = sq;
    this._broadcast('squad:update', { squadId: this.currentSquadId });
    this._emit();
    return { ok: true };
  }

  async leaveSquad(createFreshOwn = true) {
    const auth = authService.getState();
    const oldId = this.currentSquadId;
    if (!oldId || !auth.uid) return { ok: true };

    const { rtdb } = getFirebaseServices();
    if (rtdb && !auth.sandboxAuth) {
      try {
        const remaining = Object.keys(this.currentSquad?.members || {}).filter((k) => k !== auth.uid);
        if (remaining.length === 0) {
          await rtdbRemove(rtdbRef(rtdb, `squads/${oldId}`));
        } else {
          await rtdbRemove(rtdbRef(rtdb, `squads/${oldId}/members/${auth.uid}`));
          if (this.currentSquad?.leaderUid === auth.uid) {
            await rtdbUpdate(rtdbRef(rtdb, `squads/${oldId}`), { leaderUid: remaining[0] });
          }
        }
      } catch {}
    } else {
      const squads = readJson(SIM_SQUADS_KEY, {});
      const sq = squads[oldId];
      if (sq && sq.members) {
        delete sq.members[auth.uid];
        const remaining = Object.keys(sq.members);
        if (remaining.length === 0) {
          delete squads[oldId];
        } else {
          if (sq.leaderUid === auth.uid) {
            sq.leaderUid = remaining[0];
            if (sq.members[remaining[0]]) sq.members[remaining[0]].ready = true;
          }
          squads[oldId] = sq;
        }
        writeJson(SIM_SQUADS_KEY, squads);
        this._broadcast('squad:update', { squadId: oldId });
      }
    }

    this.currentSquadId = null;
    this.currentSquad = null;
    if (createFreshOwn) {
      await this.ensureOwnSquad();
    } else {
      this._emit();
    }
    return { ok: true };
  }

  async setActiveMatchId(matchId) {
    const auth = authService.getState();
    if (!this.currentSquadId || !auth.uid) return;
    const { rtdb } = getFirebaseServices();
    if (rtdb && !auth.sandboxAuth) {
      await rtdbUpdate(rtdbRef(rtdb, `squads/${this.currentSquadId}`), { activeMatchId: matchId }).catch(() => null);
      return;
    }
    const squads = readJson(SIM_SQUADS_KEY, {});
    const sq = squads[this.currentSquadId] || this.currentSquad;
    if (sq) {
      sq.activeMatchId = matchId;
      squads[this.currentSquadId] = sq;
      writeJson(SIM_SQUADS_KEY, squads);
      this.currentSquad = sq;
      this._broadcast('squad:match_start', { squadId: this.currentSquadId, matchId });
      this._emit();
    }
  }

  // Sandbox helper: adds/joins a simulated friend into the local squad for 1-device preview/testing
  async addSandboxTestMate(name = 'NovaTide', championId = 'TIDECALLER') {
    if (!this.currentSquad) await this.ensureOwnSquad();
    const squads = readJson(SIM_SQUADS_KEY, {});
    const sq = squads[this.currentSquadId] || this.currentSquad;
    const keys = Object.keys(sq.members || {});
    if (keys.length >= MAX_SQUAD_SIZE) return { ok: false, error: 'Squad is full (4/4).' };
    const mateUid = `mate_${keys.length}_${Date.now().toString(36).slice(-4)}`;
    sq.members[mateUid] = {
      uid: mateUid,
      displayName: name,
      championId: sanitizeChampionId(championId),
      level: 14,
      ready: true,
      colorIndex: keys.length % 4,
      isSimMate: true,
      joinedAt: Date.now(),
    };
    squads[this.currentSquadId] = sq;
    writeJson(SIM_SQUADS_KEY, squads);
    this.currentSquad = sq;
    this._broadcast('squad:update', { squadId: this.currentSquadId });
    this._emit();
    return { ok: true, uid: mateUid };
  }
}

export const socialService = new SocialServiceImpl();
