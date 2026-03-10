import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { configFingerprint } from './config-fingerprint.mjs';
import { SERVICE_NAME, serviceIsInstalled } from './systemd.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const stateDir = path.join(os.homedir(), '.claude-code-gmn-proxy');
const pidFile = path.join(stateDir, 'proxy.pid');
const logFile = path.join(stateDir, 'proxy.log');

export function getPackageRoot() {
  return packageRoot;
}

export function getNodeBinary() {
  return process.execPath;
}

export function getConfig() {
  const config = loadConfig();
  if (!config.upstreamBaseUrl) {
    throw new Error('Codex upstream base URL not found. Configure ~/.codex/config.toml first.');
  }
  if (!config.upstreamApiKey) {
    throw new Error('Codex upstream API key not found. Configure ~/.codex/auth.json first.');
  }
  return config;
}

function isExecutable(filePath) {
  try {
    const stats = fsSync.statSync(filePath);
    if (!stats.isFile()) {
      return false;
    }
    if (process.platform === 'win32') {
      return true;
    }
    fsSync.accessSync(filePath, fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function buildPathCandidates(command) {
  if (process.platform !== 'win32') {
    return [command];
  }
  if (path.extname(command)) {
    return [command];
  }
  const extensions = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean);
  return [command, ...extensions.map((extension) => `${command}${extension}`)];
}

function findBinaryOnPath(command) {
  const rawPath = process.env.PATH || '';
  for (const entry of rawPath.split(path.delimiter)) {
    const dir = entry.replace(/^"(.*)"$/, '$1');
    if (!dir) {
      continue;
    }
    for (const candidate of buildPathCandidates(command)) {
      const fullPath = path.join(dir, candidate);
      if (isExecutable(fullPath)) {
        return fullPath;
      }
    }
  }
  return null;
}

export async function proxyHealth(config = getConfig()) {
  try {
    const res = await fetch(`http://${config.host}:${config.port}/health`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function proxyMatchesConfig(health, config) {
  return Boolean(
    health?.ok &&
    health.default_model === config.defaultModel &&
    health.upstream_base_url === config.upstreamBaseUrl &&
    health.config_fingerprint === configFingerprint(config),
  );
}

export function findClaudeBinary() {
  const override = process.env.CLAUDE_CODE_CLI;
  if (override) {
    return override;
  }
  const bin = findBinaryOnPath('claude');
  if (!bin) {
    throw new Error('Claude Code CLI not found. Install it first with: npm install -g @anthropic-ai/claude-code');
  }
  return bin;
}

async function ensureStateDir() {
  await fs.mkdir(stateDir, { recursive: true });
}

function resolvePidFile(customStateDir) {
  return path.join(customStateDir || stateDir, 'proxy.pid');
}

function systemctlAvailable() {
  return process.platform === 'linux' && Boolean(findBinaryOnPath('systemctl'));
}

function readCommandLineForPid(pid) {
  if (process.platform === 'linux') {
    return fs.readFile(`/proc/${pid}/cmdline`, 'utf8');
  }

  if (process.platform === 'win32') {
    const shell = findBinaryOnPath('pwsh') || findBinaryOnPath('powershell');
    if (!shell) {
      return Promise.resolve(null);
    }
    const result = spawnSync(shell, [
      '-NoProfile',
      '-Command',
      `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($process) { $process.CommandLine }`,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0) {
      return Promise.resolve(null);
    }
    return Promise.resolve(result.stdout.trim() || null);
  }

  const result = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) {
    return Promise.resolve(null);
  }
  return Promise.resolve(result.stdout.trim() || null);
}

async function startDetachedProxy(config) {
  await ensureStateDir();
  const out = await fs.open(logFile, 'a');
  try {
    const child = spawn(getNodeBinary(), [path.join(packageRoot, 'src', 'server.mjs')], {
      detached: true,
      stdio: ['ignore', out.fd, out.fd],
      env: {
        ...process.env,
        CLAUDE_CODE_GMN_PROXY_HOST: config.host,
        CLAUDE_CODE_GMN_PROXY_PORT: String(config.port),
        CLAUDE_CODE_GMN_PROXY_UPSTREAM_BASE_URL: config.upstreamBaseUrl,
        CLAUDE_CODE_GMN_PROXY_UPSTREAM_API_KEY: config.upstreamApiKey,
        CLAUDE_CODE_GMN_PROXY_MODEL: config.defaultModel,
        CLAUDE_CODE_GMN_PROXY_REASONING: config.reasoningEffort,
        CLAUDE_CODE_GMN_PROXY_AUTH_TOKEN: config.localAuthToken,
      },
    });
    child.unref();
    await fs.writeFile(pidFile, `${child.pid}\n`);
  } finally {
    await out.close();
  }
}

async function startViaSystemd() {
  spawnSync('systemctl', ['--user', 'start', SERVICE_NAME], { stdio: 'ignore' });
}

async function restartViaSystemd() {
  spawnSync('systemctl', ['--user', 'restart', SERVICE_NAME], { stdio: 'ignore' });
}

async function waitForProxyShutdown(config, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await proxyHealth(config)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

export async function ensureProxyAvailable(config = getConfig()) {
  const health = await proxyHealth(config);
  if (proxyMatchesConfig(health, config)) {
    return config;
  }

  const useSystemd = systemctlAvailable() && serviceIsInstalled();
  if (health) {
    if (useSystemd) {
      if (await detachedProxyPidLooksOwnedByCurrentPackage()) {
        await stopDetachedProxyOnly();
        if (!await waitForProxyShutdown(config)) {
          throw new Error(`Existing detached proxy on http://${config.host}:${config.port} did not stop before restarting systemd service`);
        }
      }
      await restartViaSystemd();
    } else {
      if (!await detachedProxyPidLooksOwnedByCurrentPackage()) {
        throw new Error(`Existing proxy on http://${config.host}:${config.port} is not owned by this package and cannot be restarted automatically`);
      }
      await stopDetachedProxyOnly();
      if (!await waitForProxyShutdown(config)) {
        throw new Error(`Existing proxy on http://${config.host}:${config.port} did not stop after configuration drift`);
      }
      await startDetachedProxy(config);
    }
  } else {
    if (useSystemd) {
      await startViaSystemd();
    } else {
      await startDetachedProxy(config);
    }
  }

  for (let i = 0; i < 40; i += 1) {
    if (proxyMatchesConfig(await proxyHealth(config), config)) {
      return config;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Claude Code proxy did not become healthy. Check ${logFile}`);
}

export async function stopDetachedProxyOnly({ stateDir: customStateDir } = {}) {
  const customPidFile = resolvePidFile(customStateDir);
  try {
    const pid = Number((await fs.readFile(customPidFile, 'utf8')).trim());
    if (Number.isFinite(pid) && pid > 0) {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // ignore stale or missing pid state
  }
  await fs.rm(customPidFile, { force: true });
}

export async function detachedProxyPidLooksOwnedByCurrentPackage({ stateDir: customStateDir } = {}) {
  const customPidFile = resolvePidFile(customStateDir);
  try {
    const pid = Number((await fs.readFile(customPidFile, 'utf8')).trim());
    if (!Number.isFinite(pid) || pid <= 0) {
      return false;
    }
    const cmdline = await readCommandLineForPid(pid);
    return Boolean(cmdline && cmdline.includes(path.join(packageRoot, 'src', 'server.mjs')));
  } catch {
    return false;
  }
}

function hasModelArg(argv) {
  return argv.some((arg, index) => arg === '--model' || (index > 0 && argv[index - 1] === '--model') || arg.startsWith('--model='));
}

export function buildClaudeSettingsOverride(config) {
  return {
    env: {
      ANTHROPIC_BASE_URL: `http://${config.host}:${config.port}`,
      ANTHROPIC_AUTH_TOKEN: config.localAuthToken,
      ANTHROPIC_API_KEY: config.localAuthToken,
    },
  };
}

function stripConflictingClaudeArgs(argv) {
  const stripped = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--settings' || arg === '--setting-sources') {
      i += 1;
      continue;
    }
    if (arg.startsWith('--settings=') || arg.startsWith('--setting-sources=')) {
      continue;
    }
    stripped.push(arg);
  }
  return stripped;
}

export function buildClaudeArgs(argv, config, settingsPath) {
  const cleanArgv = stripConflictingClaudeArgs(argv);
  const modelArgs = hasModelArg(cleanArgv) ? cleanArgv : ['--model', config.defaultModel, ...cleanArgv];
  return ['--settings', settingsPath, ...modelArgs];
}

function shouldUseShellForCommand(command) {
  return process.platform === 'win32' && ['.cmd', '.bat'].includes(path.extname(command).toLowerCase());
}

function exitCodeForSignal(signal) {
  return {
    SIGHUP: 129,
    SIGINT: 130,
    SIGTERM: 143,
  }[signal] || 1;
}

export async function execClaudeWithProxy(argv) {
  const config = await ensureProxyAvailable();
  const claude = findClaudeBinary();
  await ensureStateDir();
  const settingsPath = path.join(stateDir, `claude-settings-${process.pid}-${Date.now()}.json`);
  await fs.writeFile(settingsPath, `${JSON.stringify(buildClaudeSettingsOverride(config))}\n`);
  const args = buildClaudeArgs(argv, config, settingsPath);
  let forwardedSignal = null;
  const cleanupSettingsFile = () => {
    try {
      fsSync.rmSync(settingsPath, { force: true });
    } catch {
      // ignore cleanup failures for temp settings
    }
  };
  const child = spawn(claude, args, {
    shell: shouldUseShellForCommand(claude),
    stdio: 'inherit',
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://${config.host}:${config.port}`,
      ANTHROPIC_AUTH_TOKEN: config.localAuthToken,
      ANTHROPIC_API_KEY: config.localAuthToken,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || '1',
    },
  });
  const signalHandlers = new Map();
  const disposeCleanupHooks = () => {
    process.off('exit', cleanupSettingsFile);
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    signalHandlers.clear();
  };
  const forwardSignalToChild = (signal) => {
    forwardedSignal = signal;
    cleanupSettingsFile();
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(signal);
      } catch {
        // child may already be gone
      }
    }
  };
  process.on('exit', cleanupSettingsFile);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => forwardSignalToChild(signal);
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  await new Promise((resolve, reject) => {
    child.on('error', (error) => {
      disposeCleanupHooks();
      cleanupSettingsFile();
      reject(error);
    });
    child.on('exit', (code, signal) => {
      disposeCleanupHooks();
      cleanupSettingsFile();
      const exitSignal = signal || forwardedSignal;
      if (exitSignal) {
        process.exit(exitCodeForSignal(exitSignal));
        return;
      }
      process.exit(code ?? 0);
      resolve();
    });
  });
}

export async function stopProxy(config = getConfig()) {
  if (systemctlAvailable() && serviceIsInstalled()) {
    spawnSync('systemctl', ['--user', 'stop', SERVICE_NAME], { stdio: 'inherit' });
    return;
  }
  await stopDetachedProxyOnly();
}

export async function printProxyStatus(config = getConfig()) {
  const health = await proxyHealth(config);
  if (health) {
    process.stdout.write(`${JSON.stringify(health)}\n`);
    return 0;
  }
  if (systemctlAvailable() && serviceIsInstalled()) {
    const status = spawnSync('systemctl', ['--user', 'status', '--no-pager', SERVICE_NAME], { encoding: 'utf8' });
    process.stdout.write(status.stdout || status.stderr || 'proxy unavailable\n');
    return status.status ?? 1;
  }
  process.stdout.write('proxy unavailable\n');
  return 1;
}
