export const AI_RESTING = 'AI가 잠시 쉬고 있어요... 무료 사용 한도에 도달했으니 잠시 후 다시 시도해 주세요. 승인함과 결제는 AI 없이도 계속 사용할 수 있어요.';

// Maps a provider error to a chat-safe message. API keys are never echoed; quota errors are not retried.
export function friendlyAiError(error: unknown) {
  const m = String((error as { message?: string })?.message ?? error);
  if (/quota|429|RESOURCE_EXHAUSTED|rate.?limit|too many requests/i.test(m)) return AI_RESTING;
  if (/high demand|UNAVAILABLE|overloaded|503/i.test(m)) return 'AI 모델이 지금 혼잡해요 (503). 잠시 후 다시 시도하거나 GOOGLE_MODEL을 바꿔 주세요.';
  if (/not found|no longer available|404/i.test(m)) return 'AI 모델을 찾을 수 없어요 (404). GOOGLE_MODEL 설정을 확인해 주세요.';
  return 'AI 응답에 실패했습니다. API 키, 모델, 사용 한도와 DB 초기화를 확인해 주세요.';
}

export const redactKeys = (message: string) => message.replace(/AIza[\w-]+/g, 'AIza***').replace(/sk-[\w-]+/g, 'sk-***');
