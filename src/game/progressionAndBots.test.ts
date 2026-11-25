import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PLAYER_LEVEL,
  BOT_NAME_POOL,
  getXpRequiredForLevel,
  getMilestoneRewardForLevel,
  applyPlayerLevelProgression,
  formatLobbyLevelLabel,
  computeBotScaling,
  assignBotLevels,
  getOffscreenBotDamageMultiplier,
  getBotVisionMultiplier,
  pickUniqueBotNames,
  computeLootScatter,
  sampleDeathAnimation,
} from './progressionAndBots';

test('XP curve formula matches specification across levels 1 to 100', () => {
  assert.equal(getXpRequiredForLevel(1), 100);
  assert.equal(getXpRequiredForLevel(2), 100 + 35 + Math.floor(Math.pow(1, 1.6) * 5));
  assert.equal(getXpRequiredForLevel(10), 100 + 9 * 35 + Math.floor(Math.pow(9, 1.6) * 5));
  assert.equal(getXpRequiredForLevel(50), 100 + 49 * 35 + Math.floor(Math.pow(49, 1.6) * 5));
  assert.equal(getXpRequiredForLevel(100), 100 + 99 * 35 + Math.floor(Math.pow(99, 1.6) * 5));
});

test('multi-level carryover, milestone rewards (5/10/100), and LVL 100 MAX cap work accurately', () => {
  // Multi-level gain across levels 4 -> 6 (hits level 5 minor milestone + level 6 standard bonus)
  const xpFor4 = getXpRequiredForLevel(4);
  const xpFor5 = getXpRequiredForLevel(5);
  const res = applyPlayerLevelProgression(4, 0, xpFor4 + xpFor5 + 25);
  assert.equal(res.level, 6);
  assert.equal(res.xp, 25);
  assert.deepEqual(res.levelsGained, [5, 6]);
  assert.equal(res.milestones.length, 1);
  assert.deepEqual(res.milestones[0], { level: 5, tier: 'MINOR', coins: 250, crystals: 150, gems: 0 });
  assert.equal(res.bonusCoins, 300); // 250 milestone + 50 standard for lvl 6
  assert.equal(res.bonusCrystals, 150);
  assert.equal(res.bonusGems, 0);

  // Level 10 major milestone
  const lvl10 = applyPlayerLevelProgression(9, 0, getXpRequiredForLevel(9) + 10);
  assert.equal(lvl10.level, 10);
  assert.deepEqual(lvl10.milestones[0], { level: 10, tier: 'MAJOR', coins: 500, crystals: 300, gems: 3 });

  // Level 100 max milestone & clamping
  const lvl100 = applyPlayerLevelProgression(99, 0, getXpRequiredForLevel(99) + 99999);
  assert.equal(lvl100.level, MAX_PLAYER_LEVEL);
  assert.equal(lvl100.isMaxLevel, true);
  assert.equal(lvl100.xp, lvl100.xpNeeded);
  assert.deepEqual(lvl100.milestones[0], { level: 100, tier: 'MAX', coins: 2500, crystals: 1500, gems: 15 });
  assert.equal(formatLobbyLevelLabel(100), 'LVL 100 · MAX');
  assert.equal(formatLobbyLevelLabel(42), 'LVL 42');
  assert.equal(getMilestoneRewardForLevel(7), null);
});

