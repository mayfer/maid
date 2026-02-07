import { fetchModelsWithRanking, reasoningStream, getTopModels } from "./llm/index";
import type { StandardizedModel, ChatMessage } from "./llm/index";
import { readFileSync, existsSync } from "fs";
import { spawn } from "child_process";
import packageJson from "./package.json";
import { buildPrompt, DEFAULT_CHAT_SYSTEM_PROMPT } from "./prompt";
import {
    getCachedModelSelection,
    setCachedModelSelection,
    getConfiguredOpenRouterApiKey,
    setConfiguredOpenRouterApiKey,
    getConfiguredSystemPrompt,
    setConfiguredSystemPrompt,
    getCustomProviderConfig,
    setCustomProviderConfig,
    endpointPromptDefaultFromApiBase,
} from "./src/config";
import { runModelPicker, type ModelSelection } from "./src/ui/model-picker";

const MODEL_PICKER_ABORT = "__MODEL_PICKER_ABORT__";
const USER_PROMPT_LABEL = "\x1B[2m>\x1B[0m ";
const PRIMARY_TEXT = "\x1B[36m";
const RESET_TEXT = "\x1B[0m";
const ASSISTANT_DOT = `${PRIMARY_TEXT}●${RESET_TEXT} `;
const ASSISTANT_TYPING = "\x1B[2m…\x1B[0m";
const DIM_TEXT = "\x1B[2m";
const RUN_COMMAND_MARKER = "__RUN_COMMAND__";
const WEB_INSTALL_COMMAND = "curl -fsSL https://raw.githubusercontent.com/mayfer/maid/main/scripts/web_install.sh | bash";
const RELEASES_LATEST_URL = "https://api.github.com/repos/mayfer/maid/releases/latest";
const MAID_VERSION = normalizeVersion(typeof (packageJson as any)?.version === "string" ? (packageJson as any).version : "") || "unknown";
process.on("SIGINT", () => {
    if (process.stdout.isTTY) process.stdout.write("\n");
    process.exit(130);
});

function getCurrentVersion(): string {
    return MAID_VERSION;
}

function normalizeVersion(raw: string): string {
    return raw.trim().replace(/^v/i, "");
}

async function getLatestReleaseVersion(): Promise<string | undefined> {
    try {
        const res = await fetch(RELEASES_LATEST_URL, {
            headers: {
                "Accept": "application/vnd.github+json",
                "User-Agent": "maid-cli",
            },
        });
        if (!res.ok) return undefined;
        const body = await res.json() as { tag_name?: string };
        if (typeof body.tag_name !== "string") return undefined;
        const normalized = normalizeVersion(body.tag_name);
        return normalized || undefined;
    } catch {
        return undefined;
    }
}

function getDefaultSystemPrompt(): string {
    const configured = getConfiguredSystemPrompt();
    return buildPrompt(configured || DEFAULT_CHAT_SYSTEM_PROMPT);
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

interface CommandRunResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
}

async function runCommand(command: string): Promise<CommandRunResult> {
    return await new Promise<CommandRunResult>((resolve) => {
        const child = spawn(command, { shell: true, stdio: ["inherit", "pipe", "pipe"] });
        let sawOutput = false;
        let lastOutputEndedWithNewline = true;
        let stdoutCaptured = "";
        let stderrCaptured = "";
        let exitCode: number | null = null;

        const handleChunk = (chunk: Buffer | string, writer: (s: string) => void, capture: "stdout" | "stderr") => {
            const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
            if (!text) return;
            sawOutput = true;
            lastOutputEndedWithNewline = text.endsWith("\n");
            if (capture === "stdout") stdoutCaptured += text;
            else stderrCaptured += text;
            writer(text);
        };

        child.stdout?.on("data", (chunk) => handleChunk(chunk, (s) => process.stdout.write(s), "stdout"));
        child.stderr?.on("data", (chunk) => handleChunk(chunk, (s) => process.stderr.write(s), "stderr"));

        child.on("error", (error) => {
            console.error(`Failed to run command: ${error.message}`);
            resolve({ exitCode: 1, stdout: stdoutCaptured, stderr: `${stderrCaptured}${stderrCaptured ? "\n" : ""}${error.message}` });
        });
        child.on("exit", (code) => {
            exitCode = code;
            if (process.stdout.isTTY && sawOutput && !lastOutputEndedWithNewline) {
                process.stdout.write("\n");
            }
            resolve({ exitCode, stdout: stdoutCaptured, stderr: stderrCaptured });
        });
    });
}

