// Generic prompt-injection heuristics for untrusted seller text. A hit is a warning that sends a cart to human review;
// a miss proves nothing, which is why the policy and the same-turn checkout rule do not depend on this scanner.

const RULES: [id: string, pattern: RegExp][] = [
  ['hidden-characters', /[­​-‏‪-‮⁠-⁤﻿]/],
  ['hidden-markup', /<!--|-->|```|<\/?(?:system|assistant|user|developer|instructions?|tool[\w-]*)\b[^>]*>/i],
  ['role-impersonation', /\[\s*(?:system|developer|assistant|admin|시스템|개발자|관리자)[^\]]{0,20}\]|(?:^|[.!?]\s*)(?:system|assistant|developer)\s*(?:message|prompt)?\s*:|(?:시스템|사용자|관리자|개발자)\s*(?:메시지|안내|지시|지침)\s*:|내부\s*지침|tool_result/i],
  ['instruction-override', /\b(?:ignore|disregard|forget|override)\b.{0,30}\b(?:instructions?|rules?|prompts?|polic(?:y|ies)|limits?)\b|무시(?:하|해)|지시가\s*우선|최우선으로/i],
  ['approval-bypass', /\b(?:skip|bypass|without|no)\s*[-_]?\s*(?:approval|confirmation)\b|skipApproval|승인[^.\n]{0,15}(?:생략|위조|건너|없이)|(?:정책|경고|보안)[^.\n]{0,15}(?:비활성|해제|숨기|예외|변경)/i],
  ['purchase-directive', /\b(?:buy|add|purchase|order)\s+(?:\d+|ten|twenty)\s+(?:units?|items?|pcs|of)\b|\d+\s*개\s*(?:를|을)?\s*(?:사라|구매하라|담아라|주문하라)|(?:장바구니|결제|구매)[^.\n]{0,15}하라|즉시\s*결제/i],
  ['credential-exfiltration', /\b[A-Z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD)\b/],
  ['external-url', /https?:\/\/|\bwww\./i],
  ['imperative-to-agent', /\b(?:agent|assistant|ai)\b\s*(?:only|에게)|에이전트\s*(?:전용|에게)|(?:하|사|보내|따르|숨기)라(?=$|[\s.!,]|\s*-->)/i],
];

export type ScanResult = { flagged: boolean; hits: string[] };

export function scanUntrusted(text: string): ScanResult {
  const normalized = text.normalize('NFKC');
  const hits = RULES.filter(([, pattern]) => pattern.test(text) || pattern.test(normalized)).map(([id]) => id);
  if (text.length > 1000) hits.push('oversized');
  return { flagged: hits.length > 0, hits };
}

// Untrusted text is handed to the model as an inert, delimited data field. Angle brackets are neutralized so the
// text cannot close the wrapper or forge a tag of its own.
export function wrapUntrusted(source: string, text: string) {
  const inert = text.replace(/</g, '‹').replace(/>/g, '›');
  return `<untrusted_data source="${source}">${inert}</untrusted_data>`;
}
