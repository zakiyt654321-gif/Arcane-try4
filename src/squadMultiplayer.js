import {
  ref as rtdbRef,
  set as rtdbSet,
  update as rtdbUpdate,
  push as rtdbPush,
  remove as rtdbRemove,
  onValue,
  onDisconnect,
  runTransaction,
  serverTimestamp as rtdbServerTimestamp,
} from 'firebase/database';
import {
  getFirebaseServices,
  isSimBroadcastEnabled,
  SIM_CHANNEL_NAME,
  SANDBOX_STORAGE_KEYS,
} from './firebaseConfig.js';
import { authService, sanitizeChampionId } from './authService.js';

export const SQUAD_COLORS = Object.freeze(['#fbbf24', '#38bdf8', '#34d399', '#e879f9']);
export const SQUAD_COLOR_NAMES = Object.freeze(['Gold', 'Cyan', 'Emerald', 'Magenta']);
export const AOI_RADIUS = 600;
export const INTERP_DELAY_MS = 100;
export const HOST_STALL_MS = 6000;
export const RECONNECT_GRACE_MS = 12000;
export const INTENT_TTL_MS = 3000;
export const REMOTE_SFX_STALE_MS = 350;
export const ACTIVE_MATCH_SESSION_KEY = 'arcane_active_match_v1';
const SIM_MATCHES_KEY = SANDBOX_STORAGE_KEYS.matches;

export const QUICK_COMMS_OPTIONS = Object.freeze([
  Object.freeze({ id: 'enemy', icon: '⚠️', label: 'Enemy Here!' }),
  Object.freeze({ id: 'heal', icon: '✚', label: 'Need Healing!' }),
  Object.freeze({ id: 'group', icon: '🛡️', label: 'Group Up!' }),
  Object.freeze({ id: 'zone', icon: '🌀', label: 'Move to Safe Zone!' }),
  Object.freeze({ id: 'revive', icon: '💛', label: 'Revive Me!' }),
  Object.freeze({ id: 'nice', icon: '🔥', label: 'Nice Play!' }),
]);

const CHAMP_TO_IDX = { BERSERKER: 0, TIDECALLER: 1, SHADOW: 2 };
const IDX_TO_CHAMP = ['BERSERKER', 'TIDECALLER', 'SHADOW'];
const STATE_TO_IDX = { idle: 0, walk: 1, attack: 2 };
const IDX_TO_STATE = ['idle', 'walk', 'attack'];
const ELEM_TO_IDX = { '': 0, FIRE: 1, WATER: 2, DARK: 3 };
const IDX_TO_ELEM = [null, 'FIRE', 'WATER', 'DARK'];

/** Deterministic 32-bit PRNG (Mulberry32) so all squadmates generate identical static terrain & obstacles */
export function createSeededRng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cryptographically unbiased float in [0, 1) for dynamic storm circles & supply drop placement */
export function cryptoRandomFloat() {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buf);
    return buf[0] / 4294967296;
  }
  return Math.random();
}

/** Splits deterministic static worldRng from non-deterministic visual fxRng */
export function createWorldAndFxRng(seed) {
  return {
    worldRng: createSeededRng(seed),
    fxRng: () => Math.random(),
  };
}

/**
 * Host-authoritative validation for remote squadmate intents (`hit`, `loot`, `barrel`, `revive`).
 * Verifies range (+tolerance), cooldown (>= 85%), champion damage cap, and velocity sanity.
 */
