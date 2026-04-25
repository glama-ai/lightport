import { EmbedParams } from '../../types/embedRequestBody';
import { ProviderConfig } from '../types';

export const FireworksAIEmbedConfig: ProviderConfig = {
  model: {
    param: 'model',
    required: true,
    default: 'nomic-ai/nomic-embed-text-v1.5',
  },
  input: {
    param: 'input',
    required: true,
    transform: (params: EmbedParams) => {
      if (Array.isArray(params.input)) {
        return params.input;
      }

      return [params.input];
    },
  },
  dimensions: {
    param: 'dimensions',
  },
};

