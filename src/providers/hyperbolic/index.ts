import { HYPERBOLIC } from '../../globals';
import { chatCompleteParams, completeParams, responseTransformers } from '../open-ai-base';
import { ProviderConfigs } from '../types';
import HyperbolicAPIConfig from './api';
import { HyperbolicChatCompleteStreamChunkTransform } from './chatComplete';
import {
  HyperbolicImageGenerateConfig,
  HyperbolicImageGenerateResponseTransform,
} from './imageGenerate';

const HyperbolicConfig: ProviderConfigs = {
  chatComplete: chatCompleteParams(
    [],
    {},
    {
      top_k: { param: 'top_k', default: -1 },
      min_p: { param: 'min_p', default: 0, min: 0, max: 1 },
      repetition_penalty: { param: 'repetition_penalty', default: 1 },
    },
  ),
  // Nothing is excluded, as for chat above: Hyperbolic does not publish the
  // parameters its completions endpoint takes, and dropping one it does accept
  // would lose it silently where forwarding one it does not lets it say so. The
  // sampling parameters chat adds are carried here for the same reason — the two
  // endpoints are served by the same models, and leaving them out would drop
  // them from one while the other passes them on.
  complete: completeParams(
    [],
    {},
    {
      top_k: { param: 'top_k', default: -1 },
      min_p: { param: 'min_p', default: 0, min: 0, max: 1 },
      repetition_penalty: { param: 'repetition_penalty', default: 1 },
    },
  ),
  imageGenerate: HyperbolicImageGenerateConfig,
  api: HyperbolicAPIConfig,
  responseTransforms: {
    ...responseTransformers(HYPERBOLIC, {
      chatComplete: true,
      complete: true,
    }),
    'stream-chatComplete': HyperbolicChatCompleteStreamChunkTransform,
    imageGenerate: HyperbolicImageGenerateResponseTransform,
  },
};

export default HyperbolicConfig;
