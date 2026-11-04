import { createHash } from 'node:crypto';
import { z } from 'zod';
import { centsToUsdString, lineTotalCents, usdStringToCents } from '@/src/domain/money';
import type { RuntimeProduct } from '@/src/server/catalog';
import type { PaymentProvider } from '@/src/server/payments/provider';

// Server-only thin REST adapter for PayPal Orders v2, CAPTURE intent. The demo never talks to the live API.
export const PAYPAL_SANDBOX_API = 'https://api-m.sandbox.paypal.com';

export type PayPalConfig = { apiBase: typeof PAYPAL_SANDBOX_API; clientId: string; clientSecret: string; merchantId: string };
type Env = Record<string, string | undefined>;

export function loadPayPalConfig(env: Env = process.env): PayPalConfig {
  const base = env.PAYPAL_API_BASE?.trim().replace(/\/+$/, '');
  if (base && base !== PAYPAL_SANDBOX_API) throw new Error('Only the PayPal sandbox API is allowed in this demo.');
  const mode = env.PAYPAL_ENV?.trim();
  if (mode && mode !== 'sandbox') throw new Error('PAYPAL_ENV must be "sandbox" in this demo.');
  const clientId = env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim();
  const merchantId = env.PAYPAL_SANDBOX_MERCHANT_ID?.trim();
  if (!clientId || !clientSecret || !merchantId) throw new Error('Set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_SANDBOX_MERCHANT_ID.');
  return { apiBase: PAYPAL_SANDBOX_API, clientId, clientSecret, merchantId };
}

// Checkout input from a browser or script carries only product and quantity. Amount, currency and payee are server-owned.
export const checkoutInputSchema = z.object({ productId: z.string().min(1).max(80), quantity: z.number().int().min(1).max(5) });
export type CheckoutOrder = { referenceId: string; currency: 'USD'; unitCents: number; quantity: number; name: string; totalCents: number };

export function priceCheckout(input: unknown, catalog: RuntimeProduct[], referenceId: string): CheckoutOrder {
  const { productId, quantity } = checkoutInputSchema.parse(input);
  const product = catalog.find(p => p.id === productId);
  if (!product || quantity > product.stock) throw new Error('Product is unavailable in the requested quantity.');
  return { referenceId, currency: 'USD', unitCents: product.priceCents, quantity, name: product.name, totalCents: lineTotalCents(product.priceCents, quantity) };
}

