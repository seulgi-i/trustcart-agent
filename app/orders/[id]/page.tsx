import Link from 'next/link';
import { SessionStatus } from '../../session-status';
import { OrderProtection } from './order-protection';

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <Link href="/orders" className="text-sm underline">← My orders</Link>
      <h1 className="mt-2 text-2xl font-semibold">Order protection</h1>
      <SessionStatus><OrderProtection orderId={id} /></SessionStatus>
    </main>
  );
}
