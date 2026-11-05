import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayPalClient, interpretRefund, loadPayPalConfig, PAYPAL_SANDBOX_API, PayPalError, paypalRequestId } from '../src/server/payments/paypal';
import { createMockProvider } from '../src/server/payments/provider';

const config = loadPayPalConfig({ PAYPAL_CLIENT_ID: 'test-client', PAYPAL_CLIENT_SECRET: 'test-secret', PAYPAL_SANDBOX_MERCHANT_ID: 'SANDBOXMERCHANT1' });
type Call = { url: string; init: RequestInit };
function fakeFetch(responses: (() => Response)[]) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'token', expires_in: 3600 });
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected call');
    return next();
  };
  return { calls, fetchImpl };
}
const header = (call: Call, name: string) => (call.init.headers as Record<string, string>)[name];
const refunded = (value = '1.00', status = 'COMPLETED') => () => Response.json({ id: 'REFUND1', status, amount: { currency_code: 'USD', value } });

test('refund: POST /v2/payments/captures/{id}/refund on the sandbox with a derived PayPal-Request-Id', async () => {
  const { calls, fetchImpl } = fakeFetch([refunded('1.00'), refunded('55.97')]);
  const client = createPayPalClient(config, fetchImpl);
  await client.refundCapture('CAPTURE1', 100, 'refund:order-1:hidden_fee');
  await client.refundCapture('CAPTURE1', null, 'refund:order-1:price_change');
  assert.equal(calls[0].url, `${PAYPAL_SANDBOX_API}/v2/payments/captures/CAPTURE1/refund`);
  assert.equal(calls[0].init.method, 'POST');
  // Partial: the amount in USD. Full: no amount, PayPal refunds what is left.
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { amount: { currency_code: 'USD', value: '1.00' } });
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), {});
  assert.equal(header(calls[0], 'PayPal-Request-Id'), paypalRequestId('refund', 'refund:order-1:hidden_fee'));
  assert.notEqual(header(calls[0], 'PayPal-Request-Id'), header(calls[1], 'PayPal-Request-Id'));
  assert.notEqual(paypalRequestId('refund', 'X'), paypalRequestId('capture', 'X'));
  // A capture ID that is not a PayPal ID never reaches the network.
  assert.throws(() => client.refundCapture('../../v1/evil', 100, 'k'), /capture ID/);
});

test('refund retries reuse the same PayPal-Request-Id; a lost answer is outcome-unknown', async () => {
  const networkError = () => { throw new TypeError('fetch failed'); };
  const { calls, fetchImpl } = fakeFetch([networkError, () => new Response(null, { status: 503 }), refunded()]);
  await createPayPalClient(config, fetchImpl).refundCapture('CAPTURE1', 100, 'key-1');
  assert.equal(calls.length, 3);
  assert.ok(calls.every(c => header(c, 'PayPal-Request-Id') === paypalRequestId('refund', 'key-1')));
  const failing = fakeFetch([networkError, networkError, networkError]);
  await assert.rejects(createPayPalClient(config, failing.fetchImpl).refundCapture('CAPTURE1', 100, 'key-1'), (e: unknown) => e instanceof PayPalError && e.outcomeUnknown);
});

test('interpretRefund: COMPLETED and PENDING are refunds, anything else is not', () => {
  assert.deepEqual(interpretRefund({ id: 'R1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '18.99' } }), { ok: true, refundId: 'R1', status: 'COMPLETED', amountCents: 1899 });
  assert.deepEqual(interpretRefund({ id: 'R1', status: 'PENDING' }), { ok: true, refundId: 'R1', status: 'PENDING', amountCents: null });
  assert.deepEqual(interpretRefund({ id: 'R1', status: 'FAILED' }), { ok: false, reason: 'REFUND_NOT_COMPLETED', status: 'FAILED' });
  assert.deepEqual(interpretRefund({ status: 'COMPLETED' }), { ok: false, reason: 'UNRECOGNIZED_RESPONSE' });
});

test('mock refund: labeled, idempotent per key, never more than the capture', async () => {
  const mock = createMockProvider();
  const order = { referenceId: 'ref-1', currency: 'USD' as const, unitCents: 1000, quantity: 1, name: 'x', totalCents: 1000 };
  const created = await mock.createOrder(order, { returnUrl: 'http://localhost:3000/r', cancelUrl: 'http://localhost:3000/c' }) as { id: string };
  const captureId = (await mock.captureOrder(created.id) as { purchase_units: { payments: { captures: { id: string }[] } }[] }).purchase_units[0].payments.captures[0].id;
  const first = await mock.refundCapture(captureId, 300, 'a') as { id: string; mock: boolean };
  assert.match(first.id, /^MOCK-/);
  assert.equal(first.mock, true);
  assert.deepEqual(await mock.refundCapture(captureId, 300, 'a'), first);
  await assert.rejects(mock.refundCapture(captureId, 701, 'b'), (e: unknown) => e instanceof PayPalError && !e.outcomeUnknown);
  assert.deepEqual(interpretRefund(await mock.refundCapture(captureId, null, 'c')), { ok: true, refundId: (await mock.refundCapture(captureId, null, 'c') as { id: string }).id, status: 'COMPLETED', amountCents: 700 });
  await assert.rejects(mock.refundCapture(captureId, null, 'd'));
});
