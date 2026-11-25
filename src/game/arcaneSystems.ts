export type UpgradeStatKey = 'maxHealth' | 'movementSpeed' | 'attackPower';

export interface StatUpgrades {
  maxHealth: number;
  movementSpeed: number;
  attackPower: number;
}

export interface UpgradeDefinition {
  key: UpgradeStatKey;
  label: string;
  shortLabel: string;
  description: string;
  maxRank: number;
  baseCost: number;
  costStep: number;
  bonusPerRank: number;
  unit: string;
}

export const STAT_UPGRADE_DEFS: Record<UpgradeStatKey, UpgradeDefinition> = {
  maxHealth: {
    key: 'maxHealth',
    label: 'Maximum Health',
    shortLabel: 'Vitality',
    description: '+15 Max HP per rank across all champions.',
    maxRank: 10,
    baseCost: 40,
    costStep: 30,
    bonusPerRank: 15,
    unit: 'HP',
  },
  movementSpeed: {
    key: 'movementSpeed',
    label: 'Movement Speed',
    shortLabel: 'Agility',
    description: '+0.25 Move Speed per rank for faster rotations and kiting.',
    maxRank: 10,
    baseCost: 45,
    costStep: 35,
    bonusPerRank: 0.25,
    unit: 'SPD',
  },
  attackPower: {
    key: 'attackPower',
    label: 'Attack Power',
    shortLabel: 'Might',
    description: '+2.5 Sword & +3.0 Spell Damage per rank.',
    maxRank: 10,
    baseCost: 50,
    costStep: 35,
    bonusPerRank: 2.5,
    unit: 'ATK',
  },
};

export interface BaseHeroStats {
  PWR: number;
  FOC: number;
  AGI: number;
  VIT: number;
}

export interface DerivedHeroStats {
  maxHp: number;
  maxMana: number;
  manaRegen: number;
  speed: number;
  swordDamage: number;
  spellDamage: number;
}

export function normalizeStatUpgrades(raw?: Partial<StatUpgrades> | null): StatUpgrades {
  const clampRank = (value: unknown, maxRank: number): number => {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(maxRank, n);
  };
  return {
    maxHealth: clampRank(raw?.maxHealth, STAT_UPGRADE_DEFS.maxHealth.maxRank),
    movementSpeed: clampRank(raw?.movementSpeed, STAT_UPGRADE_DEFS.movementSpeed.maxRank),
    attackPower: clampRank(raw?.attackPower, STAT_UPGRADE_DEFS.attackPower.maxRank),
  };
}

export function getUpgradeCost(statKey: UpgradeStatKey, currentRank: number): number {
  const def = STAT_UPGRADE_DEFS[statKey];
  const safeRank = Math.max(0, Math.floor(currentRank));
  if (safeRank >= def.maxRank) return Infinity;
  return def.baseCost + safeRank * def.costStep;
}

export function applyXpUpgrade(
  spendableXp: number,
  upgrades: StatUpgrades,
  statKey: UpgradeStatKey
): { ok: boolean; reason?: string; cost: number; remainingXp: number; upgrades: StatUpgrades } {
  const normalized = normalizeStatUpgrades(upgrades);
  const def = STAT_UPGRADE_DEFS[statKey];
  const currentRank = normalized[statKey];
  if (currentRank >= def.maxRank) {
    return {
      ok: false,
      reason: 'MAX_RANK',
      cost: 0,
      remainingXp: spendableXp,
      upgrades: normalized,
    };
  }
  const cost = getUpgradeCost(statKey, currentRank);
  if (spendableXp < cost) {
    return {
      ok: false,
      reason: 'INSUFFICIENT_XP',
      cost,
      remainingXp: spendableXp,
      upgrades: normalized,
    };
  }
  return {
    ok: true,
    cost,
    remainingXp: spendableXp - cost,
    upgrades: {
      ...normalized,
      [statKey]: currentRank + 1,
    },
  };
}

export function computePlayerDerivedStats(
  baseStats: BaseHeroStats,
  upgrades?: Partial<StatUpgrades> | null
): DerivedHeroStats {
  const up = normalizeStatUpgrades(upgrades);
  return {
    maxHp: 80 + baseStats.VIT * 5 + up.maxHealth * STAT_UPGRADE_DEFS.maxHealth.bonusPerRank,
    maxMana: 100 + baseStats.FOC * 2,
    manaRegen: 4.5 + baseStats.FOC * 0.2,
    speed: 3 + baseStats.AGI * 0.2 + up.movementSpeed * STAT_UPGRADE_DEFS.movementSpeed.bonusPerRank,
    swordDamage: 10 * (baseStats.PWR / 10) + up.attackPower * 2.5,
    spellDamage: 15 * (baseStats.FOC / 10) + up.attackPower * 3.0,
  };
}

export interface MatchXpInput {
  survivalSeconds: number;
  kills: number;
  isVictory: boolean;
  placement: number;
}

export interface MatchXpBreakdown {
  survivalXp: number;
  combatXp: number;
  placementXp: number;
  totalXp: number;
}

