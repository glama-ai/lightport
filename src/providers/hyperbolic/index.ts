import { HYPERBOLIC } from '../../globals';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';
import { HyperbolicChatCompleteStreamChunkTransform } from './chatComplete';
import {
  HyperbolicImageGenerateConfig,
  HyperbolicImageGenerateResponseTransform,
} from './imageGenerate';

// The sampling parameters Hyperbolic adds beyond OpenAI's, carried by both
// endpoints: the same models serve each, and naming them for one alone would
// drop them from the other while it passed them on.
const sampling = {
  top_k: { param: 'top_k', default: -1 },
  min_p: { param: 'min_p', default: 0, min: 0, max: 1 },
  repetition_penalty: { param: 'repetition_penalty', default: 1 },
};

const HyperbolicConfig = defineOpenAICompatibleProvider({
  name: HYPERBOLIC,
  baseURL: 'https://api.hyperbolic.xyz',
  endpoints: {
    chatComplete: { path: '/v1/chat/completions', defaultModel: null, extra: { ...sampling } },
    // Nothing is excluded, as for chat: Hyperbolic does not publish the
    // parameters its completions endpoint takes, and dropping one it does
    // accept would lose it silently where forwarding one it does not lets it
    // say so.
    complete: { path: '/v1/completions', defaultModel: null, extra: { ...sampling } },
    imageGenerate: { path: '/v1/image/generation', defaultModel: null },
  },
});

export default {
  ...HyperbolicConfig,
  imageGenerate: HyperbolicImageGenerateConfig,
  responseTransforms: {
    ...HyperbolicConfig.responseTransforms,
    'stream-chatComplete': HyperbolicChatCompleteStreamChunkTransform,
    imageGenerate: HyperbolicImageGenerateResponseTransform,
  },
};
