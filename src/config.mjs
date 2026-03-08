import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function readFileIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function readCodexConfig() {
  const text = readFileIfExists(path.join(os.homedir(), '.codex', 'config.toml')) || '';
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+) = "([^"]+)"$/);
    if (match) {
      result[match[1]] = match[2];
    }
  }
  const providerMatch = text.match(/\[model_providers\.([^.\]]+)\][\s\S]*?base_url = "([^"]+)"/m);
  if (providerMatch && (!result.base_url || result.model_provider === providerMatch[1])) {
    result.base_url = providerMatch[2];
  }
  return result;
}

function readCodexAuth() {
  const text = readFileIfExists(path.join(os.homedir(), '.codex', 'auth.json'));
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export function loadConfig(overrides = {}) {
  const codexConfig = readCodexConfig();
  const codexAuth = readCodexAuth();
  return {
    host: process.env.CLAUDE_CODE_GMN_PROXY_HOST || '127.0.0.1',
    port: Number(process.env.CLAUDE_CODE_GMN_PROXY_PORT || 4040),
    upstreamBaseUrl: process.env.CLAUDE_CODE_GMN_PROXY_UPSTREAM_BASE_URL || codexConfig.base_url,
    upstreamApiKey: process.env.CLAUDE_CODE_GMN_PROXY_UPSTREAM_API_KEY || codexAuth.OPENAI_API_KEY,
    defaultModel: process.env.CLAUDE_CODE_GMN_PROXY_MODEL || codexConfig.model || 'gpt-5.4',
    reasoningEffort: process.env.CLAUDE_CODE_GMN_PROXY_REASONING || codexConfig.model_reasoning_effort || 'high',
    localAuthToken: process.env.CLAUDE_CODE_GMN_PROXY_AUTH_TOKEN || 'local-claude-proxy',
    ...overrides,
  };
}
