import {
  reasoningStream as openAIReasoningStream,
  fetchModels as openAIFetchModels,
} from "./providers/openai";
import {
  reasoningStream as openrouterReasoningStream,
  fetchModels as openrouterFetchModels,
} from "./providers/openrouter";
import * as Rankings from "./rankings";
export {
  rankModels,
  processOpenRouterModels,
  getTopModels,
  filterModelsByProvider,
  sortModelsByProvider,
  getModelRanking,
  exampleRanking,
} from "./rankings";
export type { ModelRanking, OpenRouterModel } from "./rankings";

export const ReasoningEffort = {
  Off: "off",
  Low: "low",
  Medium: "medium",
  High: "high",
} as const;
export type ReasoningEffort =
  (typeof ReasoningEffort)[keyof typeof ReasoningEffort];

export type Provider =
  | "openai"
  | "openrouter"
  | "custom";

export interface ModelPricing {
  prompt?: number;
  completion?: number;
  image?: number;
  request?: number;
  web_search?: number;
  internal_reasoning?: number;
  image_output?: number;
  discount?: number;
}

export interface StandardizedModel {
  id: string;
  name?: string; // display_name for Anthropic, or fallback to id
  provider: Provider;
  created?: number; // Unix timestamp
  owned_by?: string;
  object?: string; // Usually "model"
  active?: boolean; // Groq specific
  context_window?: number; // Groq specific
  context_length?: number; // OpenRouter specific
  max_completion_tokens?: number; // Groq specific
  type?: string; // Anthropic specific ("model")
  permaslug?: string; // OpenRouter specific
  pricing?: ModelPricing;
  // Parameters the model explicitly supports (from provider metadata, e.g. OpenRouter "supported_parameters")
  supported_parameters?: string[];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ReasoningStreamOptions {
  prompt?: string;
  messages?: ChatMessage[];
  model?: string;
  provider?: Provider;
  effort?: ReasoningEffort;
  printHeaders?: boolean;
  debugEvents?: boolean;
  onReasoningDelta?: (delta: string) => void;
  onAnswerDelta?: (delta: string) => void;
  onAnnotations?: (annotations: any[]) => void;
  apiKey?: string;
  baseUrl?: string;
  webSearch?: boolean;
  signal?: AbortSignal;
}

export interface ReasoningStreamResult {
  finalAnswer: string;
  thinking: string;
  annotations?: any[];
  usage: any;
  raw: any;
}

export interface ChatStreamOptions {
  prompt: string;
  model?: string;
  provider?: Provider;
  baseUrl?: string;
  printHeaders?: boolean;
  debugEvents?: boolean;
  onAnswerDelta?: (delta: string) => void;
  apiKey?: string;
}

export async function fetchModels(
  provider: Provider,
  apiKey?: string,
  baseURL?: string,
): Promise<StandardizedModel[]> {
  switch (provider) {
    case "openrouter":
      return openrouterFetchModels(apiKey, baseURL);
    case "openai":
    case "custom":
    default:
      // Fall back to OpenAI for providers that don't have fetchModels yet
      return openAIFetchModels(apiKey, baseURL);
  }
}

export async function reasoningStream(
  opts: ReasoningStreamOptions,
): Promise<ReasoningStreamResult> {
  const provider: Provider =
    opts.provider || (process.env.PROVIDER as Provider) || "openai";
  switch (provider) {
    case "openrouter":
      return openrouterReasoningStream(opts);
    case "openai":
    case "custom":
    default:
      // Fall back to OpenAI for providers that don't support reasoning yet
      return openAIReasoningStream(opts);
  }
}

/**
 * Fetch models with ranking information
 * This enhances the original provider data with ranking scores and metadata
 */
export async function fetchModelsWithRanking(
  provider: Provider,
  apiKey?: string,
  baseURL?: string,
): Promise<{
  models: StandardizedModel[];
  rankings: Rankings.ModelRanking[];
  topModels: StandardizedModel[];
}> {
  // Fetch models from the provider
  const models = await fetchModels(provider, apiKey, baseURL);

  // Import ranking functions
  const { rankModels, getTopModels } = Rankings;

  // Generate rankings
  const rankings = await rankModels(models);

  // Get top 10 models
  const topModels = getTopModels(rankings, 10);

  return {
    models,
    rankings,
    topModels,
  };
}
