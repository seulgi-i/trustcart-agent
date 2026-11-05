import { SessionStatus } from '../session-status';
import { PolicyForm } from './policy-form';

export default function PolicyPage() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Spending policy</h1>
      <p className="mt-1 text-stone-600">Two layers check every cart the agent proposes: fixed system limits (Layer 1) and your own settings inside them (Layer 2). Only you can change Layer 2 here; the agent can read the outcome but has no way to edit this policy.</p>
      <SessionStatus><PolicyForm /></SessionStatus>
    </main>
  );
}
