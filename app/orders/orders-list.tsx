'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';

type Order = { id: string; status: string; totalCents: number; createdAt: string; captureId: string | null; evaluation: { lines: { productId: string; name: string; quantity: number }[] } };
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

// This session's orders, newest first (the same list as the review inbox). Paid orders link to their mandate view.
export function OrdersList() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => {
    fetch('/api/approvals').then(r => r.json()).then(d => setOrders(d.orders ?? [])).catch(() => setMessage('Could not load your orders.'));
  }, []);

  if (!orders) return <p className="mt-4 text-sm">{message || 'Loading…'}</p>;
  if (!orders.length) return <p className="mt-4 text-sm text-stone-600">No orders yet. Ask the agent to check out a cart.</p>;
  return (
    <table className="mt-4 w-full text-left text-sm">
      <thead><tr className="text-stone-500"><th>Date</th><th>Items</th><th>Total</th><th>Status</th><th></th></tr></thead>
      <tbody>
        {orders.map(o => (
          <tr key={o.id} className="border-t border-stone-200 align-top">
            <td className="py-2 pr-2 whitespace-nowrap">{new Date(o.createdAt).toLocaleString('en-US')}</td>
            <td className="py-2 pr-2">{o.evaluation.lines.map(l => `${l.quantity} × ${l.name}`).join(', ')}</td>
            <td className="py-2 pr-2">{usd(o.totalCents)}</td>
            <td className="py-2 pr-2 font-mono text-xs">{o.status}</td>
            <td className="py-2">
              {o.status === 'PAID'
                ? <Link href={`/orders/${encodeURIComponent(o.id)}`} className="underline">Mandate &amp; refunds</Link>
                : <Link href="/approvals" className="text-stone-500 underline">Inbox</Link>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
