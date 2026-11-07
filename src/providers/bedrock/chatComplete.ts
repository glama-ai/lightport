import { BEDROCK, imagesMimeTypes, fileExtensionMimeTypeMap, videoMimeTypes } from '../../globals';
import {
  Message,
  Params,
  PromptCache,
  ToolCall,
  SYSTEM_MESSAGE_ROLES,
  ContentType,
  Options,
  ToolChoiceObject,
} from '../../types/requestBody';
import { GatewayError } from '../../errors/GatewayError';
import { openAiErrorEvent } from '../../errors/openAiError';
import { parseJson } from '../../utils/parseJson';
import {
  ChatCompletionResponse,
  ErrorResponse,
  ProviderConfig,
  StreamContentBlock,
} from '../types';
import {
  generateErrorResponse,
  generateInvalidProviderResponseError,
  transformFinishReason,
} from '../utils';
import {
  BedrockAI21CompleteResponse,
  BedrockCohereCompleteResponse,
  BedrockCohereStreamChunk,
} from './complete';
import { BedrockErrorResponse } from './embed';
import {
  BedrockCachePoint,
  BedrockChatCompleteStreamChunk,
  BedrockChatCompletionResponse,
  BedrockContentItem,
  BedrockStreamState,
} from './types';
import {
  mimeTypeOfName,
  parseDataUrl,
  readFilePart,
  unreadableFileMessage,
} from '../utils/filePart';
import { getCachePoint } from './utils/cachePoint';
import {
  transformAdditionalModelRequestFields,
  transformAI21AdditionalModelRequestFields,
  transformAnthropicAdditionalModelRequestFields,
  transformCohereAdditionalModelRequestFields,
  transformInferenceConfig,
} from './utils';

export interface BedrockChatCompletionsParams extends Params {
  additionalModelRequestFields?: Record<string, any>;
  additional_model_request_fields?: Record<string, any>;
  additionalModelResponseFieldPaths?: string[];
  guardrailConfig?: {
    guardrailIdentifier: string;
    guardrailVersion: string;
    trace?: string;
  };
  guardrail_config?: {
    guardrailIdentifier: string;
    guardrailVersion: string;
    trace?: string;
  };
  anthropic_version?: string;
  countPenalty?: number;
}

export interface BedrockConverseAnthropicChatCompletionsParams extends BedrockChatCompletionsParams {
  anthropic_version?: string;
  user?: string;
  thinking?: {
    type: string;
    budget_tokens: number;
  };
  anthropic_beta?: string[];
}

export interface BedrockConverseCohereChatCompletionsParams extends BedrockChatCompletionsParams {
  frequency_penalty?: number;
  presence_penalty?: number;
  logit_bias?: Record<string, number>;
  n?: number;
}

export interface BedrockConverseAI21ChatCompletionsParams extends BedrockChatCompletionsParams {
  frequency_penalty?: number;
  presence_penalty?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  countPenalty?: number;
}

// const CACHE_SUPPORTED_ROLES = ['user', 'assistant', 'system'];

const getMessageTextContentArray = (
  message: Message,
): Array<{ text: string } | BedrockCachePoint> => {
  if (message.content && typeof message.content === 'object') {
    const filteredContentMessages = message.content.filter((item) => item.type === 'text');
    const finalContent: Array<{ text: string } | BedrockCachePoint> = [];
    filteredContentMessages.forEach((item) => {
      finalContent.push({
        text: item.text || '',
      });
      // push a cache point.
      if (item.cache_control) {
        finalContent.push(getCachePoint(item.cache_control));
      }
    });
    return finalContent;
  }
  // Content written as a plain string has no part to carry `cache_control`, so
  // the caller puts it on the message — the same place the Anthropic provider
  // reads it from. Ignoring it here dropped the checkpoint without a word.
  const messageCacheControl = (message as Message & PromptCache).cache_control;
  return [
    {
      text: message.content || '',
    },
    ...(messageCacheControl ? [getCachePoint(messageCacheControl)] : []),
  ];
};

const transformAndAppendThinkingMessageItem = (item: ContentType, out: any[]) => {
  if (item.type === 'thinking') {
    out.push({
      reasoningContent: {
        reasoningText: {
          signature: item.signature,
          text: item.thinking,
        },
      },
    });
  } else if (item.type === 'redacted_thinking') {
    out.push({
      reasoningContent: {
        redactedContent: item.data,
      },
    });
  }
};

// What Converse calls each document type, where it is not the MIME subtype.
const BEDROCK_DOCUMENT_FORMATS: Record<string, string> = {
  [fileExtensionMimeTypeMap.pdf]: 'pdf',
  [fileExtensionMimeTypeMap.csv]: 'csv',
  [fileExtensionMimeTypeMap.doc]: 'doc',
  [fileExtensionMimeTypeMap.docx]: 'docx',
  [fileExtensionMimeTypeMap.xls]: 'xls',
  [fileExtensionMimeTypeMap.xlsx]: 'xlsx',
  [fileExtensionMimeTypeMap.html]: 'html',
  [fileExtensionMimeTypeMap.txt]: 'txt',
  [fileExtensionMimeTypeMap.md]: 'md',
};

