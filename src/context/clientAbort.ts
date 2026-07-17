import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<AbortSignal>();

/**
 * Carries the caller's abort signal for the life of a request.
 *
 * Handing the signal to each provider call by argument means every call site has
 * to remember to opt in, and they don't — the batch and upload helpers each
 * reach for `externalServiceFetch` directly. Keeping it here instead lets the
 * transport pick it up ambiently, so an outbound request is cancellable whether
 * or not its author thought about cancellation.
 */
export const runWithClientAbort = <T>(signal: AbortSignal, callback: () => T): T => {
  return storage.run(signal, callback);
};

export const getClientAbortSignal = (): AbortSignal | undefined => {
  return storage.getStore();
};
