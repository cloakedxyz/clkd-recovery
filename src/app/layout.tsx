import type { Metadata } from 'next';
import { Nunito } from 'next/font/google';
import { Providers } from './providers';
import './globals.css';

const nunito = Nunito({
  subsets: ['latin'],
  variable: '--font-nunito',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Cloaked Recovery',
  description: 'Recover your Cloaked stealth address private keys entirely client-side.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={nunito.variable}>
      <body className="font-sans min-h-screen">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
