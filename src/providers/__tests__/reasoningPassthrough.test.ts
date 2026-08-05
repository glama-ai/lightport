import { describe, expect, it } from 'vitest';
import { transformReasoning, transformUsageDetails } from '../utils';
import { ZhipuChatCompleteResponseTransform } from '../zhipu/chatComplete';
import { MoonshotChatCompleteResponseTransform } from '../moonshot/chatComplete';
import { DeepInfraChatCompleteResponseTransform } from '../deepinfra/chatComplete';
import {
  NovitaAIChatCompleteResponseTransform,
  NovitaAIChatCompleteStreamChunkTransform,
} from '../novita-ai/chatComplete';
import { PerplexityAIChatCompleteResponseTransform } from '../perplexity-ai/chatComplete';
import {
  TogetherAIChatCompleteResponseTransform,
  TogetherAIChatCompleteStreamChunkTransform,
} from '../together-ai/chatComplete';
import { AI302ChatCompleteResponseTransform } from '../302ai/chatComplete';
import { LatitudeChatCompleteResponseTransform } from '../latitude/chatComplete';
import { LingyiChatCompleteResponseTransform } from '../lingyi/chatComplete';
import { NCompassChatCompleteResponseTransform } from '../ncompass/chatComplete';
import { GetMistralAIChatCompleteResponseTransform } from '../mistral-ai/chatComplete';
import { PredibaseChatCompleteResponseTransform } from '../predibase/chatComplete';
import type { ChatCompletionResponse } from '../types';

describe('transformReasoning', () => {
  it('carries the chain of thought under either name the providers use', () => {
    // DeepSeek set one convention and OpenRouter the other; the aggregators
    // relay whichever their upstream chose.
    expect(
      transformReasoning({ content: 'four', reasoning_content: 'two plus two' }, true),
    ).toEqual({ reasoning_content: 'two plus two' });
    expect(transformReasoning({ content: 'four', reasoning: 'two plus two' }, true)).toEqual({
      reasoning_content: 'two plus two',
    });
  });

  it('keeps it under the default, which is strict compliance', () => {
    // The streaming halves of these providers forward the delta whole and gate
    // nothing, so gating here would leave the two paths disagreeing by default.
    expect(
      transformReasoning({ content: '', reasoning_content: 'all of it' }, true),
    ).toHaveProperty('reasoning_content', 'all of it');
  });

  it('adds the thinking block once compliance is relaxed', () => {
    expect(
      transformReasoning({ content: 'four', reasoning_content: 'two plus two' }, false),
    ).toEqual({
      reasoning_content: 'two plus two',
      content_blocks: [
        { type: 'thinking', thinking: 'two plus two' },
        { type: 'text', text: 'four' },
      ],
    });
  });

  it('looks past a field an aggregator left empty', () => {
    // Normalising the name it did not receive leaves it present but blank, and
    // the thinking is in the other one.
    expect(
      transformReasoning(
        { content: 'four', reasoning_content: '', reasoning: 'two plus two' },
        true,
      ),
    ).toEqual({ reasoning_content: 'two plus two' });
  });

  it('adds nothing when the model did not reason', () => {
    expect(transformReasoning({ content: 'pong' }, false)).toEqual({});
    expect(transformReasoning({ content: 'pong', reasoning_content: '' }, false)).toEqual({});
    expect(transformReasoning(undefined, false)).toEqual({});
  });
});

