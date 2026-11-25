export const HUD_LAYOUT_STORAGE_KEY = 'arcane_royale_hud_layout_v1';

export const HUD_ELEMENT_IDS = [
  'joystick',
  'actions',
  'quickuse',
  'resources',
  'minimap',
] as const;

export type HudElementId = (typeof HUD_ELEMENT_IDS)[number];

export interface HudElementLayout {
  /** Normalized left offset (0..1 of viewport width), or null to use responsive default. */
  x: number | null;
  /** Normalized top offset (0..1 of viewport height), or null to use responsive default. */
  y: number | null;
  /** Element scale multiplier clamped between 0.75 and 1.35. */
  scale: number;
  /** Element opacity clamped between 0.40 and 1.00. */
  opacity: number;
}

export interface HudLayoutConfig {
  version: 1;
  snapToGrid: boolean;
  elements: Record<HudElementId, HudElementLayout>;
}

export interface SafeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const HUD_SCALE_MIN = 0.75;
export const HUD_SCALE_MAX = 1.35;
export const HUD_OPACITY_MIN = 0.4;
export const HUD_OPACITY_MAX = 1.0;
export const HUD_GRID_SIZE = 16;

export const HUD_ELEMENT_LABELS: Record<HudElementId, string> = {
  joystick: 'Movement Joystick',
  actions: 'Combat Action Cluster',
  quickuse: 'Quick-Use & Loot',
  resources: 'HP / MP / Stamina',
  minimap: 'Minimap & Waypoint',
};

export function clampHudScale(value: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 1;
  const clamped = Math.max(HUD_SCALE_MIN, Math.min(HUD_SCALE_MAX, num));
  return Math.round(clamped * 100) / 100;
}

export function clampHudOpacity(value: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 1;
  const clamped = Math.max(HUD_OPACITY_MIN, Math.min(HUD_OPACITY_MAX, num));
  return Math.round(clamped * 100) / 100;
}

export function createDefaultElementLayout(): HudElementLayout {
  return { x: null, y: null, scale: 1, opacity: 1 };
}

export function createDefaultHudLayout(snapToGrid = true): HudLayoutConfig {
  return {
    version: 1,
    snapToGrid: Boolean(snapToGrid),
    elements: {
      joystick: createDefaultElementLayout(),
      actions: createDefaultElementLayout(),
      quickuse: createDefaultElementLayout(),
      resources: createDefaultElementLayout(),
      minimap: createDefaultElementLayout(),
    },
  };
}

export function snapCoordinateToGrid(
  value: number,
  gridSize: number = HUD_GRID_SIZE,
  enabled = true
): number {
  if (!enabled || !Number.isFinite(value) || gridSize <= 1) {
    return Math.round(Number.isFinite(value) ? value : 0);
  }
  return Math.round(value / gridSize) * gridSize;
}

export function clampElementPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  insets: SafeInsets = { top: 8, right: 8, bottom: 8, left: 8 }
): { x: number; y: number } {
  const vw = Math.max(240, Math.round(viewportWidth || 844));
  const vh = Math.max(240, Math.round(viewportHeight || 390));
  const w = Math.max(24, Math.min(vw - insets.left - insets.right, width || 48));
  const h = Math.max(24, Math.min(vh - insets.top - insets.bottom, height || 48));

  const minX = Math.max(4, insets.left);
  const maxX = Math.max(minX, vw - insets.right - w);
  const minY = Math.max(4, insets.top);
  const maxY = Math.max(minY, vh - insets.bottom - h);

  return {
    x: Math.round(Math.max(minX, Math.min(maxX, Number.isFinite(x) ? x : minX))),
    y: Math.round(Math.max(minY, Math.min(maxY, Number.isFinite(y) ? y : minY))),
  };
}

export function normalizeElementPosition(
  px: number,
  py: number,
  viewportWidth: number,
  viewportHeight: number
): { x: number; y: number } {
  const vw = Math.max(240, viewportWidth || 844);
  const vh = Math.max(240, viewportHeight || 390);
  const nx = Math.max(0, Math.min(1, px / vw));
  const ny = Math.max(0, Math.min(1, py / vh));
  return {
    x: Math.round(nx * 10000) / 10000,
    y: Math.round(ny * 10000) / 10000,
  };
}

export function denormalizeAndClampPosition(
  nx: number,
  ny: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  insets?: SafeInsets
): { x: number; y: number } {
  const vw = Math.max(240, viewportWidth || 844);
  const vh = Math.max(240, viewportHeight || 390);
  return clampElementPosition(
    nx * vw,
    ny * vh,
    width,
    height,
    vw,
    vh,
    insets
  );
}

export function sanitizeHudLayout(raw: unknown): HudLayoutConfig {
  const defaults = createDefaultHudLayout(true);
  if (!raw || typeof raw !== 'object') return defaults;
  const obj = raw as Record<string, unknown>;
  const snapToGrid = typeof obj.snapToGrid === 'boolean' ? obj.snapToGrid : true;
  const srcElements =
    obj.elements && typeof obj.elements === 'object'
      ? (obj.elements as Record<string, unknown>)
      : {};

  const result = createDefaultHudLayout(snapToGrid);
  for (const id of HUD_ELEMENT_IDS) {
    const entry = srcElements[id];
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const rawX = item.x;
    const rawY = item.y;
    const hasCoords =
      typeof rawX === 'number' &&
      Number.isFinite(rawX) &&
      typeof rawY === 'number' &&
      Number.isFinite(rawY);
    result.elements[id] = {
      x: hasCoords ? Math.round(Math.max(0, Math.min(1, rawX)) * 10000) / 10000 : null,
      y: hasCoords ? Math.round(Math.max(0, Math.min(1, rawY)) * 10000) / 10000 : null,
      scale: clampHudScale(item.scale as number),
      opacity: clampHudOpacity(item.opacity as number),
    };
  }
  return result;
}

export function updateHudElementLayout(
  layout: HudLayoutConfig,
  id: HudElementId,
  patch: Partial<HudElementLayout>
): HudLayoutConfig {
  const base = sanitizeHudLayout(layout);
  const prev = base.elements[id];
  const nextX =
    patch.x === null
      ? null
      : typeof patch.x === 'number' && Number.isFinite(patch.x)
        ? Math.round(Math.max(0, Math.min(1, patch.x)) * 10000) / 10000
        : prev.x;
  const nextY =
    patch.y === null
      ? null
      : typeof patch.y === 'number' && Number.isFinite(patch.y)
        ? Math.round(Math.max(0, Math.min(1, patch.y)) * 10000) / 10000
        : prev.y;

  base.elements[id] = {
    x: nextX,
    y: nextY,
    scale: patch.scale !== undefined ? clampHudScale(patch.scale) : prev.scale,
    opacity: patch.opacity !== undefined ? clampHudOpacity(patch.opacity) : prev.opacity,
  };
  return base;
}
