export const MAX_PLAYER_LEVEL = 100;
export const DEATH_ANIM_DURATION = 0.85;
export const DEATH_PHASE1_DURATION = 0.15;

export interface MilestoneReward {
  level: number;
  tier: 'MINOR' | 'MAJOR' | 'MAX';
  coins: number;
  crystals: number;
  gems: number;
}

export interface LevelProgressionResult {
  level: number;
  xp: number;
  xpNeeded: number;
  isMaxLevel: boolean;
  levelsGained: number[];
  bonusCoins: number;
  bonusCrystals: number;
  bonusGems: number;
  milestones: MilestoneReward[];
}

export function getXpRequiredForLevel(level: number): number {
  const lv = Math.max(1, Math.min(MAX_PLAYER_LEVEL, Math.floor(Number(level) || 1)));
  return 100 + (lv - 1) * 35 + Math.floor(Math.pow(lv - 1, 1.6) * 5);
}

export function getMilestoneRewardForLevel(level: number): MilestoneReward | null {
  const lv = Math.floor(Number(level) || 0);
  if (lv <= 0 || lv > MAX_PLAYER_LEVEL) return null;
  if (lv === MAX_PLAYER_LEVEL) {
    return { level: 100, tier: 'MAX', coins: 2500, crystals: 1500, gems: 15 };
  }
  if (lv % 10 === 0) {
    return { level: lv, tier: 'MAJOR', coins: 500, crystals: 300, gems: 3 };
  }
  if (lv % 5 === 0) {
    return { level: lv, tier: 'MINOR', coins: 250, crystals: 150, gems: 0 };
  }
  return null;
}

export function applyPlayerLevelProgression(
  currentLevel: number,
  currentXp: number,
  earnedXp: number
): LevelProgressionResult {
  let level = Math.max(1, Math.min(MAX_PLAYER_LEVEL, Math.floor(Number(currentLevel) || 1)));
  let xp = Math.max(0, Math.floor(Number(currentXp) || 0));
  const gain = Math.max(0, Math.floor(Number(earnedXp) || 0));

  const levelsGained: number[] = [];
  const milestones: MilestoneReward[] = [];
  let bonusCoins = 0;
  let bonusCrystals = 0;
  let bonusGems = 0;

  if (level >= MAX_PLAYER_LEVEL) {
    const capXp = getXpRequiredForLevel(MAX_PLAYER_LEVEL);
    return {
      level: MAX_PLAYER_LEVEL,
      xp: capXp,
      xpNeeded: capXp,
      isMaxLevel: true,
      levelsGained,
      bonusCoins,
      bonusCrystals,
      bonusGems,
      milestones,
    };
  }

  xp += gain;

  while (level < MAX_PLAYER_LEVEL) {
    const needed = getXpRequiredForLevel(level);
    if (xp < needed) break;
    xp -= needed;
    level += 1;
    levelsGained.push(level);

    const milestone = getMilestoneRewardForLevel(level);
    if (milestone) {
      milestones.push(milestone);
      bonusCoins += milestone.coins;
      bonusCrystals += milestone.crystals;
      bonusGems += milestone.gems;
    } else {
      bonusCoins += 50;
    }

    if (level >= MAX_PLAYER_LEVEL) {
      level = MAX_PLAYER_LEVEL;
      xp = getXpRequiredForLevel(MAX_PLAYER_LEVEL);
      break;
    }
  }

  const isMaxLevel = level >= MAX_PLAYER_LEVEL;
  const xpNeeded = getXpRequiredForLevel(level);
  if (isMaxLevel) {
    xp = xpNeeded;
  }

  return {
    level,
    xp,
    xpNeeded,
    isMaxLevel,
    levelsGained,
    bonusCoins,
    bonusCrystals,
    bonusGems,
    milestones,
  };
}

export function formatLobbyLevelLabel(level: number): string {
  const lv = Math.max(1, Math.min(MAX_PLAYER_LEVEL, Math.floor(Number(level) || 1)));
  return lv >= MAX_PLAYER_LEVEL ? 'LVL 100 · MAX' : `LVL ${lv}`;
}

export interface BotScalingProfile {
  level: number;
  t: number;
  statMultiplier: number;
  reactionDelay: number;
  aimSpreadDeg: number;
  aimSpreadRad: number;
  shotLeadingEnabled: boolean;
  shotLeadFactor: number;
  artComboEnabled: boolean;
  dodgeChance: number;
  aggression: number;
}

export function computeBotScaling(botLevel: number): BotScalingProfile {
  const level = Math.max(1, Math.min(MAX_PLAYER_LEVEL, Math.floor(Number(botLevel) || 1)));
  const t = (level - 1) / (MAX_PLAYER_LEVEL - 1);
  const statMultiplier = 0.85 + t * 0.27;
  const reactionDelay = 0.55 - t * 0.27;
  const aimSpreadDeg = 14.0 - t * 9.0;
  const aimSpreadRad = aimSpreadDeg * (Math.PI / 180);
  const shotLeadingEnabled = level > 15;
  const shotLeadFactor = shotLeadingEnabled
    ? Math.min(0.5, 0.15 + ((level - 15) / (MAX_PLAYER_LEVEL - 15)) * 0.35)
    : 0;
  const artComboEnabled = level >= 25;
  const dodgeChance = 0.22 + t * 0.33;
  const aggression = 0.58 + t * 0.24;

  return {
    level,
    t,
    statMultiplier,
    reactionDelay,
    aimSpreadDeg,
    aimSpreadRad,
    shotLeadingEnabled,
    shotLeadFactor,
    artComboEnabled,
    dodgeChance,
    aggression,
  };
}

