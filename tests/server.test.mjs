import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.mjs';

function startServer(options = {}) {
  const server = createServer({
    config: {
      localAuthToken: 'local-token',
      defaultModel: 'gpt-5.4',
      upstreamBaseUrl: 'https://example.invalid',
      ...options.config,
    },
    upstreamFetch: options.upstreamFetch || (async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })),
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: address.port });
    });
  });
}

async function getFreePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}

test('server exposes health endpoint and enforces auth on /v1/messages', async () => {
  const { server, port } = await startServer();
  try {
    let res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const health = await res.json();
    assert.equal(health.ok, true);
    assert.equal(health.default_model, 'gpt-5.4');

    res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4', messages: [], max_tokens: 16 }),
    });
    assert.equal(res.status, 401);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('server proxies non-stream messages to upstream and returns Anthropics shape', async () => {
  const seen = { url: null, body: null };
  const upstreamFetch = async (url, init) => {
    seen.url = url;
    seen.body = JSON.parse(init.body);
    return new Response(JSON.stringify({
      id: 'resp_1',
      model: 'gpt-5.4',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'PONG' }] }],
      usage: { input_tokens: 6, output_tokens: 4, input_tokens_details: { cached_tokens: 0 } },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const { server, port } = await startServer({ upstreamFetch });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages?beta=true`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with PONG only.' }] }],
        max_tokens: 32,
        stream: false,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(seen.url, 'https://example.invalid/v1/responses');
    assert.equal(seen.body.model, 'gpt-5.4');
    assert.equal(body.content[0].text, 'PONG');
    assert.equal(body.stop_reason, 'end_turn');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('server starts when executed directly via node', async (context) => {
  const port = await getFreePort();
  const entry = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
  const stdout = [];
  const stderr = [];
  const child = spawn(process.execPath, [entry], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CLAUDE_CODE_GMN_PROXY_HOST: '127.0.0.1',
      CLAUDE_CODE_GMN_PROXY_PORT: String(port),
      CLAUDE_CODE_GMN_PROXY_UPSTREAM_BASE_URL: 'https://example.invalid',
      CLAUDE_CODE_GMN_PROXY_UPSTREAM_API_KEY: 'test-key',
    },
  });

  child.stdout.on('data', (chunk) => stdout.push(chunk.toString()));
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
  context.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
  });

  let health = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {
      // child may still be booting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.ok(
    health,
    `Expected direct server execution to expose /health. exitCode=${child.exitCode} stdout=${stdout.join('')} stderr=${stderr.join('')}`,
  );
  assert.equal(health.ok, true);
});
