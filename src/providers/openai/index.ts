import { OPEN_AI } from '../../globals';
import {
  createModelResponseParams,
  OpenAICreateModelResponseTransformer,
  OpenAIGetModelResponseTransformer,
  OpenAIDeleteModelResponseTransformer,
  OpenAIListInputItemsResponseTransformer,
} from '../open-ai-base';
import { ProviderConfigs } from '../types';
import OpenAIAPIConfig from './api';
import { OpenAICancelBatchResponseTransform } from './cancelBatch';
import { OpenAIChatCompleteConfig } from './chatComplete';
import { OpenAICompleteConfig, OpenAICompleteResponseTransform } from './complete';
import { OpenAICreateBatchConfig, OpenAICreateBatchResponseTransform } from './createBatch';
import { OpenAICreateFinetuneConfig, OpenAIFinetuneResponseTransform } from './createFinetune';
import { OpenAICreateSpeechConfig, OpenAICreateSpeechResponseTransform } from './createSpeech';
import { OpenAICreateTranscriptionResponseTransform } from './createTranscription';
import { OpenAICreateTranslationResponseTransform } from './createTranslation';
import { OpenAIDeleteFileResponseTransform } from './deleteFile';
import { OpenAIEmbedConfig } from './embed';
import { OpenAIGetBatchOutputRequestHandler } from './getBatchOutput';
import { OpenAIImageGenerateConfig, OpenAIImageGenerateResponseTransform } from './imageGenerate';
import { OpenAIListBatchesResponseTransform } from './listBatches';
import { OpenAIGetFilesResponseTransform } from './listFiles';
import { OpenAIRetrieveBatchResponseTransform } from './retrieveBatch';
import { OpenAIGetFileContentResponseTransform } from './retrieveFileContent';
import { OpenAIUploadFileResponseTransform, OpenAIFileUploadRequestTransform } from './uploadFile';

const OpenAIConfig: ProviderConfigs = {
  complete: OpenAICompleteConfig,
  embed: OpenAIEmbedConfig,
  api: OpenAIAPIConfig,
  chatComplete: OpenAIChatCompleteConfig,
  imageGenerate: OpenAIImageGenerateConfig,
  imageEdit: {},
  createSpeech: OpenAICreateSpeechConfig,
  createTranscription: {},
  createTranslation: {},
  realtime: {},
  createBatch: OpenAICreateBatchConfig,
  createFinetune: OpenAICreateFinetuneConfig,
  cancelBatch: {},
  cancelFinetune: {},
  createModelResponse: createModelResponseParams([]),
  getModelResponse: {},
  deleteModelResponse: {},
  listModelsResponse: {},
  requestHandlers: {
    getBatchOutput: OpenAIGetBatchOutputRequestHandler,
  },
  requestTransforms: {
    uploadFile: OpenAIFileUploadRequestTransform,
  },
  responseTransforms: {
    complete: OpenAICompleteResponseTransform,
    // 'stream-complete': OpenAICompleteResponseTransform,
    // 'stream-chatComplete': OpenAIChatCompleteResponseTransform,
    imageGenerate: OpenAIImageGenerateResponseTransform,
    createSpeech: OpenAICreateSpeechResponseTransform,
    createTranscription: OpenAICreateTranscriptionResponseTransform,
    createTranslation: OpenAICreateTranslationResponseTransform,
    realtime: {},
    uploadFile: OpenAIUploadFileResponseTransform,
    listFiles: OpenAIGetFilesResponseTransform,
    retrieveFile: OpenAIGetFilesResponseTransform,
    deleteFile: OpenAIDeleteFileResponseTransform,
    retrieveFileContent: OpenAIGetFileContentResponseTransform,
    createBatch: OpenAICreateBatchResponseTransform,
    retrieveBatch: OpenAIRetrieveBatchResponseTransform,
    cancelBatch: OpenAICancelBatchResponseTransform,
    listBatches: OpenAIListBatchesResponseTransform,
    createFinetune: OpenAIFinetuneResponseTransform,
    retrieveFinetune: OpenAIFinetuneResponseTransform,
    createModelResponse: OpenAICreateModelResponseTransformer(OPEN_AI),
    getModelResponse: OpenAIGetModelResponseTransformer(OPEN_AI),
    deleteModelResponse: OpenAIDeleteModelResponseTransformer(OPEN_AI),
    listModelsResponse: OpenAIListInputItemsResponseTransformer(OPEN_AI),
  },
};

export default OpenAIConfig;
