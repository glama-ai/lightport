/**
 * Provider connectivity smoke tests.
 *
 * Each registered provider is tested with a minimal chat completion and
 * responses API request. Tests are skipped when the required environment
 * variables are not set.
 */

import createApp from '../index';
import { afterAll, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

interface ProviderEntry {
  provider: string;
  model: string;
  env: Record<string, string>;
  headers?: Record<string, string>;
  responsesModel?: string;
}

const env = (key: string) => process.env[key] ?? '';

const PROVIDERS: ProviderEntry[] = [
  // --- OpenAI-compatible (API key only) ---
  {
    provider: 'openai',
    model: 'gpt-4o-mini',
    responsesModel: 'gpt-4o-mini',
    env: { OPENAI_API_KEY: '' },
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    responsesModel: 'claude-sonnet-4-20250514',
    env: { ANTHROPIC_API_KEY: '' },
  },
  {
    provider: 'groq',
    model: 'llama-3.1-8b-instant',
    env: { GROQ_API_KEY: '' },
  },
  {
    provider: 'mistral-ai',
    model: 'mistral-small-latest',
    env: { MISTRAL_API_KEY: '' },
  },
  {
    provider: 'cohere',
    model: 'command-r',
    env: { COHERE_API_KEY: '' },
  },
  {
    provider: 'together-ai',
    model: 'meta-llama/Llama-3-8b-chat-hf',
    env: { TOGETHER_API_KEY: '' },
  },
  {
    provider: 'fireworks-ai',
    model: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
    env: { FIREWORKS_API_KEY: '' },
  },
  {
    provider: 'deepinfra',
    model: 'meta-llama/Llama-3.3-70B-Instruct',
    env: { DEEPINFRA_API_KEY: '' },
  },
  {
    provider: 'deepseek',
    model: 'deepseek-chat',
    env: { DEEPSEEK_API_KEY: '' },
  },
  {
    provider: 'perplexity-ai',
    model: 'sonar',
    env: { PERPLEXITY_API_KEY: '' },
  },
  {
    provider: 'openrouter',
    model: 'meta-llama/llama-3.1-8b-instruct',
    env: { OPENROUTER_API_KEY: '' },
  },
  {
    provider: 'cerebras',
    model: 'llama-4-scout-17b-16e-instruct',
    env: { CEREBRAS_API_KEY: '' },
  },
  {
    provider: 'sambanova',
    model: 'Meta-Llama-3.1-8B-Instruct',
    env: { SAMBANOVA_API_KEY: '' },
  },
  {
    provider: 'x-ai',
    model: 'grok-3-mini-fast',
    env: { XAI_API_KEY: '' },
  },
  {
    provider: 'google',
    model: 'gemini-2.5-flash',
    env: { GOOGLE_API_KEY: '' },
  },

  // --- Providers that need extra headers ---
  {
    provider: 'azure-openai',
    model: 'gpt-4o-mini',
    env: {
      AZURE_OPENAI_API_KEY: '',
      AZURE_OPENAI_RESOURCE_NAME: '',
      AZURE_OPENAI_DEPLOYMENT_ID: '',
    },
    headers: {
      'x-lightport-azure-resource-name': 'AZURE_OPENAI_RESOURCE_NAME',
      'x-lightport-azure-deployment-id': 'AZURE_OPENAI_DEPLOYMENT_ID',
      'x-lightport-azure-api-version': '2024-06-01',
    },
  },
  {
    provider: 'bedrock',
    model: 'anthropic.claude-3-haiku-20240307-v1:0',
    env: {
      AWS_ACCESS_KEY_ID: '',
      AWS_SECRET_ACCESS_KEY: '',
      AWS_REGION: '',
    },
    headers: {
      'x-lightport-aws-access-key-id': 'AWS_ACCESS_KEY_ID',
      'x-lightport-aws-secret-access-key': 'AWS_SECRET_ACCESS_KEY',
      'x-lightport-aws-region': 'AWS_REGION',
    },
  },
  {
    provider: 'vertex-ai',
    model: 'gemini-2.0-flash',
    env: {
      VERTEX_SERVICE_ACCOUNT_JSON: '',
      VERTEX_PROJECT_ID: '',
      VERTEX_REGION: '',
    },
    headers: {
      'x-lightport-vertex-service-account-json': 'VERTEX_SERVICE_ACCOUNT_JSON',
      'x-lightport-vertex-project-id': 'VERTEX_PROJECT_ID',
      'x-lightport-vertex-region': 'VERTEX_REGION',
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveCredentials(entry: ProviderEntry): {
  available: boolean;
  apiKey: string;
  extraHeaders: Record<string, string>;
  missing: string[];
} {
  const missing: string[] = [];
  const resolved: Record<string, string> = {};

  for (const envKey of Object.keys(entry.env)) {
    const value = env(envKey);
    if (!value) missing.push(envKey);
    resolved[envKey] = value;
  }

  if (missing.length > 0) {
    return { available: false, apiKey: '', extraHeaders: {}, missing };
  }

  // First env key is the API key by convention
  const apiKey = resolved[Object.keys(entry.env)[0]];

  const extraHeaders: Record<string, string> = {};
  if (entry.headers) {
    for (const [header, valueOrEnvKey] of Object.entries(entry.headers)) {
      extraHeaders[header] = resolved[valueOrEnvKey] ?? valueOrEnvKey;
    }
  }

  return { available: true, apiKey, extraHeaders, missing };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const app = createApp();

afterAll(async () => {
  await app.close();
});

describe('provider ping – chat completions', () => {
  for (const entry of PROVIDERS) {
    const creds = resolveCredentials(entry);

    const name = creds.available
      ? `${entry.provider} responds to a simple completion`
      : `${entry.provider} (missing ${creds.missing.join(', ')})`;

    it.skipIf(!creds.available)(
      name,
      async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${creds.apiKey}`,
            'x-lightport-provider': entry.provider,
            ...creds.extraHeaders,
          },
          payload: JSON.stringify({
            model: entry.model,
            max_tokens: 5,
            messages: [{ role: 'user', content: 'Say hi.' }],
          }),
        });

        expect(response.statusCode).toBe(200);

        const body = response.json();
        expect(body.choices).toBeDefined();
        expect(body.choices.length).toBeGreaterThan(0);
        expect(body.choices[0].message?.content).toBeTruthy();
      },
      30_000,
    );
  }
});

describe('provider ping – responses API', () => {
  const responsesProviders = PROVIDERS.filter((e) => e.responsesModel);

  for (const entry of responsesProviders) {
    const creds = resolveCredentials(entry);

    const name = creds.available
      ? `${entry.provider} responds to a simple response`
      : `${entry.provider} (missing ${creds.missing.join(', ')})`;

    it.skipIf(!creds.available)(
      name,
      async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/responses',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${creds.apiKey}`,
            'x-lightport-provider': entry.provider,
            ...creds.extraHeaders,
          },
          payload: JSON.stringify({
            model: entry.responsesModel,
            max_output_tokens: 20,
            input: 'Say hi.',
          }),
        });

        expect(response.statusCode).toBe(200);

        const body = response.json();
        expect(body.output).toBeDefined();
        expect(body.output.length).toBeGreaterThan(0);
      },
      30_000,
    );
  }
});
