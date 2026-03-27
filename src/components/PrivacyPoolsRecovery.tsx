'use client';

import { useState, useCallback } from 'react';
import { createPublicClient, http, fallback, formatEther, type Hex, parseAbiItem } from 'viem';
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
  depositor?: string;
  privateKey?: string;
  reviewStatus: ReviewStatus | 'unknown' | 'scanning';
  spent: boolean;
}

type DeriveInput = { signature: Hex } | { spendSecret: Hex; viewSecret: Hex };

interface StealthKey {
  address: string;
  privateKey: string;
}

interface Props {
  /** Entropy source — signature (wallet+PIN) or PRF secrets (backup) */
  deriveInput: DeriveInput;
  chainId: 1 | 11155111;
  /** Derived stealth keys from the recovery section above, used to match depositor addresses */
  stealthKeys?: StealthKey[];
}

const CHAIN_MAP = { 1: mainnet, 11155111: sepolia } as const;

const MAINNET_RPCS = [
  'https://eth.drpc.org',
  'https://ethereum-json-rpc.stakely.io',
  'https://eth.api.pocket.network',
  'https://ethereum-rpc.publicnode.com',
  'https://rpc.flashbots.net',
  'https://eth.llamarpc.com',
];

const PP_UI_URL = 'https://privacypools.com';

