'use strict';

/**
 * server.js 鈥?Accio Work Desktop gateway bridge.
 *
 * Endpoints:
 *   POST /api/llm/config/v2        merged model catalog (custom + official)
 *   POST /api/adk/llm/generateContent
 *   POST /api/adk/llm              GenAI streaming, translated for custom models
 *   *    everything else            transparent proxy to phoenix-gw.alibaba.com
 *
 * Zero external dependencies: node:http / node:https / global fetch (Node 18+).
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const converter = require('./converter');
const discovery = require('./discovery');
const { createProxyHandler } = require('./proxy');
const { detectAccioWorkCN } = require('./accio-detect');

const UPSTREAM_DEFAULT = 'https://phoenix-gw.alibaba.com';
const CONFIG_PATH = process.env.ACCIO_BRIDGE_CONFIG || path.join(__dirname, '..', 'config.json');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// Process-wide ring buffer of recent log lines, backing GET /api/bridge/logs.
const LOG_BUFFER_CAPACITY = 1000;
const logBuffer = [];
function pushLogBuffer(level, msg) {
  try {
    logBuffer.push({ ts: new Date().toISOString(), level, msg });
    if (logBuffer.length > LOG_BUFFER_CAPACITY) {
      logBuffer.splice(0, logBuffer.length - LOG_BUFFER_CAPACITY);
    }
  } catch {
    /* logging must never throw */
  }
}

// Per-model usage counters (in-memory only, cleared on process restart).
const usageStats = new Map();
const USAGE_SINCE = new Date().toISOString();
function usageFor(id) {
  let entry = usageStats.get(id);
  if (!entry) {
    entry = { requests: 0, errors: 0, lastUsedAt: null, lastLatencyMs: null };
    usageStats.set(id, entry);
  }
  return entry;
}

// 10s cache for GET /api/bridge/discover.
const DISCOVER_CACHE_TTL_MS = 10000;
const discoverCache = { at: 0, data: null };

function makeLogger(level, logFilePath = process.env.ACCIO_BRIDGE_LOG_FILE) {
  const threshold = LEVELS[String(level || 'info').toLowerCase()] ?? LEVELS.info;
  let fileStream = null;
  if (logFilePath) {
    try {
      fileStream = fs.createWriteStream(logFilePath, { flags: 'a' });
      fileStream.on('error', () => {});
    } catch {}
  }

  const emit = (name, sink) => (...args) => {
    if (LEVELS[name] < threshold) return;
    const formatted = args.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
    const line = `${new Date().toISOString()} [${name}] ${formatted}`;
    pushLogBuffer(name, formatted);
    try {
      sink(line);
    } catch {}
    if (fileStream) {
      try {
        fileStream.write(line + '\n');
      } catch {}
    }
  };
  return {
    debug: emit('debug', console.log),
    info: emit('info', console.log),
    warn: emit('warn', console.warn),
    error: emit('error', console.error),
  };
}

let log = makeLogger('info');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function fail(message) {
  console.error(`[accio-gateway-bridge] ${message}`);
  process.exit(1);
}

