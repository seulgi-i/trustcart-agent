import { PrismaClient } from '@prisma/client';
import products from '../data/products.json';
const db = new PrismaClient();
async function main() {
  await db.$transaction(products.map(({ priceUSD, ...product }) => {
    const data = { ...product, priceCents: Math.round(priceUSD * 100) };
    return db.product.upsert({ where: { id: product.id }, create: data, update: data });
  }));
  console.log(`Seeded ${products.length} products (${products.filter(p => p.isMalicious).length} malicious fixtures).`);
}
main().catch(() => { console.error('Seed failed. Check DATABASE_URL and run db:push first.'); process.exitCode = 1; }).finally(() => db.$disconnect());
