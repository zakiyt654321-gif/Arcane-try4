import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEMO_SUPPLY_GRANT,
  computeSaveChecksum,
  verifyAndRecoverSave,
  sanitizePlayerName,
  shouldShowPostMatchInterstitial,
  getVaultCooldownRemainingSec,
  VAULT_AD_OFFERS,
} from './productionSystems';

test('Demo Supply Drop grants exactly 9,999 of all four currencies', () => {
  assert.equal(DEMO_SUPPLY_GRANT.gold, 9999);
  assert.equal(DEMO_SUPPLY_GRANT.astralCrystals, 9999);
  assert.equal(DEMO_SUPPLY_GRANT.gems, 9999);
  assert.equal(DEMO_SUPPLY_GRANT.xp, 9999);
});

test('Salted save checksum validates genuine saves and detects manual currency/level tampering', () => {
  const genuineSave: Record<string, unknown> = {
    playerName: 'ArcaneHero',
    gold: 1250,
    gems: 80,
    astralCrystals: 640,
    level: 7,
    xp: 120,
    spendableXp: 300,
    totalXpEarned: 1800,
    statUpgrades: { maxHealth: 2, movementSpeed: 1, attackPower: 3 },
    unlockedFighters: ['BERSERKER', 'TIDECALLER'],
    unlockedDropSkins: ['RIFT'],
    unlockedRunes: ['VAMPIRIC_EDGE'],
    totalMatches: 6,
    totalWins: 2,
    totalKills: 19,
    musicVolume: 0.4,
  };

  const sig = computeSaveChecksum(genuineSave);
  const signed = { ...genuineSave, _sig: sig };

  // Valid signed save loads cleanly
  const okRes = verifyAndRecoverSave(signed, sig);
  assert.equal(okRes.valid, true);
  assert.equal(okRes.tampered, false);
  assert.equal(okRes.sanitized.gold, 1250);
  assert.equal(okRes.sanitized.level, 7);

  // Tampered gold in DevTools Application Storage triggers reset of corrupted fields while preserving name/settings
  const tamperedGold = { ...signed, gold: 9999999 };
  const badRes = verifyAndRecoverSave(tamperedGold, sig);
  assert.equal(badRes.valid, false);
  assert.equal(badRes.tampered, true);
  assert.equal(badRes.sanitized.gold, 500);
  assert.equal(badRes.sanitized.level, 1);
  assert.equal(badRes.sanitized.playerName, 'ArcaneHero');
  assert.equal(badRes.sanitized.musicVolume, 0.4);

  // Stripping _sig when companion signature exists is also caught as tampering
  const strippedSig = { ...genuineSave, level: 99 };
  const strippedRes = verifyAndRecoverSave(strippedSig, sig);
  assert.equal(strippedRes.valid, false);
  assert.equal(strippedRes.tampered, true);
  assert.equal(strippedRes.sanitized.level, 1);

  // Legacy unsigned save with no companion sig migrates cleanly without wiping data
  const legacyRes = verifyAndRecoverSave(genuineSave, null);
  assert.equal(legacyRes.valid, true);
  assert.equal(legacyRes.tampered, false);
  assert.equal(legacyRes.sanitized.gold, 1250);
});

test('sanitizePlayerName strips HTML tags, special characters, enforces 12-char limit, and filters profanity', () => {
  assert.equal(sanitizePlayerName('<b>Arcane</b>!@#'), 'Arcane');
  assert.equal(sanitizePlayerName('  Shadow_King_99999  '), 'Shadow_King_');
  assert.equal(sanitizePlayerName('f*ck_u'), 'Player');
  assert.equal(sanitizePlayerName('sh1tLord'), 'Player');
  assert.equal(sanitizePlayerName('   <script>alert(1)</script>   '), 'alert1');
  assert.equal(sanitizePlayerName('!!!$$$'), 'Player');
  assert.equal(sanitizePlayerName('Nova-7'), 'Nova-7');
});

test('Ad monetization interstitial cadence fires every 2nd completed match and Vault cooldowns count down cleanly', () => {
  assert.equal(shouldShowPostMatchInterstitial(0), false);
  assert.equal(shouldShowPostMatchInterstitial(1), false);
  assert.equal(shouldShowPostMatchInterstitial(2), true);
  assert.equal(shouldShowPostMatchInterstitial(3), false);
  assert.equal(shouldShowPostMatchInterstitial(4), true);

  assert.equal(VAULT_AD_OFFERS.length, 3);
  const cdMap: Record<string, number> = { vault_crystals_sm: 100_000 };
  assert.equal(getVaultCooldownRemainingSec(cdMap, 'vault_crystals_sm', 70_000), 30);
  assert.equal(getVaultCooldownRemainingSec(cdMap, 'vault_crystals_sm', 100_001), 0);
  assert.equal(getVaultCooldownRemainingSec(cdMap, 'vault_gems_pack', 70_000), 0);
});