/**
 * A document's name as Converse will take it: letters and digits, single
 * spaces, hyphens, parentheses and square brackets, at most 200 of them. A file
 * name has an extension at the least, and its dot alone was enough for the
 * request to be refused.
 */
const bedrockDocumentName = (name?: string) =>
  (name ?? '')
    .replace(/\.[^.]*$/, '')
    .replace(/[^a-zA-Z0-9\s\-()[\]]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200) || crypto.randomUUID();

const bedrockMediaBlock = (
  mimeType: string,
  source: Record<string, unknown>,
  name?: string,
): BedrockContentItem => {
  const subtype = mimeType.split('/')[1];

  if (imagesMimeTypes.includes(mimeType)) {
    return { image: { format: subtype, source } } as BedrockContentItem;
  }

  if (videoMimeTypes.includes(mimeType)) {
    return { video: { format: subtype, source } } as BedrockContentItem;
  }

  return {
    document: {
      format: BEDROCK_DOCUMENT_FORMATS[mimeType] ?? subtype,
      name: bedrockDocumentName(name),
      source,
    },
  } as BedrockContentItem;
};

const getMessageContent = (message: Message) => {
  if (!message.content && !message.tool_calls && !message.tool_call_id) return [];
  if (message.role === 'tool') {
    const parts = getMessageTextContentArray(message);
    // A `toolResult` holds document | image | json | searchResult | text | video
    // and nothing else, so a cache point nested among them is not a checkpoint
    // Bedrock will honour. It belongs beside the tool result, as a sibling.
    const toolResultContent = parts.filter((part) => !('cachePoint' in part));
    const cachePoints = parts.filter((part) => 'cachePoint' in part);
    return [
      {
        toolResult: {
          // Bedrock allows empty array but does not allow empty string in content.
          content: (toolResultContent[0] as { text: string })?.text ? toolResultContent : [],
          toolUseId: message.tool_call_id,
        },
      },
      ...cachePoints,
    ];
  }
  const out: BedrockContentItem[] = [];
  const inputContent: ContentType[] | string | undefined =
    message.content_blocks ?? message.content;
  // if message is a string, return a single element array with the text
  if (typeof inputContent === 'string' && inputContent.trim()) {
    out.push({
      text: inputContent,
    });
  } else if (inputContent && Array.isArray(inputContent)) {
    inputContent.forEach((item) => {
      if (item.type === 'text') {
        out.push({
          text: item.text || '',
        });
      } else if (item.type === 'thinking') {
        transformAndAppendThinkingMessageItem(item, out);
      } else if (item.type === 'image_url' && item.image_url) {
        const { url } = item.image_url;
        const dataUrl = parseDataUrl(url);
        if (dataUrl) {
          out.push(bedrockMediaBlock(dataUrl.mimeType, { bytes: dataUrl.base64 }));
        } else if (url.startsWith('s3://')) {
          const mimeType =
            item.image_url.mime_type || mimeTypeOfName(url) || fileExtensionMimeTypeMap.jpeg;
          out.push(bedrockMediaBlock(mimeType, { s3Location: { uri: url } }));
        } else {
          // Read as a data URL regardless, a web address split into nothing and
          // threw — a 500 for a request whose only fault was where its image was.
          throw new GatewayError(
            'Bedrock takes an image as a data URL or an s3:// address, not a web address',
            400,
          );
        }
      } else if (item.type === 'file') {
        const file = readFilePart(item.file);
        if (!file) {
          throw new GatewayError(unreadableFileMessage('bedrock', item.file), 400);
        }

        if (file.url === undefined) {
          out.push(bedrockMediaBlock(file.mimeType, { bytes: file.data }, file.name));
        } else if (file.url.startsWith('s3://')) {
          out.push(bedrockMediaBlock(file.mimeType, { s3Location: { uri: file.url } }, file.name));
        } else {
          throw new GatewayError(
            'Bedrock reads a file from its content or an s3:// address, not a web address',
            400,
          );
        }
      }

      if (item.cache_control) {
        // if content item has `cache_control`, push the cache point to the out array
        out.push(getCachePoint(item.cache_control));
      }
    });
  }

  // If message is an array of objects, handle text content, tool calls, tool results, this would be much cleaner if lightports chat create object were a union type
  message.tool_calls?.forEach((toolCall: ToolCall) => {
    out.push({
      toolUse: {
        name: toolCall.function.name,
        input:
          toolCall.function.arguments?.length > 0 ? parseJson(toolCall.function.arguments) : {},
        toolUseId: toolCall.id,
      },
    });
  });

  // Bedrock requires a text block when documents are present
  const hasDocument = out.some((item) => 'document' in item);
  const hasText = out.some((item) => 'text' in item);
  if (hasDocument && !hasText) {
    out.unshift({ text: ' ' });
  }

  return out;
};

