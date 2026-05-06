'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  createPublicClient,
  http,
  fallback,
  formatUnits,
  type Hex,
  type PublicClient,
  parseAbiItem,
  erc20Abi,
} from 'viem';
import { sepolia, mainnet } from 'viem/chains';
import {
  deriveMnemonic,
  deriveMasterKeys,
  deriveDepositSecrets,
  computePrecommitment,
  computeNullifierHash,
  discoverChangeCommitments,
  getChainConfig,
  scanPoolEvents,
  getDepositStatuses,
  type ReviewStatus,
  type DepositRecord,
  type PoolConfig,
  type WithdrawalRecord,
} from '@cloakedxyz/clkd-privacy-pools';

interface PoolDeposit {
  /** Symbol (e.g. "ETH", "USDC") — taken from the key in CHAIN_CONFIGS.pools */
  poolSymbol: string;
  /** Asset decimals — 18 for native ETH, read from the ERC-20 for complex pools */
  decimals: number;
  /** Deposit index (shared across all pools for this user) */
  index: number;
  /** Withdrawal index — 0 for originals, >0 for change commitments from partial withdrawals */
  withdrawalIndex?: number;
  /** True for change commitments discovered via partial withdrawal tracing */
  isChange?: boolean;
  /** Precommitment hash — only present for original deposits, absent for change commitments */
  precommitment?: bigint;
  deposit: DepositRecord;
  depositor?: string;
  privateKey?: string;
  reviewStatus: ReviewStatus | 'unknown' | 'scanning';
  spent: boolean;
  /** How the commitment was consumed — 'withdrawn' (ZK proof) or 'recovered' (ragequit) */
  spentVia?: 'withdrawn' | 'recovered';
}

/**
 * Resolve the display decimals for a pool.
 * Simple pools are native ETH (18 decimals). Complex pools wrap an ERC-20 —
 * we read decimals() from the asset contract so new pools "just work" without
 * needing a code change here.
 */
