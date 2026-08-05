import { type OpenAIError } from '../errors/openAiError';

/**
 * What a caller reading a stream is told when it stops short.
 *
 * Neutral about cause on purpose. Every exception out of the send loop ends
 * here, a fault in the gateway's own transform as much as a provider that
 * stopped sending, and the caller is in no position to tell those apart — the
 * log and the Sentry event, which can, are where the distinction is drawn.
 */
export const TRUNCATION_NOTICE: OpenAIError = {
  code: 'stream_truncated',
  message: 'The response stream ended before it was complete.',
  type: 'server_error',
};

/**
 * How one particular stream says it was cut short.
 *
 * The send layer is where truncation is detected, and it is also the layer that
 * knows least about what it is sending: a body, a media type, and nothing about
 * the API whose vocabulary those bytes are written in. It can manage a bare
 * error frame from the route alone, but not a terminal lifecycle event —
 * `response.failed` has to name the response it ends and take the next sequence
 * number, and both live in adapter state that never reaches this far.
 *
 * So the adapter leaves behind the one thing only it can write, and the send
 * layer asks for it at the moment it turns out to be needed. Keyed on the
 * response rather than the request because that is the exact thing being
 * written: a handler that returns some other response — an error, a retry —
 * finds no notice and falls back to the frame the route implies, which is the
 * right answer rather than a stale one.
 *
 * A registered builder may still decline, returning undefined. That covers a
 * response already given an ending of either kind — an upstream that reported
 * its own failure, and equally one that ran to completion before the connection
 * died under it. A second ending behind either would contradict the first, and
 * the hangup is left to speak for whatever the bytes could not.
 */
const notices = new WeakMap<Response, () => string | undefined>();

export const setTruncationNotice = (response: Response, build: () => string | undefined): void => {
  notices.set(response, build);
};

export const getTruncationNotice = (response: Response): (() => string | undefined) | undefined =>
  notices.get(response);
