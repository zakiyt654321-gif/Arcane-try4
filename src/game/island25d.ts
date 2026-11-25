// ============================================================================
// ARCANE ROYALE — 2.5D BATTLE ROYALE ISLAND & 3-LAYER 45° ACTION CAMERA ENGINE
// ============================================================================
// Pure, deterministic TypeScript module (zero Three.js) covering:
//   - PART A: 2x2 Prop Sheet Slicer (20px outer margin trim, bright/dark magenta
//             background & shadow stripping, 1px JPEG pink-fringe despill pass,
//             auto-trim transparent bounds, bottom-center foot anchor) + rich
//             procedural canvas fallbacks when PNGs are unavailable.
//   - PART B: Hand-crafted 4-Biome Island (Arcane Citadel, Whispering Grove,
//             Obsidian Forge, Tidal Ruins) via deterministic seeded `worldRng`,
//             Y-sort comparator, and floating sky-island perimeter geometry.
//   - PART C: 3-Layer 45-Degree Action Camera (0.72 vertical ground tilt,
//             reverse-tilt screen-to-world aim conversion, 55u aim/sprint
//             look-ahead, 0.92x dash/jump-pad action zoom, Z-height shadow
//             separation, and 520u world-space vision cap fairness).
// ============================================================================

export const TILT_Y_SCALE = 0.72;
export const INV_TILT_Y_SCALE = 1 / TILT_Y_SCALE;
export const PROP_SHEET_OUTER_MARGIN = 20;
export const CAMERA_LOOKAHEAD_MAX = 55;
export const CAMERA_ACTION_ZOOM = 0.92;
export const PARALLAX_CLOUD_FACTOR = 0.72;
export const CONTACT_SHADOW_RGBA = 'rgba(0, 0, 0, 0.34)';
export const WORLD_VISION_CAP = 520;

export type IslandBiomeId = 'CITADEL' | 'GROVE' | 'OBSIDIAN' | 'TIDAL';

export type PropSpriteKey =
  | 'pillar'
  | 'wall'
  | 'obelisk'
  | 'jump_pad'
  | 'tree'
  | 'boulder'
  | 'chest'
  | 'barrel';

export type BiomeTileKey =
  | 'tile_citadel'
  | 'tile_grove'
  | 'tile_obsidian'
  | 'tile_tidal';

export type MapImageKey = BiomeTileKey | 'props_structures' | 'props_nature_loot';

export interface MapAssetEntry {
  key: MapImageKey;
  path: string;
  kind: 'tile' | 'sheet';
}

export const ISLAND_MAP_MANIFEST: ReadonlyArray<MapAssetEntry> = Object.freeze([
  { key: 'tile_citadel', path: './assets/Image/tile_citadel.png', kind: 'tile' },
  { key: 'tile_grove', path: './assets/Image/tile_grove.png', kind: 'tile' },
  { key: 'tile_obsidian', path: './assets/Image/tile_obsidian.png', kind: 'tile' },
  { key: 'tile_tidal', path: './assets/Image/tile_tidal.png', kind: 'tile' },
  { key: 'props_structures', path: './assets/Image/props_structures.png', kind: 'sheet' },
  { key: 'props_nature_loot', path: './assets/Image/props_nature_loot.png', kind: 'sheet' }
]);

export const PROP_SHEET_QUADRANTS: Readonly<
  Record<'props_structures' | 'props_nature_loot', { tl: PropSpriteKey; tr: PropSpriteKey; bl: PropSpriteKey; br: PropSpriteKey }>
> = Object.freeze({
  props_structures: {
    tl: 'pillar',
    tr: 'wall',
    bl: 'obelisk',
    br: 'jump_pad'
  },
  props_nature_loot: {
    tl: 'tree',
    tr: 'boulder',
    bl: 'chest',
    br: 'barrel'
  }
});

export interface Rect2D {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TrimAndAnchorResult {
  trimX: number;
  trimY: number;
  trimW: number;
  trimH: number;
  anchorX: number;
  anchorY: number;
  opaqueCount: number;
}

export interface SlicedPropSprite {
  key: PropSpriteKey;
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
  source: 'sheet' | 'procedural';
}

export interface IslandStaticProp {
  id: string;
  spriteKey: 'pillar' | 'wall' | 'obelisk' | 'tree' | 'boulder';
  biome: IslandBiomeId;
  x: number;
  y: number;
  footY: number;
  collisionRadius: number;
  drawScale: number;
  shadowRx: number;
  shadowRy: number;
  zHeight: number;
  flipX: boolean;
}

export interface IslandDestructibleSpawn {
  id: string;
  kind: 'CRATE' | 'BARREL' | 'CRYSTAL_PILLAR';
  spriteKey: 'chest' | 'barrel' | 'boulder' | 'obelisk';
  biome: IslandBiomeId;
  x: number;
  y: number;
  radius: number;
  maxHp: number;
  drawScale: number;
}

export interface IslandJumpPadSpawn {
  id: string;
  biome: IslandBiomeId;
  x: number;
  y: number;
  radius: number;
  label: string;
  pulseOffset: number;
}

export interface IslandPathSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  biome: IslandBiomeId;
  kind: 'stone_path' | 'tidal_channel' | 'magma_vein' | 'citadel_ring';
}

export interface IslandBiomeRegion {
  id: IslandBiomeId;
  name: string;
  x: number; // normalized 0..1
  y: number; // normalized 0..1
  color: string;
  accent: string;
}

export interface Island25DWorldData {
  seed: number;
  arenaWidth: number;
  arenaHeight: number;
  citadelRadius: number;
  regions: IslandBiomeRegion[];
  staticProps: IslandStaticProp[];
  destructibles: IslandDestructibleSpawn[];
  jumpPads: IslandJumpPadSpawn[];
  paths: IslandPathSegment[];
}

export interface YSortableItem {
  id: string | number;
  footY: number;
  x?: number;
}

export interface CameraFocusInput {
  playerX: number;
  playerY: number;
  playerZ: number;
  isAiming: boolean;
  aimAngle: number;
  velX: number;
  velY: number;
  maxSpeed: number;
  isDashing: boolean;
  isJumpPadAirborne: boolean;
  isDropping: boolean;
  currentLookX: number;
  currentLookY: number;
  currentActionZoom: number;
  deltaTime: number;
  reducedMotion: boolean;
}

export interface CameraFocusOutput {
  lookAheadX: number;
  lookAheadY: number;
  targetX: number;
  targetY: number;
  actionZoom: number;
}

// ============================================================================
// DETERMINISTIC SEEDED PRNG (`worldRng`)
// ============================================================================

export function createWorldRng(seed = 20260725): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
// PART A: PURE 2x2 PROP SLICER & RENAMED-JPEG MAGENTA EDGE CLEANUP
// ============================================================================

/**
 * Slices a 2x2 sprite sheet into 4 quadrant rectangles after trimming
 * `outerMargin` pixels (default 20px) from each outer edge of the sheet.
 */
