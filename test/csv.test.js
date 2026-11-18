import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBalances, splitLine, MAX_IMPORT_ROWS } from '../src/lib/csv.js';

test('splitLine handles quotes, escaped quotes and delimiters inside quotes', () => {
  assert.deepEqual(splitLine('1010,"Bank, main","1,234.56"', ','), ['1010', 'Bank, main', '1,234.56']);
  assert.deepEqual(splitLine('a;"say ""hi""";c', ';'), ['a', 'say "hi"', 'c']);
  assert.deepEqual(splitLine('x\t\ty', '\t'), ['x', '', 'y']);
});

test('parses a comma CSV with quoted amounts into minor units', () => {
  const { rows, errors } = parseBalances(
    'account,name,gl_balance,source_balance,opening_balance\n1010,Operating bank,"18,810,000.00","18,450,000.00",(1.50)\n',
  );
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].account, '1010');
  assert.equal(rows[0].name, 'Operating bank');
  assert.equal(rows[0].glBalance, 1881000000n);
  assert.equal(rows[0].sourceBalance, 1845000000n);
  assert.equal(rows[0].openingBalance, -150n);
});

test('detects tab-separated paste from a spreadsheet and header aliases', () => {
  const text = 'Account Code\tAccount Name\tGL Balance\tBank Balance\n1200\tReceivables\t312750.00\t308250.00\n2000\tPayables\t-198700\t';
  const { rows, errors } = parseBalances(text);
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].sourceBalance, 30825000n);
  assert.equal(rows[1].glBalance, -19870000n);
  assert.equal(rows[1].sourceBalance, null);
  assert.equal(rows[1].openingBalance, null);
});

test('semicolon CSV, BOM, blank lines and zero-decimal currencies', () => {
  const { rows, errors } = parseBalances('﻿account;gl_balance\n\n1010;1.500.000\n1020;2500000\n', 0);
  // "1.500.000" is not a valid amount for a 0-decimal currency (dots are not thousands separators here)
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 3);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].glBalance, 2500000n);
});

test('reports bad rows with line numbers and keeps the good ones', () => {
  const { rows, errors } = parseBalances(
    'account,gl_balance,source_balance\n1010,100.00,100.00\nbad code!,1,1\n1010,5,5\n1030,,1\n1040,1.234,1\n1050,abc,1\n1060,7,7',
  );
  assert.deepEqual(
    rows.map((r) => r.account),
    ['1010', '1060'],
  );
  assert.deepEqual(
    errors.map((e) => e.line),
    [3, 4, 5, 6, 7],
  );
  assert.match(errors[1].message, /more than once/);
  assert.match(errors[2].message, /GL balance is empty/);
  assert.match(errors[3].message, /more than 2 decimal places/);
});

test('requires a header with account and gl_balance', () => {
  assert.match(parseBalances('1010,100').errors[0].message, /header/);
  assert.match(parseBalances('   \n').errors[0].message, /Nothing to import/);
});

test('caps the number of imported accounts', () => {
  const lines = ['account,gl_balance'];
  for (let i = 0; i < MAX_IMPORT_ROWS + 5; i += 1) lines.push(`A${i},1`);
  const { rows, errors } = parseBalances(lines.join('\n'));
  assert.equal(rows.length, MAX_IMPORT_ROWS);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Only the first/);
});
