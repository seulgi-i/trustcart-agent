import { safeNextPath } from '@/src/server/demo-gate';
import { LoginForm } from './login-form';

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { next } = await searchParams;
  return (
    <main className="mx-auto max-w-sm px-4 py-12">
      <h1 className="text-2xl font-semibold">TrustCart Agent</h1>
      <p className="mt-1 text-sm text-stone-600">This demo is password protected.</p>
      <LoginForm next={safeNextPath(typeof next === 'string' ? next : null)} />
    </main>
  );
}
