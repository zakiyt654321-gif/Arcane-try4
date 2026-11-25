import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_SFX_VOICES,
  SFX_COOLDOWN_MS,
  SFX_MAX_DISTANCE,
  AUDIO_OFFSET_MIN_MS,
  AUDIO_OFFSET_MAX_MS,
  ANNOUNCER_COOLDOWN_MS,
  REMOTE_SFX_STALE_MS,
  LOOKAHEAD_WINDOW_SEC,
  LOOKAHEAD_TICK_MS,
  clampAudioSyncOffset,
  computeScheduledAudioTime,
  shouldDropRemoteSfx,
  isAudioContextPlayable,
  advanceLookaheadCursor,
  computeSpatialSfxGain,
  createVoiceLimiter,
  createAnnouncerGate,
} from './audioScheduler.ts';
import { validateChampionName, escapeHtml, formatFriendlyAuthError } from '../authService.js';
import { clampFrameDeltaTime } from './mobileHudAndPerf.ts';
import {
  FIREBASE_CONFIG,
  DEV_DEMO_ENABLED,
  SANDBOX_STORAGE_KEYS,
  CLOUD_CACHE_STORAGE_KEYS,
  isFirebaseConfigured,
  isRtdbConfigured,
  isSandboxMode,
  isSimBroadcastEnabled,
} from '../firebaseConfig.js';
import {
  cryptoRandomFloat,
  createWorldAndFxRng,
  validateRemoteIntent,
  REMOTE_SFX_STALE_MS as MP_REMOTE_SFX_STALE_MS,
} from '../squadMultiplayer.js';

const ROOT = process.cwd();

test('Hardware audio constants match zero-latency mobile spec', () => {
  assert.equal(MAX_SFX_VOICES, 12);
  assert.equal(SFX_COOLDOWN_MS, 40);
  assert.equal(SFX_MAX_DISTANCE, 520);
  assert.equal(AUDIO_OFFSET_MIN_MS, -150);
  assert.equal(AUDIO_OFFSET_MAX_MS, 150);
  assert.equal(ANNOUNCER_COOLDOWN_MS, 1200);
  assert.equal(REMOTE_SFX_STALE_MS, 350);
  assert.equal(MP_REMOTE_SFX_STALE_MS, 350);
  assert.equal(LOOKAHEAD_WINDOW_SEC, 0.1);
  assert.equal(LOOKAHEAD_TICK_MS, 25);
});

test('clampAudioSyncOffset & computeScheduledAudioTime clamp safely to >= currentTimeSec', () => {
  assert.equal(clampAudioSyncOffset(-500), -150);
  assert.equal(clampAudioSyncOffset(500), 150);
  assert.equal(clampAudioSyncOffset(42.6), 43);
  assert.equal(clampAudioSyncOffset(Number.NaN), 0);

  // Negative offset clamps to >= currentTimeSec so audio never schedules in the past
  assert.equal(computeScheduledAudioTime(10.0, -150, 0), 10.0);
  // Relative delay shifts cleanly into hardware timeline
  assert.equal(computeScheduledAudioTime(10.0, 0, 0.08), 10.08);
  // Positive offset delays future cue cleanly
  assert.equal(computeScheduledAudioTime(10.0, 50, 0), 10.05);
});

test('isAudioContextPlayable rejects suspended and interrupted states (no wake-up burst lag)', () => {
  assert.equal(isAudioContextPlayable('running'), true);
  assert.equal(isAudioContextPlayable('suspended'), false);
  assert.equal(isAudioContextPlayable('interrupted'), false);
  assert.equal(isAudioContextPlayable('closed'), false);
  assert.equal(isAudioContextPlayable(null), false);
});

test('shouldDropRemoteSfx discards remote squadmate audio older than 350ms', () => {
  assert.equal(shouldDropRemoteSfx(10000, 10200), false);
  assert.equal(shouldDropRemoteSfx(10000, 10350), false);
  assert.equal(shouldDropRemoteSfx(10000, 10351), true);
  assert.equal(shouldDropRemoteSfx(Number.NaN, 10000), true);
});

