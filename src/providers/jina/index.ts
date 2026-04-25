import { ProviderConfigs } from '../types';
import JinaAPIConfig from './api';
import { JinaEmbedConfig, JinaEmbedResponseTransform } from './embed';
import { JinaRerankConfig, JinaRerankResponseTransform } from './rerank';

const JinaConfig: ProviderConfigs = {
  embed: JinaEmbedConfig,
  rerank: JinaRerankConfig,
  api: JinaAPIConfig,
  responseTransforms: {
    embed: JinaEmbedResponseTransform,
    rerank: JinaRerankResponseTransform,
  },
};

export default JinaConfig;
