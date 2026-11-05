import { randomUUID } from 'node:crypto';
import { centsToUsdString } from '@/src/domain/money';
import type { CheckoutOrder } from '@/src/server/payments/paypal';

export type CheckoutUrls = { returnUrl: string; cancelUrl: string };

// Fixed, never derived from the request Host header. PayPal appends its own token and PayerID query parameters.
export const APP_ORIGIN = 'http://localhost:3000';
export const checkoutUrls = (orderId: string): CheckoutUrls => ({
  returnUrl: `${APP_ORIGIN}/checkout/return?orderId=${encodeURIComponent(orderId)}`,
  cancelUrl: `${APP_ORIGIN}/checkout/cancel?orderId=${encodeURIComponent(orderId)}`,
});

// Request IDs are derived inside each provider from (operation, order), never passed in by callers.
export interface PaymentProvider {
  readonly kind: 'paypal-sandbox' | 'mock';
  readonly merchantId: string;
  createOrder(order: CheckoutOrder, urls: CheckoutUrls): Promise<unknown>;
  getOrder(orderId: string): Promise<unknown>;
  captureOrder(orderId: string): Promise<unknown>;
}

export const MOCK_MERCHANT_ID = 'MOCK-MERCHANT';

// MOCK ONLY: no network, no money. Every ID starts with MOCK- and every response carries mock: true,
// so it can never be presented as a real PayPal order or capture. Responses mirror the PayPal shape so the
// same checks decide PAID. There is no buyer page: the approval link is the return URL and the order reads as
// APPROVED (approve: false simulates a buyer who never approved). Capture is idempotent per order, like PayPal
// with a reused request ID. captureStatus lets tests simulate a capture that is not COMPLETED.
export function createMockProvider({ captureStatus = 'COMPLETED', approve = true } = {}): PaymentProvider {
  const orders = new Map<string, { order: CheckoutOrder; captureId?: string }>();
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
      orders.set(id, { order });
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
  };
}
