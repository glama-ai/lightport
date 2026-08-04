import { openAiErrorEvent, openAiErrorEventAfterPartialFrame } from '../openAiError';
import { EventSourceParserStream } from 'eventsource-parser/stream';
import { describe, expect, it } from 'vitest';

const error = { code: 'stream_truncated', message: 'stopped short', type: 'server_error' };

/**
 * Reads a body back through the same parser the gateway uses on provider
 * streams, so what is asserted is what a client recovers rather than what the
 * string happens to contain.
 */
const parse = async (body: string): Promise<Array<{ data: string; event?: string }>> => {
  const events: Array<{ data: string; event?: string }> = [];

  const stream = new ReadableStream<string>({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  }).pipeThrough(new EventSourceParserStream());

  for await (const event of stream) {
    events.push({ data: event.data, event: event.event });
  }

  return events;
};

describe('openAiErrorEventAfterPartialFrame', () => {
  it('survives being appended to a frame that never finished', async () => {
    // Where a stream stops is decided by whoever broke it, not by the gateway.
    const dangling = 'data: {"choices":[{"delta":{"content":"hel';

    const events = await parse(`${dangling}${openAiErrorEventAfterPartialFrame(error)}`);
    const raised = events.find((event) => event.event === 'error');

    // Without the separator the two merge into one unnamed event and the notice
    // is destroyed by the truncation it exists to report.
    expect(raised).toBeDefined();
    expect(JSON.parse(raised!.data).error).toMatchObject(error);
  });

  it('adds nothing to a stream that stopped on a boundary', async () => {
    const complete = 'data: {"choices":[]}\n\n';

    const events = await parse(`${complete}${openAiErrorEventAfterPartialFrame(error)}`);

    // An empty event is no event: the separator has to be free when it is not
    // needed, or every clean truncation gains a phantom chunk.
    expect(events).toHaveLength(2);
    expect(events[1].event).toBe('error');
  });
});

describe('openAiErrorEvent', () => {
  it('carries no separator of its own', async () => {
    // The transforms emit this in sequence behind a frame that already ended
    // properly. A separator here would be a blank line in every provider stream
    // that reports an error.
    expect(openAiErrorEvent(error).startsWith('event:')).toBe(true);

    const events = await parse(`data: {"choices":[]}\n\n${openAiErrorEvent(error)}`);

    expect(events).toHaveLength(2);
    expect(events[1].event).toBe('error');
  });
});
