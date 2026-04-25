import { getHttpsAgent, getProxyAgent } from '../agentStore';

export async function externalServiceFetch(
  url: string,
  options?: RequestInit,
  proxyUrl?: string,
) {
  const agent = proxyUrl ? getProxyAgent(proxyUrl) : getHttpsAgent();
  return fetch(url, {
    ...options,
    ...(agent ? { dispatcher: agent } : {}),
  });
}
