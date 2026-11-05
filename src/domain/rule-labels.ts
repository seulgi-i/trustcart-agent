// Human labels for Evaluation reasons, shared by the server (messages) and the review inbox ("Layer n · label").
// Pure data, safe to import in client components.
export const RULE_LABELS: Record<string, string> = {
  // Layer 1: system
  'injection-scanner': 'Prompt-injection scan',
  'intent-budget': 'Intent match: budget',
  'intent-quantity': 'Intent match: quantity',
  'intent-category': 'Intent match: category',
  'empty-cart': 'Price finalization: empty cart',
  'unknown-product': 'Price finalization: unknown product',
  'invalid-quantity': 'Price finalization: invalid quantity',
  'max-units-per-line': 'Price finalization: max units per line',
  'out-of-stock': 'Price finalization: stock',
  'hard-budget-cap': 'Price finalization: hard cap per payment',
  'velocity-limit': 'Velocity limit',
  'split-payment': 'Split-payment detection',
  'duplicate-payment': 'Duplicate payment',
  'daily-hard-cap': 'Daily hard cap',
  'monthly-hard-cap': 'Monthly hard cap',
  // Layer 2: user settings
  'policy-per-order-max': 'Per-order maximum',
  'policy-daily-max': 'Daily maximum',
  'policy-category-max': 'Category maximum',
  'policy-category': 'Category not allowed',
  'policy-approval-threshold': 'Always review above',
  'policy-outside-hours': 'Outside allowed hours',
  'policy-outside-weekdays': 'Outside allowed weekdays',
};

export const ruleLabel = (ruleId: string) => RULE_LABELS[ruleId] ?? ruleId;

// Orders stored before the two-layer model carry only { rule, expected, actual }; they are shown with the layer
// inferred from the rule name.
export function describeReason(r: { layer?: number; ruleId?: string; rule?: string; message?: string; expected?: string; actual?: string }) {
  const ruleId = r.ruleId ?? r.rule ?? 'unknown';
  const layer = r.layer ?? (ruleId.startsWith('policy-') ? 2 : 1);
  return { title: `Layer ${layer} · ${ruleLabel(ruleId)}`, message: r.message ?? `expected ${r.expected ?? '?'}, got ${r.actual ?? '?'}` };
}
