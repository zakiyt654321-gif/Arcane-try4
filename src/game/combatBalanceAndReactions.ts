/**
 * Pure game logic for Arcane Royale combat balance, elemental reactions,
 * 5-phase storm pacing, smart auto-upgrade loot, 25-tier upgrades,
 * Arcane Runes, daily missions, and 2.5D Y-sorting / sliding collision.
 */

export type ChampionKey = 'BERSERKER' | 'TIDECALLER' | 'SHADOW';
export type ElementType = 'FIRE' | 'WATER' | 'DARK';
export type ReactionType = 'STEAM_ERUPTION' | 'SHADOWFLAME_IGNITION' | 'ABYSSAL_UNDERTOW';
export type LootRarity = 'COMMON' | 'RARE' | 'EPIC' | 'LEGENDARY';
export type RuneKey = 'VAMPIRIC_EDGE' | 'SWIFT_STRIDE' | 'ARCANE_CAPACITOR';

export const ELEMENT_BY_CHAMPION: Record<ChampionKey, ElementType> = {
  BERSERKER: 'FIRE',
  TIDECALLER: 'WATER',
  SHADOW: 'DARK',
};

export const ELEMENTAL_PRIMING_DURATION = 4.0;
export const ELEMENTAL_REACTION_COOLDOWN = 2.5;

export interface ChampionBalanceResult {
  damage: number;
  isBackstabOrExecute?: boolean;
  burnTotalDamage?: number;
  burnDuration?: number;
  casterDrMultiplier?: number;
  casterVulnerabilityDuration?: number;
  casterVulnerabilityMultiplier?: number;
}

/**
 * Berserker Crimson Cleave: 25% damage reduction & knockback resistance while casting,
 * plus 1.5s Fire Burn dealing 12% bonus damage over time.
 */
export function computeBerserkerCleaveModifiers(baseDamage: number): ChampionBalanceResult {
  const safeDmg = Math.max(0, baseDamage);
  return {
    damage: safeDmg,
    burnTotalDamage: Math.round(safeDmg * 0.12 * 10) / 10,
    burnDuration: 1.5,
    casterDrMultiplier: 0.75, // 25% damage reduction
  };
}

/**
 * Tidecaller Tidal Wave width/radius taper over travel progress [0..1]:
 * Starts full width (1.0x) and tapers smoothly to 0.62x at max range.
 */
export function computeTidalWaveWidthScale(distanceTraveled: number, maxRange: number): number {
  if (maxRange <= 0) return 1.0;
  const t = Math.max(0, Math.min(1, distanceTraveled / maxRange));
  return Math.round((1.0 - t * 0.38) * 1000) / 1000;
}

/**
 * Shadow Line Teleport Slash:
 * +25% bonus backstab/flank damage when striking targets facing away (dot > 0.25)
 * OR below 50% HP, balanced by a 1.5s +12% vulnerability window on the Shadow.
 */
export function computeShadowSlashDamage(
  baseDamage: number,
  attackAngle: number,
  targetFacingAngle: number,
  targetHpRatio: number
): ChampionBalanceResult {
  const safeDmg = Math.max(0, baseDamage);
  const cosDiff = Math.cos(attackAngle - targetFacingAngle);
  const isFacingAway = cosDiff > 0.25; // Moving in roughly same direction target is facing = behind/flank
  const isLowHp = targetHpRatio < 0.5;
  const bonus = isFacingAway || isLowHp;
  return {
    damage: Math.round(safeDmg * (bonus ? 1.25 : 1.0) * 10) / 10,
    isBackstabOrExecute: bonus,
    casterVulnerabilityDuration: 1.5,
    casterVulnerabilityMultiplier: 1.12,
  };
}

/**
 * Resolve incoming damage multipliers (Berserker Cleave 25% DR, Shadow +12% vulnerability).
 */
export function applyDefensiveDamageModifiers(
  rawDamage: number,
  cleaveArmorActive: boolean,
  shadowVulnerableActive: boolean
): number {
  let mult = 1.0;
  if (cleaveArmorActive) mult *= 0.75;
  if (shadowVulnerableActive) mult *= 1.12;
  return Math.round(Math.max(0, rawDamage * mult) * 100) / 100;
}

