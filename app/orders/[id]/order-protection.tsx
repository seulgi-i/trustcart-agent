'use client';
import { useCallback, useEffect, useState } from 'react';
import { policySourceLabel, type MandatePayload } from '@/src/domain/mandate';
import { MISMATCH_SCENARIOS, SCENARIO_LABELS, type DiffEntry, type MismatchScenario } from '@/src/domain/mismatch';
import { describeReason } from '@/src/domain/rule-labels';

type Refund = {
  id: string; scenario: string; status: string; diff: DiffEntry[]; suggestedCents: number; capturedCents: number;
  mode: string | null; amountCents: number | null; providerRefundId: string | null; providerStatus: string | null; failureReason: string | null; retryable: boolean; createdAt: string;
};
type View = {
  order: { id: string; status: string; totalCents: number; provider: string | null; providerOrderId: string | null; captureId: string | null; createdAt: string };
  mandate: { payload: MandatePayload; signature: string; publicKeyFingerprint: string; createdAt: string } | null;
  refundRequests: Refund[]; refundedCents: number; refundableCents: number;
};
type Verification = { valid: boolean; checks: Record<string, boolean>; publicKeyFingerprint: string };
type Check = { scenario: string; diff: DiffEntry[]; refundRequest: Refund | null };

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const show = (field: string, value: string | number | null) => value === null ? '—' : typeof value === 'number' && /Cents$/.test(field) ? usd(value) : String(value);
const scenarioLabel = (s: string) => SCENARIO_LABELS[s as MismatchScenario] ?? s;
const CHECK_LABELS: Record<string, string> = {
  signature: 'Ed25519 signature matches the payload',
  keyFingerprint: 'Signed with this server’s key',
  canonical: 'Payload is in canonical form',
  orderBinding: 'Names this order and its capture',
};
const REFUND_STATUS: Record<string, string> = {
  DRAFT: 'Draft — not submitted yet.',
  REFUNDING: 'Refund in progress…',
  REFUNDED: 'Refunded.',
  PENDING: 'Refund accepted by the provider and pending.',
  FAILED: 'Refund failed. No money was returned.',
};

