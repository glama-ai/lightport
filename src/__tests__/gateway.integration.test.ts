import createApp from '../index';
import getPort from 'get-port';
import OpenAI from 'openai';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? '';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY ?? '';
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY ?? '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';

let app: ReturnType<typeof createApp>;
let baseURL: string;

beforeAll(async () => {
  const port = await getPort();
  app = createApp();
  await app.listen({ port, host: '127.0.0.1' });
  baseURL = `http://127.0.0.1:${port}/v1`;
});

afterAll(async () => {
  await app.close();
});

describe.skipIf(!ANTHROPIC_API_KEY)('anthropic', () => {
  let client: OpenAI;

  beforeAll(() => {
    client = new OpenAI({
      apiKey: ANTHROPIC_API_KEY,
      baseURL,
      defaultHeaders: {
        'x-lightport-provider': 'anthropic',
        Authorization: `Bearer ${ANTHROPIC_API_KEY}`,
      },
    });
  });

  it('completes a chat request', async () => {
    const response = await client.chat.completions.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Reply with only the word "pong".' }],
    });

    expect(response.choices).toHaveLength(1);
    expect(response.choices[0].message.content?.toLowerCase()).toContain('pong');
    expect(response.choices[0].finish_reason).toBe('stop');
  }, 30_000);

  it('streams a chat response', async () => {
    const stream = await client.chat.completions.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Reply with only the word "pong".' }],
      stream: true,
    });

    const chunks: string[] = [];

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        chunks.push(delta);
      }
    }

    const text = chunks.join('');
    expect(text.toLowerCase()).toContain('pong');
  }, 30_000);

  it('returns tool_calls', async () => {
    const response = await client.chat.completions.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Call the submit tool with answer "hello".' }],
      tool_choice: 'required' as any,
      tools: [
        {
          type: 'function',
          function: {
            name: 'submit',
            description: 'Submit the final answer.',
            parameters: {
              type: 'object',
              properties: {
                answer: { type: 'string', description: 'The answer' },
              },
              required: ['answer'],
            },
          },
        },
      ],
    });

    expect(response.choices[0].finish_reason).toBe('tool_calls');

    const toolCalls = response.choices[0].message.tool_calls;
    expect(toolCalls).toBeDefined();
    expect(toolCalls!.length).toBeGreaterThan(0);
    expect(toolCalls![0].type).toBe('function');
    expect(toolCalls![0].function.name).toBe('submit');

    const args = JSON.parse(toolCalls![0].function.arguments);
    expect(args.answer).toBe('hello');
  }, 30_000);

  it('streams tool_calls', async () => {
    const stream = await client.chat.completions.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Call the submit tool with answer "hello".' }],
      stream: true,
      tool_choice: 'required' as any,
      tools: [
        {
          type: 'function',
          function: {
            name: 'submit',
            description: 'Submit the final answer.',
            parameters: {
              type: 'object',
              properties: {
                answer: { type: 'string', description: 'The answer' },
              },
              required: ['answer'],
            },
          },
        },
      ],
    });

    let functionName = '';
    let functionArgs = '';

    for await (const chunk of stream) {
      const toolCalls = chunk.choices[0]?.delta?.tool_calls;
      if (toolCalls?.[0]?.function?.name) {
        functionName = toolCalls[0].function.name;
      }
      if (toolCalls?.[0]?.function?.arguments) {
        functionArgs += toolCalls[0].function.arguments;
      }
    }

    expect(functionName).toBe('submit');
    expect(functionArgs).toContain('hello');
  }, 30_000);
});

