import test from 'node:test';
import assert from 'node:assert/strict';
import { renderUserServiceUnit } from '../src/systemd.mjs';

test('renderUserServiceUnit renders a restartable user service bound to the repo root', () => {
  const unit = renderUserServiceUnit({
    repoRoot: '/tmp/claude-code-gmn-proxy',
    nodeBinary: '/usr/bin/node',
    host: '127.0.0.1',
    port: 4040,
  });

  assert.match(unit, /Description=Claude Code GMN Proxy/);
  assert.match(unit, /WorkingDirectory=\/tmp\/claude-code-gmn-proxy/);
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/tmp\/claude-code-gmn-proxy\/src\/server\.mjs/);
  assert.match(unit, /Environment=CLAUDE_CODE_GMN_PROXY_HOST=127\.0\.0\.1/);
  assert.match(unit, /Environment=CLAUDE_CODE_GMN_PROXY_PORT=4040/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /WantedBy=default\.target/);
});
