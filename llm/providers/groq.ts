import Groq from "groq-sdk";
import { ReasoningStreamOptions, ReasoningEffort, StandardizedModel } from "../index";

function getClient(apiKeyOverride?: string) {
  const apiKey = apiKeyOverride || process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("Missing GROQ_API_KEY");
  return new Groq({ apiKey });
}

export async function fetchModels(apiKeyOverride?: string): Promise<StandardizedModel[]> {
  const client = getClient(apiKeyOverride);
  try {
    const response = await client.models.list();
    // console.log("Groq models response:", JSON.stringify(response, null, 2));

    return response.data.map((model: any): StandardizedModel => ({
      id: model.id,
      name: model.id, // Groq doesn't provide display names
      provider: "groq",
      created: model.created,
      owned_by: model.owned_by,
      object: model.object,
      active: model.active,
      context_window: model.context_window,
      max_completion_tokens: model.max_completion_tokens,
    }));
  } catch (error) {
    console.error("Error fetching Groq models:", error);
    throw error;
  }
}

// Check if model supports reasoning (DeepSeek-R1 and GPT-OSS models)
function isReasoningModel(model?: string): boolean {
  return model?.includes('deepseek-r1') || model?.includes('gpt-oss') || false;
}

export async function reasoningStream(opts: ReasoningStreamOptions) {
  const { prompt, model, printHeaders = true, debugEvents = false, onReasoningDelta, onAnswerDelta, effort = ReasoningEffort.Medium } = opts;
  const client = getClient(opts.apiKey);

  let finalAnswer = "";
  let thinking = "";
  const startedAt = Date.now();
  let printedAnything = false;
  let printedReasoningHeader = false;
  let printedAnswerHeader = false;

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

  // Add reasoning parameters for reasoning models
  if (isReasoningModel(model) && effort && effort !== ReasoningEffort.Off) {
    requestParams.reasoning_effort = effort;
    requestParams.reasoning_format = "parsed"; // Ask for parsed reasoning to make streaming unambiguous
  }

  const stream = await client.chat.completions.create(requestParams) as unknown as AsyncIterable<any>;
  
  for await (const chunk of stream) {
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
  
  if (printedReasoningHeader && (!onAnswerDelta && !onReasoningDelta)) process.stdout.write("\n");
  if (printedAnswerHeader && !onAnswerDelta) process.stdout.write("\n");
  
  return { 
    finalAnswer, 
    thinking, 
    usage: { model, ms: Date.now() - startedAt }, 
    raw: null 
  } as any;
}