import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampFrameDeltaTime,
  computeMobileDprCap,
  isPointInCancelZone,
  isWithinViewportCullBounds,
  selectQuickUseInventoryItem,
  stepDistantBotAiClock,
} from './mobileHudAndPerf';

test('selectQuickUseInventoryItem prioritizes Heal <70% HP, Mana <40% MP, and recent utility otherwise', () => {
  const inv = { MEDKIT: 2, MANA: 1, SHIELD: 1, HASTE: 0, BOMB: 1 };

  // Low HP (<70%) picks MEDKIT first even if MP is also low
  const lowHp = selectQuickUseInventoryItem(inv, 0.55, 0.25, 'BOMB');
  assert.equal(lowHp.itemKey, 'MEDKIT');
  assert.equal(lowHp.itemCount, 2);
  assert.equal(lowHp.totalCount, 5);

  // Healthy HP (>=70%) + Low MP (<40%) picks MANA
  const lowMp = selectQuickUseInventoryItem(inv, 0.85, 0.35, 'BOMB');
  assert.equal(lowMp.itemKey, 'MANA');
  assert.equal(lowMp.itemCount, 1);
  assert.equal(lowMp.totalCount, 5);

  // Healthy HP + Healthy MP picks most recently picked-up utility item
  const recentUtility = selectQuickUseInventoryItem(inv, 0.92, 0.78, 'BOMB');
  assert.equal(recentUtility.itemKey, 'BOMB');
  assert.equal(recentUtility.itemCount, 1);
  assert.equal(recentUtility.totalCount, 5);

  // Empty inventory returns null with 0 totalCount
  const empty = selectQuickUseInventoryItem({}, 0.4, 0.2, 'MEDKIT');
  assert.equal(empty.itemKey, null);
  assert.equal(empty.totalCount, 0);
});

test('isPointInCancelZone detects drag finger inside vs outside circular cancel zone', () => {
  assert.equal(isPointInCancelZone(600, 210, 600, 210, 38), true);
  assert.equal(isPointInCancelZone(625, 225, 600, 210, 38), true);
  assert.equal(isPointInCancelZone(650, 210, 600, 210, 38), false);
});

test('computeMobileDprCap clamps 3x AMOLED screens cleanly per Graphics Quality preset', () => {
  assert.equal(computeMobileDprCap(3.0, 'low'), 1.0);
  assert.equal(computeMobileDprCap(3.0, 'medium'), 1.25);
  assert.equal(computeMobileDprCap(3.0, 'high'), 1.5);
  assert.equal(computeMobileDprCap(1.0, 'high'), 1.0);
});

test('clampFrameDeltaTime caps spikes at 50ms (0.05s) and handles invalid values safely', () => {
  assert.equal(clampFrameDeltaTime(0.016), 0.016);
  assert.equal(clampFrameDeltaTime(0.42), 0.05);
  assert.equal(clampFrameDeltaTime(-0.1), 0);
  assert.equal(clampFrameDeltaTime(Number.NaN), 0);
});

test('isWithinViewportCullBounds enforces 140px outer viewport cull margin', () => {
  assert.equal(isWithinViewportCullBounds(100, 100, 0, 800, 0, 400), true);
  assert.equal(isWithinViewportCullBounds(-135, 200, 0, 800, 0, 400), true);
  assert.equal(isWithinViewportCullBounds(-145, 200, 0, 800, 0, 400), false);
  assert.equal(isWithinViewportCullBounds(945, 200, 0, 800, 0, 400), false);
});

test('stepDistantBotAiClock ticks on-screen bots at 60Hz and distant off-screen bots at 15Hz', () => {
  const visible = stepDistantBotAiClock(true, 0, 0.0167, 15);
  assert.equal(visible.shouldTick, true);
  assert.equal(visible.stepDt, 0.0167);

  let acc = 0;
  let ticks = 0;
  for (let frame = 0; frame < 60; frame++) {
    const res = stepDistantBotAiClock(false, acc, 1 / 60, 15);
    acc = res.nextAccumulator;
    if (res.shouldTick) ticks++;
  }
  assert.equal(ticks, 15, `expected 15Hz distant bot ticks over 60 frames, got ${ticks}`);
});