// ==========================================
// ELEMENTAL REACTION COMBO ENGINE
// ==========================================

export interface ElementalAuraState {
  element: ElementType | null;
  expiresAt: number;
  reactionCooldownUntil: number;
}

export interface ElementalReactionOutcome {
  triggered: boolean;
  reaction: ReactionType | null;
  label: string;
  bonusDamage: number;
  aoeRadius: number;
  pullDistance: number;
  slowPercent: number;
  slowDuration: number;
  antiHealPercent: number;
  antiHealDuration: number;
  steamCloudDuration: number;
  steamAccuracyPenalty: number;
  attackerManaRefund: number;
  attackerCooldownReduction: number;
  nextState: ElementalAuraState;
}

export function resolveReactionType(a: ElementType, b: ElementType): ReactionType | null {
  if (a === b) return null;
  if ((a === 'FIRE' && b === 'WATER') || (a === 'WATER' && b === 'FIRE')) return 'STEAM_ERUPTION';
  if ((a === 'FIRE' && b === 'DARK') || (a === 'DARK' && b === 'FIRE')) return 'SHADOWFLAME_IGNITION';
  if ((a === 'WATER' && b === 'DARK') || (a === 'DARK' && b === 'WATER')) return 'ABYSSAL_UNDERTOW';
  return null;
}

export function evaluateElementalHit(
  currentState: ElementalAuraState,
  incomingElement: ElementType,
  now: number,
  targetHp: number,
  targetMaxHp: number,
  baseHitDamage: number
): ElementalReactionOutcome {
  const activeElement = currentState.element && now < currentState.expiresAt ? currentState.element : null;
  const onReactionCd = now < (currentState.reactionCooldownUntil || 0);

  if (activeElement && activeElement !== incomingElement && !onReactionCd) {
    const reaction = resolveReactionType(activeElement, incomingElement);
    const nextState: ElementalAuraState = {
      element: null,
      expiresAt: 0,
      reactionCooldownUntil: now + ELEMENTAL_REACTION_COOLDOWN,
    };

    if (reaction === 'STEAM_ERUPTION') {
      // 18% of target's max HP, capped at 45 against high-VIT targets
      const burst = Math.min(45, Math.round(Math.max(0, targetMaxHp) * 0.18));
      return {
        triggered: true,
        reaction,
        label: 'VAPORIZE!',
        bonusDamage: burst,
        aoeRadius: 110,
        pullDistance: 0,
        slowPercent: 0,
        slowDuration: 0,
        antiHealPercent: 0,
        antiHealDuration: 0,
        steamCloudDuration: 2.5,
        steamAccuracyPenalty: 0.3,
        attackerManaRefund: 0,
        attackerCooldownReduction: 0,
        nextState,
      };
    }

    if (reaction === 'SHADOWFLAME_IGNITION') {
      // +25% bonus burst damage, scaling smoothly up to +40% when target is below 45% HP
      const hpRatio = targetMaxHp > 0 ? Math.max(0, Math.min(1, targetHp / targetMaxHp)) : 1;
      const execProgress = hpRatio >= 0.45 ? 0 : (0.45 - hpRatio) / 0.45;
      const mult = 0.25 + execProgress * 0.15;
      const burst = Math.round(Math.max(12, baseHitDamage) * mult * 10) / 10;
      return {
        triggered: true,
        reaction,
        label: 'SHADOWFLAME!',
        bonusDamage: burst,
        aoeRadius: 0,
        pullDistance: 0,
        slowPercent: 0,
        slowDuration: 0,
        antiHealPercent: 0.35,
        antiHealDuration: 3.0,
        steamCloudDuration: 0,
        steamAccuracyPenalty: 0,
        attackerManaRefund: 0,
        attackerCooldownReduction: 0,
        nextState,
      };
    }

    if (reaction === 'ABYSSAL_UNDERTOW') {
      return {
        triggered: true,
        reaction,
        label: 'ABYSSAL UNDERTOW!',
        bonusDamage: Math.round(Math.max(10, baseHitDamage * 0.2)),
        aoeRadius: 0,
        pullDistance: 45,
        slowPercent: 0.45,
        slowDuration: 1.5,
        antiHealPercent: 0,
        antiHealDuration: 0,
        steamCloudDuration: 0,
        steamAccuracyPenalty: 0,
        attackerManaRefund: 15,
        attackerCooldownReduction: 1.0,
        nextState,
      };
    }
  }

  // Otherwise apply/refresh 4.0s elemental primer
  return {
    triggered: false,
    reaction: null,
    label: '',
    bonusDamage: 0,
    aoeRadius: 0,
    pullDistance: 0,
    slowPercent: 0,
    slowDuration: 0,
    antiHealPercent: 0,
    antiHealDuration: 0,
    steamCloudDuration: 0,
    steamAccuracyPenalty: 0,
    attackerManaRefund: 0,
    attackerCooldownReduction: 0,
    nextState: {
      element: incomingElement,
      expiresAt: now + ELEMENTAL_PRIMING_DURATION,
      reactionCooldownUntil: currentState.reactionCooldownUntil || 0,
    },
  };
}

