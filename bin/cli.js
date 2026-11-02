#!/usr/bin/env node
'use strict';

/**
 * bin/cli.js — Magpie-style terminal client for Accio Gateway Bridge.
 * Commands: ls, status, serve, daemon, providers, models, model, test, launch, evidence.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { c, symbols, formatTable, printHeader, padRight, padLeft } = require('../src/cli/terminal');
const { startDaemon, stopDaemon, getDaemonStatus, tailLog, probeHealth } = require('../src/cli/daemon');
const { runStreamingTest } = require('../src/cli/tester');
const { detectAccioWorkCN } = require('../src/accio-detect');

const CONFIG_PATH = process.env.ACCIO_BRIDGE_CONFIG || path.join(__dirname, '..', 'config.json');

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { server: { host: '127.0.0.1', port: 8080 }, upstream: {}, models: [] };
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch (err) {
    console.error(c.red(`Failed to load config from ${CONFIG_PATH}: ${err.message}`));
    return { server: { host: '127.0.0.1', port: 8080 }, upstream: {}, models: [] };
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Subcommand Handlers
// ---------------------------------------------------------------------------

/**
 * accio ls — List detected agents, active model, and configuration paths
 * (Direct imitation of `magpie ls`)
 */
async function cmdLs() {
  printHeader('accio', 'agent inspection & gateway bindings');

  const config = loadConfig();
  const detection = detectAccioWorkCN();
  const defaultModel = config.models?.find((m) => m.isDefault && m.enabled) || config.models?.find((m) => m.enabled);
  const modelLabel = defaultModel ? `${defaultModel.provider}/${defaultModel.id}` : 'official/qwen';

  const rows = [];

  if (detection.installed) {
    const isRunning = detection.running;
    const dot = isRunning ? symbols.activeDot : symbols.inactiveDot;
    const editionName = detection.edition === 'cn' ? 'Accio Work (中国版)' : detection.edition === 'global' ? 'Accio Work (国际版)' : 'Accio Work';
    const statusNote = isRunning ? `running (PID: ${detection.runningPids.join(',')})` : 'idle';
    const gwUrl = `gateway http://${config.server?.host || '127.0.0.1'}:${config.server?.port || 8080}`;
    const cfgPath = path.join(process.env.USERPROFILE || '', '.accio', 'domain-config.json');

    rows.push([
      `  ${editionName}`,
      modelLabel,
      symbols.bullet,
      gwUrl,
      symbols.bullet,
      statusNote,
      c.gray(cfgPath),
    ]);
  } else {
    rows.push([
      '  Accio Work',
      c.gray('— not installed —'),
      symbols.bullet,
      c.gray('download: https://www.accio-ai.com/work'),
    ]);
  }

  console.log(formatTable(rows, 2));
  console.log();
}

/**
 * accio status — High-level summary of bridge server and client
 */
