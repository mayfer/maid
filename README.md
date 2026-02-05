# maid

Mini AI Developer in your terminal, for quickly chatting with LLMs (OpenRouter or custom/local).

# Basic usage

```bash
$ maid convert m4a to wav
Using qwen/qwen3-coder-next

● Use FFmpeg:

ffmpeg -i input.m4a output.wav
```

## Run (dev)

From repo root:

```bash
bun install
bun maid.ts --help
bun maid.ts "explain this repo"
bun maid.ts --model openai/gpt-5-mini "write a short changelog"
```

If no `--model` is passed, maid uses cached selection or prompts you.

## Compile binary

```bash
bun scripts/build.ts
```

Output:

- `dist/maid`

## Install binary to ~/.local/bin/maid

```bash
./scripts/install.sh
```

Then run:

```bash
maid --help
maid "hello"
```
