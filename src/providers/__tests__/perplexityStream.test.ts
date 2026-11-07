import { describe, expect, it } from 'vitest';
import { PerplexityAIChatCompleteStreamChunkTransform as transform } from '../perplexity-ai/chatComplete';

const frame = (body: Record<string, unknown>) => `data: ${JSON.stringify(body)}`;

const delta = (content: string, finishReason: string | null = null, extra = {}) =>
  frame({
    choices: [{ delta: { content, role: 'assistant' }, finish_reason: finishReason, index: 0 }],
    created: 1,
    id: 'pplx-1',
    model: 'sonar',
    object: 'chat.completion.chunk',
    ...extra,
  });

const run = (chunks: string[]) => {
  const state = {};

  return chunks.map((chunk) => transform(chunk, 'fallback', state, true));
};

const doneCount = (frames: (string | undefined)[]) =>
  frames.join('').split('data: [DONE]').length - 1;

describe('perplexity stream', () => {
  // Perplexity ends its stream with `[DONE]`, which used to be parsed as JSON and
  // thrown on, cutting every stream short after it had finished.
  it('reads to the end of a stream that closes with [DONE]', () => {
    const usage = { completion_tokens: 2, prompt_tokens: 3, total_tokens: 5 };
    const frames = run([delta('Hel'), delta('lo', 'stop', { usage }), 'data: [DONE]']);

    expect(frames[2]).toBeUndefined();
    expect(doneCount(frames)).toBe(1);
    expect(JSON.parse(frames[1]!.split('\n\n')[0].slice('data: '.length)).usage).toEqual(usage);
  });

  it('still ends a stream whose finish reason never came', () => {
    const frames = run([delta('Hello'), 'data: [DONE]']);

    expect(frames[1]).toBe('data: [DONE]\n\n');
    expect(doneCount(frames)).toBe(1);
  });

  // A deep-research model streams chunks that carry no choices while it searches.
  it('reads a chunk that carries no choices', () => {
    const [out] = run([frame({ citations: [], id: 'pplx-1', model: 'sonar-deep-research' })]);

    expect(JSON.parse(out!.slice('data: '.length)).choices[0]).toMatchObject({
      finish_reason: null,
      index: 0,
    });
  });

  it('says a chunk has not finished, as OpenAI does', () => {
    const [out] = run([delta('Hello')]);

    expect(JSON.parse(out!.slice('data: '.length)).choices[0].finish_reason).toBeNull();
  });
});
