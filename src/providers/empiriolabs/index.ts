import { EMPIRIOLABS } from '../../globals';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';

/**
 * EmpirioLabs, an aggregator serving models from some thirty houses.
 *
 * No default model: its catalogue names models for the house that made them, so
 * there is no bare name to fall back to and nothing sensible to choose on a
 * caller's behalf. A request naming none is answered by EmpirioLabs itself,
 * saying which field it wanted.
 *
 * Text completions are left out. The route answers, but which parameters it
 * takes is not published, and forwarding a list assumed from the endpoint being
 * OpenAI-shaped is the guess this file exists to avoid making.
 */
const EmpirioLabsConfig = defineOpenAICompatibleProvider({
  name: EMPIRIOLABS,
  baseURL: 'https://api.empiriolabs.ai',
  endpoints: {
    chatComplete: { path: '/v1/chat/completions', defaultModel: null },
    // Most of the catalogue is generation rather than chat.
    imageGenerate: { path: '/v1/images/generations', defaultModel: null },
    embed: { path: '/v1/embeddings', defaultModel: null },
  },
});

export default EmpirioLabsConfig;
