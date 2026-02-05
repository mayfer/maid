import { fetchModelsWithRanking, reasoningStream, getTopModels } from "./llm/index";
import type { StandardizedModel, ChatMessage } from "./llm/index";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { spawn } from "child_process";
import path from "path";
import { buildPrompt, DEFAULT_CHAT_SYSTEM_PROMPT } from "./prompt";

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
const RUN_COMMAND_MARKER = "__RUN_COMMAND__";
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
    return buildPrompt(DEFAULT_CHAT_SYSTEM_PROMPT);
}

function stripRunMarker(response: string): { content: string; hasMarker: boolean } {
    const normalized = response.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
        lines.pop();
    }
    if (lines.length < 2) return { content: response, hasMarker: false };
    if (lines[lines.length - 1].trim() !== RUN_COMMAND_MARKER) {
        return { content: response, hasMarker: false };
    }
    const content = lines.slice(0, -1).join("\n").replace(/\s+$/, "");
    return { content, hasMarker: true };
}

function extractRunnableCommand(response: string): string | undefined {
    const normalized = response.replace(/\r\n/g, "\n");
    const tagMatches = [...normalized.matchAll(/<command>([\s\S]*?)<\/command>/g)];
    if (tagMatches.length > 0) {
        const tagged = (tagMatches[tagMatches.length - 1]?.[1] || "").trim();
        if (tagged) return tagged;
    }

    // Support commands emitted in fenced blocks, e.g.:
    // ```bash
    // command
    // __RUN_COMMAND__
    // ```
    const fencedPattern = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g;
    for (const match of normalized.matchAll(fencedPattern)) {
        const body = match[1] || "";
        const lines = body.split("\n");
        const markerIdx = lines.findIndex((line) => line.trim() === RUN_COMMAND_MARKER);
        if (markerIdx === -1) continue;
        const command = lines.slice(0, markerIdx).join("\n").trim();
        if (command) return command;
    }

    const lines = normalized.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim() !== RUN_COMMAND_MARKER) continue;

        let end = i - 1;
        while (end >= 0 && lines[end].trim() === "") end--;
        if (end < 0) continue;

        let start = end;
        while (start - 1 >= 0 && lines[start - 1].trim() !== "") start--;
        const command = lines.slice(start, i).join("\n").trim();
        if (command) return command;
    }

    return undefined;
}

function createCommandTagStreamParser() {
    const openTag = "<command>";
    const closeTag = "</command>";
    let pending = "";
    let inCommand = false;
    let commandBuffer = "";

    const longestSuffixPrefixLen = (value: string, token: string): number => {
        const max = Math.min(value.length, token.length - 1);
        for (let len = max; len > 0; len--) {
            if (value.slice(-len) === token.slice(0, len)) return len;
        }
        return 0;
    };

    const feed = (chunk: string): { visible: string; commands: string[] } => {
        pending += chunk;
        let visible = "";
        const commands: string[] = [];

        while (pending.length > 0) {
            if (!inCommand) {
                const idx = pending.indexOf(openTag);
                if (idx === -1) {
                    const keepLen = longestSuffixPrefixLen(pending, openTag);
                    const flushLen = pending.length - keepLen;
                    if (flushLen > 0) {
                        visible += pending.slice(0, flushLen);
                        pending = pending.slice(flushLen);
                    }
                    break;
                }
                if (idx > 0) visible += pending.slice(0, idx);
                pending = pending.slice(idx + openTag.length);
                inCommand = true;
                commandBuffer = "";
                continue;
            }

            const closeIdx = pending.indexOf(closeTag);
            if (closeIdx === -1) {
                const keepLen = longestSuffixPrefixLen(pending, closeTag);
                const flushLen = pending.length - keepLen;
                if (flushLen > 0) {
                    const part = pending.slice(0, flushLen);
                    commandBuffer += part;
                    visible += part;
                    pending = pending.slice(flushLen);
                }
                break;
            }

            if (closeIdx > 0) {
                const part = pending.slice(0, closeIdx);
                commandBuffer += part;
                visible += part;
            }
            const command = commandBuffer.trim();
            if (command) commands.push(command);
            pending = pending.slice(closeIdx + closeTag.length);
            inCommand = false;
            commandBuffer = "";
        }

        return { visible, commands };
    };

    const flush = (): { visible: string; commands: string[] } => {
        if (!inCommand) {
            const out = pending;
            pending = "";
            return { visible: out, commands: [] };
        }
        const out = `${openTag}${commandBuffer}${pending}`;
        pending = "";
        commandBuffer = "";
        inCommand = false;
        return { visible: out, commands: [] };
    };

    return { feed, flush };
}