async function cmdStatus() {
  printHeader('accio', 'system status & health');

  const config = loadConfig();
  const host = config.server?.host || '127.0.0.1';
  const port = Number(config.server?.port) || 8080;

  const daemon = await getDaemonStatus(host, port);
  const detection = detectAccioWorkCN();

  const activeModels = (config.models || []).filter((m) => m.enabled);

  console.log(c.bold('Gateway Bridge'));
  if (daemon.running) {
    console.log(`  Status       : ${symbols.activeDot} ${c.green('running')} on http://${host}:${port} (PID: ${daemon.pid})`);
  } else if (daemon.processAlive) {
    console.log(`  Status       : ${symbols.warningDot} ${c.yellow('process alive')} (PID: ${daemon.pid}) but HTTP health check failing`);
  } else {
    console.log(`  Status       : ${symbols.inactiveDot} ${c.gray('stopped')} (run \`accio serve\` or \`accio daemon start\`)`);
  }
  console.log(`  Upstream     : ${c.cyan(config.upstream?.baseUrl || 'https://phoenix-gw.alibaba.com')}`);
  console.log(`  Custom Models: ${c.bold(activeModels.length)} active / ${config.models?.length || 0} total (locked: false, freeUse: true)`);
  console.log();

  console.log(c.bold('Accio Work Client'));
  if (!detection.installed) {
    console.log(`  Status       : ${symbols.inactiveDot} ${c.yellow('not detected in standard paths')}`);
  } else {
    const isCn = detection.edition === 'cn';
    const tag = isCn ? c.green(`● ${detection.editionLabel}`) : c.blue(`● ${detection.editionLabel}`);
    console.log(`  Edition      : ${tag}`);
    console.log(`  Executable   : ${detection.path}`);
    console.log(`  Version      : v${detection.version || '0.34.5'}`);
    console.log(`  Process      : ${detection.running ? c.green(`● running (PID: ${detection.runningPids.join(', ')})`) : c.gray('○ stopped')}`);
    console.log(`  Sign-in      : ${detection.signedIn ? c.green(`● ${detection.accountCount} local account(s) configured`) : c.gray('○ not signed in')}`);
  }
  console.log();
}

/**
 * accio providers — List known local and remote LLM providers
 * (Direct imitation of `magpie providers`)
 */
