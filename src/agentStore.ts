import { Environment } from './utils/env';
import { ProxyAgent, Agent as UndiciAgent } from 'undici';

export interface AgentConfig {
  tls?: {
    key?: string;
    cert?: string;
    ca?: string[];
  };
}

let httpsAgent: UndiciAgent | undefined;

const proxyAgentCache = new Map<string, ProxyAgent>();

/**
 * Resolved on each use rather than captured by `buildAgents`.
 *
 * A module-level copy written only by `buildAgents` left `getProxyAgent` reading
 * `undefined` whenever it ran first, giving a proxied request no timeouts at all
 * — the same shape of bug as the dispatcher fork below, one caller along.
 */
const resolveRequestTimeout = (): number | undefined => {
  const configured = Environment({})?.REQUEST_TIMEOUT;
  const parsed = configured ? parseInt(configured) : Number.NaN;

  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

export function getProxyAgent(proxyUrl: string): ProxyAgent {
  let agent = proxyAgentCache.get(proxyUrl);

  if (!agent) {
    const requestTimeout = resolveRequestTimeout();

    agent = new ProxyAgent({
      // `allowH2` is left unset here for the same reason as below. It governs
      // only the tunnelled connection to the provider: undici always speaks
      // http/1.1 to the proxy itself, CONNECT being an http/1.1 method, and
      // then hands the socket to a connector chosen by this option. Forcing it
      // false meant a proxied deployment could not reach a provider over h2
      // even where a direct one could.
      uri: proxyUrl,
      ...(requestTimeout ? { headersTimeout: requestTimeout, bodyTimeout: requestTimeout } : {}),
    });

    proxyAgentCache.set(proxyUrl, agent);
  }

  return agent;
}

const createHttpsAgent = (agentConfig: AgentConfig): UndiciAgent => {
  const requestTimeout = resolveRequestTimeout();

  return new UndiciAgent({
    // `allowH2` is deliberately not set: undici defaults it to true, which
    // offers h2 alongside http/1.1 in ALPN and leaves the choice to the
    // provider. Setting it false here forced http/1.1, and did so for only
    // those deployments that reached this code at all — see `getHttpsAgent`.
    ...(requestTimeout ? { headersTimeout: requestTimeout, bodyTimeout: requestTimeout } : {}),
    ...(agentConfig.tls ? { connect: agentConfig.tls } : {}),
  });
};

/**
 * The dispatcher every provider request goes out on.
 *
 * There used to be none unless TLS or `REQUEST_TIMEOUT` was configured, and with
 * no dispatcher undici falls back to its own process-global one. Two deployments
 * of the same commit therefore reached providers over different connection
 * pools, under different timeouts, and — because undici defaults `allowH2` to
 * true where the agent built here forced it false — over a different version of
 * HTTP, all decided by whether a timeout happened to be set.
 *
 * Built on demand so that callers constructing the app themselves, `app.inject`
 * and the tests among them, go out the same way the server does.
 */
export function getHttpsAgent(): UndiciAgent {
  httpsAgent ??= createHttpsAgent({});

  return httpsAgent;
}

export function buildAgents(agentConfig: AgentConfig) {
  httpsAgent = createHttpsAgent(agentConfig);
}
