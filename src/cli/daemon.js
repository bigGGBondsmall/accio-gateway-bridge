'use strict';

/**
 * daemon.js — Magpie-style background service manager for the Accio Gateway Bridge.
 * Controls daemon start, stop, restart, status checks, and log tailing.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, execSync } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const PID_FILE = path.join(PROJECT_ROOT, '.accio-bridge.pid');
const LOG_FILE = path.join(PROJECT_ROOT, 'bridge.log');
const SERVER_SCRIPT = path.join(PROJECT_ROOT, 'src', 'server.js');

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // EPERM means exists but owned by someone else
  }
}

function readPid() {
  try {
    if (!fs.existsSync(PID_FILE)) return null;
    const raw = fs.readFileSync(PID_FILE, 'utf8').trim();
    const pid = parseInt(raw, 10);
    if (isNaN(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

function writePid(pid) {
  fs.writeFileSync(PID_FILE, String(pid), 'utf8');
}

function clearPid() {
  try {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  } catch {}
}

/**
 * Ping local bridge server to check if it's accepting HTTP requests.
 */
function probeHealth(host = '127.0.0.1', port = 8080, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host,
        port,
        path: '/healthz',
        timeout: timeoutMs,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            resolve({ ok: res.statusCode === 200, data });
          } catch {
            resolve({ ok: res.statusCode === 200, data: null });
          }
        });
      }
    );

    req.on('error', () => resolve({ ok: false, error: 'connection refused' }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
  });
}

/**
 * Start the bridge server in background mode.
 */
async function startDaemon(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = Number(options.port) || 8080;

  const existingPid = readPid();
  if (existingPid && isPidAlive(existingPid)) {
    const health = await probeHealth(host, port, 1000);
    if (health.ok) {
      return {
        ok: true,
        alreadyRunning: true,
        pid: existingPid,
        port,
        host,
      };
    }
  }

  const env = {
    ...process.env,
    ACCIO_BRIDGE_DAEMON: '1',
    ACCIO_BRIDGE_LOG_FILE: LOG_FILE,
  };

  const child = spawn(process.execPath, [SERVER_SCRIPT], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: 'ignore',
    env,
    windowsHide: true,
  });
  const pid = child.pid;
  writePid(pid);
  child.unref();

  // Wait briefly and verify health
  let healthy = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (!isPidAlive(pid)) {
      break;
    }
    const check = await probeHealth(host, port, 500);
    if (check.ok) {
      healthy = true;
      break;
    }
  }

  if (!healthy && !isPidAlive(pid)) {
    clearPid();
    let logTail = '';
    try {
      if (fs.existsSync(LOG_FILE)) {
        const text = fs.readFileSync(LOG_FILE, 'utf8');
        logTail = text.split('\n').slice(-10).join('\n');
      }
    } catch {}
    return {
      ok: false,
      error: 'Daemon failed to start. Process terminated unexpectedly.',
      logTail,
    };
  }

  return {
    ok: true,
    started: true,
    pid,
    port,
    host,
  };
}

/**
 * Stop the background bridge server.
 */
async function stopDaemon() {
  const pid = readPid();
  if (!pid) {
    return { ok: true, notRunning: true };
  }

  if (!isPidAlive(pid)) {
    clearPid();
    return { ok: true, notRunning: true, pid };
  }

  try {
    if (process.platform === 'win32') {
      try {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch (err) {
    return { ok: false, error: err.message, pid };
  }

  clearPid();
  return { ok: true, stopped: true, pid };
}

/**
 * Check daemon status.
 */
async function getDaemonStatus(host = '127.0.0.1', port = 8080) {
  const pid = readPid();
  const alive = pid ? isPidAlive(pid) : false;
  const health = await probeHealth(host, port, 1200);

  return {
    running: alive && health.ok,
    processAlive: alive,
    pid: alive ? pid : null,
    port,
    host,
    health: health.data,
  };
}

function tailLog(n = 25) {
  try {
    if (!fs.existsSync(LOG_FILE)) return '(No log file found)';
    const text = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = text.trim().split('\n');
    return lines.slice(-n).join('\n');
  } catch (err) {
    return `Error reading log file: ${err.message}`;
  }
}

module.exports = {
  PROJECT_ROOT,
  PID_FILE,
  LOG_FILE,
  startDaemon,
  stopDaemon,
  getDaemonStatus,
  tailLog,
  probeHealth,
};
