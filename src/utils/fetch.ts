import { getHttpsAgent, getProxyAgent } from '../agentStore';
import { getClientAbortSignal } from '../context/clientAbort';

export async function externalServiceFetch(url: string, options?: RequestInit, proxyUrl?: string) {
  const agent = proxyUrl ? getProxyAgent(proxyUrl) : getHttpsAgent();

  // Every outbound request is cancelled when the caller hangs up, without each
  // call site having to ask for it: a provider goes on billing for tokens it
  // generates after the caller has walked away, and this is the one place all of
  // them pass through.
  const signals = [options?.signal, getClientAbortSignal()].filter(
    (signal): signal is AbortSignal => Boolean(signal),
  );

  return fetch(url, {
    ...options,
    ...(signals.length > 0 && { signal: AbortSignal.any(signals) }),
    ...(agent ? { dispatcher: agent } : {}),
  });
}
