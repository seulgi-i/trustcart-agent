import type { LanguageModelV4Middleware, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { FIXTURE_DIR, readTurn, saveFixture, type FixtureStep } from './fixtures';

// AI_RECORD=1 with a real provider (ollama/gemini): after each model step, save the turn so far (earlier steps come
// from the prompt, this step from the response) as a replay fixture for AI_PROVIDER=mock. Only tool names, tool
// inputs and the model's text are stored; tool results are re-computed by the real tools on replay.
export function recordingMiddleware(source: string, dir = FIXTURE_DIR): LanguageModelV4Middleware {
  const save = (prompt: Parameters<typeof readTurn>[0], step: FixtureStep) => {
    try {
      console.log(`[ai] recorded fixture ${saveFixture(readTurn(prompt), step, source, dir)}`);
    } catch (e) {
      console.warn('[ai] could not record fixture:', (e as Error).message);
    }
  };
  const parseInput = (input: string) => { try { return JSON.parse(input) as unknown; } catch { return input; } };
  return {
    specificationVersion: 'v4',
    async wrapGenerate({ doGenerate, params }) {
      const result = await doGenerate();
      const calls = result.content.flatMap(p => (p.type === 'tool-call' ? [{ toolName: p.toolName, input: parseInput(p.input) }] : []));
      const text = result.content.flatMap(p => (p.type === 'text' ? [p.text] : [])).join('');
      save(params.prompt, { ...(calls.length ? { toolCalls: calls } : {}), ...(text ? { text } : {}) });
      return result;
    },
    async wrapStream({ doStream, params }) {
      const { stream, ...rest } = await doStream();
      const calls: NonNullable<FixtureStep['toolCalls']> = [];
      let text = '';
      const tap = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
        transform(part, controller) {
          if (part.type === 'tool-call') calls.push({ toolName: part.toolName, input: parseInput(part.input) });
          else if (part.type === 'text-delta') text += part.delta;
          else if (part.type === 'finish') save(params.prompt, { ...(calls.length ? { toolCalls: calls } : {}), ...(text ? { text } : {}) });
          controller.enqueue(part);
        },
      });
      return { stream: stream.pipeThrough(tap), ...rest };
    },
  };
}
