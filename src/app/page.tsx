'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useAccount, useDisconnect, useSignMessage } from 'wagmi';
import { type Hex } from 'viem';
import { genCloakedMessage } from '@cloakedxyz/clkd-stealth';
import { WalletSelectModal } from '~/components/WalletSelectModal';
import { deriveStealthKeys, type DerivedKey } from '~/lib/deriveKeys';

type Step = 'connect' | 'pin' | 'sign' | 'results';

const BATCH_SIZE = 50;
const INITIAL_COUNT = 500;

export default function RecoveryPage() {
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const { signMessageAsync } = useSignMessage();

  const [mounted, setMounted] = useState(false);
  const [step, setStep] = useState<Step>('connect');
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [pin, setPin] = useState(['', '', '', '']);
  const [pinVisible, setPinVisible] = useState([false, false, false, false]);
  const pinTimers = useRef<(ReturnType<typeof setTimeout> | null)[]>([null, null, null, null]);
  const [messageExpanded, setMessageExpanded] = useState(false);
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [deriving, setDeriving] = useState(false);
  const [derivedKeys, setDerivedKeys] = useState<DerivedKey[]>([]);
  const [progress, setProgress] = useState(0);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const PAGE_SIZE = 50;

  const pinRefs = [
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
  ];

  useEffect(() => {
    setMounted(true);
  }, []);

  // Advance to PIN step when wallet connects
  useEffect(() => {
    if (isConnected && step === 'connect') {
      setStep('pin');
    }
  }, [isConnected, step]);

  // Clear keys on disconnect
  useEffect(() => {
    if (!isConnected) {
      setStep('connect');
      setPin(['', '', '', '']);
      setPinVisible([false, false, false, false]);
      pinTimers.current.forEach((t) => t && clearTimeout(t));
      setDerivedKeys([]);
      setProgress(0);
      setSignError(null);
    }
  }, [isConnected]);

  const handlePinChange = (index: number, value: string) => {
    if (!/^\d?$/.test(value)) return;
    const newPin = [...pin];
    newPin[index] = value;
    setPin(newPin);

    if (value) {
      // Show digit briefly, then mask
      if (pinTimers.current[index]) clearTimeout(pinTimers.current[index]!);
      const newVisible = [...pinVisible];
      newVisible[index] = true;
      setPinVisible(newVisible);
      pinTimers.current[index] = setTimeout(() => {
        setPinVisible((prev) => {
          const next = [...prev];
          next[index] = false;
          return next;
        });
      }, 500);

      if (index < 3) {
        pinRefs[index + 1]?.current?.focus();
      }
    } else {
      const newVisible = [...pinVisible];
      newVisible[index] = false;
      setPinVisible(newVisible);
    }
  };

  const handlePinKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !pin[index] && index > 0) {
      pinRefs[index - 1]?.current?.focus();
    }
  };

  const handlePinPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 4);
    if (pasted.length === 4) {
      setPin(pasted.split(''));
      setPinVisible([true, true, true, true]);
      pinRefs[3]?.current?.focus();
      setTimeout(() => {
        setPinVisible([false, false, false, false]);
      }, 500);
    }
  };

  const isPinComplete = pin.every((d) => d !== '');

  const handleSubmitPin = () => {
    if (isPinComplete) {
      setStep('sign');
    }
  };

  const deriveKeysInBatches = useCallback(
    async (signature: Hex, totalCount: number, startFrom: number = 0) => {
      setDeriving(true);
      setProgress(0);

      const allKeys: DerivedKey[] = startFrom > 0 ? [...derivedKeys] : [];
      const batches = Math.ceil(totalCount / BATCH_SIZE);

      for (let i = 0; i < batches; i++) {
        const batchStart = startFrom + i * BATCH_SIZE;
        const batchCount = Math.min(BATCH_SIZE, totalCount - i * BATCH_SIZE);

        // Yield to UI between batches
        await new Promise((resolve) => setTimeout(resolve, 0));

        const batchKeys = deriveStealthKeys(signature, batchStart, batchCount);
        allKeys.push(...batchKeys);
        setDerivedKeys([...allKeys]);
        setProgress(Math.round(((i + 1) / batches) * 100));
      }

      setDeriving(false);
    },
    [derivedKeys]
  );

  const [signature, setSignature] = useState<Hex | null>(null);

  const handleSign = async () => {
    if (!address) return;
    setSigning(true);
    setSignError(null);

    try {
      const { message } = genCloakedMessage({
        pin: pin.join(''),
        address,
      });

      const sig = (await signMessageAsync({ message })) as Hex;
      setSignature(sig);
      setStep('results');
      await deriveKeysInBatches(sig, INITIAL_COUNT);
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.toLowerCase().includes('user rejected') ||
          err.message.toLowerCase().includes('user denied'))
      ) {
        setSignError('Signature request was cancelled.');
      } else {
        setSignError(err instanceof Error ? err.message : 'Failed to sign message.');
      }
    } finally {
      setSigning(false);
    }
  };

  const handleDeriveMore = async () => {
    if (!signature) return;
    const nextStart = derivedKeys.length;
    await deriveKeysInBatches(signature, INITIAL_COUNT, nextStart);
  };

  const handleCopy = async (text: string, index: number) => {
    await navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const handleExportJSON = () => {
    const data = derivedKeys.map((k) => ({
      nonce: k.nonce,
      address: k.address,
      privateKey: k.privateKey,
    }));
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cloaked-recovery-${address?.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDisconnect = () => {
    disconnect();
  };

  if (!mounted) {
    return null;
  }

  return (
    <main className="min-h-screen flex flex-col items-center px-4 py-8">
      {/* Header */}
      <div className="w-full max-w-2xl animate-drop-in">
        <div className="flex items-center justify-center gap-3 mb-2">
          <img src="/cloaked_logo.png" alt="Cloaked" className="w-10 h-10" />
          <h1 className="text-2xl font-bold text-text-primary">Cloaked Recovery</h1>
        </div>
        <p className="text-center text-text-muted text-sm mb-6">
          Recover your Cloaked stealth address private keys entirely client-side.
        </p>
      </div>

      {/* Security Warning */}
      <div className="w-full max-w-2xl mb-6 animate-fade-in">
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
          <p className="text-yellow-800 text-sm font-medium text-center">
            Never share your private keys. All derivation happens locally in your browser.
          </p>
        </div>
      </div>

      {/* Connected Address */}
      {isConnected && address && (
        <div className="w-full max-w-2xl mb-6 animate-fade-in">
          <div className="flex items-center justify-between bg-card-raised rounded-lg px-4 py-3 border border-gray-200">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-status-green" />
              <span className="text-sm text-text-primary font-medium">
                {address.slice(0, 6)}...{address.slice(-4)}
              </span>
            </div>
            <button
              onClick={handleDisconnect}
              className="text-sm text-text-muted hover:text-red-500 transition-colors"
            >
              Disconnect
            </button>
          </div>
        </div>
      )}

      {/* Step Content */}
      <div className="w-full max-w-2xl">
        {/* Step 1: Connect Wallet */}
        {step === 'connect' && (
          <div className="animate-fabric-wave flex flex-col items-center gap-6 py-12">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
              <svg
                width="32"
                height="32"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#7B4DFF"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M19 7V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1" />
                <path d="M22 11h-6a2 2 0 0 0-2 2v0a2 2 0 0 0 2 2h6v-4z" />
              </svg>
            </div>
            <div className="text-center">
              <h2 className="text-xl font-semibold text-text-primary mb-2">Connect Your Wallet</h2>
              <p className="text-text-muted text-sm">
                Connect the wallet you used to create your Cloaked account.
              </p>
            </div>
            <button
              onClick={() => setShowWalletModal(true)}
              className="bg-primary hover:bg-primary-light active:bg-primary-dark text-white font-semibold px-8 py-3 rounded-lg shadow-button transition-all"
            >
              Connect Wallet
            </button>
          </div>
        )}

        {/* Step 2: Enter PIN */}
        {step === 'pin' && (
          <div className="animate-fabric-wave flex flex-col items-center gap-6 py-12">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
              <svg
                width="32"
                height="32"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#7B4DFF"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <div className="text-center">
              <h2 className="text-xl font-semibold text-text-primary mb-2">Enter Your PIN</h2>
              <p className="text-text-muted text-sm">
                Enter the 4-digit PIN you set when creating your Cloaked account.
              </p>
            </div>
            <div className="flex gap-3" onPaste={handlePinPaste}>
              {pin.map((digit, i) => (
                <div key={i} className="relative w-14 h-14">
                  <input
                    ref={pinRefs[i]}
                    type="text"
                    inputMode="numeric"
                    maxLength={1}
                    value={digit}
                    onChange={(e) => handlePinChange(i, e.target.value)}
                    onKeyDown={(e) => handlePinKeyDown(i, e)}
                    className="w-14 h-14 text-center text-2xl font-bold border-2 border-gray-200 rounded-lg focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all text-transparent caret-text-primary"
                    autoFocus={i === 0}
                  />
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    {digit &&
                      (pinVisible[i] ? (
                        <span className="text-2xl font-bold text-text-primary">{digit}</span>
                      ) : (
                        <span className="w-3 h-3 rounded-full bg-text-primary inline-block" />
                      ))}
                  </div>
                </div>
              ))}
            </div>
            <button
              onClick={handleSubmitPin}
              disabled={!isPinComplete}
              className="bg-primary hover:bg-primary-light active:bg-primary-dark text-white font-semibold px-8 py-3 rounded-lg shadow-button transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
            >
              Continue
            </button>
          </div>
        )}

        {/* Step 3: Sign Message */}
        {step === 'sign' && (
          <div className="animate-fabric-wave flex flex-col items-center gap-6 py-12">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
              <svg
                width="32"
                height="32"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#7B4DFF"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <path d="M9 12l2 2 4-4" />
              </svg>
            </div>
            <div className="text-center">
              <h2 className="text-xl font-semibold text-text-primary mb-2">Sign to Recover Keys</h2>
              <p className="text-text-muted text-sm max-w-md">
                Your wallet will ask you to sign a message. This generates the cryptographic seed
                used to derive your stealth private keys.
              </p>
            </div>
            <div className="bg-card-raised border border-gray-200 rounded-lg w-full max-w-md overflow-hidden">
              <button
                type="button"
                onClick={() => setMessageExpanded((v) => !v)}
                className="w-full flex items-center justify-between p-4 text-left hover:bg-gray-100 transition-colors"
              >
                <p className="text-xs text-text-muted">Message to be signed</p>
                <svg
                  className={`w-4 h-4 text-text-muted transition-transform ${messageExpanded ? 'rotate-180' : ''}`}
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
              {!messageExpanded && (
                <p className="text-sm text-text-primary font-mono break-all px-4 pb-4 line-clamp-1">
                  Sign this message to generate your Cloaked private payment keys...
                </p>
              )}
              {messageExpanded && address && (
                <pre className="text-sm text-text-primary font-mono break-all whitespace-pre-wrap px-4 pb-4">
                  {genCloakedMessage({ pin: pin.join(''), address }).message}
                </pre>
              )}
            </div>
            {signError && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 w-full max-w-md">
                <p className="text-red-600 text-sm">{signError}</p>
              </div>
            )}
            <div className="flex gap-3">
              <button
                onClick={() => setStep('pin')}
                className="text-text-muted hover:text-text-primary font-medium px-6 py-3 rounded-lg border border-gray-200 transition-colors"
              >
                Back
              </button>
              <button
                onClick={handleSign}
                disabled={signing}
                className="bg-primary hover:bg-primary-light active:bg-primary-dark text-white font-semibold px-8 py-3 rounded-lg shadow-button transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none flex items-center gap-2"
              >
                {signing && (
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                )}
                {signing ? 'Waiting for signature...' : 'Sign & Recover Keys'}
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Results */}
        {step === 'results' && (
          <div className="animate-fade-in">
            {/* Progress bar during derivation */}
            {deriving && (
              <div className="mb-6">
                <div className="flex justify-between text-sm text-text-muted mb-2">
                  <span>Deriving keys...</span>
                  <span>{progress}%</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className="bg-primary h-2 rounded-full transition-all duration-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            )}

            {/* Actions bar */}
            {derivedKeys.length > 0 && (
              <div className="flex items-center justify-between mb-4">
                <span className="text-sm text-text-muted">{derivedKeys.length} keys derived</span>
                <div className="flex gap-2">
                  <button
                    onClick={handleExportJSON}
                    disabled={deriving}
                    className="text-sm text-primary hover:text-primary-light font-medium px-3 py-1.5 rounded-md border border-primary/30 hover:border-primary transition-colors disabled:opacity-50"
                  >
                    Export JSON
                  </button>
                  <button
                    onClick={handleDeriveMore}
                    disabled={deriving}
                    className="text-sm bg-primary hover:bg-primary-light text-white font-medium px-3 py-1.5 rounded-md shadow-button transition-all disabled:opacity-50"
                  >
                    Derive {INITIAL_COUNT} More
                  </button>
                </div>
              </div>
            )}

            {/* Keys table */}
            {derivedKeys.length > 0 &&
              (() => {
                const totalPages = Math.ceil(derivedKeys.length / PAGE_SIZE);
                const pageKeys = derivedKeys.slice(
                  currentPage * PAGE_SIZE,
                  (currentPage + 1) * PAGE_SIZE
                );

                return (
                  <>
                    <div className="border border-gray-200 rounded-lg overflow-hidden">
                      <div className="overflow-x-auto scrollbar-hide">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="bg-card-raised border-b border-gray-200">
                              <th className="text-left px-4 py-3 text-text-muted font-medium w-16">
                                #
                              </th>
                              <th className="text-left px-4 py-3 text-text-muted font-medium">
                                Stealth Address
                              </th>
                              <th className="text-left px-4 py-3 text-text-muted font-medium">
                                Private Key
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {pageKeys.map((key) => {
                              const globalIdx = key.nonce;
                              return (
                                <tr
                                  key={key.nonce}
                                  className="border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors"
                                >
                                  <td className="px-4 py-3 text-text-muted font-mono">
                                    {key.nonce}
                                  </td>
                                  <td className="px-4 py-3">
                                    <div className="flex items-center gap-2">
                                      <span className="font-mono text-text-primary text-xs">
                                        {key.address.slice(0, 10)}...
                                        {key.address.slice(-8)}
                                      </span>
                                      <button
                                        onClick={() => handleCopy(key.address, globalIdx)}
                                        className="text-text-muted hover:text-primary transition-colors flex-shrink-0"
                                        title="Copy address"
                                      >
                                        {copiedIndex === globalIdx ? (
                                          <svg
                                            className="w-4 h-4 text-status-green"
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
                                        ) : (
                                          <svg
                                            className="w-4 h-4"
                                            fill="none"
                                            stroke="currentColor"
                                            viewBox="0 0 24 24"
                                          >
                                            <rect
                                              x="9"
                                              y="9"
                                              width="13"
                                              height="13"
                                              rx="2"
                                              ry="2"
                                            />
                                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                          </svg>
                                        )}
                                      </button>
                                    </div>
                                  </td>
                                  <td className="px-4 py-3">
                                    <div className="flex items-center gap-2">
                                      <span className="font-mono text-text-primary text-xs">
                                        {key.privateKey.slice(0, 10)}...
                                        {key.privateKey.slice(-8)}
                                      </span>
                                      <button
                                        onClick={() =>
                                          handleCopy(key.privateKey, 10000 + globalIdx)
                                        }
                                        className="text-text-muted hover:text-primary transition-colors flex-shrink-0"
                                        title="Copy private key"
                                      >
                                        {copiedIndex === 10000 + globalIdx ? (
                                          <svg
                                            className="w-4 h-4 text-status-green"
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
                                        ) : (
                                          <svg
                                            className="w-4 h-4"
                                            fill="none"
                                            stroke="currentColor"
                                            viewBox="0 0 24 24"
                                          >
                                            <rect
                                              x="9"
                                              y="9"
                                              width="13"
                                              height="13"
                                              rx="2"
                                              ry="2"
                                            />
                                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                          </svg>
                                        )}
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* Pagination */}
                    {totalPages > 1 && (
                      <div className="flex items-center justify-between mt-4">
                        <button
                          onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
                          disabled={currentPage === 0}
                          className="text-sm text-text-muted hover:text-text-primary font-medium px-3 py-1.5 rounded-md border border-gray-200 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          Previous
                        </button>
                        <span className="text-sm text-text-muted">
                          Page {currentPage + 1} of {totalPages}
                        </span>
                        <button
                          onClick={() => setCurrentPage((p) => Math.min(totalPages - 1, p + 1))}
                          disabled={currentPage === totalPages - 1}
                          className="text-sm text-text-muted hover:text-text-primary font-medium px-3 py-1.5 rounded-md border border-gray-200 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          Next
                        </button>
                      </div>
                    )}
                  </>
                );
              })()}
          </div>
        )}
      </div>

      {/* Disclaimer */}
      <div className="w-full max-w-2xl mt-12 mb-4">
        <p className="text-text-muted text-xs text-center leading-relaxed">
          Moving funds out of a stealth address without using the Cloaked UI may lead to loss of
          functionality within the Cloaked UI. Only use this interface to verify addresses or as a
          last resort to recover funds.
        </p>
      </div>

      {/* Wallet Modal */}
      <WalletSelectModal isOpen={showWalletModal} onClose={() => setShowWalletModal(false)} />
    </main>
  );
}
