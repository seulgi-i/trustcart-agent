import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { ReviewBadge } from './review-badge';
import { paymentProvider } from '@/src/server/payments/select';
export const metadata: Metadata = { title: 'TrustCart Agent', description: 'AI chooses. Your rules authorize. A PayPal Sandbox demo.' };
// Only the provider kind is shown, never its configuration.
function providerBanner() {
  try {
    return paymentProvider().kind === 'paypal-sandbox'
      ? 'Demo. Payments use PayPal Sandbox only. No real money moves.'
      : 'Demo. Payments use a MOCK provider. No real money moves.';
  } catch {
    return 'Demo. Payment provider is misconfigured; payments are unavailable. No real money moves.';
  }
}
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-stone-50 text-stone-900 antialiased">
        <div className="bg-amber-100 px-4 py-2 text-center text-sm text-amber-900">{providerBanner()}</div>
        <nav className="mx-auto flex max-w-4xl gap-2 px-4 pt-3 text-sm"><Link href="/" className="rounded px-2 py-1 hover:bg-stone-200">Shop</Link><ReviewBadge /><Link href="/orders" className="rounded px-2 py-1 hover:bg-stone-200">My orders</Link><Link href="/policy" className="rounded px-2 py-1 hover:bg-stone-200">Policy</Link></nav>
        {children}
      </body>
    </html>
  );
}
