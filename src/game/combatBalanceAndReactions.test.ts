import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCANE_RUNES,
  ELEMENTAL_PRIMING_DURATION,
  ELEMENTAL_REACTION_COOLDOWN,
  MAX_UPGRADE_TIER,
  STORM_PHASES,
  advanceDailyMissions,
  applyDefensiveDamageModifiers,
  claimDailyMission,
  computeBerserkerCleaveModifiers,
  computeEffectiveHealAmount,
  computeRuneManaStats,
  computeShadowSlashDamage,
  computeTidalWaveWidthScale,
  evaluateElementalHit,
  evaluateStormAtTime,
  generateDailyMissionsForDate,
  overlapsRectCircle,
  resolveAxisSeparatedObstacles,
  resolveSmartLootPickup,
  shouldBotPrioritizeReaction,
  sortWorldRenderablesByFootY,
} from './combatBalanceAndReactions';

test('Champion balance: Berserker Cleave DR + 12% 1.5s burn, Tidecaller taper, Shadow backstab/execute + vulnerability', () => {
  const cleave = computeBerserkerCleaveModifiers(40);
  assert.equal(cleave.casterDrMultiplier, 0.75);
  assert.equal(cleave.burnDuration, 1.5);
  assert.equal(cleave.burnTotalDamage, 4.8);

  // Tidecaller Tidal Wave width tapers from 1.0x down to 0.62x at max range
  assert.equal(computeTidalWaveWidthScale(0, 400), 1.0);
  assert.equal(computeTidalWaveWidthScale(200, 400), 0.81);
  assert.equal(computeTidalWaveWidthScale(400, 400), 0.62);

  // Shadow Line Teleport Slash: +25% when target facing away OR below 50% HP
  const frontHealthy = computeShadowSlashDamage(25, 0, Math.PI, 0.8);
  assert.equal(frontHealthy.isBackstabOrExecute, false);
  assert.equal(frontHealthy.damage, 25);
  assert.equal(frontHealthy.casterVulnerabilityDuration, 1.5);
  assert.equal(frontHealthy.casterVulnerabilityMultiplier, 1.12);

  const backstab = computeShadowSlashDamage(25, 0, 0, 0.9);
  assert.equal(backstab.isBackstabOrExecute, true);
  assert.equal(backstab.damage, 31.3);

  const lowHpExecute = computeShadowSlashDamage(25, 0, Math.PI, 0.42);
  assert.equal(lowHpExecute.isBackstabOrExecute, true);
  assert.equal(lowHpExecute.damage, 31.3);

  // Defensive damage modifier stacking
  assert.equal(applyDefensiveDamageModifiers(100, true, false), 75);
  assert.equal(applyDefensiveDamageModifiers(100, false, true), 112);
});

