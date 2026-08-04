import { CONTENT_TYPES } from '../globals';

/**
 * The error shape OpenAI clients understand, as a body and as a stream event.
 *
 * Being OpenAI-compatible is what the gateway is for, and an error is as much
 * part of that interface as a completion is. A caller that cannot tell a failure
 * apart from an empty answer has been handed the one result it cannot check.
 */
export type OpenAIError = {
  code?: string | null;
  message: string;
  param?: string | null;
  type: string;
};

/**
 * `param` and `code` are written even when there is nothing to put in them,
 * because that is the shape provider errors already leave in — see
 * `generateErrorResponse` — and a client should not have to know which layer
 * produced a failure to know how to read it.
 */
export const openAiErrorBody = (error: OpenAIError): string =>
  JSON.stringify({
    error: {
      code: error.code ?? null,
      message: error.message,
      param: error.param ?? null,
      // Coalesced like the rest: a provider error object is typed as always
      // naming a type but arrives from the wire, and `undefined` would be
      // dropped by JSON.stringify — leaving the one field a client dispatches
      // on absent from an envelope that promises it.
      type: error.type ?? null,
    },
  });

export const openAiErrorResponse = (error: OpenAIError, status: number): Response =>
  new Response(openAiErrorBody(error), {
    status,
    headers: { 'content-type': CONTENT_TYPES.APPLICATION_JSON },
  });

/**
 * The same error, framed as a stream event.
 *
 * Named `error` because that is what makes the OpenAI SDKs raise on it. They
 * read `sse.event` only to recognise the `thread.` prefix, so any other name
 * falls through to the branch that inspects the payload — which throws when it
 * carries an `error` key. A frame the client cannot be made to raise on would
 * leave the failure to be inferred from a completion that never arrives.
 */
export const openAiErrorEvent = (error: OpenAIError): string =>
  `event: error\ndata: ${openAiErrorBody(error)}\n\n`;

/**
 * Reads an error frame back out of a stream chunk.
 *
 * The adapters re-frame a chatComplete stream into another API's vocabulary, and
 * they recognise chunks by their `data:` line. An error event has an `event:`
 * line ahead of that, so without this it is not skipped but dropped — and the
 * completion the adapter synthesises when the stream ends would then report the
 * failure as a finished answer, which is the thing being fixed one layer down.
 */
export const readOpenAiErrorEvent = (chunk: string): OpenAIError | undefined => {
  // Every chunk of every stream reaches this, so the cheapest disqualifying
  // test comes first. A failure is carried under a top-level `error` key, which
  // is spelled literally in the payload — a chunk without those seven
  // characters cannot be one, and the ordinary content chunk that makes up
  // almost all of this traffic leaves here having scanned once and allocated
  // nothing. Splitting the frame apart before asking costs roughly double, on
  // the hottest path the gateway has.
  if (!chunk.includes('"error"')) {
    return undefined;
  }

  // trimEnd rather than trim, so a `\r` from a CRLF stream does not end up
  // inside a field value.
  const lines = chunk
    .trim()
    .split('\n')
    .map((line) => line.trimEnd());

  // Matched whole: a prefix test would read `event: error_recovered` as fatal
  // and cut a healthy stream short. The space after the colon is optional in
  // SSE, so it cannot be part of what is matched.
  const first = lines[0] ?? '';
  const named = first.startsWith('event:');
  const name = named ? first.slice('event:'.length).trim() : undefined;

  // A frame that names an event other than `error` is not one, whatever its
  // payload. An unnamed frame still can be: an OpenAI-compatible upstream
  // reports a mid-stream failure as a bare `data: {"error":…}`, and most of the
  // provider catalogue registers no stream transform to re-frame it — so
  // requiring the `event:` line would leave those failures dropped, which is
  // the thing being fixed.
  if (named && name !== 'error') {
    return undefined;
  }

  const body = named ? lines.slice(1) : lines;
  const start = body.findIndex((line) => line.startsWith('data:'));

  if (start === -1) {
    return undefined;
  }

  // A payload may be split across several `data:` lines, which SSE joins with
  // newlines. By the time a re-framed chunk reaches the adapters the parser has
  // already done that joining, so a continuation arrives without the prefix —
  // taking only prefixed lines would leave the JSON unparseable and the error
  // dropped exactly as it was before, silently.
  const data = body
    .slice(start)
    .map((line) => (line.startsWith('data:') ? line.slice('data:'.length).replace(/^ /, '') : line))
    .join('\n');

  if (!data) {
    return undefined;
  }

  try {
    const { error } = JSON.parse(data);

    return typeof error?.message === 'string' ? error : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The same event, for appending to a stream that stopped at a point nobody
 * chose.
 *
 * A frame written straight onto a half-finished `data:` line merges into it, and
 * a parser dispatches one unnamed event carrying both — the notice destroyed by
 * the very truncation it reports. The separator closes whatever frame was still
 * open; against a stream that ended on a boundary it dispatches nothing, an
 * empty event being no event at all.
 *
 * What this buys is that a parser reaching the notice can read it. It cannot
 * make the dangling fragment ahead of it parse: a client strict about JSON
 * raises on that first, and is told something went wrong either way.
 *
 * Kept apart from `openAiErrorEvent` because the two are answers to different
 * questions. A transform emitting an error in sequence follows a frame that
 * already ended properly and wants no separator; only an append at an edge the
 * gateway did not choose does.
 */
export const openAiErrorEventAfterPartialFrame = (error: OpenAIError): string =>
  `\n\n${openAiErrorEvent(error)}`;
