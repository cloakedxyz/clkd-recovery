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

export interface RecoveryKitFile {
  version: 1;
  hasPassword: true;
  ciphertext: string; // base64
  iv: string; // base64
  salt: string; // base64
  createdAt: number; // epoch ms
  /** Last consumed stealth address nonce at time of backup. Helps determine how many addresses to derive. */
  lastConsumedNonce?: number;
}

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
// Decrypt
// ---------------------------------------------------------------------------

/**
 * Decrypt a recovery kit file with the user's password, returning the stealth keys.
 * Throws if the password is wrong (AES-GCM authentication will fail).
 */
export async function decryptRecoveryKit(
  kit: RecoveryKitFile,
  password: string
): Promise<{ pSpend: Hex; pView: Hex }> {
  if (kit.version !== 1) {
    throw new Error(`Unsupported recovery kit version: ${kit.version}`);
  }

  const salt = base64ToBytes(kit.salt);
  const iv = base64ToBytes(kit.iv);
  const ciphertext = base64ToBytes(kit.ciphertext);

  const key = await pbkdf2Async(sha256, password, salt, {
    c: PBKDF2_ITERATIONS,
    dkLen: KEY_LENGTH,
  });

  const decrypted = gcm(key, iv).decrypt(ciphertext);

  // Zero the key immediately after decryption
  key.fill(0);

  const parsed: unknown = JSON.parse(new TextDecoder().decode(decrypted));
  decrypted.fill(0);

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('p_spend' in parsed) ||
    !('p_view' in parsed) ||
    typeof (parsed as Record<string, unknown>).p_spend !== 'string' ||
    typeof (parsed as Record<string, unknown>).p_view !== 'string'
  ) {
    throw new Error('Recovery kit payload is malformed');
  }

  const { p_spend, p_view } = parsed as { p_spend: Hex; p_view: Hex };
  return { pSpend: p_spend, pView: p_view };
}
