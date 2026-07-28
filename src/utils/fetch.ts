import { getHttpsAgent, getProxyAgent } from '../agentStore';
import { getClientAbortSignal } from '../context/clientAbort';
import { fetch as undiciFetch, type Dispatcher } from 'undici';

type DispatcherRequestInit = RequestInit & { dispatcher?: Dispatcher };

/**
 * `undici`'s own fetch, typed in the DOM vocabulary the rest of the gateway is
 * written against.
 *
 * The dispatchers below come from this package's `undici`; the global `fetch` is
 * a *different*, older copy bundled into Node. Each rejects the other's request
 * handler outright — `InvalidArgumentError: invalid onRequestStart method` — so
 * every outbound call fails with a 500 inside a millisecond. A dispatcher only
 * exists when TLS, a proxy or `REQUEST_TIMEOUT` is configured, which is why
 * deployments without any of those never notice and the ones that configure any
 * of them see nothing else. Calling the matching fetch keeps both halves of the
 * exchange in one copy of undici.
 */
const dispatcherAwareFetch = undiciFetch as unknown as (
  url: string,
  init?: DispatcherRequestInit,
) => Promise<Response>;

export async function externalServiceFetch(url: string, options?: RequestInit, proxyUrl?: string) {
  const agent = proxyUrl ? getProxyAgent(proxyUrl) : getHttpsAgent();

  // Every outbound request is cancelled when the caller hangs up, without each
  // call site having to ask for it: a provider goes on billing for tokens it
  // generates after the caller has walked away, and this is the one place all of
  // them pass through.
  const signals = [options?.signal, getClientAbortSignal()].filter(
    (signal): signal is AbortSignal => Boolean(signal),
  );

  return dispatcherAwareFetch(url, {
    ...options,
    ...(signals.length > 0 && { signal: AbortSignal.any(signals) }),
    ...(agent ? { dispatcher: agent } : {}),
  });
}
