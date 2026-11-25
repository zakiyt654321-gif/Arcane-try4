import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TILT_Y_SCALE,
  CAMERA_LOOKAHEAD_MAX,
  CAMERA_ACTION_ZOOM,
  PROP_SHEET_OUTER_MARGIN,
  WORLD_VISION_CAP,
  ISLAND_MAP_MANIFEST,
  PROP_SHEET_QUADRANTS,
  compute2x2QuadrantRects,
  isBrightMagentaPixel,
  isDarkMagentaShadowPixel,
  stripMagentaAndDespillRGBA,
  computeTrimAndFootAnchor,
  worldToScreen25D,
  screenToWorld25D,
  computeAimAngleFromPointer25D,
  computeCameraFocusTarget,
  computeShadowMetricsForZ,
  isWithinWorldVisionCap,
  classifyIslandBiome,
  sortRenderablesByFootY,
  generateIsland25DWorld
} from './island25d.ts';

test('Part A: Manifest registers all 6 map images in ./assets/Image/ with exact quadrant mapping', () => {
  const paths = ISLAND_MAP_MANIFEST.map((e) => e.path);
  assert.deepEqual(paths, [
    './assets/Image/tile_citadel.png',
    './assets/Image/tile_grove.png',
    './assets/Image/tile_obsidian.png',
    './assets/Image/tile_tidal.png',
    './assets/Image/props_structures.png',
    './assets/Image/props_nature_loot.png'
  ]);
  assert.deepEqual(PROP_SHEET_QUADRANTS.props_structures, {
    tl: 'pillar',
    tr: 'wall',
    bl: 'obelisk',
    br: 'jump_pad'
  });
  assert.deepEqual(PROP_SHEET_QUADRANTS.props_nature_loot, {
    tl: 'tree',
    tr: 'boulder',
    bl: 'chest',
    br: 'barrel'
  });
});

test('Part A: 2x2 prop slicer trims 20px outer border from each edge cleanly', () => {
  const rects = compute2x2QuadrantRects(1024, 1024, PROP_SHEET_OUTER_MARGIN);
  assert.equal(rects.tl.x, 20);
  assert.equal(rects.tl.y, 20);
  assert.equal(rects.tl.w, 492);
  assert.equal(rects.tl.h, 492);

  assert.equal(rects.tr.x, 512);
  assert.equal(rects.tr.y, 20);
  assert.equal(rects.tr.x + rects.tr.w, 1004); // 1024 - 20

  assert.equal(rects.bl.x, 20);
  assert.equal(rects.bl.y, 512);
  assert.equal(rects.bl.y + rects.bl.h, 1004);

  assert.equal(rects.br.x, 512);
  assert.equal(rects.br.y, 512);
  assert.equal(rects.br.x + rects.br.w, 1004);
  assert.equal(rects.br.y + rects.br.h, 1004);
});

test('Part A: Magenta background, dark purple-magenta shadow removal & 1px JPEG edge despill pass', () => {
  // 5x5 test sprite:
  // Outer ring = bright magenta (250, 12, 240) & dark purple-magenta shadow (110, 42, 95)
  // 1px boundary pixel = JPEG pink fringe (118, 74, 104) (R > G && B > G, fails magenta strip)
  // Core pixels = rich forest green (45, 160, 72) and explosive barrel red (210, 40, 35)
  const W = 5;
  const H = 5;
  const data = new Uint8ClampedArray(W * H * 4);

  const setPx = (x: number, y: number, r: number, g: number, b: number, a = 255) => {
    const i = (y * W + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  };

  // Fill background with bright magenta & dark purple shadow
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (y === H - 1) {
        setPx(x, y, 110, 42, 95, 255); // darker purple-magenta baked shadow
      } else {
        setPx(x, y, 250, 12, 240, 255); // bright magenta chroma key
      }
    }
  }

  // Verify exact threshold predicates
  assert.equal(isBrightMagentaPixel(250, 12, 240), true);
  assert.equal(isDarkMagentaShadowPixel(110, 42, 95), true);
  assert.equal(isBrightMagentaPixel(45, 160, 72), false);
  assert.equal(isDarkMagentaShadowPixel(45, 160, 72), false);
  assert.equal(isBrightMagentaPixel(210, 40, 35), false); // red barrel stays intact!
  assert.equal(isDarkMagentaShadowPixel(210, 40, 35), false);

  // Place 3x3 sprite core: boundary subtle JPEG pink fringe at (1,1), green leaf at (2,2), red barrel at (2,3)
  // (105, 86, 100) survives Pass 1 (105 <= 86 * 1.3), and has R > G && B > G so Pass 2 neutralizes it into dark outline!
  setPx(1, 1, 105, 86, 100, 220);
  setPx(2, 1, 45, 160, 72, 255);
  setPx(3, 1, 45, 160, 72, 255);
  setPx(1, 2, 45, 160, 72, 255);
  setPx(2, 2, 45, 160, 72, 255);
  setPx(3, 2, 45, 160, 72, 255);
  setPx(2, 3, 210, 40, 35, 255); // red barrel pixel

  const stats = stripMagentaAndDespillRGBA(data, W, H);
  assert.ok(stats.strippedCount >= 18, 'All bright magenta and dark purple-magenta shadow pixels stripped');
  assert.ok(stats.despilledCount >= 1, 'Boundary pink fringe pixel despilled');

  // Bright magenta & dark shadow pixels must be alpha = 0
  assert.equal(data[(0 * W + 0) * 4 + 3], 0);
  assert.equal(data[(4 * W + 2) * 4 + 3], 0);

  // Boundary pink fringe at (1,1) must be neutralized (R <= G and B <= G, dark outline tone)
  const fringeIdx = (1 * W + 1) * 4;
  assert.ok(data[fringeIdx] <= data[fringeIdx + 1], 'Pink fringe R neutralized');
  assert.ok(data[fringeIdx + 2] <= data[fringeIdx + 1], 'Pink fringe B neutralized');
  assert.ok(data[fringeIdx] < 80, 'Neutralized into dark outline tone');

  // Core forest green & explosive barrel red must remain completely untouched
  const greenIdx = (2 * W + 2) * 4;
  assert.equal(data[greenIdx], 45);
  assert.equal(data[greenIdx + 1], 160);
  assert.equal(data[greenIdx + 2], 72);
  assert.equal(data[greenIdx + 3], 255);

  const redIdx = (3 * W + 2) * 4;
  assert.equal(data[redIdx], 210);
  assert.equal(data[redIdx + 1], 40);
  assert.equal(data[redIdx + 2], 35);
  assert.equal(data[redIdx + 3], 255);

  // Auto-trim & bottom-center foot anchor
  const trim = computeTrimAndFootAnchor(data, W, H);
  assert.equal(trim.trimX, 1);
  assert.equal(trim.trimY, 1);
  assert.equal(trim.trimW, 3);
  assert.equal(trim.trimH, 3);
  assert.equal(trim.anchorY, 2); // bottom row of trimmed 3px height
  assert.ok(Math.abs(trim.anchorX - 1) <= 0.5, 'Bottom-center foot anchor aligned to bottom pixel (x=2 -> local 1)');
});

