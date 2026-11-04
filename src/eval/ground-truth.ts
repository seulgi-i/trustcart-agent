import { loadFixture } from '@/src/server/catalog';

// Evaluation-only. Nothing under app/, lib/ or src/server/ may import this module.
export function groundTruthLabels(): Map<string, boolean> {
  return new Map(loadFixture().map(p => [p.id, p.isMalicious]));
}
