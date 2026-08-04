import { GatewayError } from '../GatewayError';
import { gatewayErrorResponse } from '../gatewayErrorResponse';
import { describe, expect, it } from 'vitest';

const read = async (response: Response) => ({
  body: await response.json(),
  status: response.status,
});

describe('gatewayErrorResponse', () => {
  it('answers a GatewayError with the status it was raised with', async () => {
    // A provider name the gateway does not recognise is raised as a 400. Every
    // one of them used to be answered with a 500 and `Something went wrong`,
    // telling the caller to retry a request that could never succeed.
    const { body, status } = await read(
      gatewayErrorResponse(new GatewayError('Provider "nope" is not supported', 400)),
    );

    expect(status).toBe(400);
    expect(body.error).toEqual({
      code: null,
      message: 'Provider "nope" is not supported',
      param: null,
      type: 'invalid_request_error',
    });
  });

  it('calls a GatewayError raised as a 5xx a server error', async () => {
    const { body, status } = await read(gatewayErrorResponse(new GatewayError('upstream is down')));

    expect(status).toBe(500);
    expect(body.error.type).toBe('server_error');
  });

  it.each([0, 200, 399, 600, 700, Number.NaN, 1.5])(
    'answers a GatewayError raised with %s as a 500 rather than throwing',
    async (status) => {
      // This runs inside the handlers' last catch, and `new Response` rejects
      // anything outside 200-599. A throw from here escapes to Fastify's own
      // handler — the ad-hoc shape this exists to remove — so an unusable
      // status has to become a usable one rather than an exception.
      const answered = await read(gatewayErrorResponse(new GatewayError('bad status', status)));

      expect(answered.status).toBe(500);
      expect(answered.body.error.type).toBe('server_error');
    },
  );

  it('keeps an error it did not raise to itself', async () => {
    // Anything from a library or a runtime may name a host, a path or a header,
    // and the caller has no business seeing any of it.
    const { body, status } = await read(
      gatewayErrorResponse(new Error('connect ECONNREFUSED 10.0.0.7:443')),
    );

    expect(status).toBe(500);
    expect(body.error.message).toBe('Something went wrong');
    expect(JSON.stringify(body)).not.toContain('10.0.0.7');
  });

  it('answers in the shape a provider error already arrives in', async () => {
    // generateErrorResponse writes all four fields for provider failures. A
    // client should not have to know which layer produced an error to read it.
    const { body } = await read(gatewayErrorResponse(new Error('boom')));

    expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'param', 'type']);
  });
});