export function calculateMatchXp(input: MatchXpInput): MatchXpBreakdown {
  const safeTime = Math.max(0, Number(input.survivalSeconds) || 0);
  const safeKills = Math.max(0, Math.floor(Number(input.kills) || 0));
  const safePlacement = Math.max(1, Math.floor(Number(input.placement) || 50));

  // Earn 1 XP every 2 seconds survived (minimum 5 XP if survived at least 5 seconds)
  const survivalXp = safeTime >= 5 ? Math.max(5, Math.floor(safeTime * 0.5)) : Math.floor(safeTime * 0.5);
  const combatXp = safeKills * 25;
  const placementXp = input.isVictory || safePlacement === 1 ? 50 : safePlacement <= 3 ? 25 : safePlacement <= 10 ? 15 : 10;

  return {
    survivalXp,
    combatXp,
    placementXp,
    totalXp: survivalXp + combatXp + placementXp,
  };
}

// ==========================================
// QUICK-PING DOUBLE-TAP & BOT HIGHLIGHT LOGIC
// ==========================================
export interface MinimapTapMemory {
  timeMs: number;
  screenX: number;
  screenY: number;
}

export function isMinimapDoubleTap(
  prevTap: MinimapTapMemory | null,
  nowMs: number,
  screenX: number,
  screenY: number,
  maxIntervalMs = 340,
  maxDistancePx = 28
): boolean {
  if (!prevTap) return false;
  const dt = nowMs - prevTap.timeMs;
  if (dt < 0 || dt > maxIntervalMs) return false;
  return Math.hypot(screenX - prevTap.screenX, screenY - prevTap.screenY) <= maxDistancePx;
}

export interface PingBotCandidate {
  id: number;
  x: number;
  y: number;
  isAlive: boolean;
  isPlayer: boolean;
  state?: string;
}

export function selectBotsForPingHighlight(
  bots: PingBotCandidate[],
  pingX: number,
  pingY: number,
  maxRadius = 4200,
  maxResponders = 4
): number[] {
  const ranked: Array<{ id: number; dist: number }> = [];
  for (const b of bots) {
    if (!b.isAlive || b.isPlayer) continue;
    if (b.state === 'FLEE' || b.state === 'STORM_RETREAT' || b.state === 'HEAL') continue;
    const dist = Math.hypot(b.x - pingX, b.y - pingY);
    if (dist <= maxRadius) {
      ranked.push({ id: b.id, dist });
    }
  }
  ranked.sort((a, b) => a.dist - b.dist);
  return ranked.slice(0, maxResponders).map((r) => r.id);
}

// ==========================================
// KILLCAM 2-SECOND SLOW-MO TRAJECTORY LOGIC
// ==========================================
export interface TrajectoryPoint {
  x: number;
  y: number;
}

export const KILLCAM_DURATION_SECONDS = 2.0;

export function sampleKillcamTrajectory(
  points: TrajectoryPoint[],
  elapsedSeconds: number,
  durationSeconds = KILLCAM_DURATION_SECONDS
): {
  progress: number;
  visiblePoints: TrajectoryPoint[];
  head: TrajectoryPoint | null;
  impactReached: boolean;
} {
  if (!points || points.length === 0) {
    return { progress: 0, visiblePoints: [], head: null, impactReached: false };
  }
  if (points.length === 1) {
    return {
      progress: 1,
      visiblePoints: [points[0]],
      head: points[0],
      impactReached: true,
    };
  }

  const clampedDuration = Math.max(0.1, durationSeconds);
  const progress = Math.max(0, Math.min(1, elapsedSeconds / clampedDuration));

  // Compute cumulative arc length so slow-motion speed stays smooth along the path
  const cumLengths: number[] = [0];
  let totalLength = 0;
  for (let i = 1; i < points.length; i++) {
    totalLength += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    cumLengths.push(totalLength);
  }

  if (totalLength <= 0.0001) {
    return {
      progress,
      visiblePoints: [points[0], points[points.length - 1]],
      head: points[points.length - 1],
      impactReached: progress >= 1,
    };
  }

  const targetDist = totalLength * progress;
  const visiblePoints: TrajectoryPoint[] = [{ x: points[0].x, y: points[0].y }];
  let head: TrajectoryPoint = { x: points[0].x, y: points[0].y };

  for (let i = 1; i < points.length; i++) {
    const segStart = cumLengths[i - 1];
    const segEnd = cumLengths[i];
    if (segEnd <= targetDist) {
      visiblePoints.push({ x: points[i].x, y: points[i].y });
      head = { x: points[i].x, y: points[i].y };
    } else {
      const segLen = Math.max(0.0001, segEnd - segStart);
      const localT = Math.max(0, Math.min(1, (targetDist - segStart) / segLen));
      head = {
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * localT,
        y: points[i - 1].y + (points[i].y - points[i - 1].y) * localT,
      };
      visiblePoints.push(head);
      break;
    }
  }

  return {
    progress,
    visiblePoints,
    head,
    impactReached: progress >= 0.999,
  };
}

