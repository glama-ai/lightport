import { afterEach, describe, expect, it } from 'vitest';
import createApp from '../../index';
import http from 'node:http';
import getPort from 'get-port';
import Providers from '..';
import { VALID_PROVIDERS } from '../valid';
import AceDataCloudConfig from '../acedatacloud';
import { OpenAIChatCompleteConfig } from '../openai/chatComplete';
import { transformUsingProviderConfig } from '../../services/transformToProviderRequest';
import type { Params } from '../../types/requestBody';

const apps: Array<ReturnType<typeof createApp>> = [];
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

const tool = {
  type: 'function',
  function: { name: 'lookup', parameters: { type: 'object', properties: {} } },
};

describe('Ace Data Cloud provider', () => {
  it('is directly selectable by provider name', () => {
    expect(Providers.acedatacloud).toBe(AceDataCloudConfig);
    expect(VALID_PROVIDERS).toContain('acedatacloud');
  });

  it('uses the fixed chat endpoint and caller Bearer credential', () => {
    const api = AceDataCloudConfig.api;
    expect(api.getBaseURL({} as any)).toBe('https://api.acedata.cloud');
    expect(api.getEndpoint({ fn: 'chatComplete' } as any)).toBe('/openai/chat/completions');
    expect(api.headers({ providerOptions: { apiKey: 'test-placeholder' } } as any)).toEqual({
      Authorization: 'Bearer test-placeholder',
    });
    expect(api.headers({ providerOptions: {} } as any)).toEqual({});
  });

  it('does not advertise unimplemented media or embedding endpoints', () => {
    for (const fn of ['imageGenerate', 'embed', 'complete']) {
      expect(AceDataCloudConfig.api.getEndpoint({ fn } as any)).toBe('');
    }
    expect(AceDataCloudConfig.nativeResponses).toBe(false);
  });

  it('keeps the requested model, tools, tool results and streaming options', () => {
    const messages = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', ...tool, function: { name: 'lookup', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'found' },
    ];
    const result = transformUsingProviderConfig(AceDataCloudConfig.chatComplete!, {
      model: 'gpt-4.1-mini',
      messages,
      tools: [tool],
      tool_choice: 'auto',
      stream: true,
      stream_options: { include_usage: true },
    } as Params);
    expect(result.model).toBe('gpt-4.1-mini');
    expect(result.messages).toEqual(messages);
    expect(result.tools).toEqual([tool]);
    expect(result.tool_choice).toBe('auto');
    expect(result.stream).toBe(true);
    expect(result.stream_options).toEqual({ include_usage: true });
  });

  it('never invents a default model or changes OpenAI defaults', () => {
    const result = transformUsingProviderConfig(AceDataCloudConfig.chatComplete!, {
      messages: [{ role: 'user', content: 'hi' }],
    } as Params);
    expect(result.model).toBeUndefined();
    expect((OpenAIChatCompleteConfig.model as any).default).toBe('gpt-3.5-turbo');
  });

  it('preserves tool calls and usage in a completion response', () => {
    const response = {
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-4.1-mini',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', ...tool, function: { name: 'lookup', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    };
    const result = (AceDataCloudConfig.responseTransforms.chatComplete as any)(response, 200);
    expect(result.choices[0].message.tool_calls).toEqual(response.choices[0].message.tool_calls);
    expect(result.usage.total_tokens).toBe(15);
    expect(result.provider).toBe('acedatacloud');
  });

  it('passes a streamed tool call and DONE through the actual gateway route', async () => {
    const delta = {
      tool_calls: [
        { index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } },
      ],
    };
    let path: string | undefined;
    let authorization: string | undefined;
    const upstream = http.createServer((request, response) => {
      path = request.url;
      authorization = request.headers.authorization;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        'data: ' +
          JSON.stringify({ id: 'test', choices: [{ index: 0, delta, finish_reason: null }] }) +
          '\n\n',
      );
      response.end('data: [DONE]\n\n');
    });
    servers.push(upstream);
    const port = await getPort();
    await new Promise<void>((resolve) => upstream.listen(port, '127.0.0.1', resolve));
    const app = createApp();
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-placeholder',
        'x-lightport-provider': 'acedatacloud',
        'x-lightport-custom-host': `http://127.0.0.1:${port}`,
      },
      payload: {
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: 'lookup' }],
        stream: true,
      },
    });
    expect(path).toBe('/openai/chat/completions');
    expect(authorization).toBe('Bearer test-placeholder');
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('lookup');
    expect(response.body).toContain('call_1');
    expect(response.body).toContain('data: [DONE]');
  });
});
