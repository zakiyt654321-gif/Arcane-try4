import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_PLAYABLE_AREA,
  VISION_RADIUS,
  WALL_SLAM_STUN_SECONDS,
  computePlayableViewport,
  computeEqualAreaZoom,
  computeVisibilityAlpha,
  clampBotVisionRange,
  computeEdgeChevron,
  stepPhysicsSubsteps,
  stepKnockbackVelocity,
  evaluateWallSlam,
  findChainBarrels,
  stepGeothermVent,
  evaluateSupplyDropSchedule,
  createInputBuffer,
  applyQuadraticStickCurve,
  validateMatchTelemetry,
  computeMatchTelemetryDigest,
  isValidFirebaseConfig,
  resolveSyncMode,
  executeArcaneBillingPurchase,
  ARCANE_IAP_CATALOG,
  HUD_LAYOUT_LANDSCAPE_KEY,
  HUD_LAYOUT_PORTRAIT_KEY,
  resolveHudProfileKey,
  resolveAdaptiveMusicStem,
  damageDestructibleProp,
  CHARACTER_REMOTE_ASSETS,
  computeSpriteSliceRect,
  type GeothermVentState,
} from './flagshipUpgrade';

test('Equal-area camera gives identical visible world area in Landscape (844x390) and Portrait (390x844)', () => {
  const land = computePlayableViewport(844, 390, 'auto');
  const port = computePlayableViewport(390, 844, 'auto');

  assert.equal(land.orientation, 'landscape');
  assert.equal(port.orientation, 'portrait');
  assert.equal(land.playableH, 390);
  assert.equal(port.playableH, Math.round(844 * 0.64));
  // Portrait focal anchor is centered inside the top 64dvh arena (~32dvh from top)
  assert.equal(port.focalY, Math.round(844 * 0.64) * 0.5);
  assert.ok(Math.abs(land.visibleWorldArea - BASE_PLAYABLE_AREA) < 1);
  assert.ok(Math.abs(port.visibleWorldArea - BASE_PLAYABLE_AREA) < 1);
  assert.ok(Math.abs(land.visibleWorldArea - port.visibleWorldArea) < 1);
});

test('3-way orientation preference overrides aspect ratio cleanly', () => {
  const lockedPort = computePlayableViewport(844, 390, 'portrait');
  const lockedLand = computePlayableViewport(390, 844, 'landscape');
  assert.equal(lockedPort.orientation, 'portrait');
  assert.equal(lockedLand.orientation, 'landscape');
  assert.ok(computeEqualAreaZoom(1200, 900) <= 1.85);
  assert.ok(computeEqualAreaZoom(240, 240) >= 0.55);
});

test('Hard 520u circular Fog-of-War fades smoothly across 40u rim and culls beyond 520u', () => {
  assert.equal(computeVisibilityAlpha(0), 1);
  assert.equal(computeVisibilityAlpha(480), 1);
  assert.equal(computeVisibilityAlpha(500), 0.5);
  assert.equal(computeVisibilityAlpha(VISION_RADIUS), 0);
  assert.equal(computeVisibilityAlpha(650), 0);
});

test('Bot vision parity clamps bot sight and sniping aggro to exact 520u radius', () => {
  assert.equal(clampBotVisionRange(900), 520);
  assert.equal(clampBotVisionRange(520), 520);
  assert.equal(clampBotVisionRange(380), 380);
  assert.equal(clampBotVisionRange(-10), 0);
});

test('Directional edge threat arrows appear 18px inside unobstructed arena bounds for off-screen threats within 520u', () => {
  const port = computePlayableViewport(390, 844, 'portrait');
  // Threat 400u to the right of player (outside 390px wide portrait screen, inside 520u vision)
  const offRight = computeEdgeChevron(1400, 1000, 1000, 1000, 1000, 1000, port, 18);
  assert.equal(offRight.visible, true);
  assert.equal(Math.round(offRight.screenX), port.playableW - 18);
  assert.ok(offRight.screenY <= port.playableH - 18);
  assert.ok(offRight.alpha > 0.42 && offRight.scale > 0.78);

  // Threat beyond 520u is hidden unless allowBeyondVision (supply drop / safe zone)
  const tooFar = computeEdgeChevron(1700, 1000, 1000, 1000, 1000, 1000, port, 18, false);
  assert.equal(tooFar.visible, false);
  const supplyDrop = computeEdgeChevron(1700, 1000, 1000, 1000, 1000, 1000, port, 18, true);
  assert.equal(supplyDrop.visible, true);

  // Threat right next to player (on-screen) does not render an edge arrow
  const onScreen = computeEdgeChevron(1040, 1010, 1000, 1000, 1000, 1000, port, 18);
  assert.equal(onScreen.visible, false);
});

