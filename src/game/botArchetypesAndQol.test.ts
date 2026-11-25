import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getBotArchetype,
  selectPlayerAggroBots,
  computeFeelerSteering,
  shouldPrioritizeStormEscape,
  findBountyLeader,
  computeBountyElimRewards,
  createArcaneJumpPads,
  canTriggerJumpPad,
  encodeSaveBackup,
  decodeSaveBackup,
  shouldStepBatterySaverFrame,
} from './botArchetypesAndQol';

test('bot champion archetypes define distinct BRAWLER, ZONER, and FLANKER rules', () => {
  const brawler = getBotArchetype('fire');
  const zoner = getBotArchetype('water');
  const flanker = getBotArchetype('dark');

  assert.equal(brawler.role, 'BRAWLER');
  assert.deepEqual([brawler.minRange, brawler.maxRange], [45, 110]);
  assert.equal(brawler.retreatHpRatio, 0.25);
  assert.equal(brawler.dashMode, 'GAP_CLOSE');

  assert.equal(zoner.role, 'ZONER');
  assert.deepEqual([zoner.minRange, zoner.maxRange], [210, 340]);
  assert.equal(zoner.retreatHpRatio, 0.45);
  assert.equal(zoner.mpReserveRatio, 0.45);
  assert.equal(zoner.dashMode, 'ESCAPE_MELEE');

  assert.equal(flanker.role, 'FLANKER');
  assert.deepEqual([flanker.minRange, flanker.maxRange], [150, 230]);
  assert.equal(flanker.dashMode, 'LATERAL_DISENGAGE');
  assert.equal(flanker.spellTelegraphSec, 0.35);
});

test('selectPlayerAggroBots caps active human-player aggro at 2 closest alive bots', () => {
  const allowed = selectPlayerAggroBots([
    { id: 'b1', distToPlayer: 280, isAlive: true },
    { id: 'b2', distToPlayer: 90, isAlive: false },
    { id: 'b3', distToPlayer: 120, isAlive: true },
    { id: 'b4', distToPlayer: 185, isAlive: true },
    { id: 'b5', distToPlayer: 210, isAlive: true },
  ]);
  assert.equal(allowed.size, 2);
  assert.equal(allowed.has('b3'), true);
  assert.equal(allowed.has('b4'), true);
  assert.equal(allowed.has('b1'), false);
  assert.equal(allowed.has('b2'), false);
});

test('computeFeelerSteering smoothly steers around a blocking obstacle using 3 probes', () => {
  const clear = computeFeelerSteering(0, 0, 0, [{ x: 300, y: 0, r: 30 }], 85, 20);
  assert.equal(clear.blockedCenter, false);
  assert.equal(clear.steerOffsetRad, 0);

  // Obstacle slightly above center ray -> right probe (+30deg) is clearer than left (-30deg)
  const steer = computeFeelerSteering(0, 0, 0, [{ x: 65, y: -18, r: 30 }], 85, 20);
  assert.equal(steer.blockedCenter, true);
  assert.ok(steer.steerOffsetRad > 0, 'Expected positive steering angle away from upper obstacle');
});

test('shouldPrioritizeStormEscape overrides duels near storm border or when closing', () => {
  assert.equal(shouldPrioritizeStormEscape(500, 500, 500, 500, 1000, false, 90), false);
  assert.equal(shouldPrioritizeStormEscape(1420, 500, 500, 500, 1000, false, 90), true);
  assert.equal(shouldPrioritizeStormEscape(1300, 500, 500, 500, 1000, true, 90), true);
});

test('kill-leader bounty requires 3+ kills and doubles coins plus +75 bonus XP', () => {
  const none = findBountyLeader([
    { id: 'a', kills: 2, isAlive: true },
    { id: 'b', kills: 5, isAlive: false },
  ]);
  assert.equal(none, null);

  const leader = findBountyLeader([
    { id: 'a', kills: 3, isAlive: true },
    { id: 'b', kills: 5, isAlive: true },
  ]);
  assert.equal(leader?.id, 'b');

  const reward = computeBountyElimRewards(40, 25, true);
  assert.deepEqual(reward, { coins: 80, xp: 100, bonusXp: 75, isBounty: true });
});

test('arcane jump pads spawn on 6 ridges and enforce cooldown + grounded trigger', () => {
  const pads = createArcaneJumpPads(4200);
  assert.equal(pads.length, 6);
  const pad = pads[0];
  assert.equal(canTriggerJumpPad(pad.x + 10, pad.y, 0, -99, pad, 10), true);
  assert.equal(canTriggerJumpPad(pad.x + 10, pad.y, 25, -99, pad, 10), false);
  assert.equal(canTriggerJumpPad(pad.x + 10, pad.y, 0, 7.5, pad, 10), false);
});

test('save backup Base64 codec round-trips save + HUD layout and rejects corrupt input', () => {
  const code = encodeSaveBackup(
    { name: 'ARCANIST', level: 12, gold: 980 },
    { joystick: { dx: 12, dy: -8, scale: 1.1, opacity: 0.9 } }
  );
  const decoded = decodeSaveBackup(code);
  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    assert.equal(decoded.payload.save.name, 'ARCANIST');
    assert.equal(decoded.payload.save.level, 12);
    assert.ok(decoded.payload.hudLayout);
  }

  const bad1 = decodeSaveBackup('not-valid-base64!!!');
  assert.equal(bad1.ok, false);
  const bad2 = decodeSaveBackup(Buffer.from('{"app":"other"}').toString('base64'));
  assert.equal(bad2.ok, false);
});

test('30 FPS battery saver throttles frames below 32.5ms and passes all frames when off', () => {
  assert.equal(shouldStepBatterySaverFrame(16.6, false), true);
  assert.equal(shouldStepBatterySaverFrame(16.6, true), false);
  assert.equal(shouldStepBatterySaverFrame(33.4, true), true);
});
