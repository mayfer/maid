# maid

Mini AI Developer in your terminal, for quickly chatting with LLMs (OpenRouter or custom/local).

# Features

* Instantly ask for a command and run it
* All OpenRouter models are listed the moment they come out, no app updates needed
* Easily list Popular / Recent models on OpenRouter

# Install

```bash
curl -fsSL https://raw.githubusercontent.com/mayfer/maid/main/scripts/web_install.sh | bash
```

Supports macOS (Apple Silicon, Intel) and Linux (x86_64, ARM64).

# Basic usage

```console
$ maid convert skunks.m4a to wav
Using qwen/qwen3-coder-next

● ffmpeg -i skunks.m4a skunks.wav

Run command? y/n
```

or

```console
$ maid
Using qwen/qwen3-coder-next

> hey

● Hello! How can I help you today?

> 
```

## Run (dev)

From repo root:

```bash
bun install
bun maid.ts --help
```

If no `--model` is passed, maid uses cached selection or prompts you.

## Compile binary

```command
$ bun scripts/build.ts
Builds stand-alone executable in dist/maid
```

## Compile & Install binary to ~/.local/bin/maid

```bash
./scripts/install.sh
```

## Additional features

* You can type `-m` anytime in chat mode to change model
* Settings go in ~/.config/maid.json
* Popular & newest OpenRouter models (or local models) are easily selectable
* It will ask for OpenRouter API key if OPENROUTER_API_KEY env var is not set