export function compute2x2QuadrantRects(
  sheetWidth: number,
  sheetHeight: number,
  outerMargin = PROP_SHEET_OUTER_MARGIN
): { tl: Rect2D; tr: Rect2D; bl: Rect2D; br: Rect2D } {
  const safeW = Math.max(4, Math.floor(sheetWidth));
  const safeH = Math.max(4, Math.floor(sheetHeight));
  const m = Math.max(0, Math.min(Math.floor(outerMargin), Math.floor(Math.min(safeW, safeH) / 4) - 1));
  const innerW = Math.max(2, safeW - m * 2);
  const innerH = Math.max(2, safeH - m * 2);
  const halfW = Math.floor(innerW / 2);
  const halfH = Math.floor(innerH / 2);
  const remW = innerW - halfW;
  const remH = innerH - halfH;

  return {
    tl: { x: m, y: m, w: halfW, h: halfH },
    tr: { x: m + halfW, y: m, w: remW, h: halfH },
    bl: { x: m, y: m + halfH, w: halfW, h: remH },
    br: { x: m + halfW, y: m + halfH, w: remW, h: remH }
  };
}

/**
 * Exact predicate for bright magenta chroma key background pixels.
 */
export function isBrightMagentaPixel(r: number, g: number, b: number): boolean {
  return r > 120 && b > 85 && r > g * 1.35 && b > g * 1.15;
}

/**
 * Exact predicate for darker purple-magenta baked shadow pixels.
 */
export function isDarkMagentaShadowPixel(r: number, g: number, b: number): boolean {
  return r > 85 && b > 55 && r > g * 1.3 && b > g * 1.1;
}

/**
 * Strips bright magenta background pixels AND darker purple-magenta baked
 * shadow pixels to `alpha = 0`, then performs a 1-pixel edge despill pass on
 * semi-transparent / boundary pixels where `R > G && B > G` to neutralize
 * JPEG pink fringe into clean dark outline pixels.
 *
 * Mutates `data` in-place and returns summary stats for verification/testing.
 */
export function stripMagentaAndDespillRGBA(
  data: Uint8ClampedArray,
  width: number,
  height: number
): { strippedCount: number; despilledCount: number } {
  const pixelCount = width * height;
  const cleared = new Uint8Array(pixelCount);
  let strippedCount = 0;
  let despilledCount = 0;

  // Pass 1: Chroma strip bright magenta & darker purple-magenta baked shadows
  for (let p = 0; p < pixelCount; p++) {
    const i = p * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];

    if (a < 16) {
      data[i + 3] = 0;
      cleared[p] = 1;
      continue;
    }

    if (isBrightMagentaPixel(r, g, b) || isDarkMagentaShadowPixel(r, g, b)) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 0;
      cleared[p] = 1;
      strippedCount++;
    }
  }

  // Pass 2: 1-pixel edge despill on boundary & semi-transparent pixels (R > G && B > G)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (cleared[p]) continue;

      const i = p * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];

      if (!(r > g && b > g)) continue;

      let touchesCleared = a < 248;
      if (!touchesCleared) {
        outer: for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
          for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
            if (nx === x && ny === y) continue;
            if (cleared[ny * width + nx]) {
              touchesCleared = true;
              break outer;
            }
          }
        }
      }

      if (!touchesCleared) continue;

      // Neutralize pink fringe into clean dark outline pixels
      const pinkExcess = (r + b) * 0.5 - g;
      const outlineLum = Math.max(12, Math.min(54, Math.round(g * 0.52)));
      const blend = Math.min(1, Math.max(0.45, pinkExcess / 60));

      const neutralR = Math.min(r, g);
      const neutralB = Math.min(b, g);

      data[i] = Math.round(neutralR * (1 - blend) + outlineLum * blend);
      data[i + 1] = Math.round(g * (1 - blend) + outlineLum * blend);
      data[i + 2] = Math.round(neutralB * (1 - blend) + outlineLum * blend);
      if (a < 180 && pinkExcess > 24) {
        data[i + 3] = Math.round(a * 0.78);
      }
      despilledCount++;
    }
  }

  return { strippedCount, despilledCount };
}

/**
 * Auto-trims transparent padding from an RGBA buffer and computes the
 * sprite's bottom-center foot anchor (`anchorX`, `anchorY`) relative to the
 * trimmed bounding box.
 */
export function computeTrimAndFootAnchor(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  alphaThreshold = 16
): TrimAndAnchorResult {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let opaqueCount = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = data[(y * width + x) * 4 + 3];
      if (a >= alphaThreshold) {
        opaqueCount++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (opaqueCount === 0 || maxX < minX || maxY < minY) {
    return {
      trimX: 0,
      trimY: 0,
      trimW: Math.max(1, width),
      trimH: Math.max(1, height),
      anchorX: width * 0.5,
      anchorY: Math.max(0, height - 1),
      opaqueCount: 0
    };
  }

  const trimX = minX;
  const trimY = minY;
  const trimW = maxX - minX + 1;
  const trimH = maxY - minY + 1;

  // Compute foot-center X across the bottom 12% opaque band (falls back to trimW / 2)
  const footBandStart = Math.max(minY, maxY - Math.max(2, Math.floor(trimH * 0.12)));
  let footSumX = 0;
  let footWeight = 0;
  for (let y = footBandStart; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const a = data[(y * width + x) * 4 + 3];
      if (a >= alphaThreshold) {
        footSumX += (x - trimX) * a;
        footWeight += a;
      }
    }
  }

  const anchorX = footWeight > 0 ? footSumX / footWeight : trimW * 0.5;
  const anchorY = trimH - 1;

  return {
    trimX,
    trimY,
    trimW,
    trimH,
    anchorX,
    anchorY,
    opaqueCount
  };
}

// ============================================================================
// PART C: 45° OBLIQUE CAMERA PROJECTION, REVERSE-TILT AIM & DYNAMIC FOCUS
// ============================================================================

/**
 * Projects world coordinates `(wx, wy, wz)` into screen space under the
 * 45-degree oblique ground tilt (`tiltY = 0.72`) with true Z-height lift.
 */
export function worldToScreen25D(
  wx: number,
  wy: number,
  wz: number,
  camX: number,
  camY: number,
  zoom: number,
  focalX: number,
  focalY: number,
  tiltY = TILT_Y_SCALE
): { sx: number; sy: number } {
  const safeZoom = Math.max(0.001, zoom);
  return {
    sx: focalX + (wx - camX) * safeZoom,
    sy: focalY + (wy - camY) * safeZoom * tiltY - (wz || 0) * safeZoom
  };
}

/**
 * Reverses the `0.72` vertical tilt factor in screen-to-world pointer conversion
 * so ground clicks, drag-to-aim trajectories, and movement remain pinpoint accurate.
 */
export function screenToWorld25D(
  sx: number,
  sy: number,
  camX: number,
  camY: number,
  zoom: number,
  focalX: number,
  focalY: number,
  tiltY = TILT_Y_SCALE
): { wx: number; wy: number } {
  const safeZoom = Math.max(0.001, zoom);
  const safeTilt = Math.max(0.05, tiltY);
  return {
    wx: camX + (sx - focalX) / safeZoom,
    wy: camY + (sy - focalY) / (safeZoom * safeTilt)
  };
}

/**
 * Computes exact true-world aim angle from a screen pointer `(clientX, clientY)`
 * relative to a player at `(playerX, playerY, playerZ)`, reversing the `0.72`
 * vertical ground tilt factor.
 */
