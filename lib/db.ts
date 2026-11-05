import { PrismaClient } from '@prisma/client';
import type { RuntimeProduct } from '@/src/server/catalog';
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
// Connects lazily on the first query, so importing this (e.g. during `next build`) needs no live database.
export const db = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;
export async function catalog(): Promise<RuntimeProduct[]> {
  return db.product.findMany();
}
export async function audit(action: string, outcome: string, detail: string, sessionId?: string) {
  await db.auditLog.create({ data: { action, outcome, detail, sessionId } });
}
