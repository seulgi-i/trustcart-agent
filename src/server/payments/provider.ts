import { randomUUID } from 'node:crypto';
import { centsToUsdString } from '@/src/domain/money';
import type { CheckoutOrder } from '@/src/server/payments/paypal';

export type CheckoutUrls = { returnUrl: string; cancelUrl: string };

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
// same interpretCapture check decides PAID. captureStatus lets tests simulate a capture that is not COMPLETED.
export function createMockProvider({ captureStatus = 'COMPLETED' } = {}): PaymentProvider {
  const orders = new Map<string, CheckoutOrder>();
  const mockId = () => `MOCK-${randomUUID()}`;
  const unit = (id: string) => ({ reference_id: orders.get(id)?.referenceId, payee: { merchant_id: MOCK_MERCHANT_ID } });
  const view = (id: string, status: string) => ({ id, status, mock: true, purchase_units: [unit(id)] });
  return {
    kind: 'mock',
    merchantId: MOCK_MERCHANT_ID,
    async createOrder(order) {
      const id = mockId();
      orders.set(id, order);
      return view(id, 'CREATED');
    },
    async getOrder(orderId) {
      if (!orders.has(orderId)) throw new Error('Unknown mock order');
      return view(orderId, 'CREATED');
    },
    async captureOrder(orderId) {
      const order = orders.get(orderId);
      if (!order) throw new Error('Unknown mock order');
      const amount = { currency_code: order.currency, value: centsToUsdString(order.totalCents) };
      return { id: orderId, status: captureStatus, mock: true, purchase_units: [{ ...unit(orderId), payments: { captures: [{ id: mockId(), status: captureStatus, amount }] } }] };
    },
  };
}
