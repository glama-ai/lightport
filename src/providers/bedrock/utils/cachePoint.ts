import { BedrockCachePoint } from '../types';

/**
 * A Bedrock cache point carrying the lifetime the caller asked for.
 *
 * Dropping `ttl` does not fail the request — it quietly hands the caller the 5
 * minute default instead of the hour they wrote. Worse, once one checkpoint has
 * lost its hour, a later block that kept its own is rejected outright for coming
 * after a `5m` one.
 *
 * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_CachePointBlock.html
 */
export const getCachePoint = (cacheControl?: { ttl?: string } | null): BedrockCachePoint => ({
  cachePoint: {
    type: 'default',
    ...(cacheControl?.ttl && { ttl: cacheControl.ttl }),
  },
});