function normalizeConfig(raw) {
  const models = (Array.isArray(raw.models) ? raw.models : [])
    .filter((model) => converter.isObject(model) && typeof model.id === 'string' && model.id.trim())
    .map((model, index) => ({
      id: model.id.trim(),
      modelCode: (model.modelCode || model.id).trim(),
      displayName: model.displayName || model.modelName || model.id,
      provider: String(model.provider || 'openai').toLowerCase(),
      baseUrl: model.baseUrl || (model.provider === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1'),
      upstreamModel: model.upstreamModel || model.modelCode || model.id,
      apiKey: model.apiKey || '',
      contextWindow: Number(model.contextWindow) || converter.DEFAULT_CONTEXT_WINDOW,
      multimodal: model.multimodal === true,
      stream: model.stream !== false,
      enabled: model.enabled !== false,
      visible: model.visible !== false,
      isDefault: model.isDefault === true,
      freeUse: model.freeUse !== false,
      locked: model.locked === true,
      usageLevel: Number(model.usageLevel) || 0,
      aliases: (Array.isArray(model.aliases) ? model.aliases : []).filter((a) => typeof a === 'string'),
      index,
    }));

  if (!models.some((model) => model.isDefault && model.enabled)) {
    const firstEnabled = models.find((model) => model.enabled);
    if (firstEnabled) firstEnabled.isDefault = true;
  }

  const server = raw.server || {};
  const upstream = raw.upstream || {};
  const catalog = raw.catalog || {};
  const accio = raw.accio || {};
  return {
    server: {
      host: server.host || '127.0.0.1',
      port: Number(server.port) || 8080,
      maxBodyBytes: Number(server.maxBodyBytes) || 25 * 1024 * 1024,
      cors: server.cors !== false,
      token: server.token || '',
      enforceToken: server.enforceToken === true,
      logLevel: server.logLevel || 'info',
    },
    upstream: {
      baseUrl: (upstream.baseUrl || UPSTREAM_DEFAULT).replace(/\/+$/, ''),
      timeoutMs: Number(upstream.timeoutMs) || 300000,
      apiKey: upstream.apiKey || '',
    },
    catalog: {
      enabled: catalog.enabled !== false,
      providerName: catalog.providerName || 'custom',
      providerDisplayName: catalog.providerDisplayName || 'Custom AI (Local / OpenAI)',
      fetchOfficial: catalog.fetchOfficial !== false,
      timeoutMs: Number(catalog.timeoutMs) || 8000,
      cacheTtlMs: Number(catalog.cacheTtlMs) || 300000,
      cacheTtlMs: Number(catalog.cacheTtlMs) || 300000,
    },
    accio: {
      enabled: accio.enabled !== false,
      customExePath: accio.customExePath || '',
      allowNonCN: accio.allowNonCN === true,
    },
    disableDiskSave: raw.disableDiskSave === true,
    models,
    modelIndex: buildModelIndex(models),
  };
}

function buildModelIndex(models) {
  const index = new Map();
  for (const model of models) {
    const keys = [model.id, model.modelCode, ...model.aliases];
    for (const key of keys) {
      if (typeof key !== 'string' || !key.trim()) continue;
      const normalized = key.trim().toLowerCase();
      if (!index.has(normalized)) index.set(normalized, model);
    }
  }
  return index;
}

function loadConfig() {
  let text;
  try {
    text = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
  } catch (err) {
    fail(`cannot read config at ${CONFIG_PATH}: ${err.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    fail(`config at ${CONFIG_PATH} is not valid JSON: ${err.message}`);
  }
  return normalizeConfig(raw);
}

function saveConfigToFile(config) {
  if (config.disableDiskSave) return false;
  try {
    const configPath = CONFIG_PATH;
    let raw = {};
    if (fs.existsSync(configPath)) {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
    }
    raw.models = config.models.map((m) => {
      const out = {
        id: m.id,
        modelCode: m.modelCode,
        displayName: m.displayName,
        provider: m.provider,
        baseUrl: m.baseUrl,
        upstreamModel: m.upstreamModel,
        apiKey: m.apiKey,
        contextWindow: m.contextWindow,
        multimodal: m.multimodal,
        stream: m.stream,
        enabled: m.enabled,
        visible: m.visible,
        isDefault: m.isDefault,
        freeUse: m.freeUse,
        locked: m.locked,
        usageLevel: m.usageLevel,
      };
      if (Array.isArray(m.aliases) && m.aliases.length > 0) out.aliases = m.aliases;
      return out;
    });
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), 'utf8');
    log.info(`saved configuration to ${configPath}`);
    return true;
  } catch (err) {
    log.warn(`could not save configuration to ${CONFIG_PATH}: ${err.message}`);
    return false;
  }
}

const DASHBOARD_HTML_PATHS = [
  path.join(__dirname, '..', 'public', 'index.html'),
  path.join(__dirname, 'dashboard.html'),
  path.join(__dirname, '..', 'src', 'dashboard.html'),
];

function getDashboardHtml() {
  for (const p of DASHBOARD_HTML_PATHS) {
    try {
      if (fs.existsSync(p)) {
        return fs.readFileSync(p, 'utf8');
      }
    } catch {}
  }
  return '<!DOCTYPE html><html><head><title>Accio Gateway Bridge Dashboard</title></head><body><h1>Accio Gateway Bridge</h1><p>Dashboard is loading or static files are missing.</p></body></html>';
}

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers':
    'content-type,authorization,x-gateway-token,x-requested-with,x-sg-k,accept,x-accio-version',
  'access-control-max-age': '86400',
};

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message, extra) {
  sendJson(res, status, { ok: false, error: message, success: false, code: String(status), message, ...extra });
}

function startSse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

function writeFrame(res, frame) {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(frame)}\n\n`);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error(`request body exceeds ${limit} bytes`), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Accio >= 0.37 compresses LLM request bodies (Content-Encoding: gzip).
 * Decode by header, and also by magic bytes in case the header is missing.
 */
function decodeRequestBody(buffer, encoding) {
  if (!buffer || buffer.length === 0) return buffer;
  const enc = String(encoding || '').toLowerCase().trim();
  const isGzip = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  const isZstd = buffer.length >= 4 && buffer[0] === 0x28 && buffer[1] === 0xb5 && buffer[2] === 0x2f && buffer[3] === 0xfd;
  if (enc.includes('gzip') || isGzip) return zlib.gunzipSync(buffer);
  if (enc.includes('br')) return zlib.brotliDecompressSync(buffer);
  if (enc.includes('zstd') || isZstd) {
    if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('zstd request body is not supported by this Node.js version');
    return zlib.zstdDecompressSync(buffer);
  }
  if (enc.includes('deflate')) {
    try { return zlib.inflateSync(buffer); } catch { return zlib.inflateRawSync(buffer); }
  }
  return buffer;
}

function parseJsonBody(buffer, encoding) {
  if (!buffer || buffer.length === 0) return {};
  const text = decodeRequestBody(buffer, encoding).toString('utf8').replace(/^\uFEFF/, '').trim();
  if (!text) return {};
  return JSON.parse(text);
}

/** Streaming SSE line reader over a fetch body. */
function createSseReader(stream, onData) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  return {
    async pump() {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          let line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (!line || line.startsWith(':')) continue;
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          onData(payload);
        }
      }
    },
    async cancel() {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    },
  };
}

/** Streaming NDJSON (Ollama) line reader. */
function createNdjsonReader(stream, onObject) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  return {
    async pump() {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          try {
            onObject(JSON.parse(line));
          } catch {
            log.debug('ollama chunk not JSON:', line.slice(0, 200));
          }
        }
      }
    },
    async cancel() {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Model catalog: POST /api/llm/config/v2
// ---------------------------------------------------------------------------

const catalogCache = { key: '', at: 0, data: null, inflight: null };

function buildCustomProvider(config) {
  const enabled = config.models.filter((model) => model.enabled);
  if (!config.catalog.enabled || enabled.length === 0) return null;
  return {
    provider: config.catalog.providerName,
    providerDisplayName: config.catalog.providerDisplayName,
    modelList: enabled.map((model) => ({
      modelCode: model.modelCode,
      modelName: model.modelCode,
      modelDisplayName: model.displayName,
      multimodal: model.multimodal,
      visible: model.visible,
      contextWindow: model.contextWindow,
      isDefault: model.isDefault,
      freeUse: model.freeUse,
      locked: model.locked,
      usageLevel: model.usageLevel,
    })),
  };
}

async function fetchOfficialCatalog(config, incomingHeaders, token) {
  const key = token || incomingHeaders.authorization || incomingHeaders.cookie || 'anon';
  const now = Date.now();

  if (catalogCache.data && catalogCache.key === key && now - catalogCache.at < config.catalog.cacheTtlMs) {
    return catalogCache.data;
  }
  if (catalogCache.inflight && catalogCache.key === key) return catalogCache.inflight;

  const task = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.catalog.timeoutMs);
    try {
      const headers = filterHeaders(incomingHeaders);
      headers['content-type'] = 'application/json';
      headers.accept = 'application/json';
      const response = await fetch(`${config.upstream.baseUrl}/api/llm/config/v2`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ token: token || '', supportAutoModel: true }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`upstream status ${response.status}`);
      const json = await response.json();
      const data = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
      catalogCache.data = data;
      catalogCache.key = key;
      catalogCache.at = Date.now();
      return data;
    } finally {
      clearTimeout(timer);
      catalogCache.inflight = null;
    }
  })();

  catalogCache.inflight = task;
  catalogCache.key = key;
  try {
    return await task;
  } catch (err) {
    const cause = err.cause ? ` (${err.cause.code || err.cause.message})` : '';
    log.warn(`official catalog fetch failed: ${err.message}${cause}`);
    // Serve a slightly stale catalogue rather than dropping the official models.
    return catalogCache.data || [];
  }
}

/**
 * Headers that must be dropped before handing the request to `fetch`.
 * undici rejects some of them outright (`expect` -> "expect header not supported")
 * and recomputes the transport specific ones itself.
 */
const FETCH_FORBIDDEN_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'accept-encoding',
  'expect',
  'upgrade',
  'te',
  'trailer',
]);

function filterHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (FETCH_FORBIDDEN_HEADERS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

async function handleCatalog(req, res, config, rawBody) {
  let body = {};
  try {
    body = parseJsonBody(rawBody, req.headers['content-encoding']);
  } catch {
    body = {};
  }
  const token = body.token
    || new URL(req.url, 'http://localhost').searchParams.get('token')
    || '';

  const custom = buildCustomProvider(config);
  let official = [];
  if (config.catalog.fetchOfficial) {
    official = await fetchOfficialCatalog(config, req.headers, token);
  }

  const data = [];
  if (custom) data.push(custom);
  for (const provider of official) {
    if (!converter.isObject(provider)) continue;
    data.push(provider);
  }

  sendJson(res, 200, { success: true, code: '200', data });
}

// ---------------------------------------------------------------------------
// Generation: POST /api/adk/llm(/generateContent)
// ---------------------------------------------------------------------------

function authorize(req, config) {
  if (!config.server.enforceToken || !config.server.token) return true;
  const url = new URL(req.url, 'http://localhost');
  const candidates = [
    url.searchParams.get('sg_k'),
    url.searchParams.get('token'),
    req.headers['x-gateway-token'],
    (req.headers.authorization || '').replace(/^Bearer\s+/i, ''),
  ].filter(Boolean);
  return candidates.includes(config.server.token);
}

async function handleGenerate(req, res, config, proxy, rawBody) {
  let body;
  try {
    body = parseJsonBody(rawBody, req.headers['content-encoding']);
  } catch (err) {
    sendError(res, 400, `invalid JSON body: ${err.message}`);
    return;
  }

  const requested = typeof body.model === 'string' ? body.model.trim().toLowerCase() : '';
  const model = requested ? config.modelIndex.get(requested) : undefined;

  if (!model || !model.enabled) {
    log.info(`forwarding model "${body.model ?? ''}" upstream`);
    await proxy(req, res, rawBody);
    return;
  }

  log.info(`routing model "${model.id}" -> ${model.provider} ${model.baseUrl}`);

  const usage = usageFor(model.id);
  usage.requests += 1;
  const reqStarted = Date.now();
  let outcome = 'ok';

  try {
    if (model.provider === 'ollama') {
      outcome = await streamOllama(res, model, body);
    } else if (model.provider === 'openai' || model.provider === 'azure' || model.provider === 'openai-compatible') {
      outcome = await streamOpenAI(res, model, body);
    } else {
      sendError(res, 400, `unsupported provider "${model.provider}" for model "${model.id}"`);
      outcome = 'error';
    }
  } catch (err) {
    outcome = 'error';
    log.error(`generation failed for ${model.id}: ${err.message}`);
    startSseIfNeeded(res);
    writeFrame(res, {
      error: { code: err.statusCode || 500, message: err.message, status: 'INTERNAL' },
      turnComplete: true,
      finishReason: 'STOP',
    });
    if (!res.writableEnded) res.end();
  } finally {
    usageFor(model.id).lastUsedAt = new Date().toISOString();
    usageFor(model.id).lastLatencyMs = Date.now() - reqStarted;
    if (outcome !== 'ok') usageFor(model.id).errors += 1;
  }
}

function startSseIfNeeded(res) {
  if (!res.headersSent) startSse(res);
}

/** Shared stream sink: accumulates tool calls and emits the terminal frame. */
function createSink(res) {
  const sink = {
    toolCalls: new Map(),
    usage: undefined,
    finishReason: undefined,
    finished: false,
  };

  sink.text = (chunk) => {
    if (sink.finished || !chunk) return;
    startSseIfNeeded(res);
    writeFrame(res, converter.textFrame(chunk));
  };

  sink.toolDelta = (index, name, argsText, id) => {
    const key = index ?? sink.toolCalls.size;
    const entry = sink.toolCalls.get(key) || { name: '', args: '', id };
    if (name && !entry.name) entry.name = name;
    if (argsText) entry.args += argsText;
    if (id && !entry.id) entry.id = id;
    sink.toolCalls.set(key, entry);
  };

  sink.addToolCall = (name, args) => {
    if (!name) return;
    sink.toolCalls.set(sink.toolCalls.size, {
      name,
      args: converter.isObject(args) ? args : converter.parseToolArguments(args),
    });
  };

  sink.noteUsage = (usage) => {
    if (converter.isObject(usage)) sink.usage = usage;
  };

  sink.noteFinish = (reason) => {
    if (reason) sink.finishReason = reason;
  };

  sink.finish = () => {
    if (sink.finished) return;
    sink.finished = true;
    startSseIfNeeded(res);

    const calls = [...sink.toolCalls.values()]
      .filter((call) => call.name)
      .map((call) => ({
        id: call.id,
        name: call.name,
        args: typeof call.args === 'string' ? converter.parseToolArguments(call.args) : call.args,
      }));

    if (calls.length > 0) writeFrame(res, converter.toolCallsFrame(calls));
    else writeFrame(res, converter.doneFrame(sink.usage, sink.finishReason));

    if (!res.writableEnded) res.end();
  };

  sink.fail = (err) => {
    if (sink.finished) return;
    sink.finished = true;
    startSseIfNeeded(res);
    writeFrame(res, {
      error: { code: err.statusCode || 502, message: err.message, status: 'UNAVAILABLE' },
      turnComplete: true,
      finishReason: 'STOP',
    });
    if (!res.writableEnded) res.end();
  };

  return sink;
}

async function streamOpenAI(res, model, body) {
  const payload = converter.toOpenAIRequest(model, body);
  const url = converter.resolveEndpoint(model.baseUrl || 'https://api.openai.com/v1', '/chat/completions');
  const sink = createSink(res);
  const controller = new AbortController();

  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: payload.stream ? 'text/event-stream' : 'application/json',
        ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) return 'aborted';
    sink.fail(new Error(`cannot reach ${url}: ${err.message}`));
    return 'error';
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    sink.fail(new Error(`upstream ${response.status} from ${url}: ${detail.slice(0, 500)}`));
    return 'error';
  }

  if (!payload.stream) {
    const json = await response.json();
    writeFrame(res, converter.openAIResponseToGenAI(json));
    res.end();
    return 'ok';
  }

  const reader = createSseReader(response.body, (data) => {
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    sink.noteUsage(chunk.usage);
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!choice) return;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) sink.text(delta.content);
    if (delta.reasoning_content && typeof delta.reasoning_content === 'string' && !delta.content) {
      // Reasoning models: surface the trace as text so the UI shows progress.
      sink.text(delta.reasoning_content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        sink.toolDelta(call.index, call.function?.name, call.function?.arguments, call.id);
      }
    }
    if (choice.finish_reason) sink.noteFinish(choice.finish_reason);
  });

  let streamError = false;
  try {
    await reader.pump();
  } catch (err) {
    if (controller.signal.aborted) return 'aborted';
    log.warn(`openai stream interrupted: ${err.message}`);
    streamError = true;
  }
  sink.finish();
  return streamError ? 'error' : 'ok';
}

