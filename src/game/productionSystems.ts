/**
 * Pure production systems logic for Arcane Royale:
 * - Demo Supply Drop constants (9,999 all currencies)
 * - Tamper-evident salted save checksum signing & verification
 * - Player name sanitization (HTML/special char stripping + profanity filter)
 * - Ad monetization cadence, Vault claim cooldowns, and verified reward tokens
 */

export const DEMO_SUPPLY_GRANT = Object.freeze({
  gold: 9999,
  astralCrystals: 9999,
  gems: 9999,
  xp: 9999,
});

export const SAVE_INTEGRITY_SALT = 'AR_v3_9f4b2c7e_sig_salt_#8129';

export const PROTECTED_SAVE_FIELDS = Object.freeze([
  'gold',
  'gems',
  'astralCrystals',
  'level',
  'xp',
  'spendableXp',
  'totalXpEarned',
  'statUpgrades',
  'unlockedFighters',
  'unlockedDropSkins',
  'unlockedRunes',
  'totalMatches',
  'totalWins',
  'totalKills',
] as const);

export const DEFAULT_ECONOMY_RESET = Object.freeze({
  gold: 500,
  gems: 50,
  astralCrystals: 500,
  level: 1,
  xp: 0,
  spendableXp: 0,
  totalXpEarned: 0,
  statUpgrades: Object.freeze({ maxHealth: 0, movementSpeed: 0, attackPower: 0 }),
  unlockedFighters: Object.freeze(['BERSERKER']),
  unlockedDropSkins: Object.freeze(['RIFT']),
  unlockedRunes: Object.freeze([] as string[]),
  selectedFighter: 'BERSERKER',
  selectedDropSkin: 'RIFT',
  equippedRune: null as string | null,
});

function canonicalizeValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(Math.floor(value)) : '0';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return '[' + value.map(item => canonicalizeValue(item)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map(k => `${k}:${canonicalizeValue(obj[k])}`).join(',') + '}';
  }
  return String(value);
}

/**
 * Deterministic salted dual-32-bit FNV-1a/Murmur-mix checksum over protected save fields.
 */
export function computeSaveChecksum(saveData: Record<string, unknown>, salt = SAVE_INTEGRITY_SALT): string {
  const parts: string[] = [salt];
  for (let i = 0; i < PROTECTED_SAVE_FIELDS.length; i++) {
    const key = PROTECTED_SAVE_FIELDS[i];
    parts.push(`${key}=${canonicalizeValue(saveData[key])}`);
  }
  const payload = parts.join('|');

  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < payload.length; i++) {
    const ch = payload.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (ch + ((i + 1) * 31));
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    h2 = ((h2 << 13) | (h2 >>> 19)) >>> 0;
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 0x85ebca6b) >>> 0;
  h2 = Math.imul(h2 ^ (h2 >>> 13), 0xc2b2ae35) >>> 0;
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

export interface SaveVerificationResult {
  valid: boolean;
  tampered: boolean;
  sanitized: Record<string, unknown>;
}

/**
 * Verifies a parsed save object against its `_sig` checksum (and optional companion device signature).
 * If tampered, resets protected economy/progression fields while preserving player preferences.
 */
