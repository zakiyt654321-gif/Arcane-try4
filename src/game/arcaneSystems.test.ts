import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyXpUpgrade,
  calculateMatchXp,
  computePlayerDerivedStats,
  getBiomeAtPoint,
  getUpgradeCost,
  getWeatherModifiersAtPoint,
  isMinimapDoubleTap,
  KILLCAM_DURATION_SECONDS,
  pickProceduralWeatherKindForBiome,
  sampleKillcamTrajectory,
  selectBotsForPingHighlight,
  type ActiveBiomeWeather,
  type BiomeRect,
} from './arcaneSystems';

test('calculateMatchXp rewards longer survival and opponent defeats', () => {
  const shortLoss = calculateMatchXp({ survivalSeconds: 10, kills: 0, isVictory: false, placement: 40 });
  const longHighKill = calculateMatchXp({ survivalSeconds: 180, kills: 4, isVictory: false, placement: 4 });
  const victory = calculateMatchXp({ survivalSeconds: 240, kills: 6, isVictory: true, placement: 1 });

  assert.equal(shortLoss.survivalXp, 5);
  assert.equal(shortLoss.combatXp, 0);
  assert.equal(shortLoss.placementXp, 10);
  assert.equal(shortLoss.totalXp, 15);

  assert.equal(longHighKill.survivalXp, 90);
  assert.equal(longHighKill.combatXp, 100);
  assert.equal(longHighKill.placementXp, 15);
  assert.equal(longHighKill.totalXp, 205);

  assert.ok(victory.totalXp > longHighKill.totalXp);
  assert.equal(victory.combatXp, 150);
  assert.equal(victory.placementXp, 50);
});

test('applyXpUpgrade spends XP, increments rank, and boosts fighter stats', () => {
  const baseStats = { PWR: 16, FOC: 4, AGI: 8, VIT: 12 }; // Berserker
  const initialUpgrades = { maxHealth: 0, movementSpeed: 0, attackPower: 0 };

  const costHp = getUpgradeCost('maxHealth', 0);
  assert.equal(costHp, 40);

  const insufficient = applyXpUpgrade(30, initialUpgrades, 'maxHealth');
  assert.equal(insufficient.ok, false);
  assert.equal(insufficient.reason, 'INSUFFICIENT_XP');
  assert.equal(insufficient.remainingXp, 30);

  const r1 = applyXpUpgrade(200, initialUpgrades, 'maxHealth');
  assert.equal(r1.ok, true);
  assert.equal(r1.remainingXp, 160);
  assert.equal(r1.upgrades.maxHealth, 1);

  const r2 = applyXpUpgrade(r1.remainingXp, r1.upgrades, 'movementSpeed');
  assert.equal(r2.ok, true);
  assert.equal(r2.upgrades.movementSpeed, 1);

  const r3 = applyXpUpgrade(r2.remainingXp, r2.upgrades, 'attackPower');
  assert.equal(r3.ok, true);
  assert.equal(r3.upgrades.attackPower, 1);

  const baseDerived = computePlayerDerivedStats(baseStats, initialUpgrades);
  const upgradedDerived = computePlayerDerivedStats(baseStats, r3.upgrades);

  assert.equal(upgradedDerived.maxHp, baseDerived.maxHp + 15);
  assert.equal(upgradedDerived.speed, baseDerived.speed + 0.25);
  assert.equal(upgradedDerived.swordDamage, baseDerived.swordDamage + 2.5);
  assert.equal(upgradedDerived.spellDamage, baseDerived.spellDamage + 3.0);
});

