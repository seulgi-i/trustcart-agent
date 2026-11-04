'use client';
import { useEffect, useState } from 'react';

export function SessionStatus() {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    fetch('/api/session', { method: 'POST' }).then(res => setState(res.ok ? 'ready' : 'error')).catch(() => setState('error'));
  }, []);
  const text = { loading: 'Starting demo session…', ready: 'Demo session ready. Your carts and approvals are private to this browser.', error: 'Could not start a demo session.' }[state];
  return <p className={`mt-4 text-sm ${state === 'error' ? 'text-red-700' : 'text-stone-600'}`}>{text}</p>;
}
