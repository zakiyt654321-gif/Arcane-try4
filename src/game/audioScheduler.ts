/**
 * Pure, testable hardware-locked audio scheduling, lookahead, stale-drop,
 * and voice-limiting primitives mirroring index.html's AudioEngine + Announcer.
 */

export const MAX_SFX_VOICES = 12;
export const SFX_COOLDOWN_MS = 40;
export const SFX_MAX_DISTANCE = 520;
export const AUDIO_OFFSET_MIN_MS = -150;
export const AUDIO_OFFSET_MAX_MS = 150;
export const ANNOUNCER_COOLDOWN_MS = 1200;
export const REMOTE_SFX_STALE_MS = 350;
export const LOOKAHEAD_WINDOW_SEC = 0.1;
export const LOOKAHEAD_TICK_MS = 25;

export function clampAudioSyncOffset(ms: number): number {
  const num = Number(ms);
  if (!Number.isFinite(num)) return 0;
  return Math.max(AUDIO_OFFSET_MIN_MS, Math.min(AUDIO_OFFSET_MAX_MS, Math.round(num)));
}

/**
 * Hardware-clock audio cue alignment. Supports -150ms..+150ms signed offset
 * while clamping final start time to >= currentTimeSec so Web Audio never clips past zero.
 */
export function computeScheduledAudioTime(
  currentTimeSec: number,
  offsetMs: number = 0,
  relativeDelaySec: number = 0
): number {
  const base = Math.max(0, Number(currentTimeSec) || 0);
  const clampedOffsetSec = clampAudioSyncOffset(offsetMs) / 1000;
  const rel = Math.max(0, Number(relativeDelaySec) || 0);
  return Math.max(base, base + clampedOffsetSec + rel);
}

/**
 * Drop remote squadmate SFX events older than 350ms so lag spikes never fire ghostly late sounds.
 */
export function shouldDropRemoteSfx(
  eventTimestampMs: number,
  nowMs: number,
  maxStaleMs: number = REMOTE_SFX_STALE_MS
): boolean {
  const ts = Number(eventTimestampMs);
  const now = Number(nowMs);
  if (!Number.isFinite(ts) || !Number.isFinite(now)) return true;
  return now - ts > maxStaleMs;
}

/**
 * No Wake-Up Burst Lag: drop SFX whenever AudioContext is not actively running.
 */
export function isAudioContextPlayable(state: string | null | undefined): boolean {
  return state === 'running';
}

/**
 * Lookahead cursor calculation with clean resume reset so tab throttling never causes burst-stacking.
 */
export function advanceLookaheadCursor(
  nextNoteTimeSec: number,
  currentTimeSec: number,
  stepSec: number,
  lookaheadSec: number = LOOKAHEAD_WINDOW_SEC
): { scheduledTimes: number[]; nextCursorSec: number; wasReset: boolean } {
  const now = Math.max(0, Number(currentTimeSec) || 0);
  const step = Math.max(0.02, Number(stepSec) || 0.25);
  let cursor = Number(nextNoteTimeSec);
  let wasReset = false;

  // If cursor fell behind currentTime (e.g., after background suspend/throttle), snap forward cleanly
  if (!Number.isFinite(cursor) || cursor < now - 0.05) {
    cursor = now + 0.02;
    wasReset = true;
  }

  const scheduledTimes: number[] = [];
  const horizon = now + Math.max(0.02, lookaheadSec);
  let guard = 0;
  while (cursor < horizon && guard < 16) {
    scheduledTimes.push(cursor);
    cursor += step;
    guard++;
  }
  return { scheduledTimes, nextCursorSec: cursor, wasReset };
}

/**
 * Spatial SFX attenuation locked to the 520u fairness vision cap.
 * Returns 0 when distance exceeds 520u so off-screen combat cannot leak audio or burn voices.
 */
export function computeSpatialSfxGain(
  distanceUnits: number,
  maxDistance: number = SFX_MAX_DISTANCE
): number {
  const d = Math.max(0, Number(distanceUnits) || 0);
  const cap = Math.max(1, Number(maxDistance) || SFX_MAX_DISTANCE);
  if (d > cap) return 0;
  const norm = 1 - d / cap;
  return Math.round(norm * norm * 1000) / 1000;
}

export interface VoiceLimiter {
  tryAcquire(sfxKey: string, nowMs: number, durationMs?: number): boolean;
  activeCount(nowMs: number): number;
  reset(): void;
}

export function createVoiceLimiter(
  maxVoices: number = MAX_SFX_VOICES,
  cooldownMs: number = SFX_COOLDOWN_MS
): VoiceLimiter {
  const activeExpiry: number[] = [];
  const lastPlayedByKey = new Map<string, number>();

  function prune(nowMs: number) {
    for (let i = activeExpiry.length - 1; i >= 0; i--) {
      if (activeExpiry[i] <= nowMs) {
        activeExpiry.splice(i, 1);
      }
    }
  }

  return {
    tryAcquire(sfxKey: string, nowMs: number, durationMs: number = 180): boolean {
      prune(nowMs);
      const prev = lastPlayedByKey.get(sfxKey);
      if (prev !== undefined && nowMs - prev < cooldownMs) {
        return false;
      }
      if (activeExpiry.length >= maxVoices) {
        return false;
      }
      lastPlayedByKey.set(sfxKey, nowMs);
      activeExpiry.push(nowMs + Math.max(16, durationMs));
      return true;
    },
    activeCount(nowMs: number): number {
      prune(nowMs);
      return activeExpiry.length;
    },
    reset(): void {
      activeExpiry.length = 0;
      lastPlayedByKey.clear();
    },
  };
}

export interface AnnouncerGate {
  canSpeak(nowMs: number, priority?: boolean): boolean;
  reset(): void;
}

export function createAnnouncerGate(cooldownMs: number = ANNOUNCER_COOLDOWN_MS): AnnouncerGate {
  let lastSpokenAt = -Infinity;
  return {
    canSpeak(nowMs: number, priority: boolean = false): boolean {
      if (!priority && nowMs - lastSpokenAt < cooldownMs) {
        return false;
      }
      lastSpokenAt = nowMs;
      return true;
    },
    reset(): void {
      lastSpokenAt = -Infinity;
    },
  };
}
