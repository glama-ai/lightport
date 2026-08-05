import { ProviderAPIConfig } from '../types';

const WorkersAiAPIConfig: ProviderAPIConfig = {
  // The base stops at `/ai`, so that the endpoint below can name the route it
  // wants. Chat completions are served at one address for every model, with the
  // model named in the body; everything else is still addressed by naming the
  // model in the path.
  getBaseURL: ({ providerOptions }) => {
    const { workersAiAccountId } = providerOptions;
    return `https://api.cloudflare.com/client/v4/accounts/${workersAiAccountId}/ai`;
  },
  headers: ({ providerOptions }) => {
    const { apiKey } = providerOptions;
    return { Authorization: `Bearer ${apiKey}` };
  },
  getEndpoint: ({ fn, gatewayRequestBodyJSON: params }) => {
    const { model } = params;
    switch (fn) {
      // Cloudflare's OpenAI-shaped route, which answers in the shape the rest of
      // the gateway already speaks — a tool call under the name the adapters
      // read, and a reason for stopping, which the route it replaces gives no
      // way to report.
      case 'chatComplete': {
        return '/v1/chat/completions';
      }
      case 'complete': {
        return `/run/${model}`;
      }
      case 'embed': {
        return `/run/${model}`;
      }
      case 'imageGenerate': {
        return `/run/${model}`;
      }
      default:
        return '';
    }
  },
};

export default WorkersAiAPIConfig;
