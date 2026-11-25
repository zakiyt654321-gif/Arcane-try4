export type DeviceModePreference = 'auto' | 'mobile' | 'tablet' | 'desktop';
export type TouchControlsPreference = 'auto' | 'on' | 'off';
export type GraphicsQualityPreference = 'low' | 'medium' | 'high';
export type ResolvedDeviceProfile = 'mobile-portrait' | 'mobile-landscape' | 'tablet' | 'desktop';

export interface DeviceEnvironmentInput {
  width: number;
  height: number;
  hasCoarsePointer?: boolean;
  maxTouchPoints?: number;
  devicePixelRatio?: number;
}

export interface ScreenOptimizationInput extends DeviceEnvironmentInput {
  modePref: DeviceModePreference;
  touchPref: TouchControlsPreference;
  controlScale?: number;
  graphicsQuality?: GraphicsQualityPreference;
}

export interface ResolvedScreenOptimization {
  profile: ResolvedDeviceProfile;
  detectedProfile: ResolvedDeviceProfile;
  modePref: DeviceModePreference;
  orientation: 'portrait' | 'landscape';
  isCompact: boolean;
  showTouchControls: boolean;
  controlScale: number;
  hudScale: number;
  dprCap: number;
  targetCombatSpan: number;
  minimapSize: number;
  minimapX: number;
  minimapY: number;
}

export const VALID_DEVICE_MODES: readonly DeviceModePreference[] = ['auto', 'mobile', 'tablet', 'desktop'];
export const VALID_TOUCH_MODES: readonly TouchControlsPreference[] = ['auto', 'on', 'off'];

export function clampControlScale(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.round(Math.max(0.75, Math.min(1.25, n)) * 100) / 100;
}

export function detectDeviceProfile(env: DeviceEnvironmentInput): ResolvedDeviceProfile {
  const width = Math.max(240, Math.floor(Number(env.width) || 844));
  const height = Math.max(240, Math.floor(Number(env.height) || 390));
  return height > width ? 'mobile-portrait' : 'mobile-landscape';
}

export function resolveScreenOptimization(input: ScreenOptimizationInput): ResolvedScreenOptimization {
  const width = Math.max(240, Math.floor(Number(input.width) || 844));
  const height = Math.max(240, Math.floor(Number(input.height) || 390));
  const orientation: 'portrait' | 'landscape' = height > width ? 'portrait' : 'landscape';
  const quality: GraphicsQualityPreference =
    input.graphicsQuality === 'low' || input.graphicsQuality === 'medium' || input.graphicsQuality === 'high'
      ? input.graphicsQuality
      : 'high';

  // Mobile-only mode: always resolve to mobile-portrait or mobile-landscape with touch controls enabled
  const detectedProfile: ResolvedDeviceProfile = orientation === 'portrait' ? 'mobile-portrait' : 'mobile-landscape';
  const profile: ResolvedDeviceProfile = detectedProfile;
  const modePref: DeviceModePreference = 'mobile';
  const showTouchControls = true;

  const userScale = clampControlScale(input.controlScale ?? 1);
  const autoControlFit =
    profile === 'mobile-landscape'
      ? Math.min(0.84, Math.max(0.58, Math.min(width / 960, height / 490)))
      : Math.min(0.86, Math.max(0.66, width / 470));
  const controlScale = Math.round(Math.max(0.54, Math.min(1.25, autoControlFit * userScale)) * 100) / 100;

  const hudScale =
    profile === 'mobile-landscape'
      ? Math.round(Math.max(0.8, Math.min(1.05, 0.88 * userScale)) * 100) / 100
      : Math.round(Math.max(0.82, Math.min(1.08, 0.92 * userScale)) * 100) / 100;

  const dprCap = quality === 'low' ? 1 : quality === 'medium' ? 1.25 : 1.5;
  const targetCombatSpan = profile === 'mobile-portrait' ? 540 : 560;

  let minimapSize: number;
  let minimapX: number;
  let minimapY: number;
  if (profile === 'mobile-landscape') {
    minimapSize = Math.round(Math.max(66, Math.min(96, height * 0.21)));
    minimapX = 10;
    minimapY = Math.round(Math.max(82, Math.min(96, height - minimapSize - 118)));
  } else {
    minimapSize = Math.round(Math.max(74, Math.min(96, width * 0.22)));
    minimapX = 10;
    minimapY = 104;
  }

  return {
    profile,
    detectedProfile,
    modePref,
    orientation,
    isCompact: true,
    showTouchControls,
    controlScale,
    hudScale,
    dprCap,
    targetCombatSpan,
    minimapSize,
    minimapX,
    minimapY
  };
}

export function computeAdaptiveCameraZoom(
  width: number,
  height: number,
  zoomMode: string,
  targetCombatSpan: number
): number {
  if (zoomMode === '0.6') return 0.6;
  if (zoomMode === '0.8') return 0.8;
  if (zoomMode === '1.0') return 1.0;
  const minDim = Math.max(240, Math.min(width, height));
  const span = Math.max(360, targetCombatSpan || 620);
  return Math.max(0.5, Math.min(1.05, minDim / span));
}