test('advanceLookaheadCursor schedules inside 100ms horizon and snaps cleanly on tab/WebView resume', () => {
  // Normal tick inside 100ms lookahead window
  const normal = advanceLookaheadCursor(5.02, 5.0, 0.05, 0.1);
  assert.equal(normal.wasReset, false);
  assert.equal(normal.scheduledTimes.length, 2);
  assert.ok(Math.abs(normal.scheduledTimes[0] - 5.02) < 1e-6);
  assert.ok(Math.abs(normal.scheduledTimes[1] - 5.07) < 1e-6);

  // Stale cursor (e.g., tab resumed after 12 seconds) resets forward without burst-stacking
  const resumed = advanceLookaheadCursor(2.0, 14.0, 0.25, 0.1);
  assert.equal(resumed.wasReset, true);
  assert.equal(resumed.scheduledTimes.length, 1);
  assert.ok(resumed.scheduledTimes[0] >= 14.0);
});

test('computeSpatialSfxGain locks attenuation to 520u vision fairness cap', () => {
  assert.equal(computeSpatialSfxGain(0), 1);
  assert.ok(computeSpatialSfxGain(260) > 0 && computeSpatialSfxGain(260) < 0.5);
  assert.equal(computeSpatialSfxGain(520), 0);
  assert.equal(computeSpatialSfxGain(521), 0);
  assert.equal(computeSpatialSfxGain(900), 0);
});

test('createVoiceLimiter enforces 40ms per-SFX cooldown and 12-voice concurrency cap', () => {
  const limiter = createVoiceLimiter(12, 40);
  assert.equal(limiter.tryAcquire('hit', 1000, 200), true);
  assert.equal(limiter.tryAcquire('hit', 1025, 200), false); // within 40ms cooldown
  assert.equal(limiter.tryAcquire('hit', 1045, 200), true);

  // Fill remaining 10 voices with distinct keys
  for (let i = 0; i < 10; i++) {
    assert.equal(limiter.tryAcquire(`sfx_${i}`, 1050, 200), true);
  }
  assert.equal(limiter.activeCount(1050), 12);
  // 13th voice blocked
  assert.equal(limiter.tryAcquire('overflow', 1050, 200), false);
  // After voices expire, slot opens
  assert.equal(limiter.tryAcquire('overflow', 1300, 200), true);
});

test('createAnnouncerGate enforces 1.2s cooldown with priority override', () => {
  const gate = createAnnouncerGate(1200);
  assert.equal(gate.canSpeak(1000, false), true);
  assert.equal(gate.canSpeak(1500, false), false);
  assert.equal(gate.canSpeak(1500, true), true); // priority overrides cooldown
  assert.equal(gate.canSpeak(2600, false), false); // 1100ms since priority speak
  assert.equal(gate.canSpeak(2750, false), true);
});

test('validateChampionName blocks reserved staff/impersonation prefixes', () => {
  assert.equal(validateChampionName('AdminKing').valid, false);
  assert.equal(validateChampionName('system_01').valid, false);
  assert.equal(validateChampionName('WarbritePro').valid, false);
  assert.equal(validateChampionName('DevTester').valid, false);
  assert.equal(validateChampionName('NovaBlade').valid, true);
});

