'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  createPublicClient,
  createWalletClient,
  fallback,
  formatUnits,
  http,
  isAddressEqual,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import {
  escrowAbi,
  getPeerEscrowRecoveryDeposits,
  type DepositRecoveryState,
  type PeerEscrowRecoveryDeposit,
} from '@cloakedxyz/clkd-peer';

interface StealthKey {
  address: string;
  privateKey: string;
}

interface Props {
  chainId: 8453 | 84532;
  stealthKeys?: StealthKey[];
  defaultRpc?: string;
}

type PeerDeposit = PeerEscrowRecoveryDeposit & {
  privateKey?: Hex;
};
type PeerRecoveryClient = Parameters<typeof getPeerEscrowRecoveryDeposits>[0];
type EscrowAction = 'pruneExpiredIntents' | 'withdrawDeposit';
type ActionReceipt = {
  depositId: bigint;
  functionName: EscrowAction;
  hash: Hex;
};

const PEER_CHAINS = {
  8453: {
    chain: base,
    label: 'Base',
    escrow: '0x777777779d229cdF3110e9de47943791c26300Ef' as Address,
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
    rpcs: [
      'https://mainnet.base.org',
      'https://base-rpc.publicnode.com',
      'https://base.llamarpc.com',
    ],
  },
  84532: {
    chain: baseSepolia,
    label: 'Base Sepolia',
    escrow: '0x05F2bF778e0c8EED51fF3E48203c0C37af009819' as Address,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address,
    rpcs: ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'],
  },
} as const;

const ZERO = BigInt(0);
const ONE_HUNDRED = BigInt(100);
const DEFAULT_LOOKBACK_BLOCKS = BigInt(500_000);
const CHUNK_SIZE = BigInt(50_000);

function shortAddress(address: string) {
  return `${address.slice(0, 10)}...${address.slice(-8)}`;
}

function makeClient(chainId: 8453 | 84532, customRpc: string) {
  const config = PEER_CHAINS[chainId];
  const urls = customRpc.trim() ? [customRpc.trim(), ...config.rpcs] : config.rpcs;
  return createPublicClient({
    chain: config.chain,
    transport: fallback(urls.map((url) => http(url))),
  });
}

