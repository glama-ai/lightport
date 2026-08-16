import { embedParams } from '../open-ai-base';
import { ProviderConfig } from '../types';

/**
 * CometAPI's own embedding parameters, built rather than borrowed.
 *
 * This was OpenAI's very config object, held by both providers at once. Writing
 * a default into it here would have written it for OpenAI too, and the default
 * it already carried — `text-embedding-ada-002` — was being sent to CometAPI as
 * though CometAPI had chosen it.
 */
export const CometAPIEmbedConfig: ProviderConfig = embedParams([], { model: undefined });
