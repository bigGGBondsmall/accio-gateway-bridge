'use strict';

/**
 * mock-openai.js — Lightweight mock OpenAI API server.
 *
 * Simulates OpenAI-compatible chat completions endpoint (/v1/chat/completions)
 * with support for:
 *   - Streaming (SSE with chunked deltas and usage)
 *   - Non-streaming (JSON chat completion object)
 *   - Standard text generation
 *   - Function / Tool calls (both streaming chunks and non-streaming)
 *   - Health checks and models endpoint
 *
 * Can be run standalone: `node tests/mock-openai.js [port]`
 * Or imported as a module: `const { startMockOpenAI } = require('./mock-openai');`
 */

const http = require('node:http');

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function sendSseFrames(res, frames) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
  });
  for (const frame of frames) {
    if (frame === '[DONE]') {
      res.write('data: [DONE]\n\n');
    } else {
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    }
  }
  res.end();
}

function createMockOpenAIServer(options = {}) {
  const requests = [];

  const server = http.createServer(async (req, res) => {
    // Enable CORS
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    res.setHeader('access-control-allow-headers', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';

    // Health check
    if ((pathname === '/' || pathname === '/health') && req.method === 'GET') {
      sendJson(res, 200, { status: 'ok', service: 'mock-openai-server' });
      return;
    }

    // Models catalog
    if ((pathname === '/v1/models' || pathname === '/models') && req.method === 'GET') {
      sendJson(res, 200, {
        object: 'list',
        data: [
          { id: 'mock-custom-model', object: 'model', owned_by: 'mock' },
          { id: 'gpt-4o-mini', object: 'model', owned_by: 'openai' },
          { id: 'qwen2.5-coder-7b', object: 'model', owned_by: 'qwen' },
        ],
      });
      return;
    }

    // Chat completions
    if ((pathname === '/v1/chat/completions' || pathname === '/chat/completions') && req.method === 'POST') {
      let body;
      try {
        body = await readRequestBody(req);
      } catch (err) {
        sendJson(res, 400, { error: { message: err.message, type: 'invalid_request_error' } });
        return;
      }

      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
        receivedAt: new Date().toISOString(),
      });

      const isStreaming = body.stream !== false;
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const promptText = messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''))).join(' ');

      // Check if tool calling should be triggered
      const isToolCall = promptText.includes('CALL_TOOL') || (Array.isArray(body.tools) && body.tools.length > 0 && promptText.toLowerCase().includes('tool'));

      if (isToolCall) {
        if (isStreaming) {
          sendSseFrames(res, [
            {
              id: 'chatcmpl-mock-tool',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: body.model || 'mock-custom-model',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_mock_tool_1',
                        type: 'function',
                        function: {
                          name: 'read_file',
                          arguments: '{"path":',
                        },
                      },
                    ],
                  },
                },
              ],
            },
            {
              id: 'chatcmpl-mock-tool',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: body.model || 'mock-custom-model',
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        function: {
                          arguments: '"test.txt"}',
                        },
                      },
                    ],
                  },
                },
              ],
            },
            {
              id: 'chatcmpl-mock-tool',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: body.model || 'mock-custom-model',
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: 'tool_calls',
                },
              ],
              usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
            },
            '[DONE]',
          ]);
          return;
        }

        // Non-streaming tool call
        sendJson(res, 200, {
          id: 'chatcmpl-mock-tool',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model || 'mock-custom-model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_mock_tool_1',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: '{"path":"test.txt"}',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
        });
        return;
      }

      // Standard text response
      if (isStreaming) {
        sendSseFrames(res, [
          {
            id: 'chatcmpl-mock-text',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: body.model || 'mock-custom-model',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  content: 'Mock ',
                },
              },
            ],
          },
          {
            id: 'chatcmpl-mock-text',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: body.model || 'mock-custom-model',
            choices: [
              {
                index: 0,
                delta: {
                  content: 'OpenAI ',
                },
              },
            ],
          },
          {
            id: 'chatcmpl-mock-text',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: body.model || 'mock-custom-model',
            choices: [
              {
                index: 0,
                delta: {
                  content: 'response!',
                },
              },
            ],
          },
          {
            id: 'chatcmpl-mock-text',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: body.model || 'mock-custom-model',
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
          '[DONE]',
        ]);
        return;
      }

      // Non-streaming text response
      sendJson(res, 200, {
        id: 'chatcmpl-mock-text',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model || 'mock-custom-model',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Mock OpenAI response!',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      return;
    }

    sendJson(res, 404, { error: { message: `Not found: ${req.method} ${pathname}`, type: 'invalid_request_error' } });
  });

  server.requests = requests;
  return server;
}

function startMockOpenAI(port = 0, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = createMockOpenAIServer();
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = addr.port;
      const url = `http://${host}:${actualPort}`;
      resolve({
        server,
        url,
        port: actualPort,
        requests: server.requests,
        close: () =>
          new Promise((done) => {
            server.close(done);
          }),
      });
    });
    server.on('error', reject);
  });
}

if (require.main === module) {
  const port = Number(process.argv[2]) || Number(process.env.MOCK_OPENAI_PORT) || 3001;
  const host = process.env.MOCK_OPENAI_HOST || '127.0.0.1';
  startMockOpenAI(port, host).then(({ url }) => {
    console.log(`[mock-openai] Listening on ${url}`);
    console.log(`[mock-openai] Endpoints available:`);
    console.log(`  - POST ${url}/v1/chat/completions (streaming & non-streaming)`);
    console.log(`  - GET  ${url}/v1/models`);
    console.log(`  - GET  ${url}/health`);
  }).catch((err) => {
    console.error(`[mock-openai] Failed to start: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  createMockOpenAIServer,
  startMockOpenAI,
};
