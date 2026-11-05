import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { wrapLanguageModel, type LanguageModel } from 'ai';
import { createMockModel } from './mock-model';
import { recordingMiddleware } from './record';

export type AiProviderKind = 'mock' | 'ollama' | 'gemini' | 'openai' | 'anthropic';
export type ResolvedProvider = { ok: true; kind: AiProviderKind; modelId: string } | { ok: false; error: string };

const EXPLICIT = ['mock', 'ollama', 'gemini'] as const;
const GOOGLE_DEFAULT = 'gemini-3.5-flash';
export const OLLAMA_DEFAULT_URL = 'http://localhost:11434/v1';
const OLLAMA_DEFAULT_MODEL = 'qwen2.5:7b';

const val = (env: NodeJS.ProcessEnv, key: string) => env[key]?.trim() || undefined;
// Vercel sets VERCEL=1 and VERCEL_ENV; a production build anywhere else counts as deployed too.
export const isDeployed = (env: NodeJS.ProcessEnv) => env.VERCEL === '1' || !!val(env, 'VERCEL_ENV') || env.NODE_ENV === 'production';

// Which model /api/chat uses. An explicit AI_PROVIDER always wins, so a stray OPENAI_API_KEY cannot take over a
// mock/ollama/gemini setup. Unset: deployed -> gemini; local -> the old key precedence (OpenAI, Anthropic, Google).
export function resolveProvider(env: NodeJS.ProcessEnv = process.env): ResolvedProvider {
  const explicit = val(env, 'AI_PROVIDER')?.toLowerCase();
  const google = (): ResolvedProvider => val(env, 'GOOGLE_GENERATIVE_AI_API_KEY')
    ? { ok: true, kind: 'gemini', modelId: val(env, 'GOOGLE_MODEL') ?? GOOGLE_DEFAULT }
    : { ok: false, error: 'Set GOOGLE_GENERATIVE_AI_API_KEY in the environment and restart the server.' };
  if (explicit) {
    if (!(EXPLICIT as readonly string[]).includes(explicit)) return { ok: false, error: `Unknown AI_PROVIDER "${explicit}". Use mock, ollama or gemini.` };
    if (explicit === 'mock') return { ok: true, kind: 'mock', modelId: 'scripted' };
    if (explicit === 'ollama') return { ok: true, kind: 'ollama', modelId: val(env, 'OLLAMA_MODEL') ?? OLLAMA_DEFAULT_MODEL };
    return google();
  }
  if (isDeployed(env)) return google();
  if (val(env, 'OPENAI_API_KEY')) return { ok: true, kind: 'openai', modelId: val(env, 'OPENAI_MODEL') ?? 'gpt-4.1-mini' };
  if (val(env, 'ANTHROPIC_API_KEY')) return { ok: true, kind: 'anthropic', modelId: val(env, 'ANTHROPIC_MODEL') ?? 'claude-sonnet-4-5' };
  if (val(env, 'GOOGLE_GENERATIVE_AI_API_KEY')) return google();
  return { ok: false, error: 'Set AI_PROVIDER (mock, ollama or gemini) or one of OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY in .env and restart the server.' };
}

// Builds the model for a resolved provider. With AI_RECORD=1, real ollama/gemini runs are saved as replay fixtures
// for the mock provider (never on a deployment).
export function chatModel(resolved: Extract<ResolvedProvider, { ok: true }>, env: NodeJS.ProcessEnv = process.env): LanguageModel {
  const { kind, modelId } = resolved;
  if (kind === 'mock') return createMockModel();
  // Ollama's OpenAI-compatible API is Chat Completions; the provider's default call would use the Responses API.
  const model = kind === 'ollama' ? createOpenAI({ apiKey: 'ollama', baseURL: val(env, 'OLLAMA_BASE_URL') ?? OLLAMA_DEFAULT_URL }).chat(modelId)
    : kind === 'gemini' ? createGoogleGenerativeAI({ apiKey: val(env, 'GOOGLE_GENERATIVE_AI_API_KEY') })(modelId)
    : kind === 'openai' ? createOpenAI({ apiKey: val(env, 'OPENAI_API_KEY') })(modelId)
    : createAnthropic({ apiKey: val(env, 'ANTHROPIC_API_KEY') })(modelId);
  if (env.AI_RECORD === '1' && (kind === 'ollama' || kind === 'gemini') && !isDeployed(env)) {
    return wrapLanguageModel({ model, middleware: recordingMiddleware(`${kind}:${modelId}`) });
  }
  return model;
}