// refer: https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html
export const BedrockConverseChatCompleteConfig: ProviderConfig = {
  messages: [
    {
      param: 'messages',
      required: true,
      transform: (params: BedrockChatCompletionsParams) => {
        if (!params.messages) return [];
        const transformedMessages = params.messages
          .filter((msg) => !SYSTEM_MESSAGE_ROLES.includes(msg.role))
          .map((msg) => {
            const content = getMessageContent(msg);
            return {
              role: msg.role === 'assistant' ? 'assistant' : 'user',
              content: content,
            };
          });
        let prevRole = '';
        // combine user messages in succession
        const combinedMessages = transformedMessages.reduce(
          (acc: typeof transformedMessages, msg) => {
            if (msg.role === 'user' && prevRole === 'user') {
              const lastMessage = acc[acc.length - 1];
              const newContent = [...lastMessage.content, ...msg.content];
              lastMessage.content = newContent as typeof lastMessage.content;
            } else {
              acc.push(msg);
            }
            prevRole = msg.role;
            return acc;
          },
          [],
        );
        return combinedMessages;
      },
    },
    {
      param: 'system',
      required: false,
      transform: (params: BedrockChatCompletionsParams) => {
        if (!params.messages) return;
        const systemMessages: Array<{ text: string } | BedrockCachePoint> = params.messages.reduce(
          (acc: Array<{ text: string } | BedrockCachePoint>, msg) => {
            if (SYSTEM_MESSAGE_ROLES.includes(msg.role)) {
              const content = getMessageTextContentArray(msg);
              return acc.concat(...content);
            }
            return acc;
          },
          [],
        );
        if (!systemMessages.length) return;
        return systemMessages;
      },
    },
  ],
  tools: {
    param: 'toolConfig',
    transform: (params: BedrockChatCompletionsParams) => {
      const canBeAmazonModel = params.model?.includes('amazon');
      const tools: Array<
        { toolSpec: { name: string; description?: string; inputSchema: any } } | BedrockCachePoint
      > = [];
      params.tools?.forEach((tool) => {
        if (tool.function) {
          tools.push({
            toolSpec: {
              name: tool.function.name,
              description: tool.function.description,
              inputSchema: { json: tool.function.parameters },
            },
          });
        }
        if (tool.cache_control && !canBeAmazonModel) {
          tools.push(getCachePoint(tool.cache_control));
        }
      });
      const toolConfig = {
        tools,
      };
      let toolChoice = undefined;
      if (params.tool_choice) {
        if (typeof params.tool_choice === 'object') {
          toolChoice = {
            tool: {
              name: (params.tool_choice as ToolChoiceObject).function.name,
            },
          };
        } else if (typeof params.tool_choice === 'string') {
          if (params.tool_choice === 'required') {
            toolChoice = {
              any: {},
            };
          } else if (params.tool_choice === 'auto') {
            toolChoice = {
              auto: {},
            };
          }
        }
      }
      // TODO: split this into two provider options, one for tools and one for toolChoice
      return tools.length ? { ...toolConfig, toolChoice } : null;
    },
  },
  guardrailConfig: {
    param: 'guardrailConfig',
    required: false,
  },
  guardrail_config: {
    param: 'guardrailConfig',
    required: false,
  },
  additionalModelResponseFieldPaths: {
    param: 'additionalModelResponseFieldPaths',
    required: false,
  },
  additional_model_response_field_paths: {
    param: 'additionalModelResponseFieldPaths',
    required: false,
  },
  max_tokens: {
    param: 'inferenceConfig',
    transform: (params: BedrockChatCompletionsParams) => transformInferenceConfig(params),
  },
  max_completion_tokens: {
    param: 'inferenceConfig',
    transform: (params: BedrockChatCompletionsParams) => transformInferenceConfig(params),
  },
  stop: {
    param: 'inferenceConfig',
    transform: (params: BedrockChatCompletionsParams) => transformInferenceConfig(params),
  },
  temperature: {
    param: 'inferenceConfig',
    transform: (params: BedrockChatCompletionsParams) => transformInferenceConfig(params),
  },
  top_p: {
    param: 'inferenceConfig',
    transform: (params: BedrockChatCompletionsParams) => transformInferenceConfig(params),
  },
  additionalModelRequestFields: {
    param: 'additionalModelRequestFields',
    transform: (params: BedrockChatCompletionsParams) =>
      transformAdditionalModelRequestFields(params),
  },
  additional_model_request_fields: {
    param: 'additionalModelRequestFields',
    transform: (params: BedrockChatCompletionsParams) =>
      transformAdditionalModelRequestFields(params),
  },
  performance_config: {
    param: 'performanceConfig',
    required: false,
  },
};

