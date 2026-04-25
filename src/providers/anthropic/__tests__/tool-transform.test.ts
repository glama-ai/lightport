import { AnthropicChatCompleteConfig } from '../chatComplete';
import { describe, it, expect, vi } from 'vitest';
import AnthropicAPIConfig from '../api';

vi.mock('../../../data-stores/redis', () => ({
  redisClient: null,
  redisReaderClient: null,
}));

vi.mock('../../../utils/awsAuth', () => ({}));

vi.mock('../../..', () => ({}));

const toolsTransform = (AnthropicChatCompleteConfig.tools as any).transform;

function makeOpenAITool(overrides: Record<string, any> = {}) {
  return {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get weather for a location',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'City name' },
        },
        required: ['location'],
      },
      ...overrides,
    },
  };
}

describe('Anthropic tool transform - strict parameter', () => {
  it('forwards strict: true to the Anthropic tool definition', () => {
    const result = toolsTransform({
      tools: [makeOpenAITool({ strict: true })],
    });
    expect(result).toHaveLength(1);
    expect(result[0].strict).toBe(true);
  });

  it('forwards strict: false to the Anthropic tool definition', () => {
    const result = toolsTransform({
      tools: [makeOpenAITool({ strict: false })],
    });
    expect(result).toHaveLength(1);
    expect(result[0].strict).toBe(false);
  });

  it('omits strict when not provided in the OpenAI tool', () => {
    const result = toolsTransform({ tools: [makeOpenAITool()] });
    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('strict');
  });

  it('handles multiple tools with mixed strict settings', () => {
    const result = toolsTransform({
      tools: [
        makeOpenAITool({ name: 'tool_a', strict: true }),
        makeOpenAITool({ name: 'tool_b', strict: false }),
        makeOpenAITool({ name: 'tool_c' }),
      ],
    });
    expect(result).toHaveLength(3);
    expect(result[0].strict).toBe(true);
    expect(result[1].strict).toBe(false);
    expect(result[2]).not.toHaveProperty('strict');
  });

  it('preserves cache_control with scope on tools', () => {
    const result = toolsTransform({
      tools: [
        {
          ...makeOpenAITool(),
          cache_control: { type: 'ephemeral', scope: 'global' },
        },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0].cache_control).toEqual({ type: 'ephemeral', scope: 'global' });
  });

  it('preserves cache_control without scope on tools', () => {
    const result = toolsTransform({
      tools: [
        {
          ...makeOpenAITool(),
          cache_control: { type: 'ephemeral' },
        },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0].cache_control).toEqual({ type: 'ephemeral' });
  });
});

const messagesConfig = AnthropicChatCompleteConfig.messages as any[];
const messagesTransform = messagesConfig.find((c: any) => c.param === 'messages').transform;
const systemTransform = messagesConfig.find((c: any) => c.param === 'system').transform;

describe('Anthropic message transform - cache_control preservation', () => {
  it('preserves cache_control with scope on system messages', () => {
    const result = systemTransform({
      messages: [
        {
          role: 'system',
          content: 'You are helpful.',
          cache_control: { type: 'ephemeral', scope: 'global' },
        },
        { role: 'user', content: 'Hi' },
      ],
    });
    expect(result[0].cache_control).toEqual({ type: 'ephemeral', scope: 'global' });
  });

  it('preserves cache_control with scope on user text content', () => {
    const result = messagesTransform({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Hello',
              cache_control: { type: 'ephemeral', scope: 'global' },
            },
          ],
        },
      ],
    });
    expect(result[0].content[0].cache_control).toEqual({ type: 'ephemeral', scope: 'global' });
  });
});

describe('Anthropic API headers', () => {
  it('falls back to anthropic-beta from request headers', () => {
    const headers = AnthropicAPIConfig.headers({
      providerOptions: { apiKey: 'sk-ant-test' },
      gatewayRequestBody: {},
      headers: { 'anthropic-beta': 'prompt-caching-scope-2026-01-05' },
      c: {} as any,
      fn: 'chatComplete',
      transformedRequestBody: {},
      transformedRequestUrl: '',
    });
    expect(headers['anthropic-beta']).toBe('prompt-caching-scope-2026-01-05');
  });

  it('prefers providerOptions over request headers for anthropic-beta', () => {
    const headers = AnthropicAPIConfig.headers({
      providerOptions: { apiKey: 'sk-ant-test', anthropicBeta: 'from-options' },
      gatewayRequestBody: {},
      headers: { 'anthropic-beta': 'from-request-headers' },
      c: {} as any,
      fn: 'chatComplete',
      transformedRequestBody: {},
      transformedRequestUrl: '',
    });
    expect(headers['anthropic-beta']).toBe('from-options');
  });

  it('sends OAuth tokens via Authorization header', () => {
    const headers = AnthropicAPIConfig.headers({
      providerOptions: { apiKey: 'oauth-token-123' },
      gatewayRequestBody: {},
      c: {} as any,
      fn: 'chatComplete',
      transformedRequestBody: {},
      transformedRequestUrl: '',
    });
    expect(headers['Authorization']).toBe('Bearer oauth-token-123');
    expect(headers).not.toHaveProperty('X-API-Key');
  });

  it('sends sk-ant- keys via X-API-Key header', () => {
    const headers = AnthropicAPIConfig.headers({
      providerOptions: { apiKey: 'sk-ant-abc123' },
      gatewayRequestBody: {},
      c: {} as any,
      fn: 'chatComplete',
      transformedRequestBody: {},
      transformedRequestUrl: '',
    });
    expect(headers['X-API-Key']).toBe('sk-ant-abc123');
    expect(headers).not.toHaveProperty('Authorization');
  });
});
