import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../lib/db';
import { createShoppingTools } from '../lib/agent';
import { runtimeCatalog } from '../src/server/catalog';
import { createSession, readSessionId, SESSION_COOKIE, sessionCookie } from '../src/server/session';
import { decideOrder, saveCart, setIntent, submitCart } from '../src/server/orders';
import { checkoutUrls, type PaymentProvider } from '../src/server/payments/provider';
import type { CartLine } from '../src/domain/policy';
import { GET as inbox } from '../app/api/approvals/route';
import { PATCH as reviewOrder } from '../app/api/approvals/[id]/route';
import { POST as postIntent } from '../app/api/intent/route';
import { POST as chat } from '../app/api/chat/route';

// Requires the throwaway DB prepared by scripts/test.ts (npm test).
before(async () => {
  for (const product of runtimeCatalog()) await db.product.upsert({ where: { id: product.id }, create: product, update: product });
});
after(() => db.$disconnect());

const cookie = (id: string) => `${SESSION_COOKIE}=${id}`;
const patch = (id: string, sessionId: string, status: string) => reviewOrder(new Request(`http://localhost/api/approvals/${id}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json', cookie: cookie(sessionId) }, body: JSON.stringify({ status }),
}), { params: Promise.resolve({ id }) });
// A provider that fails the test if anything tries to create or capture a payment.
const noPayments: PaymentProvider = { kind: 'mock', merchantId: 'X', createOrder: () => assert.fail('createOrder called'), getOrder: () => assert.fail('getOrder called'), captureOrder: () => assert.fail('captureOrder called') };

async function sessionWithOrder(cart: CartLine[]) {
  const session = await createSession(db);
  await setIntent(db, session.id, { budgetCents: 4000, category: '캠핑', quantity: 2 });
  await saveCart(db, session.id, cart);
  const submitted = await submitCart(db, session.id);
  assert.ok(submitted.ok);
  return { sessionId: session.id, orderId: submitted.orderId, status: submitted.status };
}
type ToolLike = { execute?: (input: never, options: never) => unknown };
const run = async (t: ToolLike, input: unknown) => await (t.execute!(input as never, { toolCallId: 't', messages: [] } as never)) as { ok: boolean; error?: string; status?: string };

test('session cookie is server-issued, HttpOnly and strictly parsed', () => {
  const header = sessionCookie('a'.repeat(43), true);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Secure/);
  assert.equal(readSessionId(`x=1; ${SESSION_COOKIE}=${'a'.repeat(43)}`), 'a'.repeat(43));
  assert.equal(readSessionId(`${SESSION_COOKIE}=short`), null);
  assert.equal(readSessionId(null), null);
});

test('intent is set by the user route, validated against the hard cap', async () => {
  const session = await createSession(db);
  const send = (body: unknown, headers: Record<string, string> = { cookie: cookie(session.id) }) =>
    postIntent(new Request('http://localhost/api/intent', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
  assert.equal((await send({ budgetUSD: 40, category: '캠핑', quantity: 2 }, {})).status, 401);
  assert.equal((await send({ budgetUSD: 40, category: '캠핑', quantity: 2 }, { cookie: cookie(session.id), origin: 'https://evil.example' })).status, 403);
  assert.equal((await send({ budgetUSD: 9999, category: '캠핑', quantity: 2 })).status, 400);
  assert.equal((await send({ budgetUSD: 40, category: '캠핑', quantity: -1 })).status, 400);
  assert.equal((await send({ budgetUSD: 40, category: 'weapons', quantity: 2 })).status, 400);
  assert.equal((await send({ budgetUSD: 40, category: '캠핑', quantity: 2 })).status, 201);
  assert.deepEqual(await db.intent.findFirst({ where: { sessionId: session.id }, select: { budgetCents: true, category: true, quantity: true } }), { budgetCents: 4000, category: '캠핑', quantity: 2 });
});

test('same turn: reading untrusted content blocks checkout, a new turn may check out', async () => {
  const session = await createSession(db);
  await setIntent(db, session.id, { budgetCents: 4000, category: '캠핑', quantity: 2 });

  const turn1 = createShoppingTools(session.id);
  assert.equal((await run(turn1.searchProducts, { query: '랜턴', maxPrice: null })).ok, true);
  assert.equal((await run(turn1.buildCart, { items: [{ productId: 'camp-06', quantity: 2 }] })).ok, true);
  const blocked = await run(turn1.checkout, {});
  assert.equal(blocked.ok, false);
  assert.match(blocked.error!, /untrusted/);
  assert.equal(await db.order.count({ where: { sessionId: session.id } }), 0);

  // Checkout first, then a search in the same turn: the search is refused instead.
  const turn2 = createShoppingTools(session.id);
  const submitted = await run(turn2.checkout, {});
  assert.equal(submitted.ok, true);
  assert.equal(submitted.status, 'READY');
  assert.equal((await run(turn2.searchProducts, { query: '', maxPrice: null })).ok, false);
});

test('D-DEMO: injected cart -> NEEDS_APPROVAL -> badge -> reject -> no capture', async () => {
  const { sessionId, orderId, status } = await sessionWithOrder([{ productId: 'camp-03', quantity: 10 }]);
  assert.equal(status, 'NEEDS_APPROVAL');

  const listed = await (await inbox(new Request('http://localhost/api/approvals', { headers: { cookie: cookie(sessionId) } }))).json() as { needsReview: number; orders: { id: string; evaluation: { reasons: { rule: string }[]; scan: unknown[] } }[] };
  assert.equal(listed.needsReview, 1);
  assert.deepEqual(listed.orders[0].evaluation.reasons.map(r => r.rule), ['intent-budget', 'intent-quantity', 'injection-scanner']);
  assert.equal(listed.orders[0].evaluation.scan.length, 1);

  // Another visitor cannot see or decide it.
  const other = await createSession(db);
  assert.equal((await patch(orderId, other.id, 'REJECTED')).status, 404);

  assert.equal((await decideOrder(db, noPayments, sessionId, orderId, 'REJECTED')).status, 200);
  const row = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.equal(row.status, 'REJECTED');
  assert.equal(row.providerOrderId, null);
  assert.equal(row.captureId, null);
  assert.equal((await patch(orderId, sessionId, 'APPROVED')).status, 409);
});

test('approve only creates the mock payment; nothing is captured before the buyer returns', async () => {
  const paid = await sessionWithOrder([{ productId: 'camp-03', quantity: 2 }]);
  assert.equal(paid.status, 'NEEDS_APPROVAL');
  const res = await patch(paid.orderId, paid.sessionId, 'APPROVED');
  assert.equal(res.status, 200);
  const body = await res.json() as { status: string; provider: string; approvalUrl: string };
  assert.deepEqual(body, { status: 'AWAITING_PAYMENT', provider: 'mock', approvalUrl: checkoutUrls(paid.orderId).returnUrl });
  const row = await db.order.findUniqueOrThrow({ where: { id: paid.orderId } });
  assert.equal(row.status, 'AWAITING_PAYMENT');
  assert.equal(row.provider, 'mock');
  assert.match(row.providerOrderId!, /^MOCK-/);
  assert.equal(row.captureId, null);
  assert.equal((await patch(paid.orderId, paid.sessionId, 'APPROVED')).status, 409);
});

test('DENY cannot be approved', async () => {
  const { sessionId, orderId, status } = await sessionWithOrder([{ productId: 'home-09', quantity: 1 }]);
  assert.equal(status, 'DENIED');
  assert.equal((await patch(orderId, sessionId, 'APPROVED')).status, 409);
  assert.equal((await decideOrder(db, noPayments, sessionId, orderId, 'APPROVED')).status, 409);
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status, 'DENIED');
});

test('expired sessions are rejected', async () => {
  const expired = await createSession(db, new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));
  assert.equal((await inbox(new Request('http://localhost/api/approvals', { headers: { cookie: cookie(expired.id) } }))).status, 401);
});

test('chat requires a same-origin request with a valid session', async () => {
  const send = (headers: Record<string, string>) => chat(new Request('http://localhost/api/chat', { method: 'POST', headers, body: '{}' }));
  const session = await createSession(db);
  assert.equal((await send({ origin: 'https://evil.example', cookie: cookie(session.id) })).status, 403);
  assert.equal((await send({})).status, 401);
  assert.equal((await send({ cookie: cookie('a'.repeat(43)) })).status, 401);
  // A valid session gets past the gate to input validation.
  assert.equal((await send({ cookie: cookie(session.id) })).status, 400);
});
