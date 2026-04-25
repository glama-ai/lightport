import { BatchEndpoints, GOOGLE_VERTEX_AI } from '../../globals';
import { nodeLineReader } from '../../handlers/streamHandlerUtils';
import { logger } from '../../logger';
import { Params } from '../../types/requestBody';
import { externalServiceFetch } from '../../utils/fetch';
import { parseJson } from '../../utils/parseJson';
import { getAnthropicChatCompleteResponseTransform } from '../anthropic/chatComplete';
import { responseTransformers } from '../open-ai-base';
import { RequestHandler } from '../types';
import { generateErrorResponse } from '../utils';
import GoogleApiConfig from './api';
import {
  GoogleChatCompleteResponseTransform,
  VertexLlamaChatCompleteResponseTransform,
} from './chatComplete';
import { GoogleEmbedResponseTransform } from './embed';
import { GoogleBatchRecord } from './types';
import { getModelAndProvider, isEmbeddingModel } from './utils';
import { Readable, Transform } from 'stream';

const responseTransforms = {
  google: {
    [BatchEndpoints.CHAT_COMPLETIONS]: GoogleChatCompleteResponseTransform,
    [BatchEndpoints.EMBEDDINGS]: GoogleEmbedResponseTransform,
  },
  anthropic: {
    [BatchEndpoints.CHAT_COMPLETIONS]: getAnthropicChatCompleteResponseTransform(GOOGLE_VERTEX_AI),
    [BatchEndpoints.EMBEDDINGS]: null,
  },
  meta: {
    [BatchEndpoints.CHAT_COMPLETIONS]: VertexLlamaChatCompleteResponseTransform,
    [BatchEndpoints.EMBEDDINGS]: null,
  },
  endpoints: {
    [BatchEndpoints.CHAT_COMPLETIONS]: responseTransformers(GOOGLE_VERTEX_AI, {
      chatComplete: true,
    }).chatComplete,
    [BatchEndpoints.EMBEDDINGS]: responseTransformers(GOOGLE_VERTEX_AI, {
      embed: true,
    }).embed,
  },
};

type TransformFunction = (
  response: unknown,
  responseStatus: number,
  headers: Record<string, string>,
  strictOpenAiCompliance: boolean,
  gatewayRequestUrl: string,
  gatewayRequest: Params,
) => Record<string, unknown>;

const getOpenAIBatchRow = ({
  row,
  batchId,
  transform,
  endpoint,
  modelName,
}: {
  row: Record<string, unknown>;
  transform: TransformFunction;
  batchId: string;
  endpoint: BatchEndpoints;
  modelName: string;
}) => {
  const response =
    endpoint === BatchEndpoints.EMBEDDINGS
      ? (row ?? {})
      : ((row['response'] ?? {}) as Record<string, unknown>);
  const id = `batch-${batchId}${response.responseId ? `-${response.responseId}` : ''}`;

  let error = null;
  try {
    error = parseJson(row.status as string);
  } catch {
    error = row.status;
  }

  return {
    id,
    custom_id: row.requestId || (row?.instance as any)?.requestId || response.responseId,
    response: {
      ...(!error && { status_code: 200 }),
      request_id: id,
      body: !error && transform(response, 200, {}, false, '', { model: modelName }),
    },
    error: error,
  };
};

const headObject = async (url: string, headers: Record<string, string>) => {
  try {
    const response = await externalServiceFetch(url, {
      method: 'HEAD',
      headers,
    });
    return response.status === 200;
  } catch {
    return false;
  }
};

/**
 * @param chunk The chunk to transform in string format.
 * @returns Return the stringified transformed chunk.
 */
const transformLine = (
  chunk: string,
  batchId: string,
  providerConfig: TransformFunction,
  endpoint: BatchEndpoints,
  modelName: string,
) => {
  let transformedChunk;
  try {
    const json = parseJson(chunk);
    if (Array.isArray(json)) {
      const arrayBuffer = [];
      for (const row of json) {
        try {
          const transformedRow = getOpenAIBatchRow({
            row: parseJson(row),
            batchId: batchId ?? '',
            transform: providerConfig,
            endpoint,
            modelName,
          });
          arrayBuffer.push(JSON.stringify(transformedRow));
        } catch {
          continue;
        }
      }
      transformedChunk = arrayBuffer.join('\n');
    } else {
      const transformedRow = getOpenAIBatchRow({
        row: parseJson(chunk),
        batchId: batchId ?? '',
        transform: providerConfig,
        endpoint,
        modelName,
      });
      transformedChunk = JSON.stringify(transformedRow);
    }
  } catch (error) {
    logger.error({ err: error }, 'failed to transform vertex batch output line');
    transformedChunk = null;
  }
  return transformedChunk;
};

