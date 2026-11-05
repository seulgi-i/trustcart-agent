export const AI_RESTING = 'AI is taking a short break... Free-tier quota reached — try again later. Approvals and payments still work without AI.';

// Maps a provider error to a chat-safe message. API keys are never echoed; quota errors are not retried.
export function friendlyAiError(error: unknown) {
  const m = String((error as { message?: string })?.message ?? error);
  if (/quota|429|RESOURCE_EXHAUSTED|rate.?limit|too many requests/i.test(m)) return AI_RESTING;
  if (/high demand|UNAVAILABLE|overloaded|503/i.test(m)) return 'The AI model is busy right now (503). Try again shortly or switch GOOGLE_MODEL.';
  if (/not found|no longer available|404/i.test(m)) return 'The AI model was not found (404). Check the GOOGLE_MODEL or OLLAMA_MODEL setting.';
  if (/ECONNREFUSED|fetch failed|Cannot connect/i.test(m)) return 'Could not reach the AI server. With AI_PROVIDER=ollama, start Ollama and check OLLAMA_BASE_URL.';
  return 'The AI response failed. Check the API key, model, usage limits and database setup.';
}

export const redactKeys = (message: string) => message.replace(/AIza[\w-]+/g, 'AIza***').replace(/sk-[\w-]+/g, 'sk-***');
