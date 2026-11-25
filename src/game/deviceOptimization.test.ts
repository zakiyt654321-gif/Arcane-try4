import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampControlScale,
  computeAdaptiveCameraZoom,
  detectDeviceProfile,
  resolveScreenOptimization
} from './deviceOptimization';

test('detectDeviceProfile resolves mobile-portrait and mobile-landscape for all viewports in mobile-only mode', () => {
  assert.equal(detectDeviceProfile({ width: 390, height: 844, hasCoarsePointer: true, maxTouchPoints: 5 }), 'mobile-portrait');
  assert.equal(detectDeviceProfile({ width: 844, height: 390, hasCoarsePointer: true, maxTouchPoints: 5 }), 'mobile-landscape');
  assert.equal(detectDeviceProfile({ width: 667, height: 375, hasCoarsePointer: true, maxTouchPoints: 5 }), 'mobile-landscape');
  assert.equal(detectDeviceProfile({ width: 820, height: 1180, hasCoarsePointer: true, maxTouchPoints: 5 }), 'mobile-portrait');
  assert.equal(detectDeviceProfile({ width: 1440, height: 900, hasCoarsePointer: false, maxTouchPoints: 0 }), 'mobile-landscape');
});

test('resolveScreenOptimization locks to mobile-only profile with touch controls always enabled', () => {
  const wideScreen = resolveScreenOptimization({
    modePref: 'desktop',
    touchPref: 'off',
    width: 1440,
    height: 900,
    hasCoarsePointer: false,
    maxTouchPoints: 0,
    graphicsQuality: 'high'
  });
  assert.equal(wideScreen.profile, 'mobile-landscape');
  assert.equal(wideScreen.modePref, 'mobile');
  assert.equal(wideScreen.isCompact, true);
  assert.equal(wideScreen.showTouchControls, true);
  assert.equal(wideScreen.dprCap, 1.5);

  const portraitPhone = resolveScreenOptimization({
    modePref: 'auto',
    touchPref: 'auto',
    width: 390,
    height: 844,
    hasCoarsePointer: true,
    maxTouchPoints: 5,
    graphicsQuality: 'medium'
  });
  assert.equal(portraitPhone.profile, 'mobile-portrait');
  assert.equal(portraitPhone.isCompact, true);
  assert.equal(portraitPhone.showTouchControls, true);
  assert.equal(portraitPhone.dprCap, 1.25);
});

test('control scale clamping and mobile minimap geometry prevent overlap on small screens', () => {
  assert.equal(clampControlScale(0.2), 0.75);
  assert.equal(clampControlScale(2.5), 1.25);
  assert.equal(clampControlScale('bad'), 1);

  const seLandscape = resolveScreenOptimization({
    modePref: 'mobile',
    touchPref: 'on',
    controlScale: 1.0,
    width: 667,
    height: 375,
    hasCoarsePointer: true,
    maxTouchPoints: 5
  });
  assert.equal(seLandscape.profile, 'mobile-landscape');
  assert.ok(seLandscape.minimapY >= 76, 'minimap stays below top stats bar');
  assert.ok(seLandscape.minimapY + seLandscape.minimapSize <= 253, 'minimap clears bottom joystick zone');
  assert.ok(seLandscape.controlScale <= 0.76, 'compact touch controls scale down on small landscape phones');
});

test('adaptive camera zoom scales cleanly for mobile viewports and respects manual zoom lock', () => {
  const portraitZoom = computeAdaptiveCameraZoom(390, 844, 'auto', 540);
  const landscapeZoom = computeAdaptiveCameraZoom(844, 390, 'auto', 560);
  assert.ok(portraitZoom >= 0.65 && portraitZoom <= 0.8, `expected readable portrait zoom, got ${portraitZoom}`);
  assert.ok(landscapeZoom >= 0.65 && landscapeZoom <= 0.8, `expected readable landscape zoom, got ${landscapeZoom}`);
  assert.equal(computeAdaptiveCameraZoom(390, 844, '0.6', 540), 0.6);
});
