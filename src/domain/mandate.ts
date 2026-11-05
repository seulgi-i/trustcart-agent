import { formatUsd } from '@/src/domain/money';
import type { Layer1Limits } from '@/src/domain/layer1';
import type { Evaluation, Intent, PricedLine, Reason } from '@/src/domain/policy';
import type { SpendingPolicy } from '@/src/domain/spending-policy';

// Intent mandate certificate, modeled on the AP2 Intent/Cart Mandate concept (no AP2 compliance is claimed): what the
// user asked for, the exact cart that was approved and paid, why each item was picked, the policy that let it through
// and the PayPal IDs of the payment. Built once per successful capture and signed over its canonical JSON.

export const MANDATE_TYPE = 'trustcart.intent-mandate.v1';

export type PolicySource = 'payment_time_snapshot' | 'reconstructed_at_recovery';
export const RECONSTRUCTED_POLICY_NOTE = 'Not the payment-time policy. This order had no payment decision snapshot; it was recovered after an interrupted capture, so the decision and reasons are from the checkout evaluation and the Layer 1 and Layer 2 limits were read at recovery time.';

// Display label for a stored mandate's policy source. Mandates issued before the field existed carry none.
export function policySourceLabel(policy: { source?: string; note?: string }) {
  if (policy.source === 'payment_time_snapshot') return { reconstructed: false, label: 'Payment-time snapshot (taken when the payment was approved)' };
  if (policy.source === 'reconstructed_at_recovery') return { reconstructed: true, label: `Reconstructed at recovery. ${policy.note ?? RECONSTRUCTED_POLICY_NOTE}` };
  return { reconstructed: true, label: 'Policy source not recorded (mandate issued before policy sources were tracked).' };
}

export type MandateItem = Pick<PricedLine, 'productId' | 'name' | 'seller' | 'category' | 'quantity' | 'unitCents' | 'subtotalCents'>;
// The demo ships nothing (PayPal NO_SHIPPING), so the approved shipping is always 0; a billed shipping fee is a mismatch.
export type MandateCart = { merchant: string; currency: 'USD'; items: MandateItem[]; itemTotalCents: number; shippingCents: number; totalCents: number };
export type MandatePayload = {
  type: typeof MANDATE_TYPE;
  orderId: string;
  intent: Intent;
  cart: MandateCart;
  // agentReason is model-written (untrusted) text from the buildCart tool; serverChecks are derived by the server.
  selection: { productId: string; agentReason: string | null; serverChecks: string[] }[];
  // source says where the policy came from: the approval snapshot, or (a legacy order recovered from CAPTURING with
  // no snapshot) the order's checkout evaluation and the limits read at recovery, explained in note.
  policy: { source: PolicySource; note?: string; decision: Evaluation['decision']; reasons: Reason[]; layer1: Layer1Limits; layer2: SpendingPolicy };
  payment: { provider: string; providerOrderId: string; captureId: string; capturedCents: number; currency: 'USD' };
  timestamps: { intentSetAt: string; orderCreatedAt: string; prechargeScheduledAt: string | null; capturedAt: string };
};

// Stable serialization: object keys sorted by UTF-16 code unit at every level, undefined members dropped (as in
// JSON.stringify), no whitespace. The signature covers exactly these bytes.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cannot canonicalize a non-finite number');
    return JSON.stringify(value);
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(v => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new TypeError(`Cannot canonicalize a ${typeof value}`);
}

// Shown on the pre-charge notice and recorded as the mandate's merchant. Seller names are seller-written text.
export const merchantLabel = (lines: Pick<PricedLine, 'seller'>[], provider: string | null) =>
  `${[...new Set(lines.map(l => l.seller))].join(', ') || 'TrustCart'} via ${provider === 'paypal-sandbox' ? 'PayPal Sandbox' : 'mock provider'}`;

// order.evaluation, policy and layer1 are the payment decision snapshot taken when the order was approved for
// payment (src/server/orders.ts), not the order's checkout-time evaluation or the policy in force at capture, unless
// policySource is 'reconstructed_at_recovery'.
export type MandateInput = {
  policySource: PolicySource;
  order: { id: string; totalCents: number; createdAt: Date; captureScheduledAt: Date | null; provider: string; providerOrderId: string; cartJson: string; evaluation: Evaluation };
  intent: Intent & { createdAt: Date };
  captureId: string;
  capturedCents: number;
  policy: SpendingPolicy;
  layer1: Layer1Limits;
  capturedAt: Date;
};

const AGENT_REASON_MAX = 200;

// The agent's optional per-item reason, as stored with the cart it proposed.
function agentReasons(cartJson: string) {
  const reasons = new Map<string, string>();
  let cart: unknown;
  try { cart = JSON.parse(cartJson); } catch { return reasons; }
  if (!Array.isArray(cart)) return reasons;
  for (const line of cart as { productId?: unknown; reason?: unknown }[]) {
    if (typeof line?.productId !== 'string' || typeof line.reason !== 'string' || reasons.has(line.productId)) continue;
    const reason = line.reason.trim().slice(0, AGENT_REASON_MAX);
    if (reason) reasons.set(line.productId, reason);
  }
  return reasons;
}

export function buildMandatePayload({ policySource, order, intent, captureId, capturedCents, policy, layer1, capturedAt }: MandateInput): MandatePayload {
  const { lines, decision, reasons, scan } = order.evaluation;
  const items: MandateItem[] = lines.map(({ productId, name, seller, category, quantity, unitCents, subtotalCents }) => ({ productId, name, seller, category, quantity, unitCents, subtotalCents }));
  const itemTotalCents = items.reduce((sum, i) => sum + i.subtotalCents, 0);
  const notes = agentReasons(order.cartJson);
  const selection = items.map(item => {
    const hits = scan.find(s => s.productId === item.productId)?.hits ?? [];
    return {
      productId: item.productId,
      agentReason: notes.get(item.productId) ?? null,
      serverChecks: [
        `Category ${item.category} ${item.category === intent.category ? 'matches' : 'differs from'} the requested ${intent.category}.`,
        `Catalog price ${formatUsd(item.unitCents)} x ${item.quantity} = ${formatUsd(item.subtotalCents)}, priced on the server.`,
        hits.length ? `Seller text flagged by the injection scanner (${hits.join(', ')}).` : 'No suspicious instructions found in the seller text.',
      ],
    };
  });
  return {
    type: MANDATE_TYPE,
    orderId: order.id,
    intent: { budgetCents: intent.budgetCents, category: intent.category, quantity: intent.quantity },
    cart: { merchant: merchantLabel(lines, order.provider), currency: 'USD', items, itemTotalCents, shippingCents: 0, totalCents: order.totalCents },
    selection,
    policy: { source: policySource, ...(policySource === 'reconstructed_at_recovery' ? { note: RECONSTRUCTED_POLICY_NOTE } : {}), decision, reasons, layer1, layer2: policy },
    payment: { provider: order.provider, providerOrderId: order.providerOrderId, captureId, capturedCents, currency: 'USD' },
    timestamps: {
      intentSetAt: intent.createdAt.toISOString(),
      orderCreatedAt: order.createdAt.toISOString(),
      prechargeScheduledAt: order.captureScheduledAt?.toISOString() ?? null,
      capturedAt: capturedAt.toISOString(),
    },
  };
}
