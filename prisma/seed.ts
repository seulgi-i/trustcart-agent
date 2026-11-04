import { PrismaClient } from '@prisma/client';
import { runtimeCatalog } from '../src/server/catalog';
const db = new PrismaClient();
async function main() {
  const products = runtimeCatalog();
  await db.$transaction([
    db.product.deleteMany({ where: { id: { notIn: products.map(p => p.id) } } }),
    ...products.map(product => db.product.upsert({ where: { id: product.id }, create: product, update: product })),
  ]);
  console.log(`Seeded ${products.length} products.`);
}
main().catch(() => { console.error('Seed failed. Check DATABASE_URL and run db:migrate first.'); process.exitCode = 1; }).finally(() => db.$disconnect());
