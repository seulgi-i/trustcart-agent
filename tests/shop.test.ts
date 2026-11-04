import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCart, products, searchProducts } from '../lib/shop';
test('30 USD fixtures include 10 malicious descriptions', () => {
  assert.equal(products.length, 30);
  assert.equal(products.filter(p => p.isMalicious).length, 10);
  assert.ok(products.every(p => p.priceUSD > 0 && p.seller && p.description));
});
test('search hides descriptions and excludes malicious products', () => {
  const found = searchProducts('캠핑', 100);
  assert.ok(found.length > 0);
  assert.ok(found.every(p => !('description' in p) && !p.id.startsWith('risk-')));
});
test('USD uses integer cents', () => {
  const result = buildCart(100, [{productId:'camp-06',quantity:3}]);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.cart.totalCents, 5697);
});
test('duplicate lines cannot bypass quantity policy', () => {
  assert.equal(buildCart(500,[{productId:'camp-06',quantity:3},{productId:'camp-06',quantity:3}]).ok,false);
});
test('malicious products, overspending, missing stock and negative quantities are rejected', () => {
  for (const items of [[{productId:'risk-01',quantity:1}],[{productId:'home-09',quantity:1}],[{productId:'camp-01',quantity:3}],[{productId:'camp-01',quantity:-1}]]) assert.equal(buildCart(100,items).ok,false);
});
