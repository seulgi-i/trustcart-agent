import { SessionStatus } from '../session-status';
import { OrdersList } from './orders-list';

export default function OrdersPage() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-semibold">My orders</h1>
      <p className="mt-1 text-stone-600">Every paid order carries a signed intent mandate: what you asked for, the cart you approved and the policy that allowed it. Open an order to verify it, check the billing against it and request a refund.</p>
      <SessionStatus><OrdersList /></SessionStatus>
    </main>
  );
}
