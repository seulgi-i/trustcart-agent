import { z } from 'zod';
import fixture from '@/data/products.json';
import { isUsdAmount, usdToCents } from '@/src/domain/money';

// data/products.json holds catalog data only. Evaluation labels live in src/eval and never reach runtime code.

const fixtureProductSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  name: z.string().min(1).max(120),
  category: z.string().min(1).max(40),
  priceUSD: z.number().positive().refine(isUsdAmount, 'USD price must have at most 2 decimal places'),
  stock: z.number().int().min(0),
  seller: z.string().min(1).max(80),
  description: z.string().min(1).max(2000),
});

export const fixtureSchema = z.array(fixtureProductSchema).refine(
  rows => new Set(rows.map(p => p.id)).size === rows.length,
  'Product IDs must be unique',
);

export type FixtureProduct = z.infer<typeof fixtureProductSchema>;
export type RuntimeProduct = { id: string; name: string; category: string; priceCents: number; stock: number; seller: string; description: string };

export function loadFixture(): FixtureProduct[] {
  return fixtureSchema.parse(fixture);
}

export function toRuntimeProduct({ priceUSD, ...product }: FixtureProduct): RuntimeProduct {
  return { ...product, priceCents: usdToCents(priceUSD) };
}

export function runtimeCatalog(): RuntimeProduct[] {
  return loadFixture().map(toRuntimeProduct);
}
