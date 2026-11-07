import { GatewayError } from '../../errors/GatewayError';
import { ProviderAPIConfig } from '../types';

/*
  Where Hugging Face serves inference. The address this used to default to,
  `api-inference.huggingface.co`, no longer resolves, so every request that did
  not name its own base URL failed before it was sent. The router names the model
  in the body rather than the path, and its OpenAI-compatible endpoint is chat
  completions alone — Hugging Face says so, and serves the other tasks through
  its own clients rather than at an OpenAI path.
*/
const ROUTER_URL = 'https://router.huggingface.co';

const HuggingfaceAPIConfig: ProviderAPIConfig = {
  getBaseURL: ({ providerOptions }) => {
    return providerOptions.huggingfaceBaseUrl || ROUTER_URL;
  },
  headers: ({ providerOptions }) => ({
    Authorization: `Bearer ${providerOptions.apiKey}`,
  }),
  getEndpoint: ({ fn, providerOptions }) => {
    switch (fn) {
      case 'chatComplete':
        return '/v1/chat/completions';
      case 'complete':
        // A dedicated Inference Endpoint serves `/v1/completions`; the router
        // does not, and sent there the request would fail as an unknown path
        // rather than as a question with an answer.
        if (!providerOptions.huggingfaceBaseUrl) {
          throw new GatewayError(
            'Hugging Face serves text completions only from a dedicated Inference Endpoint; name it with huggingface_base_url',
            400,
          );
        }
        return '/v1/completions';
      default:
        return '';
    }
  },
};

export default HuggingfaceAPIConfig;
