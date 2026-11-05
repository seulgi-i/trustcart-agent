'use client';
import { useState } from 'react';

export function LoginForm({ next }: { next: string }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
      if (res.ok) { window.location.assign(next); return; }
      setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? '로그인에 실패했습니다.');
    } catch {
      setError('로그인에 실패했습니다.');
    }
    setBusy(false);
  }
  return (
    <form className="mt-6 flex flex-col gap-2 text-sm" onSubmit={submit}>
      <label htmlFor="demo-password">Demo password</label>
      <input id="demo-password" type="password" autoComplete="current-password" className="border px-2 py-1" value={password} onChange={e => setPassword(e.target.value)} required />
      <button className="rounded bg-stone-800 px-3 py-1 text-white disabled:opacity-50" disabled={busy || !password}>Enter</button>
      {error && <p className="text-red-700">{error}</p>}
    </form>
  );
}
