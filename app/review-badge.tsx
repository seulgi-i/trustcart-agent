'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';

// In-app notification only (no OS notifications). Polls this session's inbox.
export function ReviewBadge() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const poll = () => fetch('/api/approvals').then(r => (r.ok ? r.json() : { needsReview: 0 })).then(d => setCount(d.needsReview ?? 0)).catch(() => {});
    poll();
    const timer = setInterval(poll, 3000);
    return () => clearInterval(timer);
  }, []);
  return (
    <Link href="/approvals" className="rounded px-2 py-1 hover:bg-stone-200">
      Reviews{count > 0 && <span className="ml-2 rounded-full bg-red-600 px-2 py-0.5 text-xs text-white">{count} {count === 1 ? 'order' : 'orders'} to review</span>}
    </Link>
  );
}
