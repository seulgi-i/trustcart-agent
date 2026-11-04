import { db } from '@/lib/db';
import { formatUsd } from '@/src/domain/money';
import { SessionStatus } from './session-status';

export const dynamic = 'force-dynamic';

export default async function Home() {
  // Seller-written descriptions are untrusted text and are not rendered here.
  const products = await db.product.findMany({ orderBy: { id: 'asc' }, select: { id: true, name: true, category: true, seller: true, priceCents: true, stock: true } }).catch(() => null);
  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-semibold">TrustCart Agent</h1>
      <p className="mt-1 text-stone-600">AI chooses. Your rules authorize.</p>
      <SessionStatus />
      <h2 className="mt-8 text-lg font-medium">Catalog</h2>
      {products === null ? (
        <p className="mt-2 text-red-700">The database is not ready. Run <code>npm run db:setup</code> and restart.</p>
      ) : (
        <table className="mt-2 w-full text-left text-sm">
          <thead><tr className="border-b text-stone-500"><th className="py-2">Product</th><th>Category</th><th>Seller</th><th className="text-right">Price</th><th className="text-right">Stock</th></tr></thead>
          <tbody>
            {products.map(p => (
              <tr key={p.id} className="border-b border-stone-200">
                <td className="py-2">{p.name}</td><td>{p.category}</td><td>{p.seller}</td>
                <td className="text-right">{formatUsd(p.priceCents)}</td><td className="text-right">{p.stock}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