test('Elemental Reactions: 4s priming, all 3 combos, 2.5s reaction CD, and Lv35+ bot awareness', () => {
  const fresh = { element: null, expiresAt: 0, reactionCooldownUntil: 0 };

  // 1. Prime with FIRE
  const primed = evaluateElementalHit(fresh, 'FIRE', 10.0, 140, 160, 20);
  assert.equal(primed.triggered, false);
  assert.equal(primed.nextState.element, 'FIRE');
  assert.equal(primed.nextState.expiresAt, 10.0 + ELEMENTAL_PRIMING_DURATION);

  // 2. Hit with WATER -> VAPORIZE! (18% max HP, capped at 45, 110px AoE, 2.5s -30% acc cloud)
  const steam = evaluateElementalHit(primed.nextState, 'WATER', 11.2, 140, 200, 18);
  assert.equal(steam.triggered, true);
  assert.equal(steam.reaction, 'STEAM_ERUPTION');
  assert.equal(steam.label, 'VAPORIZE!');
  assert.equal(steam.bonusDamage, 36); // 18% of 200
  assert.equal(steam.aoeRadius, 110);
  assert.equal(steam.steamCloudDuration, 2.5);
  assert.equal(steam.steamAccuracyPenalty, 0.3);
  assert.equal(steam.nextState.element, null);
  assert.equal(steam.nextState.reactionCooldownUntil, 11.2 + ELEMENTAL_REACTION_COOLDOWN);

  // High-VIT target caps Steam Eruption burst at 45
  const steamCapped = evaluateElementalHit(primed.nextState, 'WATER', 11.2, 500, 500, 18);
  assert.equal(steamCapped.bonusDamage, 45);

  // 3. During 2.5s reaction cooldown, hitting with different elements cannot chain-trigger
  const duringCd = evaluateElementalHit(steam.nextState, 'FIRE', 12.0, 120, 200, 18);
  const blocked = evaluateElementalHit(duringCd.nextState, 'DARK', 12.5, 120, 200, 18);
  assert.equal(blocked.triggered, false);

  // 4. SHADOWFLAME IGNITION (FIRE + DARK): +25% scaling up to +40% below 45% HP + 3s 35% anti-heal
  const sfHighHp = evaluateElementalHit(primed.nextState, 'DARK', 11.0, 150, 200, 40);
  assert.equal(sfHighHp.triggered, true);
  assert.equal(sfHighHp.reaction, 'SHADOWFLAME_IGNITION');
  assert.equal(sfHighHp.bonusDamage, 10); // +25% of 40
  assert.equal(sfHighHp.antiHealPercent, 0.35);
  assert.equal(sfHighHp.antiHealDuration, 3.0);

  const sfExec = evaluateElementalHit(primed.nextState, 'DARK', 11.0, 20, 200, 40);
  assert.ok(sfExec.bonusDamage > 14 && sfExec.bonusDamage <= 16, `expected scaled execute bonus near 40%, got ${sfExec.bonusDamage}`);

  // 5. ABYSSAL UNDERTOW (WATER + DARK): 45px pull, 45% slow 1.5s, 15 MP refund + 1.0s CD reduction
  const waterPrimed = evaluateElementalHit(fresh, 'WATER', 20.0, 120, 150, 18);
  const undertow = evaluateElementalHit(waterPrimed.nextState, 'DARK', 21.0, 120, 150, 20);
  assert.equal(undertow.triggered, true);
  assert.equal(undertow.reaction, 'ABYSSAL_UNDERTOW');
  assert.equal(undertow.pullDistance, 45);
  assert.equal(undertow.slowPercent, 0.45);
  assert.equal(undertow.slowDuration, 1.5);
  assert.equal(undertow.attackerManaRefund, 15);
  assert.equal(undertow.attackerCooldownReduction, 1.0);

  // 6. Bot reaction priority only activates at Level 35+
  assert.equal(shouldBotPrioritizeReaction(34, 'WATER', primed.nextState, 11.0), false);
  assert.equal(shouldBotPrioritizeReaction(35, 'WATER', primed.nextState, 11.0), true);
  assert.equal(shouldBotPrioritizeReaction(50, 'FIRE', primed.nextState, 11.0), false);
});

test('5-Phase Storm pacing (45s initial SAFE, 4->8->14->22->35 HP/s) & -40% Storm Corruption anti-heal', () => {
  assert.equal(STORM_PHASES.length, 5);
  assert.deepEqual(STORM_PHASES.map(p => p.dps), [4, 8, 14, 22, 35]);

  const opening = evaluateStormAtTime(0);
  assert.equal(opening.phase, 1);
  assert.equal(opening.isShrinking, false);
  assert.equal(opening.countdownSeconds, 45);
  assert.equal(opening.dps, 4);
  assert.ok(opening.nextRadius < opening.currentRadius);

  const p1Shrink = evaluateStormAtTime(50);
  assert.equal(p1Shrink.phase, 1);
  assert.equal(p1Shrink.isShrinking, true);

  const p2Start = evaluateStormAtTime(80);
  assert.equal(p2Start.phase, 2);
  assert.equal(p2Start.dps, 8);

  const suddenDeath = evaluateStormAtTime(300);
  assert.equal(suddenDeath.phase, 5);
  assert.equal(suddenDeath.isSuddenDeath, true);
  assert.equal(suddenDeath.dps, 35);

  // Healing effectiveness debuffs
  assert.equal(computeEffectiveHealAmount(50, false, false), 50);
  assert.equal(computeEffectiveHealAmount(50, true, false), 30); // -40% Storm Corruption
  assert.equal(computeEffectiveHealAmount(50, false, true), 32.5); // -35% Shadowflame
  assert.equal(computeEffectiveHealAmount(100, true, true), 39); // Stacked 0.6 * 0.65
});