test('Part C: Reverse 0.72 vertical tilt in screen-to-world & pointer aim conversion (Portrait & Landscape)', () => {
  assert.equal(TILT_Y_SCALE, 0.72);

  // Test across both Landscape (844x390) and Portrait (390x844) focal points and varied zoom levels
  const viewports = [
    { focalX: 422, focalY: 195, zoom: 0.92 },
    { focalX: 195, focalY: 270, zoom: 0.74 },
    { focalX: 640, focalY: 360, zoom: 1.15 }
  ];

  for (const vp of viewports) {
    const camX = 10000;
    const camY = 10000;
    const targetWX = 10240;
    const targetWY = 10180;

    // Project ground point (wz = 0) under 0.72 tilt -> invert back -> must match exact world coords
    const screen = worldToScreen25D(targetWX, targetWY, 0, camX, camY, vp.zoom, vp.focalX, vp.focalY, TILT_Y_SCALE);
    const back = screenToWorld25D(screen.sx, screen.sy, camX, camY, vp.zoom, vp.focalX, vp.focalY, TILT_Y_SCALE);

    assert.ok(Math.abs(back.wx - targetWX) < 1e-6);
    assert.ok(Math.abs(back.wy - targetWY) < 1e-6);

    // Aiming from player at (10000, 10000, z=0) toward screen projection of (10240, 10180)
    // Must recover exact true-world angle atan2(180, 240) despite 0.72 vertical foreshortening!
    const expectedAngle = Math.atan2(targetWY - camY, targetWX - camX);
    const aim = computeAimAngleFromPointer25D(
      screen.sx,
      screen.sy,
      camX,
      camY,
      0,
      camX,
      camY,
      vp.zoom,
      vp.focalX,
      vp.focalY,
      TILT_Y_SCALE
    );
    assert.equal(aim.valid, true);
    assert.ok(Math.abs(aim.angle - expectedAngle) < 1e-6, 'Aim angle reverses 0.72 tilt accurately');
  }
});