async function streamOllama(res, model, body) {
  const payload = converter.toOllamaRequest(model, body);
  const url = converter.resolveEndpoint(model.baseUrl || 'http://127.0.0.1:11434', '/api/chat');
  const sink = createSink(res);
  const controller = new AbortController();

  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: payload.stream ? 'application/x-ndjson' : 'application/json',
        ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) return;
    sink.fail(new Error(`cannot reach ${url}: ${err.message}`));
    return;
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    sink.fail(new Error(`upstream ${response.status} from ${url}: ${detail.slice(0, 500)}`));
    return;
  }

  if (!payload.stream) {
    const json = await response.json();
    const message = json?.message || {};
    const parts = [];
    if (typeof message.content === 'string' && message.content) parts.push({ text: message.content });
    sink.noteUsage({
      prompt_tokens: json.prompt_eval_count,
      completion_tokens: json.eval_count,
    });
    writeFrame(res, {
      content: { role: 'model', parts },
      turnComplete: true,
      finishReason: json.done_reason === 'length' ? 'MAX_TOKENS' : 'STOP',
      usageMetadata: converter.toUsageMetadata({
        prompt_tokens: json.prompt_eval_count,
        completion_tokens: json.eval_count,
      }),
    });
    res.end();
    return;
  }

  const reader = createNdjsonReader(response.body, (chunk) => {
    const message = chunk.message || {};
    if (typeof message.content === 'string' && message.content) sink.text(message.content);
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        sink.addToolCall(call.function?.name, call.function?.arguments);
      }
    }
    if (typeof chunk.thinking === 'string' && chunk.thinking && !message.content) sink.text(chunk.thinking);
    if (chunk.done) {
      sink.noteUsage({ prompt_tokens: chunk.prompt_eval_count, completion_tokens: chunk.eval_count });
      sink.noteFinish(chunk.done_reason === 'length' ? 'length' : 'stop');
    }
  });

  let streamError = false;
  try {
    await reader.pump();
  } catch (err) {
    if (controller.signal.aborted) return 'aborted';
    log.warn(`ollama stream interrupted: ${err.message}`);
    streamError = true;
  }
  sink.finish();
  return streamError ? 'error' : 'ok';
}

// ---------------------------------------------------------------------------
// Provider grouping / masking (desktop CONTRACT.md section 4)
// ---------------------------------------------------------------------------

function maskApiKey(key) {
  const value = typeof key === 'string' ? key : '';
  if (!value) return '';
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function normalizeBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function isValidHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidContextWindow(value) {
  if (typeof value === 'boolean') return false;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return false;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0;
  }
  return false;
}

function isLocalBaseUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function providerDisplayName(provider, baseUrl) {
  if (String(provider || '').toLowerCase() === 'ollama') return 'Ollama';
  let hostname = '';
  let host = '';
  try {
    const parsed = new URL(baseUrl);
    hostname = parsed.hostname.toLowerCase();
    host = parsed.host.toLowerCase();
  } catch {
    return normalizeBaseUrl(baseUrl) || 'OpenAI';
  }
  const hosts = {
    'api.deepseek.com': 'DeepSeek',
    'api.openai.com': 'OpenAI',
    'openrouter.ai': 'OpenRouter',
    'api.siliconflow.cn': '硅基流动',
    'dashscope.aliyuncs.com': '通义千问',
    'api.moonshot.cn': 'Moonshot',
    'open.bigmodel.cn': '智谱',
  };
  if (hosts[hostname]) return hosts[hostname];
  if (host === '127.0.0.1:1234' || host === 'localhost:1234') return 'LM Studio';
  return host || hostname || 'OpenAI';
}

function providerGroupId(provider, baseUrl, apiKey) {
  const digest = crypto
    .createHash('sha1')
    .update(`${provider}|${normalizeBaseUrl(baseUrl)}|${apiKey}`)
    .digest('hex');
  return `p_${digest.slice(0, 8)}`;
}

function maskedModel(model) {
  const usage = usageStats.get(model.id);
  return {
    ...model,
    apiKey: maskApiKey(model.apiKey),
    usage: usage
      ? { requests: usage.requests, errors: usage.errors, lastUsedAt: usage.lastUsedAt, lastLatencyMs: usage.lastLatencyMs }
      : { requests: 0, errors: 0, lastUsedAt: null, lastLatencyMs: null },
  };
}

/** Group `config.models` by provider + baseUrl + apiKey, in first-seen order. */
function buildProviders(config) {
  const groups = new Map();
  for (const model of config.models) {
    const baseUrl = normalizeBaseUrl(model.baseUrl);
    const apiKey = model.apiKey || '';
    const key = `${model.provider}|${baseUrl}|${apiKey}`;
    let group = groups.get(key);
    if (!group) {
      group = { provider: model.provider, baseUrl, apiKey, models: [] };
      groups.set(key, group);
    }
    group.models.push(model);
  }
  const providers = [];
  for (const group of groups.values()) {
    providers.push({
      id: providerGroupId(group.provider, group.baseUrl, group.apiKey),
      provider: group.provider,
      name: providerDisplayName(group.provider, group.baseUrl),
      baseUrl: group.baseUrl,
      apiKeyMasked: maskApiKey(group.apiKey),
      hasKey: !!group.apiKey,
      local: isLocalBaseUrl(group.baseUrl),
      enabled: group.models.some((model) => model.enabled),
      modelCount: group.models.length,
      enabledCount: group.models.filter((model) => model.enabled).length,
      models: group.models.map(maskedModel),
    });
  }
  return providers;
}

function findProviderGroup(config, id) {
  return buildProviders(config).find((group) => group.id === id) || null;
}

function buildProviderModel(input, options) {
  const id = String(input.id).trim();
  const existing = options.existing;
  return {
    id,
    modelCode: id,
    displayName: typeof input.displayName === 'string' && input.displayName.trim() ? input.displayName.trim() : id,
    provider: options.provider,
    baseUrl: options.baseUrl,
    upstreamModel: typeof input.upstreamModel === 'string' && input.upstreamModel.trim() ? input.upstreamModel.trim() : id,
    apiKey: typeof options.apiKey === 'string' ? options.apiKey : '',
    contextWindow: Number(input.contextWindow) || converter.DEFAULT_CONTEXT_WINDOW,
    multimodal: input.multimodal === true,
    stream: true,
    enabled: true,
    visible: true,
    isDefault: existing ? existing.isDefault === true : false,
    freeUse: true,
    locked: false,
    usageLevel: 0,
    aliases: existing && Array.isArray(existing.aliases) ? existing.aliases : [],
  };
}

