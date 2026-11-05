import { SessionStatus } from '../session-status';
import { Inbox } from './inbox';

export default function ApprovalsPage() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Review inbox</h1>
      <p className="mt-1 text-stone-600">Approving sends you to the payment page; you are charged only after you approve there and return. Rejecting captures nothing. Denied carts cannot be approved.</p>
      <SessionStatus><Inbox /></SessionStatus>
    </main>
  );
}
