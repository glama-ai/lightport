import { ProviderConfigs } from '../types';
import VoyageAPIConfig from './api';
import { VoyageEmbedConfig, VoyageEmbedResponseTransform } from './embed';
import { VoyageRerankConfig, VoyageRerankResponseTransform } from './rerank';

const VoyageConfig: ProviderConfigs = {
  embed: VoyageEmbedConfig,
  rerank: VoyageRerankConfig,
  api: VoyageAPIConfig,
  responseTransforms: {
    embed: VoyageEmbedResponseTransform,
    rerank: VoyageRerankResponseTransform,
  },
};

export default VoyageConfig;
