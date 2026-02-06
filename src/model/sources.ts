import { fetchModelsWithRanking } from "../../llm/index";
import type { StandardizedModel } from "../../llm/index";

const OPENROUTER_NEWEST_MODELS_URL = "https://openrouter.ai/api/frontend/models/find?order=newest";
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";

export async function fetchPopularOpenRouterModels(apiKey?: string): Promise<StandardizedModel[]> {
  const { rankings } = await fetchModelsWithRanking("openrouter", apiKey);
  return rankings.map((r: any) => r.model as StandardizedModel);
}

export async function validateOpenRouterApiKey(apiKey: string): Promise<{
  label?: string;
  isFreeTier?: boolean;
  limitRemaining?: number | null;
}> {
  const response = await fetch(OPENROUTER_KEY_URL, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenRouter auth failed (${response.status})${body ? `: ${body}` : ""}`);
  }

  const payload: any = await response.json();
  const data = payload?.data;
  if (!data || typeof data !== "object") {
    throw new Error("OpenRouter key check returned an unexpected response.");
  }

  return {
    label: typeof data.label === "string" ? data.label : undefined,
    isFreeTier: typeof data.is_free_tier === "boolean" ? data.is_free_tier : undefined,
    limitRemaining: typeof data.limit_remaining === "number" ? data.limit_remaining : data.limit_remaining ?? undefined,
  };
}

export async function fetchNewestOpenRouterModels(apiKey?: string, signal?: AbortSignal): Promise<StandardizedModel[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const referer = process.env.OPENROUTER_REFERRER || process.env.OPENROUTER_SITE_URL || process.env.SITE_URL;
  const title = process.env.OPENROUTER_TITLE || process.env.OPENROUTER_APP_TITLE || process.env.APP_TITLE;
  if (referer) headers["HTTP-Referer"] = referer;
  if (title) headers["X-Title"] = title;
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(OPENROUTER_NEWEST_MODELS_URL, { headers, signal });
  if (!response.ok) {
    throw new Error(`OpenRouter newest models request failed (${response.status})`);
  }

  const payload: any = await response.json();
  const rawModels = Array.isArray(payload?.data?.models)
    ? payload.data.models
    : Array.isArray(payload?.models)
      ? payload.models
      : [];

  const seen = new Set<string>();
  const models: StandardizedModel[] = [];
  for (const raw of rawModels) {
    const baseId = raw?.slug || raw?.permaslug || raw?.canonical_slug || raw?.id || raw?.endpoint?.model;
    if (!baseId) continue;
    const isFreeVariant = typeof raw?.name === "string" && /\(free\)/i.test(raw.name);
    const id = isFreeVariant && !baseId.endsWith(":free") ? `${baseId}:free` : baseId;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: raw?.name || raw?.canonical_slug || id,
      provider: "openrouter",
      context_length: raw?.context_length,
      created: typeof raw?.created_at === "number" ? raw.created_at : undefined,
    });
  }

  return models;
}

export async function fetchCustomEndpointModels(baseUrl: string, apiKey?: string, signal?: AbortSignal): Promise<string[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(`${baseUrl}/models`, { headers, signal });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${response.status} ${response.statusText}${body ? `: ${body}` : ""}`);
  }

  const payload: any = await response.json();
  const rawModels = Array.isArray(payload?.models)
    ? payload.models
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.data?.models)
        ? payload.data.models
        : [];

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of rawModels) {
    const id = typeof item === "string" ? item : (item?.id || item?.name);
    if (!id || typeof id !== "string") continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
