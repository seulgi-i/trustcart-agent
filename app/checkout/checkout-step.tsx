'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

const DONE: Record<string, string> = {
  PAID: 'Payment completed.',
  FAILED: 'Payment was not completed. You have not been charged.',
  CANCELLED: 'Payment cancelled. You have not been charged.',
};
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
type Notice = { totalCents: number; merchant: string; items: string[]; remainingSeconds: number };
type Outcome = { status?: string; error?: string; provider?: string; captureId?: string; reason?: string; retryAfterSeconds?: number };

const BackLink = () => <Link href="/approvals" className="mt-4 inline-block underline">Back to the review inbox</Link>;

// Posts the order ID once to the cancel route. The server ignores PayPal's query parameters and works from the
// stored order, so the ID here only selects which of this session's orders to finish.
export function CheckoutStep({ orderId }: { orderId: string | null }) {
  const [text, setText] = useState('Cancelling…');
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    if (!orderId) { setText('Missing order.'); return; }
    fetch(`/api/checkout/${encodeURIComponent(orderId)}/cancel`, { method: 'POST' })
      .then(async res => {
        const body = await res.json().catch(() => ({})) as Outcome;
        setText(!res.ok ? body.error ?? 'Something went wrong.' : DONE[body.status ?? ''] ?? body.status ?? '');
      })
      .catch(() => setText('Could not reach the server. Reload to try again.'));
  }, [orderId]);
  return <div className="mt-4 text-sm"><p className="text-lg">{text}</p><BackLink /></div>;
}

// Buyer is back from PayPal. Nothing is captured yet: the server schedules the charge and we show a pre-charge
// notice with a countdown and a Cancel button. Only when the countdown ends do we call capture, and the server
// refuses that capture until its own clock says the delay has passed, so this timer is a convenience, not the guard.
export function PrechargeCapture({ orderId }: { orderId: string | null }) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [text, setText] = useState('Preparing your payment…');
  const [detail, setDetail] = useState('');
  const [phase, setPhase] = useState<'loading' | 'countdown' | 'capturing' | 'done'>('loading');
  const [paid, setPaid] = useState(false);
  const started = useRef(false);
  const id = orderId ? encodeURIComponent(orderId) : '';

  const finish = (res: Response, body: Outcome) => {
    setPhase('done');
    if (!res.ok) { setText(body.error ?? 'Something went wrong.'); return; }
    setPaid(body.status === 'PAID');
    setText(DONE[body.status ?? ''] ?? body.status ?? '');
    setDetail(body.captureId ? `provider=${body.provider} capture=${body.captureId}` : body.reason ? `Reason: ${body.reason}` : '');
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!orderId) { setText('Missing order.'); setPhase('done'); return; }
    fetch(`/api/checkout/${id}/precharge`, { method: 'POST' })
      .then(async res => {
        const body = await res.json().catch(() => ({})) as Outcome & Partial<Notice>;
        if (!res.ok || body.status !== 'AWAITING_PAYMENT') return finish(res, body);
        setNotice(body as Notice);
        setRemaining(body.remainingSeconds ?? 0);
        setPhase('countdown');
      })
      .catch(() => { setText('Could not reach the server. Reload to try again; you will not be charged twice.'); setPhase('done'); });
  }, [orderId, id]);

  useEffect(() => {
    if (phase !== 'countdown') return;
    if (remaining > 0) {
      const timer = setTimeout(() => setRemaining(r => r - 1), 1000);
      return () => clearTimeout(timer);
    }
    setPhase('capturing');
    fetch(`/api/checkout/${id}/capture`, { method: 'POST' })
      .then(async res => {
        const body = await res.json().catch(() => ({})) as Outcome;
        // Our clock ran ahead of the server's: wait out the remainder and try again.
        if (res.status === 409 && body.retryAfterSeconds) { setRemaining(body.retryAfterSeconds); setPhase('countdown'); return; }
        finish(res, body);
      })
      .catch(() => { setText('Could not reach the server. Reload to try again; you will not be charged twice.'); setPhase('done'); });
  }, [phase, remaining, id]);

  async function cancel() {
    setPhase('done');
    setText('Cancelling…');
    const res = await fetch(`/api/checkout/${id}/precharge/cancel`, { method: 'POST' }).catch(() => null);
    if (!res) { setText('Could not reach the server. Try cancelling again from the review inbox.'); return; }
    finish(res, await res.json().catch(() => ({})) as Outcome);
  }

  return (
    <div className="mt-4 text-sm">
      {notice && phase === 'countdown' ? (
        <div role="alert" className="rounded border border-amber-400 bg-amber-50 p-3">
          <p className="text-base">
            Payment scheduled: <strong>{usd(notice.totalCents)}</strong> to <strong>{notice.merchant}</strong> for {notice.items.join(', ')}.
            {' '}Capture in <strong>{remaining}</strong> {remaining === 1 ? 'second' : 'seconds'} —{' '}
            <button onClick={cancel} className="rounded border border-stone-500 bg-white px-2 py-0.5 font-medium hover:bg-stone-100">Cancel</button>
          </p>
        </div>
      ) : (
        <p className="text-lg">{phase === 'capturing' ? 'Completing your payment…' : text}</p>
      )}
      {detail && <p className="mt-1 font-mono text-xs">{detail}</p>}
      {paid && orderId && <Link href={`/orders/${id}`} className="mt-4 mr-4 inline-block underline">View the signed mandate and refund protection</Link>}
      <BackLink />
    </div>
  );
}
