# CLI Model Selection and Args Spec

Last updated: 2026-02-05

## Scope

This spec documents the current implemented behavior for:
- CLI argument parsing
- model selection UX
- cached selections
- custom endpoint support
- provider routing for chat streaming

---

## 1) Invocation and Argument Behavior

### Commands
- `maid [prompt...] [options]`
- `bun maid.ts [prompt...] [options]`

### Supported options
- `--model <model_id>` (aliases: `--models`, `-m`)
- `--model` / `--models` / `-m` with no value: opens model picker
- `--web`
- `--reasoning <off|low|medium|high>`
- `--system <prompt|file>` (alias: `-s`)

### Prompt/option parsing
- Non-option args are joined into one initial prompt.
- `--system` supports either inline string or file path.
- Interactive model switch command inside chat is supported by entering exactly:
  - `--model`
  - `--models`
  - `-m`

---

## 2) Model Selection UX

### Tabs
- `Popular`
- `Newest`
- `Custom`

### Shared controls
- `↑/↓`: move selection
- `←/→`: switch tab
- `Enter`: select highlighted model
- `Space`: show more
- typing: filter list
- `Backspace`: clear filter characters
- `Esc`: cancel picker
- `Ctrl+C`: abort picker / exit flow

### Tab data sources
- Popular: ranked OpenRouter models loaded from `fetchModelsWithRanking("openrouter")`
- Newest: OpenRouter frontend newest endpoint
- Custom: OpenAI-compatible model list from `<custom_base>/models` (see section 4)

---

## 3) Caching

### Cached model
- File: `/tmp/muchat_last_model.txt`
- Stores last selected **non-custom** model id.
- Used as default on next run when `--model` not explicitly forcing picker.

### Cached model selection (current)
- File: `/tmp/muchat_last_model_selection.json`
- Stores last selected model + provider + optional base URL.
- Includes custom/local selections, so relaunch reuses local model mode.
- Legacy `/tmp/muchat_last_model.txt` is still written for backward compatibility.

### Cached custom endpoint
- File: `/tmp/muchat_custom_endpoint.txt`
- Stores normalized custom base URL.
- Used as default value when configuring Custom tab.

### Not cached
- Custom API key is intentionally not persisted.

---

## 4) Custom Endpoint Mode (OpenAI-Compatible)

### Endpoint normalization
- User enters endpoint (default shown as last used, fallback `http://127.0.0.1:1234`).
- CLI normalizes to `<endpoint>/v1` base.

### Model discovery
- Request: `GET <baseUrl>/models`
- Optional header: `Authorization: Bearer <apiKey>` when api key is provided.
- Supports extracting model ids from common shapes:
  - `{ models: [...] }`
  - `{ data: [...] }`
  - `{ data: { models: [...] } }`

### Chat generation (custom mode)
- Request: `POST <baseUrl>/chat/completions`
- Body includes:
  - `model`
  - `messages`
  - `stream: true`
- Streaming:
  - Parses `text/event-stream` chunks
  - Reads `choices[0].delta.content`
  - Prints incremental output live
- Non-SSE fallback:
  - Parses JSON and uses `choices[0].message.content` or `output_text` when present

### Provider routing
- OpenRouter tabs use provider `openrouter`.
- Custom tab selections use provider `openai` with overridden `baseUrl` and optional `apiKey`.

---

## 5) Async/Race Handling in Picker

- Newest tab fetches are abortable and canceled when leaving tab.
- Custom tab model fetches are abortable and canceled when leaving tab.
- Stale async results are ignored via sequence guards.
- Redraw is suppressed during line-prompt mode to avoid prompt/UI overlap.

---

## 6) Current Known Gaps / Next Work

### Implemented after initial draft
- `Esc` during streaming now stops in-flight response and returns to prompt.
- Partial streamed assistant output is preserved in history when stopped.
- `Ctrl+C` still exits process.
- Prompt input now supports multiline paste without truncating at first newline.
- Prompt Enter still submits message.
- Best-effort modified-enter support (`Alt+Enter`, some `Shift/Cmd+Enter` terminal sequences) inserts literal newline.

### Notes for next implementation
- Terminal key handling for modified-enter is terminal-dependent; behavior can vary by emulator/config.
