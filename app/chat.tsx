'use client';
import { useChat } from '@ai-sdk/react';
import { useState } from 'react';
import type { ShoppingMessage } from '@/lib/agent';

// Tool results are summarized; seller descriptions are never rendered here.
function toolSummary(type: string, output: unknown) {
  const o = output as { ok?: boolean; error?: string; blocked?: string; saved?: { category: string; quantity: number }; requested?: { category: string; quantity?: number }; products?: { id: string; scannerHits: string[] }[]; preview?: { decision: string; totalCents: number }; status?: string };
  if (o?.blocked === 'INTENT_MISMATCH') return `Blocked: intent mismatch (saved ${o.saved?.category} ×${o.saved?.quantity}, requested ${o.requested?.category}${o.requested?.quantity == null ? '' : ` ×${o.requested.quantity}`}). Update Purchase intent first.`;
  if (o?.ok === false) return o.error;
  if (type === 'tool-searchProducts') return `${o.products?.length ?? 0} products found (untrusted descriptions); scanner flagged: ${o.products?.filter(p => p.scannerHits.length).map(p => p.id).join(', ') || 'none'}`;
  if (type === 'tool-buildCart') return `Cart saved on server. Preview: ${o.preview?.decision} · $${((o.preview?.totalCents ?? 0) / 100).toFixed(2)}`;
  if (type === 'tool-checkout') return `Order submitted: ${o.status}`;
  return '';
}

// Non-2xx responses from /api/chat (429 rate limit, 503 ...) arrive as their JSON body; show only its message.
function errorText(error: Error) {
  try {
    const body = JSON.parse(error.message) as { error?: unknown };
    if (typeof body.error === 'string') return body.error;
  } catch {}
  return error.message || 'The AI request failed.';
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
        {(status === 'submitted' || status === 'streaming') && <p className="text-xs text-stone-500">Agent is thinking...</p>}
        {error && <p className="text-red-700">{errorText(error)}</p>}
      </div>
      <form className="mt-2 flex gap-2" onSubmit={e => { e.preventDefault(); if (input.trim()) { sendMessage({ text: input }); setInput(''); } }}>
        <input className="flex-1 border px-2 py-1" value={input} onChange={e => setInput(e.target.value)} placeholder="e.g. Pick 2 camping lanterns / Place the order" disabled={status !== 'ready'} />
        <button className="rounded bg-stone-800 px-3 py-1 text-white" disabled={status !== 'ready'}>Send</button>
      </form>
    </section>
  );
}
