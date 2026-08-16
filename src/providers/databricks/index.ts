import { DATABRICKS } from '../../globals';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';

// Databricks serves every endpoint from `/{model}/invocations` on a host named
// after the caller's own workspace, so both halves of the address are theirs.
const invocations = ({ gatewayRequestBodyJSON }: { gatewayRequestBodyJSON: { model?: string } }) =>
  `/${gatewayRequestBodyJSON.model}/invocations`;

const DatabricksConfig = defineOpenAICompatibleProvider({
  name: DATABRICKS,
  baseURL: ({ providerOptions }) => {
    const workspace = providerOptions.databricksWorkspace;
    if (!workspace) {
      throw new Error('Databricks workspace or base URL must be provided');
    }

    return `https://${workspace}.cloud.databricks.com/serving-endpoints`;
  },
  endpoints: {
    chatComplete: {
      path: invocations,
      defaultModel: null,
      extra: {
        thinking: { param: 'thinking', required: false },
        reasoning_effort: { param: 'reasoning_effort', required: false },
      },
    },
    complete: { path: invocations, defaultModel: null },
    // The model is named in the path, so naming it in the body too would send
    // it twice; `dimensions`, `encoding_format` and `user` are not read here.
    embed: {
      path: invocations,
      defaultModel: null,
      exclude: ['model', 'dimensions', 'encoding_format', 'user'],
    },
  },
});

export default DatabricksConfig;
