'use client';
import { useEffect, useState } from 'react';
import type { Evaluation } from '@/src/domain/policy';

type Order = {
  id: string; status: string; totalCents: number; provider: string | null; providerOrderId: string | null; captureId: string | null;
  approvalUrl: string | null; failureReason: string | null; createdAt: string;
  intent: { budgetCents: number; category: string; quantity: number }; evaluation: Evaluation;
};
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const PROVIDER_LABEL: Record<string, string> = { mock: 'MOCK provider, no real money', 'paypal-sandbox': 'PayPal sandbox, no real money' };
const HEADLINE: Record<string, string> = {
  NEEDS_APPROVAL: 'This purchase needs your review.',
  READY: 'Policy checks passed. Confirm to pay.',
  DENIED: "This cart doesn't match your purchase limits. It cannot be approved.",
  REJECTED: 'Rejected. No payment was captured.',
  PAYMENT_CREATING: 'Preparing payment…',
  AWAITING_PAYMENT: 'Waiting for you to approve the payment.',
  CAPTURING: 'Payment in progress…',
  CANCELLED: 'Payment cancelled. You have not been charged.',
  PAID: 'Payment completed.',
  FAILED: 'Payment was not completed. You have not been charged.',
};

export function Inbox() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [provider, setProvider] = useState('');
  const [message, setMessage] = useState('');
  const load = () => fetch('/api/approvals').then(r => r.json()).then(d => { setOrders(d.orders ?? []); setProvider(d.provider ?? ''); }).catch(() => setMessage('Could not load the inbox.'));
  useEffect(() => { load(); }, []);

  // Approve/confirm only creates the payment; the buyer then approves it on the provider page and comes back to /checkout/return.
  async function decide(id: string, status: 'APPROVED' | 'REJECTED') {
    const res = await fetch(`/api/approvals/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.approvalUrl) return window.location.assign(body.approvalUrl);
    setMessage(res.ok ? `Order ${id}: ${body.status}` : body.error ?? (body.reason ? `Payment could not be created (${body.reason}).` : 'Failed.'));
    await load();
  }

  async function cancel(id: string) {
    const res = await fetch(`/api/checkout/${id}/cancel`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    setMessage(res.ok ? `Order ${id}: ${body.status}` : body.error ?? 'Failed.');
    await load();
  }

  if (!orders) return <p className="mt-4 text-sm">{message || 'Loading…'}</p>;
  if (!orders.length) return <p className="mt-4 text-sm text-stone-600">No orders yet. Ask the agent to check out a cart.</p>;
  return (
    <div className="mt-4 space-y-4 text-sm">
      {provider && <p className="text-stone-600">Payments: {PROVIDER_LABEL[provider] ?? 'PayPal is misconfigured; payments will fail.'}</p>}
      {message && <p className="text-stone-700">{message}</p>}
      {orders.map(o => {
        const { reasons, scan, diff, lines } = o.evaluation;
        return (
          <article key={o.id} className="rounded border border-stone-300 bg-white p-3">
            <div className="flex justify-between"><strong>{HEADLINE[o.status] ?? o.status}</strong><span className="font-mono text-xs">{o.status}</span></div>
            <p className="mt-1 text-lg">{usd(o.totalCents)} <span className="text-xs text-stone-500">order {o.id}</span></p>

            <h3 className="mt-2 font-medium">Rules hit</h3>
            {reasons.length ? <ul className="list-disc pl-5">{reasons.map((r, i) => <li key={i}><span className={r.outcome === 'DENY' ? 'text-red-700' : 'text-amber-700'}>{r.outcome}</span> {r.rule}: expected {r.expected}, got {r.actual}</li>)}</ul> : <p>None</p>}

            <h3 className="mt-2 font-medium">Injection scanner</h3>
            {scan.length ? <ul className="list-disc pl-5">{scan.map(s => <li key={s.productId}>{s.productId}: suspicious instructions ({s.hits.join(', ')})</li>)}</ul> : <p>No suspicious instructions found (not a guarantee).</p>}

            <h3 className="mt-2 font-medium">Requested vs. cart</h3>
            <table className="w-full text-left"><thead><tr className="text-stone-500"><th></th><th>Your intent</th><th>Cart</th></tr></thead><tbody>
              <tr><td>Budget</td><td>{usd(diff.budgetCents[0])}</td><td className={diff.budgetCents[1] > diff.budgetCents[0] ? 'text-red-700' : ''}>{usd(diff.budgetCents[1])}</td></tr>
              <tr><td>Quantity</td><td>{diff.quantity[0]}</td><td className={diff.quantity[1] !== diff.quantity[0] ? 'text-red-700' : ''}>{diff.quantity[1]}</td></tr>
              <tr><td>Category</td><td>{diff.category[0]}</td><td className={diff.category[1].some(c => c !== diff.category[0]) ? 'text-red-700' : ''}>{diff.category[1].join(', ')}</td></tr>
            </tbody></table>
            <ul className="mt-1 text-stone-600">{lines.map(l => <li key={l.productId}>{l.quantity} × {l.name} ({l.productId}, {l.seller}) = {usd(l.subtotalCents)}</li>)}</ul>

            {o.providerOrderId && <p className="mt-2 font-mono text-xs">provider={o.provider} order={o.providerOrderId}{o.captureId && ` capture=${o.captureId}`}</p>}
            {o.failureReason && o.status !== 'CANCELLED' && <p className="mt-1 text-red-700">Reason: {o.failureReason}</p>}
            {(o.status === 'NEEDS_APPROVAL' || o.status === 'READY') && (
              <div className="mt-3 flex gap-2">
                <button onClick={() => decide(o.id, 'APPROVED')} className="rounded bg-stone-800 px-3 py-1 text-white">{o.status === 'READY' ? 'Confirm and pay' : 'Approve and pay'} {usd(o.totalCents)}</button>
                <button onClick={() => decide(o.id, 'REJECTED')} className="rounded border border-stone-400 px-3 py-1">Reject</button>
              </div>
            )}
            {o.status === 'AWAITING_PAYMENT' && (
              <div className="mt-3 flex gap-2">
                {o.approvalUrl && <a href={o.approvalUrl} className="rounded bg-stone-800 px-3 py-1 text-white">Pay {usd(o.totalCents)}</a>}
                <button onClick={() => cancel(o.id)} className="rounded border border-stone-400 px-3 py-1">Cancel payment</button>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
