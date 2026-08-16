import { KLUSTER_AI } from '../../globals';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';
import { KlusterAIResponseTransform } from './chatComplete';
import { KlusterAIRequestTransform } from './uploadFile';

const KlusterAIConfig = defineOpenAICompatibleProvider({
  name: KLUSTER_AI,
  baseURL: 'https://api.kluster.ai',
  headers: () => ({ 'Content-Type': 'application/json' }),
  endpoints: {
    chatComplete: {
      path: '/v1/chat/completions',
      defaultModel: 'klusterai/Meta-Llama-3.1-8B-Instruct-Turbo',
      extra: {
        store: { param: 'store' },
        metadata: { param: 'metadata', required: true },
      },
    },
    embed: {
      path: '/v1/embeddings',
      defaultModel: 'klusterai/Meta-Llama-3.1-8B-Instruct-Turbo',
    },
  },
});

export default {
  ...KlusterAIConfig,
  api: {
    ...KlusterAIConfig.api,
    getEndpoint: (args: { fn: string; [key: string]: any }) =>
      args.fn === 'uploadFile' ? '/v1/files' : KlusterAIConfig.api.getEndpoint(args),
  },
  responseTransforms: {
    ...KlusterAIConfig.responseTransforms,
    uploadFile: KlusterAIResponseTransform,
  },
  requestTransforms: { uploadFile: KlusterAIRequestTransform },
};
