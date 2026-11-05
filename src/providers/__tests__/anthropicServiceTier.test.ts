import { describe, expect, it } from 'vitest';
import { transformUsingProviderConfig } from '../../services/transformToProviderRequest';
import type { Options, Params } from '../../types/requestBody';
import { getAnthropicStreamChunkTransform } from '../anthropic/chatComplete';
import ProviderConfigs from '../index';
import type { ProviderConfig } from '../types';

const configs = ProviderConfigs as any;

const sent = (config: ProviderConfig, serviceTier: string) =>
  transformUsingProviderConfig(
    config,
    {
      messages: [{ content: 'hi', role: 'user' }],
      model: 'claude-sonnet-4-5',
      service_tier: serviceTier,
    } as unknown as Params,
    {} as Options,
  );

describe('the service tier anthropic is sent', () => {
  // Anthropic has two tiers and refuses OpenAI's names for them but `auto`.
  it.each([
    ['auto', 'auto'],
    ['priority', 'auto'],
    ['default', 'standard_only'],
    ['standard_only', 'standard_only'],
  ])('is %s sent as %s', (asked, expected) => {
    expect(sent(configs.anthropic.chatComplete, asked).service_tier).toBe(expected);
  });

  it.each(['flex', 'scale', 'constructor'])(
    'is not sent for %s, which it has no tier for',
    (asked) => {
      const request = sent(configs.anthropic.chatComplete, asked);

      expect(request.service_tier).toBeUndefined();
      expect(JSON.stringify(request)).not.toContain('service_tier');
    },
  );

  // Their Claude configs are built on Anthropic's, and neither takes the field.
  it('is not sent to claude on vertex or azure', () => {
    const azure = configs['azure-ai'].getConfig({
      providerOptions: { azureFoundryUrl: 'https://x.services.ai.azure.com/anthropic' },
    }).chatComplete;

    expect(
      sent(
        configs['vertex-ai'].getConfig({ params: { model: 'anthropic.claude-sonnet-4-5' } })
          .chatComplete,
        'auto',
      ),
    ).not.toHaveProperty('service_tier');
    expect(sent(azure, 'auto')).not.toHaveProperty('service_tier');
  });
});

describe('the service tier anthropic answers with', () => {
  const reply = (serviceTier?: string) => ({
    content: [{ text: 'hi', type: 'text' }],
    id: 'msg_1',
    model: 'claude-sonnet-4-5',
    role: 'assistant',
    stop_reason: 'end_turn',
    stop_sequence: null,
    type: 'message',
    usage: { input_tokens: 3, output_tokens: 1, ...(serviceTier && { service_tier: serviceTier }) },
  });

  const complete = (serviceTier?: string) =>
    configs.anthropic.responseTransforms.chatComplete(reply(serviceTier), 200, new Headers(), true);

  // Anthropic reports it inside `usage`; OpenAI's clients read it beside it.
  it('is reported where OpenAI reports it, in OpenAI’s name', () => {
    expect(complete('standard').service_tier).toBe('default');
    expect(complete('priority').service_tier).toBe('priority');
    expect(complete('priority').usage).not.toHaveProperty('service_tier');
  });

  it('is not reported when anthropic does not say', () => {
    expect(complete()).not.toHaveProperty('service_tier');
  });

  it('is reported with the usage of a stream', () => {
    const stream = getAnthropicStreamChunkTransform('anthropic');
    const state = {} as any;

    stream(
      `data: ${JSON.stringify({
        message: {
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 3, service_tier: 'priority' },
        },
        type: 'message_start',
      })}`,
      'fallback',
      state,
      true,
    );
    const last = stream(
      `data: ${JSON.stringify({
        delta: { stop_reason: 'end_turn' },
        type: 'message_delta',
        usage: { output_tokens: 1 },
      })}`,
      'fallback',
      state,
      true,
    );

    expect(JSON.parse(String(last).replace(/^data: /, '')).service_tier).toBe('priority');
  });
});
