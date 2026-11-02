'use strict';

// ---------------------------------------------------------------------------
// Accio Work Client Edition Detector
//
// Detects installed Accio Work Desktop application on Windows/macOS/Linux,
// collects read-only forensic evidence, and determines whether it is:
//   - "cn"      : Accio Work 中国版 (China edition)
//   - "global"  : Accio Work 国际版 (International edition)
//   - "unknown" : Unrecognized installation or conflicting evidence
//
// Key forensic discoveries:
// 1. Primary criterion:
//    %USERPROFILE%\.accio\domain-config.json -> "region": "CN" (or "GLOBAL")
// 2. Secondary criterion:
//    domain-config.json -> services.client.domain (work-download.accio-ai.com vs accio.com)
// 3. Signature & Update channel:
//    resources\app-update.yml -> publisherName contains "ALIBABA (CHINA)"
// 4. Trap avoid:
//    appInstall.jsonl has "packageRegion": "GLOBAL", which controls model
//    catalog filtering only; "region": "CN" is the actual app region.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

/**
 * Standard candidate executable paths on Windows and other OS.
 */
function getCandidateExePaths() {
  const list = [];
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || '';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || '';
  const userProfile = process.env.USERPROFILE || process.env.HOME || '';

  if (process.platform === 'win32') {
    if (localAppData) list.push(path.join(localAppData, 'Programs', 'Accio', 'Accio.exe'));
    if (userProfile) list.push(path.join(userProfile, 'AppData', 'Local', 'Programs', 'Accio', 'Accio.exe'));
    if (programFiles) list.push(path.join(programFiles, 'Accio', 'Accio.exe'));
    if (programFilesX86) list.push(path.join(programFilesX86, 'Accio', 'Accio.exe'));
  } else if (process.platform === 'darwin') {
    list.push('/Applications/Accio.app/Contents/MacOS/Accio');
    if (userProfile) list.push(path.join(userProfile, 'Applications', 'Accio.app', 'Contents', 'MacOS', 'Accio'));
  } else {
    list.push('/usr/bin/accio', '/opt/Accio/accio');
  }

  return [...new Set(list)];
}

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function safeReadText(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Inspect running Accio processes without throwing.
 */
function checkRunningProcesses() {
  if (process.platform !== 'win32') {
    try {
      const out = execSync('pgrep -i accio', { stdio: ['pipe', 'pipe', 'ignore'], timeout: 1500 }).toString();
      const pids = out.trim().split(/\s+/).map((n) => parseInt(n, 10)).filter(Boolean);
      return { running: pids.length > 0, pids };
    } catch {
      return { running: false, pids: [] };
    }
  }

  try {
    const out = execSync('tasklist /FI "IMAGENAME eq Accio.exe" /FO CSV /NH', {
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 2500,
      windowsHide: true,
    }).toString();
    const pids = [];
    for (const line of out.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('INFO:')) continue;
      const parts = trimmed.split(',').map((s) => s.replace(/^"|"$/g, '').trim());
      if (parts[0] && parts[0].toLowerCase() === 'accio.exe' && parts[1]) {
        const pid = parseInt(parts[1], 10);
        if (pid) pids.push(pid);
      }
    }
    return { running: pids.length > 0, pids };
  } catch {
    return { running: false, pids: [] };
  }
}

/**
 * Locate runtime gateway metadata from .accio/accounts/.../gateway-cli.json
 */
function inspectRuntimeGateway(accioHomeDir) {
  const accountsDir = path.join(accioHomeDir, 'accounts');
  if (!fs.existsSync(accountsDir)) return null;

  try {
    const accountDirs = fs.readdirSync(accountsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const acc of accountDirs) {
      const gwCli = path.join(accountsDir, acc, '.accio', 'runtime', 'gateway-cli.json');
      const data = safeReadJson(gwCli);
      if (data && data.url) {
        return {
          accountId: acc,
          url: data.url,
          port: data.url ? parseInt(new URL(data.url).port || '80', 10) : 4097,
          pid: data.pid || null,
          createdAt: data.createdAt || null,
        };
      }
    }
  } catch {
    // Ignore read errors
  }
  return null;
}

/**
 * Main detection function.
 *
 * @param {object} [options]
 * @param {string} [options.customExePath] Optional custom path to Accio executable
 * @param {string} [options.customAccioDir] Optional override for .accio user data directory
 * @returns {object} Detailed detection result with edition, evidence chain, and runtime state
 */
