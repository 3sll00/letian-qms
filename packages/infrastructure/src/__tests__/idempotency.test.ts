import assert from 'node:assert';
import { IdempotencyManager } from '../idempotency/idempotency-manager.js';

console.log('Testing IdempotencyManager SHA-256 hash & TTL...');

const payload1 = { a: 1, b: 'test', nested: { c: true } };
const payload2 = { nested: { c: true }, b: 'test', a: 1 };
const payload3 = { a: 1, b: 'test', nested: { c: false } };

const hash1 = IdempotencyManager.hashPayload(payload1);
const hash2 = IdempotencyManager.hashPayload(payload2);
const hash3 = IdempotencyManager.hashPayload(payload3);

assert.strictEqual(hash1, hash2, 'JSON key order differences should produce identical SHA-256 hashes');
assert.notStrictEqual(hash1, hash3, 'Different payload content must produce different hashes');

console.log('IdempotencyManager tests passed successfully!');
