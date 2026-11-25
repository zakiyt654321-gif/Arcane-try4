export type BotArchetypeRole = 'BRAWLER' | 'ZONER' | 'FLANKER';

export interface BotArchetypeConfig {
  role: BotArchetypeRole;
  badgeColor: string;
  minRange: number;
  maxRange: number;
  retreatHpRatio: number;
  dashMode: 'GAP_CLOSE' | 'ESCAPE_MELEE' | 'LATERAL_DISENGAGE';
  mpReserveRatio: number;
  spellTelegraphSec: number;
  spellBufferMinSec: number;
  spellBufferMaxSec: number;
  dashCooldownMinSec: number;
  dashCooldownMaxSec: number;
}

export const BOT_ARCHETYPES: Record<'fire' | 'water' | 'dark', BotArchetypeConfig> = {
  fire: {
    role: 'BRAWLER',
    badgeColor: '#fb923c',
    minRange: 45,
    maxRange: 110,
    retreatHpRatio: 0.25,
    dashMode: 'GAP_CLOSE',
    mpReserveRatio: 0.15,
    spellTelegraphSec: 0.35,
    spellBufferMinSec: 0.7,
    spellBufferMaxSec: 1.1,
    dashCooldownMinSec: 6.0,
    dashCooldownMaxSec: 8.0,
  },
  water: {
    role: 'ZONER',
    badgeColor: '#38bdf8',
    minRange: 210,
    maxRange: 340,
    retreatHpRatio: 0.45,
    dashMode: 'ESCAPE_MELEE',
    mpReserveRatio: 0.45,
    spellTelegraphSec: 0.35,
    spellBufferMinSec: 0.7,
    spellBufferMaxSec: 1.1,
    dashCooldownMinSec: 6.0,
    dashCooldownMaxSec: 8.0,
  },
  dark: {
    role: 'FLANKER',
    badgeColor: '#c084fc',
    minRange: 150,
    maxRange: 230,
    retreatHpRatio: 0.32,
    dashMode: 'LATERAL_DISENGAGE',
    mpReserveRatio: 0.2,
    spellTelegraphSec: 0.35,
    spellBufferMinSec: 0.7,
    spellBufferMaxSec: 1.1,
    dashCooldownMinSec: 6.0,
    dashCooldownMaxSec: 8.0,
  },
};

export function getBotArchetype(charId: string): BotArchetypeConfig {
  if (charId === 'water') return BOT_ARCHETYPES.water;
  if (charId === 'dark') return BOT_ARCHETYPES.dark;
  return BOT_ARCHETYPES.fire;
}

export interface AggroCandidate {
  id: string;
  distToPlayer: number;
  isAlive: boolean;
}

/**
 * Limits active aggro against the human player to at most `maxAggro` (default 2)
 * nearest bots. Returns a Set of bot IDs permitted to directly aggro the player.
 */
export function selectPlayerAggroBots(
  candidates: readonly AggroCandidate[],
  maxAggro: number = 2
): Set<string> {
  const cap = Math.max(0, Math.floor(maxAggro));
  const sorted = candidates
    .filter((c) => c.isAlive)
    .sort((a, b) => a.distToPlayer - b.distToPlayer);
  const allowed = new Set<string>();
  for (let i = 0; i < Math.min(cap, sorted.length); i++) {
    allowed.add(sorted[i].id);
  }
  return allowed;
}

export interface CircleObstacle {
  x: number;
  y: number;
  r: number;
}

/**
 * 3 forward feeler probes (center, -30deg, +30deg) to steer smoothly around
 * obstacles without wall-sticking.
 */
export function computeFeelerSteering(
  x: number,
  y: number,
  desiredAngle: number,
  obstacles: readonly CircleObstacle[],
  probeDist: number = 85,
  entityRadius: number = 20
): { angle: number; blockedCenter: boolean; steerOffsetRad: number } {
  const spread = (30 * Math.PI) / 180;
  const checkProbe = (ang: number): number => {
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    let minClear = 1.0;
    for (let i = 0; i < obstacles.length; i++) {
      const ob = obstacles[i];
      const pad = ob.r + entityRadius;
      // Sample mid and tip of feeler ray
      for (const frac of [0.5, 1.0]) {
        const px = x + cos * probeDist * frac;
        const py = y + sin * probeDist * frac;
        const d = Math.hypot(px - ob.x, py - ob.y);
        if (d < pad) {
          minClear = Math.min(minClear, frac * 0.5);
        }
      }
    }
    return minClear;
  };

  const centerClear = checkProbe(desiredAngle);
  if (centerClear >= 0.99) {
    return { angle: desiredAngle, blockedCenter: false, steerOffsetRad: 0 };
  }
  const leftClear = checkProbe(desiredAngle - spread);
  const rightClear = checkProbe(desiredAngle + spread);

  if (leftClear > rightClear) {
    const offset = leftClear >= 0.99 ? -spread : -spread * 1.65;
    return { angle: desiredAngle + offset, blockedCenter: true, steerOffsetRad: offset };
  }
  if (rightClear > leftClear) {
    const offset = rightClear >= 0.99 ? spread : spread * 1.65;
    return { angle: desiredAngle + offset, blockedCenter: true, steerOffsetRad: offset };
  }
  // Both sides blocked: steer sharply right to escape pocket
  const fallbackOffset = Math.PI * 0.55;
  return { angle: desiredAngle + fallbackOffset, blockedCenter: true, steerOffsetRad: fallbackOffset };
}

