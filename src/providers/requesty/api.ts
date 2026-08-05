import { POWERED_BY } from '../../globals';
import { ProviderAPIConfig } from '../types';

const RequestyAPIConfig: ProviderAPIConfig = {
  getBaseURL: () => 'https://router.requesty.ai/v1',
  headers: ({ providerOptions }) => {
    return {
      Authorization: `Bearer ${providerOptions.apiKey}`, // https://app.requesty.ai/api-keys
      // Requesty reads these to attribute a request in its own dashboard. They
      // are optional there, and named as OpenRouter names them.
      'HTTP-Referer': 'https://lightport.ai/',
      'X-Title': POWERED_BY,
    };
  },
  getEndpoint: ({ fn }) => {
    switch (fn) {
      case 'chatComplete':
        return '/chat/completions';
      default:
        return '';
    }
  },
};

export default RequestyAPIConfig;