export const BatchOutputRequestHandler: RequestHandler = async ({
  requestURL,
  providerOptions,
  c,
  requestBody,
}) => {
  const { vertexProjectId, vertexRegion, vertexServiceAccountJson } = providerOptions;
  let projectId = vertexProjectId;

  if (vertexServiceAccountJson) {
    projectId = vertexServiceAccountJson.project_id;
  }

  const headers = await GoogleApiConfig.headers({
    c,
    fn: 'getBatchOutput',
    providerOptions,
    transformedRequestBody: requestBody,
    transformedRequestUrl: requestURL,
  });

  const options = {
    method: 'GET',
    headers,
  };

  // URL: <gateway>/v1/batches/<batchId>/output
  const batchId = requestURL.split('/').at(-2);

  const baseURL = GoogleApiConfig.getBaseURL({
    providerOptions,
    fn: 'retrieveBatch',
    c,
    gatewayRequestURL: requestURL,
  });
  const batchDetailsURL = `${baseURL}/v1/projects/${projectId}/locations/${vertexRegion}/batchPredictionJobs/${batchId}`;
  let modelName;
  let outputURL;
  try {
    const response = await externalServiceFetch(batchDetailsURL, options);
    if (!response.ok) {
      const error = await response.text();
      const errorResponse = generateErrorResponse(
        {
          message: error,
          type: null,
          param: null,
          code: null,
        },
        GOOGLE_VERTEX_AI,
      );
      return new Response(JSON.stringify(errorResponse), {
        status: response.status,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    }
    const data = (await response.json()) as GoogleBatchRecord;
    outputURL = data.outputInfo?.gcsOutputDirectory ?? '';
    modelName = data.model;
  } catch (error) {
    const errorMessage = (error as Error).message || 'Failed to retrieve batch output';
    const errorResponse = generateErrorResponse(
      {
        message: errorMessage,
        type: null,
        param: null,
        code: null,
      },
      GOOGLE_VERTEX_AI,
    );
    return new Response(JSON.stringify(errorResponse), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  if (!outputURL) {
    throw new Error('Failed to retrieve batch details');
  }

  const { provider } = getModelAndProvider(modelName ?? '');
  const endpoint = isEmbeddingModel(modelName)
    ? BatchEndpoints.EMBEDDINGS
    : BatchEndpoints.CHAT_COMPLETIONS;

  const providerConfigMap = responseTransforms[provider as keyof typeof responseTransforms];
  const providerConfig = providerConfigMap?.[endpoint] ?? responseTransforms['endpoints'][endpoint];

  if (!providerConfig) {
    throw new Error(`Endpoint ${endpoint} not supported for provider ${provider}`);
  }

  let predictionFileId = 'predictions.jsonl';

  outputURL = outputURL.replace('gs://', 'https://storage.googleapis.com/');

  if (await headObject(`${outputURL}/predictions.jsonl`, headers)) {
    predictionFileId = 'predictions.jsonl';
  } else if (await headObject(`${outputURL}/000000000000.jsonl`, headers)) {
    predictionFileId = '000000000000.jsonl';
  }

  const outputResponse = await externalServiceFetch(`${outputURL}/${predictionFileId}`, options);

  if (!outputResponse.body) {
    throw new Error('Failed to retrieve batch output');
  }

  const reader = Readable.fromWeb(outputResponse.body as import('stream/web').ReadableStream);

  const responseStream = new Transform({
    transform: function (chunk, _, callback) {
      const transformed = transformLine(
        chunk.toString(),
        batchId || '',
        providerConfig as TransformFunction,
        endpoint,
        modelName,
      );
      if (transformed) {
        this.push(transformed + '\n');
      }
      callback();
    },
  });

  const lineSplitter = nodeLineReader(true);
  reader.pipe(lineSplitter).pipe(responseStream);
  const responseBody = Readable.toWeb(responseStream);

  return new Response(responseBody as ReadableStream, {
    headers: { 'Content-Type': 'application/octet-stream' },
  });
};

export const BatchOutputResponseTransform: (response: Response) => Response = (response) => {
  return response;
};
