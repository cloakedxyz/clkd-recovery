import { gcm } from '@noble/ciphers/aes';
import { pbkdf2Async } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';

import { decryptRecoveryKit, isRecoveryKitFile, type RecoveryKitFile } from './decryptBackup';
import passkeyV1Json from './fixtures/recovery-kit-v1-passkey.json';
import preWebCryptoV1Json from './fixtures/recovery-kit-v1-pre-webcrypto.json';
import walletPinV1Json from './fixtures/recovery-kit-v1-wallet-pin.json';
import accountKeysV2Json from './fixtures/recovery-kit-v2-account-keys.json';
import walletPinV2Json from './fixtures/recovery-kit-v2-wallet-pin.json';

const PASSWORD = 'correct-horse-battery-staple';
const P_SPEND = `0x${'11'.repeat(32)}` as Hex;
const P_VIEW = `0x${'22'.repeat(32)}` as Hex;
const WALLET_PIN_P_SPEND = `0x${'33'.repeat(32)}` as Hex;
const WALLET_PIN_P_VIEW = `0x${'44'.repeat(32)}` as Hex;
const POOL_MNEMONIC = 'gospel sight fish false riot believe change unable hello since hard motion';
const WALLET_PIN_POOL_MNEMONIC =
  'scale useful hurt mixed boring birth defense toilet slide reduce virus source';
const passkeyV1Fixture = passkeyV1Json as RecoveryKitFile;
const preWebCryptoV1Fixture = preWebCryptoV1Json as RecoveryKitFile;
const walletPinV1Fixture = walletPinV1Json as RecoveryKitFile;
const accountKeysV2Fixture = accountKeysV2Json as RecoveryKitFile;
const walletPinV2Fixture = walletPinV2Json as RecoveryKitFile;

async function encryptFixture(
  version: 1 | 2,
  payload: Record<string, unknown>,
  marker: number
): Promise<RecoveryKitFile> {
  const salt = new Uint8Array(32).fill(marker);
  const iv = new Uint8Array(12).fill(marker + 1);
  const key = await pbkdf2Async(sha256, PASSWORD, salt, {
    c: 600_000,
    dkLen: 32,
  });
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = gcm(key, iv).encrypt(plaintext);
  key.fill(0);
  plaintext.fill(0);

  return {
    version,
    hasPassword: true,
    ciphertext: Buffer.from(ciphertext).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
    salt: Buffer.from(salt).toString('base64'),
    createdAt: 1_800_000_000_000 + marker,
    lastConsumedNonce: 42,
  };
}

