import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../lib/db';
import { runtimeCatalog } from '../src/server/catalog';
import { createSession, SESSION_COOKIE } from '../src/server/session';
import { cancelPayment, capturePayment, decideOrder, saveCart, setIntent, submitCart } from '../src/server/orders';
import { assertSandboxHost, PayPalError, type CheckoutOrder } from '../src/server/payments/paypal';
import { checkoutUrls, createMockProvider, type PaymentProvider } from '../src/server/payments/provider';
import { selectProvider } from '../src/server/payments/select';
import type { CartLine } from '../src/domain/policy';
import { PATCH as reviewOrder } from '../app/api/approvals/[id]/route';
import { POST as captureRoute } from '../app/api/checkout/[id]/capture/route';
import { POST as cancelRoute } from '../app/api/checkout/[id]/cancel/route';

// Requires the throwaway DB prepared by scripts/test.ts (npm test), which also blanks PayPal credentials.
before(async () => {
  for (const product of runtimeCatalog()) await db.product.upsert({ where: { id: product.id }, create: product, update: product });
});
after(() => db.$disconnect());

const cookie = (id: string) => `${SESSION_COOKIE}=${id}`;
const post = (route: typeof captureRoute, action: string, id: string, headers: Record<string, string>) =>
  route(new Request(`http://localhost/api/checkout/${id}/${action}`, { method: 'POST', headers }), { params: Promise.resolve({ id }) });

async function sessionWithOrder(cart: CartLine[], intent = { budgetCents: 4000, category: '캠핑', quantity: 2 }) {
  const session = await createSession(db);
  await setIntent(db, session.id, intent);
  await saveCart(db, session.id, cart);
  const submitted = await submitCart(db, session.id);
  assert.ok(submitted.ok);
  return { sessionId: session.id, orderId: submitted.orderId, status: submitted.status };
}

// Wraps a provider, counting calls and recording what was sent. getOrder can be rewritten to simulate a tampered order.
function spy(inner: PaymentProvider, opts: { rewriteGet?: (order: Record<string, unknown>) => unknown; failCapture?: Error } = {}) {
  const calls = { create: 0, get: 0, capture: 0 };
  const created: CheckoutOrder[] = [];
  const provider: PaymentProvider = {
    kind: inner.kind,
    merchantId: inner.merchantId,
    async createOrder(order, urls) { calls.create++; created.push(order); return inner.createOrder(order, urls); },
    async getOrder(id) {
      calls.get++;
      const order = await inner.getOrder(id) as Record<string, unknown>;
      return opts.rewriteGet ? opts.rewriteGet(order) : order;
    },
    async captureOrder(id) {
      calls.capture++;
      const result = await inner.captureOrder(id);
      if (opts.failCapture) throw opts.failCapture;
      return result;
    },
  };
  return { provider, calls, created };
}

async function awaitingPayment(provider: PaymentProvider, cart: CartLine[] = [{ productId: 'camp-06', quantity: 2 }]) {
  const order = await sessionWithOrder(cart);
  const decided = await decideOrder(db, provider, order.sessionId, order.orderId, 'APPROVED');
  assert.equal(decided.body.status, 'AWAITING_PAYMENT');
  return order;
}
const row = (id: string) => db.order.findUniqueOrThrow({ where: { id } });
const audits = (sessionId: string, action: string) => db.auditLog.findMany({ where: { sessionId, action } });

