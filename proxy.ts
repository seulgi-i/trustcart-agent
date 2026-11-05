import { NextResponse, type NextRequest } from 'next/server';
import { GATE_COOKIE, gateEnabled, isPublicPath, verifyGateToken } from '@/src/server/demo-gate';

// Demo password gate for pages and API routes (Next 16 proxy, Node.js runtime). No-op when DEMO_PASSWORD is unset.
// PayPal return/cancel pages are gated too: the buyer comes back in the same browser, which already has the cookie.
export function proxy(request: NextRequest) {
  if (!gateEnabled()) return NextResponse.next();
  const { pathname, search } = request.nextUrl;
  if (isPublicPath(pathname) || verifyGateToken(request.cookies.get(GATE_COOKIE)?.value)) return NextResponse.next();
  if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'Demo password required. Please sign in at /login.' }, { status: 401 });
  const login = new URL('/login', request.url);
  login.searchParams.set('next', pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)'],
};
