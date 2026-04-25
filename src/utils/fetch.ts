import { getExternalHttpsAgentForUrl } from '../agentStore';

export async function externalServiceFetch(url: string, options?: RequestInit) {
  const agent = getExternalHttpsAgentForUrl(url);
  return fetch(url, {
    ...options,
    ...(agent ? { dispatcher: agent } : {}),
  });
}
