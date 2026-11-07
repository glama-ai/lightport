import { ANTHROPIC } from '../../globals';
import { ProviderConfigs } from '../types';
import AnthropicAPIConfig from './api';
import {
  AnthropicChatCompleteConfig,
  anthropicServiceTierParam,
  getAnthropicChatCompleteResponseTransform,
  getAnthropicStreamChunkTransform,
} from './chatComplete';
import {
  AnthropicCompleteConfig,
  AnthropicCompleteResponseTransform,
  AnthropicCompleteStreamChunkTransform,
} from './complete';
import { AnthropicMessagesConfig, AnthropicMessagesResponseTransform } from './messages';

const AnthropicConfig: ProviderConfigs = {
  complete: AnthropicCompleteConfig,
  // The tier is Anthropic's own API's alone; see `anthropicServiceTierParam`.
  chatComplete: { ...AnthropicChatCompleteConfig, service_tier: anthropicServiceTierParam },
  messages: AnthropicMessagesConfig,
  messagesCountTokens: AnthropicMessagesConfig,
  api: AnthropicAPIConfig,
  responseTransforms: {
    'stream-complete': AnthropicCompleteStreamChunkTransform,
    complete: AnthropicCompleteResponseTransform,
    chatComplete: getAnthropicChatCompleteResponseTransform(ANTHROPIC),
    messages: AnthropicMessagesResponseTransform,
    'stream-chatComplete': getAnthropicStreamChunkTransform(ANTHROPIC),
  },
};

export default AnthropicConfig;
