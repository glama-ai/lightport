import { logger } from '../logger';
import { externalServiceFetch } from './fetch';

export interface GCPCredentials {
  access_token: string;
  expires_in: number;
}

export async function fetchWorkloadIdentityToken(): Promise<GCPCredentials | undefined> {
  const METADATA_TOKEN_ENDPOINT =
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

  try {
    const response = await externalServiceFetch(METADATA_TOKEN_ENDPOINT, {
      method: 'GET',
      headers: {
        'Metadata-Flavor': 'Google',
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error(
        { status: response.status, response: errorBody },
        'error from Workload Identity Federation',
      );
      return undefined;
    }

    const data: {
      access_token: string;
      expires_in: number;
    } = await response.json();

    return data;
  } catch (err: unknown) {
    logger.error({ err }, 'Workload Identity token generation error');
    return undefined;
  }
}
