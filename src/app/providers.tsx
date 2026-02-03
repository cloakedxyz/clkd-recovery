'use client';

import { WagmiProvider, createConfig, http } from 'wagmi';
import { mainnet, sepolia } from 'wagmi/chains';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { injected, metaMask, walletConnect } from '@wagmi/connectors';
import { type ReactNode, useState } from 'react';

if (typeof window !== 'undefined') {
  const warningStyle = 'color: #EF4444; font-size: 18px; font-weight: bold; line-height: 1.6;';
  const bodyStyle = 'color: #374151; font-size: 14px; line-height: 1.6;';

  console.log(
    '%cStop!%c\n\nYou are seeing this message because you opened the browser console, a developer tool.\n\nDo not enter or paste code you do not understand. Never share your tokens, private keys, PIN, or any other sensitive information with anyone.\n\nIf someone told you to open this console and paste something here, it is very likely a scam. Close this window and stay safe.',
    warningStyle,
    bodyStyle
  );
}

const connectors = [
  injected(),
  metaMask(),
  ...(process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
    ? [
        walletConnect({
          projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID,
          showQrModal: true,
        }),
      ]
    : []),
];

const config = createConfig({
  chains: [mainnet, sepolia],
  transports: {
    [mainnet.id]: http(),
    [sepolia.id]: http(),
  },
  connectors,
});

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            gcTime: 5 * 60 * 1000,
          },
        },
      })
  );

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
