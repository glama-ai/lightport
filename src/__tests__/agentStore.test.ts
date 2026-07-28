import { buildAgents, getHttpsAgent, getProxyAgent } from '../agentStore';
import { Agent as UndiciAgent, ProxyAgent } from 'undici';
import { describe, expect, it } from 'vitest';

/**
 * The dispatcher used to exist only when TLS or REQUEST_TIMEOUT was configured,
 * and with no dispatcher undici quietly uses its own process-global one. What
 * these cover is that there is always one, whatever the configuration, because
 * the alternative is two deployments of the same commit reaching providers over
 * different pools, timeouts and versions of HTTP.
 */

/** undici records `allowH2` here only when it is set explicitly. */
const optionsOf = (agent: UndiciAgent): Record<string, unknown> => {
  const symbol = Object.getOwnPropertySymbols(agent).find(
    (candidate) => candidate.description === 'options',
  );

  expect(
    symbol,
    'undici no longer exposes Symbol(options); re-check how allowH2 is applied',
  ).toBeDefined();

  return (agent as unknown as Record<symbol, Record<string, unknown>>)[symbol!];
};

describe('getHttpsAgent', () => {
  it('returns a dispatcher when buildAgents was never called', () => {
    expect(getHttpsAgent()).toBeInstanceOf(UndiciAgent);
  });

  it('returns the same dispatcher across calls, so the pool is shared', () => {
    expect(getHttpsAgent()).toBe(getHttpsAgent());
  });

  it.each([
    ['no configuration at all', {}],
    ['TLS configured', { tls: { cert: 'cert', key: 'key' } }],
  ])('returns a dispatcher with %s', (_label, agentConfig) => {
    buildAgents(agentConfig);

    expect(getHttpsAgent()).toBeInstanceOf(UndiciAgent);
  });

  it.each([
    ['no configuration at all', {}],
    ['TLS configured', { tls: { cert: 'cert', key: 'key' } }],
  ])('does not force http/1.1 with %s', (_label, agentConfig) => {
    buildAgents(agentConfig);

    // Absent means undici's default, which offers h2 in ALPN alongside
    // http/1.1. `false` pins every provider connection to http/1.1, which is
    // what this used to do — for whichever deployments reached it at all.
    //
    // `REQUEST_TIMEOUT` is the other input that used to decide this, and it
    // cannot be varied here: `Environment` returns a snapshot taken when the
    // module was imported, so setting it on `process.env` now would change
    // nothing and the assertion would pass without testing anything. Both
    // inputs now feed one constructor, so there is no branch left to diverge.
    expect(optionsOf(getHttpsAgent())).not.toHaveProperty('allowH2');
  });
});

describe('getProxyAgent', () => {
  it('caches one dispatcher per proxy url', () => {
    const agent = getProxyAgent('http://127.0.0.1:3128');

    expect(agent).toBeInstanceOf(ProxyAgent);
    expect(getProxyAgent('http://127.0.0.1:3128')).toBe(agent);
    expect(getProxyAgent('http://127.0.0.1:3129')).not.toBe(agent);
  });
});
