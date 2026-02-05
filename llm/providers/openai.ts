import OpenAI from "openai";
import {
  ReasoningStreamOptions,
  ReasoningEffort,
  StandardizedModel,
} from "../index";

function getClient(baseURL?: string, apiKeyOverride?: string) {
  const apiKey = apiKeyOverride || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");
  const resolvedBase =
    baseURL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  return new OpenAI({ apiKey, baseURL: resolvedBase });
}

export async function fetchModels(
  apiKeyOverride?: string,
  baseURL?: string,
): Promise<StandardizedModel[]> {
  const client = getClient(baseURL, apiKeyOverride);
  try {
    const response = await client.models.list();
    // console.log("OpenAI models response:", JSON.stringify(response, null, 2));

    return response.data.map(
      (model: any): StandardizedModel => ({
        id: model.id,
        name: model.id, // OpenAI doesn't provide display names
        provider: "openai",
        created: model.created,
        owned_by: model.owned_by,
        object: model.object,
      }),
    );
  } catch (error) {
    console.error("Error fetching OpenAI models:", error);
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
    debugEvents = false,
    onReasoningDelta,
    onAnswerDelta,
  } = opts;

  const client = getClient(undefined, opts.apiKey);

  let thinking = "";
  let finalAnswer = "";
  const startedAt = Date.now();
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let reasoningTokens: number | undefined;
  let totalTokens: number | undefined;
  let final: any = null;

  let printedReasoningHeader = false;
  let printedAnswerHeader = false;
  let printedAnything = false;

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
      printHeaderOnce("REASONING (summary)");
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

  const input =
    inputMessages && inputMessages.length > 0
      ? inputMessages
      : prompt;
  const body: any = { model, input, stream: true };
  body.reasoning = { effort, summary: "detailed" };
  if (opts.webSearch) {
    body.tools = [{ type: "web_search" }];
  }

  const stream = await client.responses.create(body);
  for await (const event of stream as any) {
    if (debugEvents) console.log("RAW_STREAM:", JSON.stringify(event));
    switch (event.type) {
      case "response.reasoning_summary_text.delta": {
        const d = event.delta ?? "";
        thinking += d;
        writeReasoningDelta(d);
        break;
      }
      case "response.output_text.delta": {
        const d = event.delta ?? "";
        finalAnswer += d;
        writeAnswerDelta(d);
        break;
      }
      case "response.output_text.done": {
        if (!onAnswerDelta) process.stdout.write("\n");
        break;
      }
      case "response.completed": {
        const usage = event.response?.usage ?? {};
        inputTokens = usage.input_tokens;
        outputTokens = usage.output_tokens;
        reasoningTokens = usage.reasoning_tokens;
        totalTokens = usage.total_tokens;
        final = event.response;
        break;
      }
      case "response.incomplete": {
        const usage = event.response?.usage ?? {};
        inputTokens = usage.input_tokens ?? inputTokens;
        outputTokens = usage.output_tokens ?? outputTokens;
        reasoningTokens = usage.reasoning_tokens ?? reasoningTokens;
        totalTokens = usage.total_tokens ?? totalTokens;
        final = event.response ?? final;
        break;
      }
      case "response.failed": {
        final = event;
        break;
      }
    }
  }

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
    annotations: [], // OpenAI doesn't support annotations
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
