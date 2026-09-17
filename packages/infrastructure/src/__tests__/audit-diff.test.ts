import assert from 'node:assert';
import { calculateJsonDiff, isSensitiveField, maskValue } from '../audit/audit-diff.js';

console.log('Testing calculateJsonDiff & masking...');

// Test 1: Simple diff
const before = {
  id: '1',
  name: 'Material A',
  status: 'PENDING',
  secretKey: 'my-secret-key-1234',
  tags: ['t1'],
};

const after = {
  id: '1',
  name: 'Material B',
  status: 'COMPLETED',
  secretKey: 'new-secret-key-5678',
  tags: ['t1', 't2'],
};

const patches = calculateJsonDiff(before, after);
console.log('Patches generated:', patches);

assert.strictEqual(patches.length, 4, 'Should produce 4 patch operations (name, status, secretKey, tags)');

// Check secretKey masking
const secretPatch = patches.find((p) => p.field === 'secretKey');
assert(secretPatch, 'secretKey patch must exist');
assert.strictEqual(typeof secretPatch.oldValue, 'string');
assert(String(secretPatch.oldValue).includes('****'), 'Old secret must be masked');
assert(String(secretPatch.newValue).includes('****'), 'New secret must be masked');

// Test 2: Field sensitivity
assert.strictEqual(isSensitiveField('userPassword'), true);
assert.strictEqual(isSensitiveField('materialName'), false);

console.log('AuditDiff tests passed successfully!');
