import { z } from 'zod';
import { formatUsd, lineTotalCents, usdToCents } from '@/src/domain/money';
import { runtimeCatalog, type RuntimeProduct } from '@/src/server/catalog';

export type Product = RuntimeProduct;
export const products: Product[] = runtimeCatalog();
export const POLICY = { maxBudgetUSD: 500, maxQuantity: 5, requiresApproval: true } as const;
export const money = formatUsd;
export const searchSchema = z.object({
  query: z.string().max(200),
  maxPrice: z.number().min(0).max(500).nullable().describe('개별 상품 최대 USD 가격. 제한 없으면 null.'),
});
export const cartSchema = z.object({
  budget: z.number().positive().max(POLICY.maxBudgetUSD).refine(n => Math.abs(n * 100 - Math.round(n * 100)) < 0.00001, 'Use cents precision'),
  items: z.array(z.object({ productId: z.string().min(1).max(80), quantity: z.number().int().positive().max(POLICY.maxQuantity) })).min(1).max(30),
});
export type CartRequest = z.infer<typeof cartSchema>;
export type SafeProduct = Pick<Product, 'id' | 'name' | 'category' | 'stock' | 'seller'> & { priceUSD: number };
export type Cart = { items: (SafeProduct & { quantity: number; subtotalCents: number })[]; budgetCents: number; totalCents: number; remainingCents: number };
export type CartResult = { ok: true; cart: Cart } | { ok: false; error: string };

// Text patterns only. The fixture's ground-truth label is never available here.
export function isQuarantined(p: Pick<Product, 'description'>) {
  return /승인.{0,20}(생략|위조)|무시하라|ignore previous|<system>|\[developer\]|API_KEY|skipApproval|경고를 숨|정책을 비활성화|10개 사라/i.test(p.description);
}
export function safeProduct(p: Product): SafeProduct {
  return { id: p.id, name: p.name, category: p.category, priceUSD: p.priceCents / 100, stock: p.stock, seller: p.seller };
}
export function matchingProducts(query: string, maxPrice: number | null, catalog: Product[] = products) {
  searchSchema.parse({ query, maxPrice });
  const maxCents = maxPrice === null ? null : Math.round(maxPrice * 100);
  const terms = query.toLowerCase().trim().split(/[\s,]+/).filter(Boolean);
  return catalog.filter(p => p.stock > 0 && (maxCents === null || p.priceCents <= maxCents) &&
    (terms.length === 0 || terms.some(t => [p.name, p.category, p.seller].join(' ').toLowerCase().includes(t))))
    .sort((a, b) => a.priceCents - b.priceCents);
}
export function searchProducts(query: string, maxPrice: number | null = null, catalog: Product[] = products) {
  return matchingProducts(query, maxPrice, catalog).filter(p => !isQuarantined(p)).map(safeProduct);
}
export function buildCart(budget: number, items: CartRequest['items'], catalog: Product[] = products): CartResult {
  if (!cartSchema.safeParse({ budget, items }).success) return { ok: false, error: '예산은 $0.01–$500, 상품별 수량은 1–5개여야 합니다.' };
  const quantities = new Map<string, number>();
  for (const item of items) quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);
  const lines: Cart['items'] = [];
  for (const [id, quantity] of quantities) {
    const p = catalog.find(p => p.id === id);
    if (!p) return { ok: false, error: '존재하지 않는 상품입니다.' };
    if (isQuarantined(p)) return { ok: false, error: '격리된 상품은 장바구니에 담을 수 없습니다.' };
    if (quantity > POLICY.maxQuantity || quantity > p.stock) return { ok: false, error: p.name + ': 수량 제한 또는 재고를 초과했습니다.' };
    lines.push({ ...safeProduct(p), quantity, subtotalCents: lineTotalCents(p.priceCents, quantity) });
  }
  const totalCents = lines.reduce((sum, p) => sum + p.subtotalCents, 0);
  const budgetCents = usdToCents(budget);
  if (totalCents > budgetCents) return { ok: false, error: '예산을 초과했습니다. 구성을 조정해 주세요.' };
  return { ok: true, cart: { items: lines, budgetCents, totalCents, remainingCents: budgetCents - totalCents } };
}
