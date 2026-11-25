import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HUD_ELEMENT_IDS,
  HUD_LAYOUT_STORAGE_KEY,
  clampElementPosition,
  clampHudOpacity,
  clampHudScale,
  createDefaultHudLayout,
  denormalizeAndClampPosition,
  normalizeElementPosition,
  sanitizeHudLayout,
  snapCoordinateToGrid,
  updateHudElementLayout,
} from './hudEditor';

test('HUD layout storage key is separate from match save data and covers all 5 control groups', () => {
  assert.equal(HUD_LAYOUT_STORAGE_KEY, 'arcane_royale_hud_layout_v1');
  assert.deepEqual([...HUD_ELEMENT_IDS], ['joystick', 'actions', 'quickuse', 'resources', 'minimap']);
  const def = createDefaultHudLayout();
  assert.equal(def.version, 1);
  assert.equal(def.snapToGrid, true);
  for (const id of HUD_ELEMENT_IDS) {
    assert.deepEqual(def.elements[id], { x: null, y: null, scale: 1, opacity: 1 });
  }
});

test('clampHudScale and clampHudOpacity enforce exact 75%-135% scale and 40%-100% opacity bounds', () => {
  assert.equal(clampHudScale(0.2), 0.75);
  assert.equal(clampHudScale(0.75), 0.75);
  assert.equal(clampHudScale(1.15), 1.15);
  assert.equal(clampHudScale(2.5), 1.35);
  assert.equal(clampHudScale(Number.NaN), 1);

  assert.equal(clampHudOpacity(0.1), 0.4);
  assert.equal(clampHudOpacity(0.4), 0.4);
  assert.equal(clampHudOpacity(0.72), 0.72);
  assert.equal(clampHudOpacity(1.5), 1);
  assert.equal(clampHudOpacity(Number.NaN), 1);
});

test('snapCoordinateToGrid snaps to 16px increments when enabled and preserves precision when disabled', () => {
  assert.equal(snapCoordinateToGrid(25, 16, true), 32);
  assert.equal(snapCoordinateToGrid(23, 16, true), 16);
  assert.equal(snapCoordinateToGrid(25.4, 16, false), 25);
});

test('clampElementPosition keeps dragged controls strictly inside safe screen bounds', () => {
  const insets = { top: 10, right: 12, bottom: 14, left: 12 };
  const topLeft = clampElementPosition(-50, -30, 120, 120, 844, 390, insets);
  assert.deepEqual(topLeft, { x: 12, y: 10 });

  const bottomRight = clampElementPosition(900, 500, 120, 120, 844, 390, insets);
  assert.deepEqual(bottomRight, { x: 844 - 12 - 120, y: 390 - 14 - 120 });

  const normalized = normalizeElementPosition(211, 97.5, 844, 390);
  assert.deepEqual(normalized, { x: 0.25, y: 0.25 });

  const restored = denormalizeAndClampPosition(0.99, 0.99, 120, 120, 844, 390, insets);
  assert.deepEqual(restored, { x: 712, y: 256 });
});

test('sanitizeHudLayout safely recovers from corrupt or out-of-range saved values', () => {
  assert.deepEqual(sanitizeHudLayout(null), createDefaultHudLayout());
  const cleaned = sanitizeHudLayout({
    snapToGrid: false,
    elements: {
      joystick: { x: 0.12, y: 0.65, scale: 2.0, opacity: 0.1 },
      minimap: { x: 'bad', y: 0.2, scale: 0.9, opacity: 0.85 },
    },
  });
  assert.equal(cleaned.snapToGrid, false);
  assert.deepEqual(cleaned.elements.joystick, { x: 0.12, y: 0.65, scale: 1.35, opacity: 0.4 });
  assert.deepEqual(cleaned.elements.minimap, { x: null, y: null, scale: 0.9, opacity: 0.85 });
  assert.deepEqual(cleaned.elements.quickuse, { x: null, y: null, scale: 1, opacity: 1 });
});

test('updateHudElementLayout updates a single control group immutably', () => {
  const base = createDefaultHudLayout();
  const updated = updateHudElementLayout(base, 'quickuse', { x: 0.55, y: 0.72, scale: 1.2, opacity: 0.8 });
  assert.deepEqual(updated.elements.quickuse, { x: 0.55, y: 0.72, scale: 1.2, opacity: 0.8 });
  assert.deepEqual(base.elements.quickuse, { x: null, y: null, scale: 1, opacity: 1 });
});
