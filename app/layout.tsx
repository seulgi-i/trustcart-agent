import type { Metadata } from 'next';
import { Header } from '@/components/header';
import './globals.css';
export const metadata: Metadata = { title: 'TrustCart — 신뢰를 담는 AI 쇼핑', description: '상품을 찾고, 정책으로 검증하고, 직접 승인하는 AI 쇼핑 에이전트.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body><Header />{children}<footer className="site-footer"><span>TrustCart Agent</span><span>로컬 데모 / USD / 실제 결제 없음</span></footer></body></html>;
}
