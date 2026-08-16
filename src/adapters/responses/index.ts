/**
 * Responses API Adapter
 *
 * Enables all providers to support the OpenAI Responses API by translating
 * to/from the Chat Completions format at the handler level.
 */

export {
  transformResponsesToChatCompletions,
  findUnsupportedResponsesFields,
} from './requestTransform';
export { transformChatCompletionsToResponses } from './responseTransform';
export { transformStreamChunk, createStreamState } from './streamTransform';

import Providers from '../../providers';

/**
 * Providers that serve the Responses API themselves, so no adapter is needed.
 *
 * Read from what each provider says about itself where it can say it, rather
 * than from this list alone. A provider declared with `nativeResponses` is
 * counted here without being named twice, which is what let the answer drift
 * from the provider it was about.
 */
const NATIVE_PROVIDERS = new Set(['openai', 'azure-openai', 'openrouter']);

export function supportsResponsesApiNatively(provider: string): boolean {
  const name = provider?.toLowerCase() || '';

  return NATIVE_PROVIDERS.has(name) || Boolean((Providers as Record<string, any>)[name]?.nativeResponses);
}