function usageSnapshot() {
  const out = {};
  for (const [id, entry] of usageStats.entries()) {
    out[id] = {
      requests: entry.requests,
      errors: entry.errors,
      lastUsedAt: entry.lastUsedAt,
      lastLatencyMs: entry.lastLatencyMs,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Server wiring
// ---------------------------------------------------------------------------

function createServer(config) {
  const proxy = createProxyHandler({
    upstreamBaseUrl: config.upstream.baseUrl,
    timeoutMs: config.upstream.timeoutMs,
    apiKey: config.upstream.apiKey,
    log: (...args) => log.debug(...args),
  });
  let lastAccioDetect = null;
  let lastAccioDetectTime = 0;
  function getCachedAccioDetect(opts = {}, maxAgeMs = 4000) {
    const now = Date.now();
    if (!lastAccioDetect || now - lastAccioDetectTime > maxAgeMs || opts.force) {
      lastAccioDetect = detectAccioWorkCN({
        customExePath: opts.customExePath || config.accio?.customExePath,
        customAccioDir: opts.customAccioDir,
      });
      lastAccioDetectTime = now;
    }
    return lastAccioDetect;
  }


  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    res.on('finish', () => {
      log.debug(`${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - started}ms)`);
    });

    if (config.server.cors) {
      for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (pathname === '/healthz' || pathname === '/__bridge/health') {
        sendJson(res, 200, {
          ok: true,
          upstream: config.upstream.baseUrl,
          models: config.models.filter((model) => model.enabled).map((model) => model.id),
        });
        return;
      }

      // Web Dashboard serving
      if (req.method === 'GET' && (pathname === '/dashboard' || pathname === '/dashboard/' || pathname === '/dashboard/index.html' || pathname === '/' || pathname === '/index.html')) {
        const html = getDashboardHtml();
        const body = Buffer.from(html, 'utf8');
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': body.length,
          'cache-control': 'no-cache',
        });
        res.end(body);
        return;
      }

      // Bridge Management APIs
      if (req.method === 'GET' && (pathname === '/api/bridge/status' || pathname === '/__bridge/status' || pathname === '/__bridge/api/status')) {
        sendJson(res, 200, {
          ok: true,
          status: 'running',
          version: '1.0.0',
          server: {
            host: config.server.host,
            port: req.socket?.localPort || config.server.port,
            logLevel: config.server.logLevel,
          },
          upstream: config.upstream.baseUrl,
          modelsCount: config.models.length,
          activeModelsCount: config.models.filter((m) => m.enabled).length,
          models: config.models,
        });
        return;
      }
      // Accio Work Edition Inspection
      if (req.method === 'GET' && (pathname === '/api/bridge/accio' || pathname === '/__bridge/accio' || pathname === '/__bridge/api/accio')) {
        const force = url.searchParams.get('force') === 'true' || url.searchParams.get('refresh') === 'true';
        const customExePath = url.searchParams.get('exePath') || config.accio?.customExePath;
        const result = getCachedAccioDetect({ force, customExePath });
        sendJson(res, 200, {
          ok: true,
          accio: result,
          bridgeGatewayUrl: `http://${config.server.host}:${req.socket?.localPort || config.server.port}`,
        });
        return;
      }

      // Accio Work Client Launch with GATEWAY_BASE_URL
      if (req.method === 'POST' && (pathname === '/api/bridge/accio/launch' || pathname === '/__bridge/accio/launch' || pathname === '/__bridge/api/accio/launch')) {
        const raw = await readBody(req, config.server.maxBodyBytes);
        let body;
        try {
          body = parseJsonBody(raw);
        } catch {
          body = {};
        }

        const force = body.force === true || url.searchParams.get('force') === 'true';
        const customExePath = body.customExePath || url.searchParams.get('exePath') || config.accio?.customExePath;
        const detection = getCachedAccioDetect({ force: true, customExePath });

        if (!detection.installed || !detection.path) {
          sendError(res, 404, 'Accio Work 客户端未安装，或在标准路径中未找到可执行文件。请先下载安装。');
          return;
        }

        if (detection.edition !== 'cn' && !force && !config.accio?.allowNonCN) {
          sendJson(res, 400, {
            ok: false,
            error: `当前检测到的客户端为【${detection.editionLabel}】，非 Accio Work 中国版。如需强行接管，请传入 force: true。`,
            edition: detection.edition,
            editionLabel: detection.editionLabel,
            needsForce: true,
          });
          return;
        }

        if (detection.running && !force) {
          sendJson(res, 409, {
            ok: false,
            error: `Accio Work 正在运行中 (PID: ${detection.runningPids.join(', ')})。请先关闭应用以使网关生效，或传入 force: true 强行启动新实例。`,
            running: true,
            runningPids: detection.runningPids,
            needsForce: true,
          });
          return;
        }

        const bridgeUrl = `http://${config.server.host}:${req.socket?.localPort || config.server.port}`;
        const env = {
          ...process.env,
          GATEWAY_BASE_URL: bridgeUrl,
        };

        try {
          const child = spawn(detection.path, [], {
            detached: true,
            stdio: 'ignore',
            env,
            windowsHide: false,
          });
          child.unref();

          log.info(`[Accio] Launched ${detection.path} with GATEWAY_BASE_URL=${bridgeUrl} (PID: ${child.pid})`);
          lastAccioDetectTime = 0;

          sendJson(res, 200, {
            ok: true,
            launched: true,
            pid: child.pid,
            gatewayBaseUrl: bridgeUrl,
            edition: detection.edition,
            editionLabel: detection.editionLabel,
            path: detection.path,
          });
        } catch (err) {
          log.error(`[Accio] Failed to launch ${detection.path}: ${err.message}`);
          sendError(res, 500, `无法启动 Accio 客户端: ${err.message}`);
        }
        return;
      }


      if (req.method === 'GET' && (pathname === '/api/bridge/models' || pathname === '/__bridge/api/models')) {
        sendJson(res, 200, {
          ok: true,
          models: config.models,
        });
        return;
      }

      if (req.method === 'POST' && (pathname === '/api/bridge/models' || pathname === '/__bridge/api/models')) {
        const raw = await readBody(req, config.server.maxBodyBytes);
        let modelData;
        try {
          modelData = parseJsonBody(raw);
        } catch (err) {
          sendError(res, 400, `invalid JSON: ${err.message}`);
          return;
        }

        if (!modelData.id || typeof modelData.id !== 'string') {
          sendError(res, 400, 'model "id" is required and must be a string');
          return;
        }

        const modelId = modelData.id.trim();
        const existingIndex = config.models.findIndex((m) => m.id.toLowerCase() === modelId.toLowerCase());
        const newModel = {
          id: modelId,
          modelCode: (modelData.modelCode || modelId).trim(),
          displayName: modelData.displayName || modelData.modelName || modelId,
          provider: String(modelData.provider || 'openai').toLowerCase(),
          baseUrl: modelData.baseUrl || (modelData.provider === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1'),
          upstreamModel: modelData.upstreamModel || modelData.modelCode || modelId,
          apiKey: modelData.apiKey || '',
          contextWindow: Number(modelData.contextWindow) || converter.DEFAULT_CONTEXT_WINDOW,
          multimodal: modelData.multimodal === true,
          stream: modelData.stream !== false,
          enabled: modelData.enabled !== false,
          visible: modelData.visible !== false,
          isDefault: modelData.isDefault === true,
          freeUse: modelData.freeUse !== false,
          locked: modelData.locked === true,
          usageLevel: Number(modelData.usageLevel) || 0,
          aliases: Array.isArray(modelData.aliases) ? modelData.aliases : [],
        };

        if (existingIndex >= 0) {
          config.models[existingIndex] = { ...config.models[existingIndex], ...newModel };
        } else {
          config.models.push(newModel);
        }

        if (newModel.isDefault) {
          for (const m of config.models) {
            if (m.id.toLowerCase() !== modelId.toLowerCase()) m.isDefault = false;
          }
        }

        config.modelIndex = buildModelIndex(config.models);
        saveConfigToFile(config);
        sendJson(res, 200, { ok: true, success: true, model: newModel, models: config.models });
        return;
      }

      if (req.method === 'DELETE' && (pathname.startsWith('/api/bridge/models') || pathname.startsWith('/__bridge/api/models'))) {
        const idToDelete = url.searchParams.get('id') || pathname.split('/').pop();
        if (!idToDelete || idToDelete === 'models') {
          sendError(res, 400, 'model ID to delete is required');
          return;
        }

        const initialLength = config.models.length;
        config.models = config.models.filter((m) => m.id.toLowerCase() !== idToDelete.toLowerCase());
        if (config.models.length === initialLength) {
          sendError(res, 404, `model "${idToDelete}" not found`);
          return;
        }

        config.modelIndex = buildModelIndex(config.models);
        saveConfigToFile(config);
        sendJson(res, 200, { ok: true, success: true, deleted: idToDelete, models: config.models });
        return;
      }

      if (req.method === 'POST' && (pathname === '/api/bridge/models/delete' || pathname === '/__bridge/api/models/delete')) {
        const raw = await readBody(req, config.server.maxBodyBytes);
        let body;
        try {
          body = parseJsonBody(raw);
        } catch {
          body = {};
        }
        const idToDelete = body.id || url.searchParams.get('id');
        if (!idToDelete) {
          sendError(res, 400, 'model ID to delete is required');
          return;
        }

        config.models = config.models.filter((m) => m.id.toLowerCase() !== idToDelete.toLowerCase());
        config.modelIndex = buildModelIndex(config.models);
        saveConfigToFile(config);
        sendJson(res, 200, { ok: true, success: true, deleted: idToDelete, models: config.models });
        return;
      }

      if (req.method === 'POST' && (pathname === '/api/bridge/test' || pathname === '/__bridge/api/test')) {
        const raw = await readBody(req, config.server.maxBodyBytes);
        let body;
        try {
          body = parseJsonBody(raw);
        } catch (err) {
          sendError(res, 400, `invalid JSON: ${err.message}`);
          return;
        }
        const modelId = (body.model || body.modelId || '').trim().toLowerCase();
        const prompt = body.prompt || 'Hello! Test connection.';
        const model = config.modelIndex.get(modelId);
        if (!model) {
          sendError(res, 404, `model "${body.model || body.modelId}" not found`);
          return;
        }
        const genAiBody = {
          model: model.id,
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: Number(body.temperature) || 0.7 },
        };
        const genAiRaw = Buffer.from(JSON.stringify(genAiBody), 'utf8');
        await handleGenerate(req, res, config, proxy, genAiRaw);
        return;
      }

      // --- Desktop provider management (Agent C / CONTRACT.md section 4) ---
      if (req.method === 'GET' && pathname === '/api/bridge/providers') {
        sendJson(res, 200, { ok: true, providers: buildProviders(config) });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/bridge/providers') {
        let body;
        try {
          body = parseJsonBody(await readBody(req, config.server.maxBodyBytes));
        } catch (err) {
          sendError(res, 400, `invalid JSON: ${err.message}`);
          return;
        }
        const provider = String(body.provider || '').toLowerCase();
        if (provider !== 'ollama' && provider !== 'openai') {
          sendError(res, 400, 'provider must be "ollama" or "openai"');
          return;
        }
        if (!isValidHttpUrl(body.baseUrl)) {
          sendError(res, 400, 'baseUrl must be a valid http(s) URL');
          return;
        }
        if (body.apiKey !== undefined && typeof body.apiKey !== 'string') {
          sendError(res, 400, 'apiKey must be a string');
          return;
        }
        if (!Array.isArray(body.models) || body.models.length === 0) {
          sendError(res, 400, 'models must be a non-empty array');
          return;
        }
        for (const entry of body.models) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            sendError(res, 400, 'each model must be an object');
            return;
          }
          if (typeof entry.id !== 'string' || !entry.id.trim()) {
            sendError(res, 400, 'each model requires a non-empty string "id"');
            return;
          }
        }
        const providerBaseUrl = normalizeBaseUrl(body.baseUrl);
        const providerApiKey = typeof body.apiKey === 'string' ? body.apiKey : '';
        for (const entry of body.models) {
          const id = entry.id.trim();
          const existingIndex = config.models.findIndex((m) => m.id.toLowerCase() === id.toLowerCase());
          const existing = existingIndex >= 0 ? config.models[existingIndex] : null;
          const model = buildProviderModel(entry, {
            provider,
            baseUrl: providerBaseUrl,
            apiKey: providerApiKey,
            existing,
          });
          if (existingIndex >= 0) config.models[existingIndex] = model;
          else config.models.push(model);
        }
        config.modelIndex = buildModelIndex(config.models);
        saveConfigToFile(config);
        const providers = buildProviders(config);
        const groupId = providerGroupId(provider, providerBaseUrl, providerApiKey);
        sendJson(res, 200, { ok: true, provider: providers.find((g) => g.id === groupId) || null, providers });
        return;
      }

      if (req.method === 'POST' && pathname.startsWith('/api/bridge/providers/') && pathname.endsWith('/models')) {
        const rawSegment = pathname.slice('/api/bridge/providers/'.length, pathname.length - '/models'.length);
        let groupId = rawSegment.replace(/\/+$/, '');
        try {
          groupId = decodeURIComponent(groupId);
        } catch {
          /* keep raw */
        }
        const group = findProviderGroup(config, groupId);
        if (!group) {
          sendError(res, 404, `provider "${groupId}" not found`);
          return;
        }
        const memberIds = new Set(group.models.map((m) => m.id));
        const canonical = config.models.find((m) => memberIds.has(m.id)) || {};
        const provider = canonical.provider;
        const baseUrl = normalizeBaseUrl(canonical.baseUrl);
        const apiKey = canonical.apiKey || '';

        let body;
        try {
          body = parseJsonBody(await readBody(req, config.server.maxBodyBytes));
        } catch (err) {
          sendError(res, 400, `invalid JSON: ${err.message}`);
          return;
        }
        if (!Array.isArray(body.models) || body.models.length === 0) {
          sendError(res, 400, 'models must be a non-empty array');
          return;
        }
        for (const entry of body.models) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            sendError(res, 400, 'each model must be an object');
            return;
          }
          if (typeof entry.id !== 'string' || !entry.id.trim()) {
            sendError(res, 400, 'each model requires a non-empty string "id"');
            return;
          }
        }
        for (const entry of body.models) {
          const id = entry.id.trim();
          const existingIndex = config.models.findIndex((m) => m.id.toLowerCase() === id.toLowerCase());
          const existing = existingIndex >= 0 ? config.models[existingIndex] : null;
          const model = buildProviderModel(entry, { provider, baseUrl, apiKey, existing });
          if (existingIndex >= 0) config.models[existingIndex] = model;
          else config.models.push(model);
        }
        config.modelIndex = buildModelIndex(config.models);
        saveConfigToFile(config);
        const providers = buildProviders(config);
        const resolvedGroupId = providerGroupId(provider, baseUrl, apiKey);
        sendJson(res, 200, { ok: true, provider: providers.find((g) => g.id === resolvedGroupId) || null, providers });
        return;
      }

      if ((req.method === 'PATCH' || req.method === 'DELETE') && pathname.startsWith('/api/bridge/providers/')) {
        const rawSegment = pathname.slice('/api/bridge/providers/'.length);
        let groupId = rawSegment;
        try {
          groupId = decodeURIComponent(rawSegment);
        } catch {
          groupId = rawSegment;
        }
        const group = findProviderGroup(config, groupId);
        if (!group) {
          sendError(res, 404, `provider "${groupId}" not found`);
          return;
        }
        const memberIds = new Set(group.models.map((m) => m.id));

        if (req.method === 'DELETE') {
          const removed = [];
          config.models = config.models.filter((m) => {
            if (memberIds.has(m.id)) {
              removed.push(m.id);
              return false;
            }
            return true;
          });
          config.modelIndex = buildModelIndex(config.models);
          saveConfigToFile(config);
          sendJson(res, 200, { ok: true, deleted: removed, providers: buildProviders(config) });
          return;
        }

        let body;
        try {
          body = parseJsonBody(await readBody(req, config.server.maxBodyBytes));
        } catch (err) {
          sendError(res, 400, `invalid JSON: ${err.message}`);
          return;
        }
        if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
          sendError(res, 400, 'enabled must be a boolean');
          return;
        }
        if (body.baseUrl !== undefined && (typeof body.baseUrl !== 'string' || !isValidHttpUrl(body.baseUrl))) {
          sendError(res, 400, 'baseUrl must be a valid http(s) URL');
          return;
        }
        if (body.apiKey !== undefined && typeof body.apiKey !== 'string') {
          sendError(res, 400, 'apiKey must be a string');
          return;
        }
        const memberModels = config.models.filter((m) => memberIds.has(m.id));
        const canonical = memberModels[0] || {};
        const currentBaseUrl = normalizeBaseUrl(canonical.baseUrl);
        const currentApiKey = canonical.apiKey || '';
        const newBaseUrl = body.baseUrl !== undefined ? normalizeBaseUrl(body.baseUrl) : currentBaseUrl;
        const newApiKey = body.apiKey !== undefined ? body.apiKey : currentApiKey;
        for (const model of config.models) {
          if (!memberIds.has(model.id)) continue;
          if (body.enabled !== undefined) model.enabled = body.enabled;
          if (body.baseUrl !== undefined) model.baseUrl = newBaseUrl;
          if (body.apiKey !== undefined) model.apiKey = newApiKey;
        }
        config.modelIndex = buildModelIndex(config.models);
        saveConfigToFile(config);
        const providers = buildProviders(config);
        const newGroupId = providerGroupId(group.provider, newBaseUrl, newApiKey);
        sendJson(res, 200, { ok: true, provider: providers.find((g) => g.id === newGroupId) || null, providers });
        return;
      }

      if (req.method === 'PATCH' && pathname.startsWith('/api/bridge/models/')) {
        const rawSegment = pathname.slice('/api/bridge/models/'.length);
        let modelId = rawSegment;
        try {
          modelId = decodeURIComponent(rawSegment);
        } catch {
          modelId = rawSegment;
        }
        const model = config.models.find((m) => m.id.toLowerCase() === modelId.toLowerCase());
        if (!model) {
          sendError(res, 404, `model "${modelId}" not found`);
          return;
        }
        let body;
        try {
          body = parseJsonBody(await readBody(req, config.server.maxBodyBytes));
        } catch (err) {
          sendError(res, 400, `invalid JSON: ${err.message}`);
          return;
        }
        for (const field of ['enabled', 'visible', 'isDefault', 'multimodal', 'stream']) {
          if (body[field] !== undefined && typeof body[field] !== 'boolean') {
            sendError(res, 400, `${field} must be a boolean`);
            return;
          }
        }
        if (body.displayName !== undefined && typeof body.displayName !== 'string') {
          sendError(res, 400, 'displayName must be a string');
          return;
        }
        if (body.upstreamModel !== undefined && typeof body.upstreamModel !== 'string') {
          sendError(res, 400, 'upstreamModel must be a string');
          return;
        }
        if (body.contextWindow !== undefined && !isValidContextWindow(body.contextWindow)) {
          sendError(res, 400, 'contextWindow must be a number');
          return;
        }
        if (body.enabled !== undefined) model.enabled = body.enabled;
        if (body.visible !== undefined) model.visible = body.visible;
        if (body.multimodal !== undefined) model.multimodal = body.multimodal;
        if (body.stream !== undefined) model.stream = body.stream;
        if (body.displayName !== undefined && body.displayName.trim()) model.displayName = body.displayName;
        if (body.upstreamModel !== undefined && body.upstreamModel.trim()) model.upstreamModel = body.upstreamModel;
        if (body.contextWindow !== undefined) model.contextWindow = Number(body.contextWindow);
        if (body.isDefault === true) {
          for (const m of config.models) m.isDefault = m.id === model.id;
        } else if (body.isDefault === false) {
          model.isDefault = false;
        }
        // locked / freeUse are intentionally ignored: custom models stay unlocked & free.
        config.modelIndex = buildModelIndex(config.models);
        saveConfigToFile(config);
        sendJson(res, 200, { ok: true, model: maskedModel(model), providers: buildProviders(config) });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/bridge/discover') {
        const force = url.searchParams.get('force') === 'true';
        const now = Date.now();
        let cached = false;
        if (force || !discoverCache.data || now - discoverCache.at > DISCOVER_CACHE_TTL_MS) {
          const skipPorts = [req.socket?.localPort, config.server.port].filter((p) => Number.isFinite(p));
          discoverCache.data = await discovery.discover({
            timeoutMs: 700,
            hosts: ['127.0.0.1'],
            skipPorts,
            models: config.models,
          });
          discoverCache.at = Date.now();
        } else {
          cached = true;
        }
        const services = discovery.annotateAlreadyAdded(discoverCache.data.services, config.models);
        sendJson(res, 200, { ok: true, cached, scannedAt: discoverCache.data.scannedAt, services });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/bridge/discover/models') {
        let body;
        try {
          body = parseJsonBody(await readBody(req, config.server.maxBodyBytes));
        } catch (err) {
          sendJson(res, 200, { ok: false, error: `invalid JSON: ${err.message}`, models: [] });
          return;
        }
        let provider = body.provider;
        let baseUrl = body.baseUrl;
        let apiKey = body.apiKey;
        if (body.providerId !== undefined && body.providerId !== null && body.providerId !== '') {
          let providerId = String(body.providerId);
          try {
            providerId = decodeURIComponent(providerId);
          } catch {
            /* keep raw */
          }
          const group = findProviderGroup(config, providerId);
          if (!group) {
            sendJson(res, 200, { ok: false, error: `provider "${providerId}" not found`, models: [] });
            return;
          }
          const memberIds = new Set(group.models.map((m) => m.id));
          const canonical = config.models.find((m) => memberIds.has(m.id)) || {};
          provider = canonical.provider;
          baseUrl = canonical.baseUrl;
          apiKey = canonical.apiKey || '';
        }
        if (!isValidHttpUrl(baseUrl)) {
          sendError(res, 400, 'baseUrl must be a valid http(s) URL');
          return;
        }
        if (apiKey !== undefined && typeof apiKey !== 'string') {
          sendError(res, 400, 'apiKey must be a string');
          return;
        }
        try {
          const models = await discovery.listModelsFor({ provider, baseUrl, apiKey }, 10000);
          sendJson(res, 200, { ok: true, models });
        } catch (err) {
          sendJson(res, 200, { ok: false, error: err.message, models: [] });
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/api/bridge/logs') {
        const levelParam = String(url.searchParams.get('level') || '').toLowerCase();
        const threshold = LEVELS[levelParam];
        let linesParam = parseInt(url.searchParams.get('lines'), 10);
        if (!Number.isFinite(linesParam) || linesParam <= 0) linesParam = 200;
        if (linesParam > LOG_BUFFER_CAPACITY) linesParam = LOG_BUFFER_CAPACITY;
        let entries = logBuffer;
        if (threshold !== undefined) {
          entries = entries.filter((entry) => (LEVELS[entry.level] ?? 0) >= threshold);
        }
        const lines = entries.slice(-linesParam);
        sendJson(res, 200, { ok: true, lines, total: lines.length });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/bridge/usage') {
        sendJson(res, 200, { ok: true, usage: usageSnapshot(), since: USAGE_SINCE });
        return;
      }

      if (pathname === '/api/llm/config/v2' && req.method === 'POST') {
        const raw = await readBody(req, config.server.maxBodyBytes);
        await handleCatalog(req, res, config, raw);
        return;
      }

      const isGeneratePath = pathname === '/api/adk/llm/generateContent'
        || pathname === '/api/adk/llm'
        || pathname === '/api/adk/llm/generateContent/stream';

      if (isGeneratePath && req.method === 'POST') {
        if (!authorize(req, config)) {
          sendError(res, 401, 'invalid gateway token');
          return;
        }
        const raw = await readBody(req, config.server.maxBodyBytes);
        await handleGenerate(req, res, config, proxy, raw);
        return;
      }

      const raw = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
        ? await readBody(req, config.server.maxBodyBytes)
        : undefined;
      await proxy(req, res, raw);
    } catch (err) {
      log.error(`unhandled ${req.method} ${req.url}: ${err.stack || err.message}`);
      if (!res.headersSent) {
        sendError(res, err.statusCode || 500, err.message);
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  server.headersTimeout = 60000;
  server.keepAliveTimeout = 72000;
  return server;
}

function main() {
  const config = loadConfig();
  log = makeLogger(config.server.logLevel);

  const server = createServer(config);

  server.listen(config.server.port, config.server.host, () => {
    log.info(`accio gateway bridge listening on http://${config.server.host}:${config.server.port}`);
    log.info(`upstream: ${config.upstream.baseUrl}`);
    log.info(`custom models: ${config.models.filter((model) => model.enabled).map((model) => model.id).join(', ') || '(none)'}`);
    log.info(`set GATEWAY_BASE_URL=http://${config.server.host}:${config.server.port} in Accio Desktop`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') fail(`port ${config.server.port} is already in use`);
    fail(err.message);
  });
  server.on('clientError', (err, socket) => {
    if (err.code === 'ECONNRESET' || !socket.writable) return;
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  process.on('uncaughtException', (err) => {
    log.error(`uncaughtException: ${err.message}`);
  });
  process.on('unhandledRejection', (reason) => {
    log.error(`unhandledRejection: ${reason?.message || reason}`);
  });


  const shutdown = (signal) => {
    log.info(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) main();

module.exports = { createServer, loadConfig, normalizeConfig, buildModelIndex };



