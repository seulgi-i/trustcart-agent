// Local-only PayPal sandbox refund smoke test: refunds $1.00 of the capture made by `npm run paypal:smoke -- capture`.
// Not an HTTP endpoint and never deployed. Prints only the capture ID, refund ID, refund status and amount.
//   npm run paypal:refund-smoke
// The PayPal-Request-Id is derived from the capture ID, so a rerun (e.g. after a timeout) returns the same refund
// instead of refunding again.
import { existsSync, readFileSync } from 'node:fs';
import { formatUsd } from '@/src/domain/money';
import { createPayPalClient, interpretRefund, loadPayPalConfig, PayPalError } from '@/src/server/payments/paypal';

const STATE_FILE = '.paypal-smoke.json';
const REFUND_CENTS = 100;

type Captured = { status?: string; purchase_units?: { payments?: { captures?: { id?: string; status?: string }[] } }[] };

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('The smoke script is for local development only.');
  if (!existsSync(STATE_FILE)) throw new Error(`${STATE_FILE} not found. Run "npm run paypal:smoke -- create" and "-- capture" first.`);
  const { orderId } = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { orderId?: string };
  if (!orderId) throw new Error('No order ID recorded. Run "npm run paypal:smoke -- create" first.');
  const paypal = createPayPalClient(loadPayPalConfig());

  const order = await paypal.getOrder(orderId) as Captured;
  const capture = order.purchase_units?.flatMap(u => u.payments?.captures ?? []).find(c => c.status === 'COMPLETED' && c.id);
  if (!capture?.id) {
    console.log(`Order status is ${order.status ?? 'unknown'} with no COMPLETED capture. Run "npm run paypal:smoke -- capture" first.`);
    process.exitCode = 1;
    return;
  }
  console.log(`captureId=${capture.id}`);
  const result = interpretRefund(await paypal.refundCapture(capture.id, REFUND_CENTS, `smoke-refund:${capture.id}`));
  if (result.ok) {
    console.log(`REFUNDED refundId=${result.refundId} status=${result.status} amount=${formatUsd(result.amountCents ?? REFUND_CENTS)} USD`);
  } else {
    console.log(`NOT REFUNDED reason=${result.reason} status=${result.status ?? 'unknown'}`);
    process.exitCode = 1;
  }
}

main().catch(error => {
  // Never print config or raw responses: they may contain credentials or buyer data.
  console.error(error instanceof PayPalError ? `${error.message}${error.outcomeUnknown ? ' — outcome unknown, rerun to reuse the request ID' : ''}${error.debugId ? ` debug_id=${error.debugId}` : ''}` : error instanceof Error ? error.message : 'Refund smoke test failed.');
  process.exitCode = 1;
});
