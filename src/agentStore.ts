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

const parseTimeout = (value: string | undefined): number | undefined => {
  const parsed = value ? parseInt(value) : Number.NaN;

  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

// undici defaults headersTimeout to 300s when unset, which outlives most
// callers' own timeouts -- a silently dead connection (no RST, no data) never
// gets flagged as bad and stays in the pool. This floor makes undici notice on
// its own even when nothing is configured.
const DEFAULT_HEADERS_TIMEOUT = 120_000;

/**
 * `HEADERS_TIMEOUT`/`BODY_TIMEOUT` take over their own concern from
 * `REQUEST_TIMEOUT` when set, since the two mean different things:
 * time-to-headers is transport liveness (this connection has gone silent),
 * while a reasoning model can legitimately go quiet between body chunks far
 * longer than any connection should stay silent before responding at all.
 * `REQUEST_TIMEOUT` alone still sets both, unchanged, for whatever already
 * depends on that.
 */
export const resolveTransportTimeoutsFrom = (env: {
  REQUEST_TIMEOUT?: string;
  HEADERS_TIMEOUT?: string;
  BODY_TIMEOUT?: string;
}): { headersTimeout: number; bodyTimeout?: number } => {
  const requestTimeout = parseTimeout(env.REQUEST_TIMEOUT);
  const bodyTimeout = parseTimeout(env.BODY_TIMEOUT) ?? requestTimeout;

  return {
    headersTimeout: parseTimeout(env.HEADERS_TIMEOUT) ?? requestTimeout ?? DEFAULT_HEADERS_TIMEOUT,
    ...(bodyTimeout ? { bodyTimeout } : {}),
  };
};

/**
 * Resolved on each use rather than captured by `buildAgents`.
 *
 * A module-level copy written only by `buildAgents` left `getProxyAgent` reading
 * stale values whenever it ran first, giving a proxied request no timeouts at
 * all — the same shape of bug as the dispatcher fork below, one caller along.
 */
const resolveTransportTimeouts = (): { headersTimeout: number; bodyTimeout?: number } => {
  return resolveTransportTimeoutsFrom(Environment({}) ?? {});
};

export function getProxyAgent(proxyUrl: string): ProxyAgent {
  let agent = proxyAgentCache.get(proxyUrl);

  if (!agent) {
    agent = new ProxyAgent({
      // `allowH2` is left unset here for the same reason as below. It governs
      // only the tunnelled connection to the provider: undici always speaks
      // http/1.1 to the proxy itself, CONNECT being an http/1.1 method, and
      // then hands the socket to a connector chosen by this option. Forcing it
      // false meant a proxied deployment could not reach a provider over h2
      // even where a direct one could.
      uri: proxyUrl,
      ...resolveTransportTimeouts(),
    });

    proxyAgentCache.set(proxyUrl, agent);
  }

  return agent;
}

const createHttpsAgent = (agentConfig: AgentConfig): UndiciAgent => {
  return new UndiciAgent({
    // `allowH2` is deliberately not set: undici defaults it to true, which
    // offers h2 alongside http/1.1 in ALPN and leaves the choice to the
    // provider. Setting it false here forced http/1.1, and did so for only
    // those deployments that reached this code at all — see `getHttpsAgent`.
    ...resolveTransportTimeouts(),
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