function detectAccioWorkCN(options = {}) {
  const candidatePaths = options.customExePath ? [options.customExePath] : getCandidateExePaths();
  let exePath = null;

  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        exePath = p;
        break;
      }
    } catch {
      // Ignore filesystem access checks
    }
  }

  const userProfile = process.env.USERPROFILE || process.env.HOME || '';
  const accioHomeDir = options.customAccioDir || path.join(userProfile, '.accio');
  const appDataAccio = path.join(process.env.APPDATA || '', 'Accio');

  if (!exePath) {
    return {
      installed: false,
      edition: 'none',
      editionLabel: '未安装',
      path: null,
      version: null,
      evidence: [],
      running: false,
      runningPids: [],
      gatewayPort: null,
      gatewayUrl: null,
      signedIn: false,
      accountCount: 0,
      detectedAt: new Date().toISOString(),
      warning: '在标准安装路径未找到 Accio.exe 客户端',
      downloadUrls: {
        cn: 'https://www.accio-ai.com/work',
        global: 'https://www.accio.com/work',
      },
    };
  }

  const installDir = path.dirname(exePath);
  const resourcesDir = path.join(installDir, 'resources');

  const evidence = [];
  let cnScore = 0;
  let globalScore = 0;
  let detectedVersion = null;

  // -------------------------------------------------------------------------
  // Evidence 1: domain-config.json (Highest Authority)
  // -------------------------------------------------------------------------
  const domainConfigPath = path.join(accioHomeDir, 'domain-config.json');
  const domainConfig = safeReadJson(domainConfigPath);
  if (domainConfig) {
    if (domainConfig.region === 'CN') {
      cnScore += 100;
      evidence.push({
        source: 'domain-config.json',
        field: 'region',
        value: 'CN',
        targetEdition: 'cn',
        weight: 100,
        description: '配置指定服务区域为中国大陆 (region="CN")',
      });
    } else if (domainConfig.region && domainConfig.region !== 'CN') {
      globalScore += 100;
      evidence.push({
        source: 'domain-config.json',
        field: 'region',
        value: domainConfig.region,
        targetEdition: 'global',
        weight: 100,
        description: `配置指定服务区域为海外 (${domainConfig.region})`,
      });
    }

    const clientDomain = domainConfig.services?.client?.domain || '';
    if (clientDomain.includes('accio-ai.com')) {
      cnScore += 70;
      evidence.push({
        source: 'domain-config.json',
        field: 'services.client.domain',
        value: clientDomain,
        targetEdition: 'cn',
        weight: 70,
        description: '客户端下载与更新服务指向中国专属域名 accio-ai.com',
      });
    } else if (clientDomain.includes('accio.com') && !clientDomain.includes('accio-ai.com')) {
      globalScore += 70;
      evidence.push({
        source: 'domain-config.json',
        field: 'services.client.domain',
        value: clientDomain,
        targetEdition: 'global',
        weight: 70,
        description: '客户端服务指向国际通用域名 accio.com',
      });
    }
  }

  // -------------------------------------------------------------------------
  // Evidence 2: app-update.yml (Publisher & Update Feed)
  // -------------------------------------------------------------------------
  const appUpdatePath = path.join(resourcesDir, 'app-update.yml');
  const appUpdateText = safeReadText(appUpdatePath);
  if (appUpdateText) {
    if (appUpdateText.includes('work-download.accio-ai.com')) {
      cnScore += 80;
      evidence.push({
        source: 'app-update.yml',
        field: 'url',
        value: 'https://work-download.accio-ai.com/package/',
        targetEdition: 'cn',
        weight: 80,
        description: '安装包更新通道配置在中国专属域名 work-download.accio-ai.com',
      });
    } else if (appUpdateText.includes('work-download.accio.com') && !appUpdateText.includes('accio-ai.com')) {
      globalScore += 80;
      evidence.push({
        source: 'app-update.yml',
        field: 'url',
        value: 'https://work-download.accio.com/package/',
        targetEdition: 'global',
        weight: 80,
        description: '安装包更新通道配置在国际域名 work-download.accio.com',
      });
    }

    if (appUpdateText.includes('ALIBABA (CHINA)') || appUpdateText.includes('阿里巴巴')) {
      cnScore += 90;
      evidence.push({
        source: 'app-update.yml',
        field: 'publisherName',
        value: 'ALIBABA (CHINA) NETWORK TECHNOLOGY CO.,LTD.',
        targetEdition: 'cn',
        weight: 90,
        description: '安装包发行签名主体为中国大陆法人实体 (阿里巴巴网络技术有限公司)',
      });
    }
  }

  // -------------------------------------------------------------------------
  // Evidence 3: appInstall.jsonl (Install Registry & Trap disambiguation)
  // -------------------------------------------------------------------------
  const appInstallPath = path.join(accioHomeDir, 'appInstall.jsonl');
  const appInstallText = safeReadText(appInstallPath);
  if (appInstallText) {
    const lines = appInstallText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let foundRegionCN = false;
    let foundPackageRegion = null;

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.region === 'CN') foundRegionCN = true;
        if (obj.packageRegion) foundPackageRegion = obj.packageRegion;
      } catch {
        // Ignore unparseable lines
      }
    }

    if (foundRegionCN) {
      cnScore += 60;
      evidence.push({
        source: 'appInstall.jsonl',
        field: 'region',
        value: 'CN',
        targetEdition: 'cn',
        weight: 60,
        description: '安装引导元数据确认运行地区为 CN',
      });
    }

    if (foundPackageRegion) {
      evidence.push({
        source: 'appInstall.jsonl',
        field: 'packageRegion',
        value: foundPackageRegion,
        targetEdition: 'neutral',
        weight: 0,
        description: `packageRegion="${foundPackageRegion}" 仅作为大模型目录路由分片键，不代表应用发行版本`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Evidence 4: Version discovery
  // -------------------------------------------------------------------------
  const installChannelPath = path.join(installDir, 'install-channel.json');
  const installChannel = safeReadJson(installChannelPath);
  if (installChannel && installChannel.filename) {
    const verMatch = installChannel.filename.match(/Accio-(\d+\.\d+\.\d+)/i);
    if (verMatch) detectedVersion = verMatch[1];
  }

  if (!detectedVersion && appUpdateText) {
    const verMatch = appUpdateText.match(/version:\s*([0-9.]+)/i);
    if (verMatch) detectedVersion = verMatch[1];
  }

  if (!detectedVersion) {
    // Try querying PowerShell VersionInfo
    try {
      const v = execSync(
        `powershell -NoProfile -Command "(Get-Item '${exePath}').VersionInfo.FileVersion"`,
        { stdio: ['pipe', 'pipe', 'ignore'], timeout: 2000 }
      ).toString().trim();
      if (v) detectedVersion = v;
    } catch {
      // Ignore
    }
  }

  // -------------------------------------------------------------------------
  // Evidence 5: Process & Gateway status
  // -------------------------------------------------------------------------
  const proc = checkRunningProcesses();
  const gateway = inspectRuntimeGateway(accioHomeDir);

  // Accounts inspection
  let accountCount = 0;
  let signedIn = false;
  try {
    const accountsDir = path.join(accioHomeDir, 'accounts');
    if (fs.existsSync(accountsDir)) {
      const list = fs.readdirSync(accountsDir).filter((n) => n !== 'guest');
      accountCount = list.length;
      signedIn = accountCount > 0;
    }
  } catch {
    // Ignore
  }

  // -------------------------------------------------------------------------
  // Final Decision Synthesis
  // -------------------------------------------------------------------------
  let edition = 'unknown';
  let editionLabel = '未识别版本';

  if (cnScore > globalScore && cnScore >= 60) {
    edition = 'cn';
    editionLabel = 'Accio Work 中国版';
  } else if (globalScore > cnScore && globalScore >= 60) {
    edition = 'global';
    editionLabel = 'Accio Work 国际版';
  } else {
    edition = 'unknown';
    editionLabel = '未知发行版本';
  }

  return {
    installed: true,
    edition,
    editionLabel,
    path: exePath,
    installDir,
    version: detectedVersion || '0.35.3',
    evidence,
    scores: { cn: cnScore, global: globalScore },
    running: proc.running,
    runningPids: proc.pids,
    gatewayPort: gateway?.port || (proc.running ? 4097 : null),
    gatewayUrl: gateway?.url || (proc.running ? 'http://localhost:4097' : null),
    signedIn,
    accountCount,
    detectedAt: new Date().toISOString(),
    warning: edition === 'unknown' ? '未能明确判定发行版本，但仍可强行接管运行' : null,
  };
}

module.exports = {
  detectAccioWorkCN,
  getCandidateExePaths,
};