export const BedrockErrorResponseTransform: (
  response: BedrockErrorResponse,
) => ErrorResponse | undefined = (response) => {
  if ('message' in response) {
    return generateErrorResponse(
      { message: response.message, type: null, param: null, code: null },
      BEDROCK,
    );
  }

  return undefined;
};

const transformContentBlocks = (contentBlocks: BedrockContentItem[]) => {
  const output: ContentType[] = [];
  contentBlocks.forEach((contentBlock) => {
    if (contentBlock.text) {
      output.push({
        type: 'text',
        text: contentBlock.text,
      });
    } else if (contentBlock.reasoningContent?.reasoningText) {
      output.push({
        type: 'thinking',
        thinking: contentBlock.reasoningContent.reasoningText.text,
        signature: contentBlock.reasoningContent.reasoningText.signature,
      });
    } else if (contentBlock.reasoningContent?.redactedContent) {
      output.push({
        type: 'redacted_thinking',
        data: contentBlock.reasoningContent.redactedContent,
      });
    }
  });
  return output;
};

export const BedrockChatCompleteResponseTransform: (
  response: BedrockChatCompletionResponse | BedrockErrorResponse,
  responseStatus: number,
  responseHeaders: Headers,
  strictOpenAiCompliance: boolean,
  _gatewayRequestUrl: string,
  gatewayRequest: Params,
) => ChatCompletionResponse | ErrorResponse = (
  response,
  responseStatus,
  responseHeaders,
  strictOpenAiCompliance,
  _gatewayRequestUrl,
  gatewayRequest,
) => {
  if (responseStatus !== 200) {
    const errorResponse = BedrockErrorResponseTransform(response as BedrockErrorResponse);
    if (errorResponse) return errorResponse;
  }

  if ('output' in response) {
    let content: string = '';
    content = response.output.message.content
      .filter((item) => item.text)
      .map((item) => item.text)
      .join('\n');
    const contentBlocks = !strictOpenAiCompliance
      ? transformContentBlocks(response.output.message.content)
      : undefined;
    // Reported in `reasoning_content` as every other provider here reports it.
    // It was only in `content_blocks`, which a strict caller — the default — is
    // not sent, so the thinking of every reasoner on Converse was dropped.
    const reasoning = response.output.message.content
      .map((item) => item.reasoningContent?.reasoningText?.text ?? '')
      .join('');

    const cacheReadInputTokens = response.usage?.cacheReadInputTokens || 0;
    const cacheWriteInputTokens = response.usage?.cacheWriteInputTokens || 0;
    // Bedrock documents `inputTokens` as the non-cached input alone, the whole
    // input being `inputTokens + cacheReadInputTokens + cacheWriteInputTokens`.
    // What it does not say is which of those two its own `totalTokens` sums, so
    // reporting the whole input as `prompt_tokens` while passing that total
    // through unchanged left the parts not summing to the total whenever the
    // cache was used. The total is derived from the two counts beside it, which
    // is the relationship every OpenAI-shaped consumer reads them by, and which
    // holds whichever of the two Bedrock meant.
    const promptTokens =
      (response.usage.inputTokens ?? 0) + cacheReadInputTokens + cacheWriteInputTokens;
    const completionTokens = response.usage.outputTokens ?? 0;

    const responseObj: ChatCompletionResponse = {
      id: Date.now().toString(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: gatewayRequest.model || '',
      provider: BEDROCK,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content,
            ...(reasoning && { reasoning_content: reasoning }),
            ...(!strictOpenAiCompliance && {
              content_blocks: contentBlocks,
            }),
          },
          finish_reason: transformFinishReason(response.stopReason, strictOpenAiCompliance),
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: {
          cached_tokens: cacheReadInputTokens,
        },
        // we only want to be sending this for anthropic models and this is not openai compliant
        ...((cacheReadInputTokens > 0 || cacheWriteInputTokens > 0) && {
          cache_read_input_tokens: cacheReadInputTokens,
          cache_creation_input_tokens: cacheWriteInputTokens,
        }),
      },
    };
    const toolCalls = response.output.message.content
      .filter((content) => content.toolUse)
      .map((content) => ({
        id: content?.toolUse?.toolUseId,
        type: 'function',
        function: {
          name: content?.toolUse?.name,
          arguments: JSON.stringify(content?.toolUse?.input),
        },
      }));
    if (toolCalls.length > 0) responseObj.choices[0].message.tool_calls = toolCalls;
    return responseObj;
  }

  return generateInvalidProviderResponseError(response, BEDROCK);
};

