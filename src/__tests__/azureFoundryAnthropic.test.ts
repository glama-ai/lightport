import createApp from '../index';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/*
  A Claude deployment on Azure AI Foundry: its URL names Anthropic, its requests
  go out in Anthropic's shape, and its answers come back in it. Those answers
  were read as Azure's own shape and reached the caller unreadable.
*/
let gateway: ReturnType<typeof createApp>;
const servers: http.Server[] = [];

beforeAll(async () => {
  gateway = createApp();
  await gateway.ready();
});

afterAll(async () => {
  await gateway?.close();
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

const anthropicReply = {
  content: [{ text: 'Hello from Claude.', type: 'text' }],
  id: 'msg_1',
  model: 'claude-sonnet-4-5',
  role: 'assistant',
  stop_reason: 'end_turn',
  stop_sequence: null,
  type: 'message',
  usage: { input_tokens: 5, output_tokens: 4 },
};

const anthropicStream = [
  {
    message: { id: 'msg_1', model: 'claude-sonnet-4-5', usage: { input_tokens: 5 } },
    type: 'message_start',
  },
  { content_block: { text: '', type: 'text' }, index: 0, type: 'content_block_start' },
  {
    delta: { text: 'Hello from Claude.', type: 'text_delta' },
    index: 0,
    type: 'content_block_delta',
  },
  { index: 0, type: 'content_block_stop' },
  { delta: { stop_reason: 'end_turn' }, type: 'message_delta', usage: { output_tokens: 4 } },
  { type: 'message_stop' },
]
  .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  .join('');

const startFoundry = async () => {
  const received: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push(`${req.method} ${req.url}`);
      if (JSON.parse(body).stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(anthropicStream);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(anthropicReply));
      }
    });
  });

  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return { port: (server.address() as AddressInfo).port, received };
};

const ask = (port: number, stream: boolean) =>
  gateway.inject({
    headers: {
      authorization: 'Bearer not-a-real-key',
      'content-type': 'application/json',
      'x-lightport-azure-foundry-url': `http://127.0.0.1:${port}/anthropic`,
      'x-lightport-provider': 'azure-ai',
    },
    method: 'POST',
    payload: { messages: [{ content: 'Hi', role: 'user' }], model: 'claude-sonnet-4-5', stream },
    url: '/v1/chat/completions',
  });

describe('claude on azure ai foundry', () => {
  it('is answered as the chat completion it was asked for', async () => {
    const foundry = await startFoundry();
    const response = await ask(foundry.port, false);

    expect(foundry.received).toEqual([expect.stringMatching(/^POST \/anthropic\/v1\/messages/)]);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      choices: [
        { finish_reason: 'stop', message: { content: 'Hello from Claude.', role: 'assistant' } },
      ],
      object: 'chat.completion',
      usage: { completion_tokens: 4, prompt_tokens: 5 },
    });
  });

  it('streams as chat completion chunks', async () => {
    const foundry = await startFoundry();
    const response = await ask(foundry.port, true);
    const chunks = response.body
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: {'))
      .map((frame) => JSON.parse(frame.slice('data: '.length)));

    expect(chunks.every((chunk) => chunk.object === 'chat.completion.chunk')).toBe(true);
    expect(chunks.map((chunk) => chunk.choices[0]?.delta?.content ?? '').join('')).toBe(
      'Hello from Claude.',
    );
  });
});
