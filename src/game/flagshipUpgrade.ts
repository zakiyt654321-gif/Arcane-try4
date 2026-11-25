// Pure deterministic modules for Arcane Royale Flagship Production Upgrade:
// 1. Zero-Advantage Portrait & Landscape Equal-Area Camera + 520u Vision Cap + Edge Chevrons
// 2. Fixed-Timestep Physics, Impulse Knockback + Wall-Slam Stun, Destructible Props & Biomes
// 3. 120ms Input Buffer & Quadratic Analog Stick Acceleration
// 4. Dual Custom HUD Profiles, Match Telemetry Sanity Validator, CloudSync Fallback & ArcaneBilling IAP

export const BASE_PLAYABLE_WIDTH = 844;
export const BASE_PLAYABLE_HEIGHT = 390;
export const BASE_PLAYABLE_AREA = BASE_PLAYABLE_WIDTH * BASE_PLAYABLE_HEIGHT; // 329,160 sq px
export const PORTRAIT_ARENA_HEIGHT_RATIO = 0.64;
export const PORTRAIT_THUMB_DECK_RATIO = 0.36;

export const VISION_RADIUS = 520;
export const VISION_FADE_RIM = 40;
export const VISION_INNER_RADIUS = VISION_RADIUS - VISION_FADE_RIM; // 480u

export const WALL_SLAM_SPEED_THRESHOLD = 240;
export const WALL_SLAM_STUN_SECONDS = 0.45;
export const INPUT_BUFFER_WINDOW_MS = 120;

export type OrientationPreference = 'auto' | 'landscape' | 'portrait';
export type ActiveOrientation = 'landscape' | 'portrait';

export interface PlayableViewport {
  orientation: ActiveOrientation;
  viewportW: number;
  viewportH: number;
  playableX: number;
  playableY: number;
  playableW: number;
  playableH: number;
  focalX: number;
  focalY: number;
  zoom: number;
  visibleWorldArea: number;
}

export function resolveActiveOrientation(
  vw: number,
  vh: number,
  pref: OrientationPreference = 'auto'
): ActiveOrientation {
  if (pref === 'landscape') return 'landscape';
  if (pref === 'portrait') return 'portrait';
  return vh > vw ? 'portrait' : 'landscape';
}

export function computeEqualAreaZoom(playableW: number, playableH: number): number {
  const safeW = Math.max(200, Number.isFinite(playableW) ? playableW : BASE_PLAYABLE_WIDTH);
  const safeH = Math.max(200, Number.isFinite(playableH) ? playableH : BASE_PLAYABLE_HEIGHT);
  const raw = Math.sqrt((safeW * safeH) / BASE_PLAYABLE_AREA);
  return Math.max(0.55, Math.min(1.85, raw));
}

export function computePlayableViewport(
  vw: number,
  vh: number,
  pref: OrientationPreference = 'auto'
): PlayableViewport {
  const safeVw = Math.max(240, Number.isFinite(vw) ? vw : BASE_PLAYABLE_WIDTH);
  const safeVh = Math.max(240, Number.isFinite(vh) ? vh : BASE_PLAYABLE_HEIGHT);
  const orientation = resolveActiveOrientation(safeVw, safeVh, pref);
  const playableW = safeVw;
  const playableH = orientation === 'portrait'
    ? Math.round(safeVh * PORTRAIT_ARENA_HEIGHT_RATIO)
    : safeVh;
  const focalX = playableW * 0.5;
  const focalY = playableH * 0.5; // In portrait: ~32dvh from top (center of top 64dvh arena)
  const zoom = computeEqualAreaZoom(playableW, playableH);
  const visibleWorldArea = (playableW / zoom) * (playableH / zoom);

  return {
    orientation,
    viewportW: safeVw,
    viewportH: safeVh,
    playableX: 0,
    playableY: 0,
    playableW,
    playableH,
    focalX,
    focalY,
    zoom,
    visibleWorldArea,
  };
}

export function computeVisibilityAlpha(distance: number): number {
  if (!Number.isFinite(distance) || distance < 0) return 1;
  if (distance >= VISION_RADIUS) return 0;
  if (distance <= VISION_INNER_RADIUS) return 1;
  return Math.max(0, Math.min(1, (VISION_RADIUS - distance) / VISION_FADE_RIM));
}

