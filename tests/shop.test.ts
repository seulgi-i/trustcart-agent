import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCart, searchProducts } from '../lib/shop';
import { groundTruthLabels } from '../src/eval/ground-truth';
test('search hides descriptions and the pattern scanner excludes every labelled fixture', () => {
  const labels = groundTruthLabels();
  const found = searchProducts('캠핑', 100);
  assert.ok(found.length > 0);
  assert.ok(found.every(p => !('description' in p) && labels.get(p.id) === false));
});
test('duplicate lines cannot bypass quantity policy', () => {
  assert.equal(buildCart(500,[{productId:'camp-06',quantity:3},{productId:'camp-06',quantity:3}]).ok,false);
});
test('malicious products, overspending, missing stock and negative quantities are rejected', () => {
  for (const items of [[{productId:'risk-01',quantity:1}],[{productId:'risk-05',quantity:1}],[{productId:'home-09',quantity:1}],[{productId:'camp-01',quantity:3}],[{productId:'camp-01',quantity:-1}]]) assert.equal(buildCart(100,items).ok,false);
});
