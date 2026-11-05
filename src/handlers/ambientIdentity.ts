import { AZURE_AI_INFERENCE, AZURE_OPEN_AI, GITHUB, GOOGLE_VERTEX_AI } from '../globals';
import type { Options } from '../types/requestBody';

/**
 * The authentication modes that send the gateway's own identity rather than one
 * the caller holds, and the hosts that identity is meant for.
 *
 * A managed or workload identity is the machine's: it is minted from the cloud
 * the gateway runs in, on behalf of whoever deployed it, and asked for by
 * nothing more than a header. Every other setting on the request can name the
 * host it goes to — `custom_host` outright, and the resource name or region a
 * provider interpolates into its own URL — so a caller could have the gateway
 * mint its token and send it to an address of the caller's choosing. Checked as
 * an address alone, that one is valid: it is public, and the caller's to name
 * when the credentials are the caller's.
 *
 * So the rule is on the pairing rather than on either half: with these modes the
 * request goes to the provider's own hosts or not at all. Bedrock is not here.
 * Its credentials sign the request rather than travel in it, and a signature
 * covers the host it was made for.
 */
type IdentityOptions = Pick<
  Options,
  'azureAdToken' | 'azureAuthMode' | 'vertexAuthType' | 'vertexServiceAccountJson'
>;

type AmbientIdentity = {
  /** The setting asking for the gateway's identity, as the caller wrote it — or nothing. */
  mode: (options: IdentityOptions) => string | undefined;
  ownsHost: (hostname: string) => boolean;
};

// The public cloud, Azure Government and Azure China. Every endpoint these
// providers are served from is under one of the three — `openai.azure.com`,
// `cognitiveservices.azure.com`, `services.ai.azure.com`, `models.ai.azure.com`,
// `inference.ml.azure.com` — so a suffix is the whole of the rule.
const AZURE_DOMAINS = ['.azure.com', '.azure.us', '.azure.cn'];

const azure: AmbientIdentity = {
  // A token the caller supplied is sent ahead of any mode, so naming a mode
  // beside one asks for nothing of the gateway's.
  mode: ({ azureAdToken, azureAuthMode }) =>
    !azureAdToken && (azureAuthMode === 'managed' || azureAuthMode === 'workload')
      ? `azure_auth_mode "${azureAuthMode}"`
      : undefined,
  ownsHost: (hostname) => AZURE_DOMAINS.some((domain) => hostname.endsWith(domain)),
};

const AMBIENT_IDENTITIES: Record<string, AmbientIdentity> = {
  [AZURE_OPEN_AI]: azure,
  [AZURE_AI_INFERENCE]: azure,
  // GitHub Models is served through the same configuration, auth modes included.
  [GITHUB]: azure,
  [GOOGLE_VERTEX_AI]: {
    // A service account the caller supplied is preferred to the workload's.
    mode: ({ vertexAuthType, vertexServiceAccountJson }) =>
      !vertexServiceAccountJson && vertexAuthType === 'workload'
        ? 'vertex_auth_type "workload"'
        : undefined,
    ownsHost: (hostname) =>
      hostname === 'aiplatform.googleapis.com' || hostname.endsWith('-aiplatform.googleapis.com'),
  },
};

/**
 * Why a request may not be sent to `url` with the identity it asks for, if it
 * may not.
 */
export const ambientIdentityRefusal = (
  provider: string,
  options: IdentityOptions,
  url: string,
): string | undefined => {
  const identity = AMBIENT_IDENTITIES[provider];
  const mode = identity?.mode(options);

  if (!identity || !mode) return undefined;

  let hostname = '';
  try {
    // Read from the URL as it will be sent, not from any one option: an option
    // interpolated into a hostname can end it early, and only the parser says
    // where it ended.
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    // Unparseable is no host of the provider's, and is refused as one.
  }

  return identity.ownsHost(hostname)
    ? undefined
    : `${mode} sends the gateway's own credentials, so it can only be used with ${provider}'s own hosts`;
};
