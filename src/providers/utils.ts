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
  DeepSeek set, or as `reasoning` in the one OpenRouter set. A transform that
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
  const reasoning = message?.reasoning_content || message?.reasoning;
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
