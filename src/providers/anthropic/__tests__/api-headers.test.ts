import { describe, expect, it } from 'vitest';
import AnthropicAPIConfig from '../api';

const headersFor = (apiKey: string, extra: Record<string, unknown> = {}) =>
  AnthropicAPIConfig.headers({
    providerOptions: { apiKey, provider: 'anthropic', ...extra },
    gatewayRequestBody: {},
    headers: {},
  } as any) as Record<string, string>;

describe('anthropic authentication', () => {
  it('sends an API key as one', () => {
    const headers = headersFor('sk-ant-api03-key');

    expect(headers['X-API-Key']).toBe('sk-ant-api03-key');
    expect(headers).not.toHaveProperty('Authorization');
    expect(headers['anthropic-beta']).not.toContain('oauth');
  });

  // An OAuth token matched the test for an API key, and was refused as one.
  it('sends an OAuth token as a bearer token, with the beta Anthropic reads it by', () => {
    const headers = headersFor('sk-ant-oat01-token');

    expect(headers.Authorization).toBe('Bearer sk-ant-oat01-token');
    expect(headers).not.toHaveProperty('X-API-Key');
    expect(headers['anthropic-beta'].split(',')).toContain('oauth-2025-04-20');
  });

  it('keeps the betas a caller asked for beside it', () => {
    const headers = headersFor('sk-ant-oat01-token', {
      anthropicBeta: 'prompt-caching-2024-07-31, oauth-2025-04-20',
    });

    expect(headers['anthropic-beta']).toBe('prompt-caching-2024-07-31,oauth-2025-04-20');
  });

  it('still sends any other token as a bearer token, as before', () => {
    const headers = headersFor('a-proxy-token');

    expect(headers.Authorization).toBe('Bearer a-proxy-token');
    expect(headers['anthropic-beta']).not.toContain('oauth');
  });
});