// ==========================================
// PROCEDURAL BIOME WEATHER SYSTEM
// ==========================================
export type BiomeId = 'forest' | 'snow' | 'ruins' | 'meadow' | 'village' | 'quarry' | 'harbour' | 'coast';
export type WeatherKind = 'CLEAR' | 'FOREST_RAIN' | 'SNOWSTORM' | 'SAND_SQUALL' | 'CRYSTAL_SURGE' | 'COASTAL_GALE';

export interface BiomeRect {
  id: string;
  biome: BiomeId;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WeatherEventConfig {
  kind: WeatherKind;
  biome: BiomeId;
  label: string;
  icon: string;
  effectText: string;
  speedMultiplier: number;
  visibilityPenalty: number; // 0 = clear, 0.75 = dense blizzard whiteout
  manaRegenMultiplier: number;
}

export const BIOME_WEATHER_CATALOG: Record<Exclude<WeatherKind, 'CLEAR'>, WeatherEventConfig> = {
  FOREST_RAIN: {
    kind: 'FOREST_RAIN',
    biome: 'forest',
    label: 'Tempest Rain',
    icon: '🌧️',
    effectText: '-18% Move Speed',
    speedMultiplier: 0.82,
    visibilityPenalty: 0.22,
    manaRegenMultiplier: 1.0,
  },
  SNOWSTORM: {
    kind: 'SNOWSTORM',
    biome: 'snow',
    label: 'Northern Blizzard',
    icon: '❄️',
    effectText: 'Low Visibility · -10% Speed',
    speedMultiplier: 0.9,
    visibilityPenalty: 0.72,
    manaRegenMultiplier: 1.0,
  },
  SAND_SQUALL: {
    kind: 'SAND_SQUALL',
    biome: 'ruins',
    label: 'Ash Squall',
    icon: '🌪️',
    effectText: 'Hazy Sight · -8% Speed',
    speedMultiplier: 0.92,
    visibilityPenalty: 0.42,
    manaRegenMultiplier: 1.0,
  },
  CRYSTAL_SURGE: {
    kind: 'CRYSTAL_SURGE',
    biome: 'quarry',
    label: 'Crystal Surge',
    icon: '⚡',
    effectText: '+25% Mana Regen',
    speedMultiplier: 1.0,
    visibilityPenalty: 0.12,
    manaRegenMultiplier: 1.25,
  },
  COASTAL_GALE: {
    kind: 'COASTAL_GALE',
    biome: 'harbour',
    label: 'Harbour Squall',
    icon: '🌊',
    effectText: 'Sea Mist · -10% Speed',
    speedMultiplier: 0.9,
    visibilityPenalty: 0.35,
    manaRegenMultiplier: 1.0,
  },
};

export function getBiomeAtPoint(x: number, y: number, zones: BiomeRect[]): BiomeId {
  for (const z of zones) {
    if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) {
      return z.biome;
    }
  }
  return 'coast';
}

export interface ActiveBiomeWeather {
  kind: WeatherKind;
  biome: BiomeId;
  startedAt: number;
  endsAt: number;
}

export function getWeatherModifiersAtPoint(
  x: number,
  y: number,
  zones: BiomeRect[],
  activeEvents: ActiveBiomeWeather[],
  matchTime: number
): {
  biome: BiomeId;
  activeEvent: WeatherEventConfig | null;
  speedMultiplier: number;
  visibilityPenalty: number;
  manaRegenMultiplier: number;
} {
  const biome = getBiomeAtPoint(x, y, zones);
  for (const ev of activeEvents) {
    if (ev.kind === 'CLEAR') continue;
    if (matchTime >= ev.startedAt && matchTime <= ev.endsAt && ev.biome === biome) {
      const cfg = BIOME_WEATHER_CATALOG[ev.kind];
      return {
        biome,
        activeEvent: cfg,
        speedMultiplier: cfg.speedMultiplier,
        visibilityPenalty: cfg.visibilityPenalty,
        manaRegenMultiplier: cfg.manaRegenMultiplier,
      };
    }
  }
  return {
    biome,
    activeEvent: null,
    speedMultiplier: 1.0,
    visibilityPenalty: 0,
    manaRegenMultiplier: 1.0,
  };
}

export function pickProceduralWeatherKindForBiome(biome: BiomeId, rng = Math.random): Exclude<WeatherKind, 'CLEAR'> {
  if (biome === 'forest') return 'FOREST_RAIN';
  if (biome === 'snow') return 'SNOWSTORM';
  if (biome === 'ruins') return 'SAND_SQUALL';
  if (biome === 'quarry') return 'CRYSTAL_SURGE';
  if (biome === 'harbour') return 'COASTAL_GALE';
  const pool: Array<Exclude<WeatherKind, 'CLEAR'>> = ['FOREST_RAIN', 'SNOWSTORM', 'SAND_SQUALL', 'CRYSTAL_SURGE', 'COASTAL_GALE'];
  const idx = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
  return pool[idx];
}
