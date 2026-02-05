import Cerebras from "@cerebras/cerebras_cloud_sdk";
import { ReasoningStreamOptions, ReasoningEffort, StandardizedModel } from "../index";

function getClient(apiKeyOverride?: string) {
  const apiKey = apiKeyOverride || process.env.CEREBRAS_API_KEY;
  if (!apiKey) throw new Error("Missing CEREBRAS_API_KEY");
  return new Cerebras({ apiKey });
}

export async function fetchModels(apiKeyOverride?: string): Promise<StandardizedModel[]> {
  const client = getClient(apiKeyOverride);
  try {
    const response = await client.models.list();
    // console.log("Cerebras models response:", JSON.stringify(response, null, 2));

    return response.data.map((model: any): StandardizedModel => ({
      id: model.id,
      name: model.id, // Cerebras doesn't provide display names
      provider: "cerebras",
      created: model.created,
      owned_by: model.owned_by,
      object: model.object,
    }));
  } catch (error) {
    console.error("Error fetching Cerebras models:", error);
    throw error;
  }
}

export async function reasoningStream(opts: ReasoningStreamOptions) {
  const { prompt, model, effort, printHeaders = true, debugEvents = false, onReasoningDelta, onAnswerDelta } = opts;
  const client = getClient(opts.apiKey);

  // Ensure model is defined
  if (!model) {
    throw new Error("Model is required for Cerebras reasoning stream");
  }

  let finalAnswer = "";
  let thinking = "";
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
  const requestParams: any = {
    model,
    messages: [{ role: "user", content: prompt }],
    stream: true,
  };

  // Add reasoning effort only if the model supports it.
  // Cerebras does not universally support reasoning controls; gate by OpenRouter metadata when available.
  try {
    // Attempt to use OpenRouter metadata if this is an OpenRouter-routed Cerebras model id
    // or if we have a model with known supported parameters.
    // Since Cerebras SDK doesn't surface supported params, we conservatively disable unless known.
    const allowReasoning = false; // default off unless we later add a shared registry
    if (allowReasoning && effort && effort !== ReasoningEffort.Off) {
      requestParams.reasoning_effort = effort;
    }
  } catch {}

  const stream = await client.chat.completions.create(requestParams);

  for await (const chunk of stream as any) {
    if (debugEvents) console.log("RAW_STREAM:", JSON.stringify(chunk));
    
    const choice = chunk.choices?.[0];
    if (!choice) continue;

    // Handle reasoning content (thinking)
    if (choice.delta?.reasoning) {
      writeReasoningDelta(choice.delta.reasoning);
    }
    
    // Handle main content (answer)
    const contentDelta = choice.delta?.content;
    if (contentDelta) {
      writeAnswerDelta(contentDelta);
    }
  }
  
  if (printedReasoningHeader && !onReasoningDelta && !onAnswerDelta) process.stdout.write("\n");
  if (printedAnswerHeader && !onAnswerDelta) process.stdout.write("\n");
  return { finalAnswer, thinking, usage: { model }, raw: null } as any;
}