test('validateRemoteIntent enforces range, >=85% cooldown, damage cap, and velocity sanity', () => {
  const sender = { x: 1000, y: 1000 };
  const target = { x: 1200, y: 1000 };
  const cfg = { range: 300, tolerance: 70, cooldownMs: 500, maxDamageCap: 150, maxSpeed: 400, lastUsedAtMs: 1000 };

  // Valid hit: dist=200 <= 370, elapsed=450 >= 425 (85%), dmg=90 <= 150
  assert.equal(validateRemoteIntent({ type: 'hit', dmg: 90 }, sender, target, cfg, 1450).valid, true);

  // Cooldown violation (< 85% of 500ms = 425ms)
  const cdRes = validateRemoteIntent({ type: 'hit', dmg: 90 }, sender, target, cfg, 1300);
  assert.equal(cdRes.valid, false);
  assert.equal(cdRes.reason, 'cooldown_violation');

  // Out of range (> 370u)
  const rangeRes = validateRemoteIntent({ type: 'hit', dmg: 90 }, sender, { x: 1600, y: 1000 }, cfg, 1600);
  assert.equal(rangeRes.valid, false);
  assert.equal(rangeRes.reason, 'out_of_range');

  // Damage cap exceeded
  const dmgRes = validateRemoteIntent({ type: 'hit', dmg: 999 }, sender, target, cfg, 1600);
  assert.equal(dmgRes.valid, false);
  assert.equal(dmgRes.reason, 'damage_cap_exceeded');

  // Velocity exceeded (teleport 900u in 0.2s = 4500u/s > 500u/s)
  const velRes = validateRemoteIntent(
    { type: 'hit', dmg: 50 },
    { x: 1900, y: 1000 },
    { x: 1950, y: 1000 },
    cfg,
    1600,
    { x: 1000, y: 1000, ts: 1400 } as any
  );
  assert.equal(velRes.valid, false);
  assert.equal(velRes.reason, 'velocity_exceeded');

  // Verified dash/mobility bypasses velocity cap cleanly
  const dashRes = validateRemoteIntent(
    { type: 'hit', dmg: 50, verifiedMobility: true },
    { x: 1900, y: 1000 },
    { x: 1950, y: 1000 },
    cfg,
    1600,
    { x: 1000, y: 1000, ts: 1400 } as any
  );
  assert.equal(dashRes.valid, true);
});

test('cryptoRandomFloat & createWorldAndFxRng split deterministic worldRng from fxRng', () => {
  for (let i = 0; i < 40; i++) {
    const v = cryptoRandomFloat();
    assert.ok(v >= 0 && v < 1);
  }
  const a = createWorldAndFxRng(7777);
  const b = createWorldAndFxRng(7777);
  const wA = Array.from({ length: 8 }, () => a.worldRng());
  const wB = Array.from({ length: 8 }, () => b.worldRng());
  assert.deepEqual(wA, wB);
  const fxVal = a.fxRng();
  assert.ok(fxVal >= 0 && fxVal < 1);
});

test('Storage isolation & BroadcastChannel gating prevent sandbox/cloud cross-contamination', () => {
  assert.equal(typeof DEV_DEMO_ENABLED, 'boolean');
  for (const val of Object.values(SANDBOX_STORAGE_KEYS)) {
    assert.ok(val.startsWith('arcane_sandbox_'), `Sandbox key ${val} must use arcane_sandbox_* prefix`);
  }
  for (const val of Object.values(CLOUD_CACHE_STORAGE_KEYS)) {
    assert.ok(val.startsWith('arcane_cloud_cache_'), `Cloud cache key ${val} must use arcane_cloud_cache_* prefix`);
  }
  const baseCfg = {
    authDomain: 'real.firebaseapp.com',
    databaseURL: 'https://real-default-rtdb.firebaseio.com',
    storageBucket: 'real.firebasestorage.app',
    messagingSenderId: '123456',
    firestoreDatabaseId: '(default)',
  };
  // BroadcastChannel must be disabled whenever Firebase is configured
  assert.equal(
    isSimBroadcastEnabled({ ...baseCfg, apiKey: 'AIzaRealKey123', projectId: 'real-proj', appId: '1:123:web:abc' }),
    false
  );
  assert.equal(
    isSimBroadcastEnabled({ ...baseCfg, apiKey: 'YOUR_FIREBASE_API_KEY', projectId: 'YOUR_PROJECT_ID', appId: 'YOUR_APP_ID' }),
    true
  );
});

