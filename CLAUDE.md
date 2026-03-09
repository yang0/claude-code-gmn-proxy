# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development commands

- Requires Node.js >= 20 (`package.json`).
- Install dependencies: this package currently has no npm dependencies, so `npm install` is usually only needed to create/update the lockfile or for normal npm workflow.
- Start the local proxy server directly:
  ```bash
  npm start
  # or
  node src/server.mjs
  ```
- Run the full test suite:
  ```bash
  npm test
  # or
  node --test tests/*.test.mjs
  ```
- Run a single test file:
  ```bash
  node --test tests/server.test.mjs
  ```
- Run a specific test by name:
  ```bash
  node --test --test-name-pattern "requires auth" tests/server.test.mjs
  ```
- Install the optional systemd user service:
  ```bash
  cloud-code-proxy-install-service
  ```
- Check proxy status:
  ```bash
  cloud-code-proxy-status
  ```
- Stop the proxy:
  ```bash
  cloud-code-proxy-stop
  ```

There are currently no dedicated build or lint scripts in `package.json`; the project runs directly as Node ESM.

## High-level architecture

This repository is a small Node ESM bridge that lets Claude Code talk to the model/provider already configured for Codex.

End-to-end flow:
1. `src/config.mjs` reads Codex configuration from `~/.codex/config.toml` and auth from `~/.codex/auth.json`, then merges environment overrides.
2. `src/server.mjs` exposes a local Anthropic-compatible HTTP API (`/v1/messages`, `/v1/models`, `/health`, token counting, and no-op telemetry endpoints).
3. `src/translator.mjs` is the protocol bridge: it converts Anthropic-style requests into OpenAI Responses API payloads and maps normal + streaming responses back into Anthropic message/SSE shapes.
4. `src/runtime.mjs` manages proxy lifecycle and Claude CLI execution. It can reuse a systemd user service when installed, otherwise it starts a detached local Node process and tracks state in `~/.claude-code-gmn-proxy/`.
5. CLI entrypoints in `bin/*.mjs` are thin wrappers around runtime helpers:
   - `claude-codex` / `cloud-code` run Claude Code against the local proxy.
   - `cloud-code-proxy-install-service`, `cloud-code-proxy-status`, and `cloud-code-proxy-stop` manage the background proxy.
6. `src/systemd.mjs` renders and installs the optional user service unit at `~/.config/systemd/user/claude-code-gmn-proxy.service`.

## Important implementation notes

- The repo intentionally avoids external runtime dependencies and uses Node built-ins (`http`, `fetch`, `child_process`, `fs`, etc.).
- `src/translator.mjs` is the main place to update when changing request/response semantics, tool handling, or SSE behavior.
- `src/server.mjs` is intentionally thin: routing/auth lives there, but request/response shape conversion belongs in the translator.
- `src/runtime.mjs` is the main orchestration layer for process management, health checks, Claude CLI discovery, and env wiring (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`).
- Local proxy auth is separate from upstream auth:
  - upstream OpenAI-compatible credentials come from Codex config/auth
  - local Claude-to-proxy auth uses `CLAUDE_CODE_GMN_PROXY_AUTH_TOKEN` (default `local-claude-proxy`)

## Tests

The tests are integration-focused and map closely to the main subsystems:
- `tests/translator.test.mjs`: Anthropic ↔ OpenAI payload mapping and streaming event conversion
- `tests/server.test.mjs`: HTTP routes, auth enforcement, and upstream proxying
- `tests/runtime.test.mjs`: detached process state handling
- `tests/systemd.test.mjs`: generated systemd unit contents

## Reference docs

- `README.md`: install, usage, and local development commands
- `docs/install.md`: install and quick verification flow
- `docs/systemd-user-service.md`: background service workflow
