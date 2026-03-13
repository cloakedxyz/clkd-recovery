import type { Hex } from 'viem';
import { hexToBytes, toHex } from 'viem';
import { HDKey, privateKeyToAccount } from 'viem/accounts';
import {
  genKeysFromSignature,
  deriveChildViewingNode,
  deriveDeterministicEphemeralKey,
  genStealthPrivateKey,
} from '@cloakedxyz/clkd-stealth';

export interface DerivedKey {
  nonce: number;
  address: string;
  privateKey: Hex;
}

export function deriveStealthKeys(signature: Hex, startNonce: number, count: number): DerivedKey[] {
  const keys = genKeysFromSignature(signature);
  return deriveStealthKeysFromRaw(keys.p_spend, keys.p_view, startNonce, count);
}

/**
 * Derive stealth address key pairs from raw spending/viewing keys.
 *
 * Used by the backup-file recovery flow where p_spend and p_view are obtained
 * directly from decrypting the backup, bypassing wallet signature + genKeysFromSignature.
 *
 * Derivation: pView → childViewingNode → ephemeral key per nonce → stealth private key.
 */
export function deriveStealthKeysFromRaw(
  pSpend: Hex,
  pView: Hex,
  startNonce: number,
  count: number
): DerivedKey[] {
  // Derive the child viewing node, then re-wrap its private key as a fresh
  // HDKey master seed. This matches the server which stores only the child's
  // private key and reconstitutes it via HDKey.fromMasterSeed(child_p_view).
  const childNode = deriveChildViewingNode(pView);
  const childPrivateKey = childNode.privateKey!;
  const childViewingNode = HDKey.fromMasterSeed(hexToBytes(toHex(childPrivateKey)));

  const results: DerivedKey[] = [];

  for (let i = 0; i < count; i++) {
    const nonce = startNonce + i;

    const { p_derived } = deriveDeterministicEphemeralKey(childViewingNode, BigInt(nonce), 0);

    const derivedAccount = privateKeyToAccount(p_derived);
    const P_derived = derivedAccount.publicKey;

    const { p_stealth } = genStealthPrivateKey({
      p_spend: pSpend,
      P_derived: P_derived as `0x${string}`,
    });

    const stealthAccount = privateKeyToAccount(p_stealth);

    results.push({
      nonce,
      address: stealthAccount.address,
      privateKey: p_stealth,
    });
  }

  return results;
}
