import { test } from 'node:test';
import assert from 'node:assert';
import { sum } from './sum.js';
test('sum adds', () => assert.strictEqual(sum(2, 3), 5));
