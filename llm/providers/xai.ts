import OpenAI from "openai";
import { ReasoningStreamOptions, ReasoningEffort, StandardizedModel } from "../index";

function getClient(apiKeyOverride?: string) {
  const apiKey = apiKeyOverride || process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("Missing XAI_API_KEY");
  const baseURL = "https://api.x.ai/v1";
  return new OpenAI({ apiKey, baseURL });
}

export async function fetchModels(apiKeyOverride?: string): Promise<StandardizedModel[]> {
  const client = getClient(apiKeyOverride);
  try {
    const response = await client.models.list();
    console.log("xAI models response:", JSON.stringify(response, null, 2));

    return response.data.map((model: any): StandardizedModel => ({
      id: model.id,
      name: model.id, // xAI doesn't provide display names
      provider: "xai",
      created: model.created,
      owned_by: model.owned_by,
      object: model.object,
    }));
  } catch (error) {
    console.error("Error fetching xAI models:", error);
    throw error;
  }
}

export async function reasoningStream(opts: ReasoningStreamOptions) {
  const { prompt, model, printHeaders = true, debugEvents = false, onReasoningDelta, onAnswerDelta, effort } = opts;
  const client = getClient(opts.apiKey);

  let finalAnswer = "";
  let thinking = "";
  const startedAt = Date.now();
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let reasoningTokens: number | undefined;
  let totalTokens: number | undefined;
  let final: any = null;
  let printedAnything = false;
  let printedAnswerHeader = false;
  let printedReasoningHeader = false;

  function printHeaderOnce(title: string) {
    if (printHeaders && !onAnswerDelta && !onReasoningDelta) {
      if (!printedAnything) {
        console.log("========================================");
        console.log(`Model: ${model}`);
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
    else if (!onAnswerDelta) process.stdout.write(delta);
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

  try {
    const body: any = { 
      model, 
      messages: [{ role: "user", content: prompt }], 
      stream: true 
    };

    // Add reasoning effort if specified
    if (effort && effort !== ReasoningEffort.Off) {
      body.reasoning_effort = effort;
    }

    const stream = await client.chat.completions.create(body);
    for await (const event of stream as any) {
      if (debugEvents) console.log("RAW_STREAM:", JSON.stringify(event));
      
      // Handle reasoning content if available
      if (event.choices?.[0]?.delta?.reasoning) {
        writeReasoningDelta(event.choices[0].delta.reasoning);
      }
      
      const delta = event.choices?.[0]?.delta?.content ?? "";
      if (delta) {
        writeAnswerDelta(delta);
      }
    }

    // Get usage information with a separate non-streaming call
    try {
      const usageBody: any = { 
        model, 
        messages: [{ role: "user", content: prompt }], 
        stream: false, 
        max_tokens: 1 
      };
      
      if (effort && effort !== ReasoningEffort.Off) {
        usageBody.reasoning_effort = effort;
      }
      
      const completion = await client.chat.completions.create(usageBody);
      final = completion;
      inputTokens = (completion.usage as any)?.prompt_tokens;
      outputTokens = (completion.usage as any)?.completion_tokens;
      totalTokens = (completion.usage as any)?.total_tokens;
    } catch (e) {
      // Usage information might not be available, continue normally
    }

    const ms = Date.now() - startedAt;
    if (!onReasoningDelta && !onAnswerDelta) {
      console.log("\n=== USAGE SUMMARY ===");
      console.log(`Time: ${ms} ms`);
      console.log(`Model: ${model}`);
      if (typeof inputTokens === "number") console.log(`Input tokens: ${inputTokens}`);
      if (typeof outputTokens === "number") console.log(`Output tokens: ${outputTokens}`);
      if (typeof reasoningTokens === "number") console.log(`Reasoning tokens: ${reasoningTokens}`);
      if (typeof totalTokens === "number") console.log(`Total tokens: ${totalTokens}`);
    }

    if (printedReasoningHeader && !onReasoningDelta && !onAnswerDelta) process.stdout.write("\n");
    if (printedAnswerHeader && !onAnswerDelta) process.stdout.write("\n");
    
    return { 
      finalAnswer, 
      thinking,
      usage: { 
        model,
        ms,
        inputTokens,
        outputTokens,
        reasoningTokens,
        totalTokens
      }, 
      raw: final 
    };

  } catch (error) {
    console.error("xAI reasoning stream error:", error);
    throw error;
  }
}