export function computeAimAngleFromPointer25D(
  clientX: number,
  clientY: number,
  playerX: number,
  playerY: number,
  playerZ: number,
  camX: number,
  camY: number,
  zoom: number,
  focalX: number,
  focalY: number,
  tiltY = TILT_Y_SCALE
): { valid: boolean; angle: number; worldDX: number; worldDY: number } {
  const safeZoom = Math.max(0.001, zoom);
  const safeTilt = Math.max(0.05, tiltY);
  const playerScreen = worldToScreen25D(playerX, playerY, playerZ, camX, camY, safeZoom, focalX, focalY, safeTilt);
  const worldDX = (clientX - playerScreen.sx) / safeZoom;
  const worldDY = (clientY - playerScreen.sy) / (safeZoom * safeTilt);
  if (Math.abs(worldDX) + Math.abs(worldDY) < 2) {
    return { valid: false, angle: 0, worldDX, worldDY };
  }
  return {
    valid: true,
    angle: Math.atan2(worldDY, worldDX),
    worldDX,
    worldDY
  };
}

/**
 * Computes smooth dynamic camera focus:
 *  - Lerps up to `55u` toward active aim vector (or sprint velocity vector when not aiming)
 *  - Smoothly zooms out to `0.92x` during dashes and Jump Pad launches
 *  - Respects `reducedMotion` (reduces/suppresses abrupt camera zoom shifts)
 */
export function computeCameraFocusTarget(input: CameraFocusInput): CameraFocusOutput {
  const dt = Math.max(0, Math.min(0.1, input.deltaTime || 0));

  let desiredLookX = 0;
  let desiredLookY = 0;

  if (!input.isDropping) {
    if (input.isAiming) {
      desiredLookX = Math.cos(input.aimAngle) * CAMERA_LOOKAHEAD_MAX;
      desiredLookY = Math.sin(input.aimAngle) * CAMERA_LOOKAHEAD_MAX;
    } else {
      const speed = Math.hypot(input.velX || 0, input.velY || 0);
      const refSpeed = Math.max(80, input.maxSpeed || 240);
      if (speed > 28) {
        const mag = Math.min(1, speed / refSpeed) * CAMERA_LOOKAHEAD_MAX;
        desiredLookX = (input.velX / speed) * mag;
        desiredLookY = (input.velY / speed) * mag;
      }
    }
  }

  // Clamp strictly within CAMERA_LOOKAHEAD_MAX (55u)
  const desiredMag = Math.hypot(desiredLookX, desiredLookY);
  if (desiredMag > CAMERA_LOOKAHEAD_MAX) {
    const s = CAMERA_LOOKAHEAD_MAX / desiredMag;
    desiredLookX *= s;
    desiredLookY *= s;
  }

  const lookBlend = 1 - Math.exp(-(input.reducedMotion ? 3.5 : 6.2) * dt);
  const lookAheadX = input.currentLookX + (desiredLookX - input.currentLookX) * lookBlend;
  const lookAheadY = input.currentLookY + (desiredLookY - input.currentLookY) * lookBlend;

  const wantsActionZoom = !input.reducedMotion && !input.isDropping && (input.isDashing || input.isJumpPadAirborne);
  const targetActionZoom = wantsActionZoom ? CAMERA_ACTION_ZOOM : 1.0;
  const zoomRate = wantsActionZoom ? 7.5 : 4.2;
  const zoomBlend = 1 - Math.exp(-zoomRate * dt);
  const actionZoom = input.currentActionZoom + (targetActionZoom - input.currentActionZoom) * zoomBlend;

  const targetX = input.playerX + lookAheadX;
  const targetY = input.isDropping
    ? input.playerY - (input.playerZ || 0) * INV_TILT_Y_SCALE
    : input.playerY + lookAheadY;

  return {
    lookAheadX,
    lookAheadY,
    targetX,
    targetY,
    actionZoom
  };
}

/**
 * Computes grounded contact shadow scale and opacity for a given Z altitude.
 * Shadow stays locked at `(x, y)` on the tilted ground while shrinking smoothly
 * as the fighter rises during Jump Pad launches or initial sky-drop descent.
 */
export function computeShadowMetricsForZ(zHeight: number): { scale: number; alpha: number } {
  const z = Math.max(0, zHeight || 0);
  const scale = Math.max(0.32, 1.0 - z / 320);
  const alpha = Math.max(0.10, 0.34 * Math.max(0.35, 1.0 - z / 420));
  return { scale, alpha };
}

/**
 * Checks whether a target point is within the `520u` true unscaled world vision cap.
 */
export function isWithinWorldVisionCap(
  observerX: number,
  observerY: number,
  targetX: number,
  targetY: number,
  visionRadius = WORLD_VISION_CAP
): boolean {
  const dx = targetX - observerX;
  const dy = targetY - observerY;
  return dx * dx + dy * dy <= visionRadius * visionRadius;
}

// ============================================================================
// PART B: 4-BIOME ISLAND CLASSIFIER, DETERMINISTIC WORLD GEN & Y-SORTER
// ============================================================================

export function classifyIslandBiome(
  x: number,
  y: number,
  arenaWidth = 20000,
  arenaHeight = 20000
): IslandBiomeId {
  const cx = arenaWidth * 0.5;
  const cy = arenaHeight * 0.5;
  const dx = x - cx;
  const dy = y - cy;
  const citadelRadius = Math.min(arenaWidth, arenaHeight) * 0.21;

  // Center: Arcane Citadel (octagonal-ish soft organic radius)
  const angle = Math.atan2(dy, dx);
  const organicRim = citadelRadius * (1 + 0.045 * Math.cos(angle * 4));
  if (dx * dx + dy * dy <= organicRim * organicRim) {
    return 'CITADEL';
  }

  // Organic wave seam between North/South and West/East quadrants
  const seamX = cx + Math.sin(y * 0.00045) * 650;
  const seamY = cy + Math.cos(x * 0.00045) * 650;

  // Whispering Grove: West / Northwest (and upper-southwest edge)
  if (x < seamX && y < seamY + 1100) {
    return 'GROVE';
  }

  // Obsidian Forge: East / Northeast
  if (x >= seamX && y < seamY + 300) {
    return 'OBSIDIAN';
  }

  // Tidal Ruins: South / Southeast (plus coastal south ruins)
  return 'TIDAL';
}

export function getBiomeTileKey(biome: IslandBiomeId): BiomeTileKey {
  switch (biome) {
    case 'CITADEL':
      return 'tile_citadel';
    case 'GROVE':
      return 'tile_grove';
    case 'OBSIDIAN':
      return 'tile_obsidian';
    case 'TIDAL':
      return 'tile_tidal';
  }
}

export function getBiomeDisplayName(biome: IslandBiomeId): string {
  switch (biome) {
    case 'CITADEL':
      return 'Arcane Citadel';
    case 'GROVE':
      return 'Whispering Grove';
    case 'OBSIDIAN':
      return 'Obsidian Forge';
    case 'TIDAL':
      return 'Tidal Ruins';
  }
}

/**
 * Stable ascending Y-sort by bottom foot Y coordinate (`footY`) so characters
 * walk cleanly both in front of and behind pillars, walls, trees, and obelisks.
 */
