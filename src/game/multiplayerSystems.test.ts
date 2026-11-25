import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  FRIEND_CODE_ALPHABET,
  generateFriendCode,
  validateChampionName,
  sanitizeChampionId,
  sanitizeUnlockedChampions,
  mergeProfileConflict,
} from '../authService.js';
import { generateRoomCode, MAX_SQUAD_SIZE, INVITE_TTL_MS } from '../socialService.js';
import {
  AOI_RADIUS,
  HOST_STALL_MS,
  INTERP_DELAY_MS,
  QUICK_COMMS_OPTIONS,
  SQUAD_COLORS,
  createSeededRng,
  packAoiBots,
  unpackAoiBots,
  electNextHostUid,
  createIntentDeduplicator,
  createInterpBuffer,
  pushInterpSample,
  sampleInterpBuffer,
} from '../squadMultiplayer.js';

const ROOT = process.cwd();

test('generateFriendCode produces ARC-XXXX without confusing chars 0/O/1/I', () => {
  assert.equal(/[0O1I]/.test(FRIEND_CODE_ALPHABET), false);
  for (let i = 0; i < 60; i++) {
    const code = generateFriendCode();
    assert.match(code, /^ARC-[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(/[0O1I]/.test(code.slice(4)), false);
  }
  const deterministic = generateFriendCode(() => 0);
  assert.equal(deterministic, 'ARC-AAAA');
});

test('generateRoomCode produces SQ-XXXX without confusing chars and constants match spec', () => {
  for (let i = 0; i < 40; i++) {
    const code = generateRoomCode();
    assert.match(code, /^SQ-[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(/[0O1I]/.test(code.slice(3)), false);
  }
  assert.equal(MAX_SQUAD_SIZE, 4);
  assert.equal(INVITE_TTL_MS, 45000);
});

test('validateChampionName enforces 3-12 alphanumeric/underscore bounds', () => {
  assert.equal(validateChampionName('Ab').valid, false);
  assert.equal(validateChampionName('   ').valid, false);
  assert.equal(validateChampionName('!!!@@@').valid, false);
  assert.equal(validateChampionName('ThirteenCharsX').valid, false);
  const ok = validateChampionName('Arcane_99');
  assert.equal(ok.valid, true);
  assert.equal(ok.cleaned, 'Arcane_99');
});

test('sanitizeChampionId and sanitizeUnlockedChampions normalize legacy IDs and keep BERSERKER', () => {
  assert.equal(sanitizeChampionId('MAGE'), 'TIDECALLER');
  assert.equal(sanitizeChampionId('ASSASSIN'), 'SHADOW');
  assert.equal(sanitizeChampionId('UNKNOWN'), 'BERSERKER');
  const unlocked = sanitizeUnlockedChampions(['MAGE', 'SHADOW', 'MAGE']);
  assert.deepEqual(unlocked, ['BERSERKER', 'TIDECALLER', 'SHADOW']);
});

test('mergeProfileConflict preserves highest progression, currencies, stat tiers, unlocks, and HUD layouts', () => {
  const local = {
    displayName: 'LocalHero',
    friendCode: 'ARC-K7M2',
    level: 12,
    xp: 420,
    coins: 9999,
    crystals: 300,
    gems: 50,
    unlockedChampions: ['BERSERKER', 'TIDECALLER'],
    selectedChampion: 'TIDECALLER',
    unlockedRunes: ['AETHER_SURGE'],
    unlockedTrails: ['DEFAULT', 'EMBER'],
    statTiers: { PWR: 5, FOC: 2, AGI: 1, VIT: 4 },
    careerStats: { wins: 3, elims: 25, matches: 10, damageDealt: 12000, revives: 2, top10: 7 },
    hudLayouts: { portrait: { joyX: 0.14 }, landscape: null },
    updatedAtMs: 1000,
  };
  const remote = {
    displayName: 'CloudHero',
    friendCode: 'ARC-Q9W3',
    level: 15,
    xp: 180,
    coins: 4500,
    crystals: 8200,
    gems: 120,
    unlockedChampions: ['BERSERKER', 'SHADOW'],
    selectedChampion: 'SHADOW',
    unlockedRunes: ['SHADOW_STEP'],
    unlockedTrails: ['DEFAULT', 'TIDE'],
    statTiers: { PWR: 3, FOC: 6, AGI: 4, VIT: 2 },
    careerStats: { wins: 8, elims: 19, matches: 14, damageDealt: 18500, revives: 1, top10: 9 },
    hudLayouts: { portrait: null, landscape: { joyX: 0.11 } },
    updatedAtMs: 2000,
  };

  const merged = mergeProfileConflict(local, remote);
  assert.equal(merged.level, 15);
  assert.equal(merged.xp, 180);
  assert.equal(merged.coins, 9999);
  assert.equal(merged.crystals, 8200);
  assert.equal(merged.gems, 120);
  assert.deepEqual(new Set(merged.unlockedChampions), new Set(['BERSERKER', 'TIDECALLER', 'SHADOW']));
  assert.deepEqual(new Set(merged.unlockedRunes), new Set(['AETHER_SURGE', 'SHADOW_STEP']));
  assert.deepEqual(new Set(merged.unlockedTrails), new Set(['DEFAULT', 'EMBER', 'TIDE']));
  assert.deepEqual(merged.statTiers, { PWR: 5, FOC: 6, AGI: 4, VIT: 4 });
  assert.deepEqual(merged.careerStats, {
    wins: 8,
    elims: 25,
    matches: 14,
    damageDealt: 18500,
    revives: 2,
    top10: 9,
  });
  assert.deepEqual(merged.hudLayouts.portrait, { joyX: 0.14 });
  assert.deepEqual(merged.hudLayouts.landscape, { joyX: 0.11 });
  assert.equal(merged.friendCode, 'ARC-Q9W3');
});

test('createSeededRng is deterministic for same seed and distinct across seeds', () => {
  const rngA = createSeededRng(133742);
  const rngB = createSeededRng(133742);
  const rngC = createSeededRng(999999);
  const seqA = Array.from({ length: 12 }, () => rngA());
  const seqB = Array.from({ length: 12 }, () => rngB());
  const seqC = Array.from({ length: 12 }, () => rngC());
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  for (const v of seqA) {
    assert.ok(v >= 0 && v < 1);
  }
});

test('packAoiBots filters by 600u AOI radius, tracks deadIds, and round-trips via unpackAoiBots', () => {
  assert.equal(AOI_RADIUS, 600);
  const bots = [
    { netId: 1, isAlive: true, x: 1000, y: 1000, facingAngle: 1.24, hp: 112.4, animState: 'walk', charKey: 'TIDECALLER', primedElement: 'WATER' },
    { netId: 2, isAlive: true, x: 5000, y: 5000, facingAngle: 0, hp: 140, animState: 'idle', charKey: 'BERSERKER', primedElement: null },
    { netId: 3, isAlive: false, x: 1020, y: 1020, facingAngle: 0, hp: 0, animState: 'idle', charKey: 'SHADOW', primedElement: null },
    { netId: 4, isAlive: true, x: 1550, y: 1050, facingAngle: -0.5, hp: 85, animState: 'attack', charKey: 'SHADOW', primedElement: 'DARK' },
    { netId: 5, isAlive: true, x: 1800, y: 1050, facingAngle: 0.2, hp: 90, animState: 'walk', charKey: 'BERSERKER', primedElement: 'FIRE' },
  ];
  const humans = [{ alive: true, x: 1050, y: 1050 }];
  const packed = packAoiBots(bots, humans);

  assert.equal(packed.aliveCount, 4);
  assert.deepEqual(packed.deadIds, [3]);
  // Bot 1 (70u) and Bot 4 (500u) included; Bot 2 (>5000u) and Bot 5 (750u > 600u) excluded
  assert.equal(packed.tuples.length, 2);
  assert.equal(packed.tuples[0].length, 8);

  const unpacked = unpackAoiBots(packed.tuples);
  assert.equal(unpacked.length, 2);
  assert.equal(unpacked[0].id, 1);
  assert.equal(unpacked[0].x, 1000);
  assert.equal(unpacked[0].hp, 112);
  assert.equal(unpacked[0].animState, 'walk');
  assert.equal(unpacked[0].charKey, 'TIDECALLER');
  assert.equal(unpacked[0].primedElement, 'WATER');
  assert.equal(unpacked[1].id, 4);
  assert.equal(unpacked[1].animState, 'attack');
  assert.equal(unpacked[1].charKey, 'SHADOW');
  assert.equal(unpacked[1].primedElement, 'DARK');
});

test('electNextHostUid picks lowest connected non-stalled human UID and skips sim mates', () => {
  const now = 50_000;
  const members = {
    uid_c: { connected: true, isSimMate: false },
    uid_a: { connected: false, isSimMate: false },
    uid_b: { connected: true, isSimMate: false },
    mate_0: { connected: true, isSimMate: true },
  };
  const players = {
    uid_c: { connected: true, hb: now - 1000 },
    uid_a: { connected: false, hb: now - 10000 },
    uid_b: { connected: true, hb: now - (HOST_STALL_MS + 500) }, // stalled > 6s
  };
  assert.equal(electNextHostUid(members, players, now), 'uid_c');

  // If uid_b recovers heartbeat, uid_b < uid_c wins deterministically
  players.uid_b.hb = now - 500;
  assert.equal(electNextHostUid(members, players, now), 'uid_b');

  // If nobody is connected, returns null
  assert.equal(electNextHostUid({ mate_0: { connected: true, isSimMate: true } }, {}, now), null);
});

test('createIntentDeduplicator rejects duplicates and prunes expired TTL entries', () => {
  const dedup = createIntentDeduplicator(3000);
  assert.equal(dedup.accept('hit_1', 1000), true);
  assert.equal(dedup.accept('hit_1', 1500), false);
  assert.equal(dedup.accept('hit_2', 2000), true);
  assert.equal(dedup.size(), 2);

  dedup.prune(4500); // hit_1 is 3500ms old (>3000), hit_2 is 2500ms old
  assert.equal(dedup.size(), 1);
  assert.equal(dedup.accept('hit_1', 4600), true);
});

test('100ms interpolation buffer interpolates smoothly, wraps angles, and caps extrapolation', () => {
  assert.equal(INTERP_DELAY_MS, 100);
  const buf = createInterpBuffer();
  const out = { x: 0, y: 0, a: 0 };

  pushInterpSample(buf, 100, 200, 3.0, 100, 0, 1000);
  pushInterpSample(buf, 200, 300, -3.0, 100, 0, 1100);

  // At nowMs=1150, renderT=1050 (midpoint between 1000 and 1100)
  sampleInterpBuffer(buf, 1150, out);
  assert.equal(Math.round(out.x), 150);
  assert.equal(Math.round(out.y), 250);
  // Shortest angle wrap between +3.0 and -3.0 passes near ±π (not 0)
  assert.ok(Math.abs(out.a) > 2.9);

  // Far in the future -> extrapolation capped at 160ms * 0.65 damping = 10.4u max on vx=100
  sampleInterpBuffer(buf, 5000, out);
  assert.ok(out.x > 200 && out.x <= 211);
  assert.equal(out.y, 300);
});

test('Quick-Comms and Squad Color palettes match 6 callouts and 4 distinct squad colors', () => {
  assert.equal(QUICK_COMMS_OPTIONS.length, 6);
  assert.equal(SQUAD_COLORS.length, 4);
  assert.equal(new Set(SQUAD_COLORS).size, 4);
});

test('Asset & APK contracts: 6 verbatim PNGs, Local-First + Remote-Fallback, Berserker spelling, mobile popup+redirect Auth & zero SW', () => {
  const expectedPngs = [
    'Beserker_Portrait.png',
    'Beserker_Sprite.png',
    'Tidecaller_Portrait.png',
    'Tidecaller_Sprite.png',
    'Shadow_Portrait.png',
    'Shadow_Sprite.png',
  ];
  for (const file of expectedPngs) {
    const full = path.join(ROOT, 'assets', 'Image', file);
    assert.ok(fs.existsSync(full), `Missing local asset ${file}`);
    const head = fs.readFileSync(full).subarray(0, 4);
    assert.deepEqual(Array.from(head), [0x89, 0x50, 0x4e, 0x47], `${file} is not a valid PNG`);
  }

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(html.includes("CHARACTER_ASSET_LOCAL_BASE = './assets/Image/'"));
  assert.ok(
    html.includes("CHARACTER_ASSET_REMOTE_BASE = 'https://zakiyt654321-gif.github.io/Arcane-Royal-Try3/assets/Image/'")
  );
  for (const file of expectedPngs) {
    assert.ok(html.includes(`CHARACTER_ASSET_LOCAL_BASE + '${file}'`), `Missing local-first binding for ${file}`);
    assert.ok(html.includes(`CHARACTER_ASSET_REMOTE_BASE + '${file}'`), `Missing remote fallback for ${file}`);
  }
  assert.ok(html.includes('The Berserker'));
  assert.equal(html.includes('The Beserker'), false, 'UI must spell hero name "The Berserker"');
  assert.equal(html.includes('serviceWorker.register'), false, 'No offline Service Worker registration allowed');
  assert.ok(html.includes('href="./manifest.json"'));

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'manifest.json'), 'utf8'));
  assert.equal(manifest.display, 'fullscreen');
  assert.equal(manifest.orientation, 'any');

  // Verify Google Sign-In tries native APK bridge, then signInWithPopup with automatic signInWithRedirect + getRedirectResult fallback
  const authCode = fs.readFileSync(path.join(ROOT, 'src', 'authService.js'), 'utf8');
  assert.ok(authCode.includes('signInWithPopup'), 'Google Sign-In must try signInWithPopup first on mobile/web');
  assert.ok(authCode.includes('signInWithRedirect'), 'Google Sign-In must fall back to signInWithRedirect when popups are blocked');
  assert.ok(authCode.includes('getRedirectResult'), 'Auth init must complete getRedirectResult on mobile return');
});

test('evaluateSquadMatchOutcome handles Squad Victory (alive or spectating), Spectating, and Squad Wipe', async () => {
  const { evaluateSquadMatchOutcome } = await import('../squadMultiplayer.js');
  // 2 squadmates alive, 0 hostiles -> Squad Victory without friendly fire soft-lock
  assert.equal(evaluateSquadMatchOutcome(true, 1, 0), 'victory');
  // Local player bled out, surviving teammate kills last bot -> Squad Victory
  assert.equal(evaluateSquadMatchOutcome(false, 1, 0), 'victory');
  // Local player bled out while teammate fights remaining bots -> Spectating
  assert.equal(evaluateSquadMatchOutcome(false, 2, 5), 'spectating');
  // Local player dead & last squadmate falls -> Squad Wipe
  assert.equal(evaluateSquadMatchOutcome(false, 0, 5), 'squad_wipe');
  // Normal active combat
  assert.equal(evaluateSquadMatchOutcome(true, 1, 48), 'playing');
});

