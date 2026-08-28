import { EMPIRIOLABS } from '../../globals';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';

/**
 * EmpirioLabs AI, serving text, image, audio and video models. Part of the
 * catalogue runs on GPU infrastructure EmpirioLabs operates itself.
 *
 * No default model: its catalogue names models for the house that made them, so
 * there is no bare name to fall back to and nothing sensible to choose on a
 * caller's behalf. A request naming none is answered by EmpirioLabs itself,
 * saying which field it wanted.
 *
 * Text completions take the published list and nothing wider: model, prompt,
 * stream, temperature, max_tokens, top_p, stop, logit_bias. The remaining
 * OpenAI completion parameters are excluded rather than assumed, since the
 * endpoint being OpenAI-shaped is not a statement about which of them it reads.
 */
const EmpirioLabsConfig = defineOpenAICompatibleProvider({
  name: EMPIRIOLABS,
  baseURL: 'https://api.empiriolabs.ai',
  endpoints: {
    chatComplete: { path: '/v1/chat/completions', defaultModel: null },
    complete: {
      path: '/v1/completions',
      defaultModel: null,
      exclude: [
        'n',
        'logprobs',
        'echo',
        'presence_penalty',
        'frequency_penalty',
        'best_of',
        'user',
        'seed',
        'suffix',
      ],
    },
    // Most of the catalogue is generation rather than chat.
    imageGenerate: { path: '/v1/images/generations', defaultModel: null },
    embed: { path: '/v1/embeddings', defaultModel: null },
  },
});

export default EmpirioLabsConfig;
