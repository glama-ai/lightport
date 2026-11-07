import { AZURE_OPEN_AI } from '../../globals';
import { requestCache } from '../../services/cache/cacheService';
import { Options, Params } from '../../types/requestBody';
import {
  fetchEntraIdToken,
  fetchManagedIdentityToken,
  fetchAzureWorkloadIdentityToken,
} from '../../utils/azureAuth';
import { OpenAIErrorResponseTransform } from '../openai/utils';
import { ErrorResponse } from '../types';

const CACHE_EXPIRY = 15 * 60; // 15 minutes

export async function getAccessTokenFromEntraId(
  tenantId: string,
  clientId: string,
  clientSecret: string,
  scope = 'https://openai.azure.com/.default',
  env: Record<string, any>,
) {
  const cache = requestCache(env);
  const cacheKey = `azure-entra-token-object-${tenantId}-${clientId}-${clientSecret}-${scope}`;
  const cachedToken = await cache.get<{ access_token: string }>(cacheKey, {
    useLocalCache: true,
  });
  if (cachedToken?.access_token) {
    return cachedToken.access_token;
  }

  const token = await fetchEntraIdToken(tenantId, clientId, clientSecret, scope);
  if (token) {
    await cache.set(cacheKey, { access_token: token }, { ttl: CACHE_EXPIRY });
  }
  return token;
}

export async function getAzureManagedIdentityToken(
  resource: string,
  clientId?: string,
  env?: Record<string, any>,
) {
  const cache = requestCache(env);
  const cacheKey = `azure-managed-identity-token-object-${resource}-${clientId ?? ''}`;
  const cachedToken = await cache.get<{ access_token: string }>(cacheKey, {
    useLocalCache: true,
  });
  if (cachedToken?.access_token) {
    return cachedToken.access_token;
  }

  const token = await fetchManagedIdentityToken(resource, clientId);
  if (token) {
    await cache.set(cacheKey, { access_token: token }, { ttl: CACHE_EXPIRY });
  }
  return token;
}

export async function getAzureWorkloadIdentityToken(
  authorityHost: string,
  tenantId: string,
  clientId: string,
  federatedToken: string,
  scope = 'https://cognitiveservices.azure.com/.default',
  env?: Record<string, any>,
) {
  const cache = requestCache(env);
  const cacheKey = `azure-workload-identity-token-object-${authorityHost}-${tenantId}-${clientId}-${federatedToken}-${scope}`;
  const cachedToken = await cache.get<{ access_token: string }>(cacheKey, {
    useLocalCache: true,
  });
  if (cachedToken?.access_token) {
    return cachedToken.access_token;
  }

  const token = await fetchAzureWorkloadIdentityToken(
    authorityHost,
    tenantId,
    clientId,
    federatedToken,
    scope,
    env,
  );
  if (token) {
    await cache.set(cacheKey, { access_token: token }, { ttl: CACHE_EXPIRY });
  }
  return token;
}

export const AzureOpenAIFinetuneResponseTransform = (
  response: Response | ErrorResponse,
  responseStatus: number,
): Response | ErrorResponse => {
  if (responseStatus !== 200 && 'error' in response) {
    return OpenAIErrorResponseTransform(response, AZURE_OPEN_AI);
  }

  const _response = { ...response } as any;

  if (['created', 'pending'].includes(_response.status)) {
    _response.status = 'queued';
  }

  return _response;
};

/**
 * The `model` Azure is sent, which is the deployment's name rather than the
 * model's wherever Azure reads it.
 *
 * Azure reads it wherever the address does not already name the deployment:
 * every route of the `v1` API, and the Responses API on a dated version, whose
 * address is `/openai/responses` with no deployment in it. The model's own name
 * was sent there, so a deployment named anything but its model answered
 * DeploymentNotFound to a Responses request while chat — whose address names it
 * — worked; and `v1` without a deployment id sent no model at all. A dated
 * route that names the deployment ignores the field, so the one rule serves
 * every route.
 */
export const getAzureModelValue = (params: Params, providerOptions?: Options) => {
  return providerOptions?.deploymentId || params.model || '';
};
