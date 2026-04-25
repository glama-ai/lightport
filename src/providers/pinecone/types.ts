// ==================== Rerank Types ====================

export interface PineconeRerankDocument {
  /** Document ID */
  id: string;
  /** Document text */
  text: string;
  /** Additional fields */
  [key: string]: any;
}

/**
 * Pinecone Rerank API Response
 */
export interface PineconeRerankResponse {
  /** Model used for reranking */
  model?: string;
  /** Array of reranked results */
  data?: PineconeRerankResult[];
  /** Usage information */
  usage?: PineconeRerankUsage;
  /** Error message */
  message?: string;
  /** Error object */
  error?: {
    message: string;
    code?: string;
  };
}

export interface PineconeRerankUsage {
  /** Rerank units used */
  rerank_units?: number;
}

export interface PineconeRerankResult {
  /** Position in the original document list */
  index: number;
  /** Relevance score */
  score: number;
  /** Document object (if return_documents=true) */
  document?: {
    text: string;
    [key: string]: any;
  };
}
