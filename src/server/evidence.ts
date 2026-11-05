import type { PrismaClient } from '@prisma/client';
import { policySourceLabel } from '@/src/domain/mandate';
import { formatUsd } from '@/src/domain/money';
import { SCENARIO_LABELS, type MismatchScenario } from '@/src/domain/mismatch';
import { mandateSigner, verifyMandate, type MandateSigner, type MandateVerification } from '@/src/server/mandate';
import type { PdfLine } from '@/src/server/pdf';
import { mandateView, refundView } from '@/src/server/protection';
import { ownedBy } from '@/src/server/session';

// Evidence package for a paid order: the signed mandate with the public key and a fresh verification, every billing
// mismatch with its diff, the refunds and the order's audit trail. Exported as JSON or a simple PDF from the order
// view; nothing is sent anywhere (no dispute is created).

export type EvidencePackage = NonNullable<Awaited<ReturnType<typeof buildEvidence>>>;

export async function buildEvidence(db: PrismaClient, sessionId: string, id: string, signer: () => MandateSigner = mandateSigner) {
  const order = await db.order.findFirst({ where: ownedBy(sessionId, id), include: { mandate: true, refundRequests: { orderBy: { createdAt: 'asc' } } } });
  if (!order) return null;
  const key = signer();
  // Audit details are JSON; keep the entries that name this order.
  const rows = await db.auditLog.findMany({ where: { sessionId, detail: { contains: id } }, orderBy: { createdAt: 'asc' } });
  const auditTrail = rows.flatMap(r => {
    let detail: unknown;
    try { detail = JSON.parse(r.detail); } catch { return []; }
    return (detail as { orderId?: unknown } | null)?.orderId === id ? [{ at: r.createdAt.toISOString(), action: r.action, outcome: r.outcome, detail }] : [];
  });
  const verification: MandateVerification | null = order.mandate ? verifyMandate(order.mandate, key, { orderId: id, captureId: order.captureId }) : null;
  return {
    generatedAt: new Date().toISOString(),
    order: { id: order.id, status: order.status, totalCents: order.totalCents, provider: order.provider, providerOrderId: order.providerOrderId, captureId: order.captureId, createdAt: order.createdAt.toISOString() },
    mandate: order.mandate ? { ...mandateView(order.mandate), canonicalPayload: order.mandate.payload, algorithm: 'Ed25519', publicKeyPem: key.publicKeyPem } : null,
    verification,
    mismatches: order.refundRequests.map(r => refundView(r)),
    auditTrail,
  };
}

const text = (value: unknown) => (value === null || value === undefined ? '-' : String(value));

export function evidencePdfLines(pkg: EvidencePackage): PdfLine[] {
  const lines: PdfLine[] = [];
  const h = (t: string) => lines.push({ text: '' }, { text: t, bold: true, size: 11 });
  const p = (t: string, color?: PdfLine['color']) => lines.push({ text: t, color });
  lines.push({ text: 'TrustCart evidence package', bold: true, size: 14 }, { text: `Generated ${pkg.generatedAt}. Demo: PayPal Sandbox or mock provider, no real money.`, color: 'gray' });

  h('Order');
  const { order } = pkg;
  p(`Order ID: ${order.id}`);
  p(`Status: ${order.status}   Total: ${formatUsd(order.totalCents)}   Provider: ${text(order.provider)}`);
  p(`PayPal order ID: ${text(order.providerOrderId)}`);
  p(`Capture ID: ${text(order.captureId)}`);

  h('Signature verification');
  if (!pkg.mandate || !pkg.verification) p('No mandate was issued for this order.', 'red');
  else {
    const v = pkg.verification;
    p(v.valid ? 'VALID: the mandate signature verifies under the server key.' : 'INVALID: the mandate failed verification.', v.valid ? 'black' : 'red');
    for (const [check, ok] of Object.entries(v.checks)) p(`  ${check}: ${ok ? 'ok' : 'FAILED'}`, ok ? 'black' : 'red');
    p(`Algorithm: ${pkg.mandate.algorithm}   Key fingerprint (sha256 of SPKI DER): ${pkg.mandate.publicKeyFingerprint}`);
    p(`Signature (base64): ${pkg.mandate.signature}`);
    for (const l of pkg.mandate.publicKeyPem.trim().split('\n')) p(l, 'gray');
  }

  if (pkg.mandate) {
    const m = pkg.mandate.payload;
    h('Mandate');
    p(`Intent: budget ${formatUsd(m.intent.budgetCents)}, ${m.intent.quantity} x ${m.intent.category}`);
    p(`Merchant: ${m.cart.merchant}`);
    for (const i of m.cart.items) p(`  ${i.quantity} x ${i.name} (${i.productId}, ${i.seller}) @ ${formatUsd(i.unitCents)} = ${formatUsd(i.subtotalCents)}`);
    p(`Items ${formatUsd(m.cart.itemTotalCents)} + shipping ${formatUsd(m.cart.shippingCents)} = total ${formatUsd(m.cart.totalCents)} ${m.cart.currency}`);
    p('Selection reasons:');
    for (const s of m.selection) {
      p(`  ${s.productId}: agent (untrusted): ${s.agentReason ?? '(none given)'}`);
      for (const c of s.serverChecks) p(`    - ${c}`);
    }
    const source = policySourceLabel(m.policy);
    p(`Policy source: ${source.label}`, source.reconstructed ? 'red' : undefined);
    p(`Policy decision: ${m.policy.decision}`);
    for (const r of m.policy.reasons) p(`  Layer ${r.layer} - ${r.ruleId}: ${r.message}`);
    const l2 = m.policy.layer2;
    p(`Layer 2: per order ${formatUsd(l2.perOrderMaxCents)}, daily ${formatUsd(l2.dailyMaxCents)}, review above ${formatUsd(l2.requireApprovalAboveCents)}, categories ${l2.allowedCategories.join(', ')}, hours ${l2.allowedHours.startHour}-${l2.allowedHours.endHour} ${l2.timezone}, pre-charge ${l2.prechargeDelaySeconds} s`);
    const l1 = m.policy.layer1;
    p(`Layer 1: ${formatUsd(l1.hardCapCents)} per payment, ${l1.velocityMax} payments / ${l1.velocityWindowMinutes} min, daily ${formatUsd(l1.dailyHardCapCents)}, monthly ${formatUsd(l1.monthlyHardCapCents)}`);
    p(`Timestamps: intent ${m.timestamps.intentSetAt}, order ${m.timestamps.orderCreatedAt}, pre-charge ${text(m.timestamps.prechargeScheduledAt)}, captured ${m.timestamps.capturedAt}`);
  }

  h('Billing mismatches');
  if (!pkg.mismatches.length) p('None recorded.');
  for (const r of pkg.mismatches) {
    p(`${SCENARIO_LABELS[r.scenario as MismatchScenario] ?? r.scenario} - refund ${r.status}${r.amountCents !== null ? ` ${formatUsd(r.amountCents)} (${r.mode})` : ''}${r.providerRefundId ? ` refund ID ${r.providerRefundId}` : ''}${r.failureReason ? ` reason ${r.failureReason}` : ''}`, 'black');
    for (const d of r.diff) p(`  ${d.field}: expected ${text(d.expected)}, billed ${text(d.actual)}`, 'red');
    p(`  Suggested partial refund: ${formatUsd(r.suggestedCents)} of ${formatUsd(r.capturedCents)} captured`);
  }

  h('Audit trail');
  for (const a of pkg.auditTrail) p(`${a.at} ${a.action} ${a.outcome} ${JSON.stringify(a.detail)}`, 'gray');
  return lines;
}
