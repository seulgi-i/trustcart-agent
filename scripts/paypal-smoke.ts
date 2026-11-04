// Local-only PayPal sandbox smoke test: one real buyer approval followed by one server-side capture.
// Not an HTTP endpoint and never deployed. Prints only order ID, approval link, amount, capture status and capture ID.
//   npm run paypal:smoke -- create
//   (approve in the browser with the sandbox personal buyer)
//   npm run paypal:smoke -- capture
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { formatUsd } from '@/src/domain/money';
import { runtimeCatalog } from '@/src/server/catalog';
import { approvalLink, createPayPalClient, interpretCapture, loadPayPalConfig, PayPalError, priceCheckout, type CheckoutOrder } from '@/src/server/payments/paypal';

const STATE_FILE = '.paypal-smoke.json';
const FIXTURE = { productId: 'camp-06', quantity: 1 };
type State = { order: CheckoutOrder; orderId?: string };

const save = (state: State) => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const load = (): State => {
  if (!existsSync(STATE_FILE)) throw new Error(`Run "create" first (${STATE_FILE} not found).`);
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State;
};

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('The smoke script is for local development only.');
  const config = loadPayPalConfig();
  const paypal = createPayPalClient(config);
  const command = process.argv[2];

  if (command === 'create') {
    // The order (and so its reference ID) is persisted before the first call so a rerun after a timeout
    // derives the same PayPal-Request-Id.
    const previous = existsSync(STATE_FILE) ? load() : null;
    const state: State = previous && !previous.orderId ? previous
      : { order: priceCheckout(FIXTURE, runtimeCatalog(), `smoke-${randomUUID()}`) };
    save(state);
    const created = await paypal.createOrder(state.order, { returnUrl: 'http://localhost:3000/?paypal=return', cancelUrl: 'http://localhost:3000/?paypal=cancel' });
    const orderId = (created as { id?: string }).id;
    if (!orderId) throw new Error('PayPal did not return an order ID.');
    save({ ...state, orderId });
    console.log(`Order ${orderId} created for ${formatUsd(state.order.totalCents)} USD.`);
    console.log(`Approve as the sandbox buyer: ${approvalLink(created) ?? '(no approval link returned)'}`);
    return;
  }

  if (command === 'capture') {
    const state = load();
    if (!state.orderId) throw new Error('No order ID recorded. Rerun "create".');
    const current = await paypal.getOrder(state.orderId) as { status?: string };
    if (current.status !== 'APPROVED' && current.status !== 'COMPLETED') {
      console.log(`Order status is ${current.status ?? 'unknown'}. Approve it as the sandbox buyer first.`);
      process.exitCode = 1;
      return;
    }
    const captured = current.status === 'COMPLETED' ? current : await paypal.captureOrder(state.orderId);
    const result = interpretCapture(captured, { referenceId: state.order.referenceId, totalCents: state.order.totalCents, merchantId: config.merchantId });
    if (result.paid) {
      console.log(`PAID amount=${formatUsd(result.amountCents)} USD captureStatus=COMPLETED captureId=${result.captureId}`);
    } else {
      console.log(`NOT PAID reason=${result.reason} captureStatus=${result.status ?? 'unknown'}`);
      process.exitCode = 1;
    }
    return;
  }

  console.log('Usage: npm run paypal:smoke -- create | capture');
  process.exitCode = 1;
}

main().catch(error => {
  // Never print config or raw responses: they may contain credentials or buyer data.
  console.error(error instanceof PayPalError ? `${error.message}${error.outcomeUnknown ? ' — outcome unknown, rerun the same command to reuse the request ID' : ''}${error.debugId ? ` debug_id=${error.debugId}` : ''}` : error instanceof Error ? error.message : 'Smoke test failed.');
  process.exitCode = 1;
});