test('Part C: Dynamic camera look-ahead (<=55u), action zoom (0.92x on dash/jump pad), and Z-height shadow separation', () => {
  // Aim look-ahead approaches 55u smoothly and never exceeds 55u
  let lookX = 0;
  let lookY = 0;
  let actionZoom = 1.0;
  for (let i = 0; i < 60; i++) {
    const out = computeCameraFocusTarget({
      playerX: 10000,
      playerY: 10000,
      playerZ: 0,
      isAiming: true,
      aimAngle: Math.PI / 4,
      velX: 0,
      velY: 0,
      maxSpeed: 240,
      isDashing: true,
      isJumpPadAirborne: false,
      isDropping: false,
      currentLookX: lookX,
      currentLookY: lookY,
      currentActionZoom: actionZoom,
      deltaTime: 1 / 60,
      reducedMotion: false
    });
    lookX = out.lookAheadX;
    lookY = out.lookAheadY;
    actionZoom = out.actionZoom;
  }

  const lookDist = Math.hypot(lookX, lookY);
  assert.ok(lookDist > 50 && lookDist <= CAMERA_LOOKAHEAD_MAX + 0.01, `Look-ahead converged near 55u: ${lookDist}`);
  assert.ok(Math.abs(actionZoom - CAMERA_ACTION_ZOOM) < 0.01, `Dash zooms smoothly to 0.92x: ${actionZoom}`);

  // Reduced motion disables dynamic action zoom kick
  const rmOut = computeCameraFocusTarget({
    playerX: 10000,
    playerY: 10000,
    playerZ: 0,
    isAiming: false,
    aimAngle: 0,
    velX: 240,
    velY: 0,
    maxSpeed: 240,
    isDashing: true,
    isJumpPadAirborne: true,
    isDropping: false,
    currentLookX: 0,
    currentLookY: 0,
    currentActionZoom: 1.0,
    deltaTime: 0.05,
    reducedMotion: true
  });
  assert.equal(rmOut.actionZoom, 1.0);

  // Z-height separation: ground shadow at (x, y, z=0) stays below elevated sprite at (x, y, z=140)
  const groundPt = worldToScreen25D(10000, 10000, 0, 10000, 10000, 1.0, 400, 300);
  const airPt = worldToScreen25D(10000, 10000, 140, 10000, 10000, 1.0, 400, 300);
  assert.equal(groundPt.sx, airPt.sx);
  assert.equal(groundPt.sy - airPt.sy, 140);

  const groundShadow = computeShadowMetricsForZ(0);
  const airShadow = computeShadowMetricsForZ(140);
  assert.ok(airShadow.scale < groundShadow.scale, 'Shadow shrinks smoothly with altitude');
  assert.ok(airShadow.alpha < groundShadow.alpha, 'Shadow softens slightly with altitude');
});

test('Part B: Deterministic 4-biome island layout, Y-sort ordering by footY, and 520u vision fairness', () => {
  // Verify all 4 biomes are classified cleanly at their geographic centers
  assert.equal(classifyIslandBiome(10000, 10000), 'CITADEL');
  assert.equal(classifyIslandBiome(3800, 4200), 'GROVE');
  assert.equal(classifyIslandBiome(16200, 4200), 'OBSIDIAN');
  assert.equal(classifyIslandBiome(13500, 16200), 'TIDAL');

  // Deterministic generation produces identical props across repeated calls
  const worldA = generateIsland25DWorld(20000, 20000, 20260725);
  const worldB = generateIsland25DWorld(20000, 20000, 20260725);
  assert.deepEqual(worldA.staticProps, worldB.staticProps);
  assert.deepEqual(worldA.destructibles, worldB.destructibles);
  assert.deepEqual(worldA.jumpPads, worldB.jumpPads);

  // Confirm all 4 biome themes have their signature props
  const citadelKeys = new Set(worldA.staticProps.filter((p) => p.biome === 'CITADEL').map((p) => p.spriteKey));
  assert.ok(citadelKeys.has('pillar') && citadelKeys.has('wall'));

  const groveKeys = new Set(worldA.staticProps.filter((p) => p.biome === 'GROVE').map((p) => p.spriteKey));
  assert.ok(groveKeys.has('tree') && groveKeys.has('boulder'));

  const obsidianDestKinds = new Set(worldA.destructibles.filter((d) => d.biome === 'OBSIDIAN').map((d) => d.kind));
  assert.ok(obsidianDestKinds.has('BARREL') && obsidianDestKinds.has('CRATE'));

  const tidalKeys = new Set(worldA.staticProps.filter((p) => p.biome === 'TIDAL').map((p) => p.spriteKey));
  assert.ok(tidalKeys.has('obelisk'));

  // Stable Y-sort ordering: sprite with smaller footY draws behind sprite with larger footY
  const sorted = sortRenderablesByFootY([
    { id: 'fighter_front', footY: 10200, x: 10000 },
    { id: 'pillar_mid', footY: 10100, x: 10000 },
    { id: 'fighter_behind', footY: 10020, x: 10000 },
    { id: 'tree_tie_b', footY: 10100, x: 10050 },
    { id: 'tree_tie_a', footY: 10100, x: 9950 }
  ]);
  assert.deepEqual(
    sorted.map((s) => s.id),
    ['fighter_behind', 'tree_tie_a', 'pillar_mid', 'tree_tie_b', 'fighter_front']
  );

  // 520u vision fairness invariant in true unscaled world coordinates
  assert.equal(WORLD_VISION_CAP, 520);
  assert.equal(isWithinWorldVisionCap(10000, 10000, 10520, 10000), true);
  assert.equal(isWithinWorldVisionCap(10000, 10000, 10000, 10520), true);
  assert.equal(isWithinWorldVisionCap(10000, 10000, 10521, 10000), false);
  assert.equal(isWithinWorldVisionCap(10000, 10000, 10000, 10521), false);
});
