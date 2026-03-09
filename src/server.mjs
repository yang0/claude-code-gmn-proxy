import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import {
  anthropicToResponsesRequest,
  openaiResponseToAnthropic,
  convertOpenAIEventToAnthropicSse,
} from './translator.mjs';

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendSse(res, frame) {
  res.write(`event: ${frame.event}\n`);
  res.write(`data: ${JSON.stringify(frame.data)}\n\n`);
}

async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk.toString();
  }
  return body ? JSON.parse(body) : {};
}

function isAuthorized(req, config) {
  if (!config.localAuthToken) {
    return true;
  }
  const header = req.headers.authorization;
  const xApiKey = req.headers['x-api-key'];
  if (header?.startsWith('Bearer ')) {
    return header.slice('Bearer '.length) === config.localAuthToken;
  }
  return xApiKey === config.localAuthToken;
}

function estimateTokens(payload) {
  const text = JSON.stringify(payload);
  return Math.max(1, Math.ceil(text.length / 4));
}

async function proxyJsonToUpstream(upstreamFetch, config, requestBody) {
  const response = await upstreamFetch(`${config.upstreamBaseUrl}/v1/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.upstreamApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Upstream error ${response.status}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text);
}

async function proxyStreamToUpstream(upstreamFetch, config, requestBody, res) {
  const upstream = await upstreamFetch(`${config.upstreamBaseUrl}/v1/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.upstreamApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ...requestBody, stream: true }),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text();
    throw new Error(`Upstream stream error ${upstream.status}: ${text.slice(0, 400)}`);
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const decoder = new TextDecoder();
  let buffer = '';
  const state = {};

  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const sep = buffer.indexOf('\n\n');
      if (sep === -1) {
        break;
      }
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const lines = rawEvent.split(/\r?\n/);
      const dataLine = lines.find((line) => line.startsWith('data: '));
      if (!dataLine) {
        continue;
      }
      const eventData = JSON.parse(dataLine.slice(6));
      const frames = convertOpenAIEventToAnthropicSse(eventData, state);
      for (const frame of frames) {
        sendSse(res, frame);
      }
    }
  }

  res.end();
}

function buildModelsPayload(defaultModel) {
  return {
    data: [
      {
        id: defaultModel,
        type: 'model',
        display_name: defaultModel,
        created_at: '2024-01-01T00:00:00Z',
      },
    ],
  };
}

export function createServer({ config = loadConfig(), upstreamFetch = fetch } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, {
          ok: true,
          default_model: config.defaultModel,
          upstream_base_url: config.upstreamBaseUrl,
        });
      }

      if (req.method === 'POST' && (url.pathname === '/' || url.pathname === '/api/event_logging/batch')) {
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname.startsWith('/v1/') && !isAuthorized(req, config)) {
        return sendJson(res, 401, {
          type: 'error',
          error: { type: 'authentication_error', message: 'Invalid or missing local proxy token' },
        });
      }

      if (req.method === 'GET' && url.pathname === '/v1/models') {
        return sendJson(res, 200, buildModelsPayload(config.defaultModel));
      }

      if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, { input_tokens: estimateTokens(body) });
      }

      if (req.method === 'POST' && url.pathname === '/v1/messages') {
        const body = await readJsonBody(req);
        const mapped = anthropicToResponsesRequest(body, config);
        if (body.stream) {
          await proxyStreamToUpstream(upstreamFetch, config, mapped, res);
          return;
        }
        const upstream = await proxyJsonToUpstream(upstreamFetch, config, mapped);
        const anth = openaiResponseToAnthropic(upstream, mapped.model);
        return sendJson(res, 200, anth);
      }

      sendJson(res, 404, {
        type: 'error',
        error: { type: 'not_found_error', message: 'Not found' },
      });
    } catch (error) {
      sendJson(res, 500, {
        type: 'error',
        error: {
          type: 'api_error',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });
}

export async function startServer(overrides = {}) {
  const config = loadConfig(overrides);
  const server = createServer({ config });
  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  return { server, config };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { config } = await startServer();
  process.stdout.write(`claude-code-gmn-proxy listening on http://${config.host}:${config.port}\n`);
}
