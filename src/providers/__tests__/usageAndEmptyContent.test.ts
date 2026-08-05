import { describe, expect, it } from 'vitest';
import { transformUsingProviderConfig } from '../../services/transformToProviderRequest';
import {
  AnthropicChatCompleteConfig,
  getAnthropicChatCompleteResponseTransform,
} from '../anthropic/chatComplete';
import { VertexAnthropicChatCompleteConfig } from '../google-vertex-ai/chatComplete';
import { BedrockUploadFileTransformerConfig } from '../bedrock/uploadFileUtils';
import {
  BedrockChatCompleteResponseTransform,
  BedrockChatCompleteStreamChunkTransform,
} from '../bedrock/chatComplete';
import { RekaAIChatCompleteConfig } from '../reka-ai/chatComplete';
import type { ChatCompletionResponse, ProviderConfig } from '../types';
import type { Params } from '../../types/requestBody';

describe('a system message whose content is an empty array', () => {
  // `content` is the caller's to write, and an SDK building it up from nothing
  // sends `[]`. Reading the first element without checking there is one threw,
  // and the caller was told only that something had gone wrong.
  const configs = [
    ['anthropic', AnthropicChatCompleteConfig],
    ['vertex-anthropic', VertexAnthropicChatCompleteConfig],
  ] as const;

  it.each(configs)('%s does not fail the request', (_name, config) => {
    for (const role of ['system', 'developer']) {
      const build = () =>
        transformUsingProviderConfig(
          config as ProviderConfig,
          {
            model: 'claude',
            messages: [
              { role, content: [] },
              { role: 'user', content: 'hi' },
            ],
          } as Params,
        );

      expect(build).not.toThrow();
      // Nothing was said, so there is no system content — the same empty list a
      // request with no system message at all produces.
      expect(build().system).toEqual([]);
    }
  });

  it('a tool result with nothing before it does not fail the request either', () => {
    // The same class, in the transform beside it: the result is appended to the
    // message before it, and there is not always one to append to.
    for (const messages of [
      [{ role: 'tool', tool_call_id: 't1', content: 'result' }],
      [
        { role: 'system', content: 'be brief' },
        { role: 'tool', tool_call_id: 't1', content: 'result' },
      ],
    ]) {
      const build = () =>
        transformUsingProviderConfig(
          AnthropicChatCompleteConfig as ProviderConfig,
          {
            model: 'claude',
            messages,
          } as Params,
        );

      expect(build).not.toThrow();
      // The result stands as its own message rather than being lost.
      expect(build().messages[0].content[0]).toMatchObject({
        type: 'tool_result',
        tool_use_id: 't1',
      });
    }
  });

  it('reka survives a conversation that came to nothing', () => {
    for (const messages of [[{ role: 'user', content: [] }], []]) {
      expect(() =>
        transformUsingProviderConfig(
          RekaAIChatCompleteConfig as ProviderConfig,
          {
            model: 'reka-core',
            messages,
          } as Params,
        ),
      ).not.toThrow();
    }
  });

  it.each(configs)('%s still carries system content that is there', (_name, config) => {
    const request = transformUsingProviderConfig(
      config as ProviderConfig,
      {
        model: 'claude',
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
          { role: 'user', content: 'hi' },
        ],
      } as Params,
    );

    expect(request.system).toEqual([{ type: 'text', text: 'be brief' }]);
  });

  it('the Bedrock batch file builder does not fail either', () => {
    const anthropic: any = (BedrockUploadFileTransformerConfig as any).anthropic;
    const system = anthropic.messages.find((m: any) => m.param === 'system');

    expect(() => system.transform({ messages: [{ role: 'system', content: [] }] })).not.toThrow();
    expect(system.transform({ messages: [{ role: 'system', content: [] }] })).toBe('');
    expect(
      system.transform({
        messages: [{ role: 'system', content: [{ type: 'text', text: 'be brief' }] }],
      }),
    ).toBe('be brief');
  });
});

