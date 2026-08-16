import { parseJson } from '../utils/parseJson';
import { ANTHROPIC_STOP_REASON } from './anthropic/types';
import { ErrorResponse, FINISH_REASON, PROVIDER_FINISH_REASON } from './types';
import { AnthropicFinishReasonMap, finishReasonMap } from './utils/finishReasonMap';

export const generateInvalidProviderResponseError: (
  response: Record<string, any>,
  provider: string,
) => ErrorResponse = (response, provider) => {
  return {
    error: {
      message: `Invalid response received from ${provider}: ${JSON.stringify(response)}`,
      type: null,
      param: null,
      code: null,
    },
    provider: provider,
  } as ErrorResponse;
};

export const generateErrorResponse: (
  errorDetails: {
    message: string;
    type: string | null;
    param: string | null;
    code: string | null;
  },
  provider: string,
) => ErrorResponse = ({ message, type, param, code }, provider) => {
  return {
    error: {
      message: `${provider} error: ${message}`,
      type: type ?? null,
      param: param ?? null,
      code: code ?? null,
    },
    provider: provider,
  } as ErrorResponse;
};

const isObject = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null;

/**
 * A body read as either the answer or the failure it turned out to be.
 *
 * The distinction cannot be drawn from the status alone: a payload the provider
 * mislabelled arrives wrapped whatever the status, and the answer inside it is
 * only reachable after unwrapping.
 */
export type ReadProviderResponse =
  | { kind: 'answer'; body: Record<string, any> }
  | { kind: 'failure'; error: ErrorResponse };

/**
 * A failure named in the envelope an OpenAI client reads.
 *
 * The one shape handled before this was a non-200 body carrying `error`.
 * Everything else reached the caller as the upstream wrote it — a FastAPI
 * `{"detail": ...}`, an HTML page from whatever sits in front of the API, a
 * bare string. A client reads `error.message` off each of those and finds
 * `undefined`, so a request that failed for a stated reason arrives carrying no
 * reason at all.
 */
export const readProviderResponse: (
  response: Record<string, any>,
  responseStatus: number,
  provider: string,
) => ReadProviderResponse = (response, responseStatus, provider) => {
  const failure = (message: string, type: string | null = null, code: string | null = null) => ({
    kind: 'failure' as const,
    error: generateErrorResponse({ message, type, param: null, code }, provider),
  });

  // Read before the status is considered: a provider that mislabelled its
  // content type sends the whole payload down the text path, and a 200 wrapped
  // this way is no more readable than a 500 is.
  if ('html-message' in response) {
    const text = response['html-message'] ?? '';
    let parsed: unknown;

    try {
      parsed = parseJson(text);
    } catch {
      parsed = null;
    }

    // Not JSON after all — an HTML error page from something in front of the
    // API, most likely. The text is all there is to report.
    if (!isObject(parsed)) return failure(text);

    // Reported as a bare string rather than an object. Spreading that yields a
    // message of `undefined`, so the whole body is reported instead of a word
    // that says nothing.
    if ('error' in parsed && !isObject(parsed.error)) return failure(text);

    return readProviderResponse(parsed, responseStatus, provider);
  }

  if (responseStatus === 200) return { kind: 'answer', body: response };

  if (isObject(response.error)) {
    const { message, type, param, code } = response.error;

    // An `error` naming no message says nothing on its own, so the body it came
    // in is reported instead of the word `undefined`.
    return typeof message === 'string'
      ? {
          kind: 'failure',
          error: generateErrorResponse(
            { message, type: type ?? null, param: param ?? null, code: code ?? null },
            provider,
          ),
        }
      : failure(JSON.stringify(response));
  }

  // Reported as a bare string. Spreading that names no message at all, which is
  // how a stated reason became `undefined` on the way out.
  if (typeof response.error === 'string') {
    return failure(response.error, null, typeof response.code === 'string' ? response.code : null);
  }

  // FastAPI's validation shape, which several providers serve unaltered: a list
  // of errors under `detail`, each naming the field it is about.
  if (Array.isArray(response.detail) && response.detail.length) {
    const [first] = response.detail;
    const field = first?.loc?.join('.') ?? '';

    return failure(`${field ? `${field}: ` : ''}${first?.msg}`, first?.type ?? null);
  }

  // Problem details, RFC 7807 — a standard rather than any one provider's
  // habit, and the shape an `application/problem+json` body arrives in.
  if (typeof response.detail === 'string' || typeof response.title === 'string') {
    return failure(
      response.detail || response.title,
      typeof response.type === 'string' ? response.type : null,
      response.status === undefined ? null : String(response.status),
    );
  }

  if (typeof response.message === 'string') return failure(response.message);

  // A failure in a shape nothing here names. Reported whole rather than
  // dropped: the caller can read what the provider said even if this cannot.
  return failure(JSON.stringify(response));
};

type SplitResult = {
  before: string;
  after: string;
};