async function cmdProviders() {
  printHeader('accio', 'configured providers & endpoints');

  const config = loadConfig();
  const models = config.models || [];

  // Group models by provider / baseUrl
  const providerMap = new Map();
  for (const m of models) {
    const key = `${m.provider}::${m.baseUrl || ''}`;
    if (!providerMap.has(key)) {
      providerMap.set(key, {
        provider: m.provider,
        baseUrl: m.baseUrl,
        models: [],
        enabled: false,
      });
    }
    const entry = providerMap.get(key);
    entry.models.push(m.id);
    if (m.enabled) entry.enabled = true;
  }

  // Also include default standard probe targets if not present
  const standard = [
    { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', name: 'Ollama Local' },
    { provider: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', name: 'LM Studio' },
    { provider: 'openai', baseUrl: 'http://127.0.0.1:8000/v1', name: 'vLLM Local' },
  ];

  for (const s of standard) {
    const key = `${s.provider}::${s.baseUrl}`;
    if (!providerMap.has(key)) {
      providerMap.set(key, {
        provider: s.provider,
        baseUrl: s.baseUrl,
        models: [],
        enabled: false,
        name: s.name,
      });
    }
  }

  const rows = [];
  for (const [_, item] of providerMap.entries()) {
    const cleanUrl = (item.baseUrl || '').replace(/^https?:\/\//, '');
    const modelCountText = `${item.models.length} model${item.models.length === 1 ? '' : 's'}`;
    const dot = item.enabled ? symbols.activeDot : symbols.inactiveDot;
    const statusNote = item.enabled ? c.green('enabled in bridge') : c.gray('switched off');

    rows.push([
      `  ${padRight(item.name || item.provider, 16)}`,
      item.provider,
      cleanUrl,
      `${dot} ${statusNote}`,
      modelCountText,
    ]);
  }

  console.log(formatTable(rows, 3));
  console.log();
}

/**
 * accio models — List custom models
 * (Direct imitation of `magpie models`)
 */
async function cmdModels() {
  printHeader('accio', 'registered custom models');

  const config = loadConfig();
  const models = config.models || [];

  if (models.length === 0) {
    console.log(c.gray('  No custom models registered in config.json.'));
    console.log(c.dim('  Run `accio model add <id> [options]` to add one.\n'));
    return;
  }

  const rows = [];
  for (const m of models) {
    const dot = m.enabled ? symbols.activeDot : symbols.inactiveDot;
    const defTag = m.isDefault ? c.cyan('(default)') : '';
    const cleanUrl = (m.baseUrl || '').replace(/^https?:\/\//, '');

    rows.push([
      `  ${dot} ${c.bold(m.id)}`,
      defTag,
      m.provider,
      m.modelCode || m.id,
      cleanUrl,
      m.stream ? c.green('stream: yes') : c.gray('stream: no'),
      c.gray('locked: false · freeUse: true'),
    ]);
  }

  console.log(formatTable(rows, 2));
  console.log();
}

/**
 * accio model add <id> [--provider openai|ollama] [--baseUrl url] [--key apiKey] [--stream] [--default]
 */
async function cmdModelAdd(args) {
  const id = args[0];
  if (!id) {
    console.error(c.red('Error: model ID is required: `accio model add <id> [options]`'));
    process.exit(1);
  }

  const config = loadConfig();
  const existingIdx = config.models.findIndex((m) => m.id.toLowerCase() === id.toLowerCase());

  let provider = 'openai';
  let baseUrl = 'https://api.openai.com/v1';
  let apiKey = '';
  let stream = true;
  let isDefault = false;

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--provider' || a === '-p') provider = args[++i];
    else if (a === '--baseUrl' || a === '--url' || a === '-u') baseUrl = args[++i];
    else if (a === '--key' || a === '-k') apiKey = args[++i];
    else if (a === '--no-stream') stream = false;
    else if (a === '--default') isDefault = true;
  }

  if (provider === 'ollama' && (!args.includes('--baseUrl') && !args.includes('-u'))) {
    baseUrl = 'http://127.0.0.1:11434';
  }

  const entry = {
    id,
    modelCode: id,
    displayName: id,
    provider,
    baseUrl,
    upstreamModel: id,
    apiKey,
    stream,
    enabled: true,
    isDefault,
    freeUse: true,
    locked: false,
  };

  if (isDefault) {
    for (const m of config.models) m.isDefault = false;
  }

  if (existingIdx >= 0) {
    config.models[existingIdx] = { ...config.models[existingIdx], ...entry };
    console.log(`${symbols.check} Updated existing model ${c.bold(id)} in config.json`);
  } else {
    config.models.push(entry);
    console.log(`${symbols.check} Added model ${c.bold(id)} to config.json (locked: false, freeUse: true)`);
  }

  saveConfig(config);
}

/**
 * accio model rm <id>
 */
async function cmdModelRm(args) {
  const id = args[0];
  if (!id) {
    console.error(c.red('Error: model ID is required: `accio model rm <id>`'));
    process.exit(1);
  }

  const config = loadConfig();
  const initLen = config.models.length;
  config.models = config.models.filter((m) => m.id.toLowerCase() !== id.toLowerCase());

  if (config.models.length === initLen) {
    console.log(c.yellow(`Model "${id}" not found in config.json.`));
  } else {
    saveConfig(config);
    console.log(`${symbols.check} Removed model ${c.bold(id)} from config.json.`);
  }
}

/**
 * accio launch [--force]
 */
async function cmdLaunch(args) {
  const force = args.includes('--force') || args.includes('-f');
  const detection = detectAccioWorkCN();

  if (!detection.installed || !detection.path) {
    console.error(c.red('Error: Accio Work client is not installed in standard paths.'));
    console.error(c.dim('Download from: https://www.accio-ai.com/work'));
    process.exit(1);
  }

  if (detection.running && !force) {
    console.error(c.yellow(`Accio Work is already running (PID: ${detection.runningPids.join(', ')}).`));
    console.error(c.dim('Please close it first to allow GATEWAY_BASE_URL injection, or pass --force.'));
    process.exit(1);
  }

  const config = loadConfig();
  const bridgeUrl = `http://${config.server?.host || '127.0.0.1'}:${config.server?.port || 8080}`;

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

    console.log(`${symbols.check} Launched Accio Work (PID: ${c.bold(child.pid)})`);
    console.log(`  Target binary: ${detection.path}`);
    console.log(`  Injected env : GATEWAY_BASE_URL=${c.cyan(bridgeUrl)}`);
    console.log(`  Edition      : ${detection.edition === 'cn' ? c.green(detection.editionLabel) : c.blue(detection.editionLabel)}\n`);
  } catch (err) {
    console.error(c.red(`Failed to launch Accio: ${err.message}`));
    process.exit(1);
  }
}

/**
 * accio evidence — Show detailed China vs Global evidence
 */
async function cmdEvidence() {
  printHeader('accio', 'client edition detection evidence chain');

  const detection = detectAccioWorkCN();
  if (!detection.installed) {
    console.log(c.yellow('Accio Work client not installed.\n'));
    return;
  }

  console.log(`Classification : ${detection.edition === 'cn' ? c.green(`● ${detection.editionLabel}`) : c.blue(`● ${detection.editionLabel}`)}`);
  console.log(`Total Scores   : CN = ${c.bold(detection.scores?.cn || 0)}  |  Global = ${c.bold(detection.scores?.global || 0)}`);
  console.log(`Installation   : ${detection.path}\n`);

  console.log(c.bold('Evidence Records:'));
  for (const ev of detection.evidence || []) {
    const tag = ev.targetEdition === 'cn' ? c.green('[CN]') : ev.targetEdition === 'global' ? c.blue('[GLOBAL]') : c.gray('[INFO]');
    console.log(`  ${tag} ${c.bold(ev.source)} [${ev.field}] (+${ev.weight} pts)`);
    console.log(`     ${c.dim(ev.description)}`);
    console.log(`     Value: ${c.cyan(String(ev.value))}\n`);
  }
}

/**
 * accio daemon [start|stop|restart|status|log]
 */
async function cmdDaemon(args) {
  const sub = args[0] || 'status';
  const config = loadConfig();
  const host = config.server?.host || '127.0.0.1';
  const port = Number(config.server?.port) || 8080;

  if (sub === 'start') {
    const res = await startDaemon({ host, port });
    if (res.ok) {
      if (res.alreadyRunning) {
        console.log(`${symbols.warningDot} Bridge is already running on http://${host}:${port} (PID: ${res.pid})`);
      } else {
        console.log(`${symbols.check} Bridge daemon started on http://${host}:${port} (PID: ${res.pid})`);
      }
    } else {
      console.error(c.red(`Error: ${res.error}`));
      if (res.logTail) console.log(c.dim(res.logTail));
      process.exit(1);
    }
  } else if (sub === 'stop') {
    const res = await stopDaemon();
    if (res.ok) {
      if (res.notRunning) {
        console.log(`${symbols.inactiveDot} Bridge daemon was not running.`);
      } else {
        console.log(`${symbols.check} Stopped bridge daemon (PID: ${res.pid}).`);
      }
    } else {
      console.error(c.red(`Error stopping daemon: ${res.error}`));
      process.exit(1);
    }
  } else if (sub === 'restart') {
    await stopDaemon();
    await new Promise((r) => setTimeout(r, 600));
    const res = await startDaemon({ host, port });
    if (res.ok) {
      console.log(`${symbols.check} Bridge daemon restarted on http://${host}:${port} (PID: ${res.pid})`);
    } else {
      console.error(c.red(`Error restarting daemon: ${res.error}`));
      process.exit(1);
    }
  } else if (sub === 'log') {
    const n = Number(args[1]) || 30;
    console.log(tailLog(n));
  } else {
    // status
    const status = await getDaemonStatus(host, port);
    if (status.running) {
      console.log(`${symbols.activeDot} Bridge daemon is ${c.green('running')} on http://${host}:${port} (PID: ${status.pid})`);
      if (status.health) {
        console.log(`  Upstream: ${status.health.upstream}`);
        console.log(`  Models  : ${(status.health.models || []).join(', ') || '(none)'}`);
      }
    } else if (status.processAlive) {
      console.log(`${symbols.warningDot} Process is alive (PID: ${status.pid}) but gateway is unresponsive.`);
    } else {
      console.log(`${symbols.inactiveDot} Bridge daemon is ${c.gray('stopped')}.`);
    }
  }
}

/**
 * Print Help
 */
function printHelp() {
  printHeader('accio', 'one command to manage and hook Accio Work Desktop');

  console.log(`  ${c.bold('accio ls')}                       list detected Accio Work editions and active models`);
  console.log(`  ${c.bold('accio status')}                   show bridge gateway status and Accio Work client state`);
  console.log(`  ${c.bold('accio providers')}                list configured local & cloud providers`);
  console.log(`  ${c.bold('accio models')}                   list configured custom models`);
  console.log(`  ${c.bold('accio model add <id> [options]')} add or update a model in config.json`);
  console.log(`  ${c.bold('accio model rm <id>')}            remove a model from config.json`);
  console.log(`  ${c.bold('accio test [model] [prompt]')}    terminal streaming test with TTFT and tok/s metrics`);
  console.log(`  ${c.bold('accio launch [--force]')}         inject GATEWAY_BASE_URL and launch Accio Work client`);
  console.log(`  ${c.bold('accio evidence')}                 inspect China vs Global edition classification proof`);
  console.log(`  ${c.bold('accio serve')}                    run bridge gateway in foreground`);
  console.log(`  ${c.bold('accio daemon <start|stop|status|log>')} manage background bridge service`);
  console.log();
}

// ---------------------------------------------------------------------------
// Main CLI Router
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0]?.toLowerCase() || 'status';
  const rest = args.slice(1);

  switch (cmd) {
    case 'ls':
    case 'list':
      await cmdLs();
      break;

    case 'status':
      await cmdStatus();
      break;

    case 'providers':
    case 'provider':
      if (rest[0] === 'add') {
        // e.g. accio provider add ollama http://127.0.0.1:11434
        console.log(c.dim('Hint: run `accio model add <id> --provider <name> --url <url>` to register models.'));
      } else {
        await cmdProviders();
      }
      break;

    case 'models':
      await cmdModels();
      break;

    case 'model':
      if (rest[0] === 'add') {
        await cmdModelAdd(rest.slice(1));
      } else if (rest[0] === 'rm' || rest[0] === 'remove' || rest[0] === 'del') {
        await cmdModelRm(rest.slice(1));
      } else {
        await cmdModels();
      }
      break;

    case 'test': {
      const config = loadConfig();
      const modelId = rest[0] || config.models?.find((m) => m.enabled)?.id;
      if (!modelId) {
        console.error(c.red('No custom models found in config.json to test.'));
        process.exit(1);
      }
      const prompt = rest.slice(1).join(' ') || undefined;
      await runStreamingTest({
        modelId,
        prompt,
        host: config.server?.host,
        port: config.server?.port,
      });
      break;
    }

    case 'launch':
      await cmdLaunch(rest);
      break;

    case 'evidence':
    case 'detect':
      await cmdEvidence();
      break;

    case 'serve':
    case 'start': {
      // Foreground serve
      const { createServer, normalizeConfig } = require('../src/server');
      const cfg = normalizeConfig(loadConfig());
      const s = createServer(cfg);
      s.listen(cfg.server.port, cfg.server.host, () => {
        console.log(`${symbols.activeDot} ${c.bold('Accio Gateway Bridge')} listening on ${c.cyan(`http://${cfg.server.host}:${cfg.server.port}`)}`);
        console.log(`  Upstream: ${cfg.upstream.baseUrl}`);
        console.log(`  Models  : ${cfg.models.filter((m) => m.enabled).map((m) => m.id).join(', ') || '(none)'}`);
        console.log(`  Press ${c.bold('Ctrl+C')} to stop.\n`);
      });
      break;
    }

    case 'daemon':
      await cmdDaemon(rest);
      break;

    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;

    default:
      console.log(c.yellow(`Unknown command "${cmd}".`));
      printHelp();
      break;
  }
}

main().catch((err) => {
  console.error(c.red(`Fatal error: ${err.message}`));
  process.exit(1);
});
