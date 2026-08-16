import { POWERED_BY } from '../globals';
import Providers from '.';

/**
 * Providers registered but not published.
 *
 * A provider reaches a caller by being two things at once: a key in the
 * registry and a name this list does not hold back. Kept as the exceptions
 * rather than as the permissions, so that registering a provider publishes it
 * and holding one back is the part somebody has to write down.
 *
 * Eleven providers were registered and left out of the old hand-kept list of
 * allowed names — reachable by nothing, with nothing saying so. Each is named
 * here now, and taking a name off this list is what publishes it.
 */
const UNPUBLISHED = new Set([
  '302ai',
  'bytez',
  'cometapi',
  'matterai',
  'meshy',
  'milvus',
  'nextbit',
  'qdrant',
  'replicate',
  'tripo3d',
  'z-ai',
]);

/**
 * The names a caller is allowed to ask for.
 *
 * Read from the registry rather than kept beside it. The two were maintained by
 * hand and drifted, which a caller only ever learns as `Invalid provider
 * passed` naming a provider this gateway does in fact carry.
 */
export const VALID_PROVIDERS = [
  ...Object.keys(Providers).filter((name) => !UNPUBLISHED.has(name)),
  // Not a provider. A config may name the gateway itself as the target.
  POWERED_BY,
];
