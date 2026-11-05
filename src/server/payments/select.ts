import { assertSandboxHost, createPayPalClient, loadPayPalConfig } from '@/src/server/payments/paypal';
import { createMockProvider, type PaymentProvider } from '@/src/server/payments/provider';

type Env = Record<string, string | undefined>;

// Server-only. PayPal sandbox when both client credentials are set, the labeled mock only when neither is. Any
// other configuration (one credential without the other, missing merchant ID, non-sandbox base) throws instead
// of silently falling back to the mock.
export function selectProvider(env: Env = process.env): PaymentProvider {
  const hasId = Boolean(env.PAYPAL_CLIENT_ID?.trim());
  const hasSecret = Boolean(env.PAYPAL_CLIENT_SECRET?.trim());
  if (!hasId && !hasSecret) return createMockProvider();
  if (!hasId || !hasSecret) throw new Error('Set both PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET, or neither to use the mock provider.');
  const config = loadPayPalConfig(env);
  assertSandboxHost(config.apiBase);
  return createPayPalClient(config);
}

// One instance per server process: the PayPal token cache and the mock's in-memory orders are shared by the
// approve, capture and cancel routes, and survive dev hot reloads.
const globalForProvider = globalThis as unknown as { paymentProvider?: PaymentProvider };
export function paymentProvider(): PaymentProvider {
  return (globalForProvider.paymentProvider ??= selectProvider());
}
