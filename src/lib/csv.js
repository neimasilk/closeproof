/**
 * Balance import: parse a trial-balance style table that a finance user pastes
 * from a spreadsheet or exports as CSV.
 *
 * Expected columns (header row required, names are case-insensitive):
 *   account          general ledger account code, for example 1010
 *   name             account name (optional)
 *   gl_balance       closing balance in the general ledger
 *   source_balance   independent balance: bank statement or sub-ledger (optional)
 *   opening_balance  opening balance, used by the roll-forward control (optional)
 *
 * The delimiter is detected from the header: tab (pasted from Excel or Google
 * Sheets), then semicolon, then comma. Fields may be quoted with double quotes,
 * which is how CSV files carry amounts such as "1,234.56".
 *
 * This module is pure (no Forge calls) so it can be unit tested. Amounts are
 * returned as BigInt minor units; nothing is stored here.
 */
import { parseAmount } from './money.js';

// Each new account creates a Jira issue; 50 keeps one import well inside the
// Forge function time limit.
export const MAX_IMPORT_ROWS = 50;
const ACCOUNT_RE = /^[A-Za-z0-9._-]{1,40}$/;

/** Header aliases accepted for each column. */
const COLUMNS = {
  account: ['account', 'account code', 'account_code', 'acct', 'gl account', 'gl_account'],
  name: ['name', 'account name', 'account_name', 'description'],
  gl: ['gl_balance', 'gl balance', 'gl', 'ledger', 'ledger balance', 'closing balance', 'balance'],
  source: ['source_balance', 'source balance', 'source', 'bank', 'bank balance', 'subledger', 'sub-ledger', 'statement'],
  opening: ['opening_balance', 'opening balance', 'opening'],
};

function detectDelimiter(headerLine) {
  if (headerLine.includes('\t')) return '\t';
  if (headerLine.includes(';')) return ';';
  return ',';
}

/** Split one line into fields, honouring double quotes ("" inside quotes is a literal quote). */
export function splitLine(line, delimiter) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"' && field.trim() === '') {
      quoted = true;
      field = '';
    } else if (ch === delimiter) {
      out.push(field.trim());
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field.trim());
  return out;
}

/** Map header cells to column keys; unknown headers are ignored. */
function mapHeader(cells) {
  const index = {};
  cells.forEach((cell, i) => {
    const h = cell.toLowerCase().replace(/\s+/g, ' ').trim();
    for (const [key, aliases] of Object.entries(COLUMNS)) {
      if (index[key] === undefined && aliases.includes(h)) index[key] = i;
    }
  });
  return index;
}

/**
 * Parse pasted or uploaded balances.
 *
 * @param {string} text the table, header row first
 * @param {number} decimals minor-unit digits of the project currency
 * @returns {{rows: Array<{line:number, account:string, name:string, glBalance:bigint,
 *   sourceBalance:(bigint|null), openingBalance:(bigint|null)}>, errors: Array<{line:number, message:string}>}}
 */
export function parseBalances(text, decimals = 2) {
  const lines = String(text ?? '')
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l, i) => ({ text: l, line: i + 1 }))
    .filter((l) => l.text.trim() !== '');
  const errors = [];
  if (!lines.length) return { rows: [], errors: [{ line: 0, message: 'Nothing to import' }] };

  const delimiter = detectDelimiter(lines[0].text);
  const col = mapHeader(splitLine(lines[0].text, delimiter));
  if (col.account === undefined || col.gl === undefined) {
    return {
      rows: [],
      errors: [{ line: lines[0].line, message: 'The first row must be a header with at least "account" and "gl_balance" columns' }],
    };
  }

  const rows = [];
  const seen = new Set();
  for (const { text: raw, line } of lines.slice(1)) {
    if (rows.length >= MAX_IMPORT_ROWS) {
      errors.push({ line, message: `Only the first ${MAX_IMPORT_ROWS} accounts are imported at once` });
      break;
    }
    const cells = splitLine(raw, delimiter);
    const get = (key) => (col[key] === undefined ? '' : cells[col[key]] ?? '');
    const account = get('account');
    if (!ACCOUNT_RE.test(account)) {
      errors.push({ line, message: `"${account}" is not a valid account code (letters, digits, . _ - only)` });
      continue;
    }
    if (seen.has(account)) {
      errors.push({ line, message: `Account ${account} appears more than once` });
      continue;
    }
    const amount = (key, required) => {
      const v = get(key);
      if (v === '') {
        if (required) throw new Error(`${key === 'gl' ? 'GL balance' : key} is empty`);
        return null;
      }
      return parseAmount(v, decimals);
    };
    try {
      rows.push({
        line,
        account,
        name: get('name').slice(0, 120),
        glBalance: amount('gl', true),
        sourceBalance: amount('source', false),
        openingBalance: amount('opening', false),
      });
      seen.add(account);
    } catch (e) {
      errors.push({ line, message: `Account ${account}: ${e.message}` });
    }
  }
  return { rows, errors };
}