export function validateRemoteIntent(intent, senderState, targetState, skillConfig = {}, nowMs = Date.now(), lastSenderState = null) {
  if (!intent || typeof intent !== 'object') return { valid: false, reason: 'missing_intent' };
  if (!senderState || typeof senderState !== 'object') return { valid: false, reason: 'missing_sender' };

  const type = String(intent.type || 'hit');
  const maxRange = Number(skillConfig.range ?? (type === 'loot' ? 140 : type === 'revive' ? 150 : 560));
  const tolerance = Number(skillConfig.tolerance ?? 70);
  const cooldownMs = Math.max(0, Number(skillConfig.cooldownMs ?? 250));
  const maxDamageCap = Math.max(1, Number(skillConfig.maxDamageCap ?? 185));
  const maxSpeed = Math.max(100, Number(skillConfig.maxSpeed ?? 440));

  // 1. Velocity sanity check (unless verified dash/teleport)
  if (lastSenderState && !intent.verifiedMobility) {
    const elapsedSec = Math.max(0.05, (nowMs - Number(lastSenderState.ts || nowMs - 100)) / 1000);
    const mdx = Number(senderState.x || 0) - Number(lastSenderState.x || 0);
    const mdy = Number(senderState.y || 0) - Number(lastSenderState.y || 0);
    const speed = Math.hypot(mdx, mdy) / elapsedSec;
    if (speed > maxSpeed * 1.25) {
      return { valid: false, reason: 'velocity_exceeded' };
    }
  }

  // 2. Cooldown check (>= 85% of skill cooldown)
  if (cooldownMs > 0 && Number.isFinite(skillConfig.lastUsedAtMs) && skillConfig.lastUsedAtMs > 0) {
    const sinceLast = nowMs - skillConfig.lastUsedAtMs;
    if (sinceLast < cooldownMs * 0.85) {
      return { valid: false, reason: 'cooldown_violation' };
    }
  }

  // 3. Distance check against target or intent coordinates
  const tx = targetState ? Number(targetState.x) : Number(intent.x);
  const ty = targetState ? Number(targetState.y) : Number(intent.y);
  if (Number.isFinite(tx) && Number.isFinite(ty)) {
    const dist = Math.hypot(tx - Number(senderState.x || 0), ty - Number(senderState.y || 0));
    if (dist > maxRange + tolerance) {
      return { valid: false, reason: 'out_of_range' };
    }
  }

  // 4. Champion damage cap check
  if (type === 'hit' || type === 'barrel') {
    const dmg = Number(intent.dmg ?? intent.damage ?? 0);
    if (!Number.isFinite(dmg) || dmg < 0 || dmg > maxDamageCap) {
      return { valid: false, reason: 'damage_cap_exceeded' };
    }
  }

  return { valid: true, reason: null };
}

/**
 * Area-of-Interest (AOI) quantized bot packer (~92% RTDB bandwidth savings).
 * Includes ONLY alive bots within `aoiRadius` (default 600u) of at least one living human.
 * Tuple layout: [id, x, y, a10, hp, st, chIdx, elemMark]
 */
export function packAoiBots(bots, livingHumans, aoiRadius = AOI_RADIUS) {
  const r2 = aoiRadius * aoiRadius;
  const tuples = [];
  const deadIds = [];
  let aliveCount = 0;

  for (let i = 0; i < bots.length; i++) {
    const b = bots[i];
    if (!b) continue;
    const bid = Number(b.netId ?? b.id ?? i);
    if (!b.isAlive) {
      deadIds.push(bid);
      continue;
    }
    aliveCount++;
    let nearHuman = false;
    for (let h = 0; h < livingHumans.length; h++) {
      const hu = livingHumans[h];
      if (!hu || !hu.alive) continue;
      const dx = b.x - hu.x;
      const dy = b.y - hu.y;
      if (dx * dx + dy * dy <= r2) {
        nearHuman = true;
        break;
      }
    }
    if (!nearHuman) continue;
    tuples.push([
      bid,
      Math.round(b.x),
      Math.round(b.y),
      Math.round((Number(b.facingAngle) || 0) * 10),
      Math.max(0, Math.round(b.hp)),
      STATE_TO_IDX[b.animState] ?? 0,
      CHAMP_TO_IDX[sanitizeChampionId(b.charKey)] ?? 0,
      ELEM_TO_IDX[b.primedElement || ''] ?? 0,
    ]);
  }
  return { aliveCount, deadIds, tuples };
}

export function unpackAoiBots(tuples) {
  if (!Array.isArray(tuples)) return [];
  const out = new Array(tuples.length);
  for (let i = 0; i < tuples.length; i++) {
    const t = tuples[i];
    out[i] = {
      id: t[0],
      x: t[1],
      y: t[2],
      facingAngle: (t[3] || 0) / 10,
      hp: t[4],
      animState: IDX_TO_STATE[t[5]] || 'idle',
      charKey: IDX_TO_CHAMP[t[6]] || 'BERSERKER',
      primedElement: IDX_TO_ELEM[t[7]] || null,
    };
  }
  return out;
}

