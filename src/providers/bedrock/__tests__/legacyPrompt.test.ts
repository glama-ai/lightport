import { describe, expect, it } from 'vitest';
import { transformUsingProviderConfig } from '../../../services/transformToProviderRequest';
import type { Params } from '../../../types/requestBody';
import { BedrockAI21ChatCompleteConfig, BedrockCohereChatCompleteConfig } from '../chatComplete';

describe.each([
  ['cohere', BedrockCohereChatCompleteConfig],
  ['ai21', BedrockAI21ChatCompleteConfig],
])('the prompt a legacy %s model on bedrock is sent', (_family, config) => {
  const prompt = (messages: unknown[]) =>
    transformUsingProviderConfig(config, { messages, model: 'm' } as unknown as Params).prompt;

  // Written as the whole message list, which read `[object Object],[object Object]`.
  it('carries the system message itself', () => {
    expect(
      prompt([
        { content: 'Be terse.', role: 'system' },
        { content: 'Hi', role: 'user' },
      ]),
    ).toBe('system: Be terse.\nuser: Hi\nAssistant:');
  });

  it('carries content sent as parts as its text', () => {
    expect(
      prompt([
        {
          content: [
            { text: 'Hi', type: 'text' },
            { text: 'there', type: 'text' },
          ],
          role: 'user',
        },
      ]),
    ).toBe('user: Hi\nthere\nAssistant:');
  });
});