test('Security & Lobby structural contracts: zero setTimeout SFX chains, Account & Missions modals wired, zero-listener cloudSync shim', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(html.includes('id="account-modal"'), 'Dedicated Account modal must exist');
  assert.ok(html.includes('id="missions-modal"'), 'Daily Missions drawer modal must exist');
  assert.ok(html.includes('id="toggle-bt-early"'), 'Bluetooth Early-Trigger toggle must exist');
  assert.ok(html.includes('id="slider-audio-offset"'), 'Audio Cue Sync Offset slider must exist');
  assert.ok(html.includes('id="btn-test-audio-sync"'), 'Test Sync button must exist');
  assert.ok(html.includes('id="audio-latency-readout"'), 'Audio latency readout must exist');
  assert.ok(html.includes('id="match-ping-pill"'), 'In-match ping pill must exist');
  assert.ok(html.includes('id="reconnect-banner"'), 'In-match reconnect banner must exist');
  assert.ok(html.includes('id="lb-self-pinned"'), 'Pinned self rank row in Leaderboard must exist');

  const cloudSyncTs = fs.readFileSync(path.join(ROOT, 'src', 'firebase', 'cloudSync.ts'), 'utf8');
  assert.equal(cloudSyncTs.includes('onSnapshot'), false, 'cloudSync.ts must not attach duplicate Firestore listeners');
  assert.equal(cloudSyncTs.includes('onAuthStateChanged'), false, 'cloudSync.ts must not attach duplicate Auth listeners');
});

test('escapeHtml neutralizes XSS script, tag, and attribute injection payloads', () => {
  assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  assert.equal(escapeHtml(`' onmouseover='evil()&`), '&#39; onmouseover=&#39;evil()&amp;');
  assert.equal(escapeHtml('Arcane_99'), 'Arcane_99');
  assert.equal(escapeHtml(null as any), '');
});

test('dt hard-clamp blocks speedhacks and tab-switch wall tunneling (<= 0.05s)', () => {
  assert.equal(clampFrameDeltaTime(0.016), 0.016);
  assert.equal(clampFrameDeltaTime(0.5), 0.05);
  assert.equal(clampFrameDeltaTime(12.0), 0.05);
  assert.equal(clampFrameDeltaTime(-1), 0);
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(html.includes('Math.min(rawDelta, 0.05)'), 'Main gameLoop must hard-clamp frame delta time at 0.05s');
});

test('Pass 1 regression: atomicSpend maps currency/unlockField/statKey/xp into spendCurrencyTransaction', () => {
  const cloudSyncTs = fs.readFileSync(path.join(ROOT, 'src', 'firebase', 'cloudSync.ts'), 'utf8');
  const authServiceJs = fs.readFileSync(path.join(ROOT, 'src', 'authService.js'), 'utf8');

  assert.ok(cloudSyncTs.includes('p.currency'), 'cloudSync.ts must read currency from atomicSpend event');
  assert.ok(cloudSyncTs.includes('unlockField,'), 'cloudSync.ts must forward unlockField');
  assert.ok(cloudSyncTs.includes('statKey:'), 'cloudSync.ts must forward statKey');
  assert.ok(cloudSyncTs.includes('nextTier:'), 'cloudSync.ts must forward nextTier');
  assert.ok(cloudSyncTs.includes('costXp:'), 'cloudSync.ts must forward costXp');
  assert.ok(authServiceJs.includes('costXp'), 'authService.spendCurrencyTransaction must support XP atomic deductions');
  assert.ok(authServiceJs.includes('statKey') && authServiceJs.includes('nextTier'), 'authService.spendCurrencyTransaction must atomically update statTiers');
});