test('Fixed-timestep sub-stepping clamps dt <= 0.05s and splits frame spikes cleanly', () => {
  const normal = stepPhysicsSubsteps(0.016);
  assert.equal(normal.length, 1);
  const spike = stepPhysicsSubsteps(0.25);
  assert.equal(spike.length, 3);
  const sum = spike.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 0.05) < 0.0001);
  assert.ok(spike.every(s => s <= 1 / 60 + 0.0001));
});

test('Impulse knockback decays exponentially and slides farther on Frost Patches', () => {
  const ground = stepKnockbackVelocity(400, 0, 0.1, 7.5, false);
  const frost = stepKnockbackVelocity(400, 0, 0.1, 7.5, true);
  assert.ok(ground.speed < 400 && ground.speed > 100);
  assert.ok(frost.speed > ground.speed);
  const stopped = stepKnockbackVelocity(5, 0, 0.016, 7.5, false);
  assert.equal(stopped.speed, 0);
});

test('Wall-Slam triggers 0.45s stun and bounded crush damage only on forceful impacts', () => {
  const light = evaluateWallSlam(180);
  assert.equal(light.triggered, false);
  assert.equal(light.stunSeconds, 0);
  const heavy = evaluateWallSlam(380);
  assert.equal(heavy.triggered, true);
  assert.equal(heavy.stunSeconds, WALL_SLAM_STUN_SECONDS);
  assert.ok(heavy.crushDamage >= 28 && heavy.crushDamage <= 75);
});

test('Ember Barrels chain-detonate nearby barrels while ignoring distant props and crates', () => {
  const props = [
    { id: 'b1', kind: 'EMBER_BARREL' as const, x: 100, y: 100, radius: 18, hp: 50, maxHp: 50, active: true },
    { id: 'b2', kind: 'EMBER_BARREL' as const, x: 190, y: 100, radius: 18, hp: 50, maxHp: 50, active: true },
    { id: 'b3', kind: 'EMBER_BARREL' as const, x: 400, y: 100, radius: 18, hp: 50, maxHp: 50, active: true },
    { id: 'c1', kind: 'ARCANE_CRATE' as const, x: 140, y: 100, radius: 18, hp: 40, maxHp: 40, active: true },
  ];
  const chained = findChainBarrels(100, 100, 115, props, 'b1');
  assert.equal(chained.length, 1);
  assert.equal(chained[0].id, 'b2');
});

test('Geotherm Vent cycles IDLE -> TELEGRAPH -> ERUPTING pulse -> IDLE cleanly', () => {
  let vent: GeothermVentState = { phase: 'IDLE', timer: 0.1, didEruptPulse: false };
  vent = stepGeothermVent(vent, 0.2);
  assert.equal(vent.phase, 'TELEGRAPH');
  assert.equal(vent.didEruptPulse, false);
  vent = stepGeothermVent(vent, 2.0);
  assert.equal(vent.phase, 'ERUPTING');
  assert.equal(vent.didEruptPulse, true);
  vent = stepGeothermVent(vent, 0.6);
  assert.equal(vent.phase, 'IDLE');
});

test('Mid-match Arcane Supply Drop triggers twice per match at scheduled intervals', () => {
  assert.equal(evaluateSupplyDropSchedule(30, 0), false);
  assert.equal(evaluateSupplyDropSchedule(45, 0), true);
  assert.equal(evaluateSupplyDropSchedule(90, 1), false);
  assert.equal(evaluateSupplyDropSchedule(106, 1), true);
  assert.equal(evaluateSupplyDropSchedule(180, 2), false);
});

