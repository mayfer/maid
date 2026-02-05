import { fetchModelsWithRanking, reasoningStream, getTopModels } from "./llm/index";
import type { StandardizedModel, ChatMessage } from "./llm/index";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import path from "path";

const LEGACY_CACHE_FILE = "/tmp/muchat_last_model.txt";
const LEGACY_CACHE_SELECTION_FILE = "/tmp/muchat_last_model_selection.json";
const LEGACY_CUSTOM_ENDPOINT_CACHE_FILE = "/tmp/muchat_custom_endpoint.txt";
const CONFIG_DIR = path.join(homedir(), ".config");
const CONFIG_FILE = path.join(CONFIG_DIR, "maid.json");
const OPENROUTER_NEWEST_MODELS_URL = "https://openrouter.ai/api/frontend/models/find?order=newest";
const DEFAULT_CUSTOM_ENDPOINT = "http://127.0.0.1:1234";
const MODEL_PICKER_ABORT = "__MODEL_PICKER_ABORT__";
const USER_PROMPT_LABEL = "\x1B[2m>\x1B[0m ";
const PRIMARY_TEXT = "\x1B[36m";
const RESET_TEXT = "\x1B[0m";
const ASSISTANT_DOT = `${PRIMARY_TEXT}●${RESET_TEXT} `;
const ASSISTANT_TYPING = "\x1B[2m…\x1B[0m";
const DIM_TEXT = "\x1B[2m";
const DEFAULT_CHAT_SYSTEM_PROMPT = "You are terminal assistant for quick concise answers. Provide only the answer user asked for. Do not provide additional context or instructions for anything the user did not ask for. Keep it simple and robotically unexpressivae. Avoid using markdown. Respond in raw text."

interface ModelSelection {
    modelId: string;
    provider: "openrouter" | "openai";
    baseUrl?: string;
    apiKey?: string;
    cacheable: boolean;
}

interface CachedModelSelection {
    modelId: string;
    provider: "openrouter" | "openai";
    baseUrl?: string;
}

interface MaidConfig {
    modelSelection?: CachedModelSelection;
    customEndpoint?: string;
    openrouterApiKey?: string;
}

function ensureConfigDir(): void {
    if (existsSync(CONFIG_DIR)) return;
    mkdirSync(CONFIG_DIR, { recursive: true });
}

function readConfig(): MaidConfig {
    try {
        if (!existsSync(CONFIG_FILE)) return {};
        const raw = readFileSync(CONFIG_FILE, "utf-8");
        const parsed: any = JSON.parse(raw);
        const modelSelection = parsed?.modelSelection && typeof parsed.modelSelection === "object"
            ? {
                modelId: typeof parsed.modelSelection.modelId === "string" ? parsed.modelSelection.modelId.trim() : "",
                provider: parsed.modelSelection.provider === "openai" ? "openai" : "openrouter",
                baseUrl: typeof parsed.modelSelection.baseUrl === "string" ? parsed.modelSelection.baseUrl.trim() : undefined,
            }
            : undefined;
        const customEndpoint = typeof parsed?.customEndpoint === "string" ? parsed.customEndpoint.trim() : undefined;
        const openrouterApiKey = typeof parsed?.openrouterApiKey === "string" ? parsed.openrouterApiKey.trim() : undefined;
        return {
            modelSelection: modelSelection?.modelId ? modelSelection : undefined,
            customEndpoint: customEndpoint || undefined,
            openrouterApiKey: openrouterApiKey || undefined,
        };
    } catch {
        return {};
    }
}

function writeConfig(config: MaidConfig): void {
    ensureConfigDir();
    const cleanConfig: MaidConfig = {
        modelSelection: config.modelSelection?.modelId ? config.modelSelection : undefined,
        customEndpoint: config.customEndpoint?.trim() || undefined,
        openrouterApiKey: config.openrouterApiKey?.trim() || undefined,
    };
    writeFileSync(CONFIG_FILE, `${JSON.stringify(cleanConfig, null, 2)}\n`);
}

function updateConfig(updater: (current: MaidConfig) => MaidConfig): void {
    const current = readConfig();
    const next = updater(current);
    writeConfig(next);
}

