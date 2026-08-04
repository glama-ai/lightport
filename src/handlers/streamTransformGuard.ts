import { openAiErrorEvent, readOpenAiErrorEvent, type OpenAIError } from '../errors/openAiError';
import { logger } from '../logger';
import { captureException } from '../sentry/captureException';

/** Whether what a transform produced still carries the failure it was given. */
const carriesError = (transformed: unknown): boolean => {
  const frames = Array.isArray(transformed) ? transformed : [transformed];

  return frames.some(
    (frame) => typeof frame === 'string' && readOpenAiErrorEvent(frame.trim()) !== undefined,
  );
};

/**
 * Wraps a provider's stream chunk transform so an upstream failure survives it.
 *
 * A provider transform is written against the shape of a completion, and most of
 * them reach straight for `choices[0]`. Handed the error frame their own
 * upstream sends mid-stream — a rate limit, an overload — they do one of two
 * things, and both lose it. Fifteen of them throw, which takes the stream down
 * and tells the caller the connection broke rather than that the model refused.
 * The rest quietly produce a chunk with no content, which is worse: the stream
 * runs on to its `[DONE]` and reports a completion the model never gave, and
 * nothing downstream can tell that from a model that answered with silence.
 *
 * Patching this transform by transform is a losing game — the next provider
 * added reintroduces it. So the recovery lives here, once, on the path every
 * provider's chunks already travel, under one rule:
 *
 *   a chunk that arrived carrying a failure has to leave carrying one.
 *
 * The transform still runs first and its answer wins whenever it kept the
 * failure. A provider that reads its own error frame properly — Anthropic's
 * does, mapping the type and naming itself — must keep doing so, and pre-empting
 * it here would trade something specific for something blunter.
 *
 * Ordinary content pays a single substring scan for this and is otherwise
 * untouched; see `readOpenAiErrorEvent`.
 *
 * What this does not reach: a failure is recognised by its `data:` frame, which
 * covers the SSE-shaped upstreams and so most of the catalogue. Bedrock's
 * event-stream payloads and Cohere's JSONL arrive as bare JSON carrying no frame
 * to read, and a failure either reports mid-stream is still lost the way it
 * always was. Closing that needs a reader per wire format rather than anything
 * available from here.
 */
export const guardStreamTransform =
  (transform: Function, provider: string) =>
  (chunk: string, ...rest: unknown[]): unknown => {
    const upstreamError = readOpenAiErrorEvent(chunk);
    let transformed: unknown;

    try {
      transformed = transform(chunk, ...rest);
    } catch (err) {
      // The transform could not read what it was given. If the chunk is a
      // failure the provider reported, that is the explanation rather than a
      // fault of the gateway's, and the failure is what the caller needs.
      if (!upstreamError) {
        // A transform that cannot read an ordinary chunk is a genuine fault,
        // and there is nothing to salvage from the rest of this stream. Left to
        // propagate, so the caller is told the stream stopped short rather than
        // handed a body that quietly goes wrong from here on.
        throw err;
      }

      report(err, provider, 'rejected');

      return frameFor(upstreamError, provider);
    }

    if (upstreamError && !carriesError(transformed)) {
      // Neither thrown nor kept: the failure went in and a completion came out.
      report(undefined, provider, 'discarded');

      return frameFor(upstreamError, provider);
    }

    return transformed;
  };

const frameFor = (error: OpenAIError, provider: string): string =>
  openAiErrorEvent({
    // Carried whole rather than rebuilt from the two fields that read like the
    // whole error. `code` is what an OpenAI client dispatches on —
    // `insufficient_quota` and `context_length_exceeded` call for different
    // handling, and neither is recoverable from prose — so rebuilding without
    // it recovers the failure and discards the part of it that decides what
    // happens next. `openAiErrorBody` writes the four fields of the envelope
    // and nothing else, so what the upstream carried beyond them stays out.
    ...error,
    // Prefixed as `generateErrorResponse` prefixes a non-streamed one, so a
    // failure reads the same whether or not the caller asked for a stream —
    // which is the claim that made dropping the other fields a defect.
    message: `${provider} error: ${error.message}`,
  });

const report = (err: unknown, provider: string, verb: 'rejected' | 'discarded') => {
  const message = `provider stream transform ${verb} an upstream error frame`;

  logger.warn({ err, provider }, message);

  captureException({ error: err ?? new Error(message), extra: { provider }, message });
};