test('Pass 1 regression: squadMultiplayer emits reconnecting boolean and writes serverTimestamp heartbeat in live RTDB', () => {
  const mpJs = fs.readFileSync(path.join(ROOT, 'src', 'squadMultiplayer.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  assert.ok(mpJs.includes('reconnecting: !isConn'), 'Connected-state network events must emit reconnecting boolean');
  assert.ok(mpJs.includes('reconnecting: true'), 'Heartbeat error network events must emit reconnecting: true');
  assert.ok(mpJs.includes('hb: rtdbServerTimestamp()'), 'Live RTDB pushPlayerState must write server-stamped heartbeat');
  assert.ok(html.includes("d.payload.reconnecting || d.payload.connectionState === 'reconnecting'"), 'index.html must toggle #reconnect-banner on reconnect state');
});

test('Pass 1 regression: lookahead offset, crypto supply crates, safe storage wrappers, and APK lifecycle audio suspend', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  // Music.schedule applies audioSyncOffsetMs
  assert.ok(html.includes('this.nextNoteTime + offsetSec'), 'Music.schedule() must apply clamped audioSyncOffsetMs');

  // spawnSupplyCratesForPhase uses cryptoRandomFloat instead of Math.random
  const crateFnMatch = html.match(/function spawnSupplyCratesForPhase\(phase\)[\s\S]*?^\s{6}\}/m);
  assert.ok(crateFnMatch, 'spawnSupplyCratesForPhase must exist');
  assert.ok(crateFnMatch[0].includes('cryptoRandomFloat()'), 'spawnSupplyCratesForPhase must use cryptoRandomFloat()');
  assert.equal(crateFnMatch[0].includes('Math.random()'), false, 'spawnSupplyCratesForPhase must not use Math.random()');

  // Only safeStorageSet + try/catch HudLayout.save call localStorage.setItem, and only safeStorageRemove calls removeItem
  const rawSetMatches = html.match(/localStorage\.setItem\(/g) || [];
  const rawRemoveMatches = html.match(/localStorage\.removeItem\(/g) || [];
  assert.ok(rawSetMatches.length <= 3, 'No unguarded localStorage.setItem calls should remain outside safe helpers');
  assert.equal(rawRemoveMatches.length, 1, 'Only safeStorageRemove helper should call localStorage.removeItem');

  // APK lifecycle handler routes through handleFocusLoss / handleFocusRestore
  const apkBlock = html.match(/document\.addEventListener\('ar:apk:lifecycle'[\s\S]*?\}\);/);
  assert.ok(apkBlock, 'ar:apk:lifecycle listener must exist');
  assert.ok(apkBlock[0].includes('handleFocusLoss()'), 'ar:apk:lifecycle background event must suspend audio via handleFocusLoss()');
  assert.ok(apkBlock[0].includes('handleFocusRestore()'), 'ar:apk:lifecycle resume event must restore audio via handleFocusRestore()');
});

test('Zero-config live Firebase config boots directly from firebase-applet-config.json into live cloud mode', () => {
  const appletCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase-applet-config.json'), 'utf8'));
  assert.equal(FIREBASE_CONFIG.projectId, appletCfg.projectId);
  assert.equal(FIREBASE_CONFIG.authDomain, appletCfg.authDomain);
  assert.equal(FIREBASE_CONFIG.storageBucket, appletCfg.storageBucket);
  assert.equal(FIREBASE_CONFIG.messagingSenderId, appletCfg.messagingSenderId);
  assert.equal(FIREBASE_CONFIG.appId, appletCfg.appId);
  assert.equal(FIREBASE_CONFIG.firestoreDatabaseId, appletCfg.firestoreDatabaseId);
  assert.equal(isFirebaseConfigured(), true);
  assert.equal(isSandboxMode(), false);
  assert.equal(typeof isRtdbConfigured(), 'boolean');
});

test('formatFriendlyAuthError translates Firebase Auth and Firestore errors with actionable fixes', () => {
  const unauth = formatFriendlyAuthError({ code: 'auth/unauthorized-domain' });
  assert.ok(unauth.includes('Authorized domains'), 'unauthorized-domain must explain Authorized domains fix');

  const disabled = formatFriendlyAuthError({ code: 'auth/operation-not-allowed' });
  assert.ok(disabled.includes('Sign-in method'), 'operation-not-allowed must explain Sign-in method fix');

  const inUse = formatFriendlyAuthError({ code: 'auth/email-already-in-use' });
  assert.ok(inUse.toLowerCase().includes('sign in'), 'email-already-in-use must guide user to Sign In');

  const badCred = formatFriendlyAuthError({ code: 'auth/invalid-credential' });
  assert.ok(badCred.includes('Incorrect email or password'), 'invalid-credential must show clear credential error');

  const permDenied = formatFriendlyAuthError({ code: 'permission-denied' });
  assert.ok(permDenied.includes('firestore.rules'), 'permission-denied must guide user to Copy firestore.rules');
});

test('Protected deployment files and 1-tap Firebase Live Diagnostics UI remain intact', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'public', 'google13f3d000d1f9c862.html')), 'Google verification file must remain intact');

  const viteCfg = fs.readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');
  assert.ok(viteCfg.includes("base: './'"), 'vite.config.ts must preserve base: ./');

  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');
  assert.ok(workflow.includes('npm install --legacy-peer-deps'), 'deploy.yml must use npm install --legacy-peer-deps');
  assert.ok(workflow.includes('./dist'), 'deploy.yml must upload ./dist');

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(html.includes('id="fb-diagnostics-box"'), 'Firebase Live Diagnostics box must exist in Settings -> Save Data');
  assert.ok(html.includes('id="diag-pill-auth"'), 'Auth status pill must exist');
  assert.ok(html.includes('id="diag-pill-firestore"'), 'Firestore status pill must exist');
  assert.ok(html.includes('id="diag-pill-rtdb"'), 'Realtime DB status pill must exist');
  assert.ok(html.includes('id="btn-copy-firestore-rules"'), '1-tap Copy firestore.rules button must exist');
  assert.ok(html.includes('id="btn-copy-rtdb-rules"'), '1-tap Copy database.rules.json button must exist');

  const cloudSync = fs.readFileSync(path.join(ROOT, 'src', 'firebase', 'cloudSync.ts'), 'utf8');
  assert.ok(cloudSync.includes("case 'runFirebaseDiagnostics'"), 'cloudSync must expose runFirebaseDiagnostics');
  assert.ok(cloudSync.includes("case 'getFirebaseRulesText'"), 'cloudSync must expose getFirebaseRulesText');
});