export function assignBotLevels(playerLevel: number, count: number, rng: () => number = Math.random): number[] {
  const base = Math.max(1, Math.min(MAX_PLAYER_LEVEL, Math.floor(Number(playerLevel) || 1)));
  const levels: number[] = [];
  for (let i = 0; i < count; i++) {
    const offset = Math.floor(rng() * 7) - 3; // -3 to +3 inclusive
    levels.push(Math.max(1, Math.min(MAX_PLAYER_LEVEL, base + offset)));
  }
  return levels;
}

export function getOffscreenBotDamageMultiplier(
  stormPhase: number,
  attackerIsPlayer: boolean,
  targetIsPlayer: boolean,
  isOnScreen: boolean
): number {
  if (attackerIsPlayer || targetIsPlayer || isOnScreen) return 1.0;
  if (stormPhase <= 1) return 0.35;
  if (stormPhase === 2) return 0.6;
  return 1.0;
}

export function getBotVisionMultiplier(weatherKind: string | null | undefined): number {
  if (weatherKind === 'SNOWSTORM') return 0.55; // 45% reduction in snow blizzard
  return 1.0;
}

export const BOT_NAME_POOL: readonly string[] = Object.freeze([
  'ShadowVex', 'RiftWalker', 'Kaelen', 'Blaze_99', 'NyxArcana', 'FrostByte', 'ZephyrX', 'AetherKing',
  'Valkyrie_07', 'DravenSoul', 'Solstice', 'Kryos', 'Ashborn', 'Vortexia', 'Ironclad', 'Lunaris',
  'ZeroPing', 'HexWeaver', 'Pyroclast', 'SilentFang', 'Cinderfall', 'TideBreaker', 'AstralKite', 'Vespera',
  'Maelstrom7', 'OnyxBlade', 'StarForge', 'GrimPulse', 'NovaDrift', 'SableWraith', 'EmberVow', 'GlacierX',
  'RunicFox', 'Kestrel_21', 'ObsidianQ', 'Tempestia', 'DuskReaver', 'ArcaneFlux', 'Valkor', 'SirenWave',
  'Blightborn', 'SolarFlare', 'NightShift', 'CobaltEdge', 'Thorne_88', 'EchoStrike', 'MistWalker', 'IgnisRex',
  'VoidStrider', 'Riptide_42', 'AegisPrime', 'ShatterHex', 'CrimsonVex', 'LumenArc', 'StormCrowned', 'FangZero',
  'WraithSong', 'QuasarBit', 'FrostVeil', 'PyreKnight', 'VenomSpire', 'SkyShatter', 'KuroKage', 'Aurelia_X',
  'FluxHunter', 'CinderKin', 'AbyssalFin', 'GaleRunner', 'RuneSmith', 'Nocturne9', 'BlazeCore', 'PolarisV',
  'ShadowMire', 'TidalFury', 'Vexillum', 'Crystalline', 'NetherSpark', 'OmenCast', 'Driftwood7', 'HazeBlade',
  'Solarix', 'Krait_04', 'ArcLight', 'Brimstone', 'Zephyrus', 'MirageHex', 'TalonStrike', 'Sundered',
  'Valen_55', 'Icebound', 'PhantomJ', 'Eclipsed', 'RiftSlinger', 'MagmaPulse', 'CoralWitch', 'DreadNova'
]);

export function pickUniqueBotNames(count: number, rng: () => number = Math.random): string[] {
  const copy = [...BOT_NAME_POOL];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy.slice(0, Math.min(count, copy.length));
}

export interface LootScatterItem {
  angle: number;
  vx: number;
  vy: number;
  vz: number;
  targetOffsetX: number;
  targetOffsetY: number;
}

export function computeLootScatter(count: number, rng: () => number = Math.random): LootScatterItem[] {
  const n = Math.max(0, Math.floor(count));
  const out: LootScatterItem[] = [];
  if (n === 0) return out;
  const baseAngle = rng() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const angle = baseAngle + (i / n) * Math.PI * 2 + (rng() - 0.5) * 0.45;
    const speed = 2.6 + rng() * 1.8;
    const vz = 165 + rng() * 65;
    const radius = 34 + rng() * 24;
    out.push({
      angle,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      vz,
      targetOffsetX: Math.cos(angle) * radius,
      targetOffsetY: Math.sin(angle) * radius,
    });
  }
  return out;
}

export function sampleDeathAnimation(elapsedSeconds: number): {
  phase: 1 | 2 | 'DONE';
  hitFlashActive: boolean;
  opacity: number;
  tiltProgress: number;
  ringProgress: number;
} {
  const t = Math.max(0, elapsedSeconds);
  if (t >= DEATH_ANIM_DURATION) {
    return { phase: 'DONE', hitFlashActive: false, opacity: 0, tiltProgress: 1, ringProgress: 1 };
  }
  if (t < DEATH_PHASE1_DURATION) {
    return {
      phase: 1,
      hitFlashActive: true,
      opacity: 1,
      tiltProgress: 0,
      ringProgress: t / DEATH_PHASE1_DURATION,
    };
  }
  const p = (t - DEATH_PHASE1_DURATION) / (DEATH_ANIM_DURATION - DEATH_PHASE1_DURATION);
  return {
    phase: 2,
    hitFlashActive: false,
    opacity: Math.max(0, 1 - p),
    tiltProgress: Math.min(1, p),
    ringProgress: 1,
  };
}