test('bot level assignment stays within +/-3 clamped to [1, 100] and scales smoothly', () => {
  const lowLevels = assignBotLevels(1, 49);
  assert.equal(lowLevels.length, 49);
  for (const lv of lowLevels) {
    assert.ok(lv >= 1 && lv <= 4, `Expected level in [1,4], got ${lv}`);
  }

  const highLevels = assignBotLevels(99, 49);
  for (const lv of highLevels) {
    assert.ok(lv >= 96 && lv <= 100, `Expected level in [96,100], got ${lv}`);
  }

  const p1 = computeBotScaling(1);
  assert.ok(Math.abs(p1.statMultiplier - 0.85) < 1e-6);
  assert.ok(Math.abs(p1.reactionDelay - 0.55) < 1e-6);
  assert.ok(Math.abs(p1.aimSpreadDeg - 14.0) < 1e-6);
  assert.equal(p1.shotLeadingEnabled, false);
  assert.equal(p1.shotLeadFactor, 0);
  assert.equal(p1.artComboEnabled, false);

  const p25 = computeBotScaling(25);
  assert.equal(p25.shotLeadingEnabled, true);
  assert.ok(p25.shotLeadFactor > 0 && p25.shotLeadFactor <= 0.5);
  assert.equal(p25.artComboEnabled, true);

  const p100 = computeBotScaling(100);
  assert.ok(Math.abs(p100.statMultiplier - 1.12) < 1e-6);
  assert.ok(Math.abs(p100.reactionDelay - 0.28) < 1e-6);
  assert.ok(Math.abs(p100.aimSpreadDeg - 5.0) < 1e-6);
  assert.equal(p100.shotLeadingEnabled, true);
  assert.ok(Math.abs(p100.shotLeadFactor - 0.5) < 1e-6);
  assert.equal(p100.artComboEnabled, true);
});

test('off-screen bot-vs-bot pacing multipliers and blizzard vision reduction match rules', () => {
  assert.equal(getOffscreenBotDamageMultiplier(1, false, false, false), 0.35);
  assert.equal(getOffscreenBotDamageMultiplier(2, false, false, false), 0.6);
  assert.equal(getOffscreenBotDamageMultiplier(3, false, false, false), 1.0);
  assert.equal(getOffscreenBotDamageMultiplier(1, false, false, true), 1.0);
  assert.equal(getOffscreenBotDamageMultiplier(1, true, false, false), 1.0);
  assert.equal(getOffscreenBotDamageMultiplier(1, false, true, false), 1.0);
  assert.equal(getBotVisionMultiplier('SNOWSTORM'), 0.55);
  assert.equal(getBotVisionMultiplier('FOREST_RAIN'), 1.0);
});

test('bot name pool has >= 90 unique realistic handles with no generic Bot/AI names', () => {
  assert.ok(BOT_NAME_POOL.length >= 90, `Expected >= 90 names, got ${BOT_NAME_POOL.length}`);
  const uniqueAll = new Set(BOT_NAME_POOL);
  assert.equal(uniqueAll.size, BOT_NAME_POOL.length);
  for (const name of BOT_NAME_POOL) {
    assert.ok(!/^bot\s*\d+$/i.test(name) && !/^ai\b/i.test(name), `Disallowed generic name: ${name}`);
  }
  const matchNames = pickUniqueBotNames(49);
  assert.equal(matchNames.length, 49);
  assert.equal(new Set(matchNames).size, 49);
});

test('death animation phases and radial loot scatter behave cleanly', () => {
  const p1 = sampleDeathAnimation(0.05);
  assert.equal(p1.phase, 1);
  assert.equal(p1.hitFlashActive, true);
  assert.equal(p1.opacity, 1);

  const p2 = sampleDeathAnimation(0.5);
  assert.equal(p2.phase, 2);
  assert.equal(p2.hitFlashActive, false);
  assert.ok(p2.opacity > 0 && p2.opacity < 1);
  assert.ok(p2.tiltProgress > 0 && p2.tiltProgress < 1);

  const done = sampleDeathAnimation(0.85);
  assert.equal(done.phase, 'DONE');
  assert.equal(done.opacity, 0);

  const drops = computeLootScatter(4);
  assert.equal(drops.length, 4);
  // Ensure drops spread apart radially rather than stacking on one pixel
  const minSpread = Math.hypot(
    drops[0].targetOffsetX - drops[1].targetOffsetX,
    drops[0].targetOffsetY - drops[1].targetOffsetY
  );
  assert.ok(minSpread > 15, `Expected radial separation > 15px, got ${minSpread}`);
});
