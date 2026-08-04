/**
 * The error shape OpenAI clients understand, as a body and as a stream event.
 *
 * Being OpenAI-compatible is what the gateway is for, and an error is as much
 * part of that interface as a completion is. A caller that cannot tell a failure
 * apart from an empty answer has been handed the one result it cannot check.
 */
export type OpenAIError = {
  code?: string;
  message: string;
  type: string;
};

export const openAiErrorBody = (error: OpenAIError): string => JSON.stringify({ error });

/**
 * An error delivered inside the body of a stream, for a failure that happens
 * after the status line has gone out and can no longer be expressed as one.
 *
 * What makes the OpenAI SDKs raise on this is the `error` member of the payload,
 * not the event name: openai-node reads `sse.event` only for the `thread.`
 * prefixes, so an unrecognised name lands on the branch that parses the data and
 * throws on what it finds there. The name is carried anyway for the clients that
 * do switch on it, and costs nothing to the ones that do not.
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
  // trimEnd rather than trim, so a `\r` from a CRLF stream does not end up
  // inside a field value.
  const lines = chunk
    .trim()
    .split('\n')
    .map((line) => line.trimEnd());

  // Matched whole: a prefix test would read `event: error_recovered` as fatal
  // and cut a healthy stream short. The space after the colon is optional in
  // SSE, so it cannot be part of what is matched.
  const name = lines[0]?.startsWith('event:') ? lines[0].slice('event:'.length).trim() : undefined;

  if (name !== 'error') {
    return undefined;
  }

  // A payload may be split across several `data:` lines, which SSE joins with
  // newlines. Reading only the first would leave the JSON unparseable, and the
  // error would be dropped exactly as it was before — silently.
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).replace(/^ /, ''))
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
