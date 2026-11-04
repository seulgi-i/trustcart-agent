import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'TrustCart Agent', description: 'AI chooses. Your rules authorize. A PayPal Sandbox demo.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-stone-50 text-stone-900 antialiased">
        <div className="bg-amber-100 px-4 py-2 text-center text-sm text-amber-900">PayPal Sandbox demo. No real money moves.</div>
        {children}
      </body>
    </html>
  );
}
