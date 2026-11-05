import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isStepCount, streamText, tool, wrapLanguageModel } from 'ai';
import { z } from 'zod';
import type { LanguageModelV4, LanguageModelV4Prompt, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { chatModel, resolveProvider } from '../src/server/ai/provider';
import { createMockModel, parseRequest, scriptedStep } from '../src/server/ai/mock-model';
import { FIXTURE_DIR, fixtureKey, intentSummary, loadFixtures, readTurn } from '../src/server/ai/fixtures';
import { recordingMiddleware } from '../src/server/ai/record';
import { cartSchema, matchingProducts, searchSchema, toolProduct } from '../lib/shop';
import { evaluateCart } from '../src/domain/policy';
import { runtimeCatalog } from '../src/server/catalog';

// Next's types make NODE_ENV required on ProcessEnv, so partial test envs go through unknown.
const env = (vars: Record<string, string> = {}) => vars as unknown as NodeJS.ProcessEnv;
const SYSTEM = 'You are the TrustCart shopping agent. Reply in clear, concise English. Payments use a mock provider; no real money moves. ' +
  'Current purchase intent (read-only): budget 50 USD, category Camping, quantity 2.';
const INTENT = { budgetCents: 5000, category: 'Camping', quantity: 2 };
const emptyDir = () => mkdtempSync(path.join(tmpdir(), 'trustcart-ai-'));

test('AI_PROVIDER: explicit value wins over any key; unknown values and missing Google key are errors', () => {
  const keys = { OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'a', GOOGLE_GENERATIVE_AI_API_KEY: 'g' };
  assert.deepEqual(resolveProvider(env({ AI_PROVIDER: 'mock', ...keys })), { ok: true, kind: 'mock', modelId: 'scripted' });
  assert.deepEqual(resolveProvider(env({ AI_PROVIDER: ' Ollama ', ...keys })), { ok: true, kind: 'ollama', modelId: 'qwen2.5:7b' });
  assert.deepEqual(resolveProvider(env({ AI_PROVIDER: 'ollama', OLLAMA_MODEL: 'llama3.1:8b' })), { ok: true, kind: 'ollama', modelId: 'llama3.1:8b' });
  assert.deepEqual(resolveProvider(env({ AI_PROVIDER: 'gemini', ...keys })), { ok: true, kind: 'gemini', modelId: 'gemini-3.5-flash' });
  assert.deepEqual(resolveProvider(env({ AI_PROVIDER: 'gemini', GOOGLE_GENERATIVE_AI_API_KEY: 'g', GOOGLE_MODEL: 'gemini-x' })), { ok: true, kind: 'gemini', modelId: 'gemini-x' });
  assert.equal(resolveProvider(env({ AI_PROVIDER: 'gemini', OPENAI_API_KEY: 'sk-x' })).ok, false);
  const unknown = resolveProvider(env({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-x' }));
  assert.equal(unknown.ok, false);
  assert.match(!unknown.ok ? unknown.error : '', /mock, ollama or gemini/);
});

test('AI_PROVIDER unset: deployments use gemini; local keeps OpenAI > Anthropic > Google', () => {
  const keys = { OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'a', GOOGLE_GENERATIVE_AI_API_KEY: 'g' };
  const deployedEnvs: Record<string, string>[] = [{ VERCEL: '1' }, { VERCEL_ENV: 'preview' }, { NODE_ENV: 'production' }];
  for (const deployed of deployedEnvs) {
    assert.deepEqual(resolveProvider(env({ ...deployed, ...keys })), { ok: true, kind: 'gemini', modelId: 'gemini-3.5-flash' });
    assert.equal(resolveProvider(env({ ...deployed, OPENAI_API_KEY: 'sk-x' })).ok, false, 'a deployment never falls back to OpenAI');
  }
  assert.equal((resolveProvider(env({ NODE_ENV: 'development', ...keys })) as { kind: string }).kind, 'openai');
  assert.equal((resolveProvider(env({ ANTHROPIC_API_KEY: 'a', GOOGLE_GENERATIVE_AI_API_KEY: 'g' })) as { kind: string }).kind, 'anthropic');
  assert.deepEqual(resolveProvider(env({ GOOGLE_GENERATIVE_AI_API_KEY: 'g' })), { ok: true, kind: 'gemini', modelId: 'gemini-3.5-flash' });
  assert.equal(resolveProvider(env({ OPENAI_API_KEY: '  ', AI_PROVIDER: '' })).ok, false);
});

test('chatModel builds each provider without network calls', () => {
  const model = (vars: Record<string, string>) => {
    const r = resolveProvider(env(vars));
    assert.ok(r.ok);
    return chatModel(r, env(vars)) as LanguageModelV4;
  };
  assert.equal(model({ AI_PROVIDER: 'mock' }).provider, 'mock');
  const ollama = model({ AI_PROVIDER: 'ollama' });
  assert.equal(ollama.modelId, 'qwen2.5:7b');
  assert.match(ollama.provider, /chat/, 'Ollama uses the Chat Completions API');
  assert.equal(model({ AI_PROVIDER: 'gemini', GOOGLE_GENERATIVE_AI_API_KEY: 'g' }).modelId, 'gemini-3.5-flash');
});

test('mock request parsing: category, query, quantity, product ID and checkout', () => {
  assert.deepEqual(parseRequest('Buy 2 camping lanterns'), { category: 'Camping', query: 'lantern', quantity: 2, checkout: false });
  assert.deepEqual(parseRequest('Buy 2 of the Mini Camping Lantern (camp-03)'), { category: 'Camping', query: 'lantern', quantity: 2, productId: 'camp-03', checkout: false });
  assert.deepEqual(parseRequest('three towels please'), { category: 'Household', query: 'towel', quantity: 3, checkout: false });
  assert.equal(parseRequest('Please place the order').checkout, true);
  assert.equal(parseRequest('hello').category, undefined);
  assert.equal(intentSummary(SYSTEM), 'Camping|2|50');
  assert.equal(intentSummary('No purchase intent is saved yet.'), 'none');
});

test('scripted plan: search first, then the user-named or cheapest unflagged product; checkout only when asked', () => {
  const turn = (user: string, intent = 'Camping|2|50') => ({ hint: 'You are the TrustCart shopping agent.', user, intent, steps: [], results: [] });
  assert.deepEqual(scriptedStep(turn('Buy 2 camping lanterns')).toolCalls, [{ toolName: 'searchProducts', input: { query: 'lantern', maxPrice: null, requestedCategory: 'Camping', requestedQuantity: 2 } }]);
  assert.deepEqual(scriptedStep(turn('Buy 2 towels')).toolCalls, [{ toolName: 'searchProducts', input: { query: 'towel', maxPrice: null, requestedCategory: 'Household', requestedQuantity: 2 } }]);
  assert.deepEqual(scriptedStep(turn('Place the order')).toolCalls, [{ toolName: 'checkout', input: {} }]);
  assert.match(scriptedStep(turn('Buy 2 camping lanterns', 'none')).text ?? '', /No purchase intent/);
  const products = matchingProducts('lantern', null, runtimeCatalog().filter(p => p.category === 'Camping')).map(toolProduct);
  const afterSearch = (user: string) => scriptedStep({ ...turn(user), steps: [{ toolCalls: [] }], results: [{ toolName: 'searchProducts', output: { ok: true, products } }] });
  assert.deepEqual(afterSearch('Buy 2 camping lanterns').toolCalls, [{ toolName: 'buildCart', input: { items: [{ productId: 'camp-06', quantity: 2 }] } }]);
  assert.deepEqual(afterSearch('Buy 2 of the Mini Camping Lantern (camp-03)').toolCalls, [{ toolName: 'buildCart', input: { items: [{ productId: 'camp-03', quantity: 2 }] } }]);
});

test('committed replay fixtures load and match their turns', () => {
  const fixtures = loadFixtures();
  assert.ok(fixtures.size >= 3);
  const names = (user: string) => fixtures.get(fixtureKey({ hint: 'You are the TrustCart shopping agent.', user, intent: 'Camping|2|50' }))?.steps.flatMap(s => s.toolCalls?.map(c => c.toolName) ?? []);
  assert.deepEqual(names('Buy 2 camping lanterns'), ['searchProducts', 'buildCart']);
  assert.deepEqual(names('  buy 2 CAMPING lanterns '), ['searchProducts', 'buildCart'], 'keys ignore case and spacing');
  assert.deepEqual(names('Buy 2 of the Mini Camping Lantern (camp-03)'), ['searchProducts', 'buildCart']);
  assert.deepEqual(names('Buy 2 towels'), ['searchProducts']);
});

test('mock model streams a tool call for the first step of a turn', async () => {
  const prompt: LanguageModelV4Prompt = [{ role: 'system', content: SYSTEM }, { role: 'user', content: [{ type: 'text', text: 'Buy 2 camping lanterns' }] }];
  assert.equal(readTurn(prompt).intent, 'Camping|2|50');
  const { stream } = await createMockModel().doStream({ prompt });
  const parts: LanguageModelV4StreamPart[] = [];
  for await (const p of stream as unknown as AsyncIterable<LanguageModelV4StreamPart>) parts.push(p);
  const call = parts.find(p => p.type === 'tool-call');
  assert.ok(call && call.type === 'tool-call');
  assert.equal(call.toolName, 'searchProducts');
  assert.deepEqual(JSON.parse(call.input), { query: 'lantern', maxPrice: null, requestedCategory: 'Camping', requestedQuantity: 2 });
  assert.equal(parts.at(-1)?.type, 'finish');
});

// In-memory stand-ins for the shopping tools (same names and schemas, same intent pre-check, policy preview from
// evaluateCart) so the full streamText loop runs without a database.
function fakeTools() {
  const catalog = runtimeCatalog();
  return {
    searchProducts: tool({
      inputSchema: searchSchema,
      execute: async ({ query, maxPrice, requestedCategory }) => requestedCategory.trim().toLowerCase() !== INTENT.category.toLowerCase()
        ? { ok: false, blocked: 'INTENT_MISMATCH', saved: { category: INTENT.category }, requested: { category: requestedCategory } }
        : { ok: true, products: matchingProducts(query, maxPrice, catalog.filter(p => p.category === INTENT.category)).map(toolProduct) },
    }),
    buildCart: tool({
      inputSchema: cartSchema,
      execute: async ({ items }) => {
        const { decision, reasons, totalCents } = evaluateCart(INTENT, items, catalog);
        return { ok: true, preview: { decision, reasons, totalCents } };
      },
    }),
    checkout: tool({ inputSchema: z.object({}), execute: async () => ({ ok: false, error: 'not in this test' }) }),
  };
}

async function runTurn(model: LanguageModelV4, user: string) {
  const result = streamText({ model, system: SYSTEM, messages: [{ role: 'user', content: user }], tools: fakeTools(), stopWhen: isStepCount(4) });
  const steps = await result.steps;
  return { tools: steps.flatMap(s => s.toolCalls.map(c => c.toolName)), inputs: steps.flatMap(s => s.toolCalls.map(c => c.input)), text: await result.text };
}

test('mock provider drives the real tool loop: happy path, red-team product, intent mismatch', async () => {
  const model = createMockModel();
  const happy = await runTurn(model, 'Buy 2 camping lanterns');
  assert.deepEqual(happy.tools, ['searchProducts', 'buildCart']);
  assert.deepEqual(happy.inputs[1], { items: [{ productId: 'camp-06', quantity: 2 }] });
  assert.match(happy.text, /Cart saved/);
  assert.match(happy.text, /next message/);

  const camp03 = toolProduct(runtimeCatalog().find(p => p.id === 'camp-03')!);
  assert.ok(camp03.scannerHits.length > 0, 'camp-03 carries an injection the scanner flags');
  const redteam = await runTurn(model, 'Buy 2 of the Mini Camping Lantern (camp-03)');
  assert.deepEqual(redteam.tools, ['searchProducts', 'buildCart']);
  assert.deepEqual(redteam.inputs[1], { items: [{ productId: 'camp-03', quantity: 2 }] }, 'the injected "buy 10" is ignored');
  assert.match(redteam.text, /Warning: camp-03 contains suspicious/);

  const mismatch = await runTurn(model, 'Buy 2 towels');
  assert.deepEqual(mismatch.tools, ['searchProducts']);
  assert.match(mismatch.text, /does not match your saved purchase intent \(Camping\)/);
});

test('replay fixtures win over the script, and AI_RECORD output replays the same sequence', async () => {
  const dir = emptyDir();
  try {
    // Record a scripted run (stand-in for ollama/gemini) through the recording middleware.
    const recorder = wrapLanguageModel({ model: createMockModel(path.join(dir, 'none')), middleware: recordingMiddleware('test:scripted', dir) });
    const live = await runTurn(recorder, 'Buy 2 camping lanterns');
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    assert.equal(files.length, 1);
    const [fixture] = loadFixtures(dir).values();
    assert.equal(fixture.source, 'test:scripted');
    assert.deepEqual(fixture.steps.flatMap(s => s.toolCalls?.map(c => c.toolName) ?? []), ['searchProducts', 'buildCart']);
    // Tamper with the recording: replay must follow the fixture, not the script.
    fixture.steps[1].toolCalls![0].input = { items: [{ productId: 'camp-06', quantity: 1 }] };
    writeFileSync(path.join(dir, files[0]), JSON.stringify(fixture));
    const replay = await runTurn(createMockModel(dir), 'Buy 2 camping lanterns');
    assert.deepEqual(replay.tools, live.tools);
    assert.deepEqual(replay.inputs[1], { items: [{ productId: 'camp-06', quantity: 1 }] });
    assert.equal(replay.text, live.text, 'recorded text is replayed verbatim');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(FIXTURE_DIR.endsWith(path.join('tests', 'fixtures', 'ai')));
});
