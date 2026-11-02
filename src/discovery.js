'use strict';

/**
 * discovery.js — local inference-service discovery + remote model listing.
 *
 * Zero external dependencies: node:http via global fetch (Node 18+).
 *
 * Exports:
 *   discover({ timeoutMs, hosts, skipPorts, probes, models })
 *     -> { scannedAt, services: Service[] }
 *   listModelsFor({ provider, baseUrl, apiKey }, timeoutMs) -> string[]
 *   annotateAlreadyAdded(services, models) -> Service[]
 */

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Probe table from the desktop contract.
 * `baseUrlPath` is the suffix appended to `http://host:port` for the service baseUrl.
 * `path` is the request path used to detect the service.
 */
const PROBE_TABLE = [
  { kind: 'ollama', name: 'Ollama', provider: 'ollama', port: 11434, path: '/api/tags', baseUrlPath: '' },
  { kind: 'lmstudio', name: 'LM Studio', provider: 'openai', port: 1234, path: '/v1/models', baseUrlPath: '/v1' },
  { kind: 'vllm', name: 'vLLM', provider: 'openai', port: 8000, path: '/v1/models', baseUrlPath: '/v1' },
  { kind: 'llamacpp', name: 'llama.cpp', provider: 'openai', port: 8080, path: '/v1/models', baseUrlPath: '/v1' },
  { kind: 'koboldcpp', name: 'KoboldCpp', provider: 'openai', port: 5001, path: '/api/v1/model', baseUrlPath: '/v1' },
  { kind: 'localai', name: 'LocalAI', provider: 'openai', port: 8081, path: '/v1/models', baseUrlPath: '/v1' },
  { kind: 'jan', name: 'Jan', provider: 'openai', port: 1337, path: '/v1/models', baseUrlPath: '/v1' },
  { kind: 'textgen', name: 'Text Generation WebUI', provider: 'openai', port: 5000, path: '/v1/models', baseUrlPath: '/v1' },
];

/** Secondary ports probed with the generic OpenAI-compatible `/v1/models` shape. */
const EXTRA_OPENAI_PORTS = [11435, 1235, 8001, 8082, 5002, 1338];

const GENERIC_KINDS = new Set(['openai', 'openai-compatible']);

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function buildDefaultProbes(hosts) {
  const probes = [];
  for (const host of hosts) {
    for (const entry of PROBE_TABLE) {
      probes.push({
        host,
        port: entry.port,
        kind: entry.kind,
        name: entry.name,
        provider: entry.provider,
        path: entry.path,
        baseUrl: `http://${host}:${entry.port}${entry.baseUrlPath}`,
      });
    }
    for (const port of EXTRA_OPENAI_PORTS) {
      probes.push({
        host,
        port,
        kind: 'openai',
        name: 'OpenAI-compatible',
        provider: 'openai',
        path: '/v1/models',
        baseUrl: `http://${host}:${port}/v1`,
      });
    }
  }
  return probes;
}

function normalizeProbe(input, defaultHost) {
  const host = input.host || defaultHost;
  const provider = String(input.provider || 'openai').toLowerCase();
  const port = Number(input.port);
  const suffix = provider === 'ollama' ? '' : '/v1';
  return {
    host,
    port,
    kind: input.kind || 'openai',
    name: input.name || 'OpenAI-compatible',
    provider,
    path: input.path || '/v1/models',
    baseUrl: input.baseUrl || `http://${host}:${port}${suffix}`,
  };
}

function parseOllamaModels(json) {
  if (!json || !Array.isArray(json.models)) return null;
  return json.models
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry.name === 'string' && entry.name) return entry.name;
      return null;
    })
    .filter(Boolean);
}

function parseOpenaiModels(json) {
  if (!json || !Array.isArray(json.data)) return null;
  return json.data
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry.id === 'string' && entry.id) return entry.id;
      return null;
    })
    .filter(Boolean);
}

function parseKoboldModel(json) {
  if (!json || typeof json.result !== 'string' || !json.result.trim()) return null;
  const raw = json.result.trim();
  const name = raw.includes('/') ? raw.split('/').pop() : raw;
  return [name || raw];
}

function parseModelsForKind(kind, json) {
  if (kind === 'ollama') return parseOllamaModels(json);
  if (kind === 'koboldcpp') return parseKoboldModel(json);
  return parseOpenaiModels(json);
}

/** Read a fetch body as text, returning null when it exceeds the size cap. */
async function readLimitedText(response, maxBytes) {
  let reader = null;
  try {
    reader = response.body && typeof response.body.getReader === 'function' ? response.body.getReader() : null;
  } catch {
    reader = null;
  }
  if (!reader) {
    const text = await response.text();
    return Buffer.byteLength(text, 'utf8') > maxBytes ? null : text;
  }
  const decoder = new TextDecoder('utf-8');
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      return null;
    }
    chunks.push(value);
  }
  return decoder.decode(Buffer.concat(chunks));
}

