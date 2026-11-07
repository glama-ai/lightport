import { describe, expect, it } from 'vitest';
import { transformUsingProviderConfig } from '../../services/transformToProviderRequest';
import type { Options, Params } from '../../types/requestBody';
import ProviderConfigs from '../index';
import type { ProviderConfig } from '../types';

const azure = (ProviderConfigs as any)['azure-openai'];

const modelSent = (fn: string, params: Record<string, unknown>, options: Partial<Options>) =>
  transformUsingProviderConfig(
    azure[fn] as ProviderConfig,
    params as unknown as Params,
    { provider: 'azure-openai', ...options } as Options,
  ).model;

describe('the model azure is sent', () => {
  // The Responses address names no deployment on a dated version, so Azure
  // reads it from here — and a deployment named anything but its model was
  // answered DeploymentNotFound.
  it.each(['2025-04-01-preview', 'v1'])(
    'is the deployment on a responses request with api version %s',
    (apiVersion) => {
      expect(
        modelSent(
          'createModelResponse',
          { input: 'hi', model: 'gpt-4o' },
          { apiVersion, deploymentId: 'prod-4o' },
        ),
      ).toBe('prod-4o');
    },
  );

  // `v1` without a deployment id sent no model at all.
  it('falls back to the model when no deployment is named', () => {
    expect(
      modelSent('chatComplete', { messages: [], model: 'prod-4o' }, { apiVersion: 'v1' }),
    ).toBe('prod-4o');
    expect(
      modelSent('createModelResponse', { input: 'hi', model: 'prod-4o' }, { apiVersion: 'v1' }),
    ).toBe('prod-4o');
  });

  it('is the deployment on a v1 chat request, as it was', () => {
    expect(
      modelSent(
        'chatComplete',
        { messages: [], model: 'gpt-4o' },
        { apiVersion: 'v1', deploymentId: 'prod-4o' },
      ),
    ).toBe('prod-4o');
  });
});
