import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { LanguageModelV4Prompt } from '@ai-sdk/provider';

// One model step of a turn: the tool calls it made and/or the text it wrote.
export type FixtureStep = { toolCalls?: { toolName: string; input: unknown }[]; text?: string };
export type FixtureMatch = { hint: string; user: string; intent: string };
export type Fixture = { match: FixtureMatch; source: string; steps: FixtureStep[] };
// The current turn as seen in a model call: everything after the last user message belongs to it.
export type TurnState = FixtureMatch & { steps: FixtureStep[]; results: { toolName: string; output: unknown }[] };

export const FIXTURE_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'ai');

const normalize = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

// Stable replay key: (system hint, last user message, intent summary). The provider note and the rest of the system
// prompt are left out so editing the instructions does not orphan every fixture.
export function fixtureKey(m: FixtureMatch) {
  return createHash('sha256').update(JSON.stringify([normalize(m.hint), normalize(m.user), normalize(m.intent)])).digest('hex').slice(0, 16);
}

// "budget 50 USD, category Camping, quantity 2" -> "Camping|2|50"; no saved intent -> "none".
export function intentSummary(system: string) {
  const m = /Current purchase intent \(read-only\): budget ([\d.]+) USD, category ([^,]+), quantity (-?\d+)\./.exec(system);
  return m ? `${m[2].trim()}|${m[3]}|${m[1]}` : 'none';
}

export function readTurn(prompt: LanguageModelV4Prompt): TurnState {
  const system = prompt.flatMap(m => (m.role === 'system' ? [m.content] : [])).join('\n');
  const last = prompt.map(m => m.role).lastIndexOf('user');
  const userMsg = last >= 0 ? prompt[last] : undefined;
  const user = userMsg?.role === 'user' ? userMsg.content.flatMap(p => (p.type === 'text' ? [p.text] : [])).join('\n') : '';
  const steps: FixtureStep[] = [];
  const results: TurnState['results'] = [];
  for (const m of prompt.slice(last + 1)) {
    if (m.role !== 'assistant' && m.role !== 'tool') continue;
    if (m.role === 'assistant') {
      const step: FixtureStep = {};
      const calls = m.content.flatMap(p => (p.type === 'tool-call' ? [{ toolName: p.toolName, input: p.input }] : []));
      const text = m.content.flatMap(p => (p.type === 'text' ? [p.text] : [])).join('');
      if (calls.length) step.toolCalls = calls;
      if (text) step.text = text;
      steps.push(step);
    }
    for (const p of m.content) {
      if (p.type !== 'tool-result') continue;
      const o = p.output;
      results.push({ toolName: p.toolName, output: o.type === 'json' || o.type === 'error-json' ? o.value : 'value' in o ? o.value : null });
    }
  }
  return { hint: system.split(/(?<=\.)\s/)[0] ?? '', user, intent: intentSummary(system), steps, results };
}

// Replay fixtures, indexed by the key of their match fields (file names are informational only).
export function loadFixtures(dir = FIXTURE_DIR) {
  const byKey = new Map<string, Fixture>();
  let files: string[];
  try { files = readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { return byKey; }
  for (const f of files) {
    try {
      const fx = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as Fixture;
      if (fx?.match && Array.isArray(fx.steps)) byKey.set(fixtureKey(fx.match), fx);
    } catch (e) {
      console.warn(`[ai] skipping unreadable fixture ${f}:`, (e as Error).message);
    }
  }
  return byKey;
}

export function findFixture(turn: FixtureMatch, dir = FIXTURE_DIR) {
  return loadFixtures(dir).get(fixtureKey(turn));
}

// Called after every recorded step; the last write of a turn holds its full tool-call sequence.
export function saveFixture(turn: TurnState, step: FixtureStep, source: string, dir = FIXTURE_DIR) {
  const fixture: Fixture = { match: { hint: turn.hint, user: turn.user, intent: turn.intent }, source, steps: [...turn.steps, step] };
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${fixtureKey(fixture.match)}.json`);
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
  return file;
}