test('Smart auto-upgrade loot swap, 25-tier cap, Arcane Runes & Daily Missions rotation/claim', () => {
  assert.equal(MAX_UPGRADE_TIER, 25);

  // Full stack auto-upgrades COMMON -> EPIC and ejects COMMON
  const swap = resolveSmartLootPickup(['COMMON', 'RARE'], 2, 'EPIC');
  assert.equal(swap.action, 'UPGRADE_SWAP');
  assert.equal(swap.ejectedRarity, 'COMMON');
  assert.deepEqual(swap.nextStack, ['EPIC', 'RARE']);

  // Full stack rejects equal/lower rarity
  const reject = resolveSmartLootPickup(['EPIC', 'LEGENDARY'], 2, 'RARE');
  assert.equal(reject.action, 'FULL_REJECT');
  assert.equal(reject.ejectedRarity, null);

  // Arcane Capacitor boosts max MP and mana regen by +15%
  const boostedMana = computeRuneManaStats(100, 5.0, 'ARCANE_CAPACITOR');
  assert.equal(boostedMana.maxMana, 115);
  assert.equal(boostedMana.manaRegen, 5.75);
  assert.equal(ARCANE_RUNES.VAMPIRIC_EDGE.lifestealPct, 0.05);
  assert.equal(ARCANE_RUNES.SWIFT_STRIDE.outOfCombatSpeedPct, 0.1);

  // Daily missions generate 3 missions, track progress, and claim idempotently
  const missions = generateDailyMissionsForDate('2026-11-22');
  assert.equal(missions.length, 3);
  const firstId = missions[0].id;
  const firstMetric = missions[0].metric;
  const progressed = advanceDailyMissions(missions, { [firstMetric]: 999 });
  assert.equal(progressed[0].progress, progressed[0].target);

  const claim1 = claimDailyMission(progressed, firstId);
  assert.equal(claim1.ok, true);
  assert.equal(claim1.missions[0].claimed, true);

  const claim2 = claimDailyMission(claim1.missions, firstId);
  assert.equal(claim2.ok, false);
});

test('2.5D sliding collision along obstacles, post-dash unstuck eject & Y-sorting by foot Y', () => {
  const obstacles = [{ x: 200, y: 200, w: 100, h: 100, zHeight: 60 }];

  // Diagonal movement hitting left edge slides smoothly along Y without stopping X+Y dead
  const slid = resolveAxisSeparatedObstacles(175, 220, 192, 238, 20, 0, obstacles, 2000, 2000);
  assert.equal(overlapsRectCircle(slid.x, slid.y, 20, obstacles[0]), false);
  assert.ok(slid.y > 225, `expected fighter to slide vertically past 225, got y=${slid.y}`);

  // Post-dash unstuck ejects fighter landed dead-center inside an obstacle
  const unstuck = resolveAxisSeparatedObstacles(100, 250, 240, 250, 20, 0, obstacles, 2000, 2000);
  assert.equal(overlapsRectCircle(unstuck.x, unstuck.y, 20, obstacles[0]), false);

  // Unified foot-Y sorting orders renderables back-to-front accurately
  const sorted = sortWorldRenderablesByFootY([
    { kind: 'entity', sortY: 420, id: 'player' },
    { kind: 'obstacle', sortY: 380, id: 'tree1' },
    { kind: 'crate', sortY: 450, id: 'crate1' },
    { kind: 'loot', sortY: 395, id: 'medkit' },
  ]);
  assert.deepEqual(sorted.map(s => s.id), ['tree1', 'medkit', 'player', 'crate1']);
});