test('120ms Input Buffer fires early inputs within window and expires stale inputs', () => {
  const buf = createInputBuffer();
  buf.push('dash', 1000);
  assert.equal(buf.peek('dash', 1110), true);
  assert.equal(buf.consume('dash', 1115), true);
  // Consumed once
  assert.equal(buf.consume('dash', 1118), false);
  // Expired beyond 120ms
  buf.push('ability', 2000);
  assert.equal(buf.consume('ability', 2150), false);
});

test('Quadratic analog joystick curve suppresses deadzone and smooths low tilt while reaching 1.0 at full tilt', () => {
  const dead = applyQuadraticStickCurve(0.05, 0.02);
  assert.equal(dead.magnitude, 0);
  const mid = applyQuadraticStickCurve(0.54, 0);
  assert.ok(mid.magnitude > 0.2 && mid.magnitude < 0.35);
  const full = applyQuadraticStickCurve(1, 0);
  assert.ok(Math.abs(full.x - 1) < 0.0001 && Math.abs(full.magnitude - 1) < 0.0001);
});

test('Match telemetry sanity validator accepts legitimate runs and rejects tampered payloads', () => {
  const legit = validateMatchTelemetry({
    durationSec: 145,
    kills: 7,
    maxDps: 420,
    placement: 1,
    damageDealt: 1850,
    champion: 'BERSERKER',
  });
  assert.equal(legit.valid, true);
  assert.ok(legit.digest.startsWith('T1_'));
  assert.equal(legit.digest, computeMatchTelemetryDigest({
    durationSec: 145,
    kills: 7,
    maxDps: 420,
    placement: 1,
    damageDealt: 1850,
    champion: 'BERSERKER',
  }));

  const impossibleDps = validateMatchTelemetry({
    durationSec: 120,
    kills: 5,
    maxDps: 9999,
    placement: 1,
    damageDealt: 10000,
    champion: 'MAGE',
  });
  assert.equal(impossibleDps.valid, false);

  const impossibleKills = validateMatchTelemetry({
    durationSec: 15,
    kills: 15,
    maxDps: 300,
    placement: 1,
    damageDealt: 1500,
    champion: 'ASSASSIN',
  });
  assert.equal(impossibleKills.valid, false);
});

test('CloudSync fallback detects placeholder/missing Firebase configs and resolves sync mode cleanly', () => {
  assert.equal(isValidFirebaseConfig(null), false);
  assert.equal(isValidFirebaseConfig({ apiKey: 'YOUR_API_KEY', projectId: 'remixed-project-id', appId: '1:2:web:3' }), false);
  const validCfg = { apiKey: 'AIzaSyRealKey12345', projectId: 'arcane-prod-01', appId: '1:123:web:abc' };
  assert.equal(isValidFirebaseConfig(validCfg), true);
  assert.equal(resolveSyncMode(null).mode, 'local');
  assert.equal(resolveSyncMode(null).label, 'Local Save Mode · Cloud Ready');
  assert.equal(resolveSyncMode(validCfg, null).mode, 'cloud-ready');
  assert.equal(resolveSyncMode(validCfg, 'uid_123').mode, 'cloud');
});

test('ArcaneBilling IAP bridge grants Gem packs on Web preview and delegates to Play Billing when present', async () => {
  assert.equal(ARCANE_IAP_CATALOG.length, 3);
  const webPack = await executeArcaneBillingPurchase('gems_royal_500');
  assert.equal(webPack.ok, true);
  assert.equal(webPack.channel, 'web-preview');
  assert.equal(webPack.gemsGranted, 500);
  assert.equal(webPack.crystalsGranted, 250);

  const pass = await executeArcaneBillingPurchase('arcane_pass', {
    purchaseProduct: async () => ({ ok: true }),
  });
  assert.equal(pass.ok, true);
  assert.equal(pass.channel, 'play-billing');
  assert.equal(pass.passUnlocked, true);

  const badSku = await executeArcaneBillingPurchase('invalid_sku');
  assert.equal(badSku.ok, false);
});

