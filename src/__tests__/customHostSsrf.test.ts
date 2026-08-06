import createApp from '../index';
import getPort from 'get-port';
import http from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// One gateway for the file. Every case here is refused or served before the
// request leaves the process, so none of them can affect another — and standing
// a fresh app up per case was enough concurrent listeners to make the file flake
// against the rest of the suite.
let gateway: ReturnType<typeof createApp>;
let gatewayPort: number;
const servers: http.Server[] = [];

beforeAll(async () => {
  gatewayPort = await getPort();
  gateway = createApp();
  await gateway.listen({ host: '127.0.0.1', port: gatewayPort });
});

afterAll(async () => {
  await gateway?.close();
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/**
 * A stand-in provider that records whether the gateway ever reached it.
 *
 * Whether a request was made is the only thing worth asserting about a host the
 * gateway was supposed to refuse. A status code says the caller was turned away;
 * it does not say the connection behind it was never opened.
 */
const startProvider = async () => {
  const port = await getPort();
  const received: string[] = [];
  const server = http.createServer((req, res) => {
    received.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [
          { finish_reason: 'stop', index: 0, message: { content: 'ok', role: 'assistant' } },
        ],
        id: 'chatcmpl-test',
        model: 'gpt-4o',
        object: 'chat.completion',
      }),
    );
  });

  servers.push(server);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

  return { port, received };
};

const BODY_FOR_PATH: Record<string, Record<string, unknown>> = {
  '/v1/chat/completions': { messages: [{ content: 'hi', role: 'user' }], model: 'gpt-4o' },
  '/v1/completions': { model: 'gpt-3.5-turbo-instruct', prompt: 'hi' },
  '/v1/responses': { input: 'hi', model: 'gpt-4o' },
};

const call = async (
  path: string,
  headers: Record<string, string>,
): Promise<{ body: any; status: number }> => {
  const response = await fetch(`http://127.0.0.1:${gatewayPort}${path}`, {
    body: JSON.stringify(BODY_FOR_PATH[path]),
    headers: {
      authorization: 'Bearer sk-not-a-real-key',
      'content-type': 'application/json',
      ...headers,
    },
    method: 'POST',
  });

  return { body: await response.json().catch(() => null), status: response.status };
};

const config = (extra: Record<string, unknown>) =>
  JSON.stringify({ api_key: 'sk-not-a-real-key', provider: 'openai', ...extra });

// A host the gateway must never call: link-local, and the address every cloud
// serves instance credentials from.
const METADATA_HOST = 'http://169.254.169.254';
const PRIVATE_HOST = 'http://10.0.0.1:8080';

describe('custom host SSRF', () => {
  /*
    The config is converted to camelCase before it is used, so `custom_host` and
    `customHost` name the same setting by the time anything reads it. Validation
    only ever saw the first spelling, and the second reached the fetch with a
    private address in it — the whole protection was a matter of how the caller
    chose to spell the key.
  */
  it.each([
    ['/v1/chat/completions', 'customHost'],
    ['/v1/chat/completions', 'custom_host'],
    ['/v1/completions', 'customHost'],
    ['/v1/completions', 'custom_host'],
    ['/v1/responses', 'customHost'],
    ['/v1/responses', 'custom_host'],
  ])('refuses a private address on %s spelled %s', async (path, key) => {
    const { status } = await call(path, {
      'x-lightport-config': config({ [key]: PRIVATE_HOST }),
    });

    expect(status).toBe(400);
  });

  it.each(['customHost', 'custom_host'])(
    'refuses the cloud metadata address spelled %s',
    async (key) => {
      const { body, status } = await call('/v1/chat/completions', {
        'x-lightport-config': config({ [key]: METADATA_HOST }),
      });

      expect(status).toBe(400);
      expect(body?.error?.message).toContain('custom host');
    },
  );

  it('refuses a private address passed as the custom-host header', async () => {
    const { status } = await call('/v1/chat/completions', {
      'x-lightport-custom-host': PRIVATE_HOST,
      'x-lightport-provider': 'openai',
    });

    expect(status).toBe(400);
  });

  it('opens no connection to the host it refuses', async () => {
    const provider = await startProvider();

    // Refused for the address it names rather than for being unreachable, so the
    // assertion below is about the gateway's choice and not about the port.
    const { status } = await call('/v1/chat/completions', {
      'x-lightport-config': config({ customHost: `http://10.0.0.1:${provider.port}` }),
    });

    expect(status).toBe(400);
    expect(provider.received).toEqual([]);
  });

  it.each(['customHost', 'custom_host'])(
    'still routes to a trusted host spelled %s',
    async (key) => {
      const provider = await startProvider();
      const { status } = await call('/v1/chat/completions', {
        'x-lightport-config': config({ [key]: `http://127.0.0.1:${provider.port}` }),
      });

      expect(status).toBe(200);
      expect(provider.received).toEqual(['POST /chat/completions']);
    },
  );

  it('still routes to a trusted host named by the custom-host header', async () => {
    const provider = await startProvider();
    const { status } = await call('/v1/chat/completions', {
      'x-lightport-custom-host': `http://127.0.0.1:${provider.port}`,
      'x-lightport-provider': 'openai',
    });

    expect(status).toBe(200);
    expect(provider.received).toEqual(['POST /chat/completions']);
  });
});

