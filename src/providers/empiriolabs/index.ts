import { EMPIRIOLABS } from '../../globals';
import { chatCompleteParams, responseTransformers } from '../open-ai-base';
import { OpenAIEmbedConfig } from '../openai/embed';
import { ProviderConfigs } from '../types';
import EmpirioLabsAPIConfig from './api';

const EmpirioLabsConfig: ProviderConfigs = {
  api: EmpirioLabsAPIConfig,
  chatComplete: chatCompleteParams([]),
  embed: OpenAIEmbedConfig,
  responseTransforms: responseTransformers(EMPIRIOLABS, {
    chatComplete: true,
    embed: true,
  }),
};

export default EmpirioLabsConfig;
