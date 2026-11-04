import { db, catalog } from '@/lib/db';
import { buildCart, cartSchema } from '@/lib/shop';
import { checkOrigin } from '@/lib/http';
import { findSession } from '@/src/server/session';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  if (!checkOrigin(request)) return Response.json({ error: '허용되지 않은 출처입니다.' }, { status: 403 });
  try {
    const session = await findSession(db, request);
    if (!session) return Response.json({ error: 'Demo session required.' }, { status: 401 });
    const parsed = cartSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: '장바구니 입력을 확인해 주세요.' }, { status: 400 });
    const result = buildCart(parsed.data.budget, parsed.data.items, await catalog());
    if (!result.ok) {
      await db.auditLog.create({ data: { sessionId: session.id, action: 'requestApproval', outcome: 'BLOCKED', detail: result.error } });
      return Response.json(result, { status: 400 });
    }
    const approval = await db.$transaction(async tx => {
      const row = await tx.approval.create({ data: { sessionId: session.id, cartJson: JSON.stringify(result.cart), totalCents: result.cart.totalCents } });
      await tx.auditLog.create({ data: { sessionId: session.id, action: 'requestApproval', outcome: 'PENDING', detail: row.id } });
      return row;
    });
    return Response.json({ id: approval.id }, { status: 201 });
  } catch {
    return Response.json({ error: '승인 요청을 저장하지 못했습니다. DB 설정을 확인해 주세요.' }, { status: 500 });
  }
}
