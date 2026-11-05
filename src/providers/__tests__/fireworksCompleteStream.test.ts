import { describe, expect, it } from 'vitest';
import { FireworksAICompleteStreamChunkTransform as transform } from '../fireworks-ai/complete';

const read = (frame: string) => JSON.parse(frame.replace(/^data: /, '').trim());

describe('fireworks completions stream', () => {
  // The usage chunk OpenAI-compatible servers send last carries no choice.
  it('reads a chunk with no choices, keeping its usage', () => {
    const usage = { completion_tokens: 2, prompt_tokens: 3, total_tokens: 5 };
    const out = read(
      transform(`data: ${JSON.stringify({ choices: [], id: 'c', model: 'm', usage })}`),
    );

    expect(out.choices).toEqual([]);
    expect(out.usage).toEqual(usage);
  });

  it('still reads a chunk with a choice', () => {
    const out = read(
      transform(
        `data: ${JSON.stringify({ choices: [{ finish_reason: null, index: 0, text: 'Hi' }], id: 'c' })}`,
      ),
    );

    expect(out.choices).toEqual([{ finish_reason: null, index: 0, logprobs: null, text: 'Hi' }]);
  });
});
