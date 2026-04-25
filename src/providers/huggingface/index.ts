import { ProviderConfigs } from '../types';
import HuggingfaceAPIConfig from './api';
import {
  HuggingfaceChatCompleteConfig,
  HuggingfaceChatCompleteResponseTransform,
  HuggingfaceChatCompleteStreamChunkTransform,
} from './chatComplete';
import {
  HuggingfaceCompleteConfig,
  HuggingfaceCompleteResponseTransform,
  HuggingfaceCompleteStreamChunkTransform,
} from './complete';

const HuggingfaceConfig: ProviderConfigs = {
  complete: HuggingfaceCompleteConfig,
  api: HuggingfaceAPIConfig,
  chatComplete: HuggingfaceChatCompleteConfig,
  responseTransforms: {
    complete: HuggingfaceCompleteResponseTransform,
    'stream-complete': HuggingfaceCompleteStreamChunkTransform,
    chatComplete: HuggingfaceChatCompleteResponseTransform,
    'stream-chatComplete': HuggingfaceChatCompleteStreamChunkTransform,
  },
};

export default HuggingfaceConfig;
