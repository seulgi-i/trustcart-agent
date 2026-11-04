import { db } from '@/lib/db';
import { buildCart, type Cart } from '@/lib/shop';
import { checkOrigin } from '@/lib/http';
import { z } from 'zod';
export const runtime = 'nodejs';
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!checkOrigin(request)) return Response.json({ error: '허용되지 않은 출처입니다.' }, { status: 403 });
  let status: 'APPROVED' | 'REJECTED';
  try { status = z.object({ status: z.enum(['APPROVED', 'REJECTED']) }).parse(await request.json()).status; }
  catch { return Response.json({ error: '올바른 승인 상태가 필요합니다.' }, { status: 400 }); }
  const { id } = await params;
  try {
    const result = await db.$transaction(async tx => {
      const row = await tx.approval.findUnique({ where: { id } });
      if (!row || row.status !== 'PENDING') return { error: '이미 처리되었거나 존재하지 않는 요청입니다.' };
      if (status === 'APPROVED') {
        const cart = JSON.parse(row.cartJson) as Cart;
        const products = (await tx.product.findMany()).map(({ priceCents, ...p }) => ({ ...p, priceUSD: priceCents / 100 }));
        const checked = buildCart(cart.budgetCents / 100, cart.items.map(p => ({ productId: p.id, quantity: p.quantity })), products);
        if (!checked.ok || JSON.stringify(checked.cart) !== row.cartJson) return { error: '상품 정보 또는 정책이 변경되었습니다. 새 장바구니를 요청해 주세요.' };
      }
      const changed = await tx.approval.updateMany({ where: { id, status: 'PENDING' }, data: { status } });
      if (!changed.count) return { error: '이미 처리된 요청입니다.' };
      await tx.auditLog.create({ data: { action: 'humanReview', outcome: status, detail: id } });
      return { ok: true };
    });
    return Response.json(result, { status: 'error' in result ? 409 : 200 });
  } catch { return Response.json({ error: '처리에 실패했습니다. 다시 시도해 주세요.' }, { status: 500 }); }
}