/**
 * Level 35+ bots recognize primed targets with a different element nearby
 * and prioritize detonating reactions; Level 1-34 bots use standard AI.
 */
export function shouldBotPrioritizeReaction(
  botLevel: number,
  botElement: ElementType,
  targetAura: ElementalAuraState,
  now: number
): boolean {
  if (botLevel < 35) return false;
  if (!targetAura.element || now >= targetAura.expiresAt) return false;
  if (now < (targetAura.reactionCooldownUntil || 0)) return false;
  return targetAura.element !== botElement;
}

// ==========================================
// 5-PHASE STORM & ANTI-HEAL ENDGAME
// ==========================================

export interface StormPhaseConfig {
  phase: 1 | 2 | 3 | 4 | 5;
  safeDuration: number;
  shrinkDuration: number;
  startRadius: number;
  endRadius: number;
  dps: number;
}

export const STORM_PHASES: readonly StormPhaseConfig[] = Object.freeze([
  { phase: 1, safeDuration: 45, shrinkDuration: 35, startRadius: 14000, endRadius: 9000, dps: 4 },
  { phase: 2, safeDuration: 35, shrinkDuration: 35, startRadius: 9000, endRadius: 5200, dps: 8 },
  { phase: 3, safeDuration: 30, shrinkDuration: 30, startRadius: 5200, endRadius: 2400, dps: 14 },
  { phase: 4, safeDuration: 25, shrinkDuration: 25, startRadius: 2400, endRadius: 750, dps: 22 },
  { phase: 5, safeDuration: 15, shrinkDuration: 40, startRadius: 750, endRadius: 80, dps: 35 },
]);

export interface StormEvaluation {
  phase: 1 | 2 | 3 | 4 | 5;
  isShrinking: boolean;
  isSuddenDeath: boolean;
  countdownSeconds: number;
  currentRadius: number;
  nextRadius: number;
  dps: number;
}

export function evaluateStormAtTime(matchTime: number): StormEvaluation {
  const t = Math.max(0, Number(matchTime) || 0);
  let elapsed = 0;

  for (let i = 0; i < STORM_PHASES.length; i++) {
    const cfg = STORM_PHASES[i];
    const safeEnd = elapsed + cfg.safeDuration;
    const shrinkEnd = safeEnd + cfg.shrinkDuration;

    if (t < safeEnd) {
      return {
        phase: cfg.phase,
        isShrinking: false,
        isSuddenDeath: cfg.phase === 5,
        countdownSeconds: Math.ceil(safeEnd - t),
        currentRadius: cfg.startRadius,
        nextRadius: cfg.endRadius,
        dps: cfg.dps,
      };
    }

    if (t < shrinkEnd) {
      const progress = (t - safeEnd) / cfg.shrinkDuration;
      const currentRadius = cfg.startRadius - (cfg.startRadius - cfg.endRadius) * progress;
      return {
        phase: cfg.phase,
        isShrinking: true,
        isSuddenDeath: cfg.phase === 5,
        countdownSeconds: Math.ceil(shrinkEnd - t),
        currentRadius,
        nextRadius: cfg.endRadius,
        dps: cfg.dps,
      };
    }

    elapsed = shrinkEnd;
  }

  const last = STORM_PHASES[STORM_PHASES.length - 1];
  return {
    phase: 5,
    isShrinking: true,
    isSuddenDeath: true,
    countdownSeconds: 0,
    currentRadius: last.endRadius,
    nextRadius: last.endRadius,
    dps: last.dps,
  };
}

