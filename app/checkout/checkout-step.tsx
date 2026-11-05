'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

const DONE: Record<string, string> = {
  PAID: 'Payment completed.',
  FAILED: 'Payment was not completed. You have not been charged.',
  CANCELLED: 'Payment cancelled. You have not been charged.',
};

// Posts the order ID once to the capture or cancel route. The server ignores PayPal's query parameters and
// works from the stored order, so the ID here only selects which of this session's orders to finish.
export function CheckoutStep({ orderId, action }: { orderId: string | null; action: 'capture' | 'cancel' }) {
  const [text, setText] = useState(action === 'capture' ? 'Completing your payment…' : 'Cancelling…');
  const [detail, setDetail] = useState('');
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    if (!orderId) { setText('Missing order.'); return; }
    fetch(`/api/checkout/${encodeURIComponent(orderId)}/${action}`, { method: 'POST' })
      .then(async res => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) { setText(body.error ?? 'Something went wrong.'); return; }
        setText(DONE[body.status] ?? body.status);
        setDetail(body.captureId ? `provider=${body.provider} capture=${body.captureId}` : body.reason ? `Reason: ${body.reason}` : '');
      })
      .catch(() => setText('Could not reach the server. Reload to try again; you will not be charged twice.'));
  }, [orderId, action]);
  return (
    <div className="mt-4 text-sm">
      <p className="text-lg">{text}</p>
      {detail && <p className="mt-1 font-mono text-xs">{detail}</p>}
      <Link href="/approvals" className="mt-4 inline-block underline">Back to the review inbox</Link>
    </div>
  );
}