async function resolvePoolDecimals(client: PublicClient, poolConfig: PoolConfig): Promise<number> {
  if (poolConfig.type === 'simple') return 18;
  const decimals = await client.readContract({
    address: poolConfig.assetAddress,
    abi: erc20Abi,
    functionName: 'decimals',
  });
  return Number(decimals);
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

const SEPOLIA_RPCS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://sepolia.drpc.org',
  'https://rpc2.sepolia.org',
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
      <td className="px-4 py-3 text-text-muted font-mono">
        {d.isChange ? (
          <span title={`Change from partial withdrawal of deposit #${d.index}`}>
            {d.index}
            <span className="text-xs text-primary ml-0.5">.{d.withdrawalIndex}</span>
          </span>
        ) : (
          d.index
        )}
      </td>
      <td className="px-4 py-3">
        <span className="inline-flex items-center text-xs font-medium text-text-primary bg-gray-100 px-2 py-0.5 rounded-full">
          {d.poolSymbol}
        </span>
      </td>
      <td className="px-4 py-3">
        {d.spent ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
            <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
            {d.spentVia === 'recovered' ? 'Recovered' : 'Spent'}
          </span>
        ) : (
          statusBadge(d.reviewStatus)
        )}
      </td>
      <td className="px-4 py-3 font-mono text-text-primary">
        {formatUnits(d.deposit.value, d.decimals)} {d.poolSymbol}
        {d.isChange && (
          <span className="block text-xs text-primary font-sans">Partial remainder</span>
        )}
      </td>
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
          <span className="flex items-center gap-1 text-xs text-yellow-600">
            Not found
            <span className="relative group">
              <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-yellow-400 text-yellow-500 text-[10px] cursor-help">
                i
              </span>
              <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 hidden group-hover:block w-56 px-2.5 py-1.5 text-[11px] text-white bg-gray-800 rounded-md shadow-lg z-10 leading-relaxed">
                This depositor address was created outside the window of derived stealth keys above.
                Generate more keys in that section, then re-scan.
              </span>
            </span>
          </span>
        ) : (
          <span className="text-xs text-text-muted">-</span>
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
  // Actual block range the last scan covered. Surfacing this helps users
  // spot stale-RPC issues: if `getBlockNumber()` returned a lagging value
  // and `endBlock` lands short of a recent deposit, the range makes it
  // obvious without having to re-run to diagnose.
  const [scannedRange, setScannedRange] = useState<{ start: bigint; end: bigint } | null>(null);
  // Cancellation: ref for the synchronous check inside the scan loop (we can't
  // `await` state updates mid-loop), state for the UI label.
  const cancelRef = useRef(false);
  const [cancelling, setCancelling] = useState(false);
  // Pool filter — 'ALL' scans every pool in config.pools sequentially, or a
  // specific symbol (e.g. 'USDC') narrows the scan to one pool. The options
  // are derived from config.pools at render time so new pools appear
  // automatically.
  const [selectedPool, setSelectedPool] = useState<string>('ALL');
  const [customRpc, setCustomRpc] = useState('');

  // Derive mnemonic on mount so it's always available
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ppMnemonic = await deriveMnemonic(deriveInput);
        if (!cancelled) setMnemonic(ppMnemonic);
      } catch (err) {
        console.warn('Failed to derive mnemonic:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deriveInput]);

  const scanForDeposits = useCallback(async () => {
    setScanning(true);
    setScanned(false);
    setError(null);
    setDeposits([]);
    setScannedRange(null);
    setScanProgress('Connecting...');
    setScanPercent(0);
    cancelRef.current = false;
    setCancelling(false);

    // Sentinel thrown at check points when the user cancels; caught below
    // and suppressed (no red error banner). Using a string constant is
    // simpler than a custom Error subclass for a single-file feature.
    const CANCELLED = '__CANCELLED__';
    const checkCancel = () => {
      if (cancelRef.current) throw new Error(CANCELLED);
    };

    try {
      const config = getChainConfig(chainId);
      const chain = CHAIN_MAP[chainId];
      const defaultRpcs = chainId === 1 ? MAINNET_RPCS : SEPOLIA_RPCS;
      const rpcs = customRpc.trim() ? [customRpc.trim(), ...defaultRpcs] : defaultRpcs;
      const transport = fallback(rpcs.map((url) => http(url)));
      const client = createPublicClient({ chain, transport });

      // Derive PP master keys from wallet signature or PRF secrets.
      // The mnemonic is pool-agnostic — per-pool secrets are derived below
      // using each pool's scope.
      const ppMnemonic = await deriveMnemonic(deriveInput);
      const masterKeys = deriveMasterKeys(ppMnemonic);

      const latestBlock = await client.getBlockNumber();
      const startBlock = customStartBlock ? BigInt(customStartBlock) : config.startBlock;
      const endBlock = customEndBlock ? BigInt(customEndBlock) : latestBlock;
      const scanMaxIndex = Math.min(Math.max(parseInt(maxIndex) || 1000, 1), 10000);
      setScannedRange({ start: startBlock, end: endBlock });

      // Build lookup: lowercase address → privateKey. Same across all pools.
      const keysByAddress = new Map<string, string>();
      for (const k of stealthKeys) {
        keysByAddress.set(k.address.toLowerCase(), k.privateKey);
      }

      // Iterate pools from the SDK's chain config, optionally narrowed to a
      // single selected pool. Adding a new asset (e.g. a new ERC-20 pool) is a
      // one-line addition to CHAIN_CONFIGS in the SDK — this UI picks it up
      // automatically, resolving decimals on-chain for complex pools.
      const allFound: PoolDeposit[] = [];
      const poolEntries = Object.entries(config.pools).filter(
        ([sym]) => selectedPool === 'ALL' || sym === selectedPool
      );
      if (poolEntries.length === 0) {
        throw new Error(`No pool "${selectedPool}" configured on this chain`);
      }

      for (const [poolSymbol, poolConfig] of poolEntries) {
        checkCancel();
        setScanProgress(`Scanning ${poolSymbol} pool...`);
        setScanPercent(0);

        const decimals = await resolvePoolDecimals(client as any, poolConfig);
        // Trust the precomputed scope from the SDK — verified against the deployed
        // contracts in config.live.test.ts, avoids an RPC round-trip per pool.
        const scope = poolConfig.scope;
        const poolAddress = poolConfig.address;

        // Scan all Deposited events in the range, then match by precommitment.
        // This works regardless of which stealth address made the deposit — the
        // precommitment is derived from the wallet signature + scope + index,
        // so it's the same for any depositor address.
        const { depositsByPrecommitment } = await scanPoolEvents(
          client as any,
          poolAddress,
          startBlock,
          endBlock,
          undefined,
          (scanned, total) => {
            // onProgress fires between chunks inside scanPoolEvents —
            // throwing here aborts the next getLogs call and unwinds out.
            checkCancel();
            if (total > BigInt(0)) {
              const pct = Number((scanned * BigInt(100)) / total);
              setScanPercent(pct);
              setScanProgress(
                `Scanning ${poolSymbol} blocks... ${pct}% (${Number(scanned).toLocaleString()} / ${Number(total).toLocaleString()})`
              );
            }
          }
        );

        setScanProgress(`Matching ${poolSymbol} deposits to your keys...`);

        // Check each index to see if the user deposited at that index.
        // The precommitment is deterministic: same wallet + same scope + same index = same precommitment.
        const found: PoolDeposit[] = [];
        for (let i = 0; i < scanMaxIndex; i++) {
          const idx = BigInt(i);
          const secrets = deriveDepositSecrets(masterKeys, scope, idx);
          const precommitment = computePrecommitment(
            secrets.nullifier as any,
            secrets.secret as any
          );
          const deposit = depositsByPrecommitment.get(precommitment);

          if (deposit) {
            found.push({
              poolSymbol,
              decimals,
              index: i,
              precommitment,
              deposit,
              reviewStatus: 'scanning',
              spent: false,
            });
          }
        }

        if (found.length > 0) {
          // ── Spent detection + change commitment tracing ──────────────
          // Scan Withdrawn + Ragequit events to build a map of spent
          // nullifier hashes. This replaces the old address-based exit
          // detection with precise nullifier-based matching, and also
          // enables tracing change commitments from partial withdrawals.
          setScanProgress(`Scanning ${poolSymbol} withdrawal events...`);
          const withdrawnEvent = parseAbiItem(
            'event Withdrawn(address indexed _processooor, uint256 _value, uint256 _spentNullifier, uint256 _newCommitment)'
          );
          const ragequitEvent = parseAbiItem(
            'event Ragequit(address indexed _ragequitter, uint256 _value, uint256 _spentNullifier, uint256 _newCommitment)'
          );
          const spentNullifiers = new Map<
            bigint,
            WithdrawalRecord & { via: 'withdrawn' | 'recovered' }
          >();
          const exitChunkSize = BigInt(1000);
          for (let start = startBlock; start <= endBlock; start += exitChunkSize) {
            checkCancel();
            const end =
              start + exitChunkSize - BigInt(1) > endBlock
                ? endBlock
                : start + exitChunkSize - BigInt(1);
            const [withdrawnLogs, ragequitLogs] = await Promise.all([
              client.getLogs({
                address: poolAddress as `0x${string}`,
                event: withdrawnEvent,
                fromBlock: start,
                toBlock: end,
              }),
              client.getLogs({
                address: poolAddress as `0x${string}`,
                event: ragequitEvent,
                fromBlock: start,
                toBlock: end,
              }),
            ]);
            for (const log of withdrawnLogs) {
              spentNullifiers.set(log.args._spentNullifier!, {
                withdrawnValue: log.args._value!,
                newCommitment: log.args._newCommitment!,
                via: 'withdrawn',
              });
            }
            for (const log of ragequitLogs) {
              spentNullifiers.set(log.args._spentNullifier!, {
                withdrawnValue: log.args._value!,
                newCommitment: log.args._newCommitment!,
                via: 'recovered',
              });
            }
          }

          // Mark originals as spent using nullifier hashes
          for (const d of found) {
            const secrets = deriveDepositSecrets(masterKeys, scope, BigInt(d.index));
            const nullifierHash = computeNullifierHash(secrets.nullifier as bigint);
            const spentRecord = spentNullifiers.get(nullifierHash);
            if (spentRecord) {
              d.spent = true;
              d.spentVia = spentRecord.via;
            }
          }

          // ── Depositor matching ───────────────────────────────────────
          // Must run before change commitment tracing so that
          // parent.depositor is populated when change commitments
          // inherit it.
          if (stealthKeys.length > 0) {
            setScanProgress(`Matching ${poolSymbol} depositors to stealth keys...`);

            const depositedEvent = parseAbiItem(
              'event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitmentHash)'
            );
            const foundPrecommitments = new Set(
              found.filter((d) => !d.isChange).map((d) => d.precommitment!)
            );
            const chunkSize = BigInt(1000);

            for (let start = startBlock; start <= endBlock; start += chunkSize) {
              checkCancel();
              const end =
                start + chunkSize - BigInt(1) > endBlock ? endBlock : start + chunkSize - BigInt(1);
              const logs = await client.getLogs({
                address: poolAddress as `0x${string}`,
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

          // ── Change commitment tracing ────────────────────────────────
          // discoverChangeCommitments walks the chain for each spent
          // original: original → change → change → ... until it finds
          // an unspent tail or the chain ends. Runs after depositor
          // matching so change commitments can inherit parent's depositor.
          if (spentNullifiers.size > 0 && found.some((d) => d.spent)) {
            setScanProgress(`Tracing ${poolSymbol} change commitments...`);
            const originals = found.map((d) => ({
              depositIndex: BigInt(d.index),
              withdrawalIndex: BigInt(0),
              label: d.deposit.label,
              value: d.deposit.value,
            }));

            const changeCommitments = discoverChangeCommitments(
              masterKeys,
              scope,
              originals,
              spentNullifiers
            );

            for (const cc of changeCommitments) {
              const parent = found.find((d) => d.index === Number(cc.depositIndex) && !d.isChange);
              found.push({
                poolSymbol,
                decimals,
                index: Number(cc.depositIndex),
                withdrawalIndex: Number(cc.withdrawalIndex),
                isChange: true,
                deposit: {
                  commitment: cc.commitment,
                  label: cc.label,
                  value: cc.value,
                },
                depositor: parent?.depositor,
                privateKey: parent?.privateKey,
                reviewStatus: 'approved',
                spent: false,
              });
            }
          }

          // ── ASP status ───────────────────────────────────────────────
          // Query the ASP API for original deposits only. Change
          // commitments inherit the same label as their parent deposit,
          // so if the original was approved, the change is too.
          setScanProgress(`Checking ${poolSymbol} ASP status...`);
          const origPrecommitments = new Set(
            found.filter((d) => !d.isChange).map((d) => d.precommitment!.toString())
          );
          try {
            const scopeStr = scope.toString();
            const [approved, declined] = await Promise.all([
              getDepositStatuses({
                aspApiBase: config.aspApiBase,
                chainId,
                precommitments: origPrecommitments,
                status: 'approved',
                scope: scopeStr,
              }),
              getDepositStatuses({
                aspApiBase: config.aspApiBase,
                chainId,
                precommitments: origPrecommitments,
                status: 'declined',
                scope: scopeStr,
              }),
            ]);
            for (const d of found) {
              if (d.isChange) continue;
              const key = d.precommitment!.toString();
              d.reviewStatus = approved.has(key)
                ? 'approved'
                : declined.has(key)
                  ? 'declined'
                  : 'pending';
            }
          } catch (err) {
            console.warn(`Failed to check ASP status for ${poolSymbol}:`, err);
            for (const d of found) {
              if (d.isChange) continue;
              d.reviewStatus = 'unknown';
            }
          }
        }

        allFound.push(...found);
      }

      setDeposits(allFound);
      setScanned(true);
    } catch (err) {
      // Silently swallow user-initiated cancellation — no error banner.
      if (!(err instanceof Error && err.message === CANCELLED)) {
        setError(err instanceof Error ? err.message : 'Scan failed');
      }
    } finally {
      setScanning(false);
      setCancelling(false);
      cancelRef.current = false;
    }
  }, [
    deriveInput,
    chainId,
    customStartBlock,
    customEndBlock,
    maxIndex,
    stealthKeys,
    selectedPool,
    customRpc,
  ]);

  const cancelScan = useCallback(() => {
    cancelRef.current = true;
    setCancelling(true);
  }, []);

  // Per-pool totals — ETH and USDC have different decimals and can't be summed
  // into a single number. We group active (non-spent) deposits by pool symbol
  // and display each asset on its own line.
  const activeTotals = deposits.reduce<Map<string, { value: bigint; decimals: number }>>(
    (acc, d) => {
      if (d.spent) return acc;
      const entry = acc.get(d.poolSymbol);
      if (entry) {
        entry.value += d.deposit.value;
      } else {
        acc.set(d.poolSymbol, { value: d.deposit.value, decimals: d.decimals });
      }
      return acc;
    },
    new Map()
  );
  const activeCount = deposits.filter((d) => !d.spent).length;
  const activeTotalsLabel =
    activeTotals.size === 0
      ? '0'
      : Array.from(activeTotals.entries())
          .map(([sym, { value, decimals }]) => `${formatUnits(value, decimals)} ${sym}`)
          .join(' + ');

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

        {!scanning ? (
          <button
            onClick={scanForDeposits}
            className="text-sm font-medium px-4 py-2 rounded-lg transition-all bg-primary hover:bg-primary-light text-white shadow-button"
          >
            Scan for Deposits
          </button>
        ) : (
          <button
            onClick={cancelScan}
            disabled={cancelling}
            className="text-sm font-medium px-4 py-2 rounded-lg transition-all bg-white border border-gray-300 hover:bg-gray-50 text-text-primary disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        )}
      </div>

      {/* Custom RPC */}
      {!scanning && (
        <div className="mb-3">
          <label className="text-xs text-text-muted block mb-1">Custom RPC (optional)</label>
          <input
            type="text"
            value={customRpc}
            onChange={(e) => setCustomRpc(e.target.value)}
            placeholder="https://eth-sepolia.g.alchemy.com/v2/..."
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all font-mono"
          />
        </div>
      )}

      {/* Block range inputs */}
      {!scanning && (
        <div className="mb-4 flex gap-3">
          <div className="w-32">
            <label className="text-xs text-text-muted block mb-1">Pool</label>
            <select
              value={selectedPool}
              onChange={(e) => setSelectedPool(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all bg-white"
            >
              <option value="ALL">All pools</option>
              {Object.keys(getChainConfig(chainId).pools).map((sym) => (
                <option key={sym} value={sym}>
                  {sym}
                </option>
              ))}
            </select>
          </div>
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
            No Privacy Pool deposits found for this wallet in{' '}
            {selectedPool === 'ALL' ? 'any pool' : `the ${selectedPool} pool`} on{' '}
            {chainId === 1 ? 'Ethereum' : 'Sepolia'}.
          </p>
          {scannedRange && (
            <p className="text-text-muted text-xs mt-2">
              Scanned blocks {Number(scannedRange.start).toLocaleString()} →{' '}
              {Number(scannedRange.end).toLocaleString()}
            </p>
          )}
        </div>
      )}

      {/* Seed phrase — always shown once derived */}
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
            This is your Privacy Pools wallet seed phrase. Keep it safe and never share it publicly.
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
                  {deposits.length !== activeCount &&
                    (() => {
                      const spentCount = deposits.filter(
                        (d) => d.spent && d.spentVia !== 'recovered'
                      ).length;
                      const recoveredCount = deposits.filter(
                        (d) => d.spentVia === 'recovered'
                      ).length;
                      const parts = [
                        `${activeCount} active`,
                        spentCount > 0 ? `${spentCount} spent` : '',
                        recoveredCount > 0 ? `${recoveredCount} recovered` : '',
                      ].filter(Boolean);
                      return (
                        <span className="text-text-muted font-normal"> ({parts.join(', ')})</span>
                      );
                    })()}
                </p>
                <p className="text-xs text-text-muted mt-0.5">
                  Up to {activeTotalsLabel} recoverable. Some approved deposits may already have
                  been withdrawn.
                </p>
                {scannedRange && (
                  <p className="text-xs text-text-muted mt-0.5">
                    Scanned blocks {Number(scannedRange.start).toLocaleString()} →{' '}
                    {Number(scannedRange.end).toLocaleString()}
                  </p>
                )}
              </div>
              <p className="text-lg font-bold text-primary">{activeTotalsLabel}</p>
            </div>
          </div>

          {/* Deposits table */}
          <div className="border border-gray-200 rounded-lg overflow-x-auto mb-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-card-raised border-b border-gray-200">
                  <th className="text-left px-4 py-3 text-text-muted font-medium w-16">#</th>
                  <th className="text-left px-4 py-3 text-text-muted font-medium">Pool</th>
                  <th className="text-left px-4 py-3 text-text-muted font-medium">Status</th>
                  <th className="text-left px-4 py-3 text-text-muted font-medium">Value</th>
                  <th className="text-left px-4 py-3 text-text-muted font-medium">Depositor</th>
                  <th className="text-left px-4 py-3 text-text-muted font-medium">Private Key</th>
                </tr>
              </thead>
              <tbody>
                {deposits.map((d) => (
                  <DepositRow key={d.index} deposit={d} />
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

          <div className="mt-3 text-xs text-text-muted space-y-0.5">
            <p>{chainId === 1 ? 'Ethereum Mainnet' : 'Sepolia Testnet'}</p>
            {Object.entries(getChainConfig(chainId).pools).map(([sym, p]) => (
              <p key={sym}>
                {sym} pool: <span className="font-mono">{p.address}</span>
              </p>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
