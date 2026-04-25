export type AnthropicStreamState = {
  containsChainOfThoughtMessage?: boolean;
  toolIndex?: number;
  toolCalls?: Map<number, { index: number; id: string; name: string; arguments: string }>;
  usage?: {
    input_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  model?: string;
};

// https://docs.anthropic.com/en/api/messages#response-stop-reason
export { ANTHROPIC_STOP_REASON } from '../../types/messagesResponse';

export interface AnthropicErrorObject {
  type: string;
  message: string;
}

export interface AnthropicErrorResponse {
  type: string;
  error: AnthropicErrorObject;
}
