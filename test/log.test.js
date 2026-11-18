import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logError } from '../src/lib/log.js';

test('logError masks amounts and keeps the message shape', () => {
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(line);
  try {
    logError('resolver', new Error('C1: Unexplained difference of 1,234.56 USD on 1010'));
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 1);
  assert.equal(lines[0], '[CloseProof] resolver: Error: C#: Unexplained difference of # USD on #');
  assert.doesNotMatch(lines[0], /1,234\.56/);
});