/**
 * Applies Storm Corruption (-40% heal while outside safe zone) and Shadowflame anti-heal (-35%).
 */
export function computeEffectiveHealAmount(
  baseHeal: number,
  outsideSafeZone: boolean,
  shadowflameAntiHealActive: boolean
): number {
  let mult = 1.0;
  if (outsideSafeZone) mult *= 0.6; // -40% Storm Corruption
  if (shadowflameAntiHealActive) mult *= 0.65; // -35% Shadowflame anti-heal
  return Math.round(Math.max(0, baseHeal) * mult * 10) / 10;
}

// ==========================================
// SMART AUTO-UPGRADE LOOT, 25-TIER UPGRADES & RUNES
// ==========================================

export const LOOT_RARITY_RANK: Record<LootRarity, number> = {
  COMMON: 1,
  RARE: 2,
  EPIC: 3,
  LEGENDARY: 4,
};

export const LOOT_RARITY_MULT: Record<LootRarity, number> = {
  COMMON: 1.0,
  RARE: 1.15,
  EPIC: 1.32,
  LEGENDARY: 1.5,
};

export interface SmartLootSwapResult {
  action: 'ADD' | 'UPGRADE_SWAP' | 'FULL_REJECT';
  nextStack: LootRarity[];
  ejectedRarity: LootRarity | null;
}

/**
 * Smart Auto-Upgrade Loot Pickup:
 * - If stack has room (< cap), append incoming rarity.
 * - If stack is full, find lowest held rarity; if incoming is strictly higher rarity,
 *   replace lowest held item and eject the replaced lower-rarity item onto the ground.
 */
export function resolveSmartLootPickup(
  currentStack: LootRarity[],
  cap: number,
  incomingRarity: LootRarity
): SmartLootSwapResult {
  const stack = [...currentStack];
  if (stack.length < cap) {
    stack.push(incomingRarity);
    return { action: 'ADD', nextStack: stack, ejectedRarity: null };
  }

  let lowestIdx = -1;
  let lowestRank = Infinity;
  for (let i = 0; i < stack.length; i++) {
    const r = LOOT_RARITY_RANK[stack[i]] || 1;
    if (r < lowestRank) {
      lowestRank = r;
      lowestIdx = i;
    }
  }

  const incomingRank = LOOT_RARITY_RANK[incomingRarity] || 1;
  if (lowestIdx >= 0 && incomingRank > lowestRank) {
    const ejected = stack[lowestIdx];
    stack[lowestIdx] = incomingRarity;
    return { action: 'UPGRADE_SWAP', nextStack: stack, ejectedRarity: ejected };
  }

  return { action: 'FULL_REJECT', nextStack: stack, ejectedRarity: null };
}

export const MAX_UPGRADE_TIER = 25;

export interface ArcaneRuneDef {
  id: RuneKey;
  name: string;
  costGold: number;
  icon: string;
  summary: string;
  lifestealPct: number;
  outOfCombatSpeedPct: number;
  maxManaAndRegenPct: number;
}

export const ARCANE_RUNES: Record<RuneKey, ArcaneRuneDef> = Object.freeze({
  VAMPIRIC_EDGE: {
    id: 'VAMPIRIC_EDGE',
    name: 'Vampiric Edge',
    costGold: 600,
    icon: '🩸',
    summary: '+5% lifesteal on all weapon & spell hits.',
    lifestealPct: 0.05,
    outOfCombatSpeedPct: 0,
    maxManaAndRegenPct: 0,
  },
  SWIFT_STRIDE: {
    id: 'SWIFT_STRIDE',
    name: 'Swift Stride',
    costGold: 550,
    icon: '💨',
    summary: '+10% movement speed while out of combat.',
    lifestealPct: 0,
    outOfCombatSpeedPct: 0.1,
    maxManaAndRegenPct: 0,
  },
  ARCANE_CAPACITOR: {
    id: 'ARCANE_CAPACITOR',
    name: 'Arcane Capacitor',
    costGold: 650,
    icon: '⚡',
    summary: '+15% Max MP and +15% passive mana regeneration.',
    lifestealPct: 0,
    outOfCombatSpeedPct: 0,
    maxManaAndRegenPct: 0.15,
  },
});

