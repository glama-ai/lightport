import { chatCompleteParams } from '../open-ai-base';
import { ProviderConfigs } from '../types';
import RequestyAPIConfig from './api';
import { RequestyChatCompleteResponseTransform } from './chatComplete';

const RequestyConfig: ProviderConfigs = {
  // Requesty reads OpenAI's parameters under their own names, `reasoning_effort`
  // among them, so nothing is excluded. Its models are named
  // for the house that made them, and a request that names none would otherwise
  // fall to the bare `gpt-3.5-turbo` this base carries, which Requesty has no
  // way to route.
  chatComplete: chatCompleteParams([], { model: 'openai/gpt-4o-mini' }),
  api: RequestyAPIConfig,
  responseTransforms: {
    chatComplete: RequestyChatCompleteResponseTransform,
  },
};

export default RequestyConfig;
