import { constructConfigFromRequestHeaders } from '../request';
import type { ErrorEvent } from '@sentry/core';
import * as Sentry from '@sentry/node-core/light';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * The provider configs are built on demand, so what these cover is that asking
 * for one provider still yields exactly that provider's headers — and none of
 * the other fourteen providers' — down both the plain and the `config` path.
 */

const events: ErrorEvent[] = [];

beforeAll(() => {
  Sentry.init({
    beforeSend: (event) => {
      events.push(event as ErrorEvent);
      return null;
    },
    dsn: 'https://public@example.invalid/1',
  });
});

beforeEach(() => {
  events.length = 0;
});

/** Every header the function reads, so nothing is absent for the wrong reason. */
const ALL_HEADERS: Record<string, string> = {
  authorization: 'Bearer sk-test',
  'x-api-key': 'anthropic-key',
  'x-lightport-aws-access-key-id': 'akid',
  'x-lightport-aws-region': 'region',
  'x-lightport-amzn-sagemaker-target-model': 'stm',
  'x-lightport-azure-resource-name': 'rn',
  'x-lightport-databricks-workspace': 'dbw',
  'x-lightport-fireworks-account-id': 'fai',
  'x-lightport-huggingface-base-url': 'hfurl',
  'x-lightport-openai-organization': 'org',
  'x-lightport-oracle-tenancy': 'ot',
  'x-lightport-stability-client-id': 'sci',
  'x-lightport-vertex-project-id': 'vpi',
  'x-lightport-workers-ai-account-id': 'waai',
};

const configFor = (provider: string, extra: Record<string, string> = {}) =>
  constructConfigFromRequestHeaders({
    ...ALL_HEADERS,
    'x-lightport-provider': provider,
    ...extra,
  }) as Record<string, any>;

/** One key that only this provider's config contributes. */
const OWN_KEY: Record<string, string> = {
  anthropic: 'anthropicApiKey',
  'azure-openai': 'resourceName',
  bedrock: 'awsAccessKeyId',
  databricks: 'databricksWorkspace',
  'fireworks-ai': 'fireworksAccountId',
  huggingface: 'huggingfaceBaseUrl',
  openai: 'openaiOrganization',
  oracle: 'oracleTenancy',
  sagemaker: 'amznSagemakerTargetModel',
  'stability-ai': 'stabilityClientId',
  'vertex-ai': 'vertexProjectId',
  'workers-ai': 'workersAiAccountId',
};

const providers = Object.keys(OWN_KEY);

describe('constructConfigFromRequestHeaders', () => {
  it.each(providers)('gives %s its own headers and no other provider’s', (provider) => {
    const config = configFor(provider);

    expect(config[OWN_KEY[provider]]).toBeDefined();

    for (const other of providers) {
      // Bedrock and SageMaker deliberately share the AWS credential block, and
      // every provider is entitled to the keys it names itself.
      if (other === provider) continue;
      if (OWN_KEY[other] === OWN_KEY[provider]) continue;
      if (provider === 'sagemaker' && other === 'bedrock') continue;

      expect(config[OWN_KEY[other]], `${provider} leaked ${OWN_KEY[other]}`).toBeUndefined();
    }
  });

  it('gives SageMaker the AWS credentials as well as its own', () => {
    const config = configFor('sagemaker');

    expect(config.awsAccessKeyId).toBe('akid');
    expect(config.amznSagemakerTargetModel).toBe('stm');
  });

  it('carries provider and api key on every request', () => {
    const config = configFor('openai');

    expect(config.provider).toBe('openai');
    expect(config.apiKey).toBe('sk-test');
  });

  it('carries guardrail defaults down both paths', () => {
    const guardrails = {
      'x-lightport-default-input-guardrails': '[{"a":1}]',
      'x-lightport-default-output-guardrails': '[{"b":2}]',
    };

    for (const extra of [guardrails, { ...guardrails, 'x-lightport-config': '{"cache":{}}' }]) {
      const config = configFor('openai', extra);

      expect(config.defaultInputGuardrails).toEqual([{ a: 1 }]);
      expect(config.defaultOutputGuardrails).toEqual([{ b: 2 }]);
    }
  });

  describe('the config header path', () => {
    it('merges the named provider’s headers into the parsed config', () => {
      const config = configFor('bedrock', {
        'x-lightport-config': JSON.stringify({ provider: 'bedrock', api_key: 'in-config' }),
      });

      expect(config.apiKey).toBe('in-config');
      expect(config.awsS3Bucket).toBeUndefined();
      expect(config.anthropicVersion).toBeUndefined();
    });

    it('takes the provider from the header when the config names none', () => {
      // `targets` used to be the other way a config could say where to go, and
      // was left alone here on the strength of it. Validation refuses that
      // config now — nothing resolves a target, so it named no provider either
      // — which leaves the header as the only remaining source.
      const config = configFor('openai', {
        'x-lightport-config': JSON.stringify({ api_key: 'in-config' }),
      });

      expect(config.provider).toBe('openai');
      expect(config.apiKey).toBe('sk-test');
      expect(config.openaiOrganization).toBe('org');
    });
  });

  describe('the vertex service account credential', () => {
    const VALID = { 'x-lightport-vertex-service-account-json': '{"client_email":"a@b.c"}' };
    const MALFORMED = { 'x-lightport-vertex-service-account-json': '{not json' };

    it('is parsed for vertex', () => {
      expect(configFor('vertex-ai', VALID).vertexServiceAccountJson).toEqual({
        client_email: 'a@b.c',
      });
    });

    it('reports a malformed credential for vertex', async () => {
      expect(configFor('vertex-ai', MALFORMED).vertexServiceAccountJson).toBeNull();

      await Sentry.flush(2_000);

      expect(events).toHaveLength(1);
      expect(events[0].exception?.values?.[0]?.value).toContain('vertex service account');
    });

    it('is not read at all for a provider that cannot use it', async () => {
      // It used to be parsed for every request whatever the provider, so one
      // malformed header raised an exception on requests that never touched it.
      expect(configFor('openai', MALFORMED).vertexServiceAccountJson).toBeUndefined();

      await Sentry.flush(2_000);

      expect(events).toHaveLength(0);
    });
  });
});
