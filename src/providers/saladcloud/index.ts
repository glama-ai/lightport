import { chatCompleteParams } from '../open-ai-base';
import { ProviderConfigs } from '../types';
import SaladCloudAPIConfig from './api';
import {
  SaladCloudChatCompleteDefaults,
  SaladCloudChatCompleteExcludedParams,
  SaladCloudChatCompleteExtraParams,
  SaladCloudChatCompleteResponseTransform,
} from './chatComplete';

const SaladCloudConfig: ProviderConfigs = {
  chatComplete: chatCompleteParams(
    SaladCloudChatCompleteExcludedParams,
    SaladCloudChatCompleteDefaults,
    SaladCloudChatCompleteExtraParams,
  ),
  api: SaladCloudAPIConfig,
  responseTransforms: {
    chatComplete: SaladCloudChatCompleteResponseTransform,
  },
};

export default SaladCloudConfig;
