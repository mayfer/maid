import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, render, useInput } from "ink";
import type { StandardizedModel } from "../../llm/index";
import { DEFAULT_CHAT_SYSTEM_PROMPT } from "../../prompt";
import { fetchCustomEndpointModels, fetchNewestOpenRouterModels, fetchPopularOpenRouterModels, validateOpenRouterApiKey } from "../model/sources";
import { normalizeCustomEndpointToApiBase } from "../config";

type Tab = "popular" | "newest" | "custom" | "settings";
type Mode = "browse" | "edit_openrouter_key" | "edit_custom_endpoint" | "edit_custom_key" | "edit_system_prompt";

export interface ModelSelection {
  modelId: string;
  provider: "openrouter" | "openai";
  baseUrl?: string;
  apiKey?: string;
  cacheable: boolean;
}

export interface ModelPickerOutcome {
  selection?: ModelSelection;
  openrouterApiKey?: string;
  customEndpoint: string;
  customApiKey?: string;
  systemPrompt?: string;
  aborted?: boolean;
  cancelled?: boolean;
}

interface ModelPickerProps {
  pageSize: number;
  initialOpenRouterApiKey?: string;
  initialCustomEndpoint: string;
  initialCustomApiKey?: string;
  initialSystemPrompt?: string;
  onDone: (result: ModelPickerOutcome) => void;
}

function tabLabel(tab: Tab): string {
  if (tab === "popular") return "Popular";
  if (tab === "newest") return "Newest";
  if (tab === "custom") return "Custom";
  return "Settings";
}

function nextTab(tab: Tab): Tab {
  if (tab === "popular") return "newest";
  if (tab === "newest") return "custom";
  if (tab === "custom") return "settings";
  return "popular";
}

function prevTab(tab: Tab): Tab {
  if (tab === "popular") return "custom";
  if (tab === "newest") return "popular";
  if (tab === "custom") return "newest";
  return "custom";
}

function normalizeInput(base: string): string {
  return base.trim();
}

