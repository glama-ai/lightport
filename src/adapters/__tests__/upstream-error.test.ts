import { openAiErrorEvent } from '../../errors/openAiError';
import {
  transformStreamChunk as messagesTransformStreamChunk,
  createStreamState as messagesCreateStreamState,
} from '../messages/streamTransform';
import {
  transformStreamChunk as responsesTransformStreamChunk,
  createStreamState as responsesCreateStreamState,
} from '../responses/streamTransform';
import { describe, expect, it } from 'vitest';

/**
 * The frame as the adapter actually receives it.
 *
 * `adaptStreamingResponse` reads the gateway's own stream back through
 * `EventSourceParserStream` and hands over `event: <name>\ndata: <payload>`, so
 * the terminating blank line the provider transform wrote is already gone by
 * the time a chunk gets here. Feeding the raw frame instead would test a shape
 * production never produces.
 */
const reframe = (frame: string) => frame.trim();

const upstreamError = reframe(
  openAiErrorEvent({
    message: 'anthropic error: Overloaded',
    type: 'overloaded_error',
  }),
);

const contentChunk = 'data: {"choices":[{"delta":{"content":"Hel"}}]}';

/**
 * The adapters recognise chunks by their `data:` line, so an error event — which
 * has an `event:` line ahead of it — used to be dropped outright. What made that
 * a wrong answer rather than a missing one is the flush below: `adaptStreaming
 * Response` finishes every stream by feeding `data: [DONE]`, so a dropped error
 * became a completion the model never produced.
 */
describe('an upstream error reaching an adapter', () => {
  describe('messages', () => {
    it('is delivered as an error rather than dropped', () => {
      const state = messagesCreateStreamState();
      messagesTransformStreamChunk(contentChunk, state);

      const result = messagesTransformStreamChunk(upstreamError, state);

      expect(result).toContain('event: error');
      expect(result).toContain('Overloaded');
      expect(result).toContain('overloaded_error');
    });

    it('stops the stream being closed as a finished message', () => {
      const state = messagesCreateStreamState();
      messagesTransformStreamChunk(contentChunk, state);
      messagesTransformStreamChunk(upstreamError, state);

      expect(messagesTransformStreamChunk('data: [DONE]', state)).toBeUndefined();
    });

    it('still closes a healthy stream', () => {
      const state = messagesCreateStreamState();
      messagesTransformStreamChunk(contentChunk, state);

      expect(messagesTransformStreamChunk('data: [DONE]', state)).toContain('message_stop');
    });
  });

  describe('responses', () => {
    it('is delivered as an error rather than dropped', () => {
      const state = responsesCreateStreamState();
      responsesTransformStreamChunk(contentChunk, state);

      const result = responsesTransformStreamChunk(upstreamError, state);

      expect(result).toContain('event: error');
      expect(result).toContain('Overloaded');
      expect(result).toContain('overloaded_error');
    });

    it('stops the stream being reported completed', () => {
      const state = responsesCreateStreamState();
      responsesTransformStreamChunk(contentChunk, state);
      responsesTransformStreamChunk(upstreamError, state);

      expect(responsesTransformStreamChunk('data: [DONE]', state)).toBeUndefined();
    });

    it('still completes a healthy stream', () => {
      const state = responsesCreateStreamState();
      responsesTransformStreamChunk(contentChunk, state);

      expect(responsesTransformStreamChunk('data: [DONE]', state)).toContain('response.completed');
    });
  });

  it('gives a started response an ending', () => {
    // A client following the lifecycle waits for a terminal event. Left with
    // `response.created` and deltas and nothing else, it waits out a stream
    // that is never coming back.
    const state = responsesCreateStreamState();
    responsesTransformStreamChunk(contentChunk, state);

    const result = responsesTransformStreamChunk(upstreamError, state);

    expect(result).toContain('event: response.failed');
    expect(result).toContain('"status":"failed"');
  });

  it('emits nothing further once a stream has failed', () => {
    // An upstream that kept talking would otherwise open a second message
    // behind an error already sent, and nothing would ever close it.
    const messagesState = messagesCreateStreamState();
    messagesTransformStreamChunk(contentChunk, messagesState);
    messagesTransformStreamChunk(upstreamError, messagesState);

    expect(messagesTransformStreamChunk(contentChunk, messagesState)).toBeUndefined();

    const responsesState = responsesCreateStreamState();
    responsesTransformStreamChunk(contentChunk, responsesState);
    responsesTransformStreamChunk(upstreamError, responsesState);

    expect(responsesTransformStreamChunk(contentChunk, responsesState)).toBeUndefined();
  });

  it('emits nothing further once a stream has completed', () => {
    // The mirror of the case above, and the one the ordering used to get wrong:
    // the error check ran ahead of the guard, so a failure arriving after the
    // `[DONE]` was still honoured. A response cannot both complete and fail, and
    // a client handed two terminal events for one id has no way to order them.
    const responsesState = responsesCreateStreamState();
    responsesTransformStreamChunk(contentChunk, responsesState);
    responsesTransformStreamChunk('data: [DONE]', responsesState);

    expect(responsesTransformStreamChunk(upstreamError, responsesState)).toBeUndefined();

    const messagesState = messagesCreateStreamState();
    messagesTransformStreamChunk(contentChunk, messagesState);
    messagesTransformStreamChunk('data: [DONE]', messagesState);

    expect(messagesTransformStreamChunk(upstreamError, messagesState)).toBeUndefined();
  });

  it('says on the terminal event what the failure was', () => {
    // `response.failed` is what a client following the lifecycle reads. A
    // status of `failed` with no reason beside it reports a failure without
    // saying what happened, which is the shortfall this whole change is about.
    const state = responsesCreateStreamState();
    responsesTransformStreamChunk(contentChunk, state);

    const failed = responsesTransformStreamChunk(upstreamError, state)!
      .split('\n\n')
      .find((frame) => frame.includes('event: response.failed'))!;
    const { response } = JSON.parse(failed.slice(failed.indexOf('data: ') + 'data: '.length));

    expect(response.error).toMatchObject({ message: 'anthropic error: Overloaded' });
  });

  it('does not present what arrived before a failure as a finished answer', () => {
    // Whatever was salvaged is half-written by definition. Reported `completed`
    // it reads as the model's answer — and a tool call's truncated arguments as
    // JSON a caller is invited to parse.
    const state = responsesCreateStreamState();
    responsesTransformStreamChunk(contentChunk, state);

    const failed = responsesTransformStreamChunk(upstreamError, state)!
      .split('\n\n')
      .find((frame) => frame.includes('event: response.failed'))!;
    const { response } = JSON.parse(failed.slice(failed.indexOf('data: ') + 'data: '.length));

    expect(response.output).not.toHaveLength(0);
    for (const item of response.output) {
      expect(item.status).not.toBe('completed');
    }
  });

  it('reaches a caller even when the failure arrives before any content', () => {
    // An overload commonly lands after the 200 and before the first token. With
    // the error dropped and nothing started, the flush had nothing to close
    // either, and the caller was handed an empty body and no reason for it.
    const state = responsesCreateStreamState();

    expect(responsesTransformStreamChunk(upstreamError, state)).toContain('Overloaded');
  });
});
