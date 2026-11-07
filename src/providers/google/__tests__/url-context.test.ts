import { describe, expect, it } from 'vitest';
import { transformUsingProviderConfig } from '../../../services/transformToProviderRequest';
import type { Params } from '../../../types/requestBody';
import { VertexGoogleChatCompleteConfig } from '../../google-vertex-ai/chatComplete';
import { GoogleChatCompleteConfig } from '../chatComplete';

describe.each([
  ['google', GoogleChatCompleteConfig],
  ['vertex-ai', VertexGoogleChatCompleteConfig],
])('%s url context', (_provider, config) => {
  it.each(['url_context', 'urlContext'])('is sent as the built-in tool when named %s', (name) => {
    const { tools } = transformUsingProviderConfig(config, {
      messages: [{ content: 'Summarise https://example.com', role: 'user' }],
      model: 'gemini-2.5-flash',
      tools: [{ function: { name }, type: 'function' }],
    } as unknown as Params) as Record<string, any>;

    expect(tools).toContainEqual({ urlContext: {} });
    expect(JSON.stringify(tools)).not.toContain('functionDeclarations');
  });
});
