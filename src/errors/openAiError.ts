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
