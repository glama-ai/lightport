import { IO_INTELLIGENCE } from '../../globals';
import { createModelResponseParams } from '../open-ai-base';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';

const IOIntelligenceConfig = defineOpenAICompatibleProvider({
  name: IO_INTELLIGENCE,
  baseURL: 'https://api.intelligence.io.solutions/api',
  endpoints: {
    chatComplete: { path: '/v1/chat/completions', defaultModel: null },
    embed: { path: '/v1/embeddings', defaultModel: null },
  },
});

export default {
  ...IOIntelligenceConfig,
  // Served by the same chat endpoint, so the path is named again rather than
  // the declaration pretending this is an endpoint of its own.
  createModelResponse: createModelResponseParams([]),
  getModelResponse: {},
  listModelsResponse: {},
  api: {
    ...IOIntelligenceConfig.api,
    getEndpoint: (args: { fn: string; [key: string]: any }) =>
      args.fn === 'createModelResponse'
        ? '/v1/chat/completions'
        : IOIntelligenceConfig.api.getEndpoint(args),
  },
};
