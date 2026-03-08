# Installation

## Prerequisites

1. Codex is already installed and working on the machine.
2. Codex has a usable `~/.codex/config.toml` and `~/.codex/auth.json`.
3. Claude Code is installed:

```bash
npm install -g @anthropic-ai/claude-code
```

## Install This Bridge

Recommended:

```bash
npm install -g github:yang0/claude-code-gmn-proxy
```

After that, this should work immediately:

```bash
claude-codex
```

You can also use the alias:

```bash
cloud-code
```

## Quick Verification

```bash
claude-codex -p 'Reply with PONG only.' --output-format json
```