function looksExecutableShellCommand(command: string): boolean {
    const trimmed = command.trim();
    if (!trimmed) return false;
    if (trimmed.length > 300) return false;
    if (/[.!?]$/.test(trimmed)) return false;

    const firstToken = trimmed.split(/\s+/)[0] || "";
    if (!firstToken) return false;
    // Avoid accidentally executing natural-language sentences.
    if (!/^[a-z0-9_./-]+$/.test(firstToken)) return false;
    if (/[A-Z]/.test(firstToken)) return false;
    if (firstToken === "i" || firstToken === "you" || firstToken === "please") return false;
    if (["check", "visit", "try", "consider", "use"].includes(firstToken)) return false;

    return true;
}

async function runCommand(command: string): Promise<void> {
    await new Promise<void>((resolve) => {
        const child = spawn(command, { shell: true, stdio: ["inherit", "pipe", "pipe"] });
        let sawOutput = false;
        let lastOutputEndedWithNewline = true;

        const handleChunk = (chunk: Buffer | string, writer: (s: string) => void) => {
            const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
            if (!text) return;
            sawOutput = true;
            lastOutputEndedWithNewline = text.endsWith("\n");
            writer(text);
        };

        child.stdout?.on("data", (chunk) => handleChunk(chunk, (s) => process.stdout.write(s)));
        child.stderr?.on("data", (chunk) => handleChunk(chunk, (s) => process.stderr.write(s)));

        child.on("error", (error) => {
            console.error(`Failed to run command: ${error.message}`);
            resolve();
        });
        child.on("exit", () => {
            if (process.stdout.isTTY && sawOutput && !lastOutputEndedWithNewline) {
                process.stdout.write("\n");
            }
            resolve();
        });
    });
}

async function maybePromptToRunCommand(command: string): Promise<boolean> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
    const shouldRun = await promptForRunCommandConfirmation(
        `${DIM_TEXT}Run command? ${RESET_TEXT}${PRIMARY_TEXT}Enter${RESET_TEXT}${DIM_TEXT}/${RESET_TEXT}${PRIMARY_TEXT}Esc${RESET_TEXT} `,
    );
    if (shouldRun) {
        await runCommand(command);
        return true;
    }
    return false;
}

