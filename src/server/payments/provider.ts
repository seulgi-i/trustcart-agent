import { randomUUID } from 'node:crypto';
import { centsToUsdString } from '@/src/domain/money';
import { PayPalError, type CheckoutOrder } from '@/src/server/payments/paypal';

export type CheckoutUrls = { returnUrl: string; cancelUrl: string };

// From configuration only, never from the request Host header: APP_BASE_URL, else the Vercel deployment URL, else
// localhost outside production. A production server with neither refuses to build checkout URLs.
export function appOrigin(env: NodeJS.ProcessEnv = process.env) {
  const base = env.APP_BASE_URL?.trim();
  if (base) {
    const url = new URL(base);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('APP_BASE_URL must be an http(s) URL.');
    return url.origin;
  }
  const vercel = env.VERCEL_URL?.trim();
  if (vercel) return new URL(`https://${vercel}`).origin;
  if (env.NODE_ENV !== 'production') return 'http://localhost:3000';
  throw new Error('Set APP_BASE_URL so PayPal can redirect the buyer back.');
}

// PayPal appends its own token and PayerID query parameters.
export const checkoutUrls = (orderId: string, origin = appOrigin()): CheckoutUrls => ({
  returnUrl: `${origin}/checkout/return?orderId=${encodeURIComponent(orderId)}`,
  cancelUrl: `${origin}/checkout/cancel?orderId=${encodeURIComponent(orderId)}`,
});

// Request IDs are derived inside each provider from (operation, order), never passed in by callers. For refunds the
// caller passes the stored idempotency key of the refund request, and the provider derives the request ID from it.
export interface PaymentProvider {
  readonly kind: 'paypal-sandbox' | 'mock';
  readonly merchantId: string;
  createOrder(order: CheckoutOrder, urls: CheckoutUrls): Promise<unknown>;
  getOrder(orderId: string): Promise<unknown>;
  captureOrder(orderId: string): Promise<unknown>;
  // amountCents null = full refund of what is left on the capture (no amount in the request body).
  refundCapture(captureId: string, amountCents: number | null, idempotencyKey: string): Promise<unknown>;
}

export const MOCK_MERCHANT_ID = 'MOCK-MERCHANT';

// MOCK ONLY: no network, no money. Every ID starts with MOCK- and every response carries mock: true,
// so it can never be presented as a real PayPal order or capture. Responses mirror the PayPal shape so the
// same checks decide PAID. There is no buyer page: the approval link is the return URL and the order reads as
// APPROVED (approve: false simulates a buyer who never approved). Capture is idempotent per order, like PayPal
// with a reused request ID. captureStatus lets tests simulate a capture that is not COMPLETED. Refunds are
// idempotent per key and refuse more than is left on the capture, like PayPal.
export function createMockProvider({ captureStatus = 'COMPLETED', approve = true } = {}): PaymentProvider {
  const orders = new Map<string, { order: CheckoutOrder; captureId?: string; refundedCents: number }>();
  const refunds = new Map<string, unknown>();
  const mockId = () => `MOCK-${randomUUID()}`;
  const get = (id: string) => {
    const entry = orders.get(id);
    if (!entry) throw new Error('Unknown mock order');
    return entry;
  };
  const view = (id: string, status: string) => {
    const { order, captureId } = get(id);
    const amount = { currency_code: order.currency, value: centsToUsdString(order.totalCents) };
    const payments = captureId ? { captures: [{ id: captureId, status: captureStatus, amount }] } : undefined;
    return { id, status, mock: true, purchase_units: [{ reference_id: order.referenceId, amount, payee: { merchant_id: MOCK_MERCHANT_ID }, payments }] };
  };
  return {
    kind: 'mock',
    merchantId: MOCK_MERCHANT_ID,
    async createOrder(order, urls) {
      const id = mockId();
      orders.set(id, { order, refundedCents: 0 });
      return { ...view(id, 'CREATED'), links: [{ rel: 'payer-action', href: urls.returnUrl }] };
    },
    async getOrder(orderId) {
      const { captureId } = get(orderId);
      return view(orderId, captureId ? 'COMPLETED' : approve ? 'APPROVED' : 'PAYER_ACTION_REQUIRED');
    },
    async captureOrder(orderId) {
      const entry = get(orderId);
      entry.captureId ??= mockId();
      return view(orderId, captureStatus);
    },
    async refundCapture(captureId, amountCents, idempotencyKey) {
      const replay = refunds.get(idempotencyKey);
      if (replay) return replay;
      const entry = [...orders.values()].find(e => e.captureId === captureId);
      if (!entry) throw new Error('Unknown mock capture');
      const remaining = entry.order.totalCents - entry.refundedCents;
      const cents = amountCents ?? remaining;
      if (cents <= 0 || cents > remaining) throw new PayPalError(422, 'UNPROCESSABLE_ENTITY', false);
      entry.refundedCents += cents;
      const refund = { id: mockId(), status: 'COMPLETED', mock: true, amount: { currency_code: entry.order.currency, value: centsToUsdString(cents) } };
      refunds.set(idempotencyKey, refund);
      return refund;
    },
  };
}
