import { describe, expect, it } from 'vitest';
import { createStreamState, transformStreamChunk } from '../responses';

const chunk = (body: Record<string, unknown>) =>
  `data: ${JSON.stringify({ created: 1, id: 'c', model: 'm', object: 'chat.completion.chunk', ...body })}`;

const completedEvent = (events: string) =>
  events
    .split('\n\n')
    .map((event) => event.split('\n').find((line) => line.startsWith('data: ')))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice('data: '.length)))
    .find((event) => event.type === 'response.completed');

describe('the usage of a streamed responses request', () => {
  // The non-streamed translation reported these; the streamed one wrote zero.
  it('reports the cached and reasoning tokens the provider counted', () => {
    const state = createStreamState();
    const events = [
      chunk({ choices: [{ delta: { content: 'Hi', role: 'assistant' }, index: 0 }] }),
      chunk({
        choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
        usage: {
          completion_tokens: 40,
          completion_tokens_details: { reasoning_tokens: 32 },
          prompt_tokens: 100,
          prompt_tokens_details: { cached_tokens: 64 },
          total_tokens: 140,
        },
      }),
      'data: [DONE]',
    ]
      .map((c) => transformStreamChunk(c, state) ?? '')
      .join('');

    expect(completedEvent(events).response.usage).toMatchObject({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 64 },
      output_tokens: 40,
      output_tokens_details: { reasoning_tokens: 32 },
    });
  });
});
