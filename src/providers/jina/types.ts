// ==================== Rerank Types ====================

/**
 * Jina Rerank API Response
 */
export interface JinaRerankResponse {
  /** Model used for reranking */
  model?: string;
  /** Usage information */
  usage?: JinaRerankUsage;
  /** Array of reranked results */
  results?: JinaRerankResult[];
  /** Error detail message */
  detail?: string;
  /** Error message */
  message?: string;
}

export interface JinaRerankUsage {
  /** Total tokens used */
  total_tokens?: number;
  /** Prompt tokens used */
  prompt_tokens?: number;
}

export interface JinaRerankResult {
  /** Position in the original document list */
  index: number;
  /** Relevance score */
  relevance_score: number;
  /** Document object (if return_documents=true) */
  document?: {
    text: string;
  };
}
