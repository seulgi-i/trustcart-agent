import test from 'node:test';
import assert from 'node:assert/strict';
import { convertToModelMessages, isStepCount, streamText, tool } from 'ai';
import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { classifyText, categoryVocabulary, gateSearch } from '../src/domain/intent-gate';
import { dropBlockedTurns, latestUserText } from '../lib/agent';
import { matchingProducts, searchSchema, toolProduct } from '../lib/shop';
import { runtimeCatalog } from '../src/server/catalog';
import { createMockModel } from '../src/server/ai/mock-model';

const catalog = runtimeCatalog();
const SYSTEM = 'You are the TrustCart shopping agent. Current purchase intent (read-only): budget 50 USD, category Camping, quantity 2.';

test('category vocabulary: catalog terms map to exactly one category', () => {
  const vocab = categoryVocabulary(catalog);
  assert.equal(vocab.get('detergent'), 'Household');
  assert.equal(vocab.get('lantern'), 'Camping');
  assert.equal(vocab.get('camp'), 'Camping');
  assert.equal(vocab.has('stainless'), false, 'shared words decide nothing');
  assert.deepEqual([...classifyText('Buy 2 camping lanterns under $50', vocab).keys()], ['Camping']);
});

test('gateSearch: detergent under a Camping intent is INTENT_MISMATCH, not an empty search', () => {
  assert.deepEqual(gateSearch('Camping', 'laundry detergent', undefined, catalog), { ok: false, categories: ['Household'], source: 'query' });
  assert.deepEqual(gateSearch('Camping', 'laundry detergent', 'Buy laundry detergent', catalog), { ok: false, categories: ['Household'], source: 'user' });
  assert.deepEqual(gateSearch('Camping', 'lantern', 'Buy 2 camping lanterns', catalog), { ok: true, query: 'lantern', rewritten: false });
  assert.deepEqual(gateSearch('Camping', '', 'show me camping stuff', catalog), { ok: true, query: '', rewritten: false });
  assert.deepEqual(gateSearch('Household', 'towel', 'Buy 2 towels', catalog), { ok: true, query: 'towel', rewritten: false });
});

test('gateSearch: a stale query that shares no terms with the latest message searches the latest request', () => {
  assert.deepEqual(gateSearch('Camping', 'laundry detergent', 'Buy 2 camping lanterns under $50', catalog), { ok: true, query: 'lantern', rewritten: true });
  // A query that overlaps the latest message is the model's own choice and is kept.
  assert.deepEqual(gateSearch('Camping', 'led lantern', 'Buy 2 camping lanterns', catalog), { ok: true, query: 'led lantern', rewritten: false });
});

const user = (id: string, text: string) => ({ id, role: 'user' as const, parts: [{ type: 'text' as const, text }] });
const blockedReply = (id: string) => ({ id, role: 'assistant' as const, parts: [
  { type: 'tool-searchProducts', toolCallId: 'c1', state: 'output-available', input: { query: 'laundry detergent', requestedCategory: 'Household' }, output: { ok: false, blocked: 'INTENT_MISMATCH' } },
  { type: 'text', text: 'That does not match your Camping intent.' },
] });

test('dropBlockedTurns removes earlier blocked turns and keeps the latest user message', () => {
  const msgs = [user('u0', 'hi'), { id: 'a0', role: 'assistant' as const, parts: [{ type: 'text', text: 'hello' }] }, user('u1', 'Buy laundry detergent'), blockedReply('a1'), user('u2', 'Buy 2 camping lanterns under $50')];
  assert.deepEqual(dropBlockedTurns(msgs).map(m => m.id), ['u0', 'a0', 'u2']);
  assert.equal(latestUserText(msgs), 'Buy 2 camping lanterns under $50');
  // A blocked latest turn is not touched (nothing after it to protect).
  const last = [user('u1', 'Buy laundry detergent')];
  assert.deepEqual(dropBlockedTurns(last).map(m => m.id), ['u1']);
});

// A stub "small model" that always repeats the stale blocked request on its first step.
function staleModel(): LanguageModelV4 {
  const base = createMockModel();
  return {
    ...base,
    async doStream({ prompt }) {
      const lastUser = prompt.map(m => m.role).lastIndexOf('user');
      const first = !prompt.slice(lastUser + 1).some(m => m.role === 'tool');
      const parts: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }];
      if (first) parts.push({ type: 'tool-call', toolCallId: 'stale1', toolName: 'searchProducts', input: JSON.stringify({ query: 'laundry detergent', maxPrice: 50, requestedCategory: 'Camping', requestedQuantity: 2 }) });
      else parts.push({ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'done' }, { type: 'text-end', id: 't' });
      parts.push({ type: 'finish', usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, finishReason: { unified: first ? 'tool-calls' : 'stop', raw: undefined } } as LanguageModelV4StreamPart);
      return { stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) };
    },
  };
}

test('mismatch then a valid request: the search uses the valid terms, not the stale request', async () => {
  const history = [user('u1', 'Buy laundry detergent'), blockedReply('a1'), user('u2', 'Buy 2 camping lanterns under $50')];
  const latest = latestUserText(history);
  const searches: string[] = [];
  const tools = {
    searchProducts: tool({
      inputSchema: searchSchema,
      execute: async ({ query, maxPrice }) => {
        const gate = gateSearch('Camping', query, latest, catalog);
        if (!gate.ok) return { ok: false, blocked: 'INTENT_MISMATCH' };
        searches.push(gate.query);
        return { ok: true, products: matchingProducts(gate.query, maxPrice, catalog.filter(p => p.category === 'Camping')).map(toolProduct) };
      },
    }),
  };
  const modelMessages = await convertToModelMessages(dropBlockedTurns(history) as never);
  assert.equal(JSON.stringify(modelMessages).includes('detergent'), false, 'the blocked turn never reaches the model');
  const result = streamText({ model: staleModel(), system: SYSTEM, messages: modelMessages, tools, stopWhen: isStepCount(3) });
  const steps = await result.steps;
  const output = steps[0].toolResults[0]?.output as { ok: boolean; products: { id: string }[] };
  assert.deepEqual(searches, ['lantern']);
  assert.equal(output.ok, true);
  assert.deepEqual(output.products.map(p => p.id).sort(), ['camp-03', 'camp-06']);
});