// refer: https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html
export const BedrockChatCompleteStreamChunkTransform: (
  response: string,
  fallbackId: string,
  streamState: BedrockStreamState,
  strictOpenAiCompliance: boolean,
  gatewayRequest: Params,
) => string | string[] = (
  responseChunk,
  fallbackId,
  streamState,
  strictOpenAiCompliance,
  gatewayRequest,
) => {
  const parsedChunk: BedrockChatCompleteStreamChunk = parseJson(responseChunk);
  // An exception Bedrock sends mid-stream — a throttle, a refused image, a model
  // that failed — was answered with a chunk finishing as `stop` and a `[DONE]`,
  // its message thrown away: to the caller, a reply that had simply ended there.
  // It is a failure, and leaves as one, named as Bedrock named it.
  if (parsedChunk.message) {
    return openAiErrorEvent({
      code: parsedChunk.__type ?? null,
      message: `${BEDROCK} error: ${parsedChunk.message}`,
      type: parsedChunk.__type ?? 'api_error',
    });
  }
  if (parsedChunk.stopReason) {
    streamState.stopReason = parsedChunk.stopReason;
  }
  if (streamState.currentToolCallIndex === undefined) {
    streamState.currentToolCallIndex = -1;
  }

  if (parsedChunk.usage) {
    const cacheReadInputTokens = parsedChunk.usage?.cacheReadInputTokens || 0;
    const cacheWriteInputTokens = parsedChunk.usage?.cacheWriteInputTokens || 0;
    // As above: the total is derived from the two counts beside it rather than
    // taken from Bedrock, which does not count the cache into `inputTokens`.
    const promptTokens =
      (parsedChunk.usage.inputTokens ?? 0) + cacheReadInputTokens + cacheWriteInputTokens;
    const completionTokens = parsedChunk.usage.outputTokens ?? 0;

    return [
      `data: ${JSON.stringify({
        id: fallbackId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: gatewayRequest.model || '',
        provider: BEDROCK,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: transformFinishReason(streamState.stopReason, strictOpenAiCompliance),
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
          prompt_tokens_details: {
            cached_tokens: cacheReadInputTokens,
          },
          // we only want to be sending this for anthropic models and this is not openai compliant
          ...((cacheReadInputTokens > 0 || cacheWriteInputTokens > 0) && {
            cache_read_input_tokens: cacheReadInputTokens,
            cache_creation_input_tokens: cacheWriteInputTokens,
          }),
        },
      })}\n\n`,
      `data: [DONE]\n\n`,
    ];
  }

  const toolCalls = [];
  if (parsedChunk.start?.toolUse) {
    streamState.currentToolCallIndex = streamState.currentToolCallIndex + 1;
    toolCalls.push({
      index: streamState.currentToolCallIndex,
      id: parsedChunk.start.toolUse.toolUseId,
      type: 'function',
      function: {
        name: parsedChunk.start.toolUse.name,
        arguments: parsedChunk.start.toolUse.input,
      },
    });
  } else if (parsedChunk.delta?.toolUse) {
    toolCalls.push({
      index: streamState.currentToolCallIndex,
      id: parsedChunk.delta.toolUse.toolUseId,
      type: 'function',
      function: {
        name: parsedChunk.delta.toolUse.name,
        arguments: parsedChunk.delta.toolUse.input,
      },
    });
  }

  const content = parsedChunk.delta?.text;

  const contentBlockObject: StreamContentBlock = {
    index: parsedChunk.contentBlockIndex ?? 0,
    delta: {},
  };
  if (parsedChunk.delta?.reasoningContent?.text)
    contentBlockObject.delta.thinking = parsedChunk.delta.reasoningContent.text;
  if (parsedChunk.delta?.reasoningContent?.signature)
    contentBlockObject.delta.signature = parsedChunk.delta.reasoningContent.signature;
  if (parsedChunk.delta?.text) contentBlockObject.delta.text = parsedChunk.delta.text;
  if (parsedChunk.delta?.reasoningContent?.redactedContent)
    contentBlockObject.delta.data = parsedChunk.delta.reasoningContent.redactedContent;

  return `data: ${JSON.stringify({
    id: fallbackId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: gatewayRequest.model || '',
    provider: BEDROCK,
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          content,
          ...(parsedChunk.delta?.reasoningContent?.text && {
            reasoning_content: parsedChunk.delta.reasoningContent.text,
          }),
          ...(!strictOpenAiCompliance &&
            !toolCalls.length &&
            Object.keys(contentBlockObject.delta).length > 0 && {
              content_blocks: [contentBlockObject],
            }),
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finish_reason: null,
      },
    ],
  })}\n\n`;
};

