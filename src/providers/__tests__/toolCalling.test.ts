import { describe, expect, it } from 'vitest';
import { transformUsingProviderConfig } from '../../services/transformToProviderRequest';
import {
  AI302ChatCompleteConfig,
  AI302ChatCompleteResponseTransform,
  AI302ChatCompleteStreamChunkTransform,
} from '../302ai/chatComplete';
import {
  DeepInfraChatCompleteConfig,
  DeepInfraChatCompleteResponseTransform,
  DeepInfraChatCompleteStreamChunkTransform,
} from '../deepinfra/chatComplete';
import {
  LingyiChatCompleteConfig,
  LingyiChatCompleteResponseTransform,
  LingyiChatCompleteStreamChunkTransform,
} from '../lingyi/chatComplete';
import {
  MoonshotChatCompleteConfig,
  MoonshotChatCompleteResponseTransform,
  MoonshotChatCompleteStreamChunkTransform,
} from '../moonshot/chatComplete';
import {
  NCompassChatCompleteConfig,
  NCompassChatCompleteResponseTransform,
  NCompassChatCompleteStreamChunkTransform,
} from '../ncompass/chatComplete';
import {
  ZhipuChatCompleteConfig,
  ZhipuChatCompleteResponseTransform,
  ZhipuChatCompleteStreamChunkTransform,
} from '../zhipu/chatComplete';
import type { ChatCompletionResponse, ProviderConfig } from '../types';
import type { Params } from '../../types/requestBody';

const providers = [
  [
    '302ai',
    AI302ChatCompleteConfig,
    AI302ChatCompleteResponseTransform,
    AI302ChatCompleteStreamChunkTransform,
  ],
  [
    'deepinfra',
    DeepInfraChatCompleteConfig,
    DeepInfraChatCompleteResponseTransform,
    DeepInfraChatCompleteStreamChunkTransform,
  ],
  [
    'lingyi',
    LingyiChatCompleteConfig,
    LingyiChatCompleteResponseTransform,
    LingyiChatCompleteStreamChunkTransform,
  ],
  [
    'moonshot',
    MoonshotChatCompleteConfig,
    MoonshotChatCompleteResponseTransform,
    MoonshotChatCompleteStreamChunkTransform,
  ],
  [
    'ncompass',
    NCompassChatCompleteConfig,
    NCompassChatCompleteResponseTransform,
    NCompassChatCompleteStreamChunkTransform,
  ],
  [
    'zhipu',
    ZhipuChatCompleteConfig,
    ZhipuChatCompleteResponseTransform,
    ZhipuChatCompleteStreamChunkTransform,
  ],
] as const;

const weatherTool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Look up the weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
  },
};

const toolCall = {
  id: 'call_1',
  type: 'function',
  function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
};

describe.each(providers)('%s tool calling', (_name, config, transform, streamTransform) => {
  it('sends the tools it was given', () => {
    // Only parameters the config names are forwarded, and these were not named,
    // so the tools were stripped on the way out: the model was never told it
    // could call anything and simply answered in prose.
    const request = transformUsingProviderConfig(
      config as ProviderConfig,
      {
        model: 'a-model',
        messages: [{ role: 'user', content: 'weather in Paris?' }],
        tools: [weatherTool],
        tool_choice: 'auto',
      } as Params,
    );

    expect(request.tools).toEqual([weatherTool]);
    expect(request.tool_choice).toBe('auto');
  });

  it('carries the result of a call back to the model', () => {
    // The reply naming the call and the tool's answer both have to survive the
    // request transform, or a second turn loses the conversation.
    const request = transformUsingProviderConfig(
      config as ProviderConfig,
      {
        model: 'a-model',
        messages: [
          { role: 'user', content: 'weather in Paris?' },
          { role: 'assistant', content: null, tool_calls: [toolCall] },
          { role: 'tool', tool_call_id: 'call_1', content: '17C' },
        ],
      } as Params,
    );

    expect(request.messages[1].tool_calls).toEqual([toolCall]);
    expect(request.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
  });

  it('returns the calls the model asked for', () => {
    // Rebuilding the message field by field dropped them, so a model that had
    // decided to call a tool came back as though it had said nothing.
    const result = transform(
      {
        id: 'chat-1',
        object: 'chat.completion',
        created: 1_700_000_000,
        model: 'a-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: null, tool_calls: [toolCall] },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      } as never,
      200,
      new Headers(),
      true,
    ) as ChatCompletionResponse;

    expect(result.choices[0].message.tool_calls).toEqual([toolCall]);
    // The caller needs this to know the turn ended in a call rather than an answer.
    expect(result.choices[0].finish_reason).toBe('tool_calls');
  });

  it('says nothing about tools when the model did not call one', () => {
    const result = transform(
      {
        id: 'chat-1',
        object: 'chat.completion',
        created: 1_700_000_000,
        model: 'a-model',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'sunny' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      } as never,
      200,
      new Headers(),
      true,
    ) as ChatCompletionResponse;

    expect(result.choices[0].message).not.toHaveProperty('tool_calls');
  });

  it('says nothing about tools when the provider sends an empty list', () => {
    // An empty array is truthy, so it used to be reported as calls the model had
    // made, and a caller reading `tool_calls` at all found something there.
    const result = transform(
      {
        id: 'chat-1',
        object: 'chat.completion',
        created: 1_700_000_000,
        model: 'a-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'sunny', tool_calls: [] },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      } as never,
      200,
      new Headers(),
      true,
    ) as ChatCompletionResponse;

    expect(result.choices[0].message).not.toHaveProperty('tool_calls');
  });

  it('sends parallel_tool_calls, which the Responses API asks for by name', () => {
    const request = transformUsingProviderConfig(
      config as ProviderConfig,
      {
        model: 'a-model',
        messages: [{ role: 'user', content: 'weather in Paris?' }],
        tools: [weatherTool],
        parallel_tool_calls: false,
      } as Params,
    );

    expect(request.parallel_tool_calls).toBe(false);
  });

  it('streams the calls the model asks for', () => {
    // These transforms take the chunk and nothing else — they forward the delta
    // whole, which is why the calls survive here without being named.
    const chunk = streamTransform(
      `data: ${JSON.stringify({
        id: 'chat-1',
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model: 'a-model',
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, ...toolCall }] },
            finish_reason: null,
          },
        ],
      })}`,
    );

    const parsed = JSON.parse((chunk as string).replace(/^data: /, ''));
    expect(parsed.choices[0].delta.tool_calls).toEqual([{ index: 0, ...toolCall }]);
  });

  it('leaves a request carrying no tools untouched', () => {
    const request = transformUsingProviderConfig(
      config as ProviderConfig,
      {
        model: 'a-model',
        messages: [{ role: 'user', content: 'hello' }],
      } as Params,
    );

    expect(request).not.toHaveProperty('tools');
    expect(request).not.toHaveProperty('tool_choice');
  });
});
