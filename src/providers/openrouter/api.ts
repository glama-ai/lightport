import { POWERED_BY } from '../../globals';
import { ProviderAPIConfig } from '../types';

const OpenrouterAPIConfig: ProviderAPIConfig = {
  getBaseURL: () => 'https://openrouter.ai/api',
  headers: ({ providerOptions }) => {
    return {
      Authorization: `Bearer ${providerOptions.apiKey}`, // https://openrouter.ai/keys
      'HTTP-Referer': 'https://lightport.ai/',
      'X-Title': POWERED_BY,
    };
  },
  getEndpoint: ({ fn }) => {
    switch (fn) {
      case 'chatComplete':
        return '/v1/chat/completions';
      case 'createModelResponse':
        return '/v1/responses';
      case 'imageGenerate':
        return '/v1/images';
      default:
        return '';
    }
  },
};

export default OpenrouterAPIConfig;
