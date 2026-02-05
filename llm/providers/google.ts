import { GoogleGenAI } from "@google/genai";
import { ReasoningStreamOptions, ReasoningEffort, StandardizedModel } from "../index";

function getClient(apiKeyOverride?: string) {
  const apiKey = apiKeyOverride || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("Missing GOOGLE_API_KEY");
  return new GoogleGenAI({ apiKey });
}

export async function fetchModels(apiKeyOverride?: string): Promise<StandardizedModel[]> {
  const genai = getClient(apiKeyOverride);
  try {
    const response = await genai.models.list();
    // console.log("Google models response type:", typeof response);
    // console.log("Google models response keys:", Object.keys(response || {}));

    // Handle Pager<Model> response from Google GenAI
    const models: any[] = [];
    for await (const model of response) {
      models.push(model);
      console.log("Google model sample:", JSON.stringify(model, null, 2));
    }

    console.log("Google models fetched:", models.length, "models");

    return models.map((model: any): StandardizedModel => ({
      id: (model.name || model.id)?.replace(/^models\//, ''),
      name: model.displayName || model.name || model.id,
      provider: "google",
      // Google doesn't provide created timestamp in the same format
      // created: model.created ? new Date(model.created).getTime() / 1000 : undefined,
    }));
  } catch (error) {
    console.error("Error fetching Google models:", error);
    throw error;
  }
}

function shouldIncludeThoughts(effort?: ReasoningEffort): boolean {
  return effort !== undefined && effort !== ReasoningEffort.Off;
}

export async function reasoningStream(opts: ReasoningStreamOptions) {
  const { prompt, model, effort, printHeaders = true, debugEvents = false, onReasoningDelta, onAnswerDelta } = opts;
  const genai = getClient(opts.apiKey);

  let finalAnswer = "";
  let thinking = "";
  let printedAnything = false;
  let printedAnswerHeader = false;
  let printedReasoningHeader = false;

  function printHeaderOnce(title: string) {
    if (printHeaders && !onAnswerDelta && !onReasoningDelta) {
      if (!printedAnything) {
        console.log("========================================");
        console.log(`Model: ${model}${effort ? `  |  Effort: ${effort}` : ""}`);
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
      if (printedReasoningHeader && !onReasoningDelta && !onAnswerDelta) process.stdout.write("\n\n");
      printHeaderOnce("ANSWER");
      printedAnswerHeader = true;
    }
    finalAnswer += delta;
    if (onAnswerDelta) onAnswerDelta(delta);
    else process.stdout.write(delta);
  }

  const includeThoughts = shouldIncludeThoughts(effort);
  const streamConfig: any = {
    model,
    contents: prompt
  };
  
  if (includeThoughts) {
    streamConfig.config = {
      thinkingConfig: {
        includeThoughts: true
      }
    };
  }

  const stream = await genai.models.generateContentStream(streamConfig);
  for await (const event of stream) {
    if (debugEvents) console.log("RAW_STREAM:", JSON.stringify(event));
    
    const parts = (event as any).candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (!part.text) {
          continue;
        } else if (part.thought) {
          // This is thinking content
          thinking += part.text;
          writeReasoningDelta(part.text);
        } else {
          // This is regular answer content
          finalAnswer += part.text;
          writeAnswerDelta(part.text);
        }
      }
    } else {
      // Fallback for non-parts structure
      const text = (event as any).text || "";
      if (text) {
        finalAnswer += text;
        writeAnswerDelta(text);
      }
    }
  }
  if (printedReasoningHeader && !onReasoningDelta && !onAnswerDelta) process.stdout.write("\n");
  if (printedAnswerHeader && !onAnswerDelta) process.stdout.write("\n");
  return { finalAnswer, thinking, usage: { model }, raw: null } as any;
}