function summarizeCommandOutput(result: CommandRunResult): string {
    const combined = `${result.stdout}${result.stderr ? `${result.stdout ? "\n" : ""}${result.stderr}` : ""}`.replace(/\r\n/g, "\n");
    const lines = combined.split("\n");
    const normalizedLines = lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
    if (normalizedLines.length === 0) {
        return "(no output)";
    }
    if (normalizedLines.length <= 100) {
        return normalizedLines.join("\n");
    }

    const head = normalizedLines.slice(0, 50);
    const tail = normalizedLines.slice(-50);
    const skipped = normalizedLines.length - 100;
    return `${head.join("\n")}\n... [${skipped} lines truncated] ...\n${tail.join("\n")}`;
}

async function maybePromptToRunCommand(command: string): Promise<CommandRunResult | undefined> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
    const shouldRun = await promptForRunCommandConfirmation(
        `${DIM_TEXT}Run command? ${RESET_TEXT}${PRIMARY_TEXT}Enter${RESET_TEXT}${DIM_TEXT}/${RESET_TEXT}${PRIMARY_TEXT}Esc${RESET_TEXT} `,
    );
    if (shouldRun) {
        return await runCommand(command);
    }
    return undefined;
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
        throw new Error("Missing OPENROUTER_API_KEY. Run maid interactively once to store it in ~/.config/maid.json.");
    }

    const entered = await promptForLine("OPENROUTER_API_KEY: ");
    const apiKey = entered?.trim();
    if (!apiKey) {
        throw new Error("OPENROUTER_API_KEY is required.");
    }

    setConfiguredOpenRouterApiKey(apiKey);
    process.env.OPENROUTER_API_KEY = apiKey;
}

async function runSelfUpdate(): Promise<void> {
    const currentVersion = getCurrentVersion();
    const latestVersion = await getLatestReleaseVersion();
    if (latestVersion && currentVersion !== "unknown" && normalizeVersion(currentVersion) === normalizeVersion(latestVersion)) {
        console.error(`Already up to date (v${currentVersion}).`);
        return;
    }

    console.error(`Running self-update:\n${WEB_INSTALL_COMMAND}`);
    const result = await runCommand(WEB_INSTALL_COMMAND);
    if (result.exitCode !== 0) {
        throw new Error(`Self-update failed with exit code ${result.exitCode ?? "unknown"}.`);
    }
}

async function main() {
    const args = process.argv.slice(2);
    const firstArg = args[0];

    if (firstArg === "help" || firstArg === "-h" || firstArg === "--help") {
        printHelp();
        return;
    }

    if (firstArg === "version" || firstArg === "-v" || firstArg === "--version" || args.includes("--version")) {
        console.log(getCurrentVersion());
        return;
    }

    if (firstArg === "update" || args.includes("--update")) {
        await runSelfUpdate();
        return;
    }

    if (args.length === 1 && (firstArg === "--system" || firstArg === "-s")) {
        console.log(getDefaultSystemPrompt());
        return;
    }

    // Read stdin if piped (not a TTY)
    let stdinContent: string | undefined;
    if (!process.stdin.isTTY) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
            chunks.push(chunk);
        }
        const text = Buffer.concat(chunks).toString("utf-8").trim();
        if (text.length > 0) stdinContent = text;
    }

    // No subcommands; default to chat behavior.
    if (!firstArg && !stdinContent) {
        if (process.stdin.isTTY && process.stdout.isTTY) {
            await chat([]);
        } else {
            printHelp();
        }
        return;
    }

    await chat(args, stdinContent);
}