export function sortRenderablesByFootY<T extends YSortableItem>(items: T[]): T[] {
  return items.sort((a, b) => {
    if (a.footY !== b.footY) return a.footY - b.footY;
    const ax = a.x ?? 0;
    const bx = b.x ?? 0;
    if (ax !== bx) return ax - bx;
    return String(a.id).localeCompare(String(b.id));
  });
}

/**
 * Generates the complete hand-crafted 4-biome 2.5D island layout using
 * deterministic seeded placement (`worldRng`).
 */
export function generateIsland25DWorld(
  arenaWidth = 20000,
  arenaHeight = 20000,
  seed = 20260725
): Island25DWorldData {
  const rng = createWorldRng(seed);
  const cx = arenaWidth * 0.5;
  const cy = arenaHeight * 0.5;
  const citadelRadius = Math.min(arenaWidth, arenaHeight) * 0.21;

  const regions: IslandBiomeRegion[] = [
    { id: 'CITADEL', name: 'Arcane Citadel', x: 0.5, y: 0.5, color: '#c8b48c', accent: '#fbbf24' },
    { id: 'GROVE', name: 'Whispering Grove', x: 0.23, y: 0.28, color: '#2d6a4f', accent: '#4ade80' },
    { id: 'OBSIDIAN', name: 'Obsidian Forge', x: 0.77, y: 0.26, color: '#3b1f2b', accent: '#f97316' },
    { id: 'TIDAL', name: 'Tidal Ruins', x: 0.56, y: 0.79, color: '#1b4965', accent: '#22d3ee' }
  ];

  // Jump Pads: central Citadel ring + Tidal Ruins flanking pads + Grove/Obsidian overlooks
  const jumpPads: IslandJumpPadSpawn[] = [
    { id: 'JP_CITADEL_N', biome: 'CITADEL', x: cx, y: cy - 1650, radius: 42, label: 'Citadel North Pad', pulseOffset: 0.0 },
    { id: 'JP_CITADEL_S', biome: 'CITADEL', x: cx, y: cy + 1650, radius: 42, label: 'Citadel South Pad', pulseOffset: 1.1 },
    { id: 'JP_CITADEL_W', biome: 'CITADEL', x: cx - 1650, y: cy, radius: 42, label: 'Citadel West Pad', pulseOffset: 2.2 },
    { id: 'JP_CITADEL_E', biome: 'CITADEL', x: cx + 1650, y: cy, radius: 42, label: 'Citadel East Pad', pulseOffset: 3.3 },
    { id: 'JP_GROVE_NW', biome: 'GROVE', x: 4800, y: 5200, radius: 42, label: 'Grove Canopy Pad', pulseOffset: 4.4 },
    { id: 'JP_OBSIDIAN_NE', biome: 'OBSIDIAN', x: 15200, y: 5100, radius: 42, label: 'Forge Spire Pad', pulseOffset: 5.5 },
    { id: 'JP_TIDAL_SW', biome: 'TIDAL', x: 6200, y: 15200, radius: 42, label: 'Tidal West Flank', pulseOffset: 6.6 },
    { id: 'JP_TIDAL_SE', biome: 'TIDAL', x: 14600, y: 15000, radius: 42, label: 'Tidal East Flank', pulseOffset: 7.7 }
  ];

  // Winding stone pathways, Tidal glowing channels & Forge magma fissures
  const paths: IslandPathSegment[] = [
    // Whispering Grove winding stone pathways into Citadel West gate
    { x1: 1800, y1: 3200, x2: 4400, y2: 5200, width: 220, biome: 'GROVE', kind: 'stone_path' },
    { x1: 4400, y1: 5200, x2: 6400, y2: 7600, width: 210, biome: 'GROVE', kind: 'stone_path' },
    { x1: 6400, y1: 7600, x2: 8000, y2: 9600, width: 230, biome: 'GROVE', kind: 'stone_path' },
    { x1: 2200, y1: 9400, x2: 5600, y2: 9800, width: 190, biome: 'GROVE', kind: 'stone_path' },
    { x1: 5600, y1: 9800, x2: 7800, y2: 10000, width: 210, biome: 'GROVE', kind: 'stone_path' },
    // Obsidian Forge magma veins & basalt bridge roads
    { x1: 12200, y1: 9800, x2: 15200, y2: 7800, width: 190, biome: 'OBSIDIAN', kind: 'magma_vein' },
    { x1: 15200, y1: 7800, x2: 17800, y2: 4600, width: 170, biome: 'OBSIDIAN', kind: 'magma_vein' },
    { x1: 13200, y1: 3200, x2: 15400, y2: 5800, width: 165, biome: 'OBSIDIAN', kind: 'magma_vein' },
    // Tidal Ruins glowing cyan cobblestone channels
    { x1: 10000, y1: 13400, x2: 10000, y2: 18200, width: 240, biome: 'TIDAL', kind: 'tidal_channel' },
    { x1: 5800, y1: 15600, x2: 10000, y2: 15200, width: 200, biome: 'TIDAL', kind: 'tidal_channel' },
    { x1: 10000, y1: 15200, x2: 15200, y2: 15600, width: 200, biome: 'TIDAL', kind: 'tidal_channel' },
    { x1: 13400, y1: 12600, x2: 16600, y2: 16800, width: 180, biome: 'TIDAL', kind: 'tidal_channel' }
  ];

  const staticProps: IslandStaticProp[] = [];
  const destructibles: IslandDestructibleSpawn[] = [];

  const isClearOfSpecials = (x: number, y: number, minGap: number): boolean => {
    if (x < 680 || x > arenaWidth - 680 || y < 680 || y > arenaHeight - 680) return false;
    // Keep exact center spawn sanctuary open (420u radius)
    if (Math.hypot(x - cx, y - cy) < 420) return false;
    for (let i = 0; i < jumpPads.length; i++) {
      if (Math.hypot(x - jumpPads[i].x, y - jumpPads[i].y) < 230) return false;
    }
    for (let i = 0; i < staticProps.length; i++) {
      const p = staticProps[i];
      if (Math.hypot(x - p.x, y - p.y) < minGap + p.collisionRadius) return false;
    }
    for (let i = 0; i < destructibles.length; i++) {
      const d = destructibles[i];
      if (Math.hypot(x - d.x, y - d.y) < Math.max(110, minGap * 0.72)) return false;
    }
    return true;
  };

  let propSeq = 1;
  const pushStatic = (
    spriteKey: IslandStaticProp['spriteKey'],
    biome: IslandBiomeId,
    x: number,
    y: number,
    drawScale = 1.0,
    flipX = false
  ) => {
    const specMap: Record<
      IslandStaticProp['spriteKey'],
      { r: number; sx: number; sy: number; zh: number }
    > = {
      pillar: { r: 28, sx: 36, sy: 18, zh: 76 },
      wall: { r: 44, sx: 58, sy: 24, zh: 68 },
      obelisk: { r: 30, sx: 38, sy: 19, zh: 96 },
      tree: { r: 32, sx: 50, sy: 24, zh: 112 },
      boulder: { r: 36, sx: 46, sy: 22, zh: 58 }
    };
    const sp = specMap[spriteKey];
    staticProps.push({
      id: `prop_${propSeq++}`,
      spriteKey,
      biome,
      x: Math.round(x),
      y: Math.round(y),
      footY: Math.round(y),
      collisionRadius: Math.round(sp.r * drawScale),
      drawScale,
      shadowRx: Math.round(sp.sx * drawScale),
      shadowRy: Math.round(sp.sy * drawScale),
      zHeight: Math.round(sp.zh * drawScale),
      flipX
    });
  };

  let destSeq = 1;
  const pushDestructible = (
    kind: IslandDestructibleSpawn['kind'],
    spriteKey: IslandDestructibleSpawn['spriteKey'],
    biome: IslandBiomeId,
    x: number,
    y: number,
    drawScale = 1.0
  ) => {
    const radius = kind === 'CRYSTAL_PILLAR' ? 28 : kind === 'BARREL' ? 20 : 22;
    const maxHp = kind === 'CRYSTAL_PILLAR' ? 110 : kind === 'BARREL' ? 35 : 45;
    destructibles.push({
      id: `dest_${destSeq++}`,
      kind,
      spriteKey,
      biome,
      x: Math.round(x),
      y: Math.round(y),
      radius,
      maxHp,
      drawScale
    });
  };

  // 1. ARCANE CITADEL (Center) — Hand-crafted concentric colonnades, stepped walls & alcove chests
  const sanctuaryRingR = 620;
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const px = cx + Math.cos(ang) * sanctuaryRingR;
    const py = cy + Math.sin(ang) * sanctuaryRingR;
    pushStatic(i % 2 === 0 ? 'pillar' : 'wall', 'CITADEL', px, py, 1.0, i % 2 === 1);
  }
  const innerRingR = 1120;
  for (let i = 0; i < 10; i++) {
    const ang = (i / 10) * Math.PI * 2 + Math.PI / 10;
    const px = cx + Math.cos(ang) * innerRingR;
    const py = cy + Math.sin(ang) * innerRingR;
    if (isClearOfSpecials(px, py, 210)) {
      pushStatic(i % 3 === 0 ? 'wall' : 'pillar', 'CITADEL', px, py, 1.08, i % 2 === 1);
    }
  }
  const midWallR = 2350;
  for (let i = 0; i < 14; i++) {
    if (i % 4 === 0) continue; // Keep cardinal gates wide open
    const ang = (i / 14) * Math.PI * 2;
    const wx = cx + Math.cos(ang) * midWallR;
    const wy = cy + Math.sin(ang) * midWallR;
    if (isClearOfSpecials(wx, wy, 220)) {
      pushStatic(i % 2 === 0 ? 'wall' : 'pillar', 'CITADEL', wx, wy, 1.05, i % 2 === 1);
    }
  }
  const outerCitadelR = 3450;
  for (let i = 0; i < 18; i++) {
    if (i % 4 === 0) continue;
    const ang = (i / 18) * Math.PI * 2 + 0.1;
    const px = cx + Math.cos(ang) * outerCitadelR;
    const py = cy + Math.sin(ang) * outerCitadelR;
    if (isClearOfSpecials(px, py, 220)) {
      pushStatic(i % 3 === 0 ? 'wall' : 'pillar', 'CITADEL', px, py, 0.96 + rng() * 0.18, rng() > 0.5);
    }
  }
  // Citadel alcove chests (including near inner courtyard for instant early-game loot sightlines)
  for (let i = 0; i < 12; i++) {
    const ang = (i / 12) * Math.PI * 2 + 0.25;
    const r = i < 4 ? 760 : (1450 + (i % 2) * 1400);
    const tx = cx + Math.cos(ang) * r;
    const ty = cy + Math.sin(ang) * r;
    if (isClearOfSpecials(tx, ty, 140)) {
      pushDestructible('CRATE', 'chest', 'CITADEL', tx, ty, 1.0);
    }
  }

  // 2. WHISPERING GROVE (West / Northwest) — Dense fantasy trees & crystal boulders
  for (let attempt = 0; attempt < 260 && staticProps.length < 135; attempt++) {
    const x = 900 + rng() * 8800;
    const y = 900 + rng() * 10400;
    if (classifyIslandBiome(x, y, arenaWidth, arenaHeight) !== 'GROVE') continue;
    if (!isClearOfSpecials(x, y, 275)) continue;
    const isTree = rng() < 0.72;
    pushStatic(isTree ? 'tree' : 'boulder', 'GROVE', x, y, 0.92 + rng() * 0.32, rng() > 0.5);
  }
  for (let attempt = 0; attempt < 45 && destructibles.length < 22; attempt++) {
    const x = 1200 + rng() * 8200;
    const y = 1200 + rng() * 9800;
    if (classifyIslandBiome(x, y, arenaWidth, arenaHeight) !== 'GROVE') continue;
    if (!isClearOfSpecials(x, y, 200)) continue;
    const kind = rng() < 0.65 ? 'CRATE' : 'CRYSTAL_PILLAR';
    pushDestructible(kind, kind === 'CRATE' ? 'chest' : 'boulder', 'GROVE', x, y, 1.0);
  }

  // 3. OBSIDIAN FORGE (East / Northeast) — Crystal rock cover, forge walls, explosive red barrels & high-tier chests
  for (let attempt = 0; attempt < 220 && staticProps.length < 195; attempt++) {
    const x = 10400 + rng() * 8700;
    const y = 900 + rng() * 9600;
    if (classifyIslandBiome(x, y, arenaWidth, arenaHeight) !== 'OBSIDIAN') continue;
    if (!isClearOfSpecials(x, y, 290)) continue;
    const roll = rng();
    const key: IslandStaticProp['spriteKey'] = roll < 0.52 ? 'boulder' : roll < 0.82 ? 'wall' : 'pillar';
    pushStatic(key, 'OBSIDIAN', x, y, 0.94 + rng() * 0.28, rng() > 0.5);
  }
  // Explosive red barrel clusters + high-tier loot chests in Obsidian Forge
  for (let attempt = 0; attempt < 95 && destructibles.length < 44; attempt++) {
    const x = 10800 + rng() * 8000;
    const y = 1200 + rng() * 8800;
    if (classifyIslandBiome(x, y, arenaWidth, arenaHeight) !== 'OBSIDIAN') continue;
    if (!isClearOfSpecials(x, y, 190)) continue;
    const roll = rng();
    if (roll < 0.58) {
      pushDestructible('BARREL', 'barrel', 'OBSIDIAN', x, y, 1.05);
      // Occasional twin chain-reaction barrel nearby!
      if (rng() < 0.4 && destructibles.length < 44) {
        const bx2 = x + (rng() > 0.5 ? 78 : -78);
        const by2 = y + (rng() - 0.5) * 64;
        if (isClearOfSpecials(bx2, by2, 70)) {
          pushDestructible('BARREL', 'barrel', 'OBSIDIAN', bx2, by2, 1.0);
        }
      }
    } else if (roll < 0.85) {
      pushDestructible('CRATE', 'chest', 'OBSIDIAN', x, y, 1.06);
    } else {
      pushDestructible('CRYSTAL_PILLAR', 'boulder', 'OBSIDIAN', x, y, 1.0);
    }
  }

  // 4. TIDAL RUINS (South / Southeast) — Cyan arcane obelisks, ancient pillars & ruined walls
  for (let attempt = 0; attempt < 240 && staticProps.length < 258; attempt++) {
    const x = 1000 + rng() * 18000;
    const y = 10600 + rng() * 8400;
    if (classifyIslandBiome(x, y, arenaWidth, arenaHeight) !== 'TIDAL') continue;
    if (!isClearOfSpecials(x, y, 285)) continue;
    const roll = rng();
    const key: IslandStaticProp['spriteKey'] = roll < 0.45 ? 'obelisk' : roll < 0.78 ? 'pillar' : 'wall';
    pushStatic(key, 'TIDAL', x, y, 0.95 + rng() * 0.28, rng() > 0.5);
  }
  for (let attempt = 0; attempt < 60 && destructibles.length < 54; attempt++) {
    const x = 1400 + rng() * 17200;
    const y = 11000 + rng() * 7800;
    if (classifyIslandBiome(x, y, arenaWidth, arenaHeight) !== 'TIDAL') continue;
    if (!isClearOfSpecials(x, y, 200)) continue;
    const roll = rng();
    if (roll < 0.45) {
      pushDestructible('CRATE', 'chest', 'TIDAL', x, y, 1.0);
    } else if (roll < 0.75) {
      pushDestructible('BARREL', 'barrel', 'TIDAL', x, y, 1.0);
    } else {
      pushDestructible('CRYSTAL_PILLAR', 'obelisk', 'TIDAL', x, y, 0.92);
    }
  }

  return {
    seed,
    arenaWidth,
    arenaHeight,
    citadelRadius,
    regions,
    staticProps,
    destructibles,
    jumpPads,
    paths
  };
}