function DiffTable({ diff }: { diff: DiffEntry[] }) {
  if (!diff.length) return <p className="mt-1 text-green-800">No differences: the billing matches the signed mandate.</p>;
  return (
    <table className="mt-1 w-full text-left">
      <thead><tr className="text-stone-500"><th>Field</th><th>Mandate (approved)</th><th>Billed</th></tr></thead>
      <tbody>{diff.map(d => (
        <tr key={d.field} className="border-t border-stone-200">
          <td className="py-1 pr-2 font-mono text-xs">{d.field}</td>
          <td className="py-1 pr-2">{show(d.field, d.expected)}</td>
          <td className="bg-red-50 py-1 pr-2 font-semibold text-red-700">{show(d.field, d.actual)}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

export function OrderProtection({ orderId }: { orderId: string }) {
  const id = encodeURIComponent(orderId);
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [verification, setVerification] = useState<Verification | null>(null);
  const [scenario, setScenario] = useState<MismatchScenario>('extra_quantity');
  const [check, setCheck] = useState<Check | null>(null);
  const [message, setMessage] = useState('');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/orders/${id}`).catch(() => null);
    const body = await res?.json().catch(() => ({}));
    if (!res?.ok) { setError(body?.error ?? 'Could not load the order.'); return; }
    setView(body as View);
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function verify() {
    setVerification(null);
    const res = await fetch(`/api/orders/${id}/mandate/verify`).catch(() => null);
    const body = await res?.json().catch(() => ({}));
    if (!res?.ok) { setMessage(body?.error ?? 'Could not verify the mandate.'); return; }
    setVerification(body as Verification);
  }

  async function simulate() {
    setBusy(true);
    const res = await fetch(`/api/orders/${id}/mismatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenario }) }).catch(() => null);
    const body = await res?.json().catch(() => ({}));
    setBusy(false);
    if (!res?.ok) { setMessage(body?.error ?? 'Could not check the billing.'); return; }
    setCheck(body as Check);
    setMessage(body.refundRequest ? (body.created ? 'Mismatch found. A refund request draft with the evidence was created below.' : 'Mismatch found. A refund request for this mismatch already exists below.') : '');
    await load();
  }

  async function refund(r: Refund, mode: 'PARTIAL' | 'FULL') {
    let amountCents: number | undefined;
    if (mode === 'PARTIAL') {
      const raw = amounts[r.id] ?? (r.suggestedCents / 100).toFixed(2);
      if (!/^\d+(\.\d{1,2})?$/.test(raw.trim())) { setMessage('Enter the refund amount in dollars, e.g. 18.99.'); return; }
      amountCents = Math.round(Number(raw) * 100);
    }
    setBusy(true);
    const res = await fetch(`/api/refunds/${encodeURIComponent(r.id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode, amountCents }) }).catch(() => null);
    const body = await res?.json().catch(() => ({}));
    setBusy(false);
    setMessage(res?.ok ? `${REFUND_STATUS[body.status] ?? body.status} ${usd(body.amountCents)} refund ID ${body.refundId}` : body?.error ?? (body?.reason ? `Refund failed (${body.reason}).` : 'Refund failed.'));
    await load();
  }

  if (error) return <p className="mt-4 text-sm text-red-700">{error}</p>;
  if (!view) return <p className="mt-4 text-sm">Loading…</p>;
  const { order, mandate } = view;
  const m = mandate?.payload;
  const policySource = m ? policySourceLabel(m.policy) : null;

  return (
    <div className="mt-4 space-y-6 text-sm">
      <section className="rounded border border-stone-300 bg-white p-3">
        <h2 className="text-lg font-medium">Order</h2>
        <p className="mt-1">{usd(order.totalCents)} · <span className="font-mono text-xs">{order.status}</span></p>
        <p className="font-mono text-xs">order={order.id}</p>
        <p className="font-mono text-xs">provider={order.provider ?? '—'} paypalOrder={order.providerOrderId ?? '—'} capture={order.captureId ?? '—'}</p>
        {view.refundedCents > 0 && <p className="mt-1">Refunded so far: {usd(view.refundedCents)}. Still refundable: {usd(view.refundableCents)}.</p>}
      </section>

      <section className="rounded border border-stone-300 bg-white p-3">
        <h2 className="text-lg font-medium">Intent mandate</h2>
        {!m || !mandate ? <p className="mt-1 text-stone-600">No signed mandate. Mandates are issued when a payment is captured.</p> : (
          <>
            <p className="mt-1 text-stone-600">Signed at capture with Ed25519 over the canonical JSON below. Inspired by the AP2 Intent/Cart Mandate concept.</p>
            <h3 className="mt-3 font-medium">Your intent</h3>
            <p>Budget {usd(m.intent.budgetCents)} · {m.intent.quantity} × {m.intent.category}</p>
            <h3 className="mt-3 font-medium">Approved cart</h3>
            <p>Merchant: {m.cart.merchant}</p>
            <ul className="list-disc pl-5">{m.cart.items.map(i => <li key={i.productId}>{i.quantity} × {i.name} ({i.productId}, {i.seller}) @ {usd(i.unitCents)} = {usd(i.subtotalCents)}</li>)}</ul>
            <p>Items {usd(m.cart.itemTotalCents)} + shipping {usd(m.cart.shippingCents)} = <strong>{usd(m.cart.totalCents)} {m.cart.currency}</strong></p>
            <h3 className="mt-3 font-medium">Why these items</h3>
            <ul className="list-disc pl-5">{m.selection.map(s => (
              <li key={s.productId}>
                <span className="font-mono text-xs">{s.productId}</span>: {s.agentReason ? <>Agent said (untrusted): “{s.agentReason}”</> : <span className="text-stone-500">Agent gave no reason.</span>}
                <ul className="list-[circle] pl-5 text-stone-600">{s.serverChecks.map((c, i) => <li key={i}>{c}</li>)}</ul>
              </li>
            ))}</ul>
            <h3 className="mt-3 font-medium">Applied policy</h3>
            <p className={policySource?.reconstructed ? 'rounded border border-amber-300 bg-amber-50 p-2 text-amber-900' : 'text-stone-600'}>Policy source: {policySource?.label}</p>
            <p>{policySource?.reconstructed ?'Decision on record:' : 'Decision at payment approval:'} <span className="font-mono text-xs">{m.policy.decision}</span></p>
            {m.policy.reasons.length > 0 && <ul className="list-disc pl-5">{m.policy.reasons.map((r, i) => { const { title, message } = describeReason(r); return <li key={i}>{r.outcome} <strong>{title}</strong> — {message}</li>; })}</ul>}
            <p>Layer 2: per order {usd(m.policy.layer2.perOrderMaxCents)}, daily {usd(m.policy.layer2.dailyMaxCents)}, review above {usd(m.policy.layer2.requireApprovalAboveCents)}, categories {m.policy.layer2.allowedCategories.join(', ') || '(none)'}, hours {m.policy.layer2.allowedHours.startHour}–{m.policy.layer2.allowedHours.endHour} {m.policy.layer2.timezone}, pre-charge {m.policy.layer2.prechargeDelaySeconds} s.</p>
            <p>Layer 1: {usd(m.policy.layer1.hardCapCents)} per payment, {m.policy.layer1.velocityMax} payments per {m.policy.layer1.velocityWindowMinutes} min, daily cap {usd(m.policy.layer1.dailyHardCapCents)}, monthly cap {usd(m.policy.layer1.monthlyHardCapCents)}.</p>
            <h3 className="mt-3 font-medium">Timestamps</h3>
            <p className="font-mono text-xs">intent={m.timestamps.intentSetAt} order={m.timestamps.orderCreatedAt} precharge={m.timestamps.prechargeScheduledAt ?? '—'} captured={m.timestamps.capturedAt}</p>
            <h3 className="mt-3 font-medium">Signature</h3>
            <p className="break-all font-mono text-xs">fingerprint={mandate.publicKeyFingerprint}</p>
            <p className="break-all font-mono text-xs">signature={mandate.signature}</p>
            <div className="mt-2 flex items-center gap-3">
              <button onClick={verify} className="rounded bg-stone-800 px-3 py-1 text-white">Verify signature</button>
              <a href="/api/mandate/public-key" className="underline" target="_blank" rel="noreferrer">Public key</a>
            </div>
            {verification && (
              <div role="status" className={`mt-2 rounded border p-2 ${verification.valid ? 'border-green-600 bg-green-50 text-green-900' : 'border-red-600 bg-red-50 text-red-800'}`}>
                <strong>{verification.valid ? 'Valid: the mandate is authentic and unmodified.' : 'Invalid: the mandate failed verification.'}</strong>
                <ul className="mt-1">{Object.entries(verification.checks).map(([k, ok]) => <li key={k}>{ok ? '✓' : '✗'} {CHECK_LABELS[k] ?? k}</li>)}</ul>
              </div>
            )}
          </>
        )}
      </section>

      {m && order.status === 'PAID' && (
        <section className="rounded border border-stone-300 bg-white p-3">
          <h2 className="text-lg font-medium">Billing check <span className="text-xs font-normal text-stone-500">(demo)</span></h2>
          <p className="mt-1 text-stone-600">Simulates what the merchant fulfilled and billed, and compares it with the signed mandate. Differences are shown in red.</p>
          <div className="mt-2 flex items-center gap-2">
            <select value={scenario} onChange={e => setScenario(e.target.value as MismatchScenario)} className="rounded border border-stone-400 px-2 py-1">
              {MISMATCH_SCENARIOS.map(s => <option key={s} value={s}>{SCENARIO_LABELS[s]}</option>)}
            </select>
            <button onClick={simulate} disabled={busy} className="rounded bg-stone-800 px-3 py-1 text-white disabled:opacity-50">Simulate billing and compare</button>
          </div>
          {check && <div className="mt-2"><p className="font-medium">{scenarioLabel(check.scenario)}</p><DiffTable diff={check.diff} /></div>}
        </section>
      )}

      {message && <p className="text-stone-800">{message}</p>}

      {view.refundRequests.length > 0 && (
        <section className="rounded border border-stone-300 bg-white p-3">
          <h2 className="text-lg font-medium">Refund requests</h2>
          {view.refundRequests.map(r => (
            <article key={r.id} className="mt-3 border-t border-stone-200 pt-3">
              <div className="flex justify-between"><strong>{scenarioLabel(r.scenario)}</strong><span className="font-mono text-xs">{r.status}</span></div>
              <p>{REFUND_STATUS[r.status] ?? r.status}{r.amountCents !== null && ` ${r.mode === 'FULL' ? 'Full' : 'Partial'} refund of ${usd(r.amountCents)}.`}{r.providerRefundId && <span className="font-mono text-xs"> refund={r.providerRefundId}</span>}{r.failureReason && <span className="text-red-700"> Reason: {r.failureReason}</span>}</p>
              <p className="mt-1 text-stone-600">Evidence: the signed mandate and this diff.</p>
              <DiffTable diff={r.diff} />
              {r.status === 'DRAFT' && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <label>Amount $<input value={amounts[r.id] ?? (r.suggestedCents / 100).toFixed(2)} onChange={e => setAmounts(a => ({ ...a, [r.id]: e.target.value }))} inputMode="decimal" className="ml-1 w-24 rounded border border-stone-400 px-1 py-0.5" /></label>
                  <button onClick={() => refund(r, 'PARTIAL')} disabled={busy} className="rounded bg-stone-800 px-3 py-1 text-white disabled:opacity-50">Refund overcharge (partial)</button>
                  <button onClick={() => refund(r, 'FULL')} disabled={busy || view.refundableCents === 0} className="rounded border border-stone-500 px-3 py-1 disabled:opacity-50">Full refund ({usd(view.refundableCents)})</button>
                  <span className="text-stone-500">Suggested: {usd(r.suggestedCents)} overcharge of {usd(r.capturedCents)} captured.</span>
                </div>
              )}
              {r.retryable && (
                <button onClick={() => refund(r, r.mode === 'FULL' ? 'FULL' : 'PARTIAL')} disabled={busy} className="mt-2 rounded border border-stone-500 px-3 py-1">Retry refund (same amount, no double refund)</button>
              )}
            </article>
          ))}
        </section>
      )}

      <section className="rounded border border-stone-300 bg-white p-3">
        <h2 className="text-lg font-medium">Evidence package</h2>
        <p className="mt-1 text-stone-600">Mandate, signature verification, mismatches, order and capture IDs and the audit trail. Nothing is sent anywhere; no dispute is opened.</p>
        <div className="mt-2 flex gap-3">
          <a href={`/api/orders/${id}/evidence?format=json`} download className="underline">Download JSON</a>
          <a href={`/api/orders/${id}/evidence?format=pdf`} download className="underline">Download PDF</a>
        </div>
      </section>
    </div>
  );
}