test('Dual Custom HUD profiles map to distinct landscape and portrait storage keys', () => {
  assert.equal(resolveHudProfileKey('landscape'), HUD_LAYOUT_LANDSCAPE_KEY);
  assert.equal(resolveHudProfileKey('portrait'), HUD_LAYOUT_PORTRAIT_KEY);
  assert.notEqual(HUD_LAYOUT_LANDSCAPE_KEY, HUD_LAYOUT_PORTRAIT_KEY);
});

test('Adaptive multi-state audio engine switches to Final-10 Storm Climax at alive <= 10 or phase >= 4', () => {
  assert.equal(resolveAdaptiveMusicStem('LOBBY', 50, 0), 'lobby');
  assert.equal(resolveAdaptiveMusicStem('PLAYING', 32, 2), 'combat');
  assert.equal(resolveAdaptiveMusicStem('PLAYING', 10, 2), 'climax');
  assert.equal(resolveAdaptiveMusicStem('PLAYING', 18, 4), 'climax');
});

test('Crystal Cover Pillar blocks projectiles until HP reaches 0 and shatters', () => {
  const pillar = { id: 'p1', kind: 'CRYSTAL_PILLAR' as const, x: 0, y: 0, radius: 22, hp: 100, maxHp: 100, active: true };
  const hit1 = damageDestructibleProp(pillar, 40);
  assert.equal(hit1.blocksProjectile, true);
  assert.equal(hit1.shattered, false);
  assert.equal(pillar.active, true);
  const hit2 = damageDestructibleProp(pillar, 70);
  assert.equal(hit2.shattered, true);
  assert.equal(pillar.active, false);
});

test('Arcane Crate shatters into HP/MP orb drop while Ember Barrel triggers explosion', () => {
  const crate = { id: 'c1', kind: 'ARCANE_CRATE' as const, x: 0, y: 0, radius: 18, hp: 35, maxHp: 35, active: true };
  const cRes = damageDestructibleProp(crate, 40);
  assert.equal(cRes.shattered, true);
  assert.equal(cRes.dropOrb, 'hp_mp');
  assert.equal(cRes.explode, false);

  const barrel = { id: 'b1', kind: 'EMBER_BARREL' as const, x: 0, y: 0, radius: 18, hp: 45, maxHp: 45, active: true };
  const bRes = damageDestructibleProp(barrel, 50);
  assert.equal(bRes.shattered, true);
  assert.equal(bRes.explode, true);
});

test('Equal-area camera holds parity across tall modern phones (412x915 portrait vs 915x412 landscape)', () => {
  const p = computePlayableViewport(412, 915, 'auto');
  const l = computePlayableViewport(915, 412, 'auto');
  assert.ok(Math.abs(p.visibleWorldArea - l.visibleWorldArea) < 1);
  assert.ok(p.focalY < p.viewportH * 0.35);
});

test('Wall-Slam crush damage clamps cleanly at upper ceiling for extreme velocity impacts', () => {
  const mega = evaluateWallSlam(1400);
  assert.equal(mega.triggered, true);
  assert.equal(mega.crushDamage, 75);
  assert.equal(mega.stunSeconds, WALL_SLAM_STUN_SECONDS);
});

