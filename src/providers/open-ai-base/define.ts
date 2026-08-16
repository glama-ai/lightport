import { OpenAIImageGenerateConfig } from '../openai/imageGenerate';
import { OpenAIImageResponseTransform } from '../openai/utils';
import { ProviderAPIConfig, ProviderConfig, ProviderConfigs } from '../types';
import { chatCompleteParams, completeParams, embedParams, responseTransformers } from '.';

/**
 * A path, or how to work one out.
 *
 * Most are a constant. A few providers put the model in the path itself, which
 * is theirs to build.
 */
type Path = string | ((args: { gatewayRequestBodyJSON: any; [key: string]: any }) => string);

/**
 * An endpoint that takes a model, and the model to send when the caller names
 * none.
 *
 * `defaultModel` has no default of its own: leaving it off is a type error
 * rather than a silent inheritance of OpenAI's `gpt-3.5-turbo`, which is what
 * eleven providers are sending today for a request that names no model.
 *
 * `null` is a legitimate answer — it means this provider has no sensible
 * default, so nothing is sent and the provider says so itself. Its complaint
 * reaches the caller readable, which is the one thing that was missing.
 */
type ModelEndpoint = {
  path: Path;
  defaultModel: string | null;
  /** Parameters of OpenAI's this provider does not take. */
  exclude?: string[];
  /** Parameters this provider takes that OpenAI does not. */
  extra?: ProviderConfig;
};

type Endpoint = { path: Path };

export interface OpenAICompatibleProvider {
  /** The slug the caller names in `x-lightport-provider`. */
  name: string;
  /**
   * The host, with no version segment.
   *
   * A custom host replaces the base URL whole, so a `/v1` written in here
   * vanishes for any caller who supplies one and the request goes to a path the
   * provider does not serve. The version belongs in each endpoint's path.
   *
   * A function for the providers whose host is the caller's to name — a
   * workspace or a region they configure.
   */
  baseURL: string | ((args: { providerOptions: any; [key: string]: any }) => string);
  /**
   * Only what this provider actually serves.
   *
   * Naming an endpoint it does not serve misroutes a request; leaving out one
   * it does serve refuses a request that would have worked. Both are decisions,
   * so both are written down.
   */
  endpoints: {
    chatComplete?: ModelEndpoint;
    complete?: ModelEndpoint;
    embed?: ModelEndpoint;
    imageGenerate?: ModelEndpoint;
  };
  /** Headers beyond the bearer token, which is always sent. */
  headers?: (args: { providerOptions: { apiKey?: string; [key: string]: any } }) => Record<
    string,
    string
  >;
  /**
   * Whether the provider serves `/v1/responses` itself.
   *
   * Left off, a Responses request is translated into a chat completion, and the
   * caller is told so when they use a field translation cannot carry.
   */
  nativeResponses?: boolean;
}

const VERSION_SUFFIX = /\/v\d+\/?$/;

/**
 * A provider that speaks OpenAI's API, declared rather than assembled.
 *
 * Every provider of this kind was written by copying the last one, which copied
 * the one before it. What copied cleanly was the shape; what did not were the
 * decisions nobody restated — the default model, which endpoints the upstream
 * really serves, whether the version segment was in the right half of the URL.
 * Each of those is a field here, and the ones that cannot be guessed have no
 * default, so the compiler asks rather than the reviewer.
 */
export const defineOpenAICompatibleProvider = (
  provider: OpenAICompatibleProvider,
): ProviderConfigs => {
  const { name, baseURL, endpoints, headers, nativeResponses } = provider;

  // Thrown where it is written rather than reported where it is used: a
  // provider assembled wrongly cannot serve any request, so failing to start is
  // both the earliest and the clearest place to say so.
  if (typeof baseURL === 'string' && VERSION_SUFFIX.test(baseURL)) {
    throw new Error(
      `${name}: the version segment belongs in each endpoint path, not in baseURL (${baseURL}). ` +
        'A custom host replaces the base URL whole and would drop it.',
    );
  }

  for (const [fn, endpoint] of Object.entries(endpoints)) {
    if (typeof endpoint.path === 'string' && !endpoint.path.startsWith('/')) {
      throw new Error(`${name}: the ${fn} path must start with a slash, and is "${endpoint.path}".`);
    }
  }

  const api: ProviderAPIConfig = {
    getBaseURL: (args) => (typeof baseURL === 'string' ? baseURL : baseURL(args)),
    headers: ({ providerOptions }) => ({
      // Sent only when there is a key to send. `Bearer undefined` is a header
      // the provider has to reject on its own terms, and some read a credential
      // from elsewhere when none is named here.
      ...(providerOptions.apiKey && { Authorization: `Bearer ${providerOptions.apiKey}` }),
      ...headers?.({ providerOptions }),
    }),
    getEndpoint: (args) => {
      const path = (endpoints as Record<string, Endpoint | undefined>)[args.fn]?.path;
      if (path === undefined) return '';

      return typeof path === 'string' ? path : path(args);
    },
  };

  // `model: undefined` is not the same as saying nothing: it replaces the
  // default this base carries from OpenAI's own config, which is how a request
  // naming no model came to be sent as `gpt-3.5-turbo`.
  const models = (endpoint: ModelEndpoint) => ({ model: endpoint.defaultModel ?? undefined });

  return {
    ...(endpoints.chatComplete && {
      chatComplete: chatCompleteParams(
        endpoints.chatComplete.exclude ?? [],
        models(endpoints.chatComplete),
        endpoints.chatComplete.extra,
      ),
    }),
    ...(endpoints.complete && {
      complete: completeParams(
        endpoints.complete.exclude ?? [],
        models(endpoints.complete),
        endpoints.complete.extra,
      ),
    }),
    ...(endpoints.embed && {
      embed: embedParams(
        endpoints.embed.exclude ?? [],
        models(endpoints.embed),
        endpoints.embed.extra,
      ),
    }),
    ...(endpoints.imageGenerate && {
      imageGenerate: {
        ...OpenAIImageGenerateConfig,
        // Replaced rather than inherited, as for chat: OpenAI's config defaults
        // this to `dall-e-2`, which no other provider serves.
        model: { ...OpenAIImageGenerateConfig.model, default: endpoints.imageGenerate.defaultModel ?? undefined },
        ...endpoints.imageGenerate.extra,
      },
    }),
    api,
    responseTransforms: {
      ...responseTransformers(name, {
        chatComplete: Boolean(endpoints.chatComplete),
        complete: Boolean(endpoints.complete),
        embed: Boolean(endpoints.embed),
      }),
      ...(endpoints.imageGenerate && {
        imageGenerate: (response: any, responseStatus: number) =>
          OpenAIImageResponseTransform(response, responseStatus, name),
      }),
    },
    // Read by the Responses adapter rather than a second list it keeps of its
    // own, which is where the answer went out of step with the provider.
    nativeResponses: Boolean(nativeResponses),
  };
};
