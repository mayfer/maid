import Anthropic from "@anthropic-ai/sdk";
import { ReasoningStreamOptions, ReasoningEffort, StandardizedModel } from "../index";

function getClient(apiKeyOverride?: string) {
  const apiKey = apiKeyOverride || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");
  return new Anthropic({ apiKey });
}

export async function fetchModels(apiKeyOverride?: string): Promise<StandardizedModel[]> {
  const client = getClient(apiKeyOverride);
  try {
    const response = await client.models.list();
    // console.log("Anthropic models response:", JSON.stringify(response, null, 2));

    return response.data.map((model: any): StandardizedModel => ({
      id: model.id,
      name: model.display_name || model.id,
      provider: "anthropic",
      created: model.created_at ? new Date(model.created_at).getTime() / 1000 : undefined,
      type: model.type,
    }));
  } catch (error) {
    console.error("Error fetching Anthropic models:", error);
    throw error;
  }
}

// Map reasoning effort to Anthropic thinking budget tokens
function getThinkingBudget(effort: ReasoningEffort): number {
  switch (effort) {
    case ReasoningEffort.Off:
      return 0;
    case ReasoningEffort.Low:
      return 5000;
    case ReasoningEffort.Medium:
      return 10000;
    case ReasoningEffort.High:
      return 20000;
    default:
      return 10000;
  }
}

export async function reasoningStream(opts: ReasoningStreamOptions) {
  const {
    prompt,
    model,
    effort = ReasoningEffort.Medium,
    printHeaders = true,
    debugEvents = false,
    onReasoningDelta,
    onAnswerDelta,
  } = opts;

  const client = getClient(opts.apiKey);
  const startedAt = Date.now();
  
  let thinking = "";
  let finalAnswer = "";
  let printedReasoningHeader = false;
  let printedAnswerHeader = false;
  let printedAnything = false;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let thinkingTokens: number | undefined;
  let totalTokens: number | undefined;
  let final: any = null;

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
      printHeaderOnce("THINKING");
      printedReasoningHeader = true;
    }
    thinking += delta;
    if (onReasoningDelta) onReasoningDelta(delta);
    else process.stdout.write(delta);
  }

  function writeAnswerDelta(delta: string) {
    if (!printedAnswerHeader) {
      if (printedReasoningHeader && !onReasoningDelta && !onAnswerDelta) process.stdout.write("\n");
      printHeaderOnce("ANSWER");
      printedAnswerHeader = true;
    }
    finalAnswer += delta;
    if (onAnswerDelta) onAnswerDelta(delta);
    else process.stdout.write(delta);
  }

  // Prepare request parameters
  const budgetTokens = getThinkingBudget(effort);
  const requestParams: any = {
    model,
    max_tokens: Math.max(16000, budgetTokens + 6000), // Ensure max_tokens > budget_tokens
    messages: [{ role: "user", content: prompt }],
  };

  // Add thinking parameter if effort is not off
  if (effort !== ReasoningEffort.Off && budgetTokens > 0) {
    requestParams.thinking = { 
      type: "enabled", 
      budget_tokens: budgetTokens 
    };
  }

  try {
    const stream = await client.messages.stream(requestParams);
    
    for await (const event of stream) {
      if (debugEvents) console.log("RAW_STREAM:", JSON.stringify(event));
      
      if (event.type === "message_start") {
        const usage = (event as any).message?.usage;
        if (usage) {
          inputTokens = usage.input_tokens;
        }
        continue;
      }
      
      if (event.type === "content_block_delta") {
        if (event.delta?.type === "text_delta") {
          const delta = event.delta.text || "";
          if (delta) {
            writeAnswerDelta(delta);
          }
        }
      }
      
      // Handle thinking content if available in the stream
      const eventAny = event as any;
      if (eventAny.thinking_delta || eventAny.delta?.thinking) {
        const thinkingDelta = eventAny.thinking_delta || eventAny.delta?.thinking || "";
        if (thinkingDelta) {
          writeReasoningDelta(thinkingDelta);
        }
      }
      
      if (event.type === "message_delta") {
        const usage = (event as any).usage;
        if (usage) {
          outputTokens = usage.output_tokens;
          totalTokens = usage.input_tokens + usage.output_tokens;
        }
      }
    }
    
    // Get final response for usage info
    final = await stream.finalMessage();
    if (final?.usage) {
      inputTokens = final.usage.input_tokens;
      outputTokens = final.usage.output_tokens;
      totalTokens = (inputTokens || 0) + (outputTokens || 0);
    }
    
  } catch (error) {
    console.error("Anthropic reasoning stream error:", error);
    throw error;
  }

  const ms = Date.now() - startedAt;
  if (!onReasoningDelta && !onAnswerDelta) {
    console.log("\n=== USAGE SUMMARY ===");
    console.log(`Time: ${ms} ms`);
    console.log(`Model: ${model}`);
    if (typeof inputTokens === "number") console.log(`Input tokens: ${inputTokens}`);
    if (typeof outputTokens === "number") console.log(`Output tokens: ${outputTokens}`);
    if (typeof thinkingTokens === "number") console.log(`Thinking tokens: ${thinkingTokens}`);
    if (typeof totalTokens === "number") console.log(`Total tokens: ${totalTokens}`);
    console.log(`Thinking budget: ${budgetTokens} tokens`);
  }

  if (printedReasoningHeader && !onReasoningDelta && !onAnswerDelta) process.stdout.write("\n");
  if (printedAnswerHeader && !onAnswerDelta) process.stdout.write("\n");

  return {
    finalAnswer,
    thinking,
    usage: { model, ms, inputTokens, outputTokens, reasoningTokens: thinkingTokens, totalTokens },
    raw: final,
  };
}