export function clampBotVisionRange(rawRange: number): number {
  if (!Number.isFinite(rawRange) || rawRange <= 0) return 0;
  return Math.min(VISION_RADIUS, rawRange);
}

export interface EdgeChevronResult {
  visible: boolean;
  screenX: number;
  screenY: number;
  angle: number;
  scale: number;
  alpha: number;
}

export function computeEdgeChevron(
  targetX: number,
  targetY: number,
  playerX: number,
  playerY: number,
  camX: number,
  camY: number,
  viewport: PlayableViewport,
  margin = 18,
  allowBeyondVision = false
): EdgeChevronResult {
  const dist = Math.hypot(targetX - playerX, targetY - playerY);
  if (!allowBeyondVision && (dist > VISION_RADIUS || dist < 1)) {
    return { visible: false, screenX: 0, screenY: 0, angle: 0, scale: 1, alpha: 0 };
  }
  const sx = (targetX - camX) * viewport.zoom + viewport.focalX;
  const sy = (targetY - camY) * viewport.zoom + viewport.focalY;
  const minX = viewport.playableX + margin;
  const maxX = viewport.playableX + viewport.playableW - margin;
  const minY = viewport.playableY + margin;
  const maxY = viewport.playableY + viewport.playableH - margin;

  // Already clearly on-screen inside the unobstructed arena bounds
  if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) {
    return { visible: false, screenX: sx, screenY: sy, angle: 0, scale: 1, alpha: 0 };
  }

  const dx = sx - viewport.focalX;
  const dy = sy - viewport.focalY;
  const angle = Math.atan2(dy, dx);
  const halfW = Math.max(1, viewport.playableW * 0.5 - margin);
  const halfH = Math.max(1, viewport.playableH * 0.5 - margin);
  const tx = Math.abs(dx) > 0.0001 ? halfW / Math.abs(dx) : Infinity;
  const ty = Math.abs(dy) > 0.0001 ? halfH / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  const screenX = Math.max(minX, Math.min(maxX, viewport.focalX + dx * t));
  const screenY = Math.max(minY, Math.min(maxY, viewport.focalY + dy * t));

  const closeness = Math.max(0, Math.min(1, 1 - dist / VISION_RADIUS));
  const scale = 0.78 + closeness * 0.52;
  const alpha = allowBeyondVision ? 0.82 : 0.42 + closeness * 0.58;

  return { visible: true, screenX, screenY, angle, scale, alpha };
}

// ==========================================
// 2. PHYSICS SUB-STEPPING, KNOCKBACK & WALL-SLAM
// ==========================================
export function stepPhysicsSubsteps(rawDt: number, maxSubstep = 1 / 60): number[] {
  const clamped = Math.max(0, Math.min(0.05, Number.isFinite(rawDt) ? rawDt : 0));
  if (clamped <= 0) return [];
  const count = Math.max(1, Math.ceil(clamped / maxSubstep));
  const subDt = clamped / count;
  const steps: number[] = [];
  for (let i = 0; i < count; i++) steps.push(subDt);
  return steps;
}

export function stepKnockbackVelocity(
  vx: number,
  vy: number,
  dt: number,
  friction = 7.5,
  onFrost = false
): { vx: number; vy: number; speed: number } {
  const effFriction = onFrost ? friction * 0.28 : friction;
  const decay = Math.exp(-effFriction * Math.max(0, dt));
  let nx = vx * decay;
  let ny = vy * decay;
  const speed = Math.hypot(nx, ny);
  if (speed < 8) {
    nx = 0;
    ny = 0;
    return { vx: 0, vy: 0, speed: 0 };
  }
  return { vx: nx, vy: ny, speed };
}

export interface WallSlamOutcome {
  triggered: boolean;
  stunSeconds: number;
  crushDamage: number;
}

