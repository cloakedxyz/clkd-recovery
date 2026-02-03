# clkd-recovery

Recover your Cloaked stealth address private keys — entirely client-side.

### [recovery.staycloaked.xyz](https://recovery.staycloaked.xyz)

---

## What is this?

A standalone recovery tool for [Cloaked](https://staycloaked.xyz) stealth addresses. If you need to verify your stealth addresses or recover funds as a last resort, this tool derives your stealth private keys using only your wallet signature and PIN — no servers, no API calls, no logging.

## How it works

1. **Connect** the wallet you used to create your Cloaked account
2. **Enter** your 4-digit PIN
3. **Sign** a message with your wallet (generates the cryptographic seed)
4. **View** your derived stealth addresses and private keys

All key derivation happens locally in your browser using [`@cloakedxyz/clkd-stealth`](https://github.com/cloakedxyz/clkd-stealth). Nothing is sent to any server.

## Security

- Zero API calls — all derivation is client-side
- Private keys are held only in React component state and cleared on disconnect
- Security headers enforced via Next.js config
- Console warning deters social engineering attacks
- Open source so you can verify the code yourself

## Running locally

```bash
# Clone the repo
git clone https://github.com/cloakedxyz/clkd-recovery.git
cd clkd-recovery

# Install dependencies
pnpm install

# Set up environment variables
cp .env.example .env.local
# Add your WalletConnect project ID to .env.local

# Start the dev server
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Environment variables

| Variable                               | Description                                                            |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | WalletConnect Cloud project ID (required for WalletConnect QR support) |

## Tech stack

- [Next.js 14](https://nextjs.org/) (App Router) + TypeScript
- [Tailwind CSS](https://tailwindcss.com/)
- [wagmi v2](https://wagmi.sh/) + [viem](https://viem.sh/)
- [@cloakedxyz/clkd-stealth](https://github.com/cloakedxyz/clkd-stealth)

## License

MIT