function normalizeCustomEndpointToApiBase(endpoint: string): string {
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

process.on("SIGINT", () => {
    if (process.stdout.isTTY) process.stdout.write("\n");
    process.exit(130);
});

function getCachedModelSelection(): CachedModelSelection | undefined {
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

    // Backward compatibility with older cache format.
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

function setCachedModelSelection(selection: CachedModelSelection): void {
    try {
        updateConfig((current) => ({ ...current, modelSelection: selection }));
    } catch {}
}

function getCachedCustomEndpoint(): string | undefined {
    const configEndpoint = readConfig().customEndpoint;
    if (configEndpoint) return configEndpoint;

    try {
        if (existsSync(LEGACY_CUSTOM_ENDPOINT_CACHE_FILE)) {
            const value = readFileSync(LEGACY_CUSTOM_ENDPOINT_CACHE_FILE, "utf-8").trim();
            if (value.length > 0) {
                updateConfig((current) => ({ ...current, customEndpoint: value }));
                return value;
            }
        }
    } catch {}
    return undefined;
}

function setCachedCustomEndpoint(baseUrl: string): void {
    try {
        updateConfig((current) => ({ ...current, customEndpoint: baseUrl }));
    } catch {}
}

function getConfiguredOpenRouterApiKey(): string | undefined {
    const apiKey = readConfig().openrouterApiKey;
    return apiKey && apiKey.length > 0 ? apiKey : undefined;
}

function setConfiguredOpenRouterApiKey(apiKey: string): void {
    updateConfig((current) => ({ ...current, openrouterApiKey: apiKey }));
}

function endpointPromptDefaultFromApiBase(baseUrl: string): string {
    return baseUrl.replace(/\/v1$/i, "");
}

function getDefaultSystemPrompt(): string {
    return DEFAULT_CHAT_SYSTEM_PROMPT;
}

async function ensureOpenRouterApiKeyConfigured(): Promise<void> {
    const envApiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (envApiKey) return;

    const configuredApiKey = getConfiguredOpenRouterApiKey();
    if (configuredApiKey) {
        process.env.OPENROUTER_API_KEY = configuredApiKey;
        return;
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error("Missing OPENROUTER_API_KEY. Run maid interactively once to store it in ~/.config/maid.json.");
        process.exit(1);
    }

    const entered = await promptForLine("OPENROUTER_API_KEY: ");
    const apiKey = entered?.trim();
    if (!apiKey) {
        console.error("OPENROUTER_API_KEY is required.");
        process.exit(1);
    }

    setConfiguredOpenRouterApiKey(apiKey);
    process.env.OPENROUTER_API_KEY = apiKey;
}

async function main() {
    ensureConfigDir();
    await ensureOpenRouterApiKeyConfigured();

    const args = process.argv.slice(2);
    const firstArg = args[0];

    if (firstArg === "help" || firstArg === "-h" || firstArg === "--help") {
        printHelp();
        return;
    }

    // No subcommands; default to chat behavior.
    if (!firstArg) {
        if (process.stdin.isTTY && process.stdout.isTTY) {
            await chat([]);
        } else {
            printHelp();
        }
        return;
    }

    await chat(args);
}

function printHelp() {
    console.log(`
Usage:
  maid [prompt...] [options]
  bun maid.ts [prompt...] [options]

Options:
  --model <model_id>  (alias: --models, -m)
  --model             (show model picker to select new model)
  --models            (alias for --model)
  -m                  (alias for --model)
  --web               (enable web search)
  --reasoning <level> (off, low, medium, high; default: low; off is treated as low)
  --system <prompt|file>  (alias: -s; system prompt as string or path to file)
                     (default file: prompts/default-system.txt)

In interactive mode, chat continues until you type 'exit' or Ctrl+C.
Conversation history is maintained throughout the session.

Examples:
  maid                                 # Start interactive chat
  maid hi how are you                  # Unquoted args are joined as one prompt
  maid "explain this" --web            # Use web search
  maid solve this --reasoning low      # Enable light reasoning
  maid hello --system "You are a pirate"  # String system prompt
  maid hello -s ./prompt.txt          # System prompt from file
`);
}

async function promptForLine(label: string): Promise<string | undefined> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
    const stdin = process.stdin;
    const stdout = process.stdout;
    const wasRaw = Boolean((stdin as any).isRaw);
    let value = "";
    let inBracketedPaste = false;

    // Best-effort modified-enter detection (terminal dependent).
    const isLiteralNewlineKey = (key: string) =>
        key === "\u001b\r" || // Alt+Enter in some terminals
        key === "\u001b[13;2u" || // Shift+Enter (CSI u)
        key === "\u001b[13;9u"; // Cmd+Enter (CSI u in some terminals)

    // Ensure render stays correct for multiline input and deletions.
    const clearAndRender = () => {
        stdout.write("\r\x1B[J");
        stdout.write(label + value);
    };

    stdout.write(label);

    return await new Promise<string | undefined>((resolve) => {
        const finish = (result: string | undefined) => {
            stdin.removeListener("data", onData);
            if (!wasRaw) {
                stdin.setRawMode(false);
                stdin.pause();
            }
            resolve(result);
        };

        const onData = (chunk: string) => {
            // Bracketed paste wrapper.
            if (chunk.includes("\u001b[200~")) {
                inBracketedPaste = true;
                chunk = chunk.replace(/\u001b\[200~/g, "");
            }
            if (chunk.includes("\u001b[201~")) {
                inBracketedPaste = false;
                chunk = chunk.replace(/\u001b\[201~/g, "");
            }

            if (chunk === "\u0003") { // Ctrl+C
                stdout.write("\n");
                process.exit(130);
            }

            // Enter submits unless explicitly modified-enter for literal newline.
            if (!inBracketedPaste && (chunk === "\r" || chunk === "\n")) {
                stdout.write("\n");
                const trimmed = value.trim();
                finish(trimmed.length > 0 ? value : undefined);
                return;
            }

            if (!inBracketedPaste && isLiteralNewlineKey(chunk)) {
                value += "\n";
                clearAndRender();
                return;
            }

            // Backspace
            if (!inBracketedPaste && (chunk === "\x7f" || chunk === "\b")) {
                if (value.length > 0) {
                    value = value.slice(0, -1);
                    clearAndRender();
                }
                return;
            }

            // Ignore standalone escape (avoid polluting input).
            if (!inBracketedPaste && chunk === "\u001b") {
                return;
            }

            // Ignore most ANSI cursor keys while typing.
            if (!inBracketedPaste && /^\u001b\[[0-9;]*[A-Za-z]$/.test(chunk)) {
                return;
            }

            // Normalize CR-based newlines from paste so multiline content renders correctly.
            const normalized = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
            value += normalized;
            stdout.write(normalized);
        };

        if (!wasRaw) {
            stdin.setRawMode(true);
            stdin.resume();
            stdin.setEncoding("utf8");
        }
        stdin.on("data", onData);
    });
}

async function promptForModelFromTop(rankings: any[], pageSize: number = 10): Promise<ModelSelection | string | undefined> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;

    const stdin = process.stdin;
    const stdout = process.stdout;

    const popularModels = rankings.map((r: any) => r.model as StandardizedModel);
    let newestModels: StandardizedModel[] | undefined;
    let customModels: StandardizedModel[] | undefined;
    let activeList: "popular" | "newest" | "custom" = "popular";
    let shown = Math.min(pageSize, popularModels.length);
    let filter = "";
    let selectedIndex = 0;
    let canRender = true;

    let customBaseUrl = getCachedCustomEndpoint() || normalizeCustomEndpointToApiBase(DEFAULT_CUSTOM_ENDPOINT);
    let customApiKey: string | undefined;

    let loadingNewest = false;
    let newestLoadError: string | undefined;
    let newestFetchController: AbortController | undefined;
    let newestFetchSeq = 0;

    let loadingCustom = false;
    let customLoadError: string | undefined;
    let customFetchController: AbortController | undefined;
    let customFetchSeq = 0;

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    async function fetchNewestOpenRouterModels(signal?: AbortSignal): Promise<StandardizedModel[]> {
        const headers: Record<string, string> = { Accept: "application/json" };
        const referer = process.env.OPENROUTER_REFERRER || process.env.OPENROUTER_SITE_URL || process.env.SITE_URL;
        const title = process.env.OPENROUTER_TITLE || process.env.OPENROUTER_APP_TITLE || process.env.APP_TITLE;
        if (referer) headers["HTTP-Referer"] = referer;
        if (title) headers["X-Title"] = title;

        const response = await fetch(OPENROUTER_NEWEST_MODELS_URL, { headers, signal });
        if (!response.ok) throw new Error(`OpenRouter newest models request failed (${response.status})`);

        const payload: any = await response.json();
        const rawModels = Array.isArray(payload?.data?.models) ? payload.data.models : (Array.isArray(payload?.models) ? payload.models : []);
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

    async function fetchCustomModels(baseUrl: string, apiKey?: string, signal?: AbortSignal): Promise<StandardizedModel[]> {
        const ids = await fetchCustomEndpointModels(baseUrl, apiKey, signal);
        return ids.map((id) => ({ id, name: id, provider: "openai" as const }));
    }

    function getBaseModels(): StandardizedModel[] {
        if (activeList === "popular") return popularModels;
        if (activeList === "newest") return newestModels || [];
        return customModels || [];
    }

    function getMatchingModels(): StandardizedModel[] {
        const all = getBaseModels();
        if (!filter) return all;
        const q = filter.toLowerCase();
        return all.filter((m) => (m.name || m.id).toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
    }

    function getFilteredModels(): StandardizedModel[] {
        return getMatchingModels().slice(0, shown);
    }

    function cancelNewestLoad() {
        newestFetchSeq++;
        if (newestFetchController) newestFetchController.abort();
        newestFetchController = undefined;
        loadingNewest = false;
    }

    function cancelCustomLoad() {
        customFetchSeq++;
        if (customFetchController) customFetchController.abort();
        customFetchController = undefined;
        loadingCustom = false;
    }

    function startNewestLoad() {
        if (newestModels || loadingNewest) return;
        const seq = ++newestFetchSeq;
        const controller = new AbortController();
        newestFetchController = controller;
        loadingNewest = true;
        newestLoadError = undefined;
        render();

        fetchNewestOpenRouterModels(controller.signal)
            .then((models) => {
                if (seq !== newestFetchSeq) return;
                newestModels = models;
            })
            .catch((error) => {
                if (seq !== newestFetchSeq) return;
                if (error instanceof Error && error.name === "AbortError") return;
                newestModels = [];
                newestLoadError = error instanceof Error ? error.message : String(error);
            })
            .finally(() => {
                if (seq !== newestFetchSeq) return;
                newestFetchController = undefined;
                loadingNewest = false;
                if (activeList === "newest") {
                    shown = Math.min(pageSize, getBaseModels().length);
                    selectedIndex = 0;
                    render();
                }
            });
    }

    function startCustomLoad() {
        if (loadingCustom) return;
        const seq = ++customFetchSeq;
        const controller = new AbortController();
        customFetchController = controller;
        loadingCustom = true;
        customLoadError = undefined;
        customModels = undefined;
        render();

        fetchCustomModels(customBaseUrl, customApiKey, controller.signal)
            .then((models) => {
                if (seq !== customFetchSeq) return;
                customModels = models;
            })
            .catch((error) => {
                if (seq !== customFetchSeq) return;
                if (error instanceof Error && error.name === "AbortError") return;
                customModels = [];
                customLoadError = error instanceof Error ? error.message : String(error);
            })
            .finally(() => {
                if (seq !== customFetchSeq) return;
                customFetchController = undefined;
                loadingCustom = false;
                if (activeList === "custom") {
                    shown = Math.min(pageSize, getBaseModels().length);
                    selectedIndex = 0;
                    render();
                }
            });
    }

    let lastLines: string[] = [];
    function clearRenderedOutput() {
        if (lastLines.length > 0) {
            stdout.write(`\x1B[${lastLines.length}A`);
            stdout.write("\x1B[J");
            lastLines = [];
        }
    }

    function render() {
        if (!canRender) return;
        const matches = getMatchingModels();
        const filtered = getFilteredModels();
        const lines: string[] = [];
        const popularTab = activeList === "popular" ? `${PRIMARY_TEXT}[Popular]${RESET_TEXT}` : " Popular ";
        const newestTab = activeList === "newest" ? `${PRIMARY_TEXT}[Newest]${RESET_TEXT}` : " Newest ";
        const customTab = activeList === "custom" ? `${PRIMARY_TEXT}[Custom]${RESET_TEXT}` : " Custom ";
        lines.push(`${popularTab}  |  ${newestTab}  |  ${customTab}   (use ← → to switch)`);
        lines.push("");

        if (filter) lines.push(`Filter: "${filter}" (showing ${Math.min(filtered.length, matches.length)} of ${matches.length} matches)`);
        else lines.push(`Pick a model from ${activeList} (showing 1-${Math.min(shown, getBaseModels().length)} of ${getBaseModels().length}):`);
        lines.push("");

        if (activeList === "newest" && loadingNewest) {
            lines.push("Loading newest models...");
            lines.push("");
        } else if (activeList === "newest" && newestLoadError) {
            lines.push(`Could not load newest models: ${newestLoadError}`);
            lines.push("");
        } else if (activeList === "custom") {
            lines.push(`Endpoint: ${customBaseUrl}`);
            lines.push(`API key: ${customApiKey ? "[set]" : "[blank]"}`);
            if (loadingCustom) lines.push("Loading custom models...");
            if (customLoadError) lines.push(`Could not load custom models: ${customLoadError}`);
            lines.push("");
        }

        if (filtered.length === 0) lines.push("No models match your filter.");
        else {
            filtered.forEach((m, i) => {
                const prefix = i === selectedIndex ? `${PRIMARY_TEXT}>${RESET_TEXT} ` : "  ";
                const itemNumber = `${DIM_TEXT}${i + 1})${RESET_TEXT}`;
                lines.push(`${prefix}${itemNumber} ${m.name || m.id}`);
            });
        }

        lines.push("");
        lines.push("[↑↓] Navigate  [←→] Switch list  [Enter] Select  [Space] Show more  [e] Edit custom  [Esc] Cancel");
        if (filter) lines.push("[Backspace] Clear filter  [Type] Filter models");
        else lines.push("[Type] Filter by name");

        clearRenderedOutput();
        lines.forEach((line) => stdout.write(line + "\n"));
        lastLines = lines;
    }

    return new Promise((resolve) => {
        render();

        const cleanup = () => {
            cancelNewestLoad();
            cancelCustomLoad();
            stdin.setRawMode(false);
            stdin.pause();
            stdin.removeListener("data", onData);
        };

        const withLinePrompt = async <T>(runPrompt: () => Promise<T>): Promise<T> => {
            stdin.removeListener("data", onData);
            stdin.setRawMode(false);
            stdin.pause();
            canRender = false;
            clearRenderedOutput();
            try {
                return await runPrompt();
            } finally {
                stdout.write("\n");
                canRender = true;
                stdin.setRawMode(true);
                stdin.resume();
                stdin.on("data", onData);
            }
        };

        const configureCustomEndpoint = async (): Promise<boolean> => {
            const configured = await withLinePrompt(async () => {
                const endpointDefault = endpointPromptDefaultFromApiBase(customBaseUrl);
                const endpoint = await promptForLine(`Custom endpoint [${endpointDefault}]: `);
                const apiKey = await promptForLine("API key (optional): ");
                customBaseUrl = normalizeCustomEndpointToApiBase(endpoint || endpointDefault);
                customApiKey = apiKey || undefined;
                setCachedCustomEndpoint(customBaseUrl);
                return true;
            });
            return configured;
        };

        const switchTab = async (next: "popular" | "newest" | "custom") => {
            if (next === activeList) return;
            if (next !== "newest") cancelNewestLoad();
            if (next !== "custom") cancelCustomLoad();
            activeList = next;
            filter = "";
            shown = Math.min(pageSize, getBaseModels().length);
            selectedIndex = 0;

            if (activeList === "newest") startNewestLoad();
            if (activeList === "custom" && !customModels && !loadingCustom) {
                await configureCustomEndpoint();
                startCustomLoad();
            }
            render();
        };

        const onData = async (key: string) => {
            const filtered = getFilteredModels();

            if (key === "\u0003") {
                cleanup();
                clearRenderedOutput();
                stdout.write("\n");
                resolve(MODEL_PICKER_ABORT);
                return;
            }

            if (key === "\u001b") {
                cleanup();
                clearRenderedOutput();
                stdout.write("\n");
                resolve(undefined);
                return;
            }

            if (key === "\r" || key === "\n") {
                if (filtered.length > 0 && selectedIndex < filtered.length) {
                    const selected = filtered[selectedIndex];
                    cleanup();
                    clearRenderedOutput();
                    stdout.write(`${DIM_TEXT}Switched to ${RESET_TEXT}${selected.id}\n\n`);
                    resolve({
                        modelId: selected.id,
                        provider: activeList === "custom" ? "openai" : "openrouter",
                        baseUrl: activeList === "custom" ? customBaseUrl : undefined,
                        apiKey: activeList === "custom" ? (customApiKey || "local") : undefined,
                        cacheable: true,
                    });
                }
                return;
            }

            if (key === " ") {
                const maxItems = filter ? getMatchingModels().length : getBaseModels().length;
                if (shown < maxItems) {
                    shown = Math.min(shown + pageSize, maxItems);
                    selectedIndex = 0;
                    render();
                }
                return;
            }

            if (key === "\x7f" || key === "\b") {
                if (filter.length > 0) {
                    filter = filter.slice(0, -1);
                    selectedIndex = 0;
                    render();
                }
                return;
            }

            if (key === "\u001b[A") {
                if (selectedIndex > 0) {
                    selectedIndex--;
                    render();
                }
                return;
            }
            if (key === "\u001b[B") {
                if (selectedIndex < filtered.length - 1) {
                    selectedIndex++;
                    render();
                }
                return;
            }
            if (key === "\u001b[C") {
                const next = activeList === "popular" ? "newest" : activeList === "newest" ? "custom" : "popular";
                await switchTab(next);
                return;
            }
            if (key === "\u001b[D") {
                const prev = activeList === "popular" ? "custom" : activeList === "newest" ? "popular" : "newest";
                await switchTab(prev);
                return;
            }

            if (key === "e" || key === "E") {
                if (activeList === "custom") {
                    await configureCustomEndpoint();
                    startCustomLoad();
                    render();
                }
                return;
            }

            if (key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) < 127) {
                filter += key;
                selectedIndex = 0;
                render();
                return;
            }
        };

        stdin.on("data", onData);
    });
}

function isModelSwitchCommand(input: string): boolean {
    const v = input.trim();
    return v === "--model" || v === "--models" || v === "-m";
}

async function promptForModelSelection(): Promise<ModelSelection | string | undefined> {
    let loadingLineShown = false;
    try {
        if (process.stdout.isTTY) {
            process.stdout.write("Loading models...\n");
            loadingLineShown = true;
        }
        const { rankings } = await fetchModelsWithRanking("openrouter");
        if (loadingLineShown) {
            process.stdout.write('\x1B[1A\x1B[2K\r');
        }
        const selected = await promptForModelFromTop(rankings, 10);
        if (selected === MODEL_PICKER_ABORT) {
            return MODEL_PICKER_ABORT;
        }
        return selected;
    } catch (error) {
        if (loadingLineShown) {
            process.stdout.write('\x1B[1A\x1B[2K\r');
        }
        throw error;
    }
}

async function listModels(args: string[]) {
    const limitIdx = args.indexOf("--limit");
    const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 10;

    console.log("Fetching models from OpenRouter...");
    try {
        const { rankings } = await fetchModelsWithRanking("openrouter");
        const topModels = getTopModels(rankings, limit);

        console.log(`\nTop ${limit} Models on OpenRouter:\n`);
        topModels.forEach((model, index) => {
            console.log(`${index + 1}. ${model.name || model.id} (${model.id})`);
            if (model.pricing) {
                console.log(`   Pricing: Prompt $${model.pricing.prompt}/1M, Completion $${model.pricing.completion}/1M`);
            }
            console.log("");
        });
    } catch (error) {
        console.error("Error fetching models:", error);
    }
}

async function chat(args: string[]) {
    const modelFlags = ["--model", "--models", "-m"];
    const modelIdx = args.findIndex((arg) =>
        modelFlags.includes(arg) ||
        arg.startsWith("--model=") ||
        arg.startsWith("--models=") ||
        arg.startsWith("-m=")
    );
    const webSearch = args.includes("--web");

    // Parse reasoning effort
    let reasoningEffort: "off" | "low" | "medium" | "high" = "off";
    const reasoningIdx = args.indexOf("--reasoning");
    if (reasoningIdx !== -1) {
        const nextArg = args[reasoningIdx + 1];
        if (nextArg && ["off", "low", "medium", "high"].includes(nextArg.toLowerCase())) {
            reasoningEffort = nextArg.toLowerCase() as "off" | "low" | "medium" | "high";
        }
    }

    // Parse system prompt (string or file path)
    let systemPrompt = getDefaultSystemPrompt();
    const systemIdx = args.findIndex((arg) =>
        arg === "--system" ||
        arg === "-s" ||
        arg.startsWith("--system=") ||
        arg.startsWith("-s=")
    );
    if (systemIdx !== -1) {
        const systemArg = args[systemIdx];
        const eqIdx = systemArg.indexOf("=");
        const inlineValue = eqIdx !== -1 && eqIdx < systemArg.length - 1 ? systemArg.slice(eqIdx + 1) : undefined;
        const nextArg = args[systemIdx + 1];
        const systemValue = inlineValue || (nextArg && !nextArg.startsWith("-") ? nextArg : undefined);
        if (systemValue) {
            // Check if it's a file path
            if (existsSync(systemValue)) {
                try {
                    systemPrompt = readFileSync(systemValue, "utf-8");
                } catch {
                    console.error(`Error reading system prompt file: ${systemValue}`);
                }
            } else {
                // Treat as string
                systemPrompt = systemValue;
            }
        }
    }

    // Build prompt from non-option args (excluding --system value)
    const optionFlags = ["--model", "--models", "-m", "--web", "--reasoning", "--system", "-s"];
    const isOption = (arg: string) =>
        optionFlags.some((flag) => arg === flag || arg.startsWith(`${flag}=`));
    const nonOptionArgs: string[] = [];
    let skipNext = false;
    for (let i = 0; i < args.length; i++) {
        if (skipNext) {
            skipNext = false;
            continue;
        }
        if (isOption(args[i])) {
            // Skip the flag and its value (if not a boolean flag)
            if (!args[i].includes("=") && args[i] !== "--web" && i + 1 < args.length && !args[i + 1].startsWith("-")) {
                skipNext = true;
            }
            continue;
        }
        nonOptionArgs.push(args[i]);
    }
    let initialPrompt = nonOptionArgs.length > 0 ? nonOptionArgs.join(" ") : undefined;

    if (!systemPrompt) {
        systemPrompt = getDefaultSystemPrompt();
    }

    let modelId: string | undefined;
    let modelProvider: "openrouter" | "openai" = "openrouter";
    let modelBaseUrl: string | undefined;
    let modelApiKey: string | undefined;
    let usedPickerForInitialModel = false;
    
    // Check if model flag exists (--model, --models, -m)
    if (modelIdx !== -1) {
        const modelArg = args[modelIdx];
        const eqIdx = modelArg.indexOf("=");
        if (eqIdx !== -1 && eqIdx < modelArg.length - 1) {
            // Model ID provided inline (e.g. --model=id, --models=id, -m=id)
            modelId = modelArg.slice(eqIdx + 1);
        } else {
            // Check if there's a value after the model flag
            const nextArg = args[modelIdx + 1];
            if (nextArg && !nextArg.startsWith("-")) {
                // Model ID provided
                modelId = nextArg;
            } else {
                // Model flag without argument - show picker
                try {
                    usedPickerForInitialModel = true;
                    const selection = await promptForModelSelection();
                    if (selection === MODEL_PICKER_ABORT) {
                        return;
                    }
                    if (selection && typeof selection !== "string") {
                        modelId = selection.modelId;
                        modelProvider = selection.provider;
                        modelBaseUrl = selection.baseUrl;
                        modelApiKey = selection.apiKey;
                        if (selection.cacheable) setCachedModelSelection({ modelId, provider: modelProvider, baseUrl: modelBaseUrl });
                    } else if (!selection) {
                        const { rankings } = await fetchModelsWithRanking("openrouter");
                        const topModels = getTopModels(rankings, 1);
                        if (topModels.length > 0) {
                            modelId = topModels[0].id;
                            modelProvider = "openrouter";
                            modelBaseUrl = undefined;
                            modelApiKey = undefined;
                            console.log(`${DIM_TEXT}Using top model: ${RESET_TEXT}${topModels[0].name || modelId}`);
                        }
                    }
                } catch (error) {
                    console.error("Error fetching models:", error);
                    return;
                }
            }
        }
    } else {
        // No --model flag - try cached model
        const cachedSelection = getCachedModelSelection();
        if (cachedSelection) {
            modelId = cachedSelection.modelId;
            modelProvider = cachedSelection.provider;
            modelBaseUrl = cachedSelection.baseUrl;
            modelApiKey = undefined;
            console.log(`${DIM_TEXT}Using ${RESET_TEXT}${modelId}`);
        } else {
            try {
                usedPickerForInitialModel = true;
                const selection = await promptForModelSelection();
                if (selection === MODEL_PICKER_ABORT) {
                    return;
                }
                if (selection && typeof selection !== "string") {
                    modelId = selection.modelId;
                    modelProvider = selection.provider;
                    modelBaseUrl = selection.baseUrl;
                    modelApiKey = selection.apiKey;
                    if (selection.cacheable) setCachedModelSelection({ modelId, provider: modelProvider, baseUrl: modelBaseUrl });
                } else if (!selection) {
                    const { rankings } = await fetchModelsWithRanking("openrouter");
                    const topModels = getTopModels(rankings, 1);
                    if (topModels.length > 0) {
                        modelId = topModels[0].id;
                        modelProvider = "openrouter";
                        modelBaseUrl = undefined;
                        modelApiKey = undefined;
                        console.log(`${DIM_TEXT}Using top model: ${RESET_TEXT}${topModels[0].name || modelId}`);
                    }
                }
            } catch (error) {
                console.error("Error fetching top models:", error);
                return;
            }
        }
    }

    if (!modelId) {
        console.error("Could not determine model.");
        return;
    }

    // Cache the model for next time
    if (modelId) {
        setCachedModelSelection({ modelId, provider: modelProvider, baseUrl: modelBaseUrl });
    }

    // Initialize conversation history
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [];

    // Add system prompt if provided
    if (systemPrompt) {
        messages.push({ role: "system", content: systemPrompt });
    }

    // Interactive loop for messages
    if (process.stdin.isTTY && process.stdout.isTTY) {
        if (!usedPickerForInitialModel && !initialPrompt) {
            console.log("");
        }
        let firstPrompt = initialPrompt;
        
        // Resolve the first actionable input (prompt text or model-switch command)
        while (true) {
            if (!firstPrompt) {
                firstPrompt = await promptForLine(USER_PROMPT_LABEL);
                if (!firstPrompt) {
                    continue;
                }
            }
            if (!isModelSwitchCommand(firstPrompt)) {
                break;
            }
            try {
                const selection = await promptForModelSelection();
                if (selection === MODEL_PICKER_ABORT) {
                    return;
                }
                if (selection && typeof selection !== "string") {
                    modelId = selection.modelId;
                    modelProvider = selection.provider;
                    modelBaseUrl = selection.baseUrl;
                    modelApiKey = selection.apiKey;
                    if (selection.cacheable) setCachedModelSelection({ modelId, provider: modelProvider, baseUrl: modelBaseUrl });
                }
            } catch (error) {
                console.error("Error fetching models:", error);
            }
            firstPrompt = undefined;
        }
        
        // Process the first prompt
        await streamChatResponse(modelId, modelProvider, modelBaseUrl, modelApiKey, firstPrompt, messages, webSearch, reasoningEffort);
        
        // Continue with follow-up prompts
        while (true) {
            const prompt = await promptForLine(USER_PROMPT_LABEL);
            
            if (!prompt) {
                continue;
            }
            
            if (prompt.toLowerCase() === "exit" || prompt.toLowerCase() === "quit") {
                console.log("--- Chat session ended. ---");
                break;
            }
            if (isModelSwitchCommand(prompt)) {
                try {
                    const selection = await promptForModelSelection();
                    if (selection === MODEL_PICKER_ABORT) {
                        return;
                    }
                    if (selection && typeof selection !== "string") {
                        modelId = selection.modelId;
                        modelProvider = selection.provider;
                        modelBaseUrl = selection.baseUrl;
                        modelApiKey = selection.apiKey;
                        if (selection.cacheable) setCachedModelSelection({ modelId, provider: modelProvider, baseUrl: modelBaseUrl });
                    }
                } catch (error) {
                    console.error("Error fetching models:", error);
                }
                continue;
            }

            await streamChatResponse(modelId, modelProvider, modelBaseUrl, modelApiKey, prompt, messages, webSearch, reasoningEffort);
        }
    }
}

async function streamChatResponse(
    modelId: string,
    provider: "openrouter" | "openai",
    baseUrl: string | undefined,
    apiKey: string | undefined,
    prompt: string,
    messages: { role: "system" | "user" | "assistant"; content: string }[],
    webSearch: boolean,
    reasoningEffort: "off" | "low" | "medium" | "high"
) {
    // Add user message to history
    messages.push({ role: "user", content: prompt });

    let fullResponse = "";
    let ellipsisVisible = false;
    let startedAssistantLine = false;
    let sawReasoning = false;
    let startedAnswer = false;
    let userStopped = false;
    const streamAbortController = new AbortController();
    const stdin = process.stdin;
    const canListenForStop = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const wasRaw = Boolean((stdin as any).isRaw);

    const stopStreaming = () => {
        if (userStopped) return;
        userStopped = true;
        streamAbortController.abort();
    };

    const onStreamKey = (key: string) => {
        if (key === '\u001b') { // Esc
            stopStreaming();
        } else if (key === '\u0003') { // Ctrl+C
            if (process.stdout.isTTY) process.stdout.write("\n");
            process.exit(130);
        }
    };

    const removeTypingEllipsis = () => {
        if (!ellipsisVisible) return;
        process.stdout.write("\x1B[1D\x1B[0K");
        ellipsisVisible = false;
    };

    const showTypingEllipsis = () => {
        if (ellipsisVisible) return;
        process.stdout.write(ASSISTANT_TYPING);
        ellipsisVisible = true;
    };

    try {
        if (canListenForStop) {
            if (!wasRaw) stdin.setRawMode(true);
            stdin.resume();
            stdin.setEncoding("utf8");
            stdin.on("data", onStreamKey);
        }

        process.stdout.write(`\n${ASSISTANT_DOT}`);
        startedAssistantLine = true;
        showTypingEllipsis();

        if (baseUrl) {
            removeTypingEllipsis();
            const customAnswer = await streamCustomOpenAICompatibleResponse({
                baseUrl,
                apiKey,
                modelId,
                messages,
                onDelta: (delta) => process.stdout.write(delta),
                signal: streamAbortController.signal,
            });
            fullResponse = customAnswer;
            if (fullResponse.length > 0) messages.push({ role: "assistant", content: fullResponse });
            console.log("\n");
            return;
        }
        
        await reasoningStream({
            messages,
            provider,
            model: modelId,
            baseUrl,
            apiKey,
            // Always request visible reasoning; treat "off" as "low".
            effort: reasoningEffort === "off" ? "low" : reasoningEffort,
            debugEvents: false,
            webSearch,
            signal: streamAbortController.signal,
            onReasoningDelta: (delta) => {
                if (userStopped) return;
                removeTypingEllipsis();
                sawReasoning = true;
                process.stdout.write(`${DIM_TEXT}${delta}${RESET_TEXT}`);
                showTypingEllipsis();
            },
            onAnswerDelta: (delta) => {
                if (userStopped) return;
                removeTypingEllipsis();
                if (!startedAnswer) {
                    if (sawReasoning) {
                        process.stdout.write("\n\n");
                    }
                    startedAnswer = true;
                }
                process.stdout.write(delta);
                fullResponse += delta;
                showTypingEllipsis();
            },
        });

        removeTypingEllipsis();
        
        // Add assistant response to history
        if (fullResponse.length > 0) messages.push({ role: "assistant", content: fullResponse });
        
        console.log("\n");
    } catch (error) {
        removeTypingEllipsis();
        if (startedAssistantLine) process.stdout.write("\n");
        const message = error instanceof Error ? error.message : String(error);
        const isAbort = userStopped || /abort/i.test(message);
        if (isAbort) {
            if (fullResponse.length > 0) {
                messages.push({ role: "assistant", content: fullResponse });
            }
            process.stdout.write(`${DIM_TEXT}[stopped]${RESET_TEXT}\n\n`);
            return;
        }
        console.error(`Error during chat: ${message}`);
    } finally {
        if (canListenForStop) {
            stdin.removeListener("data", onStreamKey);
            if (!wasRaw) {
                stdin.setRawMode(false);
                stdin.pause();
            }
        }
    }
}

async function streamCustomOpenAICompatibleResponse(opts: {
    baseUrl: string;
    apiKey?: string;
    modelId: string;
    messages: { role: "system" | "user" | "assistant"; content: string }[];
    onDelta?: (delta: string) => void;
    signal?: AbortSignal;
}): Promise<string> {
    const { baseUrl, apiKey, modelId, messages } = opts;
    const requestMessages = messages.some((m) => m.role === "system")
        ? messages
        : [{ role: "system", content: DEFAULT_CHAT_SYSTEM_PROMPT } as const, ...messages];
    const systemPrompt = requestMessages.find((m) => m.role === "system")?.content;
    if (process.env.MAID_DEBUG_SYSTEM_PROMPT === "1") {
        console.log(`[debug] system_prompt=${JSON.stringify(systemPrompt || "")}`);
    }
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        signal: opts.signal,
        body: JSON.stringify({
            model: modelId,
            messages: requestMessages,
            // Some "OpenAI-compatible" local servers only honor system_prompt.
            ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
            stream: true,
        }),
    });

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`${response.status} ${response.statusText}${body ? `: ${body}` : ""}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (response.body && contentType.includes("text/event-stream")) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let full = "";

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line.startsWith("data:")) continue;
                const data = line.slice(5).trim();
                if (!data || data === "[DONE]") continue;
                try {
                    const chunk: any = JSON.parse(data);
                    const delta = chunk?.choices?.[0]?.delta?.content;
                    if (typeof delta === "string" && delta.length > 0) {
                        full += delta;
                        opts.onDelta?.(delta);
                    }
                } catch { }
            }
        }
        return full;
    }

    const payload: any = await response.json();
    const messageContent = payload?.choices?.[0]?.message?.content;
    if (typeof messageContent === "string" && messageContent.trim().length > 0) {
        return messageContent;
    }
    const outputText = payload?.output_text;
    if (typeof outputText === "string" && outputText.trim().length > 0) {
        return outputText;
    }
    return JSON.stringify(payload);
}

async function fetchCustomEndpointModels(baseUrl: string, apiKey?: string, signal?: AbortSignal): Promise<string[]> {
    const headers: Record<string, string> = {
        Accept: "application/json",
    };
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

main();