export function evaluateWallSlam(impactSpeed: number): WallSlamOutcome {
  if (!Number.isFinite(impactSpeed) || impactSpeed < WALL_SLAM_SPEED_THRESHOLD) {
    return { triggered: false, stunSeconds: 0, crushDamage: 0 };
  }
  const crushDamage = Math.max(28, Math.min(75, Math.round(impactSpeed * 0.095)));
  return {
    triggered: true,
    stunSeconds: WALL_SLAM_STUN_SECONDS,
    crushDamage,
  };
}

export interface DestructibleProp {
  id: string;
  kind: 'ARCANE_CRATE' | 'CRYSTAL_PILLAR' | 'EMBER_BARREL';
  x: number;
  y: number;
  radius: number;
  hp: number;
  maxHp: number;
  active: boolean;
  detonateDelay?: number;
}

export function findChainBarrels(
  originX: number,
  originY: number,
  blastRadius: number,
  props: DestructibleProp[],
  excludeId?: string
): DestructibleProp[] {
  const chained: DestructibleProp[] = [];
  for (const p of props) {
    if (!p.active || p.kind !== 'EMBER_BARREL' || p.id === excludeId) continue;
    if (Math.hypot(p.x - originX, p.y - originY) <= blastRadius + p.radius) {
      chained.push(p);
    }
  }
  return chained;
}

export interface GeothermVentState {
  phase: 'IDLE' | 'TELEGRAPH' | 'ERUPTING';
  timer: number;
  didEruptPulse: boolean;
}

export function stepGeothermVent(
  state: GeothermVentState,
  dt: number,
  idleSec = 6.5,
  telegraphSec = 1.6,
  eruptSec = 0.5
): GeothermVentState {
  let phase = state.phase;
  let timer = state.timer - Math.max(0, dt);
  let didEruptPulse = false;

  if (timer <= 0) {
    if (phase === 'IDLE') {
      phase = 'TELEGRAPH';
      timer = telegraphSec;
    } else if (phase === 'TELEGRAPH') {
      phase = 'ERUPTING';
      timer = eruptSec;
      didEruptPulse = true;
    } else {
      phase = 'IDLE';
      timer = idleSec;
    }
  }
  return { phase, timer, didEruptPulse };
}

export function evaluateSupplyDropSchedule(
  matchTimeSec: number,
  triggeredCount: number
): boolean {
  const DROP_TIMES = [42, 105];
  if (triggeredCount >= DROP_TIMES.length) return false;
  return matchTimeSec >= DROP_TIMES[triggeredCount];
}

// ==========================================
// 3. 120ms INPUT BUFFER & QUADRATIC STICK CURVE
// ==========================================
export type BufferedAction = 'dash' | 'ability' | 'art' | 'basic';

export interface InputBuffer {
  push(action: BufferedAction, nowMs: number): void;
  consume(action: BufferedAction, nowMs: number, windowMs?: number): boolean;
  peek(action: BufferedAction, nowMs: number, windowMs?: number): boolean;
  clear(): void;
}

export function createInputBuffer(): InputBuffer {
  const timestamps: Partial<Record<BufferedAction, number>> = {};
  return {
    push(action, nowMs) {
      timestamps[action] = nowMs;
    },
    peek(action, nowMs, windowMs = INPUT_BUFFER_WINDOW_MS) {
      const ts = timestamps[action];
      if (typeof ts !== 'number') return false;
      return nowMs - ts >= 0 && nowMs - ts <= windowMs;
    },
    consume(action, nowMs, windowMs = INPUT_BUFFER_WINDOW_MS) {
      const ts = timestamps[action];
      if (typeof ts !== 'number') return false;
      const valid = nowMs - ts >= 0 && nowMs - ts <= windowMs;
      delete timestamps[action];
      return valid;
    },
    clear() {
      delete timestamps.dash;
      delete timestamps.ability;
      delete timestamps.art;
      delete timestamps.basic;
    },
  };
}