function StateBadge({ state }: { state: DepositRecoveryState }) {
  const styles: Record<DepositRecoveryState, string> = {
    withdrawable: 'bg-green-100 text-green-700 border-green-200',
    partially_withdrawable: 'bg-green-100 text-green-700 border-green-200',
    prunable: 'bg-amber-100 text-amber-800 border-amber-200',
    locked: 'bg-yellow-100 text-yellow-800 border-yellow-200',
    empty: 'bg-gray-100 text-gray-600 border-gray-200',
    completed: 'bg-gray-100 text-gray-600 border-gray-200',
  };
  const labels: Record<DepositRecoveryState, string> = {
    withdrawable: 'Withdrawable',
    partially_withdrawable: 'Partial',
    prunable: 'Expired intent',
    locked: 'Locked',
    empty: 'Empty',
    completed: 'Completed',
  };
  return (
    <span
      className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium border ${styles[state]}`}
    >
      {labels[state]}
    </span>
  );
}

function AmountLine({ label, value }: { label: string; value: bigint }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="text-xs text-text-muted">{label}</span>
      <span className="text-sm font-medium text-text-primary">{formatUnits(value, 6)} USDC</span>
    </div>
  );
}

function formatEscrowActionError(err: unknown, depositor: Address) {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (
    lower.includes('out of gas') ||
    lower.includes('gas required exceeds allowance') ||
    lower.includes('insufficient funds')
  ) {
    return `${shortAddress(depositor)} needs Base ETH for gas before this recovery transaction can be sent.`;
  }
  return err instanceof Error ? err.message : 'Transaction failed.';
}

function formatActionName(functionName: EscrowAction) {
  return functionName === 'withdrawDeposit' ? 'Withdraw' : 'Prune';
}

function formatRelativeTime(timestamp: bigint, now: bigint) {
  const seconds = Number(timestamp - now);
  if (seconds <= 0) return 'expired';

  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours}h`;

  const days = Math.ceil(hours / 24);
  return `${days}d`;
}

function getNextActiveIntentExpiry(deposits: PeerDeposit[], now: bigint | null) {
  if (now == null) return null;
  const expiries = deposits.flatMap((row) =>
    row.intents
      .filter((intent) => intent.amount > ZERO && intent.expiryTime >= now)
      .map((intent) => intent.expiryTime)
  );
  return expiries.length > 0
    ? expiries.reduce((min, expiry) => (expiry < min ? expiry : min))
    : null;
}

function getResolvedAmount(row: PeerDeposit) {
  const inEscrow = row.deposit.remainingDeposits + row.deposit.outstandingIntentAmount;
  return row.received.amount > inEscrow ? row.received.amount - inEscrow : ZERO;
}

export function PeerEscrowRecovery({ chainId, stealthKeys = [], defaultRpc = '' }: Props) {
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customRpc, setCustomRpc] = useState(defaultRpc);
  const [customStartBlock, setCustomStartBlock] = useState('');
  const [customEndBlock, setCustomEndBlock] = useState('');
  const [scanProgress, setScanProgress] = useState('');
  const [scanPercent, setScanPercent] = useState(0);
  const [scannedRange, setScannedRange] = useState<{ start: bigint; end: bigint } | null>(null);
  const [scannedTimestamp, setScannedTimestamp] = useState<bigint | null>(null);
  const [deposits, setDeposits] = useState<PeerDeposit[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionReceipt, setActionReceipt] = useState<ActionReceipt | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const cancelRef = useRef(false);

  const config = PEER_CHAINS[chainId];
  const keyLookup = useMemo(() => {
    const map = new Map<string, Hex>();
    for (const key of stealthKeys) {
      map.set(key.address.toLowerCase(), key.privateKey as Hex);
    }
    return map;
  }, [stealthKeys]);

  const cancelScan = () => {
    cancelRef.current = true;
    setScanProgress('Cancelling...');
  };

  const scan = useCallback(async () => {
    setScanning(true);
    setScanned(false);
    setError(null);
    setActionError(null);
    setDeposits([]);
    setScannedTimestamp(null);
    setScanProgress('Connecting to Base...');
    setScanPercent(0);
    cancelRef.current = false;

    try {
      if (stealthKeys.length === 0) {
        throw new Error('Derive stealth keys first, then scan Peer escrow deposits.');
      }

      const client = makeClient(chainId, customRpc);
      const latestBlock = await client.getBlockNumber();
      const startBlock = customStartBlock
        ? BigInt(customStartBlock)
        : latestBlock > DEFAULT_LOOKBACK_BLOCKS
          ? latestBlock - DEFAULT_LOOKBACK_BLOCKS
          : ZERO;
      const endBlock = customEndBlock ? BigInt(customEndBlock) : latestBlock;
      const latest = await client.getBlock({ blockNumber: endBlock });
      setScannedRange({ start: startBlock, end: endBlock });
      setScannedTimestamp(latest.timestamp);

      const rows = await getPeerEscrowRecoveryDeposits(
        client as unknown as PeerRecoveryClient,
        stealthKeys.map((key) => key.address as Address),
        config.escrow,
        {
          fromBlock: startBlock,
          toBlock: endBlock,
          token: config.usdc,
          chunkSize: CHUNK_SIZE,
          onProgress: (scannedBlocks, totalBlocks) => {
            if (cancelRef.current) throw new Error('__CANCELLED__');
            const pct =
              totalBlocks > ZERO ? Number((scannedBlocks * ONE_HUNDRED) / totalBlocks) : 100;
            setScanPercent(Math.min(100, pct));
            setScanProgress(`Scanning escrow events... ${Math.min(100, pct)}%`);
          },
        }
      );

      rows.sort((a, b) => Number(a.depositId - b.depositId));
      setDeposits(
        rows.map((row) => ({
          ...row,
          privateKey: keyLookup.get(row.received.depositor.toLowerCase()),
        }))
      );
      setScanned(true);
      setScanProgress('');
      setScanPercent(0);
    } catch (err) {
      if (err instanceof Error && err.message === '__CANCELLED__') {
        setScanProgress('');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to scan Peer escrow deposits.');
      }
    } finally {
      setScanning(false);
    }
  }, [
    chainId,
    config.escrow,
    config.usdc,
    customEndBlock,
    customRpc,
    customStartBlock,
    keyLookup,
    stealthKeys,
  ]);

  const sendEscrowTx = async (row: PeerDeposit, functionName: EscrowAction) => {
    setActionError(null);
    setPendingAction(`${functionName}:${row.depositId.toString()}`);
    try {
      if (!row.privateKey)
        throw new Error(
          'Private key for this depositor was not derived. Derive more keys, then scan again.'
        );
      const account = privateKeyToAccount(row.privateKey);
      if (!isAddressEqual(account.address, row.received.depositor)) {
        throw new Error('Derived private key does not match the deposit owner.');
      }
      const client = makeClient(chainId, customRpc);
      const balance = await client.getBalance({ address: account.address });
      if (balance === ZERO) {
        throw new Error(
          `${shortAddress(account.address)} needs Base ETH for gas before this recovery transaction can be sent.`
        );
      }
      const wallet = createWalletClient({
        account,
        chain: config.chain,
        transport: http(customRpc.trim() || config.rpcs[0]),
      });
      const hash = await wallet.writeContract({
        address: config.escrow,
        abi: escrowAbi,
        functionName,
        args: [row.depositId],
      });
      await client.waitForTransactionReceipt({ hash });
      setActionReceipt({ depositId: row.depositId, functionName, hash });
      await scan();
    } catch (err) {
      setActionError(formatEscrowActionError(err, row.received.depositor));
    } finally {
      setPendingAction(null);
    }
  };

  const recoverableTotal = deposits.reduce((sum, row) => {
    return sum + row.recovery.recoverableAmount;
  }, ZERO);
  const matchedTotal = deposits.reduce((sum, row) => sum + row.recovery.matchedAmount, ZERO);
  const resolvedTotal = deposits.reduce((sum, row) => sum + getResolvedAmount(row), ZERO);
  const nextIntentExpiry = getNextActiveIntentExpiry(deposits, scannedTimestamp);

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
              <path d="M4 12h16" />
              <path d="M12 4v16" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Peer Escrow</h3>
            <p className="text-xs text-text-muted">
              Scan for recoverable USDC in zkp2p Peer escrow
            </p>
          </div>
        </div>
        {!scanning ? (
          <button
            onClick={scan}
            className="text-sm font-medium px-4 py-2 rounded-lg transition-all bg-primary hover:bg-primary-light text-white shadow-button"
          >
            Scan Peer
          </button>
        ) : (
          <button
            onClick={cancelScan}
            className="text-sm font-medium px-4 py-2 rounded-lg transition-all bg-white border border-gray-300 hover:bg-gray-50 text-text-primary"
          >
            Cancel
          </button>
        )}
      </div>

      {!scanning && (
        <>
          <div className="mb-3">
            <label className="text-xs text-text-muted block mb-1">Custom Base RPC (optional)</label>
            <input
              type="text"
              value={customRpc}
              onChange={(e) => setCustomRpc(e.target.value)}
              placeholder={defaultRpc || config.rpcs[0]}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all font-mono"
            />
          </div>
          <div className="mb-4 flex gap-3">
            <div className="flex-1">
              <label className="text-xs text-text-muted block mb-1">Start block (optional)</label>
              <input
                type="text"
                value={customStartBlock}
                onChange={(e) => setCustomStartBlock(e.target.value.replace(/\D/g, ''))}
                placeholder="Default: latest - 500,000"
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
          </div>
        </>
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
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
          <p className="text-red-600 text-sm">{error}</p>
        </div>
      )}
      {actionError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
          <p className="text-red-600 text-sm">{actionError}</p>
        </div>
      )}
      {actionReceipt && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3 mb-4">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-green-800 text-sm">
              {formatActionName(actionReceipt.functionName)} confirmed for deposit #
              {actionReceipt.depositId.toString()}.
            </p>
            <p className="font-mono text-xs text-green-700 break-all">{actionReceipt.hash}</p>
          </div>
        </div>
      )}

      {scanned && deposits.length === 0 && (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 text-center">
          <p className="text-text-muted text-sm">
            No Peer escrow deposits found on {config.label}.
          </p>
          {scannedRange && (
            <p className="text-text-muted text-xs mt-2">
              Scanned blocks {Number(scannedRange.start).toLocaleString()} →{' '}
              {Number(scannedRange.end).toLocaleString()}
            </p>
          )}
        </div>
      )}

      {deposits.length > 0 && (
        <>
          <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 mb-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-text-primary">
                  {deposits.length} escrow deposit{deposits.length !== 1 ? 's' : ''} found
                </p>
                <p className="text-xs text-text-muted mt-0.5">
                  {formatUnits(recoverableTotal, 6)} USDC recoverable from Peer escrow.
                  {matchedTotal > ZERO && (
                    <>
                      {' '}
                      {formatUnits(matchedTotal, 6)} USDC matched with buyer intent liquidity
                      {nextIntentExpiry
                        ? `, expiring in ${formatRelativeTime(nextIntentExpiry, scannedTimestamp!)}`
                        : ''}
                      .
                    </>
                  )}
                </p>
                {resolvedTotal > ZERO && (
                  <p className="text-xs text-text-muted mt-0.5">
                    {formatUnits(resolvedTotal, 6)} USDC already released or withdrawn.
                  </p>
                )}
                {scannedRange && (
                  <p className="text-xs text-text-muted mt-0.5">
                    Scanned blocks {Number(scannedRange.start).toLocaleString()} →{' '}
                    {Number(scannedRange.end).toLocaleString()}
                  </p>
                )}
              </div>
              <div className="text-right">
                <p className="text-xs text-text-muted">Recoverable now</p>
                <p className="text-lg font-bold text-primary">
                  {formatUnits(recoverableTotal, 6)} USDC
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-3 mb-4">
            {deposits.map((row) => {
              const pending = pendingAction?.endsWith(`:${row.depositId.toString()}`);
              return (
                <div
                  key={row.depositId.toString()}
                  className="border border-gray-200 rounded-lg p-4"
                >
                  <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-mono text-sm font-medium text-text-primary">
                          Deposit #{row.depositId.toString()}
                        </p>
                        <StateBadge state={row.recovery.state} />
                      </div>
                      <p className="font-mono text-xs text-text-muted mt-3">
                        Depositor {shortAddress(row.received.depositor)}
                      </p>
                    </div>

                    <div className="w-full md:w-64 shrink-0 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
                      <AmountLine label="Deposited" value={row.received.amount} />
                      {getResolvedAmount(row) > ZERO && (
                        <AmountLine label="Released/withdrawn" value={getResolvedAmount(row)} />
                      )}
                      <AmountLine label="Remaining" value={row.deposit.remainingDeposits} />
                      <AmountLine label="Matched" value={row.deposit.outstandingIntentAmount} />
                      {row.recovery.activeIntentAmount > ZERO &&
                        (() => {
                          const nextExpiry = getNextActiveIntentExpiry([row], scannedTimestamp);
                          return nextExpiry ? (
                            <div className="flex items-baseline justify-between gap-4 py-1">
                              <span className="text-xs text-text-muted">Expires</span>
                              <span className="text-sm font-medium text-text-primary">
                                {formatRelativeTime(nextExpiry, scannedTimestamp!)}
                              </span>
                            </div>
                          ) : null;
                        })()}
                    </div>

                    <div className="flex gap-2 md:justify-end md:min-w-40">
                      {row.recovery.canPrune && (
                        <button
                          type="button"
                          disabled={pending || !row.privateKey}
                          onClick={() => sendEscrowTx(row, 'pruneExpiredIntents')}
                          className="text-xs font-medium px-3 py-1.5 rounded-md bg-amber-100 hover:bg-amber-200 text-amber-900 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {pending ? 'Working...' : 'Prune'}
                        </button>
                      )}
                      {row.recovery.canWithdraw && (
                        <button
                          type="button"
                          disabled={pending || !row.privateKey}
                          onClick={() => sendEscrowTx(row, 'withdrawDeposit')}
                          className="text-xs font-medium px-3 py-1.5 rounded-md bg-primary hover:bg-primary-light text-white disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Withdraw
                        </button>
                      )}
                      {!row.privateKey && (
                        <span className="self-center text-xs text-yellow-700">
                          Derive more keys
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {deposits.some((row) => row.recovery.canWithdraw || row.recovery.canPrune) && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4">
              <p className="text-sm font-medium text-amber-900 mb-1">Base ETH required</p>
              <p className="text-xs text-amber-800">
                Recovery transactions are sent from the stealth depositor address, so that address
                needs enough Base ETH for gas.
              </p>
            </div>
          )}

          <div className="mt-3 text-xs text-text-muted space-y-0.5">
            <p>{config.label}</p>
            <p>
              EscrowV2: <span className="font-mono">{config.escrow}</span>
            </p>
            <p>
              USDC: <span className="font-mono">{config.usdc}</span>
            </p>
          </div>
        </>
      )}
    </div>
  );
}