// ============================================================================
// BROWSER CANVAS SLICER + HIGH-CRAFT PROCEDURAL FALLBACK GENERATORS
// ============================================================================

function makeOffscreenCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/**
 * Slices a loaded 2x2 prop sheet (`props_structures.png` or `props_nature_loot.png`)
 * into 4 cleaned, despilled, auto-trimmed, foot-anchored sprite canvases.
 */
export function slicePropSheet2x2(
  img: HTMLImageElement | HTMLCanvasElement,
  sheetKey: 'props_structures' | 'props_nature_loot',
  outerMargin = PROP_SHEET_OUTER_MARGIN
): Partial<Record<PropSpriteKey, SlicedPropSprite>> {
  const srcW = (img as HTMLImageElement).naturalWidth || img.width || 0;
  const srcH = (img as HTMLImageElement).naturalHeight || img.height || 0;
  if (srcW < 64 || srcH < 64) return {};

  const rects = compute2x2QuadrantRects(srcW, srcH, outerMargin);
  const map = PROP_SHEET_QUADRANTS[sheetKey];
  const entries: Array<[PropSpriteKey, Rect2D]> = [
    [map.tl, rects.tl],
    [map.tr, rects.tr],
    [map.bl, rects.bl],
    [map.br, rects.br]
  ];

  const results: Partial<Record<PropSpriteKey, SlicedPropSprite>> = {};

  for (const [propKey, rect] of entries) {
    const work = makeOffscreenCanvas(rect.w, rect.h);
    const wctx = work.getContext('2d', { willReadFrequently: true });
    if (!wctx) continue;

    wctx.clearRect(0, 0, rect.w, rect.h);
    wctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);

    try {
      const imgData = wctx.getImageData(0, 0, rect.w, rect.h);
      stripMagentaAndDespillRGBA(imgData.data, rect.w, rect.h);
      wctx.putImageData(imgData, 0, 0);

      const trim = computeTrimAndFootAnchor(imgData.data, rect.w, rect.h, 16);
      if (trim.opaqueCount < 24) continue;

      const out = makeOffscreenCanvas(trim.trimW, trim.trimH);
      const octx = out.getContext('2d');
      if (!octx) continue;
      octx.drawImage(
        work,
        trim.trimX,
        trim.trimY,
        trim.trimW,
        trim.trimH,
        0,
        0,
        trim.trimW,
        trim.trimH
      );

      results[propKey] = {
        key: propKey,
        canvas: out,
        width: trim.trimW,
        height: trim.trimH,
        anchorX: trim.anchorX,
        anchorY: trim.anchorY,
        source: 'sheet'
      };
    } catch {
      // Cross-origin tainted canvas fallback handled cleanly by caller
      continue;
    }
  }

  return results;
}