export const BedrockConverseAnthropicChatCompleteConfig: ProviderConfig = {
  ...BedrockConverseChatCompleteConfig,
  additionalModelRequestFields: {
    param: 'additionalModelRequestFields',
    transform: (params: BedrockConverseAnthropicChatCompletionsParams, providerOptions?: Options) =>
      transformAnthropicAdditionalModelRequestFields(params, providerOptions),
  },
  additional_model_request_fields: {
    param: 'additionalModelRequestFields',
    transform: (params: BedrockConverseAnthropicChatCompletionsParams, providerOptions?: Options) =>
      transformAnthropicAdditionalModelRequestFields(params, providerOptions),
  },
  top_k: {
    param: 'additionalModelRequestFields',
    transform: (params: BedrockConverseAnthropicChatCompletionsParams, providerOptions?: Options) =>
      transformAnthropicAdditionalModelRequestFields(params, providerOptions),
  },
  anthropic_version: {
    param: 'additionalModelRequestFields',
    transform: (params: BedrockConverseAnthropicChatCompletionsParams, providerOptions?: Options) =>
      transformAnthropicAdditionalModelRequestFields(params, providerOptions),
  },
  user: {
    param: 'additionalModelRequestFields',
    transform: (params: BedrockConverseAnthropicChatCompletionsParams, providerOptions?: Options) =>
      transformAnthropicAdditionalModelRequestFields(params, providerOptions),
  },
  thinking: {
    param: 'additionalModelRequestFields',
    transform: (params: BedrockConverseAnthropicChatCompletionsParams, providerOptions?: Options) =>
      transformAnthropicAdditionalModelRequestFields(params, providerOptions),
  },
  anthropic_beta: {
    param: 'additionalModelRequestFields',
    transform: (params: BedrockConverseAnthropicChatCompletionsParams, providerOptions?: Options) =>
      transformAnthropicAdditionalModelRequestFields(params, providerOptions),
  },
  reasoning_effort: {
    param: 'additionalModelRequestFields',
    transform: (params: BedrockConverseAnthropicChatCompletionsParams, providerOptions?: Options) =>
      transformAnthropicAdditionalModelRequestFields(params, providerOptions),
  },
  response_format: {
    param: 'additionalModelRequestFields',
    transform: (params: BedrockConverseAnthropicChatCompletionsParams, providerOptions?: Options) =>
      transformAnthropicAdditionalModelRequestFields(params, providerOptions),
  },
};

export const BedrockConverseCohereChatCompleteConfig: ProviderConfig = {
  ...BedrockConverseChatCompleteConfig,
  additionalModelRequestFields: {
    param: 'additionalModelRequestFields',
    transform: (params: BedrockConverseCohereChatCompletionsParams) =>
      transformCohereAdditionalModelRequestFields(params),
  },
  additional_model_request_fields: {
    param: 'additionalModelRequestFields',
    transform: (params: BedrockConverseCohereChatCompletionsParams) =>
      transformCohereAdditionalModelRequestFields(params),
  },
  top_k: {
    param: 'additionalModelRequestFields',
    transform: (params: BedrockConverseCohereChatCompletionsParams) =>
      transformCohereAdditionalModelRequestFields(params),
  },
  frequency_penalty: {
    param: 'additionalModelRequestFields',
    transform: (params: BedrockConverseCohereChatCompletionsParams) =>
      transformCohereAdditionalModelRequestFields(params),
  },
  presence_penalty: {
    param: 'additionalModelRequestFields',
    transform: (params: BedrockConverseCohereChatCompletionsParams) =>
      transformCohereAdditionalModelRequestFields(params),
  },
  logit_bias: {
    param: 'additionalModelRequestFields',
    transform: (params: BedrockConverseCohereChatCompletionsParams) =>
      transformCohereAdditionalModelRequestFields(params),
  },
  n: {
    param: 'additionalModelRequestFields',
    transform: (params: BedrockConverseCohereChatCompletionsParams) =>
      transformCohereAdditionalModelRequestFields(params),
  },
};

export const BedrockConverseAI21ChatCompleteConfig: ProviderConfig = {
  ...BedrockConverseChatCompleteConfig,
  additionalModelRequestFields: {
    param: 'additionalModelRequestFields',
    transform: (params: BedrockConverseAI21ChatCompletionsParams) =>
      transformAI21AdditionalModelRequestFields(params),
  },
  additional_model_request_fields: {
    param: 'additionalModelRequestFields',
    transform: (params: BedrockConverseAI21ChatCompletionsParams) =>
      transformAI21AdditionalModelRequestFields(params),
  },
  top_k: {
    param: 'additionalModelRequestFields',
    transform: (params: BedrockConverseAI21ChatCompletionsParams) =>
      transformAI21AdditionalModelRequestFields(params),
  },
  frequency_penalty: {
    param: 'additionalModelRequestFields',
    transform: (params: BedrockConverseAI21ChatCompletionsParams) =>
      transformAI21AdditionalModelRequestFields(params),
  },
  presence_penalty: {
    param: 'additionalModelRequestFields',
    transform: (params: BedrockConverseAI21ChatCompletionsParams) =>
      transformAI21AdditionalModelRequestFields(params),
  },
  frequencyPenalty: {
    param: 'additionalModelRequestFields',
    transform: (params: BedrockConverseAI21ChatCompletionsParams) =>
      transformAI21AdditionalModelRequestFields(params),
  },
  presencePenalty: {
    param: 'additionalModelRequestFields',
    transform: (params: BedrockConverseAI21ChatCompletionsParams) =>
      transformAI21AdditionalModelRequestFields(params),
  },
  countPenalty: {
    param: 'additionalModelRequestFields',
    transform: (params: BedrockConverseAI21ChatCompletionsParams) =>
      transformAI21AdditionalModelRequestFields(params),
  },
};

