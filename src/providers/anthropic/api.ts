import { ProviderAPIConfig } from '../types';

type Params = Record<string, any>;

const AnthropicAPIConfig: ProviderAPIConfig = {
  getBaseURL: () => 'https://api.anthropic.com/v1',
  headers: ({ providerOptions, gatewayRequestBody, headers: requestHeaders }) => {
    const apiKey = providerOptions.apiKey || providerOptions.anthropicApiKey || '';
    const headers: Record<string, string | string[]> = {};

    if (!apiKey || apiKey.startsWith('sk-ant-')) {
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

    headers['anthropic-beta'] = betaHeader;
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
