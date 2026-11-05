import { ProviderAPIConfig } from '../types';

type Params = Record<string, any>;

const OAUTH_TOKEN_PREFIX = 'sk-ant-oat';
const OAUTH_BETA = 'oauth-2025-04-20';

// `anthropic-beta` is a comma-separated list, and the caller's own betas stay.
const withBeta = (header: string | string[], beta: string) => {
  const betas = (Array.isArray(header) ? header : [header])
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean);

  return (betas.includes(beta) ? betas : [...betas, beta]).join(',');
};

const AnthropicAPIConfig: ProviderAPIConfig = {
  getBaseURL: () => 'https://api.anthropic.com/v1',
  headers: ({ providerOptions, gatewayRequestBody, headers: requestHeaders }) => {
    const apiKey = providerOptions.apiKey || providerOptions.anthropicApiKey || '';
    const headers: Record<string, string | string[]> = {};
    // An OAuth access token is an `sk-ant-` token too, so it matched the test
    // for an API key and went out as one, which Anthropic refuses. It is sent as
    // a bearer token, with the beta that tells Anthropic to read it as one.
    const isOAuthToken = apiKey.startsWith(OAUTH_TOKEN_PREFIX);

    if (!apiKey || (apiKey.startsWith('sk-ant-') && !isOAuthToken)) {
      headers['X-API-Key'] = apiKey;
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    // Accept anthropic_beta and anthropic_version in body to support environments which cannot send it in headers.
    const betaHeader =
      providerOptions?.['anthropicBeta'] ??
      (gatewayRequestBody as Params)?.['anthropic_beta'] ??
      requestHeaders?.['anthropic-beta'] ??
      'messages-2023-12-15';
    const version =
      providerOptions?.['anthropicVersion'] ??
      (gatewayRequestBody as Params)?.['anthropic_version'] ??
      requestHeaders?.['anthropic-version'] ??
      '2023-06-01';

    headers['anthropic-beta'] = isOAuthToken ? withBeta(betaHeader, OAUTH_BETA) : betaHeader;
    headers['anthropic-version'] = version;
    return headers;
  },
  getEndpoint: ({ fn }) => {
    switch (fn) {
      case 'complete':
        return '/complete';
      case 'chatComplete':
        return '/messages';
      case 'messages':
        return '/messages';
      case 'messagesCountTokens':
        return '/messages/count_tokens';
      default:
        return '';
    }
  },
};

export default AnthropicAPIConfig;
