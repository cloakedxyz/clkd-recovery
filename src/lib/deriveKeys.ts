import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
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
  const childViewingNode = deriveChildViewingNode(keys.p_view);

  const results: DerivedKey[] = [];

  for (let i = 0; i < count; i++) {
    const nonce = startNonce + i;

    const { p_derived } = deriveDeterministicEphemeralKey(childViewingNode, BigInt(nonce), 0);

    const derivedAccount = privateKeyToAccount(p_derived);
    const P_derived = derivedAccount.publicKey;

    const { p_stealth } = genStealthPrivateKey({
      p_spend: keys.p_spend,
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
