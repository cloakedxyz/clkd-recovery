/**
 * Inlined backup-file decryption from @cloakedxyz/clkd-sdk-client.
 *
 * Scheme:
 *   KDF:  PBKDF2-SHA256, 600 000 iterations, 32-byte key
 *   AEAD: AES-256-GCM (12-byte IV, 32-byte random salt)
 *
 * Inlined rather than depending on the unpublished SDK to keep the
 * recovery tool standalone and dependency-light.
 *
 * @see sdk-client/src/recovery/crypto.ts — canonical implementation
 */

import { gcm } from '@noble/ciphers/aes';
import { pbkdf2Async } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';
import type { Hex } from 'viem';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RecoveryKitFileBase {
  hasPassword: true;
  ciphertext: string; // base64
  iv: string; // base64
  salt: string; // base64
  createdAt: number; // epoch ms
  /** Last consumed stealth address nonce at time of backup. Helps determine how many addresses to derive. */
  lastConsumedNonce?: number;
}

export interface RecoveryKitFileV1 extends RecoveryKitFileBase {
  version: 1;
}

export interface RecoveryKitFileV2 extends RecoveryKitFileBase {
  version: 2;
}

export type RecoveryKitFile = RecoveryKitFileV1 | RecoveryKitFileV2;

export type PrivacyPoolsRecoveryMaterial =
  | { scheme: 'account-keys-v1' }
  | { scheme: 'mnemonic-v1'; mnemonic: string };

export type DecryptedRecoveryKit =
  | {
      version: 1;
      pSpend: Hex;
      pView: Hex;
    }
  | {
      version: 2;
      pSpend: Hex;
      pView: Hex;
      privacyPools: PrivacyPoolsRecoveryMaterial;
    };

// ---------------------------------------------------------------------------
// Base64 helpers (cross-platform: browser + Node)
// ---------------------------------------------------------------------------

function base64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return Uint8Array.from(Buffer.from(base64, 'base64'));
  }

  if (typeof atob !== 'undefined') {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }

  throw new Error('No Base64 decoder available.');
}

// ---------------------------------------------------------------------------
// Crypto constants
// ---------------------------------------------------------------------------

const PBKDF2_ITERATIONS = 600_000;
const KEY_LENGTH = 32; // 256 bits

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPrivateKey(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isMnemonic(value: unknown): value is string {
  return typeof value === 'string' && value.trim().split(/\s+/).length === 12;
}

function isBase64WithLength(value: unknown, expectedLength: number): value is string {
  return (
    isBase64WithMinimumLength(value, expectedLength) &&
    base64ToBytes(value).length === expectedLength
  );
}

function isBase64WithMinimumLength(value: unknown, minimumLength: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }

  try {
    return base64ToBytes(value).length >= minimumLength;
  } catch {
    return false;
  }
}

export function isRecoveryKitFile(value: unknown): value is RecoveryKitFile {
  if (!isRecord(value)) return false;
  if (value.version !== 1 && value.version !== 2) return false;
  if (value.hasPassword !== true) return false;
  // AES-GCM ciphertext includes a 16-byte authentication tag plus non-empty JSON plaintext.
  if (!isBase64WithMinimumLength(value.ciphertext, 17)) return false;
  if (!isBase64WithLength(value.iv, 12)) return false;
  if (!isBase64WithLength(value.salt, 32)) return false;
  if (!Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 0) return false;
  if (
    value.lastConsumedNonce !== undefined &&
    (!Number.isSafeInteger(value.lastConsumedNonce) || Number(value.lastConsumedNonce) < 0)
  ) {
    return false;
  }
  return true;
}

function malformedPayload(): never {
  throw new Error('Recovery kit payload is malformed');
}

function parseRecoveryKitPayload(parsed: unknown, fileVersion: 1 | 2): DecryptedRecoveryKit {
  if (!isRecord(parsed)) return malformedPayload();
  if (parsed.version !== fileVersion) return malformedPayload();
  if (!isPrivateKey(parsed.p_spend) || !isPrivateKey(parsed.p_view)) {
    return malformedPayload();
  }

  const pSpend = parsed.p_spend;
  const pView = parsed.p_view;
  if (fileVersion === 1) {
    return { version: 1, pSpend, pView };
  }

  const privacyPools = parsed.privacy_pools;
  if (!isRecord(privacyPools)) return malformedPayload();

  if (privacyPools.scheme === 'account-keys-v1') {
    return {
      version: 2,
      pSpend,
      pView,
      privacyPools: { scheme: 'account-keys-v1' },
    };
  }

  if (privacyPools.scheme === 'mnemonic-v1' && isMnemonic(privacyPools.mnemonic)) {
    return {
      version: 2,
      pSpend,
      pView,
      privacyPools: {
        scheme: 'mnemonic-v1',
        mnemonic: privacyPools.mnemonic.trim().replace(/\s+/g, ' '),
      },
    };
  }

  return malformedPayload();
}

// ---------------------------------------------------------------------------
// Decrypt
// ---------------------------------------------------------------------------

/**
 * Decrypt a recovery kit file with the user's password, returning the stealth keys.
 * Throws if the password is wrong (AES-GCM authentication will fail).
 */
export async function decryptRecoveryKit(
  kit: RecoveryKitFile,
  password: string
): Promise<DecryptedRecoveryKit> {
  const fileVersion: number = kit.version;
  if (fileVersion !== 1 && fileVersion !== 2) {
    throw new Error(`Unsupported recovery kit version: ${fileVersion}`);
  }

  const salt = base64ToBytes(kit.salt);
  const iv = base64ToBytes(kit.iv);
  const ciphertext = base64ToBytes(kit.ciphertext);

  const key = await pbkdf2Async(sha256, password, salt, {
    c: PBKDF2_ITERATIONS,
    dkLen: KEY_LENGTH,
  });

  let decrypted: Uint8Array;
  try {
    decrypted = gcm(key, iv).decrypt(ciphertext);
  } finally {
    // Zero the password-derived key even when authentication fails.
    key.fill(0);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(decrypted));
  } finally {
    decrypted.fill(0);
  }

  return parseRecoveryKitPayload(parsed, fileVersion);
}