test('Character remote asset manifest maps exact GitHub Pages PNG URLs, ./assets/Image fallbacks, grids, and The Berserker spelling', () => {
  assert.equal(CHARACTER_REMOTE_ASSETS.BERSERKER.displayName, 'The Berserker');
  assert.equal(
    CHARACTER_REMOTE_ASSETS.BERSERKER.portraitUrl,
    'https://zakiyt654321-gif.github.io/Arcane-Royal-Try3/assets/Image/Beserker_Portrait.png'
  );
  assert.equal(
    CHARACTER_REMOTE_ASSETS.BERSERKER.spriteUrl,
    'https://zakiyt654321-gif.github.io/Arcane-Royal-Try3/assets/Image/Beserker_Sprite.png'
  );
  assert.equal(CHARACTER_REMOTE_ASSETS.BERSERKER.portraitFallback, './assets/Image/Beserker_Portrait.png');
  assert.equal(CHARACTER_REMOTE_ASSETS.BERSERKER.spriteFallback, './assets/Image/Beserker_Sprite.png');
  assert.equal(CHARACTER_REMOTE_ASSETS.BERSERKER.cols, 5);
  assert.equal(CHARACTER_REMOTE_ASSETS.BERSERKER.rows, 4);
  assert.equal(CHARACTER_REMOTE_ASSETS.BERSERKER.frameCount, 20);

  assert.equal(
    CHARACTER_REMOTE_ASSETS.TIDECALLER.portraitUrl,
    'https://zakiyt654321-gif.github.io/Arcane-Royal-Try3/assets/Image/Tidecaller_Portrait.png'
  );
  assert.equal(
    CHARACTER_REMOTE_ASSETS.TIDECALLER.spriteUrl,
    'https://zakiyt654321-gif.github.io/Arcane-Royal-Try3/assets/Image/Tidecaller_Sprite.png'
  );
  assert.equal(CHARACTER_REMOTE_ASSETS.TIDECALLER.portraitFallback, './assets/Image/Tidecaller_Portrait.png');
  assert.equal(CHARACTER_REMOTE_ASSETS.TIDECALLER.spriteFallback, './assets/Image/Tidecaller_Sprite.png');
  assert.equal(CHARACTER_REMOTE_ASSETS.TIDECALLER.cols, 5);
  assert.equal(CHARACTER_REMOTE_ASSETS.TIDECALLER.rows, 6);
  assert.equal(CHARACTER_REMOTE_ASSETS.TIDECALLER.frameCount, 30);

  assert.equal(
    CHARACTER_REMOTE_ASSETS.SHADOW.portraitUrl,
    'https://zakiyt654321-gif.github.io/Arcane-Royal-Try3/assets/Image/Shadow_Portrait.png'
  );
  assert.equal(
    CHARACTER_REMOTE_ASSETS.SHADOW.spriteUrl,
    'https://zakiyt654321-gif.github.io/Arcane-Royal-Try3/assets/Image/Shadow_Sprite.png'
  );
  assert.equal(CHARACTER_REMOTE_ASSETS.SHADOW.portraitFallback, './assets/Image/Shadow_Portrait.png');
  assert.equal(CHARACTER_REMOTE_ASSETS.SHADOW.spriteFallback, './assets/Image/Shadow_Sprite.png');
  assert.equal(CHARACTER_REMOTE_ASSETS.SHADOW.cols, 5);
  assert.equal(CHARACTER_REMOTE_ASSETS.SHADOW.rows, 4);
  assert.equal(CHARACTER_REMOTE_ASSETS.SHADOW.frameCount, 20);
});

test('computeSpriteSliceRect calculates exact cell dimensions with zero frame bleeding and preserves aspect ratio', () => {
  // Berserker 559x447 (5x4)
  const bCell = computeSpriteSliceRect(559, 447, 5, 4, 4, 3, 74);
  assert.ok(Math.abs(bCell.frameW - 111.8) < 1e-6);
  assert.ok(Math.abs(bCell.frameH - 111.75) < 1e-6);
  assert.ok(bCell.sx > 4 * bCell.frameW && bCell.sx + bCell.sw < 559);
  assert.ok(bCell.sy > 3 * bCell.frameH && bCell.sy + bCell.sh < 447);

  // Tidecaller 395x632 (5x6) -> 79 x 105.333 tall aspect ratio preserved
  const tCell = computeSpriteSliceRect(395, 632, 5, 6, 2, 5, 74);
  assert.equal(tCell.frameW, 79);
  assert.ok(Math.abs(tCell.frameH - 632 / 6) < 1e-6);
  assert.equal(tCell.drawH, 74);
  assert.ok(Math.abs(tCell.drawW - 74 * (79 / (632 / 6))) < 1e-6);
  assert.ok(tCell.sy + tCell.sh < 632);

  // Shadow 1600x1280 (5x4) -> 320 x 320 exact square
  const sCell = computeSpriteSliceRect(1600, 1280, 5, 4, 0, 0, 74);
  assert.equal(sCell.frameW, 320);
  assert.equal(sCell.frameH, 320);
  assert.equal(sCell.drawW, 74);
  assert.equal(sCell.drawH, 74);
});


