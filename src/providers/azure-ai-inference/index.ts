import { AZURE_AI_INFERENCE, GITHUB } from '../../globals';
import {
  AnthropicChatCompleteConfig,
  getAnthropicChatCompleteResponseTransform,
  getAnthropicStreamChunkTransform,
} from '../anthropic/chatComplete';
import { AzureOpenAICreateBatchConfig } from '../azure-openai/createBatch';
import { AzureOpenAICreateSpeechConfig } from '../azure-openai/createSpeech';
import { AzureOpenAIImageGenerateConfig } from '../azure-openai/imageGenerate';
import { OpenAICreateFinetuneConfig } from '../openai/createFinetune';
import { OpenAIFileUploadRequestTransform } from '../openai/uploadFile';
import { ProviderConfigs } from '../types';
import AzureAIInferenceAPI from './api';
import {
  AzureAIInferenceChatCompleteConfig,
  AzureAIInferenceChatCompleteResponseTransform,
} from './chatComplete';
import {
  AzureAIInferenceCompleteConfig,
  AzureAIInferenceCompleteResponseTransform,
} from './complete';
import { AzureAIInferenceEmbedConfig, AzureAIInferenceEmbedResponseTransform } from './embed';
import { AzureAIInferenceGetBatchOutputRequestHandler } from './getBatchOutput';
import {
  AzureAIInferenceMessagesConfig,
  AzureAIInferenceMessagesResponseTransform,
} from './messages';
import {
  AzureAIInferenceCreateSpeechResponseTransform,
  AzureAIInferenceCreateTranscriptionResponseTransform,
  AzureAIInferenceCreateTranslationResponseTransform,
  AzureAIInferenceResponseTransform,
} from './utils';

const AzureAIInferenceAPIConfig: ProviderConfigs = {
  api: AzureAIInferenceAPI,
  getConfig: ({ providerOptions }) => {
    const { azureFoundryUrl } = providerOptions || {};
    const isAnthropicModel = azureFoundryUrl?.includes('anthropic');
    const chatCompleteConfig = isAnthropicModel
      ? AnthropicChatCompleteConfig
      : AzureAIInferenceChatCompleteConfig;
    const chatCompleteResponseTransform = isAnthropicModel
      ? getAnthropicChatCompleteResponseTransform(AZURE_AI_INFERENCE)
      : AzureAIInferenceChatCompleteResponseTransform(AZURE_AI_INFERENCE);
    return {
      complete: AzureAIInferenceCompleteConfig,
      embed: AzureAIInferenceEmbedConfig,
      chatComplete: chatCompleteConfig,
      messages: AzureAIInferenceMessagesConfig,
      imageGenerate: AzureOpenAIImageGenerateConfig,
      imageEdit: {},
      createSpeech: AzureOpenAICreateSpeechConfig,
      createFinetune: OpenAICreateFinetuneConfig,
      createTranscription: {},
      createTranslation: {},
      realtime: {},
      cancelBatch: {},
      createBatch: AzureOpenAICreateBatchConfig,
      cancelFinetune: {},
      requestHandlers: {
        getBatchOutput: AzureAIInferenceGetBatchOutputRequestHandler,
      },
      requestTransforms: {
        uploadFile: OpenAIFileUploadRequestTransform,
      },
      responseTransforms: {
        complete: AzureAIInferenceCompleteResponseTransform(AZURE_AI_INFERENCE),
        ...(isAnthropicModel && {
          'stream-chatComplete': getAnthropicStreamChunkTransform(AZURE_AI_INFERENCE),
        }),
        chatComplete: chatCompleteResponseTransform,
        messages: AzureAIInferenceMessagesResponseTransform,
        embed: AzureAIInferenceEmbedResponseTransform(AZURE_AI_INFERENCE),
        imageGenerate: AzureAIInferenceResponseTransform,
        createSpeech: AzureAIInferenceCreateSpeechResponseTransform,
        createTranscription: AzureAIInferenceCreateTranscriptionResponseTransform,
        createTranslation: AzureAIInferenceCreateTranslationResponseTransform,
        realtime: {},
        createBatch: AzureAIInferenceResponseTransform,
        retrieveBatch: AzureAIInferenceResponseTransform,
        cancelBatch: AzureAIInferenceResponseTransform,
        listBatches: AzureAIInferenceResponseTransform,
        uploadFile: AzureAIInferenceResponseTransform,
        listFiles: AzureAIInferenceResponseTransform,
        retrieveFile: AzureAIInferenceResponseTransform,
        deleteFile: AzureAIInferenceResponseTransform,
        retrieveFileContent: AzureAIInferenceResponseTransform,
      },
    };
  },
};

const GithubModelAPiConfig: ProviderConfigs = {
  complete: AzureAIInferenceCompleteConfig,
  embed: AzureAIInferenceEmbedConfig,
  api: AzureAIInferenceAPI,
  chatComplete: AzureAIInferenceChatCompleteConfig,
  responseTransforms: {
    complete: AzureAIInferenceCompleteResponseTransform(GITHUB),
    chatComplete: AzureAIInferenceChatCompleteResponseTransform(GITHUB),
    embed: AzureAIInferenceEmbedResponseTransform(GITHUB),
  },
};

export { AzureAIInferenceAPIConfig, GithubModelAPiConfig };
