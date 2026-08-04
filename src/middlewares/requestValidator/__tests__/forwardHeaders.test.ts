import { HEADER_KEYS } from '../../../globals';
import type { GatewayContext } from '../../../types/GatewayContext';
import { requestValidator } from '../index';
import { configSchema } from '../schema/config';
import { describe, expect, it } from 'vitest';

const createContext = (headers: Record<string, string>): GatewayContext => ({
  req: {
    url: 'http://localhost/v1/chat/completions',
    method: 'POST',
    param: () => ({}),
  },
  get: (key: string) => (key === 'mappedHeaders' ? headers : undefined),
  set: () => {},
});

const validate = (headers: Record<string, string>) =>
  requestValidator(createContext({ [HEADER_KEYS.PROVIDER]: 'openai', ...headers }));

describe('forward_headers self-reference', () => {
  it('rejects the forward-headers header listing itself', async () => {
    const response = validate({ [HEADER_KEYS.FORWARD_HEADERS]: HEADER_KEYS.FORWARD_HEADERS });

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toMatchObject({
      error: {
        code: null,
        message: `forward_headers must not contain the '${HEADER_KEYS.FORWARD_HEADERS}' header`,
        param: null,
        type: 'invalid_request_error',
      },
    });
  });

  it('rejects it regardless of casing, padding, or position in the list', async () => {
    const response = validate({
      [HEADER_KEYS.FORWARD_HEADERS]: `authorization,  X-LightPort-Forward-Headers  ,x-request-id`,
    });

    expect(response?.status).toBe(400);
  });

  it('allows forwarding unrelated headers', () => {
    const response = validate({
      [HEADER_KEYS.FORWARD_HEADERS]: 'authorization,x-request-id',
    });

    expect(response).toBeNull();
  });

  it('rejects a config whose forward_headers lists the header', () => {
    const result = configSchema.safeParse({
      provider: 'openai',
      api_key: 'sk-test',
      forward_headers: ['authorization', HEADER_KEYS.FORWARD_HEADERS],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        message: `forward_headers must not contain the '${HEADER_KEYS.FORWARD_HEADERS}' header`,
      }),
    );
  });

  it('accepts a config with unrelated forward_headers', () => {
    const result = configSchema.safeParse({
      provider: 'openai',
      api_key: 'sk-test',
      forward_headers: ['authorization', 'x-request-id'],
    });

    expect(result.success).toBe(true);
  });
});
