import OpenAI from "openai";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import {
  ReasoningStreamOptions,
  ReasoningEffort,
  StandardizedModel,
} from "../index";

const MAID_CONFIG_FILE = path.join(homedir(), ".config", "maid.json");

interface Annotation {
  type: string;
  url_citation?: {
    url: string;
    title: string;
    content?: string;
    start_index: number;
    end_index: number;
  };
}

function formatOpenRouterError(err: any): string {
  const status =
    typeof err?.status === "number"
      ? err.status
      : typeof err?.error?.code === "number"
        ? err.error.code
        : undefined;
  const message =
    (typeof err?.error?.message === "string" && err.error.message) ||
    (typeof err?.message === "string" && err.message) ||
    "Unknown OpenRouter error";
  return status ? `${status} ${message}` : message;
}

function getConfigApiKey(): string | undefined {
  try {
    if (!existsSync(MAID_CONFIG_FILE)) return undefined;
    const parsed: any = JSON.parse(readFileSync(MAID_CONFIG_FILE, "utf-8"));
    const nestedApiKey =
      typeof parsed?.providers?.openrouter?.apiKey === "string"
        ? parsed.providers.openrouter.apiKey.trim()
        : "";
    const legacyApiKey =
      typeof parsed?.openrouterApiKey === "string"
        ? parsed.openrouterApiKey.trim()
        : "";
    const apiKey = nestedApiKey || legacyApiKey;
    return apiKey || undefined;
  } catch {
    return undefined;
  }
}

function getClient(baseURL?: string, apiKeyOverride?: string) {
  const apiKey = apiKeyOverride || process.env.OPENROUTER_API_KEY || getConfigApiKey();
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");
  const resolvedBase =
    baseURL ||
    process.env.OPENROUTER_BASE_URL ||
    "https://openrouter.ai/api/v1";
  return new OpenAI({
    apiKey,
    baseURL: resolvedBase,
  });
}

export async function fetchModels(
  apiKeyOverride?: string,
  baseURL?: string,
): Promise<StandardizedModel[]> {
  const client = getClient(baseURL, apiKeyOverride);
  try {
    const response = await client.models.list();
    // console.log("OpenRouter models response:", JSON.stringify(response, null, 2));

    return response.data.map(
      (model: any): StandardizedModel => ({
        id: model.id,
        name: model.id, // OpenRouter doesn't provide display names in the same format
        provider: "openrouter",
        created: model.created,
        owned_by: model.owned_by,
        object: model.object,
        context_length:
          model?.top_provider?.context_length ?? model?.context_length,
        permaslug: model?.permaslug,
        pricing: model?.pricing
          ? {
            prompt: Number(model.pricing.prompt) || undefined,
            completion: Number(model.pricing.completion) || undefined,
            request: Number(model.pricing.request) || undefined,
            image: Number(model.pricing.image) || undefined,
            web_search: Number(model.pricing.web_search) || undefined,
            internal_reasoning:
              Number(model.pricing.internal_reasoning) || undefined,
          }
          : undefined,
        supported_parameters: Array.isArray(model?.supported_parameters)
          ? model.supported_parameters
          : undefined,
      }),
    );
  } catch (error) {
    console.error("Error fetching OpenRouter models:", error);
    throw error;
  }
}

