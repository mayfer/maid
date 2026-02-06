import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";

const LEGACY_CACHE_FILE = "/tmp/muchat_last_model.txt";
const LEGACY_CACHE_SELECTION_FILE = "/tmp/muchat_last_model_selection.json";
const LEGACY_CUSTOM_ENDPOINT_CACHE_FILE = "/tmp/muchat_custom_endpoint.txt";

export const DEFAULT_CUSTOM_ENDPOINT = "http://127.0.0.1:1234";

const CONFIG_DIR = path.join(homedir(), ".config");
const CONFIG_FILE = path.join(CONFIG_DIR, "maid.json");

export interface CachedModelSelection {
  modelId: string;
  provider: "openrouter" | "openai";
  baseUrl?: string;
}

export interface MaidConfig {
  modelSelection?: CachedModelSelection;
  systemPrompt?: string;
  providers?: {
    openrouter?: {
      apiKey?: string;
    };
    custom?: {
      endpoint?: string;
      apiKey?: string;
    };
  };
  // Legacy compatibility for existing providers code.
  openrouterApiKey?: string;
  customEndpoint?: string;
}

export function normalizeCustomEndpointToApiBase(endpoint: string): string {
  const raw = endpoint.trim() || DEFAULT_CUSTOM_ENDPOINT;
  const prefixed = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  const url = new URL(prefixed);

  const cleanPath = url.pathname.replace(/\/+$/, "");
  if (!cleanPath || cleanPath === "/") {
    url.pathname = "/v1";
  } else if (!/\/v1$/i.test(cleanPath)) {
    url.pathname = `${cleanPath}/v1`;
  } else {
    url.pathname = cleanPath;
  }

  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function ensureConfigDir(): void {
  if (existsSync(CONFIG_DIR)) return;
  mkdirSync(CONFIG_DIR, { recursive: true });
}

function normalizeConfig(parsed: any): MaidConfig {
  const modelSelection = parsed?.modelSelection && typeof parsed.modelSelection === "object"
    ? {
        modelId: typeof parsed.modelSelection.modelId === "string" ? parsed.modelSelection.modelId.trim() : "",
        provider: parsed.modelSelection.provider === "openai" ? "openai" : "openrouter",
        baseUrl: typeof parsed.modelSelection.baseUrl === "string" ? parsed.modelSelection.baseUrl.trim() : undefined,
      }
    : undefined;

  const nestedOpenRouterKey = typeof parsed?.providers?.openrouter?.apiKey === "string"
    ? parsed.providers.openrouter.apiKey.trim()
    : "";
  const legacyOpenRouterKey = typeof parsed?.openrouterApiKey === "string"
    ? parsed.openrouterApiKey.trim()
    : "";

  const nestedCustomEndpoint = typeof parsed?.providers?.custom?.endpoint === "string"
    ? parsed.providers.custom.endpoint.trim()
    : "";
  const legacyCustomEndpoint = typeof parsed?.customEndpoint === "string"
    ? parsed.customEndpoint.trim()
    : "";
  const nestedCustomApiKey = typeof parsed?.providers?.custom?.apiKey === "string"
    ? parsed.providers.custom.apiKey.trim()
    : "";

  const openrouterApiKey = nestedOpenRouterKey || legacyOpenRouterKey;
  const customEndpoint = nestedCustomEndpoint || legacyCustomEndpoint;
  const systemPrompt = typeof parsed?.systemPrompt === "string" && parsed.systemPrompt.trim().length > 0
    ? parsed.systemPrompt
    : undefined;

  return {
    modelSelection: modelSelection?.modelId ? modelSelection : undefined,
    systemPrompt,
    providers: {
      openrouter: {
        apiKey: openrouterApiKey || undefined,
      },
      custom: {
        endpoint: customEndpoint || undefined,
        apiKey: nestedCustomApiKey || undefined,
      },
    },
    openrouterApiKey: openrouterApiKey || undefined,
    customEndpoint: customEndpoint || undefined,
  };
}

export function readConfig(): MaidConfig {
  try {
    if (!existsSync(CONFIG_FILE)) return normalizeConfig({});
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    const parsed: any = JSON.parse(raw);
    return normalizeConfig(parsed);
  } catch {
    return normalizeConfig({});
  }
}

export function writeConfig(config: MaidConfig): void {
  ensureConfigDir();

  const systemPrompt = config.systemPrompt?.trim() ? config.systemPrompt : undefined;
  const openrouterApiKey = config.providers?.openrouter?.apiKey?.trim() || config.openrouterApiKey?.trim() || undefined;
  const customEndpoint = config.providers?.custom?.endpoint?.trim() || config.customEndpoint?.trim() || undefined;
  const customApiKey = config.providers?.custom?.apiKey?.trim() || undefined;

  const cleanConfig: MaidConfig = {
    modelSelection: config.modelSelection?.modelId ? config.modelSelection : undefined,
    systemPrompt,
    providers: {
      openrouter: {
        apiKey: openrouterApiKey,
      },
      custom: {
        endpoint: customEndpoint,
        apiKey: customApiKey,
      },
    },
    // Keep legacy top-level keys for backward compatibility.
    openrouterApiKey,
    customEndpoint,
  };

  writeFileSync(CONFIG_FILE, `${JSON.stringify(cleanConfig, null, 2)}\n`);
}

export function updateConfig(updater: (current: MaidConfig) => MaidConfig): void {
  const current = readConfig();
  const next = updater(current);
  writeConfig(next);
}

export function getCachedModelSelection(): CachedModelSelection | undefined {
  const configSelection = readConfig().modelSelection;
  if (configSelection?.modelId) {
    return configSelection;
  }

  try {
    if (existsSync(LEGACY_CACHE_SELECTION_FILE)) {
      const raw = readFileSync(LEGACY_CACHE_SELECTION_FILE, "utf-8");
      const parsed: any = JSON.parse(raw);
      const modelId = typeof parsed?.modelId === "string" ? parsed.modelId.trim() : "";
      const provider = parsed?.provider === "openai" ? "openai" : "openrouter";
      const baseUrl = typeof parsed?.baseUrl === "string" ? parsed.baseUrl.trim() : undefined;
      if (modelId) {
        const legacySelection = { modelId, provider, baseUrl };
        updateConfig((current) => ({ ...current, modelSelection: legacySelection }));
        return legacySelection;
      }
    }
  } catch {}

  try {
    if (existsSync(LEGACY_CACHE_FILE)) {
      const modelId = readFileSync(LEGACY_CACHE_FILE, "utf-8").trim();
      if (modelId.length > 0) {
        const legacySelection = { modelId, provider: "openrouter" as const };
        updateConfig((current) => ({ ...current, modelSelection: legacySelection }));
        return legacySelection;
      }
    }
  } catch {}

  return undefined;
}

export function setCachedModelSelection(selection: CachedModelSelection): void {
  try {
    updateConfig((current) => ({ ...current, modelSelection: selection }));
  } catch {}
}

export function getConfiguredOpenRouterApiKey(): string | undefined {
  const apiKey = readConfig().providers?.openrouter?.apiKey;
  return apiKey && apiKey.length > 0 ? apiKey : undefined;
}

export function getConfiguredSystemPrompt(): string | undefined {
  const systemPrompt = readConfig().systemPrompt;
  return systemPrompt && systemPrompt.trim().length > 0 ? systemPrompt : undefined;
}

export function setConfiguredSystemPrompt(systemPrompt?: string): void {
  const value = systemPrompt?.trim() ? systemPrompt : undefined;
  updateConfig((current) => ({
    ...current,
    systemPrompt: value,
  }));
}

export function setConfiguredOpenRouterApiKey(apiKey: string): void {
  updateConfig((current) => ({
    ...current,
    providers: {
      ...current.providers,
      openrouter: { apiKey },
    },
    openrouterApiKey: apiKey,
  }));
}

export function getCustomProviderConfig(): { endpoint: string; apiKey?: string } {
  const cfg = readConfig();
  const endpoint = cfg.providers?.custom?.endpoint || readLegacyCustomEndpoint() || normalizeCustomEndpointToApiBase(DEFAULT_CUSTOM_ENDPOINT);
  const apiKey = cfg.providers?.custom?.apiKey;
  if (!cfg.providers?.custom?.endpoint && endpoint) {
    setCustomProviderConfig({ endpoint, apiKey });
  }
  return { endpoint, apiKey: apiKey || undefined };
}

function readLegacyCustomEndpoint(): string | undefined {
  try {
    if (!existsSync(LEGACY_CUSTOM_ENDPOINT_CACHE_FILE)) return undefined;
    const value = readFileSync(LEGACY_CUSTOM_ENDPOINT_CACHE_FILE, "utf-8").trim();
    return value.length > 0 ? normalizeCustomEndpointToApiBase(value) : undefined;
  } catch {
    return undefined;
  }
}

export function setCustomProviderConfig(next: { endpoint?: string; apiKey?: string }): void {
  updateConfig((current) => {
    const endpoint = next.endpoint?.trim() || current.providers?.custom?.endpoint || normalizeCustomEndpointToApiBase(DEFAULT_CUSTOM_ENDPOINT);
    const apiKey = next.apiKey !== undefined ? next.apiKey.trim() : current.providers?.custom?.apiKey;

    return {
      ...current,
      providers: {
        ...current.providers,
        custom: {
          endpoint,
          apiKey: apiKey || undefined,
        },
      },
      customEndpoint: endpoint,
    };
  });
}

export function endpointPromptDefaultFromApiBase(baseUrl: string): string {
  return baseUrl.replace(/\/v1$/i, "");
}
