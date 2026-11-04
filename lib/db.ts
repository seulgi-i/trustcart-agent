import { PrismaClient } from '@prisma/client';
import type { RuntimeProduct } from '@/src/server/catalog';
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
export const db = globalForPrisma.prisma ?? new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL || 'file:./dev.db' } } });
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;
export async function catalog(): Promise<RuntimeProduct[]> {
  return db.product.findMany();
}
export async function audit(action: string, outcome: string, detail: string, sessionId?: string) {
  await db.auditLog.create({ data: { action, outcome, detail, sessionId } });
}
