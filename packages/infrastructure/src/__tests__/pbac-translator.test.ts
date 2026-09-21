import assert from 'node:assert';
import type { MaterialPermission } from '@letian/contracts';
import {
  buildMaterialPermissionWhere,
  hasFullWildcard,
  isFullWildcardRule,
} from '../repositories/pbac-sql-translator.js';
import { DummyDriver, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, Kysely } from 'kysely';

console.log('Testing PBAC SQL translator...');

// Setup a dummy db to compile queries
const db = new Kysely<any>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

const rule = (overrides: Partial<MaterialPermission>): MaterialPermission => ({
  id: '70000000-0000-4000-8000-000000000001',
  userId: '11000000-0000-4000-8000-000000000001',
  userName: '张强',
  roleCode: 'QA_MANAGER',
  materialCategories: [],
  materialCodes: [],
  supplierCodes: [],
  isActive: true,
  ...overrides,
});

// 1. 无生效规则 => fail-closed (1 = 0)
const noRules = buildMaterialPermissionWhere([]);
const compiledNoRules = db.selectFrom('inspectionOrders').selectAll().where(noRules).compile();
console.log('Compiled no-rules SQL:', compiledNoRules.sql);
assert(compiledNoRules.sql.includes('1 = 0'), 'no rules should compile to 1 = 0');

// 2. 全通配规则 => 全量放行 (1 = 1)
assert(isFullWildcardRule(rule({ materialCategories: ['*'] })), 'star category should be wildcard');
assert(isFullWildcardRule(rule({})), 'empty all dimensions should be wildcard');
assert(!isFullWildcardRule(rule({ materialCodes: ['MAT-1'] })), 'specific code should not be wildcard');
assert(hasFullWildcard([rule({})]), 'should detect full wildcard in list');

const wildcardWhere = buildMaterialPermissionWhere([rule({})]);
const compiledWildcard = db.selectFrom('inspectionOrders').selectAll().where(wildcardWhere).compile();
console.log('Compiled wildcard SQL:', compiledWildcard.sql);
assert(compiledWildcard.sql.includes('1 = 1'), 'full wildcard should compile to 1 = 1');

// 3. 具体规则 => 分类 EXISTS 子查询 + 编码 IN + 供应商 IN，多条件 AND
const specific = buildMaterialPermissionWhere([
  rule({
    materialCategories: ['CAT-RAW-WIRE'],
    materialCodes: ['MAT-304SS-05'],
    supplierCodes: ['SUP-001', 'SUP-002'],
  }),
]);
const compiledSpecific = db
  .selectFrom('inspectionOrders')
  .selectAll()
  .where(specific)
  .compile();
console.log('Compiled specific SQL:', compiledSpecific.sql);
console.log('Parameters:', compiledSpecific.parameters);
assert(
  compiledSpecific.sql.includes('EXISTS') && compiledSpecific.sql.includes('category_code'),
  'category dimension should use EXISTS against materials'
);
assert(
  compiledSpecific.sql.includes('"inspection_orders"."material_code" IN'),
  'code dimension should constrain material_code'
);
assert(
  compiledSpecific.sql.includes('"inspection_orders"."supplier_code"') &&
    compiledSpecific.sql.includes('IN'),
  'supplier dimension should constrain supplier_code'
);
assert.deepStrictEqual(compiledSpecific.parameters, [
  'CAT-RAW-WIRE',
  'MAT-304SS-05',
  'SUP-001',
  'SUP-002',
]);

// 4. 无供应商列的表 + 限定供应商的规则 => 该规则被跳过 => 1 = 0
const noSupplierTable = buildMaterialPermissionWhere(
  [rule({ supplierCodes: ['SUP-001'] })],
  { targetRef: 'mrb_reviews', hasSupplierColumn: false }
);
const compiledNoSupplier = db.selectFrom('mrbReviews').selectAll().where(noSupplierTable).compile();
console.log('Compiled no-supplier SQL:', compiledNoSupplier.sql);
assert(compiledNoSupplier.sql.includes('1 = 0'), 'supplier-only rule on supplierless table should deny all');

// 5. 停用规则被忽略：停用 + 全通配停用 => 仍拒绝
const inactiveOnly = buildMaterialPermissionWhere([rule({ isActive: false })]);
const compiledInactive = db
  .selectFrom('inspectionOrders')
  .selectAll()
  .where(inactiveOnly)
  .compile();
assert(compiledInactive.sql.includes('1 = 0'), 'inactive rules must not grant access');

// 6. 多规则 OR：分类维度限定 CAT-A 与编码维度限定 MAT-B 两条规则应产生 OR 连接
const multi = buildMaterialPermissionWhere([
  rule({ materialCategories: ['CAT-RAW-WIRE'] }),
  rule({ id: '70000000-0000-4000-8000-000000000002', materialCodes: ['MAT-35CRMO-08'] }),
]);
const compiledMulti = db.selectFrom('inspectionOrders').selectAll().where(multi).compile();
console.log('Compiled multi-rule SQL:', compiledMulti.sql);
assert(compiledMulti.sql.includes(' OR '), 'multiple rules should be OR-combined');

console.log('PBAC SQL translator tests passed successfully!');