describe('transformUsageDetails', () => {
  it('reports the reasoning tokens that were billed', () => {
    expect(transformUsageDetails({ completion_tokens_details: { reasoning_tokens: 80 } })).toEqual({
      completion_tokens_details: { reasoning_tokens: 80 },
    });
  });

  it('reports a cache hit however the provider named it', () => {
    expect(transformUsageDetails({ prompt_cache_hit_tokens: 6 })).toEqual({
      prompt_tokens_details: { cached_tokens: 6 },
    });
    expect(transformUsageDetails({ cached_tokens: 7 })).toEqual({
      prompt_tokens_details: { cached_tokens: 7 },
    });
    expect(transformUsageDetails({ prompt_tokens_details: { cached_tokens: 8 } })).toEqual({
      prompt_tokens_details: { cached_tokens: 8 },
    });
  });

  it('prefers the count the provider already shaped the OpenAI way', () => {
    expect(
      transformUsageDetails({
        prompt_tokens_details: { cached_tokens: 4 },
        prompt_cache_hit_tokens: 6,
      }),
    ).toEqual({ prompt_tokens_details: { cached_tokens: 4 } });
  });

  it('keeps a cache count of zero, which is not the same as no count', () => {
    expect(transformUsageDetails({ prompt_cache_hit_tokens: 0 })).toEqual({
      prompt_tokens_details: { cached_tokens: 0 },
    });
  });

  it('carries the rest of the breakdown beside the cache count', () => {
    // Rebuilding this object from the cache count alone would drop what sits
    // beside it, which is the mistake the helper exists to undo.
    expect(
      transformUsageDetails({ prompt_tokens_details: { cached_tokens: 4, audio_tokens: 2 } }),
    ).toEqual({ prompt_tokens_details: { cached_tokens: 4, audio_tokens: 2 } });

    expect(transformUsageDetails({ prompt_tokens_details: { audio_tokens: 2 } })).toEqual({
      prompt_tokens_details: { audio_tokens: 2 },
    });
  });

  it('adds nothing when the provider reported no breakdown', () => {
    expect(transformUsageDetails({ prompt_tokens: 1, completion_tokens: 1 })).toEqual({});
    expect(transformUsageDetails(undefined)).toEqual({});
  });
});

// A reasoning turn as each provider reports it: the thinking beside the answer,
// and for the turn spent entirely on reasoning, no answer at all.
const reasoningBody = (extra: Record<string, unknown> = {}) => ({
  id: 'chat-1',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: 'a-reasoner',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: '', reasoning_content: 'all of it' },
      finish_reason: 'stop',
    },
  ],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 90,
    total_tokens: 100,
    completion_tokens_details: { reasoning_tokens: 80 },
  },
  ...extra,
});

describe('providers that rebuilt the message field by field', () => {
  const cases = [
    ['zhipu', ZhipuChatCompleteResponseTransform],
    ['moonshot', MoonshotChatCompleteResponseTransform],
    ['deepinfra', DeepInfraChatCompleteResponseTransform],
    ['novita-ai', NovitaAIChatCompleteResponseTransform],
    ['302ai', AI302ChatCompleteResponseTransform],
    ['latitude', LatitudeChatCompleteResponseTransform],
    ['lingyi', LingyiChatCompleteResponseTransform],
    ['ncompass', NCompassChatCompleteResponseTransform],
    ['mistral-ai', GetMistralAIChatCompleteResponseTransform('mistral-ai')],
    ['predibase', PredibaseChatCompleteResponseTransform],
  ] as const;

  it.each(cases)('%s keeps the reasoning and the tokens it cost', (_name, transform) => {
    const result = transform(
      reasoningBody() as never,
      200,
      new Headers(),
      true,
    ) as ChatCompletionResponse;

    expect((result.choices[0].message as any).reasoning_content).toBe('all of it');
    expect(result.usage?.completion_tokens_details?.reasoning_tokens).toBe(80);
  });

  it.each(cases)('%s offers the thinking block once compliance is relaxed', (_name, transform) => {
    const result = transform(
      reasoningBody() as never,
      200,
      new Headers(),
      false,
    ) as ChatCompletionResponse;

    expect((result.choices[0].message as any).content_blocks).toContainEqual({
      type: 'thinking',
      thinking: 'all of it',
    });
  });
});

describe('novita-ai', () => {
  it('numbers each answer as the provider did', () => {
    // Every choice used to be numbered zero, so asking for more than one
    // returned a set that all claimed to be the first.
    const body = reasoningBody();
    const result = NovitaAIChatCompleteResponseTransform(
      {
        ...body,
        choices: [
          { ...body.choices[0], index: 0 },
          { ...body.choices[0], index: 1 },
        ],
      } as never,
      200,
      new Headers(),
      true,
    ) as ChatCompletionResponse;

    expect(result.choices.map((c) => c.index)).toEqual([0, 1]);
  });

  it('streams the reasoning, the role and the reason it stopped', () => {
    // The delta was rebuilt as content alone and the finish reason was the empty
    // string throughout, so the streaming half lost more than the other did.
    const chunk = JSON.parse(
      NovitaAIChatCompleteStreamChunkTransform(
        `data: ${JSON.stringify({
          id: 'chat-1',
          object: 'chat.completion.chunk',
          model: 'a-reasoner',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: '', reasoning_content: 'all of it' },
              finish_reason: 'length',
            },
            {
              index: 1,
              delta: { role: 'assistant', content: 'second' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        })}`,
      ).replace(/^data: /, ''),
    );

    expect(chunk.choices[0].delta.reasoning_content).toBe('all of it');
    expect(chunk.choices[0].delta.role).toBe('assistant');
    expect(chunk.choices[0].finish_reason).toBe('length');
    expect(chunk.usage.total_tokens).toBe(3);
    // Only the first was ever forwarded.
    expect(chunk.choices.map((c: any) => c.index)).toEqual([0, 1]);
  });
});