export function verifyAndRecoverSave(
  parsed: Record<string, unknown>,
  companionSig: string | null = null,
  salt = SAVE_INTEGRITY_SALT
): SaveVerificationResult {
  const embeddedSig = typeof parsed._sig === 'string' ? parsed._sig : null;
  const expectedSig = computeSaveChecksum(parsed, salt);

  // Legacy unsigned save (no embedded sig AND no companion sig yet) migrates cleanly on first load.
  if (!embeddedSig && !companionSig) {
    return { valid: true, tampered: false, sanitized: { ...parsed } };
  }

  const embeddedMatches = embeddedSig === expectedSig;
  const companionMatches = !companionSig || companionSig === expectedSig;

  if (embeddedSig && embeddedMatches && companionMatches) {
    return { valid: true, tampered: false, sanitized: { ...parsed } };
  }

  // Tamper detected: reset protected economy/progression fields cleanly while preserving preferences.
  const recovered: Record<string, unknown> = {
    ...parsed,
    gold: DEFAULT_ECONOMY_RESET.gold,
    gems: DEFAULT_ECONOMY_RESET.gems,
    astralCrystals: DEFAULT_ECONOMY_RESET.astralCrystals,
    level: DEFAULT_ECONOMY_RESET.level,
    xp: DEFAULT_ECONOMY_RESET.xp,
    spendableXp: DEFAULT_ECONOMY_RESET.spendableXp,
    totalXpEarned: DEFAULT_ECONOMY_RESET.totalXpEarned,
    statUpgrades: { ...DEFAULT_ECONOMY_RESET.statUpgrades },
    unlockedFighters: [...DEFAULT_ECONOMY_RESET.unlockedFighters],
    unlockedDropSkins: [...DEFAULT_ECONOMY_RESET.unlockedDropSkins],
    unlockedRunes: [...DEFAULT_ECONOMY_RESET.unlockedRunes],
    selectedFighter: DEFAULT_ECONOMY_RESET.selectedFighter,
    selectedDropSkin: DEFAULT_ECONOMY_RESET.selectedDropSkin,
    equippedRune: DEFAULT_ECONOMY_RESET.equippedRune,
  };
  return { valid: false, tampered: true, sanitized: recovered };
}

const BLOCKED_NAME_TERMS: readonly string[] = Object.freeze([
  'fuck', 'fck', 'fuk', 'shit', 'sht', 'bitch', 'btch', 'cunt', 'dick', 'cock', 'pussy', 'whore', 'slut',
  'bastard', 'asshole', 'nigger', 'nigga', 'faggot', 'fag', 'retard', 'kike',
  'chink', 'spic', 'tranny', 'nazi', 'hitler', 'rape', 'porn', 'penis', 'vagina',
]);

function normalizeForProfanityCheck(value: string): string {
  return value
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/3/g, 'e')
    .replace(/[4@]/g, 'a')
    .replace(/[5$]/g, 's')
    .replace(/7/g, 't')
    .replace(/[^a-z]/g, '');
}

/**
 * Sanitizes a 12-character player name: strips HTML tags & special chars, filters profanity/slurs.
 */
export function sanitizePlayerName(raw: unknown, fallback = 'Player'): string {
  const str = typeof raw === 'string' ? raw : '';
  // 1. Strip HTML tags
  const withoutTags = str.replace(/<[^>]*>/g, '');
  // 2. Keep only alphanumeric, spaces, underscore, hyphen
  const safeChars = withoutTags.replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, ' ').trim();
  if (!safeChars) return fallback;

  // 3. Check normalized string (catches leetspeak & spacing bypasses)
  const normalized = normalizeForProfanityCheck(safeChars);
  for (let i = 0; i < BLOCKED_NAME_TERMS.length; i++) {
    if (normalized.includes(BLOCKED_NAME_TERMS[i])) {
      return fallback;
    }
  }

  const trimmed = safeChars.slice(0, 12).trim();
  return trimmed || fallback;
}

export interface VaultAdOffer {
  id: string;
  currency: 'astralCrystals' | 'gems';
  amount: number;
  cooldownSec: number;
}

export const VAULT_AD_OFFERS: readonly VaultAdOffer[] = Object.freeze([
  Object.freeze({ id: 'vault_crystals_sm', currency: 'astralCrystals', amount: 150, cooldownSec: 60 }),
  Object.freeze({ id: 'vault_crystals_lg', currency: 'astralCrystals', amount: 400, cooldownSec: 120 }),
  Object.freeze({ id: 'vault_gems_pack', currency: 'gems', amount: 15, cooldownSec: 90 }),
]);

/**
 * Post-match interstitial fires after every 2nd completed match.
 */
export function shouldShowPostMatchInterstitial(completedMatches: number): boolean {
  return completedMatches > 0 && completedMatches % 2 === 0;
}

/**
 * Computes remaining cooldown seconds for a rewarded ad vault claim.
 */
export function getVaultCooldownRemainingSec(
  cooldownMap: Record<string, number>,
  offerId: string,
  nowMs: number
): number {
  const readyAt = Number(cooldownMap[offerId] || 0);
  if (!Number.isFinite(readyAt) || readyAt <= nowMs) return 0;
  return Math.ceil((readyAt - nowMs) / 1000);
}