/**
 * Generates seamless 256x256 hand-painted procedural fallback tiles for all 4 biomes
 * when `./assets/Image/tile_*.png` files are not present locally.
 */
export function createProceduralBiomeTiles(): Record<BiomeTileKey, HTMLCanvasElement> {
  const S = 256;

  // 1. Arcane Citadel — 100% seamless warm sandstone-ivory courtyard flagstones (zero tile border seams)
  const citadel = makeOffscreenCanvas(S, S);
  {
    const ctx = citadel.getContext('2d')!;
    const rng = createWorldRng(101);
    ctx.fillStyle = '#6c6252';
    ctx.fillRect(0, 0, S, S);
    const tile = 64;
    for (let gy = 0; gy < 4; gy++) {
      for (let gx = 0; gx < 4; gx++) {
        const ox = gx * tile + (gy % 2 === 1 ? 32 : 0);
        const oy = gy * tile;
        const shade = Math.round((rng() - 0.5) * 14);
        const drawFlagstone = (x: number, y: number) => {
          ctx.fillStyle = `rgb(${154 + shade}, ${142 + shade}, ${120 + shade})`;
          ctx.fillRect(x + 2, y + 2, tile - 4, tile - 4);
          ctx.fillStyle = 'rgba(255, 248, 230, 0.16)';
          ctx.fillRect(x + 3, y + 3, tile - 6, 3);
          ctx.fillStyle = 'rgba(38, 31, 22, 0.22)';
          ctx.fillRect(x + 3, y + tile - 5, tile - 6, 3);
        };
        drawFlagstone(ox % S, oy);
        if (ox + tile > S) drawFlagstone((ox % S) - S, oy);
      }
    }
    // Fine weathered stone speckles (wrapped seamlessly)
    for (let i = 0; i < 160; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(255,244,214,0.12)' : 'rgba(28,22,16,0.14)';
      ctx.fillRect(rng() * S, rng() * S, 2 + rng() * 3, 2);
    }
  }

  // 2. Whispering Grove — 100% seamless emerald-moss woodland turf with wrapped dappled canopy circles
  const grove = makeOffscreenCanvas(S, S);
  {
    const ctx = grove.getContext('2d')!;
    const rng = createWorldRng(202);
    ctx.fillStyle = '#244d38';
    ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 36; i++) {
      const px = rng() * S;
      const py = rng() * S;
      const r = 16 + rng() * 26;
      const col = rng() > 0.45 ? 'rgba(49, 108, 72, 0.30)' : 'rgba(22, 56, 39, 0.32)';
      ctx.fillStyle = col;
      // Wrap across all 9 toroidal offsets so tile edges have ZERO seams
      for (const ox of [-S, 0, S]) {
        for (const oy of [-S, 0, S]) {
          if (px + ox + r < 0 || px + ox - r > S || py + oy + r < 0 || py + oy - r > S) continue;
          ctx.beginPath();
          ctx.arc(px + ox, py + oy, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    // Painterly grass tufts
    ctx.lineCap = 'round';
    for (let i = 0; i < 110; i++) {
      const gx = 8 + rng() * (S - 16);
      const gy = 10 + rng() * (S - 16);
      ctx.strokeStyle = rng() > 0.4 ? 'rgba(94, 178, 110, 0.52)' : 'rgba(134, 214, 138, 0.36)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.lineTo(gx - 3, gy - 7);
      ctx.moveTo(gx, gy);
      ctx.lineTo(gx + 3, gy - 6);
      ctx.stroke();
    }
    for (let i = 0; i < 18; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(187, 247, 208, 0.52)' : 'rgba(253, 224, 71, 0.44)';
      ctx.beginPath();
      ctx.arc(6 + rng() * (S - 12), 6 + rng() * (S - 12), 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 3. Obsidian Forge — fractured volcanic basalt slabs with glowing magma fissures
  const obsidian = makeOffscreenCanvas(S, S);
  {
    const ctx = obsidian.getContext('2d')!;
    const rng = createWorldRng(303);
    ctx.fillStyle = '#1b161e';
    ctx.fillRect(0, 0, S, S);
    // Volcanic plates
    for (let i = 0; i < 28; i++) {
      const x = rng() * S;
      const y = rng() * S;
      const w = 26 + rng() * 44;
      const h = 22 + rng() * 38;
      ctx.fillStyle = rng() > 0.5 ? 'rgba(42, 34, 48, 0.65)' : 'rgba(22, 18, 28, 0.72)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(84, 68, 92, 0.25)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, h);
    }
    // Glowing magma-orange cracks
    ctx.lineCap = 'round';
    const cracks = [
      [[0, 62], [68, 96], [142, 82], [210, 128], [256, 62]],
      [[84, 0], [108, 86], [142, 168], [116, 256]],
      [[192, 0], [174, 72], [220, 182], [192, 256]]
    ];
    for (const pts of cracks) {
      ctx.strokeStyle = 'rgba(234, 88, 12, 0.45)';
      ctx.lineWidth = 6;
      ctx.beginPath();
      pts.forEach(([x, y], idx) => (idx === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.stroke();

      ctx.strokeStyle = 'rgba(251, 146, 60, 0.78)';
      ctx.lineWidth = 2.4;
      ctx.stroke();

      ctx.strokeStyle = 'rgba(254, 240, 138, 0.65)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // 4. Tidal Ruins — weathered sea-slate cobblestones with glowing cyan rune channels
  const tidal = makeOffscreenCanvas(S, S);
  {
    const ctx = tidal.getContext('2d')!;
    const rng = createWorldRng(404);
    ctx.fillStyle = '#153146';
    ctx.fillRect(0, 0, S, S);
    const step = 32;
    for (let gy = 0; gy < 8; gy++) {
      for (let gx = 0; gx < 8; gx++) {
        const ox = gx * step + (gy % 2 === 1 ? 16 : 0);
        const oy = gy * step;
        const drawCobble = (x: number, y: number) => {
          const s = Math.round((rng() - 0.5) * 18);
          ctx.fillStyle = `rgb(${38 + s}, ${76 + s}, ${104 + s})`;
          ctx.fillRect(x + 2, y + 2, step - 4, step - 4);
          ctx.fillStyle = 'rgba(186, 230, 253, 0.14)';
          ctx.fillRect(x + 3, y + 3, step - 6, 3);
        };
        drawCobble(ox % S, oy);
        if (ox + step > S) drawCobble(ox - S, oy);
      }
    }
    // Glowing cyan water-rune channels
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.34)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(0, 128);
    ctx.lineTo(256, 128);
    ctx.moveTo(128, 0);
    ctx.lineTo(128, 256);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(165, 243, 252, 0.52)';
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  return {
    tile_citadel: citadel,
    tile_grove: grove,
    tile_obsidian: obsidian,
    tile_tidal: tidal
  };
}

/**
 * Generates crisp, painterly upright 2.5D procedural fallback sprites for all 8 props
 * with proper bottom-center foot anchors whenever the 2x2 sheets are unavailable locally.
 */
export function createProceduralPropSprites(): Record<PropSpriteKey, SlicedPropSprite> {
  const wrap = (key: PropSpriteKey, w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): SlicedPropSprite => {
    const canvas = makeOffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d')!;
    draw(ctx);
    return {
      key,
      canvas,
      width: w,
      height: h,
      anchorX: w * 0.5,
      anchorY: h - 4,
      source: 'procedural'
    };
  };

  return {
    pillar: wrap('pillar', 92, 136, (ctx) => {
      // Base plinth
      ctx.fillStyle = '#9e9585';
      ctx.strokeStyle = '#1e1b18';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(14, 108, 64, 24, 5);
      ctx.fill();
      ctx.stroke();
      // Fluted shaft
      const grad = ctx.createLinearGradient(22, 0, 70, 0);
      grad.addColorStop(0, '#efe7d6');
      grad.addColorStop(0.45, '#d5c8b0');
      grad.addColorStop(1, '#857a6b');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(22, 110);
      ctx.lineTo(22, 34);
      ctx.lineTo(36, 18);
      ctx.lineTo(54, 28);
      ctx.lineTo(70, 14);
      ctx.lineTo(70, 110);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // Fluting & gold trim band
      ctx.strokeStyle = 'rgba(72, 62, 50, 0.45)';
      ctx.lineWidth = 2;
      for (const fx of [33, 46, 59]) {
        ctx.beginPath();
        ctx.moveTo(fx, 36);
        ctx.lineTo(fx, 106);
        ctx.stroke();
      }
      ctx.fillStyle = '#d99b38';
      ctx.fillRect(20, 98, 52, 7);
    }),

    wall: wrap('wall', 140, 106, (ctx) => {
      ctx.strokeStyle = '#1b1d24';
      ctx.lineWidth = 3;
      // Stepped battlements
      ctx.fillStyle = '#9aa0ab';
      ctx.beginPath();
      ctx.moveTo(10, 98);
      ctx.lineTo(10, 36);
      ctx.lineTo(34, 36);
      ctx.lineTo(34, 20);
      ctx.lineTo(66, 20);
      ctx.lineTo(66, 36);
      ctx.lineTo(86, 36);
      ctx.lineTo(86, 16);
      ctx.lineTo(118, 16);
      ctx.lineTo(118, 36);
      ctx.lineTo(130, 36);
      ctx.lineTo(130, 98);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // Front face shadow bevel
      ctx.fillStyle = '#606875';
      ctx.fillRect(12, 54, 116, 42);
      // Stone courses & gold trim
      ctx.strokeStyle = 'rgba(20, 24, 32, 0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(12, 74);
      ctx.lineTo(128, 74);
      ctx.moveTo(52, 54);
      ctx.lineTo(52, 74);
      ctx.moveTo(92, 54);
      ctx.lineTo(92, 74);
      ctx.moveTo(34, 74);
      ctx.lineTo(34, 96);
      ctx.moveTo(76, 74);
      ctx.lineTo(76, 96);
      ctx.stroke();
      ctx.fillStyle = '#eab308';
      ctx.fillRect(12, 50, 116, 5);
    }),

    obelisk: wrap('obelisk', 88, 152, (ctx) => {
      // Base pedestal
      ctx.fillStyle = '#28384a';
      ctx.strokeStyle = '#0c1522';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(14, 122, 60, 26, 6);
      ctx.fill();
      ctx.stroke();
      // Tapered obelisk body
      const grad = ctx.createLinearGradient(20, 0, 68, 0);
      grad.addColorStop(0, '#47627d');
      grad.addColorStop(0.5, '#2b4056');
      grad.addColorStop(1, '#162433');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(22, 124);
      ctx.lineTo(29, 32);
      ctx.lineTo(44, 10);
      ctx.lineTo(59, 32);
      ctx.lineTo(66, 124);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // Glowing cyan arcane runes
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(44, 36);
      ctx.lineTo(44, 110);
      ctx.moveTo(36, 56);
      ctx.lineTo(44, 46);
      ctx.lineTo(52, 56);
      ctx.moveTo(35, 82);
      ctx.lineTo(44, 72);
      ctx.lineTo(53, 82);
      ctx.stroke();
      ctx.fillStyle = '#a5f3fc';
      ctx.beginPath();
      ctx.arc(44, 32, 6, 0, Math.PI * 2);
      ctx.fill();
    }),

    jump_pad: wrap('jump_pad', 112, 112, (ctx) => {
      const c = 56;
      ctx.fillStyle = '#1e293b';
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(c, c, 46, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      const grad = ctx.createRadialGradient(c, c, 6, c, c, 36);
      grad.addColorStop(0, '#e0f2fe');
      grad.addColorStop(0.45, '#38bdf8');
      grad.addColorStop(1, 'rgba(14, 116, 144, 0.25)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(c, c, 36, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#67e8f9';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(c, c, 26, 0, Math.PI * 2);
      ctx.stroke();
    }),

    tree: wrap('tree', 132, 158, (ctx) => {
      ctx.strokeStyle = '#142219';
      ctx.lineWidth = 3;
      // Gnarled bark trunk
      ctx.fillStyle = '#5c3c24';
      ctx.beginPath();
      ctx.moveTo(52, 150);
      ctx.lineTo(58, 92);
      ctx.lineTo(74, 92);
      ctx.lineTo(80, 150);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // Multi-tiered lush fantasy foliage canopy
      const clusters: Array<[number, number, number, string]> = [
        [66, 86, 44, '#1b4d34'],
        [40, 78, 30, '#236342'],
        [92, 78, 30, '#194730'],
        [66, 58, 38, '#2d7a4f'],
        [48, 48, 24, '#3fa364'],
        [82, 52, 24, '#297249'],
        [66, 36, 26, '#52be77']
      ];
      for (const [x, y, r, color] of clusters) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#12291c';
        ctx.lineWidth = 2.4;
        ctx.stroke();
      }
      // Sunlit leaf highlights
      ctx.fillStyle = 'rgba(167, 243, 208, 0.34)';
      ctx.beginPath();
      ctx.arc(58, 30, 12, 0, Math.PI * 2);
      ctx.arc(42, 46, 8, 0, Math.PI * 2);
      ctx.fill();
    }),

    boulder: wrap('boulder', 112, 96, (ctx) => {
      ctx.strokeStyle = '#131722';
      ctx.lineWidth = 3;
      // Faceted granite boulder
      ctx.fillStyle = '#4c5568';
      ctx.beginPath();
      ctx.moveTo(14, 88);
      ctx.lineTo(24, 44);
      ctx.lineTo(56, 28);
      ctx.lineTo(90, 42);
      ctx.lineTo(98, 88);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // Lit facet
      ctx.fillStyle = '#6f7b92';
      ctx.beginPath();
      ctx.moveTo(24, 44);
      ctx.lineTo(56, 28);
      ctx.lineTo(64, 60);
      ctx.lineTo(22, 74);
      ctx.closePath();
      ctx.fill();
      // Protruding arcane crystals
      const shards: Array<[number, number, number, number, string]> = [
        [44, 40, 32, 10, '#38bdf8'],
        [58, 36, 62, 8, '#a855f7'],
        [72, 48, 86, 22, '#22d3ee']
      ];
      for (const [bx, by, tx, ty, col] of shards) {
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.moveTo(bx - 7, by + 6);
        ctx.lineTo(tx, ty);
        ctx.lineTo(bx + 7, by + 6);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }),

    chest: wrap('chest', 84, 72, (ctx) => {
      ctx.strokeStyle = '#1c120a';
      ctx.lineWidth = 3;
      // Chest base
      ctx.fillStyle = '#78421b';
      ctx.beginPath();
      ctx.roundRect(10, 30, 64, 36, 6);
      ctx.fill();
      ctx.stroke();
      // Domed lid
      ctx.fillStyle = '#9a5824';
      ctx.beginPath();
      ctx.roundRect(8, 12, 68, 22, [10, 10, 3, 3]);
      ctx.fill();
      ctx.stroke();
      // Gold iron bands & clasp
      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(18, 12, 8, 54);
      ctx.fillRect(58, 12, 8, 54);
      ctx.fillStyle = '#fef08a';
      ctx.strokeStyle = '#78350f';
      ctx.lineWidth = 2;
      ctx.fillRect(35, 26, 14, 16);
      ctx.strokeRect(35, 26, 14, 16);
    }),

    barrel: wrap('barrel', 72, 86, (ctx) => {
      ctx.strokeStyle = '#1f0b0b';
      ctx.lineWidth = 3;
      // Crimson barrel silhouette
      const grad = ctx.createLinearGradient(14, 0, 58, 0);
      grad.addColorStop(0, '#ef4444');
      grad.addColorStop(0.5, '#b91c1c');
      grad.addColorStop(1, '#7f1d1d');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(14, 12, 44, 68, 14);
      ctx.fill();
      ctx.stroke();
      // Top rim ellipse
      ctx.fillStyle = '#dc2626';
      ctx.beginPath();
      ctx.ellipse(36, 16, 20, 7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // Iron hoops
      ctx.fillStyle = '#334155';
      ctx.fillRect(13, 28, 46, 7);
      ctx.fillRect(13, 58, 46, 7);
      // Glowing ember hazard mark
      ctx.fillStyle = '#fde047';
      ctx.beginPath();
      ctx.moveTo(36, 37);
      ctx.lineTo(44, 52);
      ctx.lineTo(28, 52);
      ctx.closePath();
      ctx.fill();
    })
  };
}

// ============================================================================
// BROWSER WINDOW BRIDGE (Used by index.html without Race Conditions)
// ============================================================================

export const Island25DBridge = {
  TILT_Y_SCALE,
  INV_TILT_Y_SCALE,
  PROP_SHEET_OUTER_MARGIN,
  CAMERA_LOOKAHEAD_MAX,
  CAMERA_ACTION_ZOOM,
  PARALLAX_CLOUD_FACTOR,
  CONTACT_SHADOW_RGBA,
  WORLD_VISION_CAP,
  ISLAND_MAP_MANIFEST,
  PROP_SHEET_QUADRANTS,
  createWorldRng,
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
  getBiomeTileKey,
  getBiomeDisplayName,
  sortRenderablesByFootY,
  generateIsland25DWorld,
  slicePropSheet2x2,
  createProceduralBiomeTiles,
  createProceduralPropSprites
};

if (typeof window !== 'undefined') {
  (window as unknown as { __AR_ISLAND_25D__?: typeof Island25DBridge }).__AR_ISLAND_25D__ = Island25DBridge;
  window.dispatchEvent(new CustomEvent('ar:island25d-ready', { detail: Island25DBridge }));
}
