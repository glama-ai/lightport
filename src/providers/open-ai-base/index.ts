import { OPEN_AI } from '../../globals';
import { EmbedResponse } from '../../types/embedRequestBody';
import { ResponseItemList } from '../../types/inputList';
import { OpenAIResponse, ModelResponseDeleteResponse } from '../../types/modelResponses';
import { Params, Message } from '../../types/requestBody';
import { OpenAIChatCompleteConfig, OpenAIChatCompleteResponse } from '../openai/chatComplete';
import { OpenAICompleteResponse } from '../openai/complete';
import { ErrorResponse, ProviderConfig } from '../types';
import {
  generateInvalidProviderResponseError,
  readProviderResponse,
  transformReasoning,
  transformUsageDetails,
} from '../utils';
import { OpenAICreateModelResponseConfig } from './createModelResponse';

type CustomTransformer<T, U> = (response: T | ErrorResponse, isError?: boolean) => U;

type DefaultValues = {
  model?: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  logprobs?: boolean;
  [key: string]: unknown;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const excludeObjectKeys = (keyList: string[], object: Record<string, any>) => {
  if (keyList) {
    keyList.forEach((excludeKey) => {
      if (Object.hasOwn(object, excludeKey)) {
        delete object[excludeKey];
      }
    });
  }
};

export const createModelResponseParams = (
  exclude: string[],
  defaultValues: Record<string, string> = {},
  extra?: ProviderConfig,
): ProviderConfig => {
  const baseParams: ProviderConfig = {
    ...OpenAICreateModelResponseConfig,
  };

  excludeObjectKeys(exclude, baseParams);

  Object.keys(defaultValues).forEach((key) => {
    if (Object.hasOwn(baseParams, key) && !Array.isArray(baseParams[key])) {
      // Replaced rather than written into. The spread above copies the config
      // one level deep, so each parameter is still the very object OpenAI's own
      // config holds — and writing a default into it set that default for every
      // provider built on this base, including OpenAI itself.
      baseParams[key] = { ...baseParams[key], default: defaultValues[key] };
    }
  });

  return { ...baseParams, ...extra };
};

/**
 *
 * @param exclude List of string that we should exclude from open-ai default parameters
 * @param defaultValues Default values specific to the provider for params
 * @param extra Extra parameters type of ProviderConfig should extend to support the provider
 * @returns {ProviderConfig}
 */
export const chatCompleteParams = (
  exclude: string[],
  defaultValues?: DefaultValues,
  extra?: ProviderConfig,
): ProviderConfig => {
  const baseParams: ProviderConfig = {
    ...OpenAIChatCompleteConfig,
    messages: {
      param: 'messages',
      default: '',
      transform: (params: Params) => {
        return params.messages?.map((message: Message) => {
          if (message.role === 'developer') return { ...message, role: 'system' };
          return message;
        });
      },
    },
  };

  Object.keys(defaultValues ?? {}).forEach((key) => {
    if (Object.hasOwn(baseParams, key) && !Array.isArray(baseParams[key])) {
      // Replaced rather than written into, as above: whichever provider named a
      // default last named it for all of them.
      baseParams[key] = { ...baseParams[key], default: defaultValues?.[key] };
    }
  });

  // Exclude params that are not needed.
  excludeObjectKeys(exclude, baseParams);

  return { ...baseParams, ...extra };
};

/**
 *
 * @param exclude List of string that we should exclude from open-ai default parameters
 * @param defaultValues Default values specific to the provider for params
 * @param extra Extra parameters type of ProviderConfig should extend to support the provider
 * @returns {ProviderConfig}
 */
export const completeParams = (
  exclude: string[],
  defaultValues?: DefaultValues,
  extra?: ProviderConfig,
): ProviderConfig => {
  const baseParams: ProviderConfig = {
    model: {
      param: 'model',
      required: true,
      ...(defaultValues?.model && { default: defaultValues.model }),
    },
    prompt: {
      param: 'prompt',
      default: '',
    },
    max_tokens: {
      param: 'max_tokens',
      ...(defaultValues?.max_tokens && { default: defaultValues.max_tokens }),
      min: 0,
    },
    temperature: {
      param: 'temperature',
      ...(defaultValues?.temperature && { default: defaultValues.temperature }),
      min: 0,
      max: 2,
    },
    top_p: {
      param: 'top_p',
      ...(defaultValues?.top_p && { default: defaultValues.top_p }),
      min: 0,
      max: 1,
    },
    n: {
      param: 'n',
      default: 1,
    },
    stream: {
      param: 'stream',
      ...(defaultValues?.stream && { default: defaultValues.stream }),
    },
    logprobs: {
      param: 'logprobs',
      max: 5,
    },
    echo: {
      param: 'echo',
      default: false,
    },
    stop: {
      param: 'stop',
    },
    presence_penalty: {
      param: 'presence_penalty',
      min: -2,
      max: 2,
    },
    frequency_penalty: {
      param: 'frequency_penalty',
      min: -2,
      max: 2,
    },
    best_of: {
      param: 'best_of',
    },
    logit_bias: {
      param: 'logit_bias',
    },
    user: {
      param: 'user',
    },
    seed: {
      param: 'seed',
    },
    suffix: {
      param: 'suffix',
    },
  };

  excludeObjectKeys(exclude, baseParams);

  return { ...baseParams, ...extra };
};

export const embedParams = (
  exclude: string[],
  // `undefined` is a value here rather than an absence: a provider saying it has
  // no default model is not the same as a provider saying nothing.
  defaultValues?: Record<string, string | undefined>,
  extra?: ProviderConfig,
): ProviderConfig => {
  const baseParams: ProviderConfig = {
    model: {
      param: 'model',
      required: true,
      ...(defaultValues?.model && { default: defaultValues.model }),
    },
    input: {
      param: 'input',
      required: true,
    },
    encoding_format: {
      param: 'encoding_format',
    },
    dimensions: {
      param: 'dimensions',
    },
    user: {
      param: 'user',
    },
  };

  excludeObjectKeys(exclude, baseParams);

  return { ...baseParams, ...extra };
};

export const createSpeechParams = (
  exclude: string[],
  defaultValues?: Record<string, string>,
  extra?: ProviderConfig,
): ProviderConfig => {
  const baseParams: ProviderConfig = {
    model: {
      param: 'model',
      required: true,
      default: 'tts-1',
    },
    input: {
      param: 'input',
      required: true,
    },
    voice: {
      param: 'voice',
      required: true,
      default: 'alloy',
    },
    response_format: {
      param: 'response_format',
      required: false,
      default: 'mp3',
    },
    speed: {
      param: 'speed',
      required: false,
      default: 1,
    },
  };

  excludeObjectKeys(exclude, baseParams);

  return { ...baseParams, ...extra };
};

/**
 * What every transformer here does, in one place.
 *
 * The seven below repeated these two steps and differed only in the shape they
 * declared — and every difference between them turned out to be a slip rather
 * than a decision: one built a failure and returned the body anyway, another
 * ignored its custom transformer on the failure path entirely. Written once,
 * there is nowhere left for them to disagree.
 *
 * A custom transformer is handed the body as the provider wrote it, failure or
 * not. It exists because that provider's shape is its own, and handing it a
 * reshaped envelope would take away the very thing it was written to read.
 */
const nameProvider = (body: Record<string, any>, provider: string) => {
  // An aggregator names the house that actually served the request in this same
  // field, and stamping over it left a caller who routed through one in order to
  // find that out told the aggregator's name every time.
  if (typeof body.provider === 'string' && body.provider !== provider) {
    body.upstream_provider = body.provider;
  }

  // Assigned rather than defined: `Object.defineProperty` on an absent key
  // creates it `writable: false, configurable: false`, so a second stamp threw
  // and a later assignment threw with it.
  body.provider = provider;

  return body;
};

const upstreamTransformer = <T>(
  provider: string,
  customTransformer?: CustomTransformer<any, T>,
  { answersWithChoices = false }: { answersWithChoices?: boolean } = {},
) => {
  return (
    response: any,
    responseStatus: number,
    _responseHeaders?: Headers,
    strictOpenAiCompliance?: boolean,
  ) => {
    const read = readProviderResponse(response, responseStatus, provider ?? OPEN_AI);

    // Named after the custom transformer rather than instead of it. Every
    // provider that brought one was stamping the name by hand, and the ones
    // that forgot answered without saying who had answered.
    const named = (result: any) =>
      result && typeof result === 'object' ? nameProvider(result, provider) : result;

    if (read.kind === 'failure') {
      return customTransformer ? named(customTransformer(response, true)) : read.error;
    }

    if (customTransformer) return named(customTransformer(read.body));

    if (!answersWithChoices) return nameProvider(read.body, provider);

    // `Array.isArray`, not `'choices' in body`: a body naming the field and
    // leaving it null passes that test and then fails on the first thing done
    // with it, which reaches the caller as a 500 of the gateway's own making
    // rather than as the unreadable answer it is.
    if (!Array.isArray(read.body.choices)) {
      return generateInvalidProviderResponseError(read.body, provider ?? OPEN_AI);
    }

    // Unknown only on the path a mislabelled body takes, which passes two
    // arguments. Read as strict there, so nothing outside OpenAI's own shape is
    // emitted to a caller who never said they would accept it.
    const strict = strictOpenAiCompliance ?? true;

    return nameProvider(
      {
        ...read.body,
        choices: read.body.choices.map((choice: Record<string, any>) =>
          choice?.message && typeof choice.message === 'object'
            ? { ...choice, message: { ...choice.message, ...transformReasoning(choice.message, strict) } }
            : choice,
        ),
        ...(read.body.usage && { usage: { ...read.body.usage, ...transformUsageDetails(read.body.usage) } }),
      },
      provider,
    );
  };
};

const EmbedResponseTransformer = <T extends EmbedResponse | ErrorResponse>(
  provider: string,
  customTransformer?: CustomTransformer<EmbedResponse, T>,
) =>
  upstreamTransformer(provider, customTransformer) as (
    response: T | ErrorResponse,
    responseStatus: number,
  ) => EmbedResponse | ErrorResponse;

const CompleteResponseTransformer = <T extends OpenAICompleteResponse | ErrorResponse>(
  provider: string,
  customTransformer?: CustomTransformer<OpenAICompleteResponse, T>,
) =>
  upstreamTransformer(provider, customTransformer, { answersWithChoices: true }) as (
    response: T | ErrorResponse,
    responseStatus: number,
  ) => T | ErrorResponse;

const ChatCompleteResponseTransformer = <T extends OpenAIChatCompleteResponse | ErrorResponse>(
  provider: string,
  customTransformer?: CustomTransformer<OpenAIChatCompleteResponse, T>,
) =>
  upstreamTransformer(provider, customTransformer, { answersWithChoices: true }) as (
    response: T | ErrorResponse,
    responseStatus: number,
  ) => T | ErrorResponse;

const CreateSpeechResponseTransformer = <T extends Response | ErrorResponse>(
  provider: string,
  customTransformer?: CustomTransformer<Response | ErrorResponse, T>,
) =>
  upstreamTransformer(provider, customTransformer) as (
    response: T | ErrorResponse,
    responseStatus: number,
  ) => T | ErrorResponse;

export const OpenAICreateModelResponseTransformer = <T extends OpenAIResponse | ErrorResponse>(
  provider: string,
  customTransformer?: CustomTransformer<OpenAIResponse, T>,
) =>
  upstreamTransformer(provider, customTransformer) as (
    response: T | ErrorResponse,
    responseStatus: number,
  ) => T | ErrorResponse;

export const OpenAIGetModelResponseTransformer = <T extends OpenAIResponse | ErrorResponse>(
  provider: string,
  customTransformer?: CustomTransformer<OpenAIResponse, T>,
) =>
  upstreamTransformer(provider, customTransformer) as (
    response: T | ErrorResponse,
    responseStatus: number,
  ) => T | ErrorResponse;

export const OpenAIDeleteModelResponseTransformer = <T extends ModelResponseDeleteResponse | ErrorResponse>(
  provider: string,
  customTransformer?: CustomTransformer<ModelResponseDeleteResponse, T>,
) =>
  upstreamTransformer(provider, customTransformer) as (
    response: T | ErrorResponse,
    responseStatus: number,
  ) => T | ErrorResponse;

export const OpenAIListInputItemsResponseTransformer = <T extends ResponseItemList | ErrorResponse>(
  provider: string,
  customTransformer?: CustomTransformer<ResponseItemList, T>,
) =>
  upstreamTransformer(provider, customTransformer) as (
    response: T | ErrorResponse,
    responseStatus: number,
  ) => T | ErrorResponse;

/**
 *
 * @param provider Provider value
 * @param options Enable transformer functions to specific task (complete, chatComplete or embed)
 * @returns
 */
export const responseTransformers = <
  T extends EmbedResponse | ErrorResponse,
  U extends OpenAICompleteResponse | ErrorResponse,
  V extends OpenAIChatCompleteResponse | ErrorResponse,
  W extends Response | ErrorResponse,
>(
  provider: string,
  options: {
    embed?: boolean | CustomTransformer<EmbedResponse | ErrorResponse, T>;
    complete?: boolean | CustomTransformer<OpenAICompleteResponse | ErrorResponse, U>;
    chatComplete?: boolean | CustomTransformer<OpenAIChatCompleteResponse | ErrorResponse, V>;
    createSpeech?: boolean | CustomTransformer<Response | ErrorResponse, W>;
  },
) => {
  // eslint-disable-next-line @typescript-eslint/ban-types
  const transformers: Record<
    'complete' | 'chatComplete' | 'embed' | 'createSpeech',
    Function | null
  > = {
    complete: null,
    chatComplete: null,
    embed: null,
    createSpeech: null,
  };

  if (options.embed) {
    transformers.embed = EmbedResponseTransformer<T>(
      provider,
      typeof options.embed === 'function' ? options.embed : undefined,
    );
  }

  if (options.complete) {
    transformers.complete = CompleteResponseTransformer<U>(
      provider,
      typeof options.complete === 'function' ? options.complete : undefined,
    );
  }

  if (options.chatComplete) {
    transformers.chatComplete = ChatCompleteResponseTransformer<V>(
      provider,
      typeof options.chatComplete === 'function' ? options.chatComplete : undefined,
    );
  }
  if (options.createSpeech) {
    transformers.createSpeech = CreateSpeechResponseTransformer<W>(
      provider,
      typeof options.createSpeech === 'function' ? options.createSpeech : undefined,
    );
  }

  return transformers;
};

export const OpenAIResponseTransform = (
  response: Response | ErrorResponse,
  responseStatus: number,
  provider: string,
): Response | ErrorResponse => {
  const read = readProviderResponse(response, responseStatus, provider ?? OPEN_AI);

  return read.kind === 'failure' ? read.error : (read.body as Response);
};
