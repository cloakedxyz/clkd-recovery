import { deriveMnemonic } from '@cloakedxyz/clkd-privacy-pools';
import type { Hex } from 'viem';

export type PrivacyPoolsRecoveryInput =
  | { signature: Hex }
  | { spendSecret: Hex; viewSecret: Hex }
  | { mnemonic: string };

/**
 * Resolve the exact Privacy Pools mnemonic used to discover and recover deposits.
 * Version 2 wallet+PIN backups carry this dedicated recovery value directly,
 * while wallet and account-key flows continue to derive it from their original input.
 */
export async function resolvePrivacyPoolsMnemonic(
  input: PrivacyPoolsRecoveryInput
): Promise<string> {
  return 'mnemonic' in input ? input.mnemonic : deriveMnemonic(input);
}
