import { describe, expect, it } from 'vitest';
import { transformUsingProviderConfig } from '../../../services/transformToProviderRequest';
import type { Message, Params } from '../../../types/requestBody';
import { BedrockConverseChatCompleteConfig } from '../chatComplete';
import { BedrockConverseMessagesConfig } from '../messages';

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

describe('the lifetime a caller asked a checkpoint to live for', () => {
  // Bedrock takes a `ttl` on every cache point. Sending the block without one is
  // not an error — the caller is simply given 5 minutes instead of the hour they
  // wrote, and nothing in the response says so.
  it('reaches Bedrock on a tool result, a system message and a tool', () => {
    const ttl = { type: 'ephemeral', ttl: '1h' };
    const params = {
      model: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'be brief', cache_control: ttl }] },
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
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: [{ type: 'text', text: 'sunny', cache_control: ttl }],
        },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', parameters: { type: 'object' } },
          cache_control: ttl,
        },
      ],
    } as unknown as Params;

    const transformed: any = transformUsingProviderConfig(
      BedrockConverseChatCompleteConfig,
      params,
    );

    expect(transformed.system).toContainEqual({ cachePoint: { type: 'default', ttl: '1h' } });
    expect(transformed.toolConfig.tools).toContainEqual({
      cachePoint: { type: 'default', ttl: '1h' },
    });
    expect(contentOf(transformed, 'toolResult')).toEqual([
      { toolResult: { content: [{ text: 'sunny' }], toolUseId: 'call_1' } },
      { cachePoint: { type: 'default', ttl: '1h' } },
    ]);
  });

  // Bedrock processes tools, then system, then messages, and rejects a `1h` block
  // that follows a `5m` one. A caller who asked for `1h` everywhere never wrote
  // that mixture; dropping the ttl from one checkpoint is what created it.
  it('is not dropped from one checkpoint and kept on the next', () => {
    const ttl = { type: 'ephemeral', ttl: '1h' };
    const params = {
      model: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'be brief', cache_control: ttl }] },
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
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: [{ type: 'text', text: 'sunny', cache_control: ttl }],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'it is sunny', cache_control: ttl }] },
      ],
    } as unknown as Params;

    const transformed: any = transformUsingProviderConfig(
      BedrockConverseChatCompleteConfig,
      params,
    );

    const cachePoints = [
      ...transformed.system,
      ...transformed.messages.flatMap((message: any) => message.content),
    ].filter((block: any) => 'cachePoint' in block);

    expect(cachePoints).toHaveLength(3);
    expect(cachePoints.every((block: any) => block.cachePoint.ttl === '1h')).toBe(true);
  });

  it('is left off when the caller left it off', () => {
    const transformed: any = transformUsingProviderConfig(
      BedrockConverseChatCompleteConfig,
      toolLoop([{ type: 'text', text: 'sunny', cache_control: { type: 'ephemeral' } }]),
    );

    // No ttl at all, rather than a guess at one: Bedrock's own default applies.
    expect(contentOf(transformed, 'toolResult')?.[1]).toEqual({ cachePoint: { type: 'default' } });
  });

  it('reaches Bedrock on the Anthropic-shaped route too', () => {
    const ttl = { type: 'ephemeral', ttl: '1h' };
    const params = {
      model: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
      max_tokens: 16,
      system: [{ type: 'text', text: 'be brief', cache_control: ttl }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'what is the weather?' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Oslo' } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: [{ type: 'text', text: 'sunny' }],
              cache_control: ttl,
            },
          ],
        },
      ],
      tools: [
        { name: 'get_weather', input_schema: { type: 'object' }, cache_control: ttl },
      ],
    } as unknown as Params;

    const transformed: any = transformUsingProviderConfig(BedrockConverseMessagesConfig, params);

    expect(transformed.system).toContainEqual({ cachePoint: { type: 'default', ttl: '1h' } });
    expect(transformed.toolConfig.tools).toContainEqual({
      cachePoint: { type: 'default', ttl: '1h' },
    });
    expect(contentOf(transformed, 'toolResult')).toEqual([
      {
        toolResult: {
          content: [{ text: 'sunny' }],
          status: 'success',
          toolUseId: 'call_1',
        },
      },
      { cachePoint: { type: 'default', ttl: '1h' } },
    ]);
  });
});

describe('a checkpoint asked for by a part inside an Anthropic-shaped tool result', () => {
  const messagesParams = (toolResultContent: unknown): Params =>
    ({
      model: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
      max_tokens: 16,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'what is the weather?' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Oslo' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: toolResultContent }],
        },
      ],
    }) as unknown as Params;

  // The cache point has to clear the `toolResult` whether the caller marked the
  // block or a part inside it — a part is the easier one to miss, because the
  // block-level marker is handled a few lines further down.
  it('leaves the tool result for a text part', () => {
    const transformed: any = transformUsingProviderConfig(
      BedrockConverseMessagesConfig,
      messagesParams([
        { type: 'text', text: 'sunny', cache_control: { type: 'ephemeral', ttl: '1h' } },
      ]),
    );

    expect(contentOf(transformed, 'toolResult')).toEqual([
      {
        toolResult: { content: [{ text: 'sunny' }], status: 'success', toolUseId: 'call_1' },
      },
      { cachePoint: { type: 'default', ttl: '1h' } },
    ]);
  });

  it('leaves the tool result for an image part', () => {
    const transformed: any = transformUsingProviderConfig(
      BedrockConverseMessagesConfig,
      messagesParams([
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'aGk=' },
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ]),
    );

    expect(contentOf(transformed, 'toolResult')).toEqual([
      {
        toolResult: {
          content: [{ image: { format: 'png', source: { bytes: 'aGk=' } } }],
          status: 'success',
          toolUseId: 'call_1',
        },
      },
      { cachePoint: { type: 'default', ttl: '1h' } },
    ]);
  });

  it('says nothing about caching when no part asked for it', () => {
    const transformed: any = transformUsingProviderConfig(
      BedrockConverseMessagesConfig,
      messagesParams([{ type: 'text', text: 'sunny' }]),
    );

    expect(contentOf(transformed, 'toolResult')).toEqual([
      { toolResult: { content: [{ text: 'sunny' }], status: 'success', toolUseId: 'call_1' } },
    ]);
  });
});
