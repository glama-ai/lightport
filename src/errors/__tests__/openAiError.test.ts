import {
  openAiErrorEvent,
  openAiErrorEventAfterPartialFrame,
  readOpenAiErrorEvent,
} from '../openAiError';
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

describe('readOpenAiErrorEvent', () => {
  // Every miss here fails the same way: the error is dropped, the adapter's
  // completion flush runs, and the caller is told the model answered. A silent
  // return to the exact bug this exists to close.
  it('reads back what the gateway writes', () => {
    expect(readOpenAiErrorEvent(openAiErrorEvent(error).trim())).toMatchObject(error);
  });

  it('reads a payload split across several data lines', () => {
    const body = ['event: error', 'data: {"error":', 'data: {"message":"stopped short"}}'].join(
      '\n',
    );

    expect(readOpenAiErrorEvent(body)?.message).toBe('stopped short');
  });

  it('reads a data line written without the optional space', () => {
    expect(readOpenAiErrorEvent('event: error\ndata:{"error":{"message":"m"}}')?.message).toBe('m');
  });

  it('reads a frame delimited with CRLF', () => {
    expect(
      readOpenAiErrorEvent('event: error\r\ndata: {"error":{"message":"m"}}\r\n')?.message,
    ).toBe('m');
  });

  it('does not treat an event merely named like an error as one', () => {
    // A prefix test would cut a healthy stream short here, and report a failure
    // that never happened.
    const body = 'event: error_recovered\ndata: {"error":{"message":"recovered"}}';

    expect(readOpenAiErrorEvent(body)).toBeUndefined();
  });

  it('ignores anything that is not an error event', () => {
    expect(readOpenAiErrorEvent('data: {"choices":[]}')).toBeUndefined();
    expect(readOpenAiErrorEvent('data: [DONE]')).toBeUndefined();
    expect(readOpenAiErrorEvent('event: error\ndata: not json')).toBeUndefined();
    expect(readOpenAiErrorEvent('event: error\ndata: {"error":"a string"}')).toBeUndefined();
    expect(readOpenAiErrorEvent('event: error')).toBeUndefined();
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