describe.skipIf(!DEEPSEEK_API_KEY)('deepseek', () => {
  let client: OpenAI;

  beforeAll(() => {
    client = new OpenAI({
      apiKey: DEEPSEEK_API_KEY,
      baseURL,
      defaultHeaders: {
        'x-lightport-provider': 'deepseek',
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      },
    });
  });

  it('completes a chat request', async () => {
    const response = await client.chat.completions.create({
      model: 'deepseek-chat',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Reply with only the word "pong".' }],
    });

    expect(response.choices).toHaveLength(1);
    expect(response.choices[0].message.content?.toLowerCase()).toContain('pong');
    expect(response.choices[0].finish_reason).toBe('stop');
  }, 30_000);

  it('streams a chat response', async () => {
    const stream = await client.chat.completions.create({
      model: 'deepseek-chat',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Reply with only the word "pong".' }],
      stream: true,
    });

    const chunks: string[] = [];

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        chunks.push(delta);
      }
    }

    const text = chunks.join('');
    expect(text.toLowerCase()).toContain('pong');
  }, 30_000);

  it('returns tool_calls when tool_choice is required', async () => {
    const response = await client.chat.completions.create({
      model: 'deepseek-chat',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Call the submit tool with answer "hello".' }],
      tool_choice: 'required',
      tools: [
        {
          type: 'function',
          function: {
            name: 'submit',
            description: 'Submit the final answer.',
            parameters: {
              type: 'object',
              properties: {
                answer: { type: 'string', description: 'The answer' },
              },
              required: ['answer'],
            },
          },
        },
      ],
    });

    expect(response.choices[0].finish_reason).toBe('tool_calls');

    const toolCalls = response.choices[0].message.tool_calls;

    expect(toolCalls).toBeDefined();
    expect(toolCalls!.length).toBeGreaterThan(0);
    const firstCall = toolCalls![0];
    expect(firstCall.type).toBe('function');
    if (firstCall.type === 'function') {
      expect(firstCall.function.name).toBe('submit');
    }
  }, 30_000);

  it('returns tool_calls with thinking disabled', async () => {
    const response = await client.chat.completions.create({
      model: 'deepseek-chat',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Call the submit tool with answer "hello".' }],
      tool_choice: 'required',
      // @ts-expect-error thinking is not in the OpenAI type
      thinking: { type: 'disabled' },
      tools: [
        {
          type: 'function',
          function: {
            name: 'submit',
            description: 'Submit the final answer.',
            parameters: {
              type: 'object',
              properties: {
                answer: { type: 'string', description: 'The answer' },
              },
              required: ['answer'],
            },
          },
        },
      ],
    });

    expect(response.choices[0].finish_reason).toBe('tool_calls');

    const toolCalls = response.choices[0].message.tool_calls;

    expect(toolCalls).toBeDefined();
    expect(toolCalls!.length).toBeGreaterThan(0);
    const firstCall = toolCalls![0];
    expect(firstCall.type).toBe('function');
    if (firstCall.type === 'function') {
      expect(firstCall.function.name).toBe('submit');
    }
  }, 30_000);

  it('streams tool_calls', async () => {
    const stream = await client.chat.completions.create({
      model: 'deepseek-chat',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Call the submit tool with answer "hello".' }],
      stream: true,
      tool_choice: 'required',
      tools: [
        {
          type: 'function',
          function: {
            name: 'submit',
            description: 'Submit the final answer.',
            parameters: {
              type: 'object',
              properties: {
                answer: { type: 'string', description: 'The answer' },
              },
              required: ['answer'],
            },
          },
        },
      ],
    });

    let functionName = '';
    let functionArgs = '';

    for await (const chunk of stream) {
      const toolCalls = chunk.choices[0]?.delta?.tool_calls;

      if (toolCalls?.[0]?.function?.name) {
        functionName = toolCalls[0].function.name;
      }

      if (toolCalls?.[0]?.function?.arguments) {
        functionArgs += toolCalls[0].function.arguments;
      }
    }

    expect(functionName).toBe('submit');
    expect(functionArgs).toContain('hello');
  }, 30_000);
});

describe.skipIf(!MISTRAL_API_KEY)('mistral-ai', () => {
  let client: OpenAI;

  beforeAll(() => {
    client = new OpenAI({
      apiKey: MISTRAL_API_KEY,
      baseURL,
      defaultHeaders: {
        'x-lightport-provider': 'mistral-ai',
        Authorization: `Bearer ${MISTRAL_API_KEY}`,
      },
    });
  });

  it('returns structured output with response_format json_schema', async () => {
    const response = await client.chat.completions.create({
      model: 'mistral-small-latest',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'What is the capital of France?' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'answer',
          schema: {
            type: 'object',
            properties: {
              city: { type: 'string' },
            },
            required: ['city'],
          },
        },
      },
    });

    const content = response.choices[0].message.content!;
    const parsed = JSON.parse(content);
    expect(parsed.city.toLowerCase()).toContain('paris');
  }, 30_000);
});

describe.skipIf(!GOOGLE_API_KEY)('google', () => {
  let client: OpenAI;

  beforeAll(() => {
    client = new OpenAI({
      apiKey: GOOGLE_API_KEY,
      baseURL,
      defaultHeaders: {
        'x-lightport-provider': 'google',
        Authorization: `Bearer ${GOOGLE_API_KEY}`,
      },
    });
  });

  it('returns tool_calls finish_reason for function calls', async () => {
    const response = await client.chat.completions.create({
      model: 'gemini-2.5-flash',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Call the submit tool with answer "hello".' }],
      tool_choice: 'required' as any,
      tools: [
        {
          type: 'function',
          function: {
            name: 'submit',
            description: 'Submit the final answer.',
            parameters: {
              type: 'object',
              properties: {
                answer: { type: 'string', description: 'The answer' },
              },
              required: ['answer'],
            },
          },
        },
      ],
    });

    expect(response.choices[0].finish_reason).toBe('tool_calls');

    const toolCalls = response.choices[0].message.tool_calls;
    expect(toolCalls).toBeDefined();
    expect(toolCalls!.length).toBeGreaterThan(0);
    expect(toolCalls![0].function.name).toBe('submit');
  }, 30_000);
});

describe.skipIf(!OPENAI_API_KEY)('openai', () => {
  let client: OpenAI;

  beforeAll(() => {
    client = new OpenAI({
      apiKey: OPENAI_API_KEY,
      baseURL,
      defaultHeaders: {
        'x-lightport-provider': 'openai',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
    });
  });

  it('completes a chat request', async () => {
    const response = await client.chat.completions.create({
      model: 'gpt-4.1-nano',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Reply with only the word "pong".' }],
    });

    expect(response.choices).toHaveLength(1);
    expect(response.choices[0].message.content?.toLowerCase()).toContain('pong');
    expect(response.choices[0].finish_reason).toBe('stop');
  }, 30_000);

  it('streams a chat response', async () => {
    const stream = await client.chat.completions.create({
      model: 'gpt-4.1-nano',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Reply with only the word "pong".' }],
      stream: true,
    });

    const chunks: string[] = [];

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        chunks.push(delta);
      }
    }

    const text = chunks.join('');
    expect(text.toLowerCase()).toContain('pong');
  }, 30_000);
});
