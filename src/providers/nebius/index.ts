import { NEBIUS } from '../../globals';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';

/**
 * Nebius, served from Token Factory.
 *
 * `api.studio.nebius.ai` is the host of AI Studio, which Token Factory replaced;
 * Nebius documents only the new one. No model is defaulted: the ones that were
 * are absent from Token Factory's catalog, so a request naming none went to a
 * model that is gone rather than being told to name one.
 */
const NebiusConfig = defineOpenAICompatibleProvider({
  name: NEBIUS,
  baseURL: 'https://api.tokenfactory.nebius.com',
  endpoints: {
    chatComplete: { path: '/v1/chat/completions', defaultModel: null },
    complete: { path: '/v1/completions', defaultModel: null },
    embed: { path: '/v1/embeddings', defaultModel: null },
  },
});

export default NebiusConfig;
