import { REQUESTY } from '../../globals';
import { OpenAIErrorResponseTransform } from '../openai/utils';
import { ChatCompletionResponse, ErrorResponse } from '../types';
import { generateInvalidProviderResponseError, transformReasoning } from '../utils';

/*
  Requesty answers in OpenAI's own shape, so the response is carried whole rather
  than rebuilt field by field — which is what loses a field nobody thought to
  name, and Requesty routes to models from several houses.

  What it does not bring on its own is the content block form of the reasoning.
  Requesty reports a model's thinking as `reasoning_content`, and that arrives
  untouched, but the Responses adapter reads a reasoning turn from
  `content_blocks` alone when it is not streaming — so without this a caller
  reaching that API through Requesty would be handed a reasoner's answer with the
  thinking missing. Streamed, the adapter reads the field itself, which is why
  there is no transform for that half.
*/
export const RequestyChatCompleteResponseTransform: (
  response: ChatCompletionResponse | ErrorResponse,
  responseStatus: number,
  responseHeaders: Headers,
  strictOpenAiCompliance: boolean,
) => ChatCompletionResponse | ErrorResponse = (
  response,
  responseStatus,
  _responseHeaders,
  strictOpenAiCompliance,
) => {
  if (responseStatus !== 200 && 'error' in response) {
    return OpenAIErrorResponseTransform(response as ErrorResponse, REQUESTY);
  }

  // `Array.isArray`, not `'choices' in response`: a body naming the field and
  // leaving it null passes that test and then fails on the first thing done with
  // it, which reaches the caller as a 500 of the gateway's own making rather than
  // as the unreadable answer it is.
  const answered = response as ChatCompletionResponse;

  if (Array.isArray(answered.choices)) {
    return {
      ...answered,
      provider: REQUESTY,
      choices: answered.choices.map((choice) => ({
        ...choice,
        message: {
          ...choice.message,
          ...transformReasoning(choice.message, strictOpenAiCompliance),
        },
      })),
    };
  }

  return generateInvalidProviderResponseError(response, REQUESTY);
};