export function shouldPrioritizeStormEscape(
  x: number,
  y: number,
  stormX: number,
  stormY: number,
  stormRadius: number,
  stormClosing: boolean,
  borderMargin: number = 90
): boolean {
  const dist = Math.hypot(x - stormX, y - stormY);
  if (dist >= Math.max(0, stormRadius - borderMargin)) return true;
  if (stormClosing && dist > stormRadius * 0.78) return true;
  return false;
}

export interface BountyEntity {
  id: string;
  kills: number;
  isAlive: boolean;
}

export function findBountyLeader(
  entities: readonly BountyEntity[],
  minKills: number = 3
): BountyEntity | null {
  let leader: BountyEntity | null = null;
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    if (!e.isAlive || e.kills < minKills) continue;
    if (!leader || e.kills > leader.kills) {
      leader = e;
    }
  }
  return leader;
}

export function computeBountyElimRewards(
  baseCoins: number,
  baseXp: number,
  isBountyLeader: boolean
): { coins: number; xp: number; bonusXp: number; isBounty: boolean } {
  if (!isBountyLeader) {
    return { coins: baseCoins, xp: baseXp, bonusXp: 0, isBounty: false };
  }
  const bonusXp = 75;
  return {
    coins: Math.round(baseCoins * 2),
    xp: Math.round(baseXp + bonusXp),
    bonusXp,
    isBounty: true,
  };
}

export interface ArcaneJumpPad {
  id: string;
  x: number;
  y: number;
  radius: number;
  launchSpeed: number;
  airtimeSec: number;
  cooldownSec: number;
}

export function createArcaneJumpPads(mapSize: number): ArcaneJumpPad[] {
  const c = mapSize * 0.5;
  const ring = mapSize * 0.24;
  const offsets: Array<[string, number, number]> = [
    ['pad_nw', -ring * 0.78, -ring * 0.72],
    ['pad_ne', ring * 0.76, -ring * 0.74],
    ['pad_e', ring * 1.02, ring * 0.06],
    ['pad_se', ring * 0.72, ring * 0.78],
    ['pad_sw', -ring * 0.76, ring * 0.76],
    ['pad_w', -ring * 1.02, -ring * 0.04],
  ];
  return offsets.map(([id, dx, dy]) => ({
    id,
    x: Math.round(c + dx),
    y: Math.round(c + dy),
    radius: 34,
    launchSpeed: 640,
    airtimeSec: 1.0,
    cooldownSec: 5.0,
  }));
}

export function canTriggerJumpPad(
  entityX: number,
  entityY: number,
  entityZ: number,
  lastPadUseTime: number,
  pad: ArcaneJumpPad,
  gameTime: number
): boolean {
  if (entityZ > 6) return false;
  if (gameTime - lastPadUseTime < pad.cooldownSec) return false;
  return Math.hypot(entityX - pad.x, entityY - pad.y) <= pad.radius;
}

export interface SaveBackupPayload {
  v: number;
  app: 'arcane_royale';
  save: Record<string, unknown>;
  hudLayout?: Record<string, unknown> | null;
}

export function encodeSaveBackup(
  save: Record<string, unknown>,
  hudLayout?: Record<string, unknown> | null
): string {
  const payload: SaveBackupPayload = {
    v: 3,
    app: 'arcane_royale',
    save,
    hudLayout: hudLayout || null,
  };
  const json = JSON.stringify(payload);
  // UTF-8 safe Base64 encoding for both Node and Browser
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(json, 'utf8').toString('base64');
  }
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function decodeSaveBackup(
  rawCode: string
): { ok: true; payload: SaveBackupPayload } | { ok: false; error: string } {
  const cleaned = String(rawCode || '').trim().replace(/\s+/g, '');
  if (!cleaned || cleaned.length < 16) {
    return { ok: false, error: 'Save code is empty or too short.' };
  }
  try {
    let json = '';
    if (typeof Buffer !== 'undefined') {
      json = Buffer.from(cleaned, 'base64').toString('utf8');
    } else {
      const binary = atob(cleaned);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      json = new TextDecoder().decode(bytes);
    }
    const parsed = JSON.parse(json) as Partial<SaveBackupPayload>;
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, error: 'Decoded payload is not a valid object.' };
    }
    if (parsed.app !== 'arcane_royale' || !parsed.save || typeof parsed.save !== 'object') {
      return { ok: false, error: 'Code is not a valid Arcane Royale backup.' };
    }
    const saveObj = parsed.save as Record<string, unknown>;
    if (typeof saveObj.level !== 'number' && typeof saveObj.gold !== 'number' && typeof saveObj.name !== 'string') {
      return { ok: false, error: 'Backup is missing required player save fields.' };
    }
    return {
      ok: true,
      payload: {
        v: Number(parsed.v) || 3,
        app: 'arcane_royale',
        save: saveObj,
        hudLayout: parsed.hudLayout && typeof parsed.hudLayout === 'object' ? (parsed.hudLayout as Record<string, unknown>) : null,
      },
    };
  } catch {
    return { ok: false, error: 'Invalid Base64 or corrupted JSON save code.' };
  }
}

export function shouldStepBatterySaverFrame(
  elapsedSinceLastRenderMs: number,
  batterySaver30Fps: boolean
): boolean {
  if (!batterySaver30Fps) return true;
  return elapsedSinceLastRenderMs >= 32.5;
}
