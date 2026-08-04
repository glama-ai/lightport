import { getTruncationNotice, setTruncationNotice, TRUNCATION_NOTICE } from '../truncationNotice';
import { describe, expect, it } from 'vitest';

describe('truncationNotice', () => {
  it('gives back the notice left for a response', () => {
    const response = new Response('body');

    setTruncationNotice(response, () => 'event: error\ndata: {}\n\n');

    expect(getTruncationNotice(response)?.()).toBe('event: error\ndata: {}\n\n');
  });

  it('has nothing for a response nobody left one for', () => {
    // The send layer tells this apart from a notice that declines: one falls
    // back to the frame the route implies, the other stays silent. Collapsing
    // the two would put a second, contradictory ending on a stream that had
    // already been given one.
    expect(getTruncationNotice(new Response('body'))).toBeUndefined();
  });

  it('lets a notice decline', () => {
    const response = new Response('body');

    setTruncationNotice(response, () => undefined);

    expect(getTruncationNotice(response)).toBeDefined();
    expect(getTruncationNotice(response)?.()).toBeUndefined();
  });

  it('keeps notices to the response they were left for', () => {
    // Keyed on the response rather than the request, so a handler that returns
    // some other response — an error, a retry — cannot pick up a stale one.
    const streamed = new Response('body');
    const other = new Response('body');

    setTruncationNotice(streamed, () => 'mine');

    expect(getTruncationNotice(streamed)?.()).toBe('mine');
    expect(getTruncationNotice(other)).toBeUndefined();
  });

  it('is built once and read many times without drift', () => {
    // Both the send layer's static frames and the adapter's own frame are built
    // from this one object, so a change to the wording reaches the wire by both
    // routes or by neither.
    expect(TRUNCATION_NOTICE).toMatchObject({
      code: 'stream_truncated',
      type: 'server_error',
    });
    expect(TRUNCATION_NOTICE.message).toMatch(/\S/);
  });
});