function ModelPickerApp(props: ModelPickerProps) {
  const [activeTab, setActiveTab] = useState<Tab>("popular");
  const [mode, setMode] = useState<Mode>("browse");
  const [draftValue, setDraftValue] = useState("");
  const [statusLine, setStatusLine] = useState<string>("");
  const [isValidatingOpenRouterKey, setIsValidatingOpenRouterKey] = useState(false);

  const [openrouterApiKey, setOpenrouterApiKey] = useState(props.initialOpenRouterApiKey || "");
  const [customEndpoint, setCustomEndpoint] = useState(normalizeCustomEndpointToApiBase(props.initialCustomEndpoint));
  const [customApiKey, setCustomApiKey] = useState(props.initialCustomApiKey || "");
  const [systemPrompt, setSystemPrompt] = useState(props.initialSystemPrompt || "");

  const [filter, setFilter] = useState("");
  const [shown, setShown] = useState(props.pageSize);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const [popularModels, setPopularModels] = useState<StandardizedModel[] | undefined>(undefined);
  const [newestModels, setNewestModels] = useState<StandardizedModel[] | undefined>(undefined);
  const [customModels, setCustomModels] = useState<StandardizedModel[] | undefined>(undefined);

  const [popularLoading, setPopularLoading] = useState(false);
  const [newestLoading, setNewestLoading] = useState(false);
  const [customLoading, setCustomLoading] = useState(false);

  const [popularError, setPopularError] = useState<string | undefined>(undefined);
  const [newestError, setNewestError] = useState<string | undefined>(undefined);
  const [customError, setCustomError] = useState<string | undefined>(undefined);

  const hasOpenRouterKey = openrouterApiKey.trim().length > 0;

  const baseModels = useMemo(() => {
    if (activeTab === "popular") return popularModels || [];
    if (activeTab === "newest") return newestModels || [];
    if (activeTab === "custom") return customModels || [];
    return [];
  }, [activeTab, popularModels, newestModels, customModels]);

  const matchingModels = useMemo(() => {
    if (!filter) return baseModels;
    const q = filter.toLowerCase();
    return baseModels.filter((m) => (m.name || m.id).toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
  }, [baseModels, filter]);

  const filteredModels = useMemo(() => matchingModels.slice(0, shown), [matchingModels, shown]);

  const resetListCursor = () => {
    setSelectedIndex(0);
    setShown(props.pageSize);
  };

  useEffect(() => {
    resetListCursor();
    setFilter("");
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== "popular") return;
    if (!hasOpenRouterKey) return;
    if (popularModels || popularLoading) return;

    setPopularLoading(true);
    setPopularError(undefined);

    fetchPopularOpenRouterModels(openrouterApiKey)
      .then((models) => setPopularModels(models))
      .catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        setPopularError(msg);
      })
      .finally(() => setPopularLoading(false));
  }, [activeTab, hasOpenRouterKey, popularModels, openrouterApiKey]);

  useEffect(() => {
    if (activeTab !== "newest") return;
    if (!hasOpenRouterKey) return;
    if (newestModels || newestLoading) return;

    const controller = new AbortController();
    setNewestLoading(true);
    setNewestError(undefined);

    fetchNewestOpenRouterModels(openrouterApiKey, controller.signal)
      .then((models) => setNewestModels(models))
      .catch((error) => {
        if (error instanceof Error && error.name === "AbortError") return;
        const msg = error instanceof Error ? error.message : String(error);
        setNewestError(msg);
      })
      .finally(() => setNewestLoading(false));

    return () => controller.abort();
  }, [activeTab, hasOpenRouterKey, newestModels, openrouterApiKey]);

  useEffect(() => {
    if (activeTab !== "custom") return;
    if (customLoading) return;
    if (customModels) return;

    const controller = new AbortController();
    setCustomLoading(true);
    setCustomError(undefined);

    fetchCustomEndpointModels(customEndpoint, customApiKey || undefined, controller.signal)
      .then((ids) => setCustomModels(ids.map((id) => ({ id, name: id, provider: "openai" as const }))))
      .catch((error) => {
        if (error instanceof Error && error.name === "AbortError") return;
        const msg = error instanceof Error ? error.message : String(error);
        setCustomError(msg);
        setCustomModels([]);
      })
      .finally(() => setCustomLoading(false));

    return () => controller.abort();
  }, [activeTab, customEndpoint, customApiKey, customModels]);

  const handleInput = async (input: string, key: any) => {
    if (input === "\u0003" || (key.ctrl && (input === "c" || input === "C"))) {
      if (process.stdout.isTTY) process.stdout.write("\n");
      process.exit(130);
      return;
    }

    if (isValidatingOpenRouterKey) {
      return;
    }

    if (mode !== "browse") {
      if (key.escape) {
        setMode("browse");
        setDraftValue("");
        setStatusLine("");
        return;
      }
      if (key.return) {
        const value = normalizeInput(draftValue);
        if (mode === "edit_openrouter_key") {
          if (!value) {
            setStatusLine("OpenRouter API key cannot be blank.");
            return;
          }
          setIsValidatingOpenRouterKey(true);
          setStatusLine("Validating OpenRouter key...");
          try {
            const keyMeta = await validateOpenRouterApiKey(value);
            setOpenrouterApiKey(value);
            setPopularModels(undefined);
            setNewestModels(undefined);
            setPopularError(undefined);
            setNewestError(undefined);
            const labelPart = keyMeta.label ? ` ${keyMeta.label}` : "";
            const freeTierPart = keyMeta.isFreeTier === true ? " [free-tier]" : "";
            setStatusLine(`OpenRouter key valid.${labelPart}${freeTierPart}`);
            setMode("browse");
            setDraftValue("");
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            setStatusLine(`OpenRouter key test failed: ${msg}`);
          } finally {
            setIsValidatingOpenRouterKey(false);
          }
          return;
        } else if (mode === "edit_custom_endpoint") {
          const normalized = normalizeCustomEndpointToApiBase(value || "http://127.0.0.1:1234");
          setCustomEndpoint(normalized);
          setCustomModels(undefined);
          setCustomError(undefined);
          setStatusLine(`Custom endpoint set to ${normalized}. Configure key (optional).`);
          setMode("edit_custom_key");
          setDraftValue(customApiKey);
          return;
        } else if (mode === "edit_custom_key") {
          setCustomApiKey(value);
          setCustomModels(undefined);
          setCustomError(undefined);
          setStatusLine(value ? "Saved custom API key." : "Custom API key cleared.");
        } else if (mode === "edit_system_prompt") {
          setSystemPrompt(value);
          setStatusLine(value ? "Saved custom system prompt." : "Custom system prompt cleared.");
        }
        setMode("browse");
        setDraftValue("");
        return;
      }
      const isBackspaceInput = input === "\u007f" || input === "\b";
      if (key.backspace || key.delete || isBackspaceInput) {
        setDraftValue((curr) => curr.slice(0, -1));
        return;
      }
      if (input && !key.return) {
        // Accept pasted/typed text broadly; strip control chars.
        const clean = input.replace(/[\u0000-\u001F\u007F]/g, "");
        if (clean.length > 0) {
          setDraftValue((curr) => curr + clean);
        }
      }
      return;
    }

    if (key.escape) {
      if (filter.length > 0) {
        setFilter("");
        setSelectedIndex(0);
        return;
      }
      if (statusLine) {
        setStatusLine("");
        return;
      }
      if (activeTab === "popular" && popularError) {
        setPopularError(undefined);
        return;
      }
      if (activeTab === "newest" && newestError) {
        setNewestError(undefined);
        return;
      }
      if (activeTab === "custom" && customError) {
        setCustomError(undefined);
        return;
      }
      return;
    }

    if (key.leftArrow) {
      setActiveTab((curr) => prevTab(curr));
      return;
    }

    if (key.rightArrow) {
      setActiveTab((curr) => nextTab(curr));
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((curr) => Math.max(0, curr - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((curr) => Math.min(Math.max(filteredModels.length - 1, 0), curr + 1));
      return;
    }

    if (input === " ") {
      setShown((curr) => Math.min(curr + props.pageSize, matchingModels.length));
      return;
    }

    if (input === "k" || input === "K") {
      if (activeTab === "popular" || activeTab === "newest") {
        setMode("edit_openrouter_key");
        setDraftValue(openrouterApiKey);
      } else if (activeTab === "custom") {
        setMode("edit_custom_endpoint");
        setDraftValue(customEndpoint.replace(/\/v1$/i, ""));
      } else {
        setMode("edit_system_prompt");
        setDraftValue(systemPrompt);
      }
      return;
    }

    if (key.backspace || key.delete) {
      if (filter.length > 0) {
        setFilter((curr) => curr.slice(0, -1));
        setSelectedIndex(0);
      }
      return;
    }

    if (key.return) {
      if (activeTab === "settings") {
        setStatusLine("Press 'k' to edit the custom system prompt.");
        return;
      }
      const selected = filteredModels[selectedIndex];
      if (!selected) return;

      if ((activeTab === "popular" || activeTab === "newest") && !hasOpenRouterKey) {
        setStatusLine("OpenRouter API key is required for this tab. Press 'k'.");
        return;
      }

      props.onDone({
        selection: {
          modelId: selected.id,
          provider: activeTab === "custom" ? "openai" : "openrouter",
          baseUrl: activeTab === "custom" ? customEndpoint : undefined,
          apiKey: activeTab === "custom" ? (customApiKey || "local") : undefined,
          cacheable: true,
        },
        openrouterApiKey: openrouterApiKey || undefined,
        customEndpoint,
        customApiKey: customApiKey || undefined,
        systemPrompt: systemPrompt || undefined,
      });
      return;
    }

    if (activeTab === "settings") {
      return;
    }

    if (input.length === 1 && input.charCodeAt(0) >= 32 && input.charCodeAt(0) < 127) {
      setFilter((curr) => curr + input);
      setSelectedIndex(0);
      return;
    }
  };

  useInput((input, key) => {
    void handleInput(input, key);
  });

  const showOpenRouterWarning = (activeTab === "popular" || activeTab === "newest") && !hasOpenRouterKey;
  const displayedSystemPrompt = systemPrompt || DEFAULT_CHAT_SYSTEM_PROMPT;

  const activeLoading = activeTab === "popular" ? popularLoading : activeTab === "newest" ? newestLoading : customLoading;
  const activeError = activeTab === "popular" ? popularError : activeTab === "newest" ? newestError : customError;

  return (
    <Box flexDirection="column">
      <Box>
        {["popular", "newest", "custom", "settings"].map((raw, index, all) => {
          const tab = raw as Tab;
          const active = tab === activeTab;
          return (
            <Text key={tab} color={active ? "cyan" : "gray"}>
              {active ? `[${tabLabel(tab)}]` : ` ${tabLabel(tab)} `}
              <Text color="gray">{index < all.length - 1 ? "  |  " : ""}</Text>
            </Text>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text>
          {activeTab === "settings"
            ? "Settings"
            : showOpenRouterWarning
            ? `OpenRouter setup required for ${tabLabel(activeTab)}`
            : filter
            ? `Filter: "${filter}" (${Math.min(filteredModels.length, matchingModels.length)}/${matchingModels.length})`
            : `Pick a model from ${tabLabel(activeTab)} (${Math.min(shown, baseModels.length)}/${baseModels.length})`}
        </Text>
      </Box>

      {activeTab === "custom" && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">Endpoint: {customEndpoint}</Text>
          <Text color="gray">API key: {customApiKey ? "[set]" : "[blank]"}</Text>
        </Box>
      )}

      {activeTab === "settings" && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">System prompt: {systemPrompt ? "[custom]" : "[default]"}</Text>
          <Text color="gray">
            {systemPrompt
              ? "Press 'k' to edit. Empty value restores built-in default prompt."
              : "Using built-in default prompt. Press 'k' to set a custom one."}
          </Text>
          <Box marginTop={1}>
            <Text>{displayedSystemPrompt}</Text>
          </Box>
        </Box>
      )}

      {showOpenRouterWarning && (
        <Box marginTop={1}>
          <Text color="yellow">OpenRouter key missing. Press 'k' to configure this tab group.</Text>
        </Box>
      )}

      {activeLoading && (
        <Box marginTop={1}>
          <Text color="gray">Loading models...</Text>
        </Box>
      )}

      {activeError && (
        <Box marginTop={1}>
          <Text color="red">{activeError}</Text>
        </Box>
      )}

      {!activeLoading && !showOpenRouterWarning && activeTab !== "settings" && (
        <Box flexDirection="column" marginTop={1}>
          {filteredModels.length === 0 ? (
            <Text color="gray">No models match your filter.</Text>
          ) : (
            filteredModels.map((m, i) => (
              <Text key={`${m.id}-${i}`} color={i === selectedIndex ? "cyan" : undefined}>
                {i === selectedIndex ? "> " : "  "}
                {i + 1}) {m.name || m.id}
              </Text>
            ))
          )}
        </Box>
      )}

      {statusLine && (
        <Box marginTop={1}>
          <Text color="yellow">{statusLine}</Text>
        </Box>
      )}

      {mode !== "browse" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            {mode === "edit_openrouter_key"
              ? "OpenRouter API key"
              : mode === "edit_custom_endpoint"
                ? "Custom endpoint"
                : mode === "edit_custom_key"
                  ? "Custom API key (optional)"
                  : "Custom system prompt"}
          </Text>
          <Box borderStyle="round" borderColor="cyan" paddingX={1}>
            <Text color="cyan">
              {(mode === "edit_custom_endpoint"
                ? (draftValue || "http://127.0.0.1:1234")
                : draftValue) + "█"}
            </Text>
          </Box>
          <Text color="gray">[Enter] Save  [Esc] Exit input</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="gray">
          [←→] Tabs [↑↓] Lists  [Space] More [Enter] Select [k] Configure [Esc] Reset
        </Text>
      </Box>
    </Box>
  );
}

export function runModelPicker(options: {
  pageSize?: number;
  initialOpenRouterApiKey?: string;
  initialCustomEndpoint: string;
  initialCustomApiKey?: string;
  initialSystemPrompt?: string;
}): Promise<ModelPickerOutcome> {
  return new Promise((resolve) => {
    let done = false;
    const app = render(
      <ModelPickerApp
        pageSize={options.pageSize || 10}
        initialOpenRouterApiKey={options.initialOpenRouterApiKey}
        initialCustomEndpoint={options.initialCustomEndpoint}
        initialCustomApiKey={options.initialCustomApiKey}
        initialSystemPrompt={options.initialSystemPrompt}
        onDone={(result) => {
          if (done) return;
          done = true;
          try {
            app.clear();
          } catch {}
          try {
            app.unmount();
          } catch {}
          // Return result after Ink teardown to avoid stdin races.
          queueMicrotask(() => resolve(result));
        }}
      />,
      { exitOnCtrlC: false },
    );
  });
}
