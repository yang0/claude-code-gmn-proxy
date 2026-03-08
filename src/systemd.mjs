import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const SERVICE_NAME = 'claude-code-gmn-proxy.service';

export function renderUserServiceUnit({ repoRoot, nodeBinary, host = '127.0.0.1', port = 4040 }) {
  return `[Unit]
Description=Claude Code GMN Proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=${repoRoot}
ExecStart=${nodeBinary} ${repoRoot}/src/server.mjs
Environment=CLAUDE_CODE_GMN_PROXY_HOST=${host}
Environment=CLAUDE_CODE_GMN_PROXY_PORT=${port}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}

export function getUserServicePath() {
  return path.join(os.homedir(), '.config', 'systemd', 'user', SERVICE_NAME);
}

export async function installUserService({ repoRoot, nodeBinary, host, port }) {
  const servicePath = getUserServicePath();
  await fs.mkdir(path.dirname(servicePath), { recursive: true });
  await fs.writeFile(servicePath, renderUserServiceUnit({ repoRoot, nodeBinary, host, port }));
  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
  spawnSync('systemctl', ['--user', 'enable', '--now', SERVICE_NAME], { stdio: 'inherit' });
  return servicePath;
}

export function serviceIsInstalled() {
  return spawnSync('systemctl', ['--user', 'status', SERVICE_NAME], { stdio: 'ignore' }).status === 0 ||
    spawnSync('systemctl', ['--user', 'cat', SERVICE_NAME], { stdio: 'ignore' }).status === 0;
}
