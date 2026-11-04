import { db } from '@/lib/db';
import { buildCart, type Cart } from '@/lib/shop';
import { checkOrigin } from '@/lib/http';
import { findSession, ownedBy } from '@/src/server/session';
import { z } from 'zod';
export const runtime = 'nodejs';
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!checkOrigin(request)) return Response.json({ error: '허용되지 않은 출처입니다.' }, { status: 403 });
  let status: 'APPROVED' | 'REJECTED';
  try { status = z.object({ status: z.enum(['APPROVED', 'REJECTED']) }).parse(await request.json()).status; }
  catch { return Response.json({ error: '올바른 승인 상태가 필요합니다.' }, { status: 400 }); }
  const { id } = await params;
  try {
    const session = await findSession(db, request);
    if (!session) return Response.json({ error: 'Demo session required.' }, { status: 401 });
    const result = await db.$transaction(async tx => {
      const row = await tx.approval.findFirst({ where: ownedBy(session.id, id) });
      if (!row) return { status: 404, body: { error: '존재하지 않는 요청입니다.' } };
      if (row.status !== 'PENDING') return { status: 409, body: { error: '이미 처리된 요청입니다.' } };
      if (status === 'APPROVED') {
        const cart = JSON.parse(row.cartJson) as Cart;
        const checked = buildCart(cart.budgetCents / 100, cart.items.map(p => ({ productId: p.id, quantity: p.quantity })), await tx.product.findMany());
        if (!checked.ok || JSON.stringify(checked.cart) !== row.cartJson) return { status: 409, body: { error: '상품 정보 또는 정책이 변경되었습니다. 새 장바구니를 요청해 주세요.' } };
      }
      const changed = await tx.approval.updateMany({ where: { ...ownedBy(session.id, id), status: 'PENDING' }, data: { status } });
      if (!changed.count) return { status: 409, body: { error: '이미 처리된 요청입니다.' } };
      await tx.auditLog.create({ data: { sessionId: session.id, action: 'humanReview', outcome: status, detail: id } });
      return { status: 200, body: { ok: true } };
    });
    return Response.json(result.body, { status: result.status });
  } catch { return Response.json({ error: '처리에 실패했습니다. 다시 시도해 주세요.' }, { status: 500 }); }
}