function CopyButton({
  label,
  copied,
  onCopy,
}: {
  label: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onCopy}
      className="text-text-muted hover:text-primary transition-colors flex-shrink-0"
      title={label}
    >
      {copied ? (
        <svg
          className="w-4 h-4 text-green-500"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

function statusBadge(status: ReviewStatus | 'unknown' | 'scanning') {
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
}

function DepositRow({ deposit: d }: { deposit: PoolDeposit }) {
  const [copiedAddr, setCopiedAddr] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);

  const handleCopyAddr = () => {
    if (!d.depositor) return;
    navigator.clipboard.writeText(d.depositor);
    setCopiedAddr(true);
    setTimeout(() => setCopiedAddr(false), 2000);
  };

  const handleCopyKey = () => {
    if (!d.privateKey) return;
    navigator.clipboard.writeText(d.privateKey);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  };

  return (
    <tr
      className={`border-b border-gray-100 last:border-0 transition-colors ${d.spent ? 'opacity-50' : 'hover:bg-gray-50'}`}
    >
      <td className="px-4 py-3 text-text-muted font-mono">{d.index}</td>
      <td className="px-4 py-3 font-mono text-text-primary">{formatEther(d.deposit.value)} ETH</td>
      <td className="px-4 py-3">
        {d.depositor ? (
          <div className="flex items-center gap-2">
            <span className="font-mono text-text-primary text-xs">
              {d.depositor.slice(0, 10)}...{d.depositor.slice(-8)}
            </span>
            <CopyButton label="Copy address" copied={copiedAddr} onCopy={handleCopyAddr} />
          </div>
        ) : (
          <span className="text-xs text-text-muted">-</span>
        )}
      </td>
      <td className="px-4 py-3">
        {d.privateKey ? (
          <div className="flex items-center gap-2">
            <span className="font-mono text-text-primary text-xs tracking-wider">
              ••••••••••••••••••••
            </span>
            <CopyButton label="Copy private key" copied={copiedKey} onCopy={handleCopyKey} />
          </div>
        ) : d.depositor ? (
          <span
            className="text-xs text-yellow-600"
            title="Try 'Derive More' in the stealth addresses section above"
          >
            Not found
          </span>
        ) : (
          <span className="text-xs text-text-muted">-</span>
        )}
      </td>
      <td className="px-4 py-3">
        {d.spent ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
            <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
            Exited
          </span>
        ) : (
          statusBadge(d.reviewStatus)
        )}
      </td>
    </tr>
  );
}

export function PrivacyPoolsRecovery({ deriveInput, chainId, stealthKeys = [] }: Props) {
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [deposits, setDeposits] = useState<PoolDeposit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [mnemonicVisible, setMnemonicVisible] = useState(false);
  const [mnemonicCopied, setMnemonicCopied] = useState(false);
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
      const transport = chainId === 1 ? fallback(MAINNET_RPCS.map((url) => http(url))) : http();
      const client = createPublicClient({ chain, transport });
      const poolConfig = config.pools['ETH'];
      if (!poolConfig) throw new Error('No ETH pool configured');

      // Derive PP mnemonic from wallet signature or PRF secrets
      const ppMnemonic = await deriveMnemonic(deriveInput);
      const masterKeys = deriveMasterKeys(ppMnemonic);
      setMnemonic(ppMnemonic);

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
            spent: false,
          });
        }
      }

      // Match depositors to stealth keys
      if (found.length > 0 && stealthKeys.length > 0) {
        setScanProgress('Matching depositors to stealth keys...');

        // Build lookup: lowercase address → privateKey
        const keysByAddress = new Map<string, string>();
        for (const k of stealthKeys) {
          keysByAddress.set(k.address.toLowerCase(), k.privateKey);
        }

        // Scan Deposited events to find depositor for each found deposit
        const depositedEvent = parseAbiItem(
          'event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitmentHash)'
        );
        const foundPrecommitments = new Set(found.map((d) => d.precommitment));
        const chunkSize = BigInt(1000);

        for (let start = startBlock; start <= endBlock; start += chunkSize) {
          const end =
            start + chunkSize - BigInt(1) > endBlock ? endBlock : start + chunkSize - BigInt(1);
          const logs = await client.getLogs({
            address: poolConfig.address as `0x${string}`,
            event: depositedEvent,
            fromBlock: start,
            toBlock: end,
          });
          for (const log of logs) {
            const precommitment = log.args._precommitmentHash!;
            if (foundPrecommitments.has(precommitment)) {
              const depositor = log.args._depositor!;
              const match = found.find((d) => d.precommitment === precommitment);
              if (match) {
                match.depositor = depositor;
                match.privateKey = keysByAddress.get(depositor.toLowerCase());
              }
            }
          }
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

      // Check if deposits have been withdrawn or ragequit by scanning exit events
      setScanProgress('Checking for already-exited deposits...');
      const depositorAddresses = new Set(
        found.filter((d) => d.depositor).map((d) => d.depositor!.toLowerCase())
      );
      if (depositorAddresses.size > 0) {
        const ragequitEvent = parseAbiItem(
          'event Ragequit(address indexed _ragequitter, uint256 _value, uint256 _spentNullifier, uint256 _newCommitment)'
        );
        const withdrawnEvent = parseAbiItem(
          'event Withdrawn(address indexed _processooor, uint256 _value, uint256 _spentNullifier, uint256 _newCommitment)'
        );
        // Collect all addresses that have ragequit or withdrawn
        // Stealth addresses are single-use, so any exit event for an address means the deposit is spent
        const exitedAddresses = new Set<string>();
        const exitChunkSize = BigInt(5000);
        for (let start = startBlock; start <= endBlock; start += exitChunkSize) {
          const end =
            start + exitChunkSize - BigInt(1) > endBlock
              ? endBlock
              : start + exitChunkSize - BigInt(1);
          const [ragequitLogs, withdrawnLogs] = await Promise.all([
            client.getLogs({
              address: poolConfig.address as `0x${string}`,
              event: ragequitEvent,
              fromBlock: start,
              toBlock: end,
            }),
            client.getLogs({
              address: poolConfig.address as `0x${string}`,
              event: withdrawnEvent,
              fromBlock: start,
              toBlock: end,
            }),
          ]);
          for (const log of ragequitLogs) {
            const addr = log.args._ragequitter!.toLowerCase();
            if (depositorAddresses.has(addr)) {
              exitedAddresses.add(addr);
            }
          }
          for (const log of withdrawnLogs) {
            const addr = log.args._processooor!.toLowerCase();
            if (depositorAddresses.has(addr)) {
              exitedAddresses.add(addr);
            }
          }
        }
        for (const d of found) {
          if (d.depositor && exitedAddresses.has(d.depositor.toLowerCase())) {
            d.spent = true;
          }
        }
      }

      setDeposits(found);
      setScanned(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setScanning(false);
    }
  }, [deriveInput, chainId, customStartBlock, customEndBlock, maxIndex, stealthKeys]);

  const activeValue = deposits.reduce(
    (sum, d) => (d.spent ? sum : sum + d.deposit.value),
    BigInt(0)
  );
  const activeCount = deposits.filter((d) => !d.spent).length;

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
              Est. deposits
              <span className="relative group">
                <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-gray-300 text-gray-400 text-[10px] cursor-help">
                  i
                </span>
                <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 hidden group-hover:block w-52 px-2.5 py-1.5 text-[11px] text-white bg-gray-800 rounded-md shadow-lg z-10 leading-relaxed">
                  Estimated number of Privacy Pool deposits you&apos;ve made. We&apos;ll check this
                  many indices to find your deposits.
                </span>
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
                  {deposits.length !== activeCount && (
                    <span className="text-text-muted font-normal">
                      {' '}
                      ({activeCount} approved, {deposits.length - activeCount} exited)
                    </span>
                  )}
                </p>
                <p className="text-xs text-text-muted mt-0.5">
                  Up to {formatEther(activeValue)} ETH recoverable. Some approved deposits may
                  already have been withdrawn.
                </p>
              </div>
              <p className="text-lg font-bold text-primary">{formatEther(activeValue)} ETH</p>
            </div>
          </div>

          {/* Deposits table */}
          <div className="border border-gray-200 rounded-lg overflow-hidden mb-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-card-raised border-b border-gray-200">
                  <th className="text-left px-4 py-3 text-text-muted font-medium w-16">#</th>
                  <th className="text-left px-4 py-3 text-text-muted font-medium">Value</th>
                  <th className="text-left px-4 py-3 text-text-muted font-medium">Depositor</th>
                  <th className="text-left px-4 py-3 text-text-muted font-medium">Private Key</th>
                  <th className="text-left px-4 py-3 text-text-muted font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {deposits.map((d) => (
                  <DepositRow key={d.index} deposit={d} />
                ))}
              </tbody>
            </table>
          </div>

          {/* Seed phrase export */}
          {mnemonic && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#D97706"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  <p className="text-sm font-semibold text-amber-900">Privacy Pools Seed Phrase</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setMnemonicVisible(!mnemonicVisible)}
                    className="text-xs text-amber-700 hover:text-amber-900 transition-colors font-medium"
                  >
                    {mnemonicVisible ? 'Hide' : 'Reveal'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(mnemonic);
                      setMnemonicCopied(true);
                      setTimeout(() => setMnemonicCopied(false), 2000);
                    }}
                    className="flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-md bg-amber-200 hover:bg-amber-300 text-amber-900 transition-colors"
                  >
                    {mnemonicCopied ? (
                      <>
                        <svg
                          className="w-3.5 h-3.5 text-green-600"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                        Copied
                      </>
                    ) : (
                      <>
                        <svg
                          className="w-3.5 h-3.5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                        Copy
                      </>
                    )}
                  </button>
                </div>
              </div>
              <div className="flex flex-col items-center gap-2">
                <div className="grid grid-cols-6 gap-2 w-full">
                  {mnemonic
                    .split(' ')
                    .slice(0, 6)
                    .map((word, i) => (
                      <div
                        key={i}
                        className="bg-white border border-amber-200 rounded-md px-2 py-1.5 text-center font-mono text-sm"
                      >
                        <span className="text-amber-400 text-xs mr-1">{i + 1}</span>
                        {mnemonicVisible ? word : '\u2022\u2022\u2022\u2022\u2022'}
                      </div>
                    ))}
                </div>
                <div className="grid grid-cols-6 gap-2 w-full">
                  {mnemonic
                    .split(' ')
                    .slice(6, 12)
                    .map((word, i) => (
                      <div
                        key={i + 6}
                        className="bg-white border border-amber-200 rounded-md px-2 py-1.5 text-center font-mono text-sm"
                      >
                        <span className="text-amber-400 text-xs mr-1">{i + 7}</span>
                        {mnemonicVisible ? word : '\u2022\u2022\u2022\u2022\u2022'}
                      </div>
                    ))}
                </div>
              </div>
              <p className="text-xs text-amber-700 mt-2">
                This is your Privacy Pools wallet seed phrase. Keep it safe and never share it
                publicly.
              </p>
            </div>
          )}

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
                  How to recover your Privacy Pool deposits
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
                  Your Privacy Pools deposits are controlled by the seed phrase above. Approved
                  deposits can be privately withdrawn using just the seed phrase. To ragequit a
                  pending or declined deposit, you also need the depositor&apos;s private key.
                </p>
                <ol className="list-decimal list-inside space-y-2 text-sm">
                  <li>
                    <strong>Import your seed phrase</strong> &mdash; Copy the seed phrase above and
                    import it at{' '}
                    <a
                      href={`${PP_UI_URL}/account/load`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 underline hover:text-blue-800 font-medium"
                    >
                      privacypools.com/account/load
                    </a>
                    . Your deposits will appear on your dashboard.
                  </li>
                  <li>
                    <strong>Withdraw approved deposits</strong> &mdash; Approved deposits can be
                    privately withdrawn via a relayer directly from the Privacy Pools dashboard. No
                    depositor key needed.
                  </li>
                  <li>
                    <strong>Ragequit pending/declined deposits</strong> &mdash; Copy the
                    depositor&apos;s private key from the table above and import it into your wallet
                    (MetaMask, Rabby, or Rainbow). Fund the address with ETH for gas, then initiate
                    a ragequit from the dashboard.
                  </li>
                </ol>
                <div className="bg-blue-100 border border-blue-300 rounded-md p-3 mt-2">
                  <p className="text-xs text-blue-900">
                    <strong>Important:</strong> Only the original depositor address can ragequit a
                    deposit. If you connect a different wallet, you will see the error: &quot;Only
                    the original depositor can ragequit from this commitment.&quot;
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
