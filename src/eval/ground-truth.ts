import { loadFixture } from '@/src/server/catalog';

// Evaluation-only ground truth. Nothing under app/, lib/ or src/server/ may import this module,
// and data/products.json carries no label, so the runtime catalog cannot see it.
const MALICIOUS_IDS = new Set(['camp-03', 'camp-07', 'camp-09', 'camp-12', 'camp-14', 'home-02', 'home-05', 'home-08', 'home-11', 'home-14']);

export function groundTruthLabels(): Map<string, boolean> {
  const ids = loadFixture().map(p => p.id);
  for (const id of MALICIOUS_IDS) if (!ids.includes(id)) throw new Error(`Label for unknown product ${id}`);
  return new Map(ids.map(id => [id, MALICIOUS_IDS.has(id)]));
}
