# Claude Code GMN Proxy

[中文说明](./README.zh-CN.md)

Run Claude Code against the model/provider that is already configured for Codex.

## Goal

On a machine where Codex already works:

1. Install Claude Code
2. Install this bridge
3. Run `claude-codex`

No manual gateway rewriting should be required.

## How It Works

- Reads the active Codex model/provider config from `~/.codex/config.toml`
- Reads the upstream key from `~/.codex/auth.json`
- Exposes a local Anthropic-compatible endpoint for Claude Code
- Translates Claude Code `POST /v1/messages` requests into OpenAI `POST /v1/responses`
- Starts the local proxy automatically when you run `claude-codex`

## Install

Install Claude Code first:

```bash
npm install -g @anthropic-ai/claude-code
```

Then install this bridge:

```bash
npm install -g github:yang0/claude-code-gmn-proxy
```

## Usage

Interactive:

```bash
claude-codex
```

Non-interactive:

```bash
claude-codex -p 'Reply with PONG only.' --output-format json
```

Alias:

```bash
cloud-code
```

## Optional: systemd User Service

Install a background user service:

```bash
cloud-code-proxy-install-service
```

See [docs/systemd-user-service.md](./docs/systemd-user-service.md).

## Local Development

```bash
npm test
node src/server.mjs
```

## Notes

- The bridge is designed around the Claude Code CLI flow, not the full Anthropic API surface.
- The proxy can start on demand without systemd.
- If a user service is installed, the launcher will reuse it.