/**
 * A message's content as the text of a prompt, for the models that take one
 * string rather than messages. The system message was written as the whole
 * message list, `[object Object],[object Object]`, and content sent as parts
 * as `[object Object]` wherever it came.
 */
const promptText = (content: Message['content']): string =>
  Array.isArray(content)
    ? content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .filter(Boolean)
        .join('\n')
    : (content ?? '');

export const BedrockCohereChatCompleteConfig: ProviderConfig = {
  messages: {
    param: 'prompt',
    required: true,
    transform: (params: Params) => {
      let prompt: string = '';
      if (params.messages) {
        let messages: Message[] = params.messages;
        messages.forEach((msg, index) => {
          if (index === 0 && SYSTEM_MESSAGE_ROLES.includes(msg.role)) {
            prompt += `system: ${promptText(msg.content)}\n`;
          } else if (msg.role == 'user') {
            prompt += `user: ${promptText(msg.content)}\n`;
          } else if (msg.role == 'assistant') {
            prompt += `assistant: ${promptText(msg.content)}\n`;
          } else {
            prompt += `${msg.role}: ${promptText(msg.content)}\n`;
          }
        });
        prompt += 'Assistant:';
      }
      return prompt;
    },
  },
  max_tokens: {
    param: 'max_tokens',
    default: 20,
    min: 1,
  },
  max_completion_tokens: {
    param: 'max_tokens',
    default: 20,
    min: 1,
  },
  temperature: {
    param: 'temperature',
    default: 0.75,
    min: 0,
    max: 5,
  },
  top_p: {
    param: 'p',
    default: 0.75,
    min: 0,
    max: 1,
  },
  top_k: {
    param: 'k',
    default: 0,
    max: 500,
  },
  frequency_penalty: {
    param: 'frequency_penalty',
    default: 0,
    min: 0,
    max: 1,
  },
  presence_penalty: {
    param: 'presence_penalty',
    default: 0,
    min: 0,
    max: 1,
  },
  logit_bias: {
    param: 'logit_bias',
  },
  n: {
    param: 'num_generations',
    default: 1,
    min: 1,
    max: 5,
  },
  stop: {
    param: 'end_sequences',
  },
  stream: {
    param: 'stream',
  },
};

