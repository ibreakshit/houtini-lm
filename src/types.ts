// src/types.ts — Shared backend types for houtini-lm
// Moved from src/index.ts; extended with CLI-backend types.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamingResult {
  content: string;
  /** Raw content before think-block stripping (for quality assessment) */
  rawContent: string;
  /** Reasoning content streamed via OpenAI vendor extension delta.reasoning_content */
  reasoningContent?: string;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    /** OpenAI: how many of the completion tokens were reasoning (hidden) */
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  finishReason: string;
  truncated: boolean;
  /** Time to first token in milliseconds */
  ttftMs?: number;
  /** Total generation time in milliseconds */
  generationMs: number;
  /** True when think-block stripping left nothing and we fell back to raw content */
  thinkStripFallback?: boolean;
  /** True when no visible content arrived and we fell back to reasoning_content */
  reasoningFallback?: boolean;
  /** Truncation caused by prefill stall (no chunks received) vs mid-stream stall */
  prefillStall?: boolean;
}

/** OpenAI-compatible response_format for structured output */
export interface ResponseFormat {
  type: 'json_schema' | 'json_object' | 'text';
  json_schema?: {
    name: string;
    strict?: boolean | string;
    schema: Record<string, unknown>;
  };
}

export interface ModelInfo {
  id: string;
  object?: string;
  type?: string;              // "llm" | "vlm" | "embeddings"
  publisher?: string;          // e.g. "nvidia", "qwen", "ibm"
  arch?: string;               // e.g. "nemotron_h_moe", "qwen3moe", "llama"
  compatibility_type?: string; // "gguf" | "mlx"
  quantization?: string;       // e.g. "Q4_K_M", "BF16", "MXFP4"
  state?: string;              // "loaded" | "not-loaded"
  max_context_length?: number; // model's maximum context (v0 API)
  loaded_context_length?: number; // actual context configured when loaded
  capabilities?: string[];     // e.g. ["tool_use"]
  context_length?: number;     // v1 API fallback
  max_model_len?: number;      // vLLM fallback
  owned_by?: string;
  [key: string]: unknown;
}

// ── CLI-backend extension types ──────────────────────────────────────

export type TaskType = 'code' | 'chat' | 'analysis' | 'embedding';

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  model?: string;
  responseFormat?: ResponseFormat;
  progressToken?: string | number;
  taskType?: TaskType;          // drives CLI pool capability scoring
  overridden?: boolean;         // true when model came from an explicit user override (D6)
  onProgress?: (message: string) => void;
}

export interface EmbedResult {
  model: string;
  data: { embedding: number[]; index: number }[];
  usage?: { prompt_tokens: number; total_tokens: number };
}

export interface InferenceBackend {
  name: string;
  chat(messages: ChatMessage[], options: ChatOptions): Promise<StreamingResult>;
  listModels(): Promise<ModelInfo[]>;
  embed?(input: string | string[], model?: string): Promise<EmbedResult>;
}
