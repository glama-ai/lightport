import {
  CitationCharLocation,
  CitationContentBlockLocation,
  CitationPageLocation,
  CitationsWebSearchResultLocation,
  RedactedThinkingBlock,
  ServerToolUseBlock,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  WebSearchToolResultBlock,
} from './messagesResponse';

export interface RawContentBlockStartEvent {
  content_block:
    | TextBlock
    | ToolUseBlock
    | ServerToolUseBlock
    | WebSearchToolResultBlock
    | ThinkingBlock
    | RedactedThinkingBlock;

  index: number;

  type: 'content_block_start';
}

export interface TextDelta {
  text: string;

  type: 'text_delta';
}

export interface InputJSONDelta {
  partial_json: string;

  type: 'input_json_delta';
}

export interface CitationsDelta {
  citation:
    | CitationCharLocation
    | CitationPageLocation
    | CitationContentBlockLocation
    | CitationsWebSearchResultLocation;

  type: 'citations_delta';
}

export interface ThinkingDelta {
  thinking: string;

  type: 'thinking_delta';
}

export interface SignatureDelta {
  signature: string;

  type: 'signature_delta';
}

export type RawContentBlockDelta =
  | TextDelta
  | InputJSONDelta
  | CitationsDelta
  | ThinkingDelta
  | SignatureDelta;

export interface RawContentBlockDeltaEvent {
  delta: RawContentBlockDelta;

  index: number;

  type: 'content_block_delta';
}

export interface RawContentBlockStopEvent {
  index: number;

  type: 'content_block_stop';
}

