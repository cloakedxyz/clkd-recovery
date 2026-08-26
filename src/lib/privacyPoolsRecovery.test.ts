import { deriveMnemonic } from '@cloakedxyz/clkd-privacy-pools';
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';

import { resolvePrivacyPoolsMnemonic } from './privacyPoolsRecovery';

const P_SPEND = `0x${'11'.repeat(32)}` as Hex;
const P_VIEW = `0x${'22'.repeat(32)}` as Hex;
const POOL_MNEMONIC = 'gospel sight fish false riot believe change unable hello since hard motion';
const WALLET_SIGNATURE = `0x${'ab'.repeat(65)}` as Hex;
const WALLET_POOL_MNEMONIC =
  'scale useful hurt mixed boring birth defense toilet slide reduce virus source';

describe('Privacy Pools recovery input', () => {
  it('uses a version 2 backup mnemonic without deriving a different identity', async () => {
    await expect(resolvePrivacyPoolsMnemonic({ mnemonic: POOL_MNEMONIC })).resolves.toBe(
      POOL_MNEMONIC
    );
  });

  it('preserves account-key derivation for existing backups', async () => {
    const expected = await deriveMnemonic({ spendSecret: P_SPEND, viewSecret: P_VIEW });

    await expect(
      resolvePrivacyPoolsMnemonic({ spendSecret: P_SPEND, viewSecret: P_VIEW })
    ).resolves.toBe(expected);
  });

  it('preserves the known wallet-signature Pool identity', async () => {
    await expect(resolvePrivacyPoolsMnemonic({ signature: WALLET_SIGNATURE })).resolves.toBe(
      WALLET_POOL_MNEMONIC
    );
  });
});