/** Probe a single host:port/path. Returns a Service or null when not a match. */
async function probeOne(probe, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(`http://${probe.host}:${probe.port}${probe.path}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const text = await readLimitedText(response, MAX_RESPONSE_BYTES);
    if (text === null) return null;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return null;
    }
    const models = parseModelsForKind(probe.kind, json);
    if (!models) return null; // unexpected shape -> not this service
    return {
      id: `${probe.kind}@${probe.host}:${probe.port}`,
      kind: probe.kind,
      name: probe.name,
      provider: probe.provider,
      host: probe.host,
      port: probe.port,
      baseUrl: probe.baseUrl,
      models,
      alreadyAdded: [],
      latencyMs: Date.now() - started,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function computeAdded(service, models) {
  const target = stripTrailingSlash(service.baseUrl);
  const added = new Set();
  for (const model of models) {
    if (!model || typeof model !== 'object') continue;
    if (String(model.provider) !== String(service.provider)) continue;
    if (stripTrailingSlash(model.baseUrl) !== target) continue;
    const known = [model.upstreamModel, model.id, model.modelCode].filter((x) => typeof x === 'string');
    for (const name of service.models) {
      if (known.includes(name)) added.add(name);
    }
  }
  return service.models.filter((name) => added.has(name));
}

/** Return a copy of `services` with `alreadyAdded` recomputed against `models`. */
function annotateAlreadyAdded(services, models) {
  const list = Array.isArray(models) ? models : [];
  return services.map((service) => ({ ...service, alreadyAdded: computeAdded(service, list) }));
}

async function discover(options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 700;
  const hosts = Array.isArray(options.hosts) && options.hosts.length ? options.hosts : ['127.0.0.1'];
  const skipPorts = new Set(
    (Array.isArray(options.skipPorts) ? options.skipPorts : []).map((p) => Number(p)).filter((p) => Number.isFinite(p))
  );
  const models = Array.isArray(options.models) ? options.models : [];

  const rawProbes = Array.isArray(options.probes) && options.probes.length
    ? options.probes.map((probe) => normalizeProbe(probe, hosts[0]))
    : buildDefaultProbes(hosts);

  const probes = rawProbes.filter((probe) => Number.isFinite(probe.port) && probe.port > 0 && !skipPorts.has(probe.port));

  const results = await Promise.allSettled(probes.map((probe) => probeOne(probe, timeoutMs)));

  const successes = results
    .filter((result) => result.status === 'fulfilled' && result.value)
    .map((result) => result.value);

  // Dedup by host:port, preferring a specific kind over the generic OpenAI probe.
  successes.sort((a, b) => {
    const aGeneric = GENERIC_KINDS.has(a.kind) ? 1 : 0;
    const bGeneric = GENERIC_KINDS.has(b.kind) ? 1 : 0;
    if (aGeneric !== bGeneric) return aGeneric - bGeneric;
    return `${a.host}:${a.port}`.localeCompare(`${b.host}:${b.port}`);
  });

  const seen = new Set();
  const services = [];
  for (const service of successes) {
    const key = `${service.host}:${service.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    services.push(service);
  }

  services.sort((a, b) => `${a.host}:${a.port}`.localeCompare(`${b.host}:${b.port}`));

  return {
    scannedAt: new Date().toISOString(),
    services: annotateAlreadyAdded(services, models),
  };
}

async function listModelsFor(options = {}, timeoutMs = 10000) {
  const provider = String(options.provider || 'openai').toLowerCase();
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey : '';
  const base = stripTrailingSlash(options.baseUrl || '');
  if (!isHttpUrl(base)) throw new Error('baseUrl must be a valid http(s) URL');

  const isOllama = provider === 'ollama';
  const url = isOllama ? `${base}/api/tags` : `${base}/models`;
  const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : 10000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limit);

  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) throw new Error(`request to ${url} timed out after ${limit}ms`);
    throw new Error(`cannot reach ${url}: ${err.message}`);
  }

  try {
    if (!response.ok) {
      await response.text().catch(() => '');
      throw Object.assign(new Error(`upstream returned HTTP ${response.status}`), {
        status: response.status,
        statusCode: response.status,
      });
    }
    const text = await readLimitedText(response, MAX_RESPONSE_BYTES);
    if (text === null) throw new Error('upstream response exceeded size limit');
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('upstream returned invalid JSON');
    }
    const models = isOllama ? parseOllamaModels(json) : parseOpenaiModels(json);
    if (!models) throw new Error('upstream returned an unexpected response shape');
    return models;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  discover,
  listModelsFor,
  annotateAlreadyAdded,
  PROBE_TABLE,
  EXTRA_OPENAI_PORTS,
};