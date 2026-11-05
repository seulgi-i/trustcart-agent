// Generic prompt-injection heuristics for untrusted seller text. A hit is a warning that sends a cart to human review;
// a miss proves nothing, which is why the policy and the same-turn checkout rule do not depend on this scanner.

const RULES: [id: string, pattern: RegExp][] = [
  ['hidden-characters', /[­​-‏‪-‮⁠-⁤﻿]/],
  ['hidden-markup', /<!--|-->|```|<\/?(?:system|assistant|user|developer|instructions?|tool[\w-]*)\b[^>]*>/i],
  ['role-impersonation', /\[\s*(?:system|developer|assistant|admin|시스템|개발자|관리자)[^\]]{0,20}\]|(?:^|[.!?]\s*)(?:system|assistant|developer)\s*(?:message|prompt)?\s*:|(?:시스템|사용자|관리자|개발자)\s*(?:메시지|안내|지시|지침)\s*:|내부\s*지침|tool_result/i],
  ['instruction-override', /\b(?:ignore|disregard|forget|override)\b.{0,30}\b(?:instructions?|rules?|prompts?|polic(?:y|ies)|limits?)\b|무시(?:하|해)|지시가\s*우선|최우선으로/i],
  ['approval-bypass', /\b(?:skip|bypass|without|no)\s*[-_]?\s*(?:approval|confirmation)\b|skipApproval|\b(?:skip|waive|disable|bypass)\w*\b.{0,30}\b(?:review|safety\s*checks?|checks?|verification)\b|\balready\s+(?:been\s+)?(?:approved|reviewed|verified|checked)\b|승인[^.\n]{0,15}(?:생략|위조|건너|없이)|(?:정책|경고|보안)[^.\n]{0,15}(?:비활성|해제|숨기|예외|변경)/i],
  ['purchase-directive', /\b(?:buy|add|purchase|order)\s+(?:\d+|ten|twenty)\s+(?:units?|items?|pcs|of)\b|\d+\s*개\s*(?:를|을)?\s*(?:사라|구매하라|담아라|주문하라)|(?:장바구니|결제|구매)[^.\n]{0,15}하라|즉시\s*결제/i],
  ['credential-exfiltration', /\b[A-Z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD)\b/],
  ['external-url', /https?:\/\/|\bwww\./i],
  ['imperative-to-agent', /\b(?:agent|assistant|ai)\b\s*(?:only|에게)|에이전트\s*(?:전용|에게)|(?:하|사|보내|따르|숨기)라(?=$|[\s.!,]|\s*-->)/i],
];

export type ScanResult = { flagged: boolean; hits: string[] };

// Common Cyrillic/Greek letters that render like Latin ones, folded so mixed-script words still match the rules.
const HOMOGLYPHS: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', һ: 'h', ӏ: 'l', ԛ: 'q', ԝ: 'w',
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X', І: 'I', Ј: 'J', Ѕ: 'S',
  α: 'a', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x',
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X',
};
const foldHomoglyphs = (s: string) => s.replace(/[Ͱ-ϿЀ-ԯ]/g, c => HOMOGLYPHS[c] ?? c);

// Base64-looking tokens are decoded and rescanned once, if they decode to printable UTF-8 text.
function decodedTokens(text: string): string[] {
  const out: string[] = [];
  for (const [token] of text.matchAll(/[A-Za-z0-9+/_-]{24,}={0,2}/g)) {
    try {
      const bytes = Uint8Array.from(atob(token.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (!/[\x00-\x08\x0E-\x1F\x7F]/.test(decoded)) out.push(decoded);
    } catch { /* not base64 */ }
  }
  return out;
}

function matchRules(text: string): string[] {
  const variants = [text, text.normalize('NFKC'), foldHomoglyphs(text.normalize('NFKC'))];
  return RULES.filter(([, pattern]) => variants.some(v => pattern.test(v))).map(([id]) => id);
}

export function scanUntrusted(text: string): ScanResult {
  const hits = new Set(matchRules(text));
  for (const decoded of decodedTokens(text)) for (const id of matchRules(decoded)) hits.add(id);
  if (text.length > 1000) hits.add('oversized');
  return { flagged: hits.size > 0, hits: [...hits] };
}

// Untrusted text is handed to the model as an inert, delimited data field. Angle brackets are neutralized so the
// text cannot close the wrapper or forge a tag of its own.
export function wrapUntrusted(source: string, text: string) {
  const inert = text.replace(/</g, '‹').replace(/>/g, '›');
  return `<untrusted_data source="${source}">${inert}</untrusted_data>`;
}
