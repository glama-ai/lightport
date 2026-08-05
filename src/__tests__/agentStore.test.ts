import {
  buildAgents,
  getHttpsAgent,
  getProxyAgent,
  resolveTransportTimeoutsFrom,
} from '../agentStore';
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

  it("always sets a headersTimeout, so a silently dead connection cannot outlive undici's notice of it", () => {
    buildAgents({});

    const { headersTimeout } = optionsOf(getHttpsAgent());

    expect(typeof headersTimeout).toBe('number');
    expect(headersTimeout).toBeGreaterThan(0);
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

/**
 * The precedence rules, tested directly against synthetic env objects rather
 * than through `getHttpsAgent`: `Environment()` snapshots `process.env` at
 * import time (see the note above), so there is no way to vary these inputs
 * against the real dispatcher from inside a running test.
 */
describe('resolveTransportTimeoutsFrom', () => {
  it('falls back to the headers-timeout floor and leaves bodyTimeout to undici when nothing is configured', () => {
    expect(resolveTransportTimeoutsFrom({})).toEqual({ headersTimeout: 120_000 });
  });

  it('lets REQUEST_TIMEOUT alone still set both, unchanged', () => {
    expect(resolveTransportTimeoutsFrom({ REQUEST_TIMEOUT: '5000' })).toEqual({
      bodyTimeout: 5000,
      headersTimeout: 5000,
    });
  });

  it('lets HEADERS_TIMEOUT override REQUEST_TIMEOUT for headers only', () => {
    expect(
      resolveTransportTimeoutsFrom({ HEADERS_TIMEOUT: '9000', REQUEST_TIMEOUT: '5000' }),
    ).toEqual({
      bodyTimeout: 5000,
      headersTimeout: 9000,
    });
  });

  it('lets BODY_TIMEOUT override REQUEST_TIMEOUT for body only', () => {
    expect(
      resolveTransportTimeoutsFrom({ BODY_TIMEOUT: '600000', REQUEST_TIMEOUT: '5000' }),
    ).toEqual({
      bodyTimeout: 600000,
      headersTimeout: 5000,
    });
  });

  it('needs no REQUEST_TIMEOUT at all once both are set independently', () => {
    expect(
      resolveTransportTimeoutsFrom({ BODY_TIMEOUT: '600000', HEADERS_TIMEOUT: '60000' }),
    ).toEqual({
      bodyTimeout: 600000,
      headersTimeout: 60000,
    });
  });

  it('ignores non-positive or non-numeric values', () => {
    expect(
      resolveTransportTimeoutsFrom({ BODY_TIMEOUT: 'nonsense', HEADERS_TIMEOUT: '-1' }),
    ).toEqual({
      headersTimeout: 120_000,
    });
  });
});
