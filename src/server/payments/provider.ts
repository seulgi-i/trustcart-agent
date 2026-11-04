import { randomUUID } from 'node:crypto';
import type { CheckoutOrder } from '@/src/server/payments/paypal';

export type CheckoutUrls = { returnUrl: string; cancelUrl: string };

// Request IDs are derived inside each provider from (operation, order), never passed in by callers.
export interface PaymentProvider {
  readonly kind: 'paypal-sandbox' | 'mock';
  createOrder(order: CheckoutOrder, urls: CheckoutUrls): Promise<unknown>;
  getOrder(orderId: string): Promise<unknown>;
  captureOrder(orderId: string): Promise<unknown>;
}

// MOCK ONLY: no network, no money. Every ID starts with MOCK- and every response carries mock: true,
// so it can never be presented as a real PayPal order or capture.
export function createMockProvider(): PaymentProvider {
  const orders = new Map<string, CheckoutOrder>();
  const mockId = () => `MOCK-${randomUUID()}`;
  const view = (id: string, status: string) => ({ id, status, mock: true, purchase_units: [{ reference_id: orders.get(id)?.referenceId }] });
  return {
    kind: 'mock',
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
      if (!orders.has(orderId)) throw new Error('Unknown mock order');
      return { ...view(orderId, 'MOCK_CAPTURED'), capture_id: mockId() };
    },
  };
}
