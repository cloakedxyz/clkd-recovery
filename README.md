# clkd-recovery

Recover your Cloaked stealth address private keys — entirely client-side.

### [recovery.clkd.xyz](https://recovery.clkd.xyz)

---

## What is this?

A standalone recovery tool for [Cloaked](https://clkd.xyz) stealth addresses. If you need to verify your stealth addresses or recover funds as a last resort, this tool derives your stealth private keys locally in your browser — no servers, no API calls, no logging.

Two recovery methods are supported:

- **Wallet + PIN** — connect the wallet you used to create your account and enter your 4-digit PIN
- **Backup file** — upload the encrypted `.json` backup file you downloaded during setup and enter your backup password

Both paths produce the same output: a table of stealth addresses and their private keys that you can import into any wallet.

## How it works

### Wallet + PIN

1. Connect your wallet
2. Enter your 4-digit PIN
3. Sign a message (generates the cryptographic seed)
4. View your derived stealth addresses and private keys

### Backup file

1. Upload your encrypted backup file (`.json`)
2. Enter the password you chose when creating the backup
3. View your derived stealth addresses and private keys

All key derivation happens locally in your browser using [`@cloakedxyz/clkd-stealth`](https://github.com/cloakedxyz/clkd-stealth). Backup decryption uses PBKDF2-SHA256 (600k iterations) + AES-256-GCM via [`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers). Nothing is sent to any server.

## Security

- Zero API calls — all derivation and decryption is client-side
- Private keys are held only in React component state and cleared on navigation/disconnect
- Key material buffers are zeroed immediately after use
- Security headers enforced via Next.js config
- Console warning deters social engineering attacks
- Open source so you can verify the code yourself

## Running locally

```bash
git clone https://github.com/cloakedxyz/clkd-recovery.git
cd clkd-recovery
pnpm install

cp .env.example .env.local
# Add your WalletConnect project ID to .env.local

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
- [@noble/ciphers](https://github.com/paulmillr/noble-ciphers) + [@noble/hashes](https://github.com/paulmillr/noble-hashes)

## License

MIT
