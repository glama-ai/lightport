import { ProxyAgent, Agent as UndiciAgent } from 'undici';

export interface AgentConfig {
  tls?: {
    key?: string;
    cert?: string;
    ca?: string[];
  };
}

let httpsAgent: UndiciAgent | undefined;
let requestTimeout: number | undefined;

const proxyAgentCache = new Map<string, ProxyAgent>();

export function getProxyAgent(proxyUrl: string): ProxyAgent {
  let agent = proxyAgentCache.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent({
      allowH2: false,
      uri: proxyUrl,
      ...(requestTimeout ? { headersTimeout: requestTimeout, bodyTimeout: requestTimeout } : {}),
    });
    proxyAgentCache.set(proxyUrl, agent);
  }
  return agent;
}

export function getHttpsAgent(): UndiciAgent | undefined {
  return httpsAgent;
}

export function buildAgents(agentConfig: AgentConfig) {
  const { Environment } = require('./utils/env');
  const env = Environment({});

  requestTimeout =
    env?.REQUEST_TIMEOUT && parseInt(env.REQUEST_TIMEOUT)
      ? parseInt(env.REQUEST_TIMEOUT)
      : undefined;

  if (agentConfig.tls) {
    httpsAgent = new UndiciAgent({
      allowH2: false,
      ...(requestTimeout ? { headersTimeout: requestTimeout, bodyTimeout: requestTimeout } : {}),
      connect: agentConfig.tls,
    });
  } else if (requestTimeout) {
    httpsAgent = new UndiciAgent({
      allowH2: false,
      headersTimeout: requestTimeout,
      bodyTimeout: requestTimeout,
    });
  }
}
