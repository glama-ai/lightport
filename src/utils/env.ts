import fs from 'fs';
import path from 'path';

export function getValueOrFileContents(value?: string, ignore?: boolean) {
  if (!value || ignore) return value;

  try {
    // Check if value looks like a file path
    if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) {
      // Resolve the path (handle relative paths)
      const resolvedPath = path.resolve(value);

      // Check if file exists
      if (fs.existsSync(resolvedPath)) {
        // File exists, read and return its contents
        return fs.readFileSync(resolvedPath, 'utf8').trim();
      }
    }

    // If not a file path or file doesn't exist, return value as is
    return value;
  } catch (error: any) {
    console.log(`Error reading file at ${value}: ${error.message}`);
    // Return the original value if there's an error
    return value;
  }
}

const nodeEnv = {
  NODE_ENV: getValueOrFileContents(process.env.NODE_ENV, true),
  PORT: getValueOrFileContents(process.env.PORT) || 8787,
  SERVICE_NAME: getValueOrFileContents(process.env.SERVICE_NAME, true),

  SENTRY_DSN: getValueOrFileContents(process.env.SENTRY_DSN),

  TLS_KEY_PATH: getValueOrFileContents(process.env.TLS_KEY_PATH, true),
  TLS_CERT_PATH: getValueOrFileContents(process.env.TLS_CERT_PATH, true),
  TLS_CA_PATH: getValueOrFileContents(process.env.TLS_CA_PATH, true),

  TLS_KEY: getValueOrFileContents(process.env.TLS_KEY, true),
  TLS_CERT: getValueOrFileContents(process.env.TLS_CERT, true),
  TLS_CA: getValueOrFileContents(process.env.TLS_CA, true),

  HOME: getValueOrFileContents(process.env.HOME, true),
  USERPROFILE: getValueOrFileContents(process.env.USERPROFILE, true),
  AWS_ACCESS_KEY_ID: getValueOrFileContents(process.env.AWS_ACCESS_KEY_ID),
  AWS_SECRET_ACCESS_KEY: getValueOrFileContents(process.env.AWS_SECRET_ACCESS_KEY),
  AWS_SESSION_TOKEN: getValueOrFileContents(process.env.AWS_SESSION_TOKEN),
  AWS_ROLE_ARN: getValueOrFileContents(process.env.AWS_ROLE_ARN),
  AWS_PROFILE: getValueOrFileContents(process.env.AWS_PROFILE, true),
  AWS_WEB_IDENTITY_TOKEN_FILE: getValueOrFileContents(
    process.env.AWS_WEB_IDENTITY_TOKEN_FILE,
    true,
  ),
  AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: getValueOrFileContents(
    process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE,
    true,
  ),
  AWS_CONTAINER_CREDENTIALS_FULL_URI: getValueOrFileContents(
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
    true,
  ),
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: getValueOrFileContents(
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI,
    true,
  ),
  AWS_ASSUME_ROLE_ACCESS_KEY_ID: getValueOrFileContents(process.env.AWS_ASSUME_ROLE_ACCESS_KEY_ID),
  AWS_ASSUME_ROLE_SECRET_ACCESS_KEY: getValueOrFileContents(
    process.env.AWS_ASSUME_ROLE_SECRET_ACCESS_KEY,
  ),
  AWS_ASSUME_ROLE_REGION: getValueOrFileContents(process.env.AWS_ASSUME_ROLE_REGION),
  AWS_ASSUME_ROLE_SOURCE_ARN: getValueOrFileContents(process.env.AWS_ASSUME_ROLE_SOURCE_ARN),
  AWS_ASSUME_ROLE_SOURCE_EXTERNAL_ID: getValueOrFileContents(
    process.env.AWS_ASSUME_ROLE_SOURCE_EXTERNAL_ID,
  ),
  AWS_REGION: getValueOrFileContents(process.env.AWS_REGION),
  AWS_DEFAULT_REGION: getValueOrFileContents(process.env.AWS_DEFAULT_REGION),
  AWS_ENDPOINT_DOMAIN: getValueOrFileContents(process.env.AWS_ENDPOINT_DOMAIN),
  AWS_IMDS_V1: getValueOrFileContents(process.env.AWS_IMDS_V1),
  ECS_CONTAINER_METADATA_URI_V4: getValueOrFileContents(process.env.ECS_CONTAINER_METADATA_URI_V4),
  ECS_CONTAINER_METADATA_URI: getValueOrFileContents(process.env.ECS_CONTAINER_METADATA_URI),

  AZURE_AUTHORITY_HOST: getValueOrFileContents(process.env.AZURE_AUTHORITY_HOST),
  AZURE_TENANT_ID: getValueOrFileContents(process.env.AZURE_TENANT_ID),
  AZURE_CLIENT_ID: getValueOrFileContents(process.env.AZURE_CLIENT_ID),
  AZURE_FEDERATED_TOKEN_FILE: getValueOrFileContents(process.env.AZURE_FEDERATED_TOKEN_FILE),
  AZURE_IDENTITY_ENDPOINT: getValueOrFileContents(process.env.AZURE_IDENTITY_ENDPOINT),
  AZURE_MANAGED_VERSION: getValueOrFileContents(process.env.AZURE_MANAGED_VERSION),
  AZURE_MANAGED_IDENTITY_HEADER: getValueOrFileContents(
    process.env.AZURE_MANAGED_IDENTITY_HEADER,
  ),

  GCP_AUTH_MODE: getValueOrFileContents(process.env.GCP_AUTH_MODE),

  HTTP_PROXY: getValueOrFileContents(process.env.HTTP_PROXY),
  HTTPS_PROXY: getValueOrFileContents(process.env.HTTPS_PROXY),
  NO_PROXY: getValueOrFileContents(process.env.NO_PROXY),

  REQUEST_TIMEOUT: getValueOrFileContents(process.env.REQUEST_TIMEOUT),

  CORS_ALLOWED_ORIGINS: getValueOrFileContents(process.env.CORS_ALLOWED_ORIGINS),
  ENABLE_CORS: getValueOrFileContents(process.env.ENABLE_CORS),
  CORS_ALLOWED_HEADERS: getValueOrFileContents(process.env.CORS_ALLOWED_HEADERS || '*'),
  CORS_ALLOWED_EXPOSE_HEADERS: getValueOrFileContents(
    process.env.CORS_ALLOWED_EXPOSE_HEADERS || '*',
  ),
  CORS_ALLOWED_METHODS: getValueOrFileContents(process.env.CORS_ALLOWED_METHODS || '*'),

  SSE_ENCRYPTION_TYPE: getValueOrFileContents(process.env.SSE_ENCRYPTION_TYPE),
  KMS_KEY_ID: getValueOrFileContents(process.env.KMS_KEY_ID),
  KMS_BUCKET_KEY_ENABLED: getValueOrFileContents(process.env.KMS_BUCKET_KEY_ENABLED),
  KMS_ENCRYPTION_CONTEXT: getValueOrFileContents(process.env.KMS_ENCRYPTION_CONTEXT),
  KMS_ENCRYPTION_ALGORITHM: getValueOrFileContents(process.env.KMS_ENCRYPTION_ALGORITHM),
  KMS_ENCRYPTION_CUSTOMER_KEY: getValueOrFileContents(process.env.KMS_ENCRYPTION_CUSTOMER_KEY),
  KMS_ENCRYPTION_CUSTOMER_KEY_MD5: getValueOrFileContents(
    process.env.KMS_ENCRYPTION_CUSTOMER_KEY_MD5,
  ),

  TRUSTED_CUSTOM_HOSTS: getValueOrFileContents(process.env.TRUSTED_CUSTOM_HOSTS),
};

export const Environment = (_env?: Record<string, any>) => nodeEnv;