export function createOrderBody(order: CheckoutOrder, config: PayPalConfig, urls: { returnUrl: string; cancelUrl: string }) {
  const money = (cents: number) => ({ currency_code: order.currency, value: centsToUsdString(cents) });
  return {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: order.referenceId,
      amount: { ...money(order.totalCents), breakdown: { item_total: money(order.totalCents) } },
      payee: { merchant_id: config.merchantId },
      items: [{ name: order.name.slice(0, 127), quantity: String(order.quantity), unit_amount: money(order.unitCents) }],
    }],
    payment_source: { paypal: { experience_context: { return_url: urls.returnUrl, cancel_url: urls.cancelUrl, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' } } },
  };
}

export class PayPalError extends Error {
  // outcomeUnknown: the request may have reached PayPal. Callers must reconcile, never retry with a new request ID.
  constructor(readonly status: number, readonly code: string, readonly outcomeUnknown: boolean, readonly debugId?: string) {
    super(`PayPal request failed: ${code} (${status})`);
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
const PAYPAL_ID = /^[A-Z0-9]{1,36}$/;

// Derived, never caller-supplied: a retry of one operation on one order reuses the ID, anything else gets a distinct one.
export function paypalRequestId(operation: 'create' | 'capture', key: string) {
  return `trustcart-${createHash('sha256').update(`${operation}\0${key}`).digest('hex')}`;
}

export function createPayPalClient(config: PayPalConfig, fetchImpl: FetchLike = fetch, maxAttempts = 3): PaymentProvider {
  if (config.apiBase !== PAYPAL_SANDBOX_API) throw new Error('Only the PayPal sandbox API is allowed in this demo.');
  let token: { value: string; expiresAt: number } | null = null;

  async function accessToken() {
    if (token && token.expiresAt > Date.now()) return token.value;
    const res = await fetchImpl(`${config.apiBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const json = await res.json().catch(() => null) as { access_token?: string; expires_in?: number } | null;
    if (!res.ok || !json?.access_token) throw new PayPalError(res.status, 'AUTHENTICATION_FAILED', false);
    token = { value: json.access_token, expiresAt: Date.now() + Math.max(0, (json.expires_in ?? 0) - 60) * 1000 };
    return token.value;
  }

  // The same requestId is reused for every attempt of one logical operation so PayPal can deduplicate it.
  async function send(method: 'GET' | 'POST', path: string, requestId?: string, body?: unknown): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetchImpl(`${config.apiBase}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${await accessToken()}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
            ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        if (error instanceof PayPalError) throw error;
        if (attempt < maxAttempts) continue;
        throw new PayPalError(0, 'NETWORK_ERROR', true);
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < maxAttempts) continue;
      const json = await res.json().catch(() => null) as { name?: string; debug_id?: string } | null;
      if (!res.ok) throw new PayPalError(res.status, json?.name ?? 'HTTP_ERROR', retryable, json?.debug_id);
      return json;
    }
  }

  const orderPath = (orderId: string) => {
    if (!PAYPAL_ID.test(orderId)) throw new Error('Invalid PayPal order ID');
    return `/v2/checkout/orders/${orderId}`;
  };

  return {
    kind: 'paypal-sandbox',
    createOrder: (order, urls) =>
      send('POST', '/v2/checkout/orders', paypalRequestId('create', order.referenceId), createOrderBody(order, config, urls)),
    getOrder: orderId => send('GET', orderPath(orderId)),
    captureOrder: orderId => send('POST', `${orderPath(orderId)}/capture`, paypalRequestId('capture', orderId), {}),
  };
}

const moneySchema = z.object({ currency_code: z.string(), value: z.string() });
const orderResponseSchema = z.object({
  id: z.string(),
  status: z.string(),
  links: z.array(z.object({ rel: z.string(), href: z.string() })).optional(),
  purchase_units: z.array(z.object({
    reference_id: z.string().optional(),
    payee: z.object({ merchant_id: z.string().optional() }).optional(),
    payments: z.object({ captures: z.array(z.object({ id: z.string(), status: z.string(), amount: moneySchema })).optional() }).optional(),
  })).optional(),
});

export function approvalLink(response: unknown): string | null {
  const parsed = orderResponseSchema.safeParse(response);
  return parsed.success ? parsed.data.links?.find(l => l.rel === 'payer-action' || l.rel === 'approve')?.href ?? null : null;
}

export type CaptureResult = { paid: true; captureId: string; amountCents: number } | { paid: false; reason: string; status?: string };

// PAID only when the capture resource itself is COMPLETED and bound to the expected amount, currency, payee and order.
// A redirect, an APPROVED order or a 2xx response is not proof of payment.
export function interpretCapture(response: unknown, expected: { referenceId: string; totalCents: number; merchantId: string }): CaptureResult {
  const parsed = orderResponseSchema.safeParse(response);
  if (!parsed.success) return { paid: false, reason: 'UNRECOGNIZED_RESPONSE' };
  const units = parsed.data.purchase_units ?? [];
  if (units.length !== 1) return { paid: false, reason: 'UNEXPECTED_PURCHASE_UNITS', status: parsed.data.status };
  const [unit] = units;
  const captures = unit.payments?.captures ?? [];
  if (captures.length !== 1) return { paid: false, reason: 'NO_SINGLE_CAPTURE', status: parsed.data.status };
  const [capture] = captures;
  if (capture.status !== 'COMPLETED') return { paid: false, reason: 'CAPTURE_NOT_COMPLETED', status: capture.status };
  if (unit.reference_id !== expected.referenceId) return { paid: false, reason: 'REFERENCE_MISMATCH', status: capture.status };
  if (unit.payee?.merchant_id !== expected.merchantId) return { paid: false, reason: 'PAYEE_MISMATCH', status: capture.status };
  if (capture.amount.currency_code !== 'USD') return { paid: false, reason: 'CURRENCY_MISMATCH', status: capture.status };
  let amountCents: number;
  try { amountCents = usdStringToCents(capture.amount.value); } catch { return { paid: false, reason: 'AMOUNT_UNPARSEABLE', status: capture.status }; }
  if (amountCents !== expected.totalCents) return { paid: false, reason: 'AMOUNT_MISMATCH', status: capture.status };
  return { paid: true, captureId: capture.id, amountCents };
}