export function applyQuadraticStickCurve(
  nx: number,
  ny: number,
  deadzone = 0.08
): { x: number; y: number; magnitude: number } {
  const rawMag = Math.hypot(nx, ny);
  if (!Number.isFinite(rawMag) || rawMag <= deadzone) {
    return { x: 0, y: 0, magnitude: 0 };
  }
  const clamped = Math.min(1, rawMag);
  const remapped = (clamped - deadzone) / (1 - deadzone);
  // Smooth quadratic acceleration curve for fine low-speed aim + crisp full-tilt sprint
  const curved = remapped * remapped;
  const ux = nx / rawMag;
  const uy = ny / rawMag;
  return { x: ux * curved, y: uy * curved, magnitude: curved };
}

// ==========================================
// 4. TELEMETRY SANITY VALIDATOR, CLOUDSYNC FALLBACK & IAP BRIDGE
// ==========================================
export interface MatchTelemetryPayload {
  durationSec: number;
  kills: number;
  maxDps: number;
  placement: number;
  damageDealt: number;
  champion: string;
}

export interface TelemetryValidationResult {
  valid: boolean;
  reason?: string;
  digest: string;
}

export function computeMatchTelemetryDigest(t: MatchTelemetryPayload, salt = 'AR_TELEMETRY_V1'): string {
  const canonical = `${salt}|${Math.round(t.durationSec)}|${t.kills}|${Math.round(t.maxDps)}|${t.placement}|${Math.round(t.damageDealt)}|${t.champion}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return `T1_${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

export function validateMatchTelemetry(t: MatchTelemetryPayload): TelemetryValidationResult {
  const digest = computeMatchTelemetryDigest(t);
  if (!Number.isFinite(t.durationSec) || t.durationSec < 5 || t.durationSec > 1800) {
    return { valid: false, reason: 'Match duration outside realistic bounds (5s-1800s).', digest };
  }
  if (!Number.isInteger(t.kills) || t.kills < 0 || t.kills > 49) {
    return { valid: false, reason: 'Elimination count outside 50-player arena bounds.', digest };
  }
  const killsPerMin = t.kills / Math.max(0.25, t.durationSec / 60);
  if (t.kills >= 4 && killsPerMin > 32) {
    return { valid: false, reason: 'Elimination rate exceeds anti-cheat ceiling.', digest };
  }
  if (!Number.isFinite(t.maxDps) || t.maxDps < 0 || t.maxDps > 2500) {
    return { valid: false, reason: 'Peak DPS exceeds combat balance ceiling.', digest };
  }
  if (!['BERSERKER', 'TIDECALLER', 'SHADOW', 'MAGE', 'ASSASSIN'].includes(t.champion)) {
    return { valid: false, reason: 'Unknown champion identifier.', digest };
  }
  return { valid: true, digest };
}

export interface FirebaseConfigLike {
  apiKey?: string;
  projectId?: string;
  appId?: string;
  firestoreDatabaseId?: string;
}

export function isValidFirebaseConfig(cfg: FirebaseConfigLike | null | undefined): boolean {
  if (!cfg || typeof cfg !== 'object') return false;
  const apiKey = String(cfg.apiKey || '').trim();
  const projectId = String(cfg.projectId || '').trim();
  const appId = String(cfg.appId || '').trim();
  if (!apiKey || !projectId || !appId) return false;
  if (/placeholder|your_|remixed-project-id|xxx/i.test(apiKey + projectId + appId)) return false;
  return true;
}

export function resolveSyncMode(cfg: FirebaseConfigLike | null | undefined, signedInUid?: string | null): {
  mode: 'cloud' | 'cloud-ready' | 'local';
  label: string;
} {
  if (!isValidFirebaseConfig(cfg)) {
    return { mode: 'local', label: 'Local Save Mode · Cloud Ready' };
  }
  if (signedInUid) {
    return { mode: 'cloud', label: 'Cloud Sync Connected' };
  }
  return { mode: 'cloud-ready', label: 'Local Save Mode · Cloud Ready' };
}

export interface ArcaneIapProduct {
  sku: 'gems_handful_80' | 'gems_royal_500' | 'arcane_pass';
  title: string;
  priceDisplay: string;
  gems: number;
  bonusCrystals: number;
  badge: string;
  desc: string;
}

export const ARCANE_IAP_CATALOG: readonly ArcaneIapProduct[] = Object.freeze([
  {
    sku: 'gems_handful_80',
    title: 'Handful of Gems',
    priceDisplay: '$0.99',
    gems: 80,
    bonusCrystals: 0,
    badge: '+80 💎',
    desc: 'Instant gem pack for mythic champions & shop cosmetics.',
  },
  {
    sku: 'gems_royal_500',
    title: 'Royal Gem Chest',
    priceDisplay: '$4.99',
    gems: 500,
    bonusCrystals: 250,
    badge: '+500 💎 · BEST VALUE',
    desc: '500 Gems plus +250 bonus Astral Crystals.',
  },
  {
    sku: 'arcane_pass',
    title: 'Arcane Pass',
    priceDisplay: '$7.99',
    gems: 750,
    bonusCrystals: 600,
    badge: 'SEASON PASS',
    desc: '+750 Gems, +600 Astral Crystals & +20% permanent XP boost.',
  },
]);

export interface PurchaseResult {
  ok: boolean;
  sku: string;
  channel: 'play-billing' | 'web-preview';
  gemsGranted: number;
  crystalsGranted: number;
  passUnlocked: boolean;
  error?: string;
}

export async function executeArcaneBillingPurchase(
  sku: string,
  nativeBridge?: { purchaseProduct?: (sku: string) => Promise<{ ok: boolean; error?: string }> } | null
): Promise<PurchaseResult> {
  const product = ARCANE_IAP_CATALOG.find(p => p.sku === sku);
  if (!product) {
    return {
      ok: false,
      sku,
      channel: 'web-preview',
      gemsGranted: 0,
      crystalsGranted: 0,
      passUnlocked: false,
      error: `Unknown product SKU: ${sku}`,
    };
  }
  if (nativeBridge && typeof nativeBridge.purchaseProduct === 'function') {
    const res = await nativeBridge.purchaseProduct(product.sku);
    if (!res?.ok) {
      return {
        ok: false,
        sku: product.sku,
        channel: 'play-billing',
        gemsGranted: 0,
        crystalsGranted: 0,
        passUnlocked: false,
        error: res?.error || 'Native billing transaction cancelled.',
      };
    }
    return {
      ok: true,
      sku: product.sku,
      channel: 'play-billing',
      gemsGranted: product.gems,
      crystalsGranted: product.bonusCrystals,
      passUnlocked: product.sku === 'arcane_pass',
    };
  }
  return {
    ok: true,
    sku: product.sku,
    channel: 'web-preview',
    gemsGranted: product.gems,
    crystalsGranted: product.bonusCrystals,
    passUnlocked: product.sku === 'arcane_pass',
  };
}

export const HUD_LAYOUT_LANDSCAPE_KEY = 'arcane_royale_hud_landscape_v1';
export const HUD_LAYOUT_PORTRAIT_KEY = 'arcane_royale_hud_portrait_v1';

export function resolveHudProfileKey(orientation: ActiveOrientation): string {
  return orientation === 'portrait' ? HUD_LAYOUT_PORTRAIT_KEY : HUD_LAYOUT_LANDSCAPE_KEY;
}

export function resolveAdaptiveMusicStem(
  gameState: string,
  aliveCount: number,
  stormPhase: number
): 'lobby' | 'combat' | 'climax' {
  if (gameState !== 'PLAYING' && gameState !== 'DROPPING' && gameState !== 'PAUSED') {
    return 'lobby';
  }
  if (aliveCount <= 10 || stormPhase >= 4) {
    return 'climax';
  }
  return 'combat';
}

export function damageDestructibleProp(
  prop: DestructibleProp,
  damage: number
): { shattered: boolean; blocksProjectile: boolean; dropOrb: 'hp_mp' | 'none'; explode: boolean } {
  if (!prop.active) {
    return { shattered: false, blocksProjectile: false, dropOrb: 'none', explode: false };
  }
  prop.hp = Math.max(0, prop.hp - Math.max(0, damage));
  const shattered = prop.hp <= 0;
  if (shattered) prop.active = false;
  return {
    shattered,
    blocksProjectile: prop.kind === 'CRYSTAL_PILLAR',
    dropOrb: shattered && prop.kind === 'ARCANE_CRATE' ? 'hp_mp' : 'none',
    explode: shattered && prop.kind === 'EMBER_BARREL',
  };
}

// ==========================================
// 5. LIVE CHARACTER PNG ASSETS & EXACT SPRITE SHEET SLICING
// ==========================================
export type CharacterAssetKey = 'BERSERKER' | 'TIDECALLER' | 'SHADOW';

export interface CharacterRemoteAssetEntry {
  key: CharacterAssetKey;
  displayName: string;
  portraitUrl: string;
  portraitFallback: string;
  spriteUrl: string;
  spriteFallback: string;
  cols: number;
  rows: number;
  frameCount: number;
}

const REMOTE_CHARACTER_BASE = 'https://zakiyt654321-gif.github.io/Arcane-Royal-Try3/assets/Image/';
const LOCAL_CHARACTER_BASE = './assets/Image/';

export const CHARACTER_REMOTE_ASSETS: Record<CharacterAssetKey, CharacterRemoteAssetEntry> = Object.freeze({
  BERSERKER: Object.freeze({
    key: 'BERSERKER',
    displayName: 'The Berserker',
    portraitUrl: `${REMOTE_CHARACTER_BASE}Beserker_Portrait.png`,
    portraitFallback: `${LOCAL_CHARACTER_BASE}Beserker_Portrait.png`,
    spriteUrl: `${REMOTE_CHARACTER_BASE}Beserker_Sprite.png`,
    spriteFallback: `${LOCAL_CHARACTER_BASE}Beserker_Sprite.png`,
    cols: 5,
    rows: 4,
    frameCount: 20,
  }),
  TIDECALLER: Object.freeze({
    key: 'TIDECALLER',
    displayName: 'The Tidecaller',
    portraitUrl: `${REMOTE_CHARACTER_BASE}Tidecaller_Portrait.png`,
    portraitFallback: `${LOCAL_CHARACTER_BASE}Tidecaller_Portrait.png`,
    spriteUrl: `${REMOTE_CHARACTER_BASE}Tidecaller_Sprite.png`,
    spriteFallback: `${LOCAL_CHARACTER_BASE}Tidecaller_Sprite.png`,
    cols: 5,
    rows: 6,
    frameCount: 30,
  }),
  SHADOW: Object.freeze({
    key: 'SHADOW',
    displayName: 'The Shadow',
    portraitUrl: `${REMOTE_CHARACTER_BASE}Shadow_Portrait.png`,
    portraitFallback: `${LOCAL_CHARACTER_BASE}Shadow_Portrait.png`,
    spriteUrl: `${REMOTE_CHARACTER_BASE}Shadow_Sprite.png`,
    spriteFallback: `${LOCAL_CHARACTER_BASE}Shadow_Sprite.png`,
    cols: 5,
    rows: 4,
    frameCount: 20,
  }),
});

export interface SpriteSliceRect {
  frameW: number;
  frameH: number;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  drawW: number;
  drawH: number;
}

export function computeSpriteSliceRect(
  naturalWidth: number,
  naturalHeight: number,
  cols: number,
  rows: number,
  col: number,
  row: number,
  drawMaxSize = 74
): SpriteSliceRect {
  const safeCols = Math.max(1, Math.floor(cols));
  const safeRows = Math.max(1, Math.floor(rows));
  const clampedCol = Math.max(0, Math.min(safeCols - 1, Math.floor(col)));
  const clampedRow = Math.max(0, Math.min(safeRows - 1, Math.floor(row)));
  const frameW = naturalWidth / safeCols;
  const frameH = naturalHeight / safeRows;
  const bleedInset = frameW > 4 && frameH > 4 ? 0.5 : 0;
  const sx = clampedCol * frameW + bleedInset;
  const sy = clampedRow * frameH + bleedInset;
  const sw = frameW - bleedInset * 2;
  const sh = frameH - bleedInset * 2;
  const cellAspect = frameW / frameH;
  const drawW = cellAspect < 1 ? drawMaxSize * cellAspect : drawMaxSize;
  const drawH = cellAspect > 1 ? drawMaxSize / cellAspect : drawMaxSize;
  return { frameW, frameH, sx, sy, sw, sh, drawW, drawH };
}