export const BedrockCohereChatCompleteResponseTransform: (
  response: BedrockCohereCompleteResponse | BedrockErrorResponse,
  responseStatus: number,
  responseHeaders: Headers,
  strictOpenAiCompliance: boolean,
  gatewayRequestUrl: string,
  gatewayRequest: Params,
) => ChatCompletionResponse | ErrorResponse = (
  response,
  responseStatus,
  responseHeaders,
  _strictOpenAiCompliance,
  _gatewayRequestUrl,
  gatewayRequest,
) => {
  if (responseStatus !== 200) {
    const errorResponse = BedrockErrorResponseTransform(response as BedrockErrorResponse);
    if (errorResponse) return errorResponse;
  }

  const model = gatewayRequest.model || '';

  if ('generations' in response) {
    const prompt_tokens = Number(responseHeaders.get('X-Amzn-Bedrock-Input-Token-Count')) || 0;
    const completion_tokens = Number(responseHeaders.get('X-Amzn-Bedrock-Output-Token-Count')) || 0;
    return {
      id: Date.now().toString(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      provider: BEDROCK,
      choices: response.generations.map((generation, index) => ({
        index: index,
        message: {
          role: 'assistant',
          content: generation.text,
        },
        finish_reason: generation.finish_reason,
      })),
      usage: {
        prompt_tokens: prompt_tokens,
        completion_tokens: completion_tokens,
        total_tokens: prompt_tokens + completion_tokens,
      },
    };
  }

  return generateInvalidProviderResponseError(response, BEDROCK);
};

export const BedrockCohereChatCompleteStreamChunkTransform: (
  response: string,
  fallbackId: string,
  _streamState: Record<string, any>,
  _strictOpenAiCompliance: boolean,
  gatewayRequest: Params,
) => string | string[] = (
  responseChunk,
  fallbackId,
  _streamState,
  _strictOpenAiCompliance,
  gatewayRequest,
) => {
  let chunk = responseChunk.trim();
  chunk = chunk.replace(/^data: /, '');
  chunk = chunk.trim();
  const parsedChunk: BedrockCohereStreamChunk = parseJson(chunk);

  const model = gatewayRequest.model || '';
  // discard the last cohere chunk as it sends the whole response combined.
  if (parsedChunk.is_finished) {
    return [
      `data: ${JSON.stringify({
        id: fallbackId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        provider: BEDROCK,
        choices: [
          {
            index: parsedChunk.index ?? 0,
            delta: {},
            finish_reason: parsedChunk.finish_reason,
          },
        ],
        usage: {
          prompt_tokens: parsedChunk['amazon-bedrock-invocationMetrics'].inputTokenCount,
          completion_tokens: parsedChunk['amazon-bedrock-invocationMetrics'].outputTokenCount,
          total_tokens:
            parsedChunk['amazon-bedrock-invocationMetrics'].inputTokenCount +
            parsedChunk['amazon-bedrock-invocationMetrics'].outputTokenCount,
        },
      })}\n\n`,
      `data: [DONE]\n\n`,
    ];
  }

  return `data: ${JSON.stringify({
    id: fallbackId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    provider: BEDROCK,
    choices: [
      {
        index: parsedChunk.index ?? 0,
        delta: {
          role: 'assistant',
          content: parsedChunk.text,
        },
        finish_reason: null,
      },
    ],
  })}\n\n`;
};

export const BedrockAI21ChatCompleteConfig: ProviderConfig = {
  messages: {
    param: 'prompt',
    required: true,
    transform: (params: Params) => {
      let prompt: string = '';
      if (params.messages) {
        let messages: Message[] = params.messages;
        messages.forEach((msg, index) => {
          if (index === 0 && SYSTEM_MESSAGE_ROLES.includes(msg.role)) {
            prompt += `system: ${promptText(msg.content)}\n`;
          } else if (msg.role == 'user') {
            prompt += `user: ${promptText(msg.content)}\n`;
          } else if (msg.role == 'assistant') {
            prompt += `assistant: ${promptText(msg.content)}\n`;
          } else {
            prompt += `${msg.role}: ${promptText(msg.content)}\n`;
          }
        });
        prompt += 'Assistant:';
      }
      return prompt;
    },
  },
  max_tokens: {
    param: 'maxTokens',
    default: 200,
  },
  max_completion_tokens: {
    param: 'maxTokens',
    default: 200,
  },
  temperature: {
    param: 'temperature',
    default: 0.7,
    min: 0,
    max: 1,
  },
  top_p: {
    param: 'topP',
    default: 1,
  },
  stop: {
    param: 'stopSequences',
  },
  presence_penalty: {
    param: 'presencePenalty',
    transform: (params: Params) => {
      return {
        scale: params.presence_penalty,
      };
    },
  },
  frequency_penalty: {
    param: 'frequencyPenalty',
    transform: (params: Params) => {
      return {
        scale: params.frequency_penalty,
      };
    },
  },
  countPenalty: {
    param: 'countPenalty',
  },
  frequencyPenalty: {
    param: 'frequencyPenalty',
  },
  presencePenalty: {
    param: 'presencePenalty',
  },
};

export const BedrockAI21ChatCompleteResponseTransform: (
  response: BedrockAI21CompleteResponse | BedrockErrorResponse,
  responseStatus: number,
  responseHeaders: Headers,
  strictOpenAiCompliance: boolean,
  _gatewayRequestUrl: string,
  gatewayRequest: Params,
) => ChatCompletionResponse | ErrorResponse = (
  response,
  responseStatus,
  responseHeaders,
  _strictOpenAiCompliance,
  _gatewayRequestUrl,
  gatewayRequest,
) => {
  if (responseStatus !== 200) {
    const errorResponse = BedrockErrorResponseTransform(response as BedrockErrorResponse);
    if (errorResponse) return errorResponse;
  }

  if ('completions' in response) {
    const prompt_tokens = Number(responseHeaders.get('X-Amzn-Bedrock-Input-Token-Count')) || 0;
    const completion_tokens = Number(responseHeaders.get('X-Amzn-Bedrock-Output-Token-Count')) || 0;
    return {
      id: response.id.toString(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: gatewayRequest.model ?? '',
      provider: BEDROCK,
      choices: response.completions.map((completion, index) => ({
        index: index,
        message: {
          role: 'assistant',
          content: completion.data.text,
        },
        finish_reason: completion.finishReason?.reason,
      })),
      usage: {
        prompt_tokens: prompt_tokens,
        completion_tokens: completion_tokens,
        total_tokens: prompt_tokens + completion_tokens,
      },
    };
  }

  return generateInvalidProviderResponseError(response, BEDROCK);
};
