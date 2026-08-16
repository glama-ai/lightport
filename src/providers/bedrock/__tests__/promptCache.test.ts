import { describe, expect, it } from 'vitest';
import { transformUsingProviderConfig } from '../../../services/transformToProviderRequest';
import type { Message, Params } from '../../../types/requestBody';
import { BedrockConverseChatCompleteConfig } from '../chatComplete';

const toolLoop = (toolContent: Message['content']): Params =>
  ({
    model: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
    messages: [
      {
        role: 'system',
        content: [{ type: 'text', text: 'be brief', cache_control: { type: 'ephemeral' } }],
      },
      { role: 'user', content: 'what is the weather?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Oslo"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: toolContent },
    ],
  }) as Params;

const contentOf = (transformed: any, role: string) =>
  transformed.messages.find((message: any) =>
    message.content.some((block: any) => role in block),
  )?.content;

describe('a tool result the caller asked to checkpoint', () => {
  // `ToolResultContentBlock` is document | image | json | searchResult | text |
  // video. A cache point put among them is not one Bedrock honours, and the
  // request then carries a checkpoint the caller cannot see is missing — until a
  // later `ttl: '1h'` block lands after it and Bedrock rejects the whole request.
  it('puts the cache point beside the tool result, not inside it', () => {
    const transformed: any = transformUsingProviderConfig(
      BedrockConverseChatCompleteConfig,
      toolLoop([{ type: 'text', text: 'sunny', cache_control: { type: 'ephemeral' } }]),
    );

    const content = contentOf(transformed, 'toolResult');

    expect(content).toEqual([
      { toolResult: { content: [{ text: 'sunny' }], toolUseId: 'call_1' } },
      { cachePoint: { type: 'default' } },
    ]);
  });

  it('keeps the cache point when the tool result itself is empty', () => {
    const transformed: any = transformUsingProviderConfig(
      BedrockConverseChatCompleteConfig,
      toolLoop([{ type: 'text', text: '', cache_control: { type: 'ephemeral' } }]),
    );

    // Bedrock allows an empty array but not an empty string, and dropping the
    // text is no reason to drop the checkpoint with it.
    expect(contentOf(transformed, 'toolResult')).toEqual([
      { toolResult: { content: [], toolUseId: 'call_1' } },
      { cachePoint: { type: 'default' } },
    ]);
  });

  it('leaves a tool result with nothing to checkpoint alone', () => {
    const transformed: any = transformUsingProviderConfig(
      BedrockConverseChatCompleteConfig,
      toolLoop([{ type: 'text', text: 'sunny' }]),
    );

    expect(contentOf(transformed, 'toolResult')).toEqual([
      { toolResult: { content: [{ text: 'sunny' }], toolUseId: 'call_1' } },
    ]);
  });
});

describe('a message whose content is a plain string', () => {
  // There is no content part to hang `cache_control` off, so the caller puts it
  // on the message itself, which is where the Anthropic provider reads it from.
  it('checkpoints a tool result marked on the message', () => {
    const params = toolLoop('sunny');
    (params.messages as any)[3].cache_control = { type: 'ephemeral' };

    const transformed: any = transformUsingProviderConfig(
      BedrockConverseChatCompleteConfig,
      params,
    );

    expect(contentOf(transformed, 'toolResult')).toEqual([
      { toolResult: { content: [{ text: 'sunny' }], toolUseId: 'call_1' } },
      { cachePoint: { type: 'default' } },
    ]);
  });

  it('checkpoints a system message marked on the message', () => {
    const params = toolLoop('sunny');
    (params.messages as any)[0] = {
      role: 'system',
      content: 'be brief',
      cache_control: { type: 'ephemeral' },
    };

    const transformed: any = transformUsingProviderConfig(
      BedrockConverseChatCompleteConfig,
      params,
    );

    expect(transformed.system).toEqual([{ text: 'be brief' }, { cachePoint: { type: 'default' } }]);
  });

  it('says nothing about caching when the caller did not', () => {
    const transformed: any = transformUsingProviderConfig(
      BedrockConverseChatCompleteConfig,
      toolLoop('sunny'),
    );

    expect(contentOf(transformed, 'toolResult')).toEqual([
      { toolResult: { content: [{ text: 'sunny' }], toolUseId: 'call_1' } },
    ]);
  });
});
