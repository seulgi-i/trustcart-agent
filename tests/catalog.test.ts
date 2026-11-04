import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFixture, runtimeCatalog } from '../src/server/catalog';
import { groundTruthLabels } from '../src/eval/ground-truth';
import { lineTotalCents, usdToCents } from '../src/domain/money';
import { evaluateCart } from '../src/domain/policy';
import { matchingProducts, toolProduct } from '../lib/shop';

test('catalog_schema_and_labels', () => {
  const fixture = loadFixture();
  assert.equal(fixture.length, 30);
  assert.equal(new Set(fixture.map(p => p.id)).size, 30);
  assert.equal([...groundTruthLabels().values()].filter(Boolean).length, 10);
  assert.ok(!readFileSync('data/products.json', 'utf8').includes('isMalicious'), 'labels must live in src/eval only');
  for (const p of fixture) {
    assert.ok(Number.isInteger(p.stock) && p.stock >= 0, p.id);
    assert.equal(usdToCents(p.priceUSD) / 100, p.priceUSD, p.id);
  }
});

test('labels_do_not_leak_via_id_or_seller', () => {
  const labels = groundTruthLabels();
  const fixture = loadFixture();
  const bad = fixture.filter(p => labels.get(p.id));
  const good = fixture.filter(p => !labels.get(p.id));
  const prefix = (id: string) => id.replace(/\d+$/, '');
  // Malicious products share no seller with each other, and every one of their sellers also sells benign products.
  assert.equal(new Set(bad.map(p => p.seller)).size, bad.length);
  for (const p of bad) assert.ok(good.some(g => g.seller === p.seller), `${p.seller} sells only malicious products`);
  // Malicious IDs use the same shapes as benign ones and are not a contiguous block.
  for (const p of bad) assert.ok(good.some(g => prefix(g.id) === prefix(p.id) && g.id.length === p.id.length), p.id);
  const ids = fixture.map(p => p.id);
  const positions = bad.map(p => ids.indexOf(p.id));
  assert.ok(positions.some((pos, i) => i > 0 && pos - positions[i - 1] > 1), 'malicious products must not be contiguous');
});

test('runtime_catalog_hides_ground_truth', () => {
  for (const p of runtimeCatalog()) assert.ok(!('isMalicious' in p), p.id);
  for (const p of matchingProducts('', null, runtimeCatalog()).map(toolProduct)) assert.ok(!('isMalicious' in p), p.id);
  // Runtime modules must not reach the evaluation labels.
  const runtimeFiles = ['lib/shop.ts', 'lib/agent.ts', 'lib/db.ts', 'src/domain/policy.ts', 'src/domain/scanner.ts', 'src/server/catalog.ts', 'src/server/orders.ts',
    'src/server/session.ts', 'src/server/payments/paypal.ts', 'src/server/payments/provider.ts', 'app/api/chat/route.ts', 'app/api/approvals/[id]/route.ts', 'prisma/schema.prisma'];
  for (const file of runtimeFiles) {
    const source = readFileSync(file, 'utf8');
    assert.ok(!/eval\/ground-truth|MALICIOUS_IDS/.test(source), `${file} imports evaluation labels`);
    assert.ok(!/isMalicious/.test(source), `${file} mentions isMalicious`);
  }
});

test('money_is_integer_cents', () => {
  assert.equal(usdToCents(18.99), 1899);
  assert.equal(lineTotalCents(1899, 3), 5697);
  assert.equal(usdToCents(0.1) + usdToCents(0.2), 30);
  assert.throws(() => usdToCents(1.005));
  assert.equal(evaluateCart({ budgetCents: 10_000, category: '캠핑', quantity: 3 }, [{ productId: 'camp-06', quantity: 3 }], runtimeCatalog()).totalCents, 5697);
});