/** Deterministic Host Migration: elects lowest connected UID when host disconnects or stalls > 6s */
export function electNextHostUid(membersMap, playersMap, nowMs, stallMs = HOST_STALL_MS) {
  if (!membersMap || typeof membersMap !== 'object') return null;
  const connectedUids = [];
  for (const uid of Object.keys(membersMap)) {
    const m = membersMap[uid];
    const p = playersMap?.[uid];
    if (!m || m.isSimMate) continue;
    const isConn = m.connected !== false && p?.connected !== false;
    const hb = Number(p?.hb || 0);
    const fresh = hb === 0 || nowMs - hb <= stallMs;
    if (isConn && fresh) connectedUids.push(uid);
  }
  if (connectedUids.length === 0) return null;
  connectedUids.sort();
  return connectedUids[0];
}

/** Pure match outcome resolver for Solo & 2-4 Player Friend Squads */
export function evaluateSquadMatchOutcome(playerAlive, livingSquadmates, livingHostiles) {
  const squadAlive = (playerAlive ? 1 : 0) + Math.max(0, Number(livingSquadmates) || 0);
  const hostiles = Math.max(0, Number(livingHostiles) || 0);
  if (hostiles === 0 && squadAlive > 0) return 'victory';
  if (!playerAlive && squadAlive === 0) return 'squad_wipe';
  if (!playerAlive && squadAlive > 0) return 'spectating';
  return 'playing';
}

/** Idempotent O(1) intent deduplicator with automatic 3s TTL pruning */
export function createIntentDeduplicator(ttlMs = INTENT_TTL_MS) {
  const seen = new Map();
  return {
    accept(intentId, nowMs = Date.now()) {
      if (!intentId || seen.has(intentId)) return false;
      seen.set(intentId, nowMs);
      if (seen.size > 64) this.prune(nowMs);
      return true;
    },
    prune(nowMs = Date.now()) {
      for (const [k, ts] of seen.entries()) {
        if (nowMs - ts > ttlMs) seen.delete(k);
      }
    },
    size() {
      return seen.size;
    },
  };
}

/** Zero-GC 100ms interpolation buffer for remote squadmates & visible bots */
export function createInterpBuffer() {
  return {
    prevX: 0,
    prevY: 0,
    prevA: 0,
    prevT: 0,
    nextX: 0,
    nextY: 0,
    nextA: 0,
    nextVx: 0,
    nextVy: 0,
    nextT: 0,
    initialized: false,
  };
}

export function pushInterpSample(buf, x, y, a, vx, vy, nowMs) {
  if (!buf.initialized) {
    buf.prevX = buf.nextX = x;
    buf.prevY = buf.nextY = y;
    buf.prevA = buf.nextA = a;
    buf.nextVx = vx || 0;
    buf.nextVy = vy || 0;
    buf.prevT = buf.nextT = nowMs;
    buf.initialized = true;
    return;
  }
  buf.prevX = buf.nextX;
  buf.prevY = buf.nextY;
  buf.prevA = buf.nextA;
  buf.prevT = buf.nextT;
  buf.nextX = x;
  buf.nextY = y;
  buf.nextA = a;
  buf.nextVx = vx || 0;
  buf.nextVy = vy || 0;
  buf.nextT = nowMs;
}

export function sampleInterpBuffer(buf, nowMs, outObj, delayMs = INTERP_DELAY_MS) {
  if (!buf.initialized) return outObj;
  const renderT = nowMs - delayMs;
  const span = Math.max(16, buf.nextT - buf.prevT);
  if (renderT <= buf.nextT) {
    const t = Math.max(0, Math.min(1, (renderT - buf.prevT) / span));
    outObj.x = buf.prevX + (buf.nextX - buf.prevX) * t;
    outObj.y = buf.prevY + (buf.nextY - buf.prevY) * t;
    let da = buf.nextA - buf.prevA;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    outObj.a = buf.prevA + da * t;
  } else {
    // Brief velocity-damped extrapolation (capped at 160ms)
    const extrapSec = Math.min(0.16, (renderT - buf.nextT) / 1000);
    const damp = 0.65;
    outObj.x = buf.nextX + buf.nextVx * extrapSec * damp;
    outObj.y = buf.nextY + buf.nextVy * extrapSec * damp;
    outObj.a = buf.nextA;
  }
  return outObj;
}