// What every OpenAI-shaped consumer reads a usage object by: the parts sum to
// the total, and the cached count is part of the input rather than beside it.
const expectUsageAddsUp = (usage: any) => {
  expect(usage.total_tokens).toBe(usage.prompt_tokens + usage.completion_tokens);
  expect(usage.prompt_tokens_details.cached_tokens).toBeLessThanOrEqual(usage.prompt_tokens);
};

describe('Anthropic usage', () => {
  const transform = getAnthropicChatCompleteResponseTransform('anthropic');

  const usageOf = (usage: Record<string, number>) =>
    (
      transform(
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude',
          stop_reason: 'end_turn',
          stop_sequence: null,
          content: [{ type: 'text', text: 'hello' }],
          usage,
        } as never,
        200,
        new Headers(),
        false,
      ) as ChatCompletionResponse
    ).usage as any;

  it('counts a cache read as input that was read', () => {
    const usage = usageOf({ input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 5000 });

    expect(usage.prompt_tokens).toBe(5010);
    expect(usage.completion_tokens).toBe(40);
    expect(usage.total_tokens).toBe(5050);
    expect(usage.prompt_tokens_details.cached_tokens).toBe(5000);
    expectUsageAddsUp(usage);
  });

  it('counts a cache write as input that was written', () => {
    const usage = usageOf({
      input_tokens: 10,
      output_tokens: 40,
      cache_creation_input_tokens: 200,
    });

    expect(usage.prompt_tokens).toBe(210);
    expectUsageAddsUp(usage);
  });

  it('adds up with nothing cached at all', () => {
    const usage = usageOf({ input_tokens: 10, output_tokens: 40 });

    expect(usage.prompt_tokens).toBe(10);
    expect(usage.total_tokens).toBe(50);
    expectUsageAddsUp(usage);
  });
});

describe('Bedrock usage', () => {
  const usageOf = (usage: Record<string, number>) =>
    (
      BedrockChatCompleteResponseTransform(
        {
          output: { message: { role: 'assistant', content: [{ text: 'hello' }] } },
          stopReason: 'end_turn',
          usage,
        } as never,
        200,
        new Headers(),
        false,
        'https://bedrock.example/converse',
        { model: 'claude' } as Params,
      ) as ChatCompletionResponse
    ).usage as any;

  it('counts the cache as input, and totals what it counted', () => {
    // Bedrock reports the cache separately and describes its own total as the
    // input plus what the model generated, so passing that total through beside
    // a cache-inclusive `prompt_tokens` left the parts not summing to it.
    const usage = usageOf({
      inputTokens: 10,
      outputTokens: 40,
      totalTokens: 50,
      cacheReadInputTokens: 5000,
      cacheWriteInputTokens: 100,
    });

    expect(usage.prompt_tokens).toBe(5110);
    expect(usage.completion_tokens).toBe(40);
    expect(usage.total_tokens).toBe(5150);
    expectUsageAddsUp(usage);
  });

  it('adds up with nothing cached at all', () => {
    const usage = usageOf({ inputTokens: 10, outputTokens: 40, totalTokens: 50 });

    expect(usage.prompt_tokens).toBe(10);
    expect(usage.total_tokens).toBe(50);
    expectUsageAddsUp(usage);
  });

  it('adds up when streamed, as it does when it is not', () => {
    const chunks = BedrockChatCompleteStreamChunkTransform(
      JSON.stringify({
        usage: {
          inputTokens: 10,
          outputTokens: 40,
          totalTokens: 50,
          cacheReadInputTokens: 5000,
          cacheWriteInputTokens: 100,
        },
      }),
      'fallback',
      {} as any,
      false,
      { model: 'claude' } as Params,
    ) as string[];

    const usage = JSON.parse(chunks[0].replace(/^data: /, '')).usage;

    expect(usage.prompt_tokens).toBe(5110);
    expect(usage.total_tokens).toBe(5150);
    expectUsageAddsUp(usage);
  });
});
