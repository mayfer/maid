import type { Provider, StandardizedModel } from './index';

// Minimal shape that works for both v1 and frontend endpoints
export interface OpenRouterModel {
  id?: string; // v1: "provider/model"
  slug?: string; // frontend: "provider/model"
  permaslug?: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: number; completion?: number };
}

export interface ModelRanking {
  model: StandardizedModel;
  score: number;
  rank: number;
  reasoning: string[];
}

// Simple 5-min cache
let cached: OpenRouterModel[] | null = null;
let cachedAt = 0;
const TTL = 5 * 60 * 1000;

async function fetchOpenRouterModels(): Promise<OpenRouterModel[]> {
  const now = Date.now();
  if (cached && now - cachedAt < TTL) return cached;

  // Prefer frontend endpoint for ordering and metadata; fallback to v1
  const tryUrls = [
    'https://openrouter.ai/api/frontend/models/find?fmt=table&order=most-popular',
    'https://openrouter.ai/api/v1/models'
  ];

  for (const url of tryUrls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const payload = await res.json();
      // Handle both formats: {data: [...]} (v1) and {data: {models: [...]}} (frontend)
      const rawData = payload?.data;
      const data: any[] = Array.isArray(rawData) ? rawData : (Array.isArray(rawData?.models) ? rawData.models : [])
      if (data.length === 0) continue;

      // Normalize to a minimal shape with a canonical slug
      const normalized = data.map((m: any) => {
        const slug = m.slug || m.id || m.permaslug || '';
        return {
          id: m.id ?? slug,
          slug,
          permaslug: m.permaslug ?? slug,
          name: m.name ?? slug,
          context_length: m.context_length,
          pricing: m.pricing ? { prompt: m.pricing.prompt, completion: m.pricing.completion } : undefined,
        } as OpenRouterModel;
      });

      cached = normalized;
      cachedAt = now;
      return normalized;
    } catch {}
  }
  return [];
}

function guessSlugs(model: StandardizedModel): string[] {
  const id = (model.id || '').toLowerCase();
  const provider = (model.provider || '').toLowerCase();
  const variants = new Set<string>([id]);
  if (provider && !id.includes('/')) variants.add(`${provider}/${id}`);
  return Array.from(variants);
}

function enrichFromOpenRouter(model: StandardizedModel, or: OpenRouterModel | undefined): StandardizedModel {
  if (!or) return model;
  return {
    ...model,
    name: or.name || model.name,
    permaslug: or.permaslug || model.permaslug,
    context_length: or.context_length ?? model.context_length,
    pricing: or.pricing ? { ...model.pricing, ...or.pricing } : model.pricing,
  };
}

export async function rankModels(models: StandardizedModel[]): Promise<ModelRanking[]> {
  const orModels = await fetchOpenRouterModels();
  const index = new Map<string, number>();
  orModels.forEach((m, i) => {
    if (m.slug) index.set(m.slug.toLowerCase(), i);
    if (m.permaslug) index.set(String(m.permaslug).toLowerCase(), i);
  });

  const ranked: ModelRanking[] = models.map((m) => {
    const keys = guessSlugs(m);
    let pos: number | undefined;
    for (const k of keys) { if (index.has(k)) { pos = index.get(k); break; } }
    const score = typeof pos === 'number' ? 1_000_000 - pos : -Infinity;
    const matched = typeof pos === 'number' ? orModels[pos] : undefined;
    const enriched = enrichFromOpenRouter(m, matched);
    return {
      model: enriched,
      score,
      rank: 0,
      reasoning: [typeof pos === 'number' ? `OpenRouter index ${pos}` : 'Not found on OpenRouter'],
    };
  });

  ranked.sort((a, b) => (a.score === b.score) ? 0 : (a.score === -Infinity ? 1 : (b.score === -Infinity ? -1 : b.score - a.score)));
  ranked.forEach((r, i) => { r.rank = i + 1; });
  return ranked;
}

export async function processOpenRouterModels(orModels: OpenRouterModel[]): Promise<ModelRanking[]> {
  const models: StandardizedModel[] = orModels.map((m) => {
    const slug = m.slug || m.id || '';
    const [provider] = String(slug).split('/');
    return { id: slug, name: m.name || slug, provider: (provider as Provider) };
  });
  // Position in the input array defines the score
  const rankings = models.map((model, i) => ({
    model,
    score: 1_000_000 - i,
    rank: i + 1,
    reasoning: [`OpenRouter index ${i}`],
  }));
  return rankings;
}

export function getTopModels(rankings: ModelRanking[], n: number = 10): StandardizedModel[] {
  return rankings.slice(0, n).map(r => r.model);
}

export function filterModelsByProvider(rankings: ModelRanking[], provider: Provider): ModelRanking[] {
  return rankings.filter(r => r.model.provider === provider);
}

export async function sortModelsByProvider(models: StandardizedModel[], provider: Provider): Promise<StandardizedModel[]> {
  const within = models.filter(m => m.provider === provider);
  const ranked = await rankModels(within);
  return ranked.map(r => r.model);
}

export function getModelRanking(rankings: ModelRanking[], modelId: string): ModelRanking | undefined {
  const key = modelId.toLowerCase();
  return rankings.find(r => r.model.id.toLowerCase() === key || (r.model.permaslug?.toLowerCase?.() === key));
}

export function exampleRanking() {
  return processOpenRouterModels([
    { slug: 'openai/gpt-4o' },
    { slug: 'google/gemini-pro' },
  ]);
}
