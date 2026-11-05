import { CheckoutStep } from '../checkout-step';

export default async function CheckoutCancelPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { orderId } = await searchParams;
  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Payment cancelled</h1>
      <CheckoutStep orderId={typeof orderId === 'string' ? orderId : null} />
    </main>
  );
}
