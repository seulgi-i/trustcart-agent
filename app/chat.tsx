'use client';
import { useChat } from '@ai-sdk/react';
import { useState } from 'react';
import type { ShoppingMessage } from '@/lib/agent';

// Tool results are summarized; seller descriptions are never rendered here.
function toolSummary(type: string, output: unknown) {
  const o = output as { ok?: boolean; error?: string; products?: { id: string; scannerHits: string[] }[]; preview?: { decision: string; totalCents: number }; status?: string };
  if (o?.ok === false) return o.error;
  if (type === 'tool-searchProducts') return `${o.products?.length ?? 0} products found (untrusted descriptions); scanner flagged: ${o.products?.filter(p => p.scannerHits.length).map(p => p.id).join(', ') || 'none'}`;
  if (type === 'tool-buildCart') return `Cart saved on server. Preview: ${o.preview?.decision} · $${((o.preview?.totalCents ?? 0) / 100).toFixed(2)}`;
  if (type === 'tool-checkout') return `Order submitted: ${o.status}`;
  return '';
}

export function Chat() {
  const { messages, sendMessage, status, error } = useChat<ShoppingMessage>();
  const [input, setInput] = useState('');
  return (
    <section className="mt-6 rounded border border-stone-300 bg-white p-3 text-sm">
      <strong>Agent</strong>
      <div className="mt-2 max-h-96 space-y-2 overflow-y-auto">
        {messages.map(m => (
          <div key={m.id} className={m.role === 'user' ? 'text-right' : ''}>
            {m.parts.map((part, i) => {
              if (part.type === 'text') return <p key={i} className="whitespace-pre-wrap">{part.text}</p>;
              if (part.type.startsWith('tool-') && 'state' in part) return (
                <p key={i} className="text-xs text-stone-500">[{part.type.slice(5)}] {part.state === 'output-available' ? toolSummary(part.type, part.output) : part.state}</p>
              );
              return null;
            })}
          </div>
        ))}
        {error && <p className="text-red-700">{error.message}</p>}
      </div>
      <form className="mt-2 flex gap-2" onSubmit={e => { e.preventDefault(); if (input.trim()) { sendMessage({ text: input }); setInput(''); } }}>
        <input className="flex-1 border px-2 py-1" value={input} onChange={e => setInput(e.target.value)} placeholder="e.g. 캠핑 랜턴 2개 골라줘 / 주문해줘" disabled={status !== 'ready'} />
        <button className="rounded bg-stone-800 px-3 py-1 text-white" disabled={status !== 'ready'}>Send</button>
      </form>
    </section>
  );
}