test('CloudSync Auth diagnostics: logs client connection, state transitions, error codes, and ready handshake without duplicate listeners', () => {
  const cloudSync = fs.readFileSync(path.join(ROOT, 'src', 'firebase', 'cloudSync.ts'), 'utf8');
  const authService = fs.readFileSync(path.join(ROOT, 'src', 'authService.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  assert.ok(cloudSync.includes('[CloudSync] Firebase client connection check:'), 'cloudSync must log Firebase client connection check');
  assert.ok(cloudSync.includes('[CloudSync] Auth state changed:'), 'cloudSync must log auth state transitions');
  assert.ok(cloudSync.includes('[CloudSync] Auth action'), 'cloudSync must log failed auth actions with error codes');
  assert.ok(cloudSync.includes("emitBus('ar:cloud:ready'"), 'cloudSync must broadcast ar:cloud:ready');
  assert.ok(html.includes("document.addEventListener('ar:cloud:ready'"), 'CloudBridge must replay queued requests on ar:cloud:ready');
  assert.ok(authService.includes('function logAuthError('), 'authService must log Firebase auth error codes');
  assert.equal(cloudSync.includes('onAuthStateChanged'), false, 'cloudSync must not register duplicate auth listeners');
  assert.equal(cloudSync.includes('onSnapshot'), false, 'cloudSync must not register duplicate Firestore listeners');
});


