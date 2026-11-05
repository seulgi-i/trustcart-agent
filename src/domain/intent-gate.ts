// Deterministic, server-side category check for search text. Small models sometimes keep searching for a request
// that was already blocked (e.g. "laundry detergent" under a Camping intent after an INTENT_MISMATCH), so the server
// classifies the query and the latest user message itself instead of trusting requestedCategory alone.
// The vocabulary is built from catalog product names plus the category names: a term counts only when it belongs to
// exactly one category, so shared words ("stainless", "soft") never decide anything.

type Named = { name: string; category: string };

// Words that appear in product names but say nothing about what the user wants.
const STOP = new Set(['pack', 'set', 'size', 'value', 'easy', 'everyday', 'one', 'all', 'the', 'and', 'for', 'buy', 'under', 'please', 'want', 'need', 'some', 'get', 'with']);

const stem = (w: string) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
export function searchTerms(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 3).map(stem).filter(w => !STOP.has(w)))];
}

export function categoryVocabulary(catalog: Named[]): Map<string, string> {
  const seen = new Map<string, Set<string>>();
  const add = (term: string, category: string) => { if (!seen.has(term)) seen.set(term, new Set()); seen.get(term)!.add(category); };
  for (const p of catalog) {
    for (const t of searchTerms(p.name)) add(t, p.category);
    for (const t of searchTerms(p.category)) add(t, p.category);
  }
  const vocab = new Map<string, string>();
  for (const [t, cats] of seen) if (cats.size === 1) vocab.set(t, [...cats][0]);
  // "camp"/"camping" both name the category.
  for (const p of catalog) for (const t of searchTerms(p.category)) if (t.endsWith('ing') && !vocab.has(t.slice(0, -3))) vocab.set(t.slice(0, -3), p.category);
  return vocab;
}

// Categories the text clearly refers to, with the terms that put it there.
export function classifyText(text: string, vocab: Map<string, string>) {
  const byCategory = new Map<string, string[]>();
  for (const t of searchTerms(text)) {
    const c = vocab.get(t);
    if (c) byCategory.set(c, [...(byCategory.get(c) ?? []), t]);
  }
  return byCategory;
}

export type SearchGate =
  | { ok: true; query: string; rewritten: boolean }
  | { ok: false; categories: string[]; source: 'query' | 'user' };

// Decide what to search for. Order:
// 1. If the latest user message names only other categories, it is off-intent (the model cannot rescue it).
// 2. If the model's query shares no terms with the latest user message but that message names in-category items,
//    the model is carrying a stale request: search the user's in-category terms instead.
// 3. If the (possibly rewritten) query names only other categories, it is off-intent.
export function gateSearch(intentCategory: string, query: string, latestUserText: string | undefined, catalog: Named[]): SearchGate {
  const vocab = categoryVocabulary(catalog);
  const offOnly = (m: Map<string, string[]>) => {
    const cats = [...m.keys()];
    return cats.length > 0 && !cats.includes(intentCategory) ? cats : null;
  };
  let effective = query;
  let rewritten = false;
  if (latestUserText) {
    const user = classifyText(latestUserText, vocab);
    const userOff = offOnly(user);
    if (userOff) return { ok: false, categories: userOff, source: 'user' };
    const userTerms = new Set(searchTerms(latestUserText));
    const queryTerms = searchTerms(query);
    const categoryWords = new Set(searchTerms(intentCategory).flatMap(w => (w.endsWith('ing') ? [w, w.slice(0, -3)] : [w])));
    const inCategory = (user.get(intentCategory) ?? []).filter(t => !categoryWords.has(t));
    if (queryTerms.length > 0 && !queryTerms.some(t => userTerms.has(t)) && inCategory.length > 0) {
      effective = inCategory.join(' ');
      rewritten = true;
    }
  }
  const queryOff = offOnly(classifyText(effective, vocab));
  if (queryOff) return { ok: false, categories: queryOff, source: 'query' };
  return { ok: true, query: effective, rewritten };
}