describe('recovery kit decryption', { timeout: 30_000 }, () => {
  let v1Kit: RecoveryKitFile;
  let v2AccountKeysKit: RecoveryKitFile;
  let v2MnemonicKit: RecoveryKitFile;

  beforeAll(async () => {
    [v1Kit, v2AccountKeysKit, v2MnemonicKit] = await Promise.all([
      encryptFixture(
        1,
        {
          version: 1,
          p_spend: P_SPEND,
          p_view: P_VIEW,
        },
        1
      ),
      encryptFixture(
        2,
        {
          version: 2,
          p_spend: P_SPEND,
          p_view: P_VIEW,
          privacy_pools: { scheme: 'account-keys-v1' },
        },
        2
      ),
      encryptFixture(
        2,
        {
          version: 2,
          p_spend: P_SPEND,
          p_view: P_VIEW,
          privacy_pools: { scheme: 'mnemonic-v1', mnemonic: POOL_MNEMONIC },
        },
        3
      ),
    ]);
  });

  it('keeps version 1 backups backward-compatible', async () => {
    await expect(decryptRecoveryKit(v1Kit, PASSWORD)).resolves.toEqual({
      version: 1,
      pSpend: P_SPEND,
      pView: P_VIEW,
    });
  });

  it('decrypts version 2 account-key Pool recovery material', async () => {
    await expect(decryptRecoveryKit(v2AccountKeysKit, PASSWORD)).resolves.toEqual({
      version: 2,
      pSpend: P_SPEND,
      pView: P_VIEW,
      privacyPools: { scheme: 'account-keys-v1' },
    });
  });

  it('decrypts version 2 mnemonic Pool recovery material', async () => {
    await expect(decryptRecoveryKit(v2MnemonicKit, PASSWORD)).resolves.toEqual({
      version: 2,
      pSpend: P_SPEND,
      pView: P_VIEW,
      privacyPools: { scheme: 'mnemonic-v1', mnemonic: POOL_MNEMONIC },
    });
  });

  it('recognizes version 1 and version 2 backup envelopes', () => {
    expect(isRecoveryKitFile(v1Kit)).toBe(true);
    expect(isRecoveryKitFile(v2MnemonicKit)).toBe(true);
    expect(isRecoveryKitFile({ ...v2MnemonicKit, version: 3 })).toBe(false);
  });

  it('accepts the exact frozen v2 envelope written by the Cloaked application', () => {
    const expectedKeys = [
      'ciphertext',
      'createdAt',
      'hasPassword',
      'iv',
      'lastConsumedNonce',
      'salt',
      'version',
    ];

    expect(Object.keys(accountKeysV2Fixture).sort()).toEqual(expectedKeys);
    expect(Object.keys(walletPinV2Fixture).sort()).toEqual(expectedKeys);
    expect(isRecoveryKitFile(accountKeysV2Fixture)).toBe(true);
    expect(isRecoveryKitFile(walletPinV2Fixture)).toBe(true);
  });

  it('accepts the exact frozen v1 envelopes from every creation path', () => {
    const expectedKeys = [
      'ciphertext',
      'createdAt',
      'hasPassword',
      'iv',
      'lastConsumedNonce',
      'salt',
      'version',
    ];

    expect(Object.keys(passkeyV1Fixture).sort()).toEqual(expectedKeys);
    expect(Object.keys(walletPinV1Fixture).sort()).toEqual(expectedKeys);
    expect(Object.keys(preWebCryptoV1Fixture).sort()).toEqual(expectedKeys);
    expect(isRecoveryKitFile(passkeyV1Fixture)).toBe(true);
    expect(isRecoveryKitFile(walletPinV1Fixture)).toBe(true);
    expect(isRecoveryKitFile(preWebCryptoV1Fixture)).toBe(true);
  });

  it('decrypts the frozen application-written passkey v1 file', async () => {
    await expect(decryptRecoveryKit(passkeyV1Fixture, PASSWORD)).resolves.toEqual({
      version: 1,
      pSpend: P_SPEND,
      pView: P_VIEW,
    });
  });

  it('decrypts the frozen application-written wallet+PIN v1 file', async () => {
    await expect(decryptRecoveryKit(walletPinV1Fixture, PASSWORD)).resolves.toEqual({
      version: 1,
      pSpend: WALLET_PIN_P_SPEND,
      pView: WALLET_PIN_P_VIEW,
    });
  });

  it('decrypts the frozen pre-Web-Crypto v1 file', async () => {
    await expect(decryptRecoveryKit(preWebCryptoV1Fixture, 'password1234')).resolves.toEqual({
      version: 1,
      pSpend: '0x9e12c53726aa3b7d1bd674de5cae61746cdc867939413bffa83238480adeabb7',
      pView: '0x7ec49d22823fc14f78449f72b42ffdc416a66078281d3fda708c5ffee77ea980',
    });
  });

  it('decrypts the frozen application-written account-key v2 file', async () => {
    await expect(decryptRecoveryKit(accountKeysV2Fixture, PASSWORD)).resolves.toEqual({
      version: 2,
      pSpend: P_SPEND,
      pView: P_VIEW,
      privacyPools: { scheme: 'account-keys-v1' },
    });
  });

  it('decrypts the frozen application-written wallet+PIN v2 file', async () => {
    await expect(decryptRecoveryKit(walletPinV2Fixture, PASSWORD)).resolves.toEqual({
      version: 2,
      pSpend: P_SPEND,
      pView: P_VIEW,
      privacyPools: { scheme: 'mnemonic-v1', mnemonic: WALLET_PIN_POOL_MNEMONIC },
    });
  });

  it.each([
    ['missing ciphertext', { ...walletPinV2Fixture, ciphertext: undefined }],
    ['empty ciphertext', { ...walletPinV2Fixture, ciphertext: '' }],
    ['invalid ciphertext encoding', { ...walletPinV2Fixture, ciphertext: 'not-base64' }],
    ['wrong IV length', { ...walletPinV2Fixture, iv: 'AA==' }],
    ['wrong salt length', { ...walletPinV2Fixture, salt: 'AA==' }],
    ['wrong hasPassword marker', { ...walletPinV2Fixture, hasPassword: false }],
    ['non-finite creation time', { ...walletPinV2Fixture, createdAt: Number.NaN }],
    ['negative creation time', { ...walletPinV2Fixture, createdAt: -1 }],
    ['fractional creation time', { ...walletPinV2Fixture, createdAt: 1.5 }],
    ['negative nonce', { ...walletPinV2Fixture, lastConsumedNonce: -1 }],
    ['fractional nonce', { ...walletPinV2Fixture, lastConsumedNonce: 1.5 }],
    ['unsafe nonce', { ...walletPinV2Fixture, lastConsumedNonce: Number.MAX_SAFE_INTEGER + 1 }],
  ])('rejects a malformed outer envelope: %s', (_label, malformed) => {
    expect(isRecoveryKitFile(malformed)).toBe(false);
  });

  it('rejects a mismatched encrypted payload version', async () => {
    const mismatched = await encryptFixture(
      2,
      {
        version: 1,
        p_spend: P_SPEND,
        p_view: P_VIEW,
      },
      4
    );

    await expect(decryptRecoveryKit(mismatched, PASSWORD)).rejects.toThrow(
      'Recovery kit payload is malformed'
    );
  });

  it.each([
    [
      'short spending key',
      {
        version: 2,
        p_spend: '0x1234',
        p_view: P_VIEW,
        privacy_pools: { scheme: 'account-keys-v1' },
      },
    ],
    [
      'missing viewing key',
      {
        version: 2,
        p_spend: P_SPEND,
        privacy_pools: { scheme: 'account-keys-v1' },
      },
    ],
    [
      'missing Pool material',
      {
        version: 2,
        p_spend: P_SPEND,
        p_view: P_VIEW,
      },
    ],
    [
      'unsupported Pool scheme',
      {
        version: 2,
        p_spend: P_SPEND,
        p_view: P_VIEW,
        privacy_pools: { scheme: 'signature-v1', signature: '0x1234' },
      },
    ],
    [
      'short Pool mnemonic',
      {
        version: 2,
        p_spend: P_SPEND,
        p_view: P_VIEW,
        privacy_pools: { scheme: 'mnemonic-v1', mnemonic: 'too short' },
      },
    ],
  ])('rejects a malformed encrypted payload: %s', async (_label, payload) => {
    const malformed = await encryptFixture(2, payload, 10);

    await expect(decryptRecoveryKit(malformed, PASSWORD)).rejects.toThrow(
      'Recovery kit payload is malformed'
    );
  });
});
