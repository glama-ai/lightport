// ==================== Rerank Types ====================

/**
 * Voyage Rerank API Response
 */
export interface VoyageRerankResponse {
  /** Object type */
  object?: string;
  /** Array of reranked results sorted by relevance score descending */
  data?: VoyageRerankResult[];
  /** Model used for reranking */
  model?: string;
  /** Usage information */
  usage?: VoyageRerankUsage;
  /** Error detail message */
  detail?: string;
  /** Error message */
  message?: string;
}

export interface VoyageRerankUsage {
  /** Total tokens used */
  total_tokens?: number;
}

export interface VoyageRerankResult {
  /** Position in the original document list */
  index: number;
  /** Relevance score */
  relevance_score: number;
  /** Document text (if return_documents=true) */
  document?: string;
}
