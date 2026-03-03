'use client';

import { useState } from 'react';

interface PostRecoveryGuideProps {
  onRetry: () => void;
  recoveryMethod: 'wallet' | 'backup';
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`w-5 h-5 text-text-muted transition-transform ${open ? 'rotate-180' : ''}`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

export function PostRecoveryGuide({ onRetry, recoveryMethod }: PostRecoveryGuideProps) {
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    what: false,
    how: false,
    wrongPin: false,
  });

  const toggle = (key: string) => setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className="mb-6 border border-gray-200 border-l-4 border-l-primary rounded-lg bg-white overflow-hidden">
      {/* Section 1 */}
      <div>
        <button
          type="button"
          onClick={() => toggle('what')}
          className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50 transition-colors"
        >
          <span className="text-sm font-semibold text-text-primary">What are these keys?</span>
          <ChevronIcon open={openSections.what} />
        </button>
        {openSections.what && (
          <ul className="px-4 pb-4 text-sm text-text-muted space-y-2 list-disc list-inside">
            <li>
              Each row is a stealth address your Cloaked account generated, paired with its private
              key.
            </li>
            <li>
              Your funds may be on any of these addresses. Check them on a block explorer or in the
              Cloaked UI.
            </li>
            <li>
              Keys are derived sequentially by nonce. If you don&apos;t see your address, try
              &quot;Derive More&quot;.
            </li>
          </ul>
        )}
      </div>

      <hr className="border-gray-200" />

      {/* Section 2 */}
      <div>
        <button
          type="button"
          onClick={() => toggle('how')}
          className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50 transition-colors"
        >
          <span className="text-sm font-semibold text-text-primary">
            How to use your private key
          </span>
          <ChevronIcon open={openSections.how} />
        </button>
        {openSections.how && (
          <div className="px-4 pb-4 text-sm text-text-muted space-y-2">
            <ol className="list-decimal list-inside space-y-1.5">
              <li>Copy the private key for the address that holds your funds.</li>
              <li>
                Open any wallet that supports private key import (MetaMask, Rabby, Rainbow, Coinbase
                Wallet, etc.).
              </li>
              <li>
                Look for &quot;Import Account&quot; or &quot;Import Private Key&quot; in the
                wallet&apos;s settings or account menu.
              </li>
              <li>Paste the private key. The wallet should show the matching stealth address.</li>
              <li>
                <strong className="text-text-primary">
                  Verify the address in your wallet matches the one shown here.
                </strong>{' '}
                If it doesn&apos;t, something went wrong.
              </li>
              <li>Send your funds to your desired destination address.</li>
            </ol>
            <p className="text-xs mt-2">
              <strong className="text-text-primary">ERC-20 tokens:</strong> You must import the key
              into a wallet and interact with the token contract. A simple ETH transfer won&apos;t
              move tokens.
            </p>
            <p className="text-xs">
              <strong className="text-text-primary">7702-delegated accounts:</strong> If your
              stealth address has an active EIP-7702 delegation, your private key can still sign and
              send outbound transactions to other addresses. The delegated code only runs when
              something calls your address, not when you send funds out.
            </p>
          </div>
        )}
      </div>

      <hr className="border-gray-200" />

      {/* Section 3: Wrong PIN? or Wrong backup? */}
      {recoveryMethod === 'wallet' ? (
        <div className="bg-amber-50/50">
          <button
            type="button"
            onClick={() => toggle('wrongPin')}
            className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-amber-50 transition-colors"
          >
            <span className="text-sm font-semibold text-amber-700">Wrong PIN?</span>
            <ChevronIcon open={openSections.wrongPin} />
          </button>
          {openSections.wrongPin && (
            <div className="px-4 pb-4 text-sm text-amber-800 space-y-2">
              <p>
                <strong>Entering an incorrect PIN will still produce keys</strong>, but they
                won&apos;t be the right ones.
              </p>
              <p>
                If you don&apos;t recognize any of these addresses, you likely entered the wrong
                PIN.
              </p>
              <p className="text-xs">
                If you forgot your PIN, there are only 10,000 possible combinations (0000-9999). You
                can try different PINs until you find addresses you recognize.
              </p>
              <button
                type="button"
                onClick={onRetry}
                className="mt-1 text-sm font-medium text-amber-700 hover:text-amber-900 px-3 py-1.5 rounded-md border border-amber-300 hover:border-amber-400 transition-colors"
              >
                Try Different PIN
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="bg-amber-50/50">
          <button
            type="button"
            onClick={() => toggle('wrongPin')}
            className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-amber-50 transition-colors"
          >
            <span className="text-sm font-semibold text-amber-700">Wrong backup?</span>
            <ChevronIcon open={openSections.wrongPin} />
          </button>
          {openSections.wrongPin && (
            <div className="px-4 pb-4 text-sm text-amber-800 space-y-2">
              <p>
                If you don&apos;t recognize these addresses, you may have uploaded the wrong backup
                file or this backup was created for a different account.
              </p>
              <button
                type="button"
                onClick={onRetry}
                className="mt-1 text-sm font-medium text-amber-700 hover:text-amber-900 px-3 py-1.5 rounded-md border border-amber-300 hover:border-amber-400 transition-colors"
              >
                Try Different Backup
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
