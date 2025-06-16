import { Provider, Model } from "./Interfaces";

type RawModel = Record<string, any>;

async function fetchJSON(
  url: string,
  headers: Record<string, string> = {}
): Promise<any> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} => ${res.status} ${res.statusText}`);
  return res.json();
}

function mapToModel(item: RawModel, idx: number): Model {
  const name = item.id || item.name || `model_${idx}`;
  const maxTokens =
    item.context_window ||
    item.max_input_tokens ||
    item.maxTokens ||
    item.max_output_tokens ||
    undefined;

  return {
    id: `${name}_${idx}`,
    name,
    temperature: 0,
    max_tokens: maxTokens,
    featured: false,
    input_cpm: undefined,
    output_cpm: undefined,
  };
}

async function fetchModelsForProvider(provider: Provider): Promise<Model[]> {
  const key = provider.apiKey || "";
  const authHeader = key ? { Authorization: `Bearer ${key}` } : {};

  try {
    switch (provider.name) {
      case "OpenAI": {
        const data = await fetchJSON(
          `${provider.apiEndpoint}models`,
          authHeader as Record<string, string>
        );
        return (data.data || []).map(mapToModel);
      }
      case "Anthropic": {
        const data = await fetchJSON("https://api.anthropic.com/v1/models", {
          "x-api-key": key,
          "anthropic-version": "2023-06-01"
        });
        return (data.data || []).map(mapToModel);
      }
      case "Google": {
        const data = await fetchJSON(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`
        );
        return (data.models || []).map(mapToModel);
      }
      case "X AI":
      case "Mistral":
      case "OpenRouter":
      case "Groq":
      case "SambaNova":
      case "Cerebras":
      case "Deepseek": {
        const data = await fetchJSON(
          `${provider.apiEndpoint}models`,
          authHeader as Record<string, string>
        );
        return (data.data || data.models || []).map(mapToModel);
      }
      default:
        return provider.models || [];
    }
  } catch (e) {
    console.warn(`Failed to fetch models for ${provider.name}:`, e);
    return provider.models || [];
  }
}

export async function refreshProviderModels(
  providers: Provider[]
): Promise<Provider[]> {
  return Promise.all(
    providers.map(async (p) => ({
      ...p,
      models: await fetchModelsForProvider(p),
    }))
  );
}