describe('together-ai', () => {
  // Together hosts models from both camps, so the thinking arrives under
  // whichever name the model it is serving happens to use.
  it.each([['reasoning'], ['reasoning_content']])('keeps the reasoning reported as %s', (field) => {
    const result = TogetherAIChatCompleteResponseTransform(
      {
        ...reasoningBody(),
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '', [field]: 'all of it' },
            finish_reason: 'stop',
          },
        ],
      } as never,
      200,
      new Headers(),
      false,
    ) as ChatCompletionResponse;

    expect((result.choices[0].message as any).reasoning_content).toBe('all of it');
    expect((result.choices[0].message as any).content_blocks).toContainEqual({
      type: 'thinking',
      thinking: 'all of it',
    });
  });

  it.each([['reasoning'], ['reasoning_content']])(
    'streams the reasoning reported as %s',
    (field) => {
      // The stream looked only for `reasoning`, so fixing the other half alone
      // would have left the two paths disagreeing the other way round.
      const chunk = JSON.parse(
        TogetherAIChatCompleteStreamChunkTransform(
          `data: ${JSON.stringify({
            id: 'chat-1',
            object: 'chat.completion.chunk',
            model: 'a-reasoner',
            choices: [{ index: 0, delta: { [field]: 'all of it' }, finish_reason: null }],
          })}`,
          'fallback',
          {},
          true,
        ).replace(/^data: /, ''),
      );

      expect(chunk.choices[0].delta.reasoning_content).toBe('all of it');
    },
  );

  it('returns the logprobs it was asked for', () => {
    const logprobs = { content: [{ token: 'four', logprob: -0.1 }] };
    const result = TogetherAIChatCompleteResponseTransform(
      {
        ...reasoningBody(),
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'four' },
            logprobs,
            finish_reason: 'stop',
          },
        ],
      } as never,
      200,
      new Headers(),
      true,
    ) as ChatCompletionResponse;

    expect(result.choices[0].logprobs).toEqual(logprobs);
  });
});

describe('perplexity-ai', () => {
  const body = {
    id: 'chat-1',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'sonar-reasoning',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'first' },
        finish_reason: 'length',
      },
      {
        index: 1,
        message: { role: 'assistant', content: 'second' },
        finish_reason: 'stop',
      },
    ],
    // Perplexity reports what it charged for beside the three token counts
    // rather than under a breakdown.
    usage: {
      prompt_tokens: 10,
      completion_tokens: 90,
      total_tokens: 100,
      num_search_queries: 2,
      reasoning_tokens: 40,
      citation_tokens: 5,
      cost: { total_cost: 0.01 },
    },
  };

  const complete = (strict = true) =>
    PerplexityAIChatCompleteResponseTransform(
      body as never,
      200,
      new Headers(),
      strict,
    ) as ChatCompletionResponse;

  it('says why the model stopped', () => {
    // The finish reason was the empty string whatever the model did, which left
    // a truncated answer looking exactly like a complete one.
    expect(complete().choices[0].finish_reason).toBe('length');
  });

  it('returns every answer, not only the first', () => {
    // The config caps `n` at 1, so the gateway cannot currently ask Perplexity
    // for a second answer. This pins the transform's own contract rather than a
    // reachable failure: only `choices[0]` used to survive.
    const result = complete();

    expect(result.choices).toHaveLength(2);
    expect(result.choices.map((c) => c.message.content)).toEqual(['first', 'second']);
    expect(result.choices.map((c) => c.index)).toEqual([0, 1]);
  });

  it('keeps everything it charged for, not only the searches it ran', () => {
    const usage = complete().usage as any;

    expect(usage.num_search_queries).toBe(2);
    expect(usage.reasoning_tokens).toBe(40);
    expect(usage.citation_tokens).toBe(5);
    expect(usage.cost).toEqual({ total_cost: 0.01 });
    // Reported flat by Perplexity, and under the breakdown by everyone else,
    // which is where the Responses adapter reads it from.
    expect(usage.completion_tokens_details.reasoning_tokens).toBe(40);
  });
});
