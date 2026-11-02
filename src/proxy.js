'use strict';

/**
 * proxy.js
 *
 * Transparent reverse proxy to the official Accio gateway
 * (`https://phoenix-gw.alibaba.com`). Used for every request the bridge does
 * not handle itself (auth, entitlement, tools, skills, heartbeat, official
 * model inference, ...) so login and cloud features keep working.
 *
 * The request/response bodies are streamed, never buffered, so SSE and large
 * uploads behave exactly like the direct connection.
 */

const http = require('node:http');
const https = require('node:https');

/** Hop-by-hop headers that must not be forwarded verbatim. */
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-authenticate',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Response headers that break clients when copied from an already-decoded body. */
const STRIPPED_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding']);

function sanitizeRequestHeaders(headers, { hasBody }) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (hasBody && lower === 'content-length') continue;
    out[key] = value;
  }
  return out;
}

function sanitizeResponseHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Create the proxy handler.
 *
 * @param {object} options
 * @param {string} options.upstreamBaseUrl e.g. https://phoenix-gw.alibaba.com
 * @param {number} [options.timeoutMs]
 * @param {string} [options.apiKey] injected as bearer when the client sends none
 * @param {(level: string, ...args: unknown[]) => void} [options.log]
 * @param {string} [options.mountPath] prefix stripped before building the upstream path
 */
function createProxyHandler(options) {
  const upstream = new URL(options.upstreamBaseUrl);
  const transport = upstream.protocol === 'http:' ? http : https;
  const timeoutMs = Number(options.timeoutMs) || 300000;
  const log = options.log || (() => {});
  const mountPath = (options.mountPath || '').replace(/\/+$/, '');

  const agent = new transport.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 128 });

  return function proxyRequest(req, res, rawBody) {
    const hasBody = Buffer.isBuffer(rawBody) && rawBody.length > 0;
    const headers = sanitizeRequestHeaders(req.headers, { hasBody });

    if (hasBody) headers['content-length'] = String(rawBody.length);
    else if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      headers['content-length'] = '0';
    }
    if (options.apiKey && !headers.authorization && !headers.Authorization) {
      headers.authorization = `Bearer ${options.apiKey}`;
    }

    const requestPath = buildUpstreamPath(req, mountPath);

    res.on('error', (err) => {
      log('debug', `client socket error on ${req.method} ${requestPath}: ${err.message}`);
    });
    req.on('error', (err) => {
      log('debug', `client request error on ${req.method} ${requestPath}: ${err.message}`);
    });

    return new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const upstreamReq = transport.request(
        {
          protocol: upstream.protocol,
          hostname: upstream.hostname,
          port: upstream.port || (upstream.protocol === 'http:' ? 80 : 443),
          method: req.method,
          path: requestPath,
          headers,
          agent,
          servername: upstream.hostname,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode || 502, sanitizeResponseHeaders(upstreamRes.headers));
          upstreamRes.pipe(res);
          upstreamRes.on('end', settle);
          upstreamRes.on('error', (err) => {
            log('warn', 'upstream response error', err.message);
            res.destroy(err);
            settle();
          });
        },
      );

      upstreamReq.setTimeout(timeoutMs, () => {
        upstreamReq.destroy(new Error(`upstream timeout after ${timeoutMs}ms`));
      });

      upstreamReq.on('error', (err) => {
        log('error', `${req.method} ${requestPath} -> ${err.message}`);
        if (!res.headersSent) {
          const payload = JSON.stringify({
            success: false,
            code: '502',
            message: `gateway bridge upstream error: ${err.message}`,
          });
          res.writeHead(502, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(payload),
          });
          res.end(payload);
        } else {
          res.destroy(err);
        }
        settle();
      });

      // Abort the upstream call when the desktop client goes away.
      res.on('close', () => {
        if (!res.writableEnded) {
          upstreamReq.destroy(new Error('client disconnected'));
          settle();
        }
      });

      if (hasBody) upstreamReq.write(rawBody);
      upstreamReq.end();
    });
  };
}

/**
 * Rebuild the original request path (query string preserved). The `mountPath`
 * prefix is stripped when the proxy is mounted below a sub path.
 */
function buildUpstreamPath(req, mountPath) {
  let path = req.url || '/';
  if (mountPath && path.startsWith(mountPath)) {
    path = path.slice(mountPath.length) || '/';
    if (!path.startsWith('/')) path = `/${path}`;
  }
  return path;
}

module.exports = { createProxyHandler, buildUpstreamPath, sanitizeRequestHeaders };
