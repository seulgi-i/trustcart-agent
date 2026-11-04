import { PrismaClient } from '@prisma/client';
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
export const db = globalForPrisma.prisma ?? new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL || 'file:./dev.db' } } });
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;
export async function catalog() {
  return (await db.product.findMany()).map(({ priceCents, ...p }) => ({ ...p, priceUSD: priceCents / 100 }));
}
export async function audit(action: string, outcome: string, detail: string) {
  await db.auditLog.create({ data: { action, outcome, detail } });
}
