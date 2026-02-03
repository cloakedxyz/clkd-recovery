'use client';

import { useState, useEffect } from 'react';
import { useConnect } from 'wagmi';
import { mainnet } from 'wagmi/chains';
import type { Connector } from 'wagmi';

interface WalletSelectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect?: () => void;
  onError?: () => void;
}

function isUserRejection(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('user rejected') ||
      msg.includes('user denied') ||
      msg.includes('user cancelled') ||
      msg.includes('rejected the request')
    );
  }
  return false;
}

export function WalletSelectModal({ isOpen, onClose, onConnect, onError }: WalletSelectModalProps) {
  const { connect, isPending, connectors } = useConnect();
  const [connectingConnectorId, setConnectingConnectorId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setConnectingConnectorId(null);
      setError(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const isMobile = (): boolean => {
    if (typeof window === 'undefined') return false;
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent
    );
  };

  const isSafari = (): boolean => {
    if (typeof window === 'undefined') return false;
    const ua = navigator.userAgent;
    const hasSafari = /Safari/i.test(ua);
    const isChrome = /Chrome/i.test(ua) || /CriOS/i.test(ua);
    const isChromium = /Chromium/i.test(ua);
    const isEdge = /Edg/i.test(ua);
    const isFirefoxIOS = /FxiOS/i.test(ua);
    return hasSafari && !isChrome && !isChromium && !isEdge && !isFirefoxIOS;
  };

  const matchesConnector = (connector: Connector, patterns: string[]): boolean => {
    const id = connector.id.toLowerCase();
    const type = (connector as any).type?.toLowerCase() || '';
    const name = connector.name?.toLowerCase() || '';
    return patterns.some(
      (pattern) =>
        id === pattern || id.includes(pattern) || name.includes(pattern) || type === pattern
    );
  };

  const availableConnectors = connectors
    .filter((c) => {
      if (matchesConnector(c, ['coinbase'])) return false;

      if (isMobile() || isSafari()) {
        return matchesConnector(c, ['walletconnect', 'walletconnectlegacy']);
      }

      const isWalletConnect = matchesConnector(c, ['walletconnect', 'walletconnectlegacy']);
      if (isWalletConnect) return true;

      const id = c.id.toLowerCase();
      const type = (c as any).type?.toLowerCase() || '';
      const isInjected =
        id === 'injected' ||
        type === 'injected' ||
        (id.includes('injected') && !id.includes('metamask'));
      const isMetaMask = matchesConnector(c, ['metamask']);
      const isRainbow = matchesConnector(c, ['rainbow']);

      return isInjected || isMetaMask || isRainbow;
    })
    .sort((a, b) => {
      const getSortOrder = (connector: Connector): number => {
        const id = connector.id.toLowerCase();
        if (id.includes('injected') && !id.includes('metamask')) return 1;
        if (id.includes('metamask')) return 2;
        if (id.includes('rainbow')) return 3;
        if (id.includes('walletconnect')) return 4;
        return 5;
      };
      return getSortOrder(a) - getSortOrder(b);
    });

  const handleConnect = (connector: Connector) => {
    setError(null);
    setConnectingConnectorId(connector.id);
    if (onConnect) onConnect();

    connect(
      { connector, chainId: mainnet.id },
      {
        onSuccess: () => {
          setConnectingConnectorId(null);
          onClose();
        },
        onError: (err) => {
          if (isUserRejection(err)) {
            if (onError) onError();
            setConnectingConnectorId(null);
            onClose();
            return;
          }
          setError(
            err instanceof Error ? err.message : 'Failed to connect wallet. Please try again.'
          );
          if (onError) onError();
          setConnectingConnectorId(null);
        },
      }
    );
  };

  const getWalletDisplayName = (connector: Connector): string => {
    const id = connector.id.toLowerCase();
    const isInjected = id.includes('injected') && !id.includes('metamask');

    if (isInjected) {
      const hasWallet = typeof window !== 'undefined' && window.ethereum !== undefined;
      return hasWallet ? 'Browser Wallet (detected)' : 'Browser Wallet (auto detect)';
    }

    if (connector.name && connector.name !== connector.id) {
      return connector.name;
    }

    const nameMap: Record<string, string> = {
      walletconnect: 'WalletConnect',
      metamask: 'MetaMask',
      rabby: 'Rabby',
      rainbow: 'Rainbow',
    };

    for (const [key, value] of Object.entries(nameMap)) {
      if (id === key || id.includes(key)) return value;
    }

    return connector.name || connector.id;
  };

  const getWalletIcon = (connector: Connector): string | null => {
    const id = connector.id.toLowerCase();
    if (id.includes('walletconnect')) return '/walletconnect-logo.svg';
    if (id.includes('metamask')) return '/metamask-logo.svg';
    if (id.includes('rabby')) return '/rabby-logo.svg';
    if (id.includes('rainbow')) return '/rainbow-logo.png';
    return null;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />

      <div
        className="relative bg-white rounded-lg p-6 border border-gray-200 shadow-card-md w-full max-w-md space-y-4 z-10 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          disabled={isPending}
          className="absolute top-4 right-4 text-text-muted hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          aria-label="Close"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>

        <h2 className="text-text-primary font-semibold text-xl mb-4">Connect a wallet</h2>

        <div className="space-y-2">
          {availableConnectors.map((connector) => {
            const isWalletConnect =
              connector.id.toLowerCase().includes('walletconnect') ||
              connector.name?.toLowerCase().includes('walletconnect');
            const iconPath = getWalletIcon(connector);

            return (
              <button
                key={connector.id}
                onClick={() => handleConnect(connector)}
                disabled={isPending || connectingConnectorId === connector.id}
                className="w-full flex items-center gap-3 px-4 py-3 bg-gray-50 hover:bg-gray-100 rounded-lg border border-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {iconPath ? (
                  <div className="w-8 h-8 flex-shrink-0 flex items-center justify-center">
                    <img
                      src={iconPath}
                      alt={getWalletDisplayName(connector)}
                      className="w-full h-full object-contain"
                    />
                  </div>
                ) : (
                  <div className="w-8 h-8 flex-shrink-0 flex items-center justify-center">
                    <svg
                      width="24"
                      height="24"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="text-text-primary"
                    >
                      <path d="M19 7V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1" />
                      <path d="M22 11h-6a2 2 0 0 0-2 2v0a2 2 0 0 0 2 2h6v-4z" />
                    </svg>
                  </div>
                )}
                <div className="flex-1 text-left">
                  <div className="text-text-primary font-medium">
                    {getWalletDisplayName(connector)}
                  </div>
                  {isWalletConnect && (
                    <div className="text-text-muted text-xs mt-0.5">Scan QR code to connect</div>
                  )}
                </div>
                {connectingConnectorId === connector.id && (
                  <span className="text-text-muted text-sm">Connecting...</span>
                )}
              </button>
            );
          })}
        </div>

        {error && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-red-600 text-sm">{error}</p>
          </div>
        )}

        <div className="pt-4 mt-4 border-t border-gray-200">
          <p className="text-text-muted text-xs text-center">
            By connecting a wallet, you agree to Cloaked&apos;s Terms of Service
          </p>
        </div>
      </div>
    </div>
  );
}