function printHelp() {
    const version = getCurrentVersion();
    console.log(`
Usage:
  maid [prompt...] [options]
  bun maid.ts [prompt...] [options]

Version:
  ${version}

Options:
  --model <model_id>  (alias: --models, -m)
  --model             (show model picker to select new model)
  --models            (alias for --model)
  -m                  (alias for --model)
  --version           (print current version)
  --web               (enable web search)
  --update            (self-update via web installer)
  --reasoning <level> (off, low, medium, high; default: low; off is treated as low)
  --system <prompt|file>  (alias: -s; system prompt as string or path to file)
                     (default file: prompts/default-system.txt)

In interactive mode, chat continues until you type 'exit' or Ctrl+C.
Conversation history is maintained throughout the session.

Stdin is supported: piped input is prepended to any arguments.

When stdout is piped, maid emits only the assistant's plain text
(no UI chrome, no colors, no reasoning trace). Informational
messages go to stderr.

Examples:
  maid                                 # Start interactive chat
  maid hi how are you                  # Unquoted args are joined as one prompt
  maid "explain this" --web            # Use web search
  maid solve this --reasoning low      # Enable light reasoning
  maid hello --system "You are a pirate"  # String system prompt
  maid hello -s ./prompt.txt          # System prompt from file
  maid --version                       # Print current version
  maid --update                        # Install newest release
  echo "hello" | maid print this uppercase  # Stdin + args
  cat file.txt | maid summarize this       # Pipe file contents
  maid "tell me a joke" | wc -l            # Pipe output to another command
`);
}

async function promptForLine(label: string): Promise<string | undefined> {
    const stdin = process.stdin;
    const stdout = process.stdout;
    if (typeof (stdin as any).setRawMode !== "function") return undefined;
    const wasRaw = Boolean((stdin as any).isRaw);
    let value = "";
    let inBracketedPaste = false;
    let renderedRows = 1;

    // Best-effort modified-enter detection (terminal dependent).
    const isLiteralNewlineKey = (key: string) =>
        key === "\u001b\r" || // Alt+Enter in some terminals
        key === "\u001b[13;2u" || // Shift+Enter (CSI u)
        key === "\u001b[13;9u"; // Cmd+Enter (CSI u in some terminals)

    const stripAnsi = (text: string) => text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
    const visualWidth = (text: string) => {
        let width = 0;
        for (const _ch of text) width++;
        return width;
    };
    const rowsForRenderedText = (text: string) => {
        const columns = Math.max(1, stdout.columns || 80);
        return Math.max(
            1,
            text.split("\n").reduce((acc, line) => {
                const lineWidth = visualWidth(stripAnsi(line));
                return acc + Math.max(1, Math.ceil(lineWidth / columns));
            }, 0)
        );
    };
    const currentRenderedText = () => label + value;

    // Ensure render stays correct for wrapped, multiline input and deletions.
    const clearAndRender = () => {
        if (renderedRows > 1) {
            stdout.write(`\x1B[${renderedRows - 1}A`);
        }
        stdout.write("\r\x1B[J");
        const text = currentRenderedText();
        stdout.write(text);
        renderedRows = rowsForRenderedText(text);
    };

    stdout.write(label);
    renderedRows = rowsForRenderedText(currentRenderedText());

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
            renderedRows = rowsForRenderedText(currentRenderedText());
        };

        if (!wasRaw) {
            stdin.setRawMode(true);
        }
        // Ink can leave stdin paused after unmount; always resume before listening.
        if (typeof (stdin as any).ref === "function") {
            (stdin as any).ref();
        }
        stdin.resume();
        stdin.setEncoding("utf8");
        stdin.on("data", onData);
    });
}

function isModelSwitchCommand(input: string): boolean {
    const v = input.trim();
    return v === "--model" || v === "--models" || v === "-m";
}

