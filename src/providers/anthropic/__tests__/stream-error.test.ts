import { ANTHROPIC } from '../../../globals';
import { AnthropicStreamState } from '../types';
import { getAnthropicStreamChunkTransform } from '../chatComplete';
import { EventSourceParserStream } from 'eventsource-parser/stream';
import { describe, it, expect } from 'vitest';

const transform = getAnthropicStreamChunkTransform(ANTHROPIC);

const newState = () => ({}) as AnthropicStreamState;

const feed = (chunk: string, state: AnthropicStreamState = newState()): string | undefined =>
  transform(chunk, 'fallback-id', state, true);

/** An SSE event as Anthropic emits it, in the shape readSSEStream hands over. */
const event = (name: string, data: Record<string, unknown>) =>
  `event: ${name}\ndata: ${JSON.stringify(data)}`;

const errorChunk = event('error', {
  error: { message: 'Overloaded', type: 'overloaded_error' },
  type: 'error',
});

/**
 * Reads a body back through the parser the gateway itself uses.
 *
 * Splitting on the text would count a frame that has no terminating blank line,
 * which the spec discards and no client ever sees — the difference between an
 * event delivered and one merely written.
 */
const parse = async (body: string): Promise<Array<{ data: string; event?: string }>> => {
  const events: Array<{ data: string; event?: string }> = [];

  const stream = new ReadableStream<string>({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  }).pipeThrough(new EventSourceParserStream());

  for await (const parsed of stream) {
    events.push({ data: parsed.data, event: parsed.event });
  }

  return events;
};

describe('anthropic stream errors', () => {
  it('delivers an upstream error as an error', async () => {
    const events = await parse(feed(errorChunk) ?? '');

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('error');
    expect(JSON.parse(events[0].data).error).toMatchObject({
      message: `${ANTHROPIC} error: Overloaded`,
      type: 'overloaded_error',
    });
  });

  it('does not close a failed stream as if it had completed', async () => {
    // `[DONE]` is the sentinel for a completion that ran to the end. Sent after
    // a failure it tells every client the model finished and chose to say
    // nothing, which is the one answer a caller has no way to check.
    const state = newState();
    const body = [
      feed(event('message_start', { message: { model: 'claude' }, type: 'message_start' }), state),
      feed(
        event('content_block_delta', {
          delta: { text: 'Hel', type: 'text_delta' },
          index: 0,
          type: 'content_block_delta',
        }),
        state,
      ),
      feed(errorChunk, state),
    ]
      .filter(Boolean)
      .join('');

    expect(body).not.toContain('[DONE]');

    const events = await parse(body);

    expect(events.at(-1)?.event).toBe('error');
  });

  it('does not pass a failure off as a finish reason', () => {
    // The error type used to be smuggled into `finish_reason` on a chunk with
    // empty content — a shape indistinguishable from an empty completion to
    // anything aggregating deltas.
    expect(feed(errorChunk)).not.toContain('finish_reason');
    expect(feed(errorChunk)).not.toContain('chat.completion.chunk');
  });

  it('still ends a healthy stream with the completion sentinel', () => {
    // The guard against overcorrecting: `message_stop` is the real completion,
    // and it has to keep terminating the stream the way clients expect.
    expect(feed(event('message_stop', { type: 'message_stop' }))).toBe('data: [DONE]\n\n');
  });
});
