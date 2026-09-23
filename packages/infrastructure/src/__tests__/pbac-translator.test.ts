import assert from 'node:assert';
import type { MaterialPermission } from '@letian/contracts';
import {
  buildMaterialPermissionWhere,
  hasFullWildcard,
  isFullWildcardRule,
} from '../repositories/pbac-sql-translator.js';
import {
  DummyDriver,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  Kysely,
  sql,
} from 'kysely';

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

// 4b. 无供应商列的表 + 传入 supplierCodeExpr（经源检验单换算）=> 供应商规则照常生效（docs/39 §2 D2）
const supplierViaExpr = buildMaterialPermissionWhere(
  [rule({ supplierCodes: ['SUP-001'] })],
  {
    targetRef: 'pending_mrb_items',
    hasSupplierColumn: true,
    supplierCodeExpr: sql`(SELECT src.supplier_code FROM inspection_orders AS src WHERE src.id = pending_mrb_items.source_order_id)`,
  }
);
const compiledSupplierViaExpr = db
  .selectFrom('pendingMrbItems')
  .selectAll()
  .where(supplierViaExpr)
  .compile();
console.log('Compiled supplier-via-subquery SQL:', compiledSupplierViaExpr.sql);
assert(
  !compiledSupplierViaExpr.sql.includes('1 = 0') &&
    compiledSupplierViaExpr.sql.includes('src.supplier_code') &&
    compiledSupplierViaExpr.sql.includes('IS NOT NULL'),
  'supplier dimension should be resolved through the given expression'
);
assert.deepStrictEqual(compiledSupplierViaExpr.parameters, ['SUP-001']);

// 4c. 方案域（对象无供应商属性）=> supplierDimension='NOT_APPLICABLE' 时供应商维度不参与判定
//     规则取陈静的真实形态：分类 + 编码 + 供应商 三维同时限定
//     （docs/42-质检方案域PBAC供应商维度错配修复设计.md §2.1：修复前该规则被整条跳过 => 1 = 0 => 录入页指标清单恒空）
const planDomainRule = rule({
  materialCategories: ['CAT-RAW-WIRE'],
  materialCodes: ['MAT-304SS-05'],
  supplierCodes: ['SUP-001', 'SUP-002'],
});
const planDomainWhere = buildMaterialPermissionWhere([planDomainRule], {
  targetRef: 'inspection_plans',
  hasSupplierColumn: false,
  supplierDimension: 'NOT_APPLICABLE',
});
const compiledPlanDomain = db
  .selectFrom('inspectionPlans')
  .selectAll()
  .where(planDomainWhere)
  .compile();
console.log('Compiled plan-domain SQL:', compiledPlanDomain.sql);
assert(!compiledPlanDomain.sql.includes('1 = 0'), '方案域不得因规则限定供应商而整条作废');
assert(
  compiledPlanDomain.sql.includes('EXISTS') && compiledPlanDomain.sql.includes('category_code'),
  '方案域仍应核对物料分类维度'
);
assert(
  compiledPlanDomain.sql.includes('"inspection_plans"."material_code" IN'),
  '方案域仍应核对物料编码维度'
);
assert(
  !compiledPlanDomain.sql.includes('supplier_code'),
  '方案域不得生成任何供应商条件'
);
assert.deepStrictEqual(compiledPlanDomain.parameters, ['CAT-RAW-WIRE', 'MAT-304SS-05']);

// 4d. 方案域 + 仅限定供应商的规则 => 物料维度全通配 => 全量放行（与领域层评估器同口径）
const planSupplierOnlyWhere = buildMaterialPermissionWhere([rule({ supplierCodes: ['SUP-001'] })], {
  targetRef: 'inspection_plans',
  hasSupplierColumn: false,
  supplierDimension: 'NOT_APPLICABLE',
});
const compiledPlanSupplierOnly = db
  .selectFrom('inspectionPlans')
  .selectAll()
  .where(planSupplierOnlyWhere)
  .compile();
console.log('Compiled plan-domain supplier-only SQL:', compiledPlanSupplierOnly.sql);
assert(
  compiledPlanSupplierOnly.sql.includes('1 = 1'),
  '仅供应商限定的规则在方案域等价于全量放行'
);

// 4e. 方案域 + 无生效规则 => 仍 fail-closed（不得因"去掉一个维度"而把无规则变成放行）
const planNoRulesWhere = buildMaterialPermissionWhere([], {
  targetRef: 'inspection_plans',
  hasSupplierColumn: false,
  supplierDimension: 'NOT_APPLICABLE',
});
const compiledPlanNoRules = db
  .selectFrom('inspectionPlans')
  .selectAll()
  .where(planNoRulesWhere)
  .compile();
assert(compiledPlanNoRules.sql.includes('1 = 0'), '方案域无生效规则仍必须 fail-closed');

// 4f. 缺省 supplierDimension 等价于 ENFORCE：无供应商列 + 限定供应商 => 仍整条跳过（单据域行为不变）
const enforceDefaultWhere = buildMaterialPermissionWhere([rule({ supplierCodes: ['SUP-001'] })], {
  targetRef: 'mrb_reviews',
  hasSupplierColumn: false,
});
const compiledEnforceDefault = db
  .selectFrom('mrbReviews')
  .selectAll()
  .where(enforceDefaultWhere)
  .compile();
assert(
  compiledEnforceDefault.sql.includes('1 = 0'),
  '缺省模式必须保持 fail-closed（不因新增开关而放行）'
);

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
