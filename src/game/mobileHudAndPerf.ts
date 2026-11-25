export type ConsumableKey = 'MEDKIT' | 'MANA' | 'SHIELD' | 'HASTE' | 'BOMB';

export type InventoryCounts = Record<ConsumableKey, number>;

export interface QuickUseSelection {
  itemKey: ConsumableKey | null;
  itemCount: number;
  totalCount: number;
}

export const QUICK_USE_FALLBACK_ORDER: readonly ConsumableKey[] = [
  'SHIELD',
  'HASTE',
  'BOMB',
  'MEDKIT',
  'MANA',
];

export const MAX_FRAME_DELTA_SECONDS = 0.05;
export const VIEWPORT_CULL_MARGIN_PX = 140;
export const DISTANT_BOT_TICK_HZ = 15;

export function selectQuickUseInventoryItem(
  inventory: Partial<InventoryCounts> | null | undefined,
  hpRatio: number,
  mpRatio: number,
  lastPickedKey: ConsumableKey | null = null
): QuickUseSelection {
  const safeInv: InventoryCounts = {
    MEDKIT: Math.max(0, Math.floor(Number(inventory?.MEDKIT) || 0)),
    MANA: Math.max(0, Math.floor(Number(inventory?.MANA) || 0)),
    SHIELD: Math.max(0, Math.floor(Number(inventory?.SHIELD) || 0)),
    HASTE: Math.max(0, Math.floor(Number(inventory?.HASTE) || 0)),
    BOMB: Math.max(0, Math.floor(Number(inventory?.BOMB) || 0)),
  };

  const totalCount =
    safeInv.MEDKIT +
    safeInv.MANA +
    safeInv.SHIELD +
    safeInv.HASTE +
    safeInv.BOMB;

  if (totalCount === 0) {
    return { itemKey: null, itemCount: 0, totalCount: 0 };
  }

  const safeHp = Number.isFinite(hpRatio) ? hpRatio : 1;
  const safeMp = Number.isFinite(mpRatio) ? mpRatio : 1;

  if (safeHp < 0.7 && safeInv.MEDKIT > 0) {
    return { itemKey: 'MEDKIT', itemCount: safeInv.MEDKIT, totalCount };
  }

  if (safeMp < 0.4 && safeInv.MANA > 0) {
    return { itemKey: 'MANA', itemCount: safeInv.MANA, totalCount };
  }

  if (lastPickedKey && safeInv[lastPickedKey] > 0) {
    return {
      itemKey: lastPickedKey,
      itemCount: safeInv[lastPickedKey],
      totalCount,
    };
  }

  for (const key of QUICK_USE_FALLBACK_ORDER) {
    if (safeInv[key] > 0) {
      return { itemKey: key, itemCount: safeInv[key], totalCount };
    }
  }

  return { itemKey: null, itemCount: 0, totalCount };
}

export function isPointInCancelZone(
  px: number,
  py: number,
  zoneCx: number,
  zoneCy: number,
  radius: number
): boolean {
  if (
    !Number.isFinite(px) ||
    !Number.isFinite(py) ||
    !Number.isFinite(zoneCx) ||
    !Number.isFinite(zoneCy) ||
    !Number.isFinite(radius) ||
    radius <= 0
  ) {
    return false;
  }
  const dx = px - zoneCx;
  const dy = py - zoneCy;
  return dx * dx + dy * dy <= radius * radius;
}

export function computeMobileDprCap(
  devicePixelRatio: number,
  graphicsQuality: 'low' | 'medium' | 'high' | string
): number {
  const safeDpr = Math.max(1, Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1);
  if (graphicsQuality === 'low') return 1.0;
  if (graphicsQuality === 'medium') return Math.min(safeDpr, 1.25);
  return Math.min(safeDpr, 1.5);
}

export function clampFrameDeltaTime(rawDeltaSeconds: number): number {
  if (!Number.isFinite(rawDeltaSeconds) || rawDeltaSeconds <= 0) return 0;
  return Math.min(rawDeltaSeconds, MAX_FRAME_DELTA_SECONDS);
}

export function isWithinViewportCullBounds(
  x: number,
  y: number,
  camLeft: number,
  camRight: number,
  camTop: number,
  camBottom: number,
  margin: number = VIEWPORT_CULL_MARGIN_PX
): boolean {
  return (
    x >= camLeft - margin &&
    x <= camRight + margin &&
    y >= camTop - margin &&
    y <= camBottom + margin
  );
}

export interface BotAiClockStep {
  shouldTick: boolean;
  stepDt: number;
  nextAccumulator: number;
}

export function stepDistantBotAiClock(
  inViewport: boolean,
  accumulator: number,
  dt: number,
  distantHz: number = DISTANT_BOT_TICK_HZ
): BotAiClockStep {
  const safeDt = clampFrameDeltaTime(dt);
  if (inViewport) {
    return { shouldTick: true, stepDt: safeDt, nextAccumulator: 0 };
  }
  const interval = 1 / Math.max(1, distantHz);
  const next = (Number.isFinite(accumulator) ? Math.max(0, accumulator) : 0) + safeDt;
  if (next >= interval) {
    return { shouldTick: true, stepDt: next, nextAccumulator: 0 };
  }
  return { shouldTick: false, stepDt: 0, nextAccumulator: next };
}