test('provider selection: mock without credentials, sandbox-only PayPal with them', () => {
  const creds = { PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_SANDBOX_MERCHANT_ID: 'MERCHANT1' };
  assert.equal(selectProvider({}).kind, 'mock');
  assert.equal(selectProvider({ PAYPAL_CLIENT_ID: ' ', PAYPAL_CLIENT_SECRET: '' }).kind, 'mock');
  assert.equal(selectProvider(creds).kind, 'paypal-sandbox');
  // Only one credential set: a config error, not a silent mock.
  assert.throws(() => selectProvider({ PAYPAL_CLIENT_ID: 'id' }), /PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET/);
  assert.throws(() => selectProvider({ PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_SANDBOX_MERCHANT_ID: 'MERCHANT1' }), /PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET/);
  // Credentials present but PayPal misconfigured: fail closed, never fall back to the mock or go live.
  assert.throws(() => selectProvider({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret' }));
  assert.throws(() => selectProvider({ ...creds, PAYPAL_API_BASE: 'https://api-m.paypal.com' }));
  assert.throws(() => selectProvider({ ...creds, PAYPAL_ENV: 'live' }));
  assert.throws(() => assertSandboxHost('https://api-m.paypal.com/v2/checkout/orders'));
  assert.throws(() => assertSandboxHost('http://api-m.sandbox.paypal.com/v2/checkout/orders'));
  assert.doesNotThrow(() => assertSandboxHost('https://api-m.sandbox.paypal.com/v2/checkout/orders'));
});

test('approve creates the provider order with the server catalog price and localhost checkout URLs', async () => {
  const { provider, calls, created } = spy(createMockProvider());
  const { orderId } = await awaitingPayment(provider, [{ productId: 'camp-06', quantity: 2 }]);
  const price = runtimeCatalog().find(p => p.id === 'camp-06')!.priceCents;
  assert.equal(calls.create, 1);
  assert.equal(calls.capture, 0);
  assert.equal(created[0].totalCents, price * 2);
  assert.equal(created[0].currency, 'USD');
  assert.equal(created[0].referenceId, orderId);
  assert.deepEqual(checkoutUrls(orderId), {
    returnUrl: `http://localhost:3000/checkout/return?orderId=${orderId}`,
    cancelUrl: `http://localhost:3000/checkout/cancel?orderId=${orderId}`,
  });
  assert.equal((await row(orderId)).status, 'AWAITING_PAYMENT');
});

test('capture route: PAID with captureId and audit in one step, idempotent, session-owned', async () => {
  const order = await sessionWithOrder([{ productId: 'camp-06', quantity: 2 }]);
  const approve = await reviewOrder(new Request(`http://localhost/api/approvals/${order.orderId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie: cookie(order.sessionId) }, body: JSON.stringify({ status: 'APPROVED' }),
  }), { params: Promise.resolve({ id: order.orderId }) });
  assert.equal(approve.status, 200);

  const other = await createSession(db);
  assert.equal((await post(captureRoute, 'capture', order.orderId, {})).status, 401);
  assert.equal((await post(captureRoute, 'capture', order.orderId, { cookie: cookie(other.id) })).status, 404);
  assert.equal((await post(cancelRoute, 'cancel', order.orderId, { cookie: cookie(other.id) })).status, 404);
  assert.equal((await post(captureRoute, 'capture', order.orderId, { cookie: cookie(order.sessionId), origin: 'https://evil.example' })).status, 403);
  assert.equal((await row(order.orderId)).status, 'AWAITING_PAYMENT');

  const first = await post(captureRoute, 'capture', order.orderId, { cookie: cookie(order.sessionId) });
  assert.equal(first.status, 200);
  const body = await first.json() as { status: string; captureId: string };
  assert.equal(body.status, 'PAID');
  assert.match(body.captureId, /^MOCK-/);
  const paid = await row(order.orderId);
  assert.equal(paid.status, 'PAID');
  assert.equal(paid.captureId, body.captureId);

  const again = await post(captureRoute, 'capture', order.orderId, { cookie: cookie(order.sessionId) });
  assert.deepEqual(await again.json(), { status: 'PAID', provider: 'mock', captureId: body.captureId });
  assert.equal((await audits(order.sessionId, 'capture')).filter(a => a.outcome === 'PAID').length, 1);
  // A paid order cannot be cancelled.
  assert.equal((await post(cancelRoute, 'cancel', order.orderId, { cookie: cookie(order.sessionId) })).status, 409);
});

test('concurrent captures call the provider capture once', async () => {
  const { provider, calls } = spy(createMockProvider());
  const { sessionId, orderId } = await awaitingPayment(provider);
  const results = await Promise.all([1, 2, 3].map(() => capturePayment(db, provider, sessionId, orderId)));
  assert.equal(calls.capture, 1);
  assert.ok(results.some(r => r.status === 200 && r.body.status === 'PAID'));
  assert.equal((await row(orderId)).status, 'PAID');
});

test('capture refuses an order that is not APPROVED or does not match amount, currency or payee', async () => {
  const cases: [string, Parameters<typeof spy>[1] & { approve?: boolean }][] = [
    ['ORDER_NOT_APPROVED', { approve: false }],
    ['AMOUNT_MISMATCH', { rewriteGet: o => withUnit(o, { amount: { currency_code: 'USD', value: '0.01' } }) }],
    ['CURRENCY_MISMATCH', { rewriteGet: o => withUnit(o, { amount: { currency_code: 'EUR', value: '1.00' } }) }],
    ['PAYEE_MISMATCH', { rewriteGet: o => withUnit(o, { payee: { merchant_id: 'ATTACKER' } }) }],
    ['ORDER_ID_MISMATCH', { rewriteGet: o => ({ ...o, id: 'MOCK-other' }) }],
  ];
  for (const [reason, { approve, ...opts }] of cases) {
    const { provider, calls } = spy(createMockProvider({ approve }), opts);
    const { sessionId, orderId } = await awaitingPayment(provider);
    const result = await capturePayment(db, provider, sessionId, orderId);
    assert.deepEqual(result.body, { status: 'FAILED', provider: 'mock', reason }, reason);
    assert.equal(calls.capture, 0, reason);
    const failed = await row(orderId);
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.failureReason, reason);
    assert.equal(failed.captureId, null);
  }
});

function withUnit(order: Record<string, unknown>, patch: Record<string, unknown>) {
  const [unit] = order.purchase_units as Record<string, unknown>[];
  return { ...order, purchase_units: [{ ...unit, ...patch }] };
}

test('a capture that is not COMPLETED is FAILED, not PAID', async () => {
  const { provider } = spy(createMockProvider({ captureStatus: 'PENDING' }));
  const { sessionId, orderId } = await awaitingPayment(provider);
  assert.equal((await capturePayment(db, provider, sessionId, orderId)).body.status, 'FAILED');
  assert.equal((await row(orderId)).failureReason, 'CAPTURE_NOT_COMPLETED');
});

test('unknown capture outcome: retryable, not cancellable, never captured twice', async () => {
  const mock = createMockProvider();
  const lost = spy(mock, { failCapture: new PayPalError(0, 'NETWORK_ERROR', true) });
  const { sessionId, orderId } = await awaitingPayment(lost.provider);
  assert.equal((await capturePayment(db, lost.provider, sessionId, orderId)).status, 503);
  assert.equal((await row(orderId)).status, 'AWAITING_PAYMENT');
  assert.equal((await cancelPayment(db, sessionId, orderId)).status, 409);

  // The capture did go through at the provider; the retry finds it COMPLETED and records it without a second capture.
  const retry = spy(mock);
  const result = await capturePayment(db, retry.provider, sessionId, orderId);
  assert.equal(result.body.status, 'PAID');
  assert.equal(retry.calls.capture, 0);
  assert.equal((await row(orderId)).failureReason, null);
});

test('an order stuck in CAPTURING after a crash is recovered on retry, never captured twice', async () => {
  // Simulates a crash between the provider call and our write: the row stays CAPTURING, last touched a while ago.
  const stuck = async (orderId: string, ageMs = 60_000) =>
    db.order.update({ where: { id: orderId }, data: { status: 'CAPTURING', updatedAt: new Date(Date.now() - ageMs) } });

  // PayPal already captured it: the retry records PAID from the GET without a second capture.
  const mock = createMockProvider();
  const done = spy(mock);
  const a = await awaitingPayment(done.provider);
  const providerOrderId = (await row(a.orderId)).providerOrderId!;
  const captureId = ((await mock.captureOrder(providerOrderId)) as { purchase_units: { payments: { captures: { id: string }[] } }[] }).purchase_units[0].payments.captures[0].id;
  await stuck(a.orderId);
  const recovered = await capturePayment(db, done.provider, a.sessionId, a.orderId);
  assert.deepEqual(recovered.body, { status: 'PAID', provider: 'mock', captureId });
  assert.equal(done.calls.capture, 0);
  const paid = await row(a.orderId);
  assert.equal(paid.status, 'PAID');
  assert.equal(paid.captureId, captureId);
  const paidAudits = (await audits(a.sessionId, 'capture')).filter(x => x.outcome === 'PAID');
  assert.equal(paidAudits.length, 1);
  assert.equal(JSON.parse(paidAudits[0].detail).recovered, true);

  // Crash before the capture reached PayPal: the order is still APPROVED, so the retry captures it once.
  const approved = spy(createMockProvider());
  const b = await awaitingPayment(approved.provider);
  await stuck(b.orderId);
  const results = await Promise.all([1, 2].map(() => capturePayment(db, approved.provider, b.sessionId, b.orderId)));
  assert.ok(results.some(r => r.body.status === 'PAID'));
  assert.equal(approved.calls.capture, 1);
  assert.equal((await row(b.orderId)).status, 'PAID');

  // A fresh CAPTURING row is a capture still in flight: no provider call, no state change.
  const inFlight = spy(createMockProvider());
  const c = await awaitingPayment(inFlight.provider);
  const before = { ...inFlight.calls };
  await stuck(c.orderId, 0);
  assert.equal((await capturePayment(db, inFlight.provider, c.sessionId, c.orderId)).status, 409);
  assert.deepEqual(inFlight.calls, before);
  assert.equal((await row(c.orderId)).status, 'CAPTURING');

  // Recovery still checks the provider order: a tampered amount is FAILED, not PAID.
  const tampered = spy(createMockProvider(), { rewriteGet: o => withUnit(o, { amount: { currency_code: 'USD', value: '0.01' } }) });
  const d = await awaitingPayment(tampered.provider);
  await stuck(d.orderId);
  assert.deepEqual((await capturePayment(db, tampered.provider, d.sessionId, d.orderId)).body, { status: 'FAILED', provider: 'mock', reason: 'AMOUNT_MISMATCH' });
  assert.equal(tampered.calls.capture, 0);
});

test('cancel marks CANCELLED without any provider call, then capture is refused', async () => {
  const { provider, calls } = spy(createMockProvider());
  const { sessionId, orderId } = await awaitingPayment(provider);
  const before = { ...calls };
  const res = await post(cancelRoute, 'cancel', orderId, { cookie: cookie(sessionId) });
  assert.deepEqual(await res.json(), { status: 'CANCELLED' });
  assert.deepEqual(await (await post(cancelRoute, 'cancel', orderId, { cookie: cookie(sessionId) })).json(), { status: 'CANCELLED' });
  assert.equal((await capturePayment(db, provider, sessionId, orderId)).status, 409);
  assert.deepEqual(calls, before);
  assert.equal((await row(orderId)).status, 'CANCELLED');
  assert.equal((await audits(sessionId, 'cancelPayment')).length, 1);
});

test('rejected and denied orders never reach create or capture', async () => {
  const { provider, calls } = spy(createMockProvider());
  const rejected = await sessionWithOrder([{ productId: 'camp-03', quantity: 10 }]);
  assert.equal(rejected.status, 'NEEDS_APPROVAL');
  assert.equal((await decideOrder(db, provider, rejected.sessionId, rejected.orderId, 'REJECTED')).status, 200);
  assert.equal((await capturePayment(db, provider, rejected.sessionId, rejected.orderId)).status, 409);
  assert.equal((await cancelPayment(db, rejected.sessionId, rejected.orderId)).status, 409);

  const denied = await sessionWithOrder([{ productId: 'home-09', quantity: 1 }]);
  assert.equal(denied.status, 'DENIED');
  assert.equal((await decideOrder(db, provider, denied.sessionId, denied.orderId, 'APPROVED')).status, 409);
  assert.equal((await capturePayment(db, provider, denied.sessionId, denied.orderId)).status, 409);
  assert.deepEqual(calls, { create: 0, get: 0, capture: 0 });
  assert.equal((await row(denied.orderId)).status, 'DENIED');
});
