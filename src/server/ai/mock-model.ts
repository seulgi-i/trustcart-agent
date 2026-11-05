import { randomUUID } from 'node:crypto';
import type { LanguageModelV4, LanguageModelV4Content, LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';
import { findFixture, FIXTURE_DIR, readTurn, type FixtureStep, type TurnState } from './fixtures';

// AI_PROVIDER=mock: a deterministic LanguageModelV4 that goes through the same streamText loop, real shopping tools
// and UI message stream as a live model. Each call answers one step of the current turn: a matching replay fixture
// (tests/fixtures/ai) wins; otherwise a small script plans searchProducts -> buildCart -> summary, or checkout when
// the user asks to order (the server's same-turn rule still applies). No network, no API key.

// Most specific first: the first keyword found in the user's message picks the category and the search query.
const KEYWORDS: [category: string, keyword: string][] = [
  ...['sleeping bag', 'lantern', 'tent', 'chair', 'table', 'cookset', 'burner', 'cooler', 'mat'].map(k => ['Camping', k] as [string, string]),
  ...['towel', 'dish soap', 'soap', 'toothbrush', 'tumbler', 'container', 'hanger', 'basket', 'storage', 'cloth', 'detergent', 'utensil'].map(k => ['Household', k] as [string, string]),
  ['Camping', 'camp'], ['Household', 'household'],
];
const CATEGORY_WORDS = new Set(['camp', 'household']);
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const PRODUCT_ID = /\b(?:camp|home)-\d{2}\b/gi;

export type ShoppingRequest = { category?: string; query: string; quantity?: number; productId?: string; checkout: boolean };

export function parseRequest(text: string): ShoppingRequest {
  const lower = text.toLowerCase();
  const productId = lower.match(PRODUCT_ID)?.[0];
  const hit = KEYWORDS.find(([, k]) => new RegExp(`\\b${k}`).test(lower));
  const withoutIds = lower.replace(PRODUCT_ID, ' ');
  const digits = /(?:^|[^\w.-])(-?\d{1,4})(?![\w.])/.exec(withoutIds)?.[1];
  const word = Object.keys(NUMBER_WORDS).find(w => new RegExp(`\\b${w}\\b`).test(withoutIds));
  const quantity = digits !== undefined ? Number(digits) : word ? NUMBER_WORDS[word] : undefined;
  const checkout = /\b(check ?out|place (?:the |my |an )?order|submit (?:the |my )?order|order (?:it|them|now)|go ahead and order)\b/.test(lower);
  return {
    ...(hit ? { category: hit[0] } : {}),
    query: hit && !CATEGORY_WORDS.has(hit[1]) ? hit[1] : '',
    ...(quantity !== undefined ? { quantity } : {}),
    ...(productId ? { productId } : {}),
    checkout,
  };
}

type Intent = { category: string; quantity: number; budget: number };
const parseIntent = (summary: string): Intent | null => {
  const [category, quantity, budget] = summary.split('|');
  return summary === 'none' || !category ? null : { category, quantity: Number(quantity), budget: Number(budget) };
};

type ToolProduct = { id: string; priceUSD: number; scannerHits: string[] };
type ToolOutput = {
  ok?: boolean; error?: string; blocked?: string; products?: ToolProduct[];
  saved?: { category: string }; requested?: { category: string };
  preview?: { decision: string; totalCents: number; reasons?: string[] };
  orderId?: string; status?: string; decision?: string;
};
const asOutput = (o: unknown): ToolOutput => (o && typeof o === 'object' ? o as ToolOutput : {});

// The scripted planner: pure, so tests can check the planned tool sequence without a database.
export function scriptedStep(turn: TurnState): FixtureStep {
  const intent = parseIntent(turn.intent);
  const req = parseRequest(turn.user);
  const called = turn.results.map(r => r.toolName);
  if (turn.steps.length === 0) {
    if (!intent) return { text: 'No purchase intent is saved yet. Please save the Purchase intent form (category, budget, quantity) on the page first.' };
    if (req.checkout) return { toolCalls: [{ toolName: 'checkout', input: {} }] };
    if (!req.category && !req.productId) return { text: `Tell me what to buy, for example "buy ${intent.quantity} ${intent.category === 'Household' ? 'towels' : 'camping lanterns'}". I search only within your saved purchase intent (${intent.category}).` };
    return { toolCalls: [{ toolName: 'searchProducts', input: { query: req.query, maxPrice: null, requestedCategory: req.category ?? intent.category, requestedQuantity: req.quantity ?? null } }] };
  }
  const search = turn.results.findLast(r => r.toolName === 'searchProducts');
  const products = asOutput(search?.output).products ?? [];
  if (intent && search && !called.includes('buildCart') && !called.includes('checkout') && products.length) {
    // The user's explicit product wins; otherwise the cheapest product without scanner hits. Seller text never
    // changes the pick or the quantity.
    const pick = products.find(p => p.id === req.productId) ?? products.find(p => p.scannerHits.length === 0) ?? products[0];
    return { toolCalls: [{ toolName: 'buildCart', input: { items: [{ productId: pick.id, quantity: req.quantity ?? intent.quantity }] } }] };
  }
  return { text: summarize(turn) };
}

export function summarize(turn: TurnState) {
  const lines: string[] = [];
  for (const { toolName, output } of turn.results) {
    const o = asOutput(output);
    if (o.blocked === 'INTENT_MISMATCH') {
      lines.push(`This request (${o.requested?.category}) does not match your saved purchase intent (${o.saved?.category}). Please update the Purchase intent form (category, budget, quantity) first, then ask again.`);
    } else if (o.ok === false) {
      lines.push(`The server refused ${toolName}: ${o.error ?? 'request not allowed'}`);
    } else if (toolName === 'searchProducts') {
      const flagged = (o.products ?? []).filter(p => p.scannerHits.length);
      lines.push(o.products?.length ? `Found ${o.products.length} matching product(s).` : 'No matching products were found in your intent category.');
      for (const p of flagged) lines.push(`Warning: ${p.id} contains suspicious seller-written instructions (${p.scannerHits.join(', ')}). I ignored them.`);
    } else if (toolName === 'buildCart' && o.preview) {
      lines.push(`Cart saved. Server preview: ${o.preview.decision}, total $${(o.preview.totalCents / 100).toFixed(2)}.${o.preview.reasons?.length ? ` Reasons: ${o.preview.reasons.join('; ')}.` : ''}`);
      lines.push('To place the order, ask me in your next message (for example "place the order").');
    } else if (toolName === 'checkout') {
      lines.push(`Order ${o.orderId} was submitted with status ${o.status}. Review it in the review inbox; nothing is paid until you approve it there.`);
    }
  }
  return lines.join('\n') || 'Done.';
}

export function mockStep(turn: TurnState, fixtureDir = FIXTURE_DIR): FixtureStep {
  const fixture = findFixture(turn, fixtureDir);
  return fixture && turn.steps.length < fixture.steps.length ? fixture.steps[turn.steps.length] : scriptedStep(turn);
}

const USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};
const finishReason = (step: FixtureStep) => step.toolCalls?.length ? { unified: 'tool-calls' as const, raw: 'tool-calls' } : { unified: 'stop' as const, raw: 'stop' };
const toolCalls = (step: FixtureStep) => (step.toolCalls ?? []).map(c => ({ type: 'tool-call' as const, toolCallId: `mock_${randomUUID()}`, toolName: c.toolName, input: JSON.stringify(c.input ?? {}) }));

export function createMockModel(fixtureDir = FIXTURE_DIR): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'scripted',
    supportedUrls: {},
    async doGenerate({ prompt }) {
      const step = mockStep(readTurn(prompt), fixtureDir);
      const content: LanguageModelV4Content[] = [...(step.text ? [{ type: 'text' as const, text: step.text }] : []), ...toolCalls(step)];
      return { content, finishReason: finishReason(step), usage: USAGE, warnings: [] };
    },
    async doStream({ prompt }) {
      const step = mockStep(readTurn(prompt), fixtureDir);
      const parts: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }, { type: 'response-metadata', id: `mock_${randomUUID()}`, modelId: 'scripted', timestamp: new Date() }];
      if (step.text) parts.push({ type: 'text-start', id: 't0' }, { type: 'text-delta', id: 't0', delta: step.text }, { type: 'text-end', id: 't0' });
      parts.push(...toolCalls(step), { type: 'finish', usage: USAGE, finishReason: finishReason(step) });
      return { stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) };
    },
  };
}