export async function reasoningStream(opts: ReasoningStreamOptions) {
  const {
    prompt,
    messages: inputMessages,
    model,
    effort = ReasoningEffort.Medium,
    printHeaders = true,
    debugEvents = true,
    onReasoningDelta,
    onAnswerDelta,
    baseUrl,
  } = opts;

  if (debugEvents) {
    console.log(
      `[OpenRouter] reasoningStream start model=${model}, effort=${effort}`,
    );
    console.log(
      `[OpenRouter] prompt length=${prompt ? prompt.length : 0}, prompt=`,
      prompt,
    );
  }
  const client = getClient(baseUrl, opts.apiKey);

  let thinking = "";
  let finalAnswer = "";
  const startedAt = Date.now();
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let reasoningTokens: number | undefined;
  let totalTokens: number | undefined;
  let final: any = null;
  let annotations: Annotation[] = [];

  let printedReasoningHeader = false;
  let printedAnswerHeader = false;
  let printedAnything = false;
  const processedReasoningIds = new Set<string>();

  function printHeaderOnce(title: string) {
    if (printHeaders && !onReasoningDelta && !onAnswerDelta) {
      if (!printedAnything) {
        console.log("========================================");
        console.log(`Model: ${model}  |  Effort: ${effort}`);
        console.log("========================================\n");
        printedAnything = true;
      }
      console.log(`=== ${title} ===`);
    }
  }

  function writeReasoningDelta(delta: string) {
    if (!printedReasoningHeader) {
      printHeaderOnce("REASONING");
      printedReasoningHeader = true;
    }
    if (onReasoningDelta) onReasoningDelta(delta);
    else process.stdout.write(delta);
  }

  function writeAnswerDelta(delta: string) {
    if (!printedAnswerHeader) {
      if (printedReasoningHeader && !onReasoningDelta)
        process.stdout.write("\n\n");
      printHeaderOnce("ANSWER");
      printedAnswerHeader = true;
    }
    if (onAnswerDelta) onAnswerDelta(delta);
    else process.stdout.write(delta);
  }

  // Build reasoning configuration based on OpenRouter's format.
  // Only include if the selected model supports the parameter.
  const reasoningConfig: any = {};
  let includeReasoning = true;
  try {
    // Attempt to find the model in a quick one-off list call to inspect supported params
    // If not found or call fails, we still send reasoning (OpenRouter often tolerates it).
    const models = await fetchModels(opts.apiKey, baseUrl);
    const m = models.find((m) => m.id === model);
    const supported = m?.supported_parameters || [];
    includeReasoning =
      supported.includes("reasoning") ||
      supported.includes("include_reasoning");
  } catch { }

  if (includeReasoning) {
    if (effort === ReasoningEffort.Off) {
      reasoningConfig.exclude = true;
    } else {
      reasoningConfig.effort = effort;
    }
  }
  if (debugEvents) {
    console.log(
      "[OpenRouter] Supported parameters include reasoning:",
      includeReasoning,
    );
    console.log("[OpenRouter] Reasoning config:", reasoningConfig);
  }

  // Use OpenRouter's chat completions API format
  // Use provided messages array, or build from prompt
  let messages: any[];
  if (inputMessages && inputMessages.length > 0) {
    // Add system message if not present
    const hasSystem = inputMessages.some(m => m.role === "system");
    if (!hasSystem) {
      messages = [
        { role: "system", content: "You are in a terminal CLI. Provide succinct, direct answers without unnecessary verbosity. Be helpful and concise." },
        ...inputMessages
      ];
    } else {
      messages = inputMessages;
    }
  } else {
    messages = [
      { role: "system", content: "You are in a terminal CLI. Provide succinct, direct answers without unnecessary verbosity. Be helpful and concise." },
      { role: "user", content: prompt }
    ];
  }
  const requestBody: any = {
    model,
    plugins: opts.webSearch ? [{ id: "web" }] : [],
    messages,
    stream: true,
    ...(includeReasoning ? { reasoning: reasoningConfig } : {}),
  };

  // Prepare OpenRouter recommended headers per-request
  const requestHeaders: Record<string, string> = {};
  const referer =
    process.env.OPENROUTER_REFERRER ||
    process.env.OPENROUTER_SITE_URL ||
    process.env.SITE_URL;
  const title =
    process.env.OPENROUTER_TITLE ||
    process.env.OPENROUTER_APP_TITLE ||
    process.env.APP_TITLE;
  if (referer) requestHeaders["HTTP-Referer"] = referer;
  if (title) requestHeaders["X-Title"] = title;

  if (debugEvents) {
    const resolvedBaseForLog =
      baseUrl ||
      process.env.OPENROUTER_BASE_URL ||
      "https://openrouter.ai/api/v1";
    console.log("[OpenRouter] Base URL:", resolvedBaseForLog);
    console.log(
      "[OpenRouter] API key present:",
      Boolean(opts.apiKey || process.env.OPENROUTER_API_KEY),
    );
    console.log(
      "[OpenRouter] Request headers:",
      JSON.stringify(requestHeaders, null, 2),
    );
    console.log(
      "[OpenRouter] Request body:",
      JSON.stringify(requestBody, null, 2),
    );
  }

  let stream: any;
  // Log outgoing OpenRouter request (unconditional)
  const resolvedBaseForLog =
    baseUrl ||
    process.env.OPENROUTER_BASE_URL ||
    "https://openrouter.ai/api/v1";
  const requestUrl = `${resolvedBaseForLog}/chat/completions`;
  if (debugEvents) {
    console.log("[OpenRouter] POST", requestUrl);
    console.log(
      "[OpenRouter] Request headers:",
      JSON.stringify(requestHeaders, null, 2),
    );
    try {
      console.log(
        "[OpenRouter] Request body:",
        JSON.stringify(requestBody, null, 2),
      );
    } catch { }
  }
  try {
    stream = await client.chat.completions.create(requestBody, {
      headers: requestHeaders,
      signal: opts.signal as any,
    } as any);
  } catch (err) {
    const summary = formatOpenRouterError(err);
    console.error(`OpenRouter request failed: ${summary}`);
    if (debugEvents) {
      console.error("Raw error:", err);
      console.error(
        "Request headers were:",
        JSON.stringify(requestHeaders, null, 2),
      );
      console.error("Request body was:", JSON.stringify(requestBody, null, 2));
    }
    throw new Error(summary);
  }
  let firstChunkLogged = false;

  for await (const chunk of stream) {
    if (!firstChunkLogged) {
      if (debugEvents) {
        console.log(
          "[OpenRouter] First chunk:",
          JSON.stringify(chunk, null, 2),
        );
      }
      firstChunkLogged = true;
    }

    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;

    // Handle reasoning content from reasoning_details (OpenRouter format)
    if (delta.reasoning_details && delta.reasoning_details.length > 0) {
      for (const reasoningDetail of delta.reasoning_details) {
        // Skip duplicate chunks by checking ID
        if (
          reasoningDetail.id &&
          processedReasoningIds.has(reasoningDetail.id)
        ) {
          if (debugEvents)
            console.log("SKIPPING DUPLICATE REASONING ID:", reasoningDetail.id);
          continue;
        }

        if (reasoningDetail.type === "reasoning.text" && reasoningDetail.text) {
          if (debugEvents)
            console.log(
              "REASONING TEXT:",
              reasoningDetail.text.length,
              "chars",
            );
          thinking += reasoningDetail.text;
          writeReasoningDelta(reasoningDetail.text);
          if (reasoningDetail.id) processedReasoningIds.add(reasoningDetail.id);
        } else if (
          reasoningDetail.type === "reasoning.summary" &&
          reasoningDetail.summary
        ) {
          if (debugEvents)
            console.log(
              "REASONING SUMMARY:",
              reasoningDetail.summary.length,
              "chars",
            );
          thinking += reasoningDetail.summary;
          writeReasoningDelta(reasoningDetail.summary);
          if (reasoningDetail.id) processedReasoningIds.add(reasoningDetail.id);
        }
      }
    }
    // Handle reasoning content from reasoning field (legacy format) only if reasoning_details is not present
    else if (delta.reasoning) {
      if (debugEvents)
        console.log("LEGACY REASONING:", delta.reasoning.length, "chars");
      thinking += delta.reasoning;
      writeReasoningDelta(delta.reasoning);
    }

    // Handle regular content
    if (delta.content) {
      finalAnswer += delta.content;
      writeAnswerDelta(delta.content);
    }

    // Handle annotations
    if ((delta as any)?.annotations) {
      const newAnnotations = (delta as any).annotations as any[];
      if (debugEvents) {
        console.log(
          "OpenRouter delta annotations:",
          JSON.stringify(newAnnotations, null, 2),
        );
      }
      annotations = annotations.concat(newAnnotations);
      if (opts.onAnnotations) {
        try {
          opts.onAnnotations(newAnnotations);
        } catch { }
      }
    }
    if (chunk.choices?.[0]?.message?.annotations) {
      const messageAnnotations = chunk.choices[0].message.annotations;
      if (debugEvents) {
        console.log(
          "OpenRouter message annotations:",
          JSON.stringify(messageAnnotations, null, 2),
        );
      }
      annotations = messageAnnotations;
      if (opts.onAnnotations) {
        try {
          opts.onAnnotations(messageAnnotations);
        } catch { }
      }
    }

    // Handle usage information
    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens;
      outputTokens = chunk.usage.completion_tokens;
      totalTokens = chunk.usage.total_tokens;
      // OpenRouter may provide reasoning tokens in usage
      if ("reasoning_tokens" in chunk.usage) {
        reasoningTokens = (chunk.usage as any).reasoning_tokens;
      }
    }

    // Store final response for return value
    if (chunk.choices?.[0]?.finish_reason) {
      final = chunk;
    }
  }

  // Log final raw chunk and extract annotations if present
  if (debugEvents) {
    try {
      console.log("[OpenRouter] Final chunk:", JSON.stringify(final, null, 2));
    } catch { }
  }
  if (
    final?.choices?.[0]?.message?.annotations &&
    (!annotations || annotations.length === 0)
  ) {
    const finalAnnotations = final.choices[0].message.annotations;
    if (debugEvents) {
      console.log(
        "OpenRouter final message annotations:",
        JSON.stringify(finalAnnotations, null, 2),
      );
    }
    annotations = finalAnnotations;
    if (opts.onAnnotations) {
      try {
        opts.onAnnotations(finalAnnotations);
      } catch { }
    }
  }
  // Final chunk already logged above
  if (!onAnswerDelta && finalAnswer) process.stdout.write("\n");

  const ms = Date.now() - startedAt;
  if (!onReasoningDelta && !onAnswerDelta) {
    console.log("\n=== USAGE SUMMARY ===");
    console.log(`Time: ${ms} ms`);
    console.log(`Model: ${model}`);
    if (typeof inputTokens === "number")
      console.log(`Input tokens: ${inputTokens}`);
    if (typeof outputTokens === "number")
      console.log(`Output tokens: ${outputTokens}`);
    if (typeof reasoningTokens === "number")
      console.log(`Reasoning tokens: ${reasoningTokens}`);
    if (typeof totalTokens === "number")
      console.log(`Total tokens: ${totalTokens}`);
  }

  return {
    finalAnswer,
    thinking,
    annotations,
    usage: {
      model,
      ms,
      inputTokens,
      outputTokens,
      reasoningTokens,
      totalTokens,
    },
    raw: final,
  };
}
