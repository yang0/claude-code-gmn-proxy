import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
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