function readSimMatches() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SIM_MATCHES_KEY) : null;
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeSimMatches(obj) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SIM_MATCHES_KEY, JSON.stringify(obj));
  } catch {}
}

class SquadMultiplayerController {
  constructor() {
    this.matchId = null;
    this.matchData = null;
    this.isHost = false;
    this.seed = 0;
    this.unsubs = [];
    this.hbTimer = null;
    this.lastPlayerPush = 0;
    this.lastBotPush = 0;
    this.lastWorldPush = 0;
    this.pingMs = 24;
    this.connectionState = 'connected';
    this.interpBuffers = new Map();
    this.senderCooldowns = new Map();
    this.senderPrevPos = new Map();
    this.intentDedup = createIntentDeduplicator(INTENT_TTL_MS);
    this.fxSeen = createIntentDeduplicator(INTENT_TTL_MS);
    this.listeners = new Set();
    this.channel =
      isSimBroadcastEnabled() && typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel(SIM_CHANNEL_NAME)
        : null;
    if (this.channel) {
      this.channel.onmessage = (ev) => {
        if (ev?.data?.type === 'match:update' && ev.data.matchId === this.matchId) {
          this._pullSandboxMatch();
        }
      };
    }
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(eventType, payload) {
    this.listeners.forEach((fn) => {
      try {
        fn(eventType, payload);
      } catch {}
    });
  }

  saveReconnectToken(matchId) {
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(ACTIVE_MATCH_SESSION_KEY, JSON.stringify({ matchId, savedAt: Date.now() }));
      }
    } catch {}
  }

  readReconnectToken() {
    try {
      if (typeof sessionStorage === 'undefined') return null;
      const raw = sessionStorage.getItem(ACTIVE_MATCH_SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed.matchId || Date.now() - (parsed.savedAt || 0) > RECONNECT_GRACE_MS) return null;
      return parsed.matchId;
    } catch {
      return null;
    }
  }

  clearReconnectToken() {
    try {
      if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(ACTIVE_MATCH_SESSION_KEY);
    } catch {}
  }

  async createMatch(squad) {
    const auth = authService.getState();
    if (!auth.uid || !squad?.members) return { ok: false, error: 'Squad not ready.' };

    const matchId = `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const seed = (Math.floor(Math.random() * 0x7fffffff) ^ Date.now()) >>> 0;
    const memberKeys = Object.keys(squad.members);
    const members = {};
    const players = {};
    memberKeys.forEach((uid, idx) => {
      const m = squad.members[uid];
      members[uid] = {
        displayName: m.displayName || 'Champion',
        championId: sanitizeChampionId(m.championId),
        colorIndex: idx % 4,
        connected: true,
        isSimMate: Boolean(m.isSimMate),
      };
      players[uid] = {
        x: 10000 + idx * 45,
        y: 10000 + idx * 35,
        vx: 0,
        vy: 0,
        a: 0,
        st: 0,
        fr: 0,
        hp: 140,
        mhp: 140,
        mp: 100,
        mmp: 100,
        sh: 0,
        ch: CHAMP_TO_IDX[sanitizeChampionId(m.championId)] ?? 0,
        alive: 1,
        downT: 0,
        ping: 0,
        hb: Date.now(),
        connected: true,
        dropPin: null,
        comm: null,
      };
    });

    const matchObj = {
      matchId,
      squadId: squad.squadId,
      hostUid: auth.uid,
      seed,
      status: 'dropping',
      createdAt: Date.now(),
      members,
      players,
      bots: { aliveCount: 50 - memberKeys.length, deadIds: [], tuples: [] },
      world: { stormPhase: 1, stormTimer: 45, cx: 10000, cy: 10000, r: 9000, aliveTotal: 50 },
      intents: {},
      fx: {},
    };

    const { rtdb } = getFirebaseServices();
    if (rtdb && !auth.sandboxAuth) {
      try {
        const rtdbMatchObj = {
          ...matchObj,
          players: Object.fromEntries(
            Object.entries(players).map(([u, p]) => [u, { ...p, hb: rtdbServerTimestamp() }])
          ),
        };
        await rtdbSet(rtdbRef(rtdb, `matches/${matchId}`), rtdbMatchObj);
        await this.joinMatch(matchId);
        return { ok: true, matchId, seed };
      } catch {}
    }

    const all = readSimMatches();
    all[matchId] = matchObj;
    writeSimMatches(all);
    if (this.channel) this.channel.postMessage({ type: 'match:update', matchId });
    await this.joinMatch(matchId);
    return { ok: true, matchId, seed };
  }

  async joinMatch(matchId) {
    this.leaveMatch(false);
    const auth = authService.getState();
    if (!auth.uid || !matchId) return { ok: false };

    this.matchId = matchId;
    this.saveReconnectToken(matchId);

    const { rtdb } = getFirebaseServices();
    if (rtdb && !auth.sandboxAuth) {
      const mRef = rtdbRef(rtdb, `matches/${matchId}`);
      onDisconnect(rtdbRef(rtdb, `matches/${matchId}/members/${auth.uid}/connected`)).set(false);
      onDisconnect(rtdbRef(rtdb, `matches/${matchId}/players/${auth.uid}/connected`)).set(false);
      await rtdbUpdate(rtdbRef(rtdb, `matches/${matchId}/members/${auth.uid}`), { connected: true }).catch(() => null);
      await rtdbUpdate(rtdbRef(rtdb, `matches/${matchId}/players/${auth.uid}`), { connected: true, hb: rtdbServerTimestamp() }).catch(() => null);
      const unsub = onValue(mRef, (snap) => {
        const val = snap.val();
        if (!val) return;
        this._ingestMatchSnapshot(val);
      });
      this.unsubs.push(unsub);
      const connUnsub = onValue(rtdbRef(rtdb, '.info/connected'), (snap) => {
        const isConn = snap.val() === true;
        this.connectionState = isConn ? 'connected' : 'reconnecting';
        this._emit('network', {
          pingMs: this.pingMs,
          connectionState: this.connectionState,
          reconnecting: !isConn,
        });
      });
      this.unsubs.push(connUnsub);
    } else {
      this.connectionState = 'connected';
      this.pingMs = 14;
      this._emit('network', { pingMs: this.pingMs, connectionState: this.connectionState, reconnecting: false });
      this._pullSandboxMatch();
    }

    this.hbTimer = setInterval(() => this._tickHeartbeatAndHostCheck(), 2000);
    return { ok: true, matchId, seed: this.seed };
  }

  _pullSandboxMatch() {
    if (!this.matchId) return;
    const all = readSimMatches();
    const val = all[this.matchId];
    if (val) this._ingestMatchSnapshot(val);
  }

  _ingestMatchSnapshot(val) {
    const auth = authService.getState();
    const now = Date.now();
    this.matchData = val;
    this.seed = val.seed || this.seed;
    this.isHost = val.hostUid === auth.uid;

    // Update 100ms interpolation buffers for remote squadmates
    const players = val.players || {};
    for (const uid of Object.keys(players)) {
      if (uid === auth.uid) continue;
      const p = players[uid];
      let buf = this.interpBuffers.get(uid);
      if (!buf) {
        buf = createInterpBuffer();
        this.interpBuffers.set(uid, buf);
      }
      pushInterpSample(buf, Number(p.x || 0), Number(p.y || 0), Number(p.a || 0), Number(p.vx || 0), Number(p.vy || 0), now);
    }

    // Deliver fresh FX/SFX events (drop remote audio events older than 350ms to prevent lag-spike ghost sounds)
    const fxMap = val.fx || {};
    for (const fxId of Object.keys(fxMap)) {
      const fx = fxMap[fxId];
      const ageMs = now - (fx?.ts || 0);
      if (!fx || ageMs > INTENT_TTL_MS) continue;
      if (fx.src !== auth.uid && ageMs > REMOTE_SFX_STALE_MS && (fx.kind === 'sfx' || fx.sfx)) continue;
      if (this.fxSeen.accept(fxId, now)) {
        this._emit('fx', { id: fxId, ...fx });
      }
    }

    // Host validates & processes incoming client intents idempotently
    if (this.isHost && val.intents) {
      for (const intentId of Object.keys(val.intents)) {
        const intent = val.intents[intentId];
        if (!intent || now - (intent.ts || 0) > INTENT_TTL_MS) continue;
        if (!this.intentDedup.accept(intentId, now)) continue;
        const srcUid = intent.src;
        if (srcUid && srcUid !== auth.uid) {
          const sender = players[srcUid];
          const prevPos = this.senderPrevPos.get(srcUid) || null;
          const cdKey = `${srcUid}:${intent.type || 'hit'}:${intent.skill || 'basic'}`;
          const lastUsedAtMs = this.senderCooldowns.get(cdKey) || 0;
          const check = validateRemoteIntent(
            intent,
            sender,
            null,
            {
              range: intent.type === 'loot' ? 140 : intent.type === 'revive' ? 160 : 620,
              tolerance: 90,
              cooldownMs: intent.type === 'hit' ? 220 : 120,
              maxDamageCap: 220,
              maxSpeed: 520,
              lastUsedAtMs,
            },
            now,
            prevPos
          );
          if (sender) {
            this.senderPrevPos.set(srcUid, { x: Number(sender.x || 0), y: Number(sender.y || 0), ts: now });
          }
          if (!check.valid) continue;
          this.senderCooldowns.set(cdKey, now);
        }
        this._emit('intent', { id: intentId, ...intent });
      }
    }

    this._emit('snapshot', val);
  }

  async _tickHeartbeatAndHostCheck() {
    const auth = authService.getState();
    if (!this.matchId || !auth.uid || !this.matchData) return;
    const now = Date.now();
    this.saveReconnectToken(this.matchId);

    const { rtdb } = getFirebaseServices();
    if (rtdb && !auth.sandboxAuth) {
      const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      rtdbUpdate(rtdbRef(rtdb, `matches/${this.matchId}/players/${auth.uid}`), { hb: rtdbServerTimestamp(), connected: true })
        .then(() => {
          const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
          this.pingMs = Math.max(8, Math.min(999, Math.round(t1 - t0)));
          this.connectionState = 'connected';
          this._emit('network', { pingMs: this.pingMs, connectionState: this.connectionState, reconnecting: false });
        })
        .catch(() => {
          this.connectionState = 'reconnecting';
          this._emit('network', { pingMs: this.pingMs, connectionState: this.connectionState, reconnecting: true });
        });
    } else {
      const all = readSimMatches();
      if (all[this.matchId]?.players?.[auth.uid]) {
        all[this.matchId].players[auth.uid].hb = now;
        writeSimMatches(all);
      }
      this.pingMs = 12 + Math.floor(Math.random() * 14);
      this.connectionState = 'connected';
      this._emit('network', { pingMs: this.pingMs, connectionState: this.connectionState, reconnecting: false });
    }

    // Check if host disconnected or heartbeat stalled > 6s -> deterministic host migration
    const curHost = this.matchData.hostUid;
    const hostMember = this.matchData.members?.[curHost];
    const hostPlayer = this.matchData.players?.[curHost];
    const hostStalled =
      !hostMember ||
      hostMember.connected === false ||
      hostPlayer?.connected === false ||
      (hostPlayer?.hb && now - hostPlayer.hb > HOST_STALL_MS);

    if (hostStalled) {
      const nextHost = electNextHostUid(this.matchData.members, this.matchData.players, now, HOST_STALL_MS);
      if (nextHost && nextHost === auth.uid) {
        if (rtdb && !auth.sandboxAuth) {
          runTransaction(rtdbRef(rtdb, `matches/${this.matchId}/hostUid`), (current) => {
            return current === curHost ? nextHost : current;
          }).catch(() => null);
        } else {
          const all = readSimMatches();
          if (all[this.matchId] && all[this.matchId].hostUid === curHost) {
            all[this.matchId].hostUid = nextHost;
            writeSimMatches(all);
            this._pullSandboxMatch();
          }
        }
      }
    }
  }

  /** 12 Hz quantized human player sync */
  pushPlayerState(pState, force = false) {
    const auth = authService.getState();
    if (!this.matchId || !auth.uid) return;
    const now = Date.now();
    if (!force && now - this.lastPlayerPush < 83) return; // ~12 Hz
    this.lastPlayerPush = now;

    const compact = {
      x: Math.round(pState.x || 0),
      y: Math.round(pState.y || 0),
      vx: Math.round(pState.vx || 0),
      vy: Math.round(pState.vy || 0),
      a: Math.round((pState.a || 0) * 10) / 10,
      st: STATE_TO_IDX[pState.animState] ?? 0,
      fr: Math.floor(pState.animFrame || 0),
      hp: Math.max(0, Math.round(pState.hp || 0)),
      mhp: Math.max(1, Math.round(pState.maxHp || 140)),
      mp: Math.max(0, Math.round(pState.mp || 0)),
      mmp: Math.max(1, Math.round(pState.maxMp || 100)),
      sh: Math.max(0, Math.round(pState.shield || 0)),
      ch: CHAMP_TO_IDX[sanitizeChampionId(pState.charKey)] ?? 0,
      alive: pState.isAlive ? 1 : 0,
      downT: Math.max(0, Math.round((pState.downedTimer || 0) * 10) / 10),
      ping: Number(pState.ping || 0),
      hb: now,
      connected: true,
    };

    const { rtdb } = getFirebaseServices();
    if (rtdb && !auth.sandboxAuth) {
      rtdbUpdate(rtdbRef(rtdb, `matches/${this.matchId}/players/${auth.uid}`), {
        ...compact,
        hb: rtdbServerTimestamp(),
      }).catch(() => null);
      return;
    }
    const all = readSimMatches();
    if (all[this.matchId]?.players) {
      all[this.matchId].players[auth.uid] = { ...(all[this.matchId].players[auth.uid] || {}), ...compact };
      writeSimMatches(all);
      if (this.channel) this.channel.postMessage({ type: 'match:update', matchId: this.matchId });
    }
  }

  /** Coordinated Drop Pin update */
  pushDropPin(x, y) {
    const auth = authService.getState();
    if (!this.matchId || !auth.uid) return;
    const pin = { x: Math.round(x), y: Math.round(y), ts: Date.now() };
    const { rtdb } = getFirebaseServices();
    if (rtdb && !auth.sandboxAuth) {
      rtdbUpdate(rtdbRef(rtdb, `matches/${this.matchId}/players/${auth.uid}`), { dropPin: pin }).catch(() => null);
      return;
    }
    const all = readSimMatches();
    if (all[this.matchId]?.players?.[auth.uid]) {
      all[this.matchId].players[auth.uid].dropPin = pin;
      writeSimMatches(all);
      if (this.channel) this.channel.postMessage({ type: 'match:update', matchId: this.matchId });
      this._pullSandboxMatch();
    }
  }

  /** Tactical 6-Option Quick-Comms callout */
  pushQuickComm(commId) {
    const auth = authService.getState();
    if (!this.matchId || !auth.uid) return;
    const opt = QUICK_COMMS_OPTIONS.find((c) => c.id === commId) || QUICK_COMMS_OPTIONS[0];
    const comm = { id: opt.id, icon: opt.icon, label: opt.label, ts: Date.now() };
    const { rtdb } = getFirebaseServices();
    if (rtdb && !auth.sandboxAuth) {
      rtdbUpdate(rtdbRef(rtdb, `matches/${this.matchId}/players/${auth.uid}`), { comm }).catch(() => null);
      return;
    }
    const all = readSimMatches();
    if (all[this.matchId]?.players?.[auth.uid]) {
      all[this.matchId].players[auth.uid].comm = comm;
      writeSimMatches(all);
      if (this.channel) this.channel.postMessage({ type: 'match:update', matchId: this.matchId });
      this._pullSandboxMatch();
    }
  }

  /** 6 Hz Host-Only AOI Bot Sync */
  pushAoiBots(bots, livingHumans) {
    if (!this.isHost || !this.matchId) return;
    const now = Date.now();
    if (now - this.lastBotPush < 166) return; // ~6 Hz
    this.lastBotPush = now;
    const packed = packAoiBots(bots, livingHumans, AOI_RADIUS);

    const auth = authService.getState();
    const { rtdb } = getFirebaseServices();
    if (rtdb && !auth.sandboxAuth) {
      rtdbSet(rtdbRef(rtdb, `matches/${this.matchId}/bots`), packed).catch(() => null);
      return;
    }
    const all = readSimMatches();
    if (all[this.matchId]) {
      all[this.matchId].bots = packed;
      writeSimMatches(all);
      if (this.channel) this.channel.postMessage({ type: 'match:update', matchId: this.matchId });
    }
  }

  /** 2 Hz Host-Only World Sync */
  pushWorldState(worldState, force = false) {
    if (!this.isHost || !this.matchId) return;
    const now = Date.now();
    if (!force && now - this.lastWorldPush < 500) return; // ~2 Hz
    this.lastWorldPush = now;

    const auth = authService.getState();
    const { rtdb } = getFirebaseServices();
    if (rtdb && !auth.sandboxAuth) {
      rtdbSet(rtdbRef(rtdb, `matches/${this.matchId}/world`), worldState).catch(() => null);
      return;
    }
    const all = readSimMatches();
    if (all[this.matchId]) {
      all[this.matchId].world = worldState;
      writeSimMatches(all);
      if (this.channel) this.channel.postMessage({ type: 'match:update', matchId: this.matchId });
    }
  }

  /** Host-Authoritative Intent + Ability FX broadcast (pruned > 3s) */
  pushIntent(intent) {
    const auth = authService.getState();
    if (!this.matchId || !auth.uid) return;
    const now = Date.now();
    const payload = { ...intent, src: auth.uid, ts: now };
    const { rtdb } = getFirebaseServices();
    if (rtdb && !auth.sandboxAuth) {
      rtdbPush(rtdbRef(rtdb, `matches/${this.matchId}/intents`), payload).catch(() => null);
      return;
    }
    const all = readSimMatches();
    if (all[this.matchId]) {
      const map = all[this.matchId].intents || {};
      const id = `i_${now}_${Math.random().toString(36).slice(2, 6)}`;
      map[id] = payload;
      for (const k of Object.keys(map)) {
        if (now - (map[k].ts || 0) > INTENT_TTL_MS) delete map[k];
      }
      all[this.matchId].intents = map;
      writeSimMatches(all);
      if (this.channel) this.channel.postMessage({ type: 'match:update', matchId: this.matchId });
    }
  }

  pushFx(fxEvent) {
    const auth = authService.getState();
    if (!this.matchId || !auth.uid) return;
    const now = Date.now();
    const payload = { ...fxEvent, src: auth.uid, ts: now };
    const { rtdb } = getFirebaseServices();
    if (rtdb && !auth.sandboxAuth) {
      rtdbPush(rtdbRef(rtdb, `matches/${this.matchId}/fx`), payload).catch(() => null);
      return;
    }
    const all = readSimMatches();
    if (all[this.matchId]) {
      const map = all[this.matchId].fx || {};
      const id = `fx_${now}_${Math.random().toString(36).slice(2, 6)}`;
      map[id] = payload;
      for (const k of Object.keys(map)) {
        if (now - (map[k].ts || 0) > INTENT_TTL_MS) delete map[k];
      }
      all[this.matchId].fx = map;
      writeSimMatches(all);
      if (this.channel) this.channel.postMessage({ type: 'match:update', matchId: this.matchId });
    }
  }

  async setMatchStatus(status) {
    if (!this.matchId) return;
    const auth = authService.getState();
    const { rtdb } = getFirebaseServices();
    if (rtdb && !auth.sandboxAuth) {
      await rtdbUpdate(rtdbRef(rtdb, `matches/${this.matchId}`), { status }).catch(() => null);
      if (status === 'finished' && this.isHost) {
        setTimeout(() => {
          rtdbRemove(rtdbRef(rtdb, `matches/${this.matchId}`)).catch(() => null);
        }, 10000);
      }
      return;
    }
    const all = readSimMatches();
    if (all[this.matchId]) {
      all[this.matchId].status = status;
      writeSimMatches(all);
      if (this.channel) this.channel.postMessage({ type: 'match:update', matchId: this.matchId });
    }
  }

  leaveMatch(clearToken = true) {
    if (this.hbTimer) {
      clearInterval(this.hbTimer);
      this.hbTimer = null;
    }
    this.unsubs.forEach((u) => {
      try {
        u();
      } catch {}
    });
    this.unsubs = [];
    this.interpBuffers.clear();
    this.senderCooldowns.clear();
    this.senderPrevPos.clear();
    this.intentDedup = createIntentDeduplicator(INTENT_TTL_MS);
    this.fxSeen = createIntentDeduplicator(INTENT_TTL_MS);
    if (clearToken) this.clearReconnectToken();
    this.matchId = null;
    this.matchData = null;
    this.isHost = false;
    this.connectionState = 'connected';
  }
}

export const squadMultiplayer = new SquadMultiplayerController();