test('minimap double-tap detection and bot quick-ping responder selection', () => {
  const tap1 = { timeMs: 1000, screenX: 48, screenY: 64 };
  assert.equal(isMinimapDoubleTap(tap1, 1180, 52, 68), true);
  assert.equal(isMinimapDoubleTap(tap1, 1500, 52, 68), false); // too slow
  assert.equal(isMinimapDoubleTap(tap1, 1150, 120, 68), false); // too far apart

  const bots = [
    { id: 1, x: 5000, y: 5000, isAlive: true, isPlayer: true, state: 'IDLE' },
    { id: 2, x: 5300, y: 5200, isAlive: true, isPlayer: false, state: 'WANDER' },
    { id: 3, x: 6000, y: 5100, isAlive: true, isPlayer: false, state: 'CHASE' },
    { id: 4, x: 5250, y: 5150, isAlive: true, isPlayer: false, state: 'FLEE' }, // fleeing bots skip
    { id: 5, x: 14000, y: 14000, isAlive: true, isPlayer: false, state: 'WANDER' }, // too far
    { id: 6, x: 5150, y: 5050, isAlive: false, isPlayer: false, state: 'DEAD' }, // dead
  ];

  const alerted = selectBotsForPingHighlight(bots, 5200, 5100, 4000, 4);
  assert.deepEqual(alerted, [2, 3]);
});

test('killcam 2-second slow-motion trajectory interpolates cleanly from origin to impact', () => {
  const path = [
    { x: 100, y: 100 },
    { x: 200, y: 100 },
    { x: 300, y: 100 },
  ];

  const start = sampleKillcamTrajectory(path, 0, KILLCAM_DURATION_SECONDS);
  assert.equal(start.progress, 0);
  assert.deepEqual(start.head, { x: 100, y: 100 });
  assert.equal(start.impactReached, false);

  const mid = sampleKillcamTrajectory(path, 1.0, KILLCAM_DURATION_SECONDS);
  assert.equal(mid.progress, 0.5);
  assert.deepEqual(mid.head, { x: 200, y: 100 });
  assert.equal(mid.impactReached, false);

  const end = sampleKillcamTrajectory(path, 2.0, KILLCAM_DURATION_SECONDS);
  assert.equal(end.progress, 1);
  assert.deepEqual(end.head, { x: 300, y: 100 });
  assert.equal(end.impactReached, true);
});

test('procedural biome weather triggers slowing forest rain and visibility-reducing northern snowstorm', () => {
  const zones: BiomeRect[] = [
    { id: 'forest_nw', biome: 'forest', x: 500, y: 500, w: 6000, h: 6000 },
    { id: 'snow_n', biome: 'snow', x: 6500, y: 500, w: 7000, h: 6000 },
    { id: 'keep_center', biome: 'meadow', x: 6500, y: 6500, w: 7000, h: 7000 },
  ];

  assert.equal(getBiomeAtPoint(2500, 2500, zones), 'forest');
  assert.equal(getBiomeAtPoint(9600, 2000, zones), 'snow');
  assert.equal(getBiomeAtPoint(10000, 10000, zones), 'meadow');
  assert.equal(getBiomeAtPoint(50, 50, zones), 'coast');

  assert.equal(pickProceduralWeatherKindForBiome('forest'), 'FOREST_RAIN');
  assert.equal(pickProceduralWeatherKindForBiome('snow'), 'SNOWSTORM');

  const activeEvents: ActiveBiomeWeather[] = [
    { kind: 'FOREST_RAIN', biome: 'forest', startedAt: 10, endsAt: 30 },
    { kind: 'SNOWSTORM', biome: 'snow', startedAt: 10, endsAt: 30 },
  ];

  const forestMods = getWeatherModifiersAtPoint(2000, 2000, zones, activeEvents, 15);
  assert.equal(forestMods.activeEvent?.kind, 'FOREST_RAIN');
  assert.ok(forestMods.speedMultiplier < 1.0);

  const snowMods = getWeatherModifiersAtPoint(9500, 2500, zones, activeEvents, 15);
  assert.equal(snowMods.activeEvent?.kind, 'SNOWSTORM');
  assert.ok(snowMods.visibilityPenalty >= 0.7);

  const expiredMods = getWeatherModifiersAtPoint(2000, 2000, zones, activeEvents, 40);
  assert.equal(expiredMods.activeEvent, null);
  assert.equal(expiredMods.speedMultiplier, 1.0);
});