export function computeRuneManaStats(baseMaxMana: number, baseManaRegen: number, equippedRune: RuneKey | null) {
  const rune = equippedRune ? ARCANE_RUNES[equippedRune] : null;
  const mult = rune ? 1 + rune.maxManaAndRegenPct : 1;
  return {
    maxMana: Math.round(baseMaxMana * mult),
    manaRegen: Math.round(baseManaRegen * mult * 100) / 100,
  };
}

// ==========================================
// DAILY MISSIONS (3 ROTATING MISSIONS)
// ==========================================

export type DailyMissionMetric = 'kills' | 'reactions' | 'top5' | 'crates' | 'damage' | 'matches';

export interface DailyMissionItem {
  id: string;
  title: string;
  metric: DailyMissionMetric;
  target: number;
  progress: number;
  rewardGold: number;
  rewardCrystals: number;
  rewardXp: number;
  claimed: boolean;
}

const DAILY_MISSION_TEMPLATES: readonly Omit<DailyMissionItem, 'progress' | 'claimed'>[] = Object.freeze([
  { id: 'elim_5', title: 'Eliminate 5 Rivals', metric: 'kills', target: 5, rewardGold: 180, rewardCrystals: 60, rewardXp: 90 },
  { id: 'react_2', title: 'Trigger 2 Elemental Reactions', metric: 'reactions', target: 2, rewardGold: 200, rewardCrystals: 80, rewardXp: 110 },
  { id: 'top_5', title: 'Reach Top 5 Placement', metric: 'top5', target: 1, rewardGold: 220, rewardCrystals: 90, rewardXp: 120 },
  { id: 'crate_2', title: 'Open 2 Arcane Supply Crates', metric: 'crates', target: 2, rewardGold: 160, rewardCrystals: 70, rewardXp: 85 },
  { id: 'dmg_600', title: 'Deal 600 Combat Damage', metric: 'damage', target: 600, rewardGold: 175, rewardCrystals: 65, rewardXp: 95 },
  { id: 'play_2', title: 'Complete 2 Arena Matches', metric: 'matches', target: 2, rewardGold: 150, rewardCrystals: 50, rewardXp: 80 },
]);

export function generateDailyMissionsForDate(dateKey: string): DailyMissionItem[] {
  let hash = 0;
  for (let i = 0; i < dateKey.length; i++) {
    hash = (hash * 31 + dateKey.charCodeAt(i)) >>> 0;
  }
  // Always keep 3 distinct missions; rotate smoothly by date offset while keeping signature trio common
  const offset = (hash % 2) * 3; // 0 -> [elim_5, react_2, top_5], 3 -> [crate_2, dmg_600, play_2]
  const picked: DailyMissionItem[] = [];
  for (let i = 0; i < 3; i++) {
    const tpl = DAILY_MISSION_TEMPLATES[(offset + i) % DAILY_MISSION_TEMPLATES.length];
    picked.push({ ...tpl, progress: 0, claimed: false });
  }
  return picked;
}

export function advanceDailyMissions(
  missions: DailyMissionItem[],
  deltas: Partial<Record<DailyMissionMetric, number>>
): DailyMissionItem[] {
  return missions.map(m => {
    const add = Math.max(0, Math.floor(Number(deltas[m.metric]) || 0));
    if (add <= 0) return { ...m };
    return { ...m, progress: Math.min(m.target, m.progress + add) };
  });
}

export function claimDailyMission(missions: DailyMissionItem[], missionId: string) {
  let claimedMission: DailyMissionItem | null = null;
  const next = missions.map(m => {
    if (m.id === missionId && !m.claimed && m.progress >= m.target) {
      claimedMission = { ...m, claimed: true };
      return claimedMission;
    }
    return { ...m };
  });
  return { ok: claimedMission !== null, mission: claimedMission, missions: next };
}

