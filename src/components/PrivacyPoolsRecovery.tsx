'use client';

import { useState, useCallback } from 'react';
import { createPublicClient, http, formatEther, type Hex } from 'viem';
import { sepolia, mainnet } from 'viem/chains';
import {
  deriveMnemonic,
  deriveMasterKeys,
  deriveDepositSecrets,
  computePrecommitment,
  getChainConfig,
  scanPoolEvents,
  getDepositStatus,
  POOL_ABI,
  type ReviewStatus,
  type DepositRecord,
} from '@cloakedxyz/clkd-privacy-pools';

interface PoolDeposit {
  index: number;
  precommitment: bigint;
  deposit: DepositRecord;
  reviewStatus: ReviewStatus | 'unknown' | 'scanning';
}

interface Props {
  /** The wallet signature used for key derivation */
  signature: Hex;
  chainId: 1 | 11155111;
}

const CHAIN_MAP = { 1: mainnet, 11155111: sepolia } as const;

const PP_UI_URL = 'https://app.privacypools.com';

export function PrivacyPoolsRecovery({ signature, chainId }: Props) {
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [deposits, setDeposits] = useState<PoolDeposit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [customStartBlock, setCustomStartBlock] = useState('');
  const [customEndBlock, setCustomEndBlock] = useState('');
  const [maxIndex, setMaxIndex] = useState('1000');
  const [scanProgress, setScanProgress] = useState('');
  const [scanPercent, setScanPercent] = useState(0);

  const scanForDeposits = useCallback(async () => {
    setScanning(true);
    setError(null);
    setDeposits([]);
    setScanProgress('Connecting...');
    setScanPercent(0);

    try {
      const config = getChainConfig(chainId);
      const chain = CHAIN_MAP[chainId];
      const client = createPublicClient({ chain, transport: http() });
      const poolConfig = config.pools['ETH'];
      if (!poolConfig) throw new Error('No ETH pool configured');

      // Derive PP mnemonic from wallet signature
      const mnemonic = await deriveMnemonic(signature);
      const masterKeys = deriveMasterKeys(mnemonic);

      // Read pool scope
      const scope = (await client.readContract({
        address: poolConfig.address as `0x${string}`,
        abi: POOL_ABI,
        functionName: 'SCOPE',
      })) as bigint;

      const latestBlock = await client.getBlockNumber();
      const startBlock = customStartBlock ? BigInt(customStartBlock) : config.startBlock;
      const endBlock = customEndBlock ? BigInt(customEndBlock) : latestBlock;
      const totalBlocks = endBlock - startBlock;

      setScanProgress(`Scanning ${totalBlocks.toLocaleString()} blocks...`);

      // Scan all Deposited events in the range, then match by precommitment.
      // This works regardless of which stealth address made the deposit —
      // the precommitment is derived from the wallet signature + scope + index,
      // so it's the same for any depositor address.
      const { depositsByPrecommitment } = await scanPoolEvents(
        client as any,
        poolConfig.address as `0x${string}`,
        startBlock,
        endBlock,
        undefined,
        (scanned, total) => {
          if (total > BigInt(0)) {
            const pct = Number((scanned * BigInt(100)) / total);
            setScanPercent(pct);
            setScanProgress(
              `Scanning blocks... ${pct}% (${Number(scanned).toLocaleString()} / ${Number(total).toLocaleString()})`
            );
          }
        }
      );

      setScanProgress('Matching deposits to your keys...');

      // Check each index to see if the user deposited at that index.
      // The precommitment is deterministic: same wallet + same scope + same index = same precommitment.
      // Stop after 20 consecutive misses once we've found at least one deposit.
      const found: PoolDeposit[] = [];
      const scanMaxIndex = Math.min(Math.max(parseInt(maxIndex) || 1000, 1), 10000);

      for (let i = 0; i < scanMaxIndex; i++) {
        const idx = BigInt(i);
        const secrets = deriveDepositSecrets(masterKeys, scope, idx);
        const precommitment = computePrecommitment(secrets.nullifier as any, secrets.secret as any);
        const deposit = depositsByPrecommitment.get(precommitment);

        if (deposit) {
          found.push({
            index: i,
            precommitment,
            deposit,
            reviewStatus: 'scanning',
          });
        }
      }

      // Check ASP status for each deposit
      setScanProgress('Checking ASP status...');
      for (const d of found) {
        try {
          const status = await getDepositStatus(config.aspApiBase, chainId, d.precommitment);
          d.reviewStatus = status?.reviewStatus ?? 'unknown';
        } catch (err) {
          console.warn(`Failed to check ASP status for deposit ${d.index}:`, err);
          d.reviewStatus = 'unknown';
        }
      }

      setDeposits(found);
      setScanned(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setScanning(false);
    }
  }, [signature, chainId, customStartBlock, customEndBlock, maxIndex]);

  const totalValue = deposits.reduce((sum, d) => sum + d.deposit.value, BigInt(0));

  const statusBadge = (status: ReviewStatus | 'unknown' | 'scanning') => {
    switch (status) {
      case 'approved':
        return (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
            Approved
          </span>
        );
      case 'declined':
        return (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700 bg-red-50 px-2 py-0.5 rounded-full">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
            Declined
          </span>
        );
      case 'pending':
        return (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-yellow-700 bg-yellow-50 px-2 py-0.5 rounded-full">
            <span className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
            Pending
          </span>
        );
      case 'scanning':
        return <span className="text-xs text-text-muted">Checking...</span>;
      default:
        return <span className="text-xs text-text-muted">Unknown</span>;
    }
  };

  return (
    <div className="mt-8 border-t border-gray-200 pt-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#7B4DFF"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Privacy Pools</h3>
            <p className="text-xs text-text-muted">Scan for deposits in 0xbow Privacy Pools</p>
          </div>
        </div>

        {!scanning && (
          <button
            onClick={scanForDeposits}
            className="text-sm font-medium px-4 py-2 rounded-lg transition-all bg-primary hover:bg-primary-light text-white shadow-button"
          >
            Scan for Deposits
          </button>
        )}
      </div>

      {/* Block range inputs */}
      {!scanning && (
        <div className="mb-4 flex gap-3">
          <div className="flex-1">
            <label className="text-xs text-text-muted block mb-1">Start block (optional)</label>
            <input
              type="text"
              value={customStartBlock}
              onChange={(e) => setCustomStartBlock(e.target.value.replace(/\D/g, ''))}
              placeholder={`Default: ${getChainConfig(chainId).startBlock.toString()}`}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all font-mono"
            />
          </div>
          <div className="flex-1">
            <label className="text-xs text-text-muted block mb-1">End block (optional)</label>
            <input
              type="text"
              value={customEndBlock}
              onChange={(e) => setCustomEndBlock(e.target.value.replace(/\D/g, ''))}
              placeholder="Default: latest"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all font-mono"
            />
          </div>
          <div className="w-32">
            <label className="text-xs text-text-muted mb-1 flex items-center gap-1">
              Max deposits
              <span
                title="How many deposit indices to check. Each deposit uses the next index (0, 1, 2, ...). Increase if you made more deposits than the default."
                className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-gray-300 text-gray-400 text-[10px] cursor-help"
              >
                i
              </span>
            </label>
            <input
              type="text"
              value={maxIndex}
              onChange={(e) => setMaxIndex(e.target.value.replace(/\D/g, ''))}
              placeholder="1000"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all font-mono"
            />
          </div>
        </div>
      )}

      {scanning && (
        <div className="mb-4">
          <div className="flex items-center justify-between text-sm text-text-muted mb-2">
            <span>{scanProgress || 'Starting...'}</span>
            {scanPercent > 0 && <span>{scanPercent}%</span>}
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className="bg-primary h-2 rounded-full transition-all duration-300"
              style={{ width: `${Math.max(scanPercent, 2)}%` }}
            />
          </div>
          {scanPercent === 0 && (
            <p className="text-xs text-text-muted mt-2">
              This may take a few minutes depending on the block range. Enter a start block above to
              speed things up.
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
          <p className="text-red-600 text-sm">{error}</p>
        </div>
      )}

      {scanned && deposits.length === 0 && (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 text-center">
          <p className="text-text-muted text-sm">
            No Privacy Pool deposits found for this wallet on{' '}
            {chainId === 1 ? 'Ethereum' : 'Sepolia'}.
          </p>
        </div>
      )}

      {deposits.length > 0 && (
        <>
          {/* Summary */}
          <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 mb-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-text-primary">
                  {deposits.length} deposit{deposits.length !== 1 ? 's' : ''} found
                </p>
                <p className="text-xs text-text-muted mt-0.5">
                  Total value in pool: {formatEther(totalValue)} ETH
                </p>
              </div>
              <p className="text-lg font-bold text-primary">{formatEther(totalValue)} ETH</p>
            </div>
          </div>

          {/* Deposits table */}
          <div className="border border-gray-200 rounded-lg overflow-hidden mb-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-card-raised border-b border-gray-200">
                  <th className="text-left px-4 py-3 text-text-muted font-medium w-16">#</th>
                  <th className="text-left px-4 py-3 text-text-muted font-medium">Value</th>
                  <th className="text-left px-4 py-3 text-text-muted font-medium">Status</th>
                  <th className="text-left px-4 py-3 text-text-muted font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {deposits.map((d) => (
                  <tr
                    key={d.index}
                    className="border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors"
                  >
                    <td className="px-4 py-3 text-text-muted font-mono">{d.index}</td>
                    <td className="px-4 py-3 font-mono text-text-primary">
                      {formatEther(d.deposit.value)} ETH
                    </td>
                    <td className="px-4 py-3">{statusBadge(d.reviewStatus)}</td>
                    <td className="px-4 py-3">
                      {d.reviewStatus === 'approved' && (
                        <span className="text-xs text-green-600 font-medium">
                          Ready to withdraw
                        </span>
                      )}
                      {d.reviewStatus === 'declined' && (
                        <span className="text-xs text-red-600 font-medium">Ragequit available</span>
                      )}
                      {d.reviewStatus === 'pending' && (
                        <span className="text-xs text-text-muted">Awaiting review</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Recovery instructions */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setShowGuide(!showGuide)}
              className="w-full flex items-center justify-between p-4 text-left hover:bg-blue-100/50 transition-colors"
            >
              <div className="flex items-center gap-2">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#2563EB"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 16v-4" />
                  <path d="M12 8h.01" />
                </svg>
                <p className="text-sm font-medium text-blue-800">
                  How to withdraw your Privacy Pool deposits
                </p>
              </div>
              <svg
                className={`w-4 h-4 text-blue-600 transition-transform ${showGuide ? 'rotate-180' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </button>

            {showGuide && (
              <div className="px-4 pb-4 text-sm text-blue-800 space-y-3">
                <p>
                  Privacy Pool deposits are controlled by your wallet&apos;s private key. To
                  withdraw, you need to use the wallet that made the deposit.
                </p>
                <ol className="list-decimal list-inside space-y-2 text-sm">
                  <li>
                    Find the <strong>stealth address private key</strong> from the table above that
                    was used to make the deposit.
                  </li>
                  <li>
                    Import that private key into a wallet (MetaMask, Rabby, or Rainbow). See the
                    &quot;How to use your private key&quot; guide above for steps.
                  </li>
                  <li>
                    Go to{' '}
                    <a
                      href={PP_UI_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 underline hover:text-blue-800 font-medium"
                    >
                      app.privacypools.com
                    </a>{' '}
                    and connect the wallet with the imported key.
                  </li>
                  <li>
                    Your deposits will appear in the Privacy Pools UI. From there you can:
                    <ul className="list-disc list-inside ml-4 mt-1 space-y-1">
                      <li>
                        <strong>Withdraw</strong> (approved deposits) &mdash; private withdrawal to
                        any address
                      </li>
                      <li>
                        <strong>Ragequit</strong> (declined deposits) &mdash; non-private withdrawal
                        that returns your funds
                      </li>
                    </ul>
                  </li>
                </ol>
                <div className="bg-blue-100/50 rounded-lg p-3 mt-3">
                  <p className="text-xs text-blue-700">
                    <strong>Note:</strong> The Privacy Pools UI uses the same wallet address that
                    made the deposit. Your deposit secrets are derived from the wallet signature, so
                    the same wallet will automatically recover them.
                  </p>
                </div>
              </div>
            )}
          </div>

          <p className="mt-3 text-xs text-text-muted">
            Pool contract:{' '}
            <span className="font-mono">{getChainConfig(chainId).pools['ETH']?.address}</span>{' '}
            &middot; {chainId === 1 ? 'Ethereum Mainnet' : 'Sepolia Testnet'}
          </p>
        </>
      )}
    </div>
  );
}
