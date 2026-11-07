import { ambientIdentityRefusal } from '../ambientIdentity';
import { describe, expect, it } from 'vitest';

describe('ambientIdentityRefusal', () => {
  it.each([
    'https://example.openai.azure.com/openai/deployments/gpt-4o/chat/completions',
    'https://example.cognitiveservices.azure.com/openai/v1/chat/completions',
    'https://example.services.ai.azure.com/models/chat/completions',
    'https://example.eastus2.models.ai.azure.com/chat/completions',
    'https://example.openai.azure.us/openai/deployments/gpt-4o/chat/completions',
    'https://example.openai.azure.cn/openai/deployments/gpt-4o/chat/completions',
  ])('lets a managed identity go to azure at %s', (url) => {
    expect(ambientIdentityRefusal('azure-openai', { azureAuthMode: 'managed' }, url)).toBe(
      undefined,
    );
  });

  it.each([
    'https://attacker.com/openai/deployments/gpt-4o/chat/completions',
    // An azure hostname as a label of someone else's domain.
    'https://example.openai.azure.com.attacker.com/openai',
    // A resource name that ended the host early.
    'https://attacker.com/?.openai.azure.com/openai',
    'https://attacker.com#.openai.azure.com/openai',
    'not a url',
  ])('refuses a managed identity at %s', (url) => {
    expect(ambientIdentityRefusal('azure-openai', { azureAuthMode: 'managed' }, url)).toContain(
      "gateway's own credentials",
    );
  });

  it.each(['azure-ai', 'github'])('holds %s to the same hosts', (provider) => {
    expect(
      ambientIdentityRefusal(provider, { azureAuthMode: 'workload' }, 'https://attacker.com/'),
    ).toBeDefined();
    expect(
      ambientIdentityRefusal(
        provider,
        { azureAuthMode: 'workload' },
        'https://example.services.ai.azure.com/models',
      ),
    ).toBe(undefined);
  });

  it.each([
    'https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1',
    'https://aiplatform.googleapis.com/v1/projects/p/locations/global',
  ])('lets a vertex workload identity go to %s', (url) => {
    expect(ambientIdentityRefusal('vertex-ai', { vertexAuthType: 'workload' }, url)).toBe(
      undefined,
    );
  });

  it.each([
    'https://attacker.com/v1/projects/p',
    'https://attacker.com/?-aiplatform.googleapis.com/v1/projects/p',
    'https://storage.googleapis.com/bucket',
  ])('refuses a vertex workload identity at %s', (url) => {
    expect(ambientIdentityRefusal('vertex-ai', { vertexAuthType: 'workload' }, url)).toBeDefined();
  });

  // Credentials the caller supplied are theirs to send where they like.
  it.each([
    ['azure-openai', {}],
    ['azure-openai', { azureAuthMode: 'entra' }],
    ['azure-openai', { azureAdToken: 'token', azureAuthMode: 'managed' }],
    ['vertex-ai', {}],
    ['vertex-ai', { vertexAuthType: 'workload', vertexServiceAccountJson: { project_id: 'p' } }],
    ['openai', { azureAuthMode: 'managed' }],
  ])('leaves %s with %o alone', (provider, options) => {
    expect(ambientIdentityRefusal(provider, options, 'https://attacker.com/')).toBe(undefined);
  });
});
