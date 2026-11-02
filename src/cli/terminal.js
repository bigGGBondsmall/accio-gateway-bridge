'use strict';

/**
 * terminal.js — ANSI colors, table alignment, and Magpie-style status indicators.
 * Respects NO_COLOR / FORCE_COLOR and process.stdout.isTTY.
 */

const isColorSupported = (() => {
  if (process.env.NO_COLOR != null && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR === '1' || process.env.FORCE_COLOR === 'true') return true;
  return Boolean(process.stdout.isTTY);
})();

function color(open, close) {
  return (text) => (isColorSupported ? `\x1b[${open}m${text}\x1b[${close}m` : String(text));
}

const c = {
  reset: color(0, 0),
  bold: color(1, 22),
  dim: color(2, 22),
  italic: color(3, 23),
  underline: color(4, 24),
  red: color(31, 39),
  green: color(32, 39),
  yellow: color(33, 39),
  blue: color(34, 39),
  magenta: color(35, 39),
  cyan: color(36, 39),
  gray: color(90, 39),
  white: color(37, 39),
  bgGreen: color(42, 49),
  bgRed: color(41, 49),
};

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

function stripAnsi(str) {
  return String(str || '').replace(ANSI_REGEX, '');
}

// Compute display width considering East Asian characters (fullwidth = 2)
function stringWidth(str) {
  const stripped = stripAnsi(str);
  let len = 0;
  for (let i = 0; i < stripped.length; i++) {
    const code = stripped.charCodeAt(i);
    // Rough heuristic for East Asian Fullwidth / CJK
    if (code >= 0x1100 && (
      code <= 0x115f ||
      code === 0x2329 || code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    )) {
      len += 2;
    } else {
      len += 1;
    }
  }
  return len;
}

function padRight(str, targetWidth) {
  const current = stringWidth(str);
  if (current >= targetWidth) return str;
  return str + ' '.repeat(targetWidth - current);
}

function padLeft(str, targetWidth) {
  const current = stringWidth(str);
  if (current >= targetWidth) return str;
  return ' '.repeat(targetWidth - current) + str;
}

// Magpie-style status indicators
const symbols = {
  activeDot: c.green('●'),
  inactiveDot: c.gray('○'),
  warningDot: c.yellow('●'),
  dangerDot: c.red('●'),
  blueDot: c.blue('●'),
  check: c.green('✓'),
  cross: c.red('✗'),
  arrow: c.gray('→'),
  bullet: c.gray('·'),
  pipe: c.gray('│'),
};

/**
 * Format rows into a clean aligned table like Magpie CLI.
 * @param {Array<Array<string>>} rows 
 * @param {Array<number>} [minGaps]
 */
function formatTable(rows, minGap = 2) {
  if (!rows || rows.length === 0) return '';
  const colCount = Math.max(...rows.map((r) => r.length));
  const colWidths = new Array(colCount).fill(0);

  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      const w = stringWidth(row[c]);
      if (w > colWidths[c]) colWidths[c] = w;
    }
  }

  const lines = [];
  for (const row of rows) {
    const cells = [];
    for (let c = 0; c < row.length; c++) {
      const cell = row[c] ?? '';
      // Don't pad the last column
      if (c === row.length - 1) {
        cells.push(cell);
      } else {
        cells.push(padRight(cell, colWidths[c]));
      }
    }
    lines.push('  ' + cells.join(' '.repeat(minGap)));
  }

  return lines.join('\n');
}

function printHeader(title = 'accio', tag = 'gateway bridge for Accio Work Desktop') {
  console.log(`${c.bold(title)} ${c.gray('—')} ${c.dim(tag)}\n`);
}

module.exports = {
  c,
  symbols,
  stripAnsi,
  stringWidth,
  padRight,
  padLeft,
  formatTable,
  printHeader,
};
