import { z } from 'zod';
import { HARD_CAP_CENTS } from '@/src/domain/policy';
import { scanUntrusted, wrapUntrusted } from '@/src/domain/scanner';
import type { RuntimeProduct } from '@/src/server/catalog';

export type Product = RuntimeProduct;
export const searchSchema = z.object({
  query: z.string().max(200),
  maxPrice: z.number().min(0).max(HARD_CAP_CENTS / 100).nullable().describe('개별 상품 최대 USD 가격. 제한 없으면 null.'),
});
// Quantities are only bounded for sanity here; zero, negative and oversized values reach the policy and are DENY there.
export const cartSchema = z.object({
  items: z.array(z.object({ productId: z.string().min(1).max(80), quantity: z.number().int().min(-1000).max(1000) })).min(1).max(30),
});

export function matchingProducts(query: string, maxPrice: number | null, catalog: Product[]) {
  searchSchema.parse({ query, maxPrice });
  const maxCents = maxPrice === null ? null : Math.round(maxPrice * 100);
  const terms = query.toLowerCase().trim().split(/[\s,]+/).filter(Boolean);
  return catalog.filter(p => p.stock > 0 && (maxCents === null || p.priceCents <= maxCents) &&
    (terms.length === 0 || terms.some(t => [p.name, p.category, p.seller].join(' ').toLowerCase().includes(t))))
    .sort((a, b) => a.priceCents - b.priceCents);
}

// What the model sees: server-owned fields as values, seller-written name, seller and description wrapped as inert
// data plus scanner hits.
export function toolProduct(p: Product) {
  return {
    id: p.id, category: p.category, priceUSD: p.priceCents / 100, stock: p.stock,
    name: wrapUntrusted(`product:${p.id}:name`, p.name),
    seller: wrapUntrusted(`product:${p.id}:seller`, p.seller),
    description: wrapUntrusted(`product:${p.id}`, p.description),
    scannerHits: scanUntrusted(`${p.name}\n${p.seller}\n${p.description}`).hits,
  };
}