// ==========================================
// 2.5D ENGINE: AXIS-SEPARATED SLIDE, UNSTUCK & Y-SORT
// ==========================================

export interface RectObstacle {
  x: number;
  y: number;
  w: number;
  h: number;
  zHeight?: number;
}

export function overlapsRectCircle(cx: number, cy: number, radius: number, obs: RectObstacle): boolean {
  const testX = Math.max(obs.x, Math.min(cx, obs.x + obs.w));
  const testY = Math.max(obs.y, Math.min(cy, obs.y + obs.h));
  const dx = cx - testX;
  const dy = cy - testY;
  return dx * dx + dy * dy < radius * radius;
}

/**
 * Axis-separated obstacle resolution so fighters slide smoothly along diagonal obstacles,
 * followed by a depenetration/unstuck pass so Dash/Teleport Slash never traps a fighter inside rocks/trees.
 */
export function resolveAxisSeparatedObstacles(
  prevX: number,
  prevY: number,
  candX: number,
  candY: number,
  radius: number,
  z: number,
  obstacles: readonly RectObstacle[],
  arenaWidth: number,
  arenaHeight: number
): { x: number; y: number } {
  let rx = candX;
  let ry = prevY;

  // Step 1: Resolve X axis independently
  for (let i = 0; i < obstacles.length; i++) {
    const obs = obstacles[i];
    if (z >= (obs.zHeight ?? 30)) continue;
    if (overlapsRectCircle(rx, ry, radius, obs)) {
      if (candX > prevX) rx = Math.min(rx, obs.x - radius - 0.1);
      else if (candX < prevX) rx = Math.max(rx, obs.x + obs.w + radius + 0.1);
    }
  }

  // Step 2: Resolve Y axis independently using updated rx
  ry = candY;
  for (let i = 0; i < obstacles.length; i++) {
    const obs = obstacles[i];
    if (z >= (obs.zHeight ?? 30)) continue;
    if (overlapsRectCircle(rx, ry, radius, obs)) {
      if (candY > prevY) ry = Math.min(ry, obs.y - radius - 0.1);
      else if (candY < prevY) ry = Math.max(ry, obs.y + obs.h + radius + 0.1);
    }
  }

  // Step 3: Post-dash / post-teleport unstuck pass (nearest edge eject if still overlapping)
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < obstacles.length; i++) {
      const obs = obstacles[i];
      if (z >= (obs.zHeight ?? 30)) continue;
      const testX = Math.max(obs.x, Math.min(rx, obs.x + obs.w));
      const testY = Math.max(obs.y, Math.min(ry, obs.y + obs.h));
      const distX = rx - testX;
      const distY = ry - testY;
      const dist = Math.hypot(distX, distY);
      if (dist < radius) {
        if (dist < 0.001) {
          // Center is strictly inside rect — push out to nearest edge cleanly
          const dLeft = Math.abs(rx - obs.x);
          const dRight = Math.abs(obs.x + obs.w - rx);
          const dTop = Math.abs(ry - obs.y);
          const dBottom = Math.abs(obs.y + obs.h - ry);
          const minEdge = Math.min(dLeft, dRight, dTop, dBottom);
          if (minEdge === dLeft) rx = obs.x - radius - 1;
          else if (minEdge === dRight) rx = obs.x + obs.w + radius + 1;
          else if (minEdge === dTop) ry = obs.y - radius - 1;
          else ry = obs.y + obs.h + radius + 1;
        } else {
          const overlap = radius - dist + 0.5;
          rx += (distX / dist) * overlap;
          ry += (distY / dist) * overlap;
        }
      }
    }
  }

  return {
    x: Math.max(radius, Math.min(arenaWidth - radius, rx)),
    y: Math.max(radius, Math.min(arenaHeight - radius, ry)),
  };
}

export interface YSortableItem {
  kind: 'obstacle' | 'loot' | 'crate' | 'entity';
  sortY: number;
  id: string;
}

export function sortWorldRenderablesByFootY<T extends YSortableItem>(items: T[]): T[] {
  return [...items].sort((a, b) => a.sortY - b.sortY);
}