export function splitString(input: string, separator: string): SplitResult {
  const sepIndex = input.indexOf(separator);

  if (sepIndex === -1) {
    return {
      before: input,
      after: '',
    };
  }

  return {
    before: input.substring(0, sepIndex),
    after: input.substring(sepIndex + 1),
  };
}

/*
  Transforms the finish reason from the provider to the finish reason used by the OpenAI API.
  If the finish reason is not found in the map, it will return the stop reason.
  If the strictOpenAiCompliance is true, it will return the finish reason from the map.
  If the strictOpenAiCompliance is false, it will return the finish reason from the provider.
  NOTE: this function always returns a finish reason
*/
export const transformFinishReason = (
  finishReason?: PROVIDER_FINISH_REASON,
  strictOpenAiCompliance?: boolean,
): FINISH_REASON | PROVIDER_FINISH_REASON => {
  if (!finishReason) return FINISH_REASON.stop;
  if (!strictOpenAiCompliance) return finishReason;
  const transformedFinishReason = finishReasonMap.get(finishReason);
  if (!transformedFinishReason) {
    return FINISH_REASON.stop;
  }
  return transformedFinishReason;
};

/*
  The fields a reasoning model answers with that OpenAI never defined, ready to
  be spread into a rebuilt message.

  Providers speaking OpenAI's dialect return the chain of thought beside
  `content` rather than inside it — as `reasoning_content` in the convention
  DeepSeek set, as `reasoning` in the one OpenRouter set, or as `reasoning_text`
  as some vLLM builds emit it. A transform that
  rebuilds the message field by field drops whichever it is, and the caller is
  handed a reply with the thinking missing. Where the model spends the whole turn
  reasoning, `content` is empty and the answer arrives blank, indistinguishable
  from a model that said nothing. The streaming half of most of these providers
  forwards the delta whole and loses none of it, so the two paths disagree about
  what the model said, and only the path nobody watched was wrong.

  `reasoning_content` is returned verbatim rather than behind
  `strictOpenAiCompliance`, which defaults to on: gating it would leave the
  default path dropping reasoning, and the stream gates nothing. `content_blocks`
  is the gateway's own way of carrying thinking, which the Messages and Responses
  adapters read to rebuild a reasoning block, and is gated as everywhere else.
*/
export const transformReasoning = (
  // Loose on purpose: the declared response interfaces do not describe these
  // fields, which is the reason they were dropped in the first place.
  message: Record<string, any> | undefined,
  // Required rather than optional: omitting it would read as false and emit
  // `content_blocks` to a caller that asked for strict compliance.
  strictOpenAiCompliance: boolean,
): Record<string, unknown> => {
  // `||`, not `??`: an aggregator normalising the field it did not receive
  // leaves it an empty string rather than absent, and the thinking is in the
  // other one.
  const reasoning = message?.reasoning_content || message?.reasoning || message?.reasoning_text;
  if (typeof reasoning !== 'string' || !reasoning) return {};

  return {
    reasoning_content: reasoning,
    ...(!strictOpenAiCompliance && {
      content_blocks: [
        { type: 'thinking', thinking: reasoning },
        { type: 'text', text: message?.content },
      ],
    }),
  };
};

/*
  The token counts beyond the three every transform already copies, ready to be
  spread into a rebuilt usage.

  Rebuilding usage as prompt/completion/total alone drops the breakdown, so
  reasoning tokens are billed but never reported and a cache hit looks like a
  miss. Providers name their cache counters themselves; the hit is reported under
  the OpenAI-shaped `prompt_tokens_details` the rest of the gateway already uses.
*/
export const transformUsageDetails = (
  usage: Record<string, any> | undefined,
): Record<string, unknown> => {
  if (!usage) return {};

  const cachedTokens = usage.prompt_cache_hit_tokens ?? usage.cached_tokens;

  return {
    ...(usage.completion_tokens_details && {
      completion_tokens_details: usage.completion_tokens_details,
    }),
    // Carried whole rather than rebuilt from the cache count alone, which would
    // drop the other counts beside it — the mistake this helper exists to undo.
    ...((usage.prompt_tokens_details || cachedTokens !== undefined) && {
      prompt_tokens_details: {
        ...usage.prompt_tokens_details,
        ...(usage.prompt_tokens_details?.cached_tokens === undefined &&
          cachedTokens !== undefined && { cached_tokens: cachedTokens }),
      },
    }),
  };
};

/*
  Transforms the finish reason from the provider to the finish reason used by the Anthropic API.
  If the finish reason is not found in the map, it will return the stop reason.
  NOTE: this function always returns a finish reason
*/
export const transformToAnthropicStopReason = (
  finishReason?: PROVIDER_FINISH_REASON,
): ANTHROPIC_STOP_REASON => {
  if (!finishReason) return ANTHROPIC_STOP_REASON.end_turn;
  const transformedFinishReason = AnthropicFinishReasonMap.get(finishReason);
  if (!transformedFinishReason) {
    return ANTHROPIC_STOP_REASON.end_turn;
  }
  return transformedFinishReason;
};