/*
  A provider builds its own base URL from the options it is given, and some of
  those options are a host the caller supplied. None of them are named in the
  config schema, so nothing validated them at all — the address was refused only
  when it arrived under the one key the schema knew.
*/
describe('provider-supplied base URLs', () => {
  it.each([
    ['huggingface', 'huggingface_base_url'],
    ['huggingface', 'huggingfaceBaseUrl'],
    ['azure-ai', 'azure_foundry_url'],
    ['azure-ai', 'azureFoundryUrl'],
  ])('refuses a private address given to %s as %s', async (provider, key) => {
    const providerServer = await startProvider();
    const { status } = await call('/v1/chat/completions', {
      'x-lightport-config': JSON.stringify({
        api_key: 'sk-not-a-real-key',
        provider,
        [key]: `http://10.0.0.1:${providerServer.port}`,
      }),
    });

    expect(status).toBe(400);
    expect(providerServer.received).toEqual([]);
  });

  it('refuses a private address given as the huggingface base-url header', async () => {
    const providerServer = await startProvider();
    const { status } = await call('/v1/chat/completions', {
      'x-lightport-huggingface-base-url': `http://10.0.0.1:${providerServer.port}`,
      'x-lightport-provider': 'huggingface',
    });

    expect(status).toBe(400);
    expect(providerServer.received).toEqual([]);
  });

  it('still routes to a trusted huggingface base url', async () => {
    const providerServer = await startProvider();
    const { status } = await call('/v1/chat/completions', {
      'x-lightport-config': JSON.stringify({
        api_key: 'sk-not-a-real-key',
        huggingface_base_url: `http://127.0.0.1:${providerServer.port}`,
        provider: 'huggingface',
      }),
    });

    expect(status).toBe(200);
    expect(providerServer.received).toEqual(['POST /v1/chat/completions']);
  });

  // The provider's own address is what a request without any host option uses,
  // and the check on the resolved URL must not be in the way of it.
  it('leaves a provider its own base url', async () => {
    const { status } = await call('/v1/chat/completions', {
      'x-lightport-config': JSON.stringify({ api_key: 'sk-not-a-real-key', provider: 'openai' }),
    });

    expect(status).not.toBe(400);
  });
});

describe('forward_headers self-reference through the config', () => {
  // The same aliasing: the schema refuses `forward_headers` naming the header
  // that carries it, and `forwardHeaders` went around the refusal.
  it.each(['forwardHeaders', 'forward_headers'])('refuses it spelled %s', async (key) => {
    const provider = await startProvider();
    const { status } = await call('/v1/chat/completions', {
      'x-lightport-config': config({
        [key]: ['x-lightport-forward-headers'],
        customHost: `http://127.0.0.1:${provider.port}`,
      }),
    });

    expect(status).toBe(400);
    expect(provider.received).toEqual([]);
  });

  it('allows unrelated headers to be forwarded', async () => {
    const provider = await startProvider();
    const { status } = await call('/v1/chat/completions', {
      'x-lightport-config': config({
        customHost: `http://127.0.0.1:${provider.port}`,
        forwardHeaders: ['x-request-id'],
      }),
    });

    expect(status).toBe(200);
    expect(provider.received).toEqual(['POST /chat/completions']);
  });
});