async function promptForRunCommandConfirmation(label: string): Promise<boolean> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
    const stdin = process.stdin;
    const stdout = process.stdout;
    const wasRaw = Boolean((stdin as any).isRaw);

    stdout.write(label);

    return await new Promise<boolean>((resolve) => {
        const finish = (value: boolean) => {
            stdin.removeListener("data", onData);
            if (!wasRaw) {
                stdin.setRawMode(false);
                stdin.pause();
            }
            resolve(value);
        };

        const onData = (chunk: string) => {
            if (chunk === "\u0003") { // Ctrl+C
                stdout.write("\n");
                process.exit(130);
            }
            if (chunk === "\r" || chunk === "\n") {
                stdout.write("\n");
                finish(true);
                return;
            }
            if (chunk === "\u001b") { // Esc
                stdout.write("\n");
                finish(false);
            }
        };

        if (!wasRaw) {
            stdin.setRawMode(true);
            stdin.resume();
            stdin.setEncoding("utf8");
        }
        stdin.on("data", onData);
    });
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

    const args = process.argv.slice(2);
    const firstArg = args[0];

    if (firstArg === "help" || firstArg === "-h" || firstArg === "--help") {
        printHelp();
        return;
    }

    if (args.length === 1 && (firstArg === "--system" || firstArg === "-s")) {
        console.log(getDefaultSystemPrompt());
        return;
    }

    // No subcommands; default to chat behavior.
    if (!firstArg) {
        if (process.stdin.isTTY && process.stdout.isTTY) {
            await ensureOpenRouterApiKeyConfigured();
            await chat([]);
        } else {
            printHelp();
        }
        return;
    }

    await ensureOpenRouterApiKeyConfigured();
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
    let systemValue: string | undefined;
    if (systemIdx !== -1) {
        const systemArg = args[systemIdx];
        const eqIdx = systemArg.indexOf("=");
        const inlineValue = eqIdx !== -1 && eqIdx < systemArg.length - 1 ? systemArg.slice(eqIdx + 1) : undefined;
        const nextArg = args[systemIdx + 1];
        systemValue = inlineValue || (nextArg && !nextArg.startsWith("-") ? nextArg : undefined);
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

    if (systemIdx !== -1 && !systemValue && !initialPrompt) {
        console.log(systemPrompt);
        return;
    }

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
        messages.push({ role: "system", content: buildPrompt(systemPrompt) });
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
    let rawResponse = "";
    let ellipsisVisible = false;
    let startedAssistantLine = false;
    let sawReasoning = false;
    let startedAnswer = false;
    let sawAnyAnswerDelta = false;
    let userStopped = false;
    let pendingAnswerTail = "";
    let renderedAnswerChars = 0;
    let commandToRun: string | undefined;
    let taggedCommand: string | undefined;
    const commandTagParser = createCommandTagStreamParser();
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

        const onAnswerDelta = (delta: string) => {
            if (userStopped) return;
            sawAnyAnswerDelta = true;
            rawResponse += delta;
            removeTypingEllipsis();
            if (!startedAnswer) {
                if (sawReasoning) {
                    process.stdout.write("\n\n");
                }
                startedAnswer = true;
            }

            const { visible, commands } = commandTagParser.feed(delta);
            if (commands.length > 0) {
                taggedCommand = commands[commands.length - 1];
            }
            if (visible.length === 0) {
                showTypingEllipsis();
                return;
            }

            fullResponse += visible;
            pendingAnswerTail += visible;
            if (pendingAnswerTail.length > 64) {
                const flushable = pendingAnswerTail.slice(0, -64);
                if (flushable.length > 0) {
                    process.stdout.write(flushable);
                    renderedAnswerChars += flushable.length;
                }
                pendingAnswerTail = pendingAnswerTail.slice(-64);
            }
            showTypingEllipsis();
        };

        if (baseUrl) {
            const customAnswer = await streamCustomOpenAICompatibleResponse({
                baseUrl,
                apiKey,
                modelId,
                messages,
                webSearch,
                onToolCall: (toolName, args) => {
                    const query = typeof args?.query === "string" ? args.query : "";
                    const error = typeof args?.error === "string" ? args.error : "";
                    const details = error
                        ? `${query ? `${query} ` : ""}${error}`.trim()
                        : query;
                    process.stdout.write(`\n${DIM_TEXT}[${toolName}]${details ? `: ${details}` : ""}${RESET_TEXT}\n`);
                },
                onDelta: onAnswerDelta,
                signal: streamAbortController.signal,
            });
            if (!sawAnyAnswerDelta && customAnswer.length > 0) {
                onAnswerDelta(customAnswer);
            }
        } else {
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
                onAnswerDelta,
            });
        }

        removeTypingEllipsis();
        const parserFlush = commandTagParser.flush();
        if (parserFlush.visible.length > 0) {
            fullResponse += parserFlush.visible;
        }
        const { content: cleanedResponse, hasMarker } = stripRunMarker(fullResponse);
        const remaining = cleanedResponse.slice(renderedAnswerChars);
        if (remaining.length > 0) {
            process.stdout.write(remaining);
            renderedAnswerChars += remaining.length;
        }
        fullResponse = cleanedResponse;
        pendingAnswerTail = "";
        if (taggedCommand && looksExecutableShellCommand(taggedCommand)) {
            commandToRun = taggedCommand;
        } else {
            const extractedCommand = extractRunnableCommand(rawResponse);
            if (extractedCommand && (hasMarker || rawResponse.includes(RUN_COMMAND_MARKER)) && looksExecutableShellCommand(extractedCommand)) {
                commandToRun = extractedCommand.trim();
            }
        }
        
        // Add assistant response to history
        if (fullResponse.length > 0) messages.push({ role: "assistant", content: fullResponse });

        // Keep spacing tight before command confirmation prompts.
        process.stdout.write(commandToRun ? "\n" : "\n\n");
    } catch (error) {
        removeTypingEllipsis();
        if (startedAssistantLine) process.stdout.write("\n");
        const message = error instanceof Error ? error.message : String(error);
        const isAbort = userStopped || /abort/i.test(message);
        if (isAbort) {
            if (pendingAnswerTail.length > 0) {
                process.stdout.write(pendingAnswerTail);
                pendingAnswerTail = "";
            }
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

    if (commandToRun) {
        const didRun = await maybePromptToRunCommand(commandToRun);
        if (didRun) {
            process.exit(0);
        }
    }
}

async function streamCustomOpenAICompatibleResponse(opts: {
    baseUrl: string;
    apiKey?: string;
    modelId: string;
    messages: { role: "system" | "user" | "assistant"; content: string }[];
    webSearch?: boolean;
    onDelta?: (delta: string) => void;
    onToolCall?: (toolName: string, args: Record<string, any>) => void;
    signal?: AbortSignal;
}): Promise<string> {
    type ToolCapableMessage =
        | { role: "system" | "user" | "assistant"; content: string; tool_calls?: any[] }
        | { role: "tool"; tool_call_id: string; name: string; content: string };

    const { baseUrl, apiKey, modelId, messages } = opts;
    const requestMessages: ToolCapableMessage[] = messages.some((m) => m.role === "system")
        ? [...messages]
        : [{ role: "system", content: DEFAULT_CHAT_SYSTEM_PROMPT } as const, ...messages];
    if (opts.webSearch) {
        const today = new Date().toISOString().slice(0, 10);
        requestMessages.push({
            role: "system",
            content: `Web-search guidance: today is ${today}. For time-sensitive queries, prefer terms like latest/current/breaking and avoid forcing an exact date unless the user explicitly asks for one.`,
        });
    }
    const systemPrompt = requestMessages.find((m) => m.role === "system")?.content;
    if (process.env.MAID_DEBUG_SYSTEM_PROMPT === "1") {
        console.log(`[debug] system_prompt=${JSON.stringify(systemPrompt || "")}`);
    }
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const webSearchTool = {
        type: "function",
        function: {
            name: "web_search",
            description: "Search the web for up-to-date information and return concise source snippets.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search query string." },
                    top_k: { type: "number", description: "Maximum number of results to return.", default: 5 },
                },
                required: ["query"],
            },
        },
    };

    const webSearchCache = new Map<string, string>();
    const compactWebSnippetFromPayload = (raw: string): string | undefined => {
        try {
            const parsed: any = JSON.parse(raw);
            const query = typeof parsed?.query === "string" ? parsed.query.trim() : "";
            const results = Array.isArray(parsed?.results) ? parsed.results : [];
            const lines = results
                .slice(0, 5)
                .map((item: any, idx: number) => {
                    const title = typeof item?.title === "string" ? item.title.trim() : "";
                    const snippet = typeof item?.snippet === "string" ? item.snippet.trim() : "";
                    const url = typeof item?.url === "string" ? item.url.trim() : "";
                    const core = [title, snippet].filter(Boolean).join(" — ");
                    return core ? `${idx + 1}. ${core}${url ? ` (${url})` : ""}` : undefined;
                })
                .filter((v: string | undefined): v is string => Boolean(v));
            if (lines.length === 0) return undefined;
            return `${query ? `Query: ${query}\n` : ""}${lines.join("\n")}`;
        } catch {
            return undefined;
        }
    };

    const decodeHtml = (value: string): string => value
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&quot;/g, "\"")
        .replace(/&#x27;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ");

    const stripHtml = (value: string): string => decodeHtml(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

    const resolveDuckDuckGoRedirect = (href: string): string => {
        try {
            const parsed = new URL(href, "https://duckduckgo.com");
            const uddg = parsed.searchParams.get("uddg");
            return uddg ? decodeURIComponent(uddg) : parsed.toString();
        } catch {
            return href;
        }
    };

    const fetchHtmlSearchResults = async (query: string, topK: number): Promise<Array<{ title: string; snippet: string; url: string }>> => {
        const htmlUrl = new URL("https://html.duckduckgo.com/html/");
        htmlUrl.searchParams.set("q", query);
        const htmlResp = await fetch(htmlUrl.toString(), {
            signal: opts.signal,
            headers: { Accept: "text/html" },
        });
        if (!htmlResp.ok) return [];

        const html = await htmlResp.text();
        const titleMatches = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
        const snippetMatches = [...html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/div>/gi)];
        const limit = Math.max(1, Math.min(topK || 5, 8));
        const out: Array<{ title: string; snippet: string; url: string }> = [];

        for (let i = 0; i < Math.min(titleMatches.length, limit); i++) {
            const href = titleMatches[i]?.[1] || "";
            const rawTitle = titleMatches[i]?.[2] || "";
            const rawSnippet = snippetMatches[i]?.[1] || snippetMatches[i]?.[2] || "";
            const title = stripHtml(rawTitle);
            const snippet = stripHtml(rawSnippet);
            const url = resolveDuckDuckGoRedirect(href);
            if (!title || !url) continue;
            out.push({ title, snippet: snippet || title, url });
        }
        return out;
    };

    const fetchSearchResults = async (query: string, topK: number): Promise<string> => {
        const limit = Math.max(1, Math.min(topK || 5, 8));
        try {
            const url = new URL("https://api.duckduckgo.com/");
            url.searchParams.set("q", query);
            url.searchParams.set("format", "json");
            url.searchParams.set("no_html", "1");
            url.searchParams.set("no_redirect", "1");
            url.searchParams.set("skip_disambig", "1");
            const searchResp = await fetch(url.toString(), { signal: opts.signal });
            if (!searchResp.ok) {
                return JSON.stringify({ query, error: `search_failed:${searchResp.status}` });
            }
            const payload: any = await searchResp.json();
            const related = Array.isArray(payload?.RelatedTopics) ? payload.RelatedTopics : [];
            const flattened = related.flatMap((item: any) =>
                Array.isArray(item?.Topics) ? item.Topics : [item],
            );
            const items = flattened
                .filter((item: any) => typeof item?.Text === "string")
                .slice(0, limit)
                .map((item: any) => ({
                    title: item.Text.split(" - ")[0] || item.Text,
                    snippet: item.Text,
                    url: item.FirstURL,
                }));
            const abstract = typeof payload?.AbstractText === "string" && payload.AbstractText.trim().length > 0
                ? [{
                    title: payload.Heading || query,
                    snippet: payload.AbstractText,
                    url: payload.AbstractURL || undefined,
                }]
                : [];
            const instantResults = [...abstract, ...items].slice(0, limit);
            if (instantResults.length > 0) {
                return JSON.stringify({
                    query,
                    results: instantResults,
                    source: "duckduckgo_instant_answer",
                });
            }

            const htmlResults = await fetchHtmlSearchResults(query, limit);
            if (htmlResults.length > 0) {
                return JSON.stringify({
                    query,
                    results: htmlResults,
                    source: "duckduckgo_html",
                });
            }

            return JSON.stringify({
                query,
                error: "no_results",
                results: [],
                source: "duckduckgo_html",
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return JSON.stringify({ query, error: `search_error:${message}` });
        }
    };

    const doChatCompletion = async (
        requestBody: Record<string, any>,
    ): Promise<any> => {
        const response = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers,
            signal: opts.signal,
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(`${response.status} ${response.statusText}${body ? `: ${body}` : ""}`);
        }
        return response.json();
    };

    // Tool-calling loop for OpenAI-compatible endpoints (e.g. LM Studio).
    if (opts.webSearch) {
        const toolMaxRounds = 3;
        const webSnippets: string[] = [];
        for (let round = 0; round < toolMaxRounds; round++) {
            const payload: any = await doChatCompletion({
                model: modelId,
                messages: requestMessages,
                ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
                tools: [webSearchTool],
                tool_choice: "auto",
                stream: false,
            });
            const message = payload?.choices?.[0]?.message || {};
            const toolCalls: any[] = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
            if (toolCalls.length === 0) {
                const finalContent = typeof message?.content === "string"
                    ? message.content
                    : typeof payload?.output_text === "string"
                        ? payload.output_text
                        : JSON.stringify(payload);
                if (finalContent.length > 0) opts.onDelta?.(finalContent);
                return finalContent;
            }

            requestMessages.push({
                role: "assistant",
                content: typeof message?.content === "string" ? message.content : "",
                tool_calls: toolCalls,
            });

            for (const call of toolCalls) {
                const name = call?.function?.name;
                const rawArgs = call?.function?.arguments;
                if (name !== "web_search") continue;
                let parsedArgs: Record<string, any> = {};
                try {
                    parsedArgs = typeof rawArgs === "string" ? JSON.parse(rawArgs) : {};
                } catch {
                    parsedArgs = {};
                }
                const query = typeof parsedArgs?.query === "string" ? parsedArgs.query.trim() : "";
                const topK = Number.isFinite(Number(parsedArgs?.top_k)) ? Number(parsedArgs.top_k) : 5;
                opts.onToolCall?.("web_search", { query, top_k: topK });
                let result: string;
                if (!query) {
                    result = JSON.stringify({ error: "missing_query" });
                } else if (webSearchCache.has(query)) {
                    result = webSearchCache.get(query)!;
                } else {
                    result = await fetchSearchResults(query, topK);
                    webSearchCache.set(query, result);
                }
                const snippet = compactWebSnippetFromPayload(result);
                if (snippet) webSnippets.push(snippet);
                try {
                    const parsedResult: any = JSON.parse(result);
                    if (typeof parsedResult?.error === "string" && parsedResult.error.length > 0) {
                        opts.onToolCall?.("web_search_error", { query, error: parsedResult.error });
                    }
                } catch {}

                requestMessages.push({
                    role: "tool",
                    tool_call_id: call?.id || `tool_${Date.now()}`,
                    name: "web_search",
                    content: result,
                });
            }
        }
        const fallbackMessages = requestMessages
            .filter((m) => m.role !== "tool")
            .map((m) => ({ role: m.role, content: m.content || "" }));
        const fallbackContext = webSnippets.length > 0
            ? webSnippets.slice(0, 6).join("\n\n")
            : "No usable search snippets were returned.";

        try {
            const forcedFinal: any = await doChatCompletion({
                model: modelId,
                messages: [
                    ...fallbackMessages,
                    {
                        role: "system",
                        content: "You must answer now using the provided web search snippets. Do not call tools.",
                    },
                    {
                        role: "user",
                        content: `Web search snippets:\n${fallbackContext}\n\nReturn a concise final answer now.`,
                    },
                ],
                stream: false,
            });
            const forcedContent = typeof forcedFinal?.choices?.[0]?.message?.content === "string"
                ? forcedFinal.choices[0].message.content
                : "";
            if (forcedContent.trim().length > 0) {
                opts.onDelta?.(forcedContent);
                return forcedContent;
            }
        } catch {
            // Fall through to textual snippet fallback below.
        }

        const snippetFallback = webSnippets.length > 0
            ? `I couldn't get the model to stop tool-calling, but here are the latest web results I found:\n\n${webSnippets.slice(0, 6).join("\n\n")}`
            : "I couldn't complete web search: the model kept requesting tools and no usable results were returned.";
        opts.onDelta?.(snippetFallback);
        return snippetFallback;
    }

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
