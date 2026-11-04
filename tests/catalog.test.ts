import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFixture, runtimeCatalog } from '../src/server/catalog';
import { groundTruthLabels } from '../src/eval/ground-truth';
import { lineTotalCents, usdToCents } from '../src/domain/money';
import { buildCart, products, searchProducts, safeProduct } from '../lib/shop';

test('catalog_schema_and_labels', () => {
  const fixture = loadFixture();
  assert.equal(fixture.length, 30);
  assert.equal(new Set(fixture.map(p => p.id)).size, 30);
  assert.equal([...groundTruthLabels().values()].filter(Boolean).length, 10);
  for (const p of fixture) {
    assert.ok(Number.isInteger(p.stock) && p.stock >= 0, p.id);
    assert.equal(usdToCents(p.priceUSD) / 100, p.priceUSD, p.id);
  }
});

test('runtime_catalog_hides_ground_truth', () => {
  for (const p of runtimeCatalog()) assert.ok(!('isMalicious' in p), p.id);
  for (const p of products) assert.ok(!('isMalicious' in p) && !('isMalicious' in safeProduct(p)), p.id);
  for (const p of searchProducts('')) assert.ok(!('isMalicious' in p) && !('description' in p), p.id);
  // Runtime modules must not reach the evaluation labels.
  for (const file of ['lib/shop.ts', 'lib/agent.ts', 'lib/db.ts', 'src/server/catalog.ts', 'src/server/session.ts', 'src/server/payments/paypal.ts', 'prisma/schema.prisma']) {
    const source = readFileSync(file, 'utf8');
    assert.ok(!/eval\/ground-truth/.test(source), `${file} imports evaluation labels`);
    assert.ok(!/\.isMalicious\b|isMalicious\s+Boolean/.test(source), `${file} reads isMalicious`);
  }
});

test('money_is_integer_cents', () => {
  assert.equal(usdToCents(18.99), 1899);
  assert.equal(lineTotalCents(1899, 3), 5697);
  assert.equal(usdToCents(0.1) + usdToCents(0.2), 30);
  assert.throws(() => usdToCents(1.005));
  const result = buildCart(100, [{ productId: 'camp-06', quantity: 3 }]);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.cart.totalCents, 5697);
});
