'use client';
import { useEffect, useState } from 'react';

type Intent = { budgetCents: number; category: string; quantity: number };

// The purchase intent is set here by the user. The agent can read it but has no way to change it.
export function IntentForm() {
  const [categories, setCategories] = useState<string[]>([]);
  const [saved, setSaved] = useState<Intent | null>(null);
  const [form, setForm] = useState({ budgetUSD: '40', category: '', quantity: '2' });
  const [message, setMessage] = useState('');

  const load = () => fetch('/api/intent').then(r => r.json()).then((d: { intent: Intent | null; categories: string[] }) => {
    setCategories(d.categories ?? []);
    setSaved(d.intent);
    setForm(f => ({ ...f, category: f.category || d.intent?.category || d.categories?.[0] || '' }));
  });
  useEffect(() => { load().catch(() => setMessage('Could not load the purchase intent.')); }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch('/api/intent', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budgetUSD: Number(form.budgetUSD), category: form.category, quantity: Number(form.quantity) }),
    });
    const body = await res.json().catch(() => ({}));
    setMessage(res.ok ? 'Purchase intent saved.' : body.error ?? 'Could not save.');
    if (res.ok) await load();
  }

  return (
    <form onSubmit={save} className="mt-6 flex flex-wrap items-end gap-3 rounded border border-stone-300 bg-white p-3 text-sm">
      <strong className="w-full">Purchase intent</strong>
      <label>Budget (USD)<input className="ml-1 w-20 border px-1" value={form.budgetUSD} onChange={e => setForm({ ...form, budgetUSD: e.target.value })} /></label>
      <label>Category<select className="ml-1 border" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>{categories.map(c => <option key={c}>{c}</option>)}</select></label>
      <label>Quantity<input className="ml-1 w-14 border px-1" value={form.quantity} onChange={e => setForm({ ...form, quantity: e.target.value })} /></label>
      <button className="rounded bg-stone-800 px-3 py-1 text-white">Save</button>
      <span className="text-stone-600">{saved ? `Current: $${(saved.budgetCents / 100).toFixed(2)} · ${saved.category} · ${saved.quantity} units` : 'No intent saved yet.'} {message}</span>
    </form>
  );
}