async function promptForModelSelection(): Promise<ModelSelection | string | undefined> {
    const customConfig = getCustomProviderConfig();
    const pickerResult = await runModelPicker({
        pageSize: 10,
        initialOpenRouterApiKey: process.env.OPENROUTER_API_KEY?.trim() || getConfiguredOpenRouterApiKey(),
        initialCustomEndpoint: endpointPromptDefaultFromApiBase(customConfig.endpoint),
        initialCustomApiKey: customConfig.apiKey,
        initialSystemPrompt: getConfiguredSystemPrompt() || "",
    });

    if (pickerResult.openrouterApiKey) {
        setConfiguredOpenRouterApiKey(pickerResult.openrouterApiKey);
        process.env.OPENROUTER_API_KEY = pickerResult.openrouterApiKey;
    }
    setCustomProviderConfig({
        endpoint: pickerResult.customEndpoint,
        apiKey: pickerResult.customApiKey,
    });
    setConfiguredSystemPrompt(pickerResult.systemPrompt);

    // Reinitialize stdin after Ink unmount so prompt loop remains alive.
    const stdin = process.stdin;
    if (typeof (stdin as any).setRawMode === "function") {
        try {
            stdin.setRawMode(false);
        } catch {}
    }
    if (typeof (stdin as any).ref === "function") {
        try {
            (stdin as any).ref();
        } catch {}
    }
    stdin.resume();
    stdin.setEncoding("utf8");

    if (pickerResult.aborted) return MODEL_PICKER_ABORT;
    if (pickerResult.cancelled) return undefined;
    return pickerResult.selection;
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

function printUsingModel(modelId: string): void {
    const out = process.stdout.isTTY ? process.stdout : process.stderr;
    out.write(`${DIM_TEXT}Using ${RESET_TEXT}${modelId}\n`);
}

async function ensureProviderConfigured(provider: "openrouter" | "openai"): Promise<boolean> {
    if (provider === "openrouter") {
        try {
            await ensureOpenRouterApiKeyConfigured();
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(msg);
            return false;
        }
    }
    return true;
}

async function chat(args: string[], stdinContent?: string) {
    const stdoutPiped = !process.stdout.isTTY;
    const sessionIsInteractive = typeof (process.stdin as any).setRawMode === "function" && !stdoutPiped;
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
    const argsPrompt = nonOptionArgs.length > 0 ? nonOptionArgs.join(" ") : undefined;
    let initialPrompt = stdinContent && argsPrompt
        ? `${stdinContent}\n${argsPrompt}`
        : stdinContent || argsPrompt;

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
            } else if (stdoutPiped) {
                // Can't show model picker when stdout is piped
                console.error("--model requires a model ID when stdout is piped.");
                return;
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
                        printUsingModel(modelId);
                        if (selection.cacheable) setCachedModelSelection({ modelId, provider: modelProvider, baseUrl: modelBaseUrl });
                    } else if (!selection) {
                        const { rankings } = await fetchModelsWithRanking("openrouter");
                        const topModels = getTopModels(rankings, 1);
                        if (topModels.length > 0) {
                            modelId = topModels[0].id;
                            modelProvider = "openrouter";
                            modelBaseUrl = undefined;
                            modelApiKey = undefined;
                            process.stderr.write(`${DIM_TEXT}Using top model: ${RESET_TEXT}${topModels[0].name || modelId}\n`);
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
            printUsingModel(modelId);
        } else if (stdoutPiped) {
            // Can't show model picker when stdout is piped; use top model
            try {
                const { rankings } = await fetchModelsWithRanking("openrouter");
                const topModels = getTopModels(rankings, 1);
                if (topModels.length > 0) {
                    modelId = topModels[0].id;
                    modelProvider = "openrouter";
                    modelBaseUrl = undefined;
                    modelApiKey = undefined;
                    process.stderr.write(`${DIM_TEXT}Using top model: ${RESET_TEXT}${topModels[0].name || modelId}\n`);
                }
            } catch (error) {
                console.error("Error fetching top models:", error);
                return;
            }
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
                    printUsingModel(modelId);
                    if (selection.cacheable) setCachedModelSelection({ modelId, provider: modelProvider, baseUrl: modelBaseUrl });
                } else if (!selection) {
                    const { rankings } = await fetchModelsWithRanking("openrouter");
                    const topModels = getTopModels(rankings, 1);
                    if (topModels.length > 0) {
                        modelId = topModels[0].id;
                        modelProvider = "openrouter";
                        modelBaseUrl = undefined;
                        modelApiKey = undefined;
                        process.stderr.write(`${DIM_TEXT}Using top model: ${RESET_TEXT}${topModels[0].name || modelId}\n`);
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

    // Non-interactive one-shot mode (piped stdin or non-TTY)
    if (!sessionIsInteractive && initialPrompt) {
        const providerReady = await ensureProviderConfigured(modelProvider);
        if (!providerReady) return;
        await streamChatResponse(modelId, modelProvider, modelBaseUrl, modelApiKey, initialPrompt, messages, webSearch, reasoningEffort);
        return;
    }

    // Interactive loop for messages
    if (sessionIsInteractive) {
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
                    printUsingModel(modelId);
                    if (selection.cacheable) setCachedModelSelection({ modelId, provider: modelProvider, baseUrl: modelBaseUrl });
                }
            } catch (error) {
                console.error("Error fetching models:", error);
            }
            firstPrompt = undefined;
        }
        
        // Process the first prompt
        const providerReady = await ensureProviderConfigured(modelProvider);
        if (!providerReady) return;
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
                        printUsingModel(modelId);
                        if (selection.cacheable) setCachedModelSelection({ modelId, provider: modelProvider, baseUrl: modelBaseUrl });
                    }
                } catch (error) {
                    console.error("Error fetching models:", error);
                }
                continue;
            }

            const providerReady = await ensureProviderConfigured(modelProvider);
            if (!providerReady) {
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

    const isPiped = !process.stdout.isTTY;
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
        if (!isPiped) process.stdout.write("\x1B[1D\x1B[0K");
        ellipsisVisible = false;
    };

    const showTypingEllipsis = () => {
        if (isPiped || ellipsisVisible) return;
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

        if (!isPiped) {
            process.stdout.write(`\n${ASSISTANT_DOT}`);
            startedAssistantLine = true;
            showTypingEllipsis();
        }

        const onAnswerDelta = (delta: string) => {
            if (userStopped) return;
            sawAnyAnswerDelta = true;
            rawResponse += delta;
            removeTypingEllipsis();
            if (!startedAnswer) {
                if (sawReasoning && !isPiped) {
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
                    const out = isPiped ? process.stderr : process.stdout;
                    out.write(`\n${DIM_TEXT}[${toolName}]${details ? `: ${details}` : ""}${RESET_TEXT}\n`);
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
                    sawReasoning = true;
                    if (isPiped) return; // skip reasoning in pipe mode
                    removeTypingEllipsis();
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
        if (isPiped) {
            // End with a single newline for clean pipe output
            process.stdout.write("\n");
        } else {
            process.stdout.write(commandToRun ? "\n" : "\n\n");
        }
    } catch (error) {
        removeTypingEllipsis();
        if (startedAssistantLine && !isPiped) process.stdout.write("\n");
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
            if (!isPiped) process.stdout.write(`${DIM_TEXT}[stopped]${RESET_TEXT}\n\n`);
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

    if (commandToRun && !isPiped) {
        const runResult = await maybePromptToRunCommand(commandToRun);
        if (runResult) {
            const summarized = summarizeCommandOutput(runResult);
            messages.push({
                role: "user",
                content: [
                    `I ran this command:`,
                    `\`\`\``,
                    commandToRun,
                    `\`\`\``,
                    `Exit code: ${runResult.exitCode ?? "unknown"}`,
                    `Output (truncated to first 50 and last 50 lines when long):`,
                    `\`\`\``,
                    summarized,
                    `\`\`\``,
                ].join("\n"),
            });
            if (process.stdout.isTTY) {
                process.stdout.write("\n");
            }
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

main().catch((error) => {
    const msg = error instanceof Error ? error.stack || error.message : String(error);
    console.error(msg);
});
