/**
 * 乐天 QMS 演示数据播种脚本（CLI 入口）
 *
 * 用法：
 *   仓库根目录： pnpm db:seed
 *   包目录内：   pnpm run seed
 *
 * 行为：
 *   1. 用一条 TRUNCATE 清空全部 18 张业务表（表之间没有外键，无需 RESTART IDENTITY，
 *      主键是 UUID 而非自增序列）；audit_logs 只有 BEFORE UPDATE/DELETE 触发器，
 *      TRUNCATE 是允许的，且本脚本绝不对它做 UPDATE / DELETE。
 *   2. 通过真实仓储类（KyselyInspectionPlanRepository / InspectionOrder / MRBReview /
 *      ReviewFlow / BatchTrace / MaterialPermission）写入方案、工单、MRB、流程、
 *      追溯图与 PBAC 规则，保证 JSONB 与列映射跟运行时完全一致；
 *      主数据（物料/分类/供应商/客户/车间/员工）、集成配置与同步日志、审计与 Outbox
 *      直接走 Kysely insertInto。
 *   3. 打印每张表的行数汇总。脚本幂等：重复执行结果完全一致。
 *
 * 连接配置：优先当前工作目录的 .env，其次回退到 monorepo 根目录的 .env
 * （由 database/connection.ts 统一加载，与 migration runner 共用同一套逻辑）。
 */
import { Kysely, sql } from 'kysely';
import type {
  InspectionItem,
  InspectionPlan,
  InspectionPlanItem,
  PlanSnapshot,
} from '@letian/contracts';
import type { Database } from '../database/schema.js';
import { createDatabaseConnection } from '../database/connection.js';
import { KyselyInspectionPlanRepository } from '../repositories/inspection-plan-repository.js';
import { KyselyInspectionOrderRepository } from '../repositories/inspection-order-repository.js';
import { KyselyMRBReviewRepository } from '../repositories/mrb-review-repository.js';
import { KyselyReviewFlowRepository } from '../repositories/review-flow-repository.js';
import { KyselyBatchTraceRepository } from '../repositories/batch-trace-repository.js';
import { KyselyMaterialPermissionRepository } from '../repositories/material-permission-repository.js';
import {
  EMPLOYEE_IDS,
  SAMPLING,
  seedAuditLogs,
  seedCategories,
  seedCustomers,
  seedEmployees,
  seedIntegrationConfigs,
  seedMaterialPermissions,
  seedMaterials,
  seedMrbReviews,
  seedOrders,
  seedOutboxEvents,
  seedPlans,
  seedReviewFlows,
  seedSuppliers,
  seedSyncLogs,
  seedTraceEdges,
  seedTraceNodes,
  seedWorkshops,
  materialNameOf,
  planVersionOf,
  type ItemResultKind,
  type SeedMetric,
  type SeedPlan,
  type SeedPlanVersion,
} from './data.js';

// ============================================================================
// 0. 需要清空 / 统计的 18 张业务表（CamelCasePlugin 运行时名 -> snake_case 物理名）
// ============================================================================

/** 18 张业务表（与 001/002 迁移 + contract 表清单一致） */
const BUSINESS_TABLES: readonly (keyof Database)[] = [
  'materials',
  'inventoryCategories',
  'suppliers',
  'customers',
  'workshops',
  'employees',
  'inspectionPlans',
  'inspectionOrders',
  'reviewFlows',
  'mrbReviews',
  'batchTraceRelations',
  'batchTraceNodes',
  'auditLogs',
  'idempotencyKeys',
  'outboxEvents',
  'integrationConfigs',
  'integrationSyncLogs',
  'materialPermissions',
];

/** 物理表名（用于打印汇总，便于与 psql 输出对照） */
const TABLE_PHYSICAL_NAMES: Readonly<Record<string, string>> = {
  materials: 'materials',
  inventoryCategories: 'inventory_categories',
  suppliers: 'suppliers',
  customers: 'customers',
  workshops: 'workshops',
  employees: 'employees',
  inspectionPlans: 'inspection_plans',
  inspectionOrders: 'inspection_orders',
  reviewFlows: 'review_flows',
  mrbReviews: 'mrb_reviews',
  batchTraceRelations: 'batch_trace_relations',
  batchTraceNodes: 'batch_trace_nodes',
  auditLogs: 'audit_logs',
  idempotencyKeys: 'idempotency_keys',
  outboxEvents: 'outbox_events',
  integrationConfigs: 'integration_configs',
  integrationSyncLogs: 'integration_sync_logs',
  materialPermissions: 'material_permissions',
};

// ============================================================================
// 1. 指标 / 快照构造工具
// ============================================================================

/** 保留 3 位小数，让演示实测值整洁可读 */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * jsonb 数组列的序列化边界在仓储类里（KyselyInspectionOrderRepository.save /
 * KyselyMaterialPermissionRepository.save 会在写库前做一次 JSON.stringify）。
 *
 * 因此种子数据必须把这些列当作**普通 JS 数组**传入：如果在这里再 stringify 一次，
 * jsonb 列收到的就是 JSON 字符串文本，落库后 `jsonb_typeof(items)` 会是 'string'
 * 而不是 'array'（双编码），读出来是 string，`jsonb_array_elements(items)` 也会直接报
 * "cannot extract elements from a scalar"（SQLSTATE 22023）。
 */

/** 公差内的实测值（取上公差的 35% 作为偏移量） */
function withinTolerance(metric: SeedMetric): number {
  return round3(metric.nominalValue + metric.upperTolerance * 0.35);
}

/** 公差外的实测值（超出上公差 50%） */
function outOfTolerance(metric: SeedMetric): number {
  const overshoot = metric.upperTolerance > 0 ? metric.upperTolerance * 0.5 : 0.01;
  return round3(metric.nominalValue + metric.upperTolerance + overshoot);
}

/** 指标模板 -> 方案快照指标（契约 InspectionPlanItem） */
function toPlanItem(metric: SeedMetric, seq: number): InspectionPlanItem {
  return {
    seq,
    itemCode: metric.itemCode,
    name: metric.name,
    dataType: metric.dataType,
    metricCategory: metric.metricCategory,
    standardText: metric.standardText,
    nominalValue: metric.nominalValue,
    upperTolerance: metric.upperTolerance,
    lowerTolerance: metric.lowerTolerance,
    sampleSize: metric.sampleSize,
    unit: metric.unit,
    measurementTool: metric.measurementTool,
    isMandatory: metric.isMandatory,
  };
}

/** 指标模板 -> 工单实测项（契约 InspectionItem），按形态填充 result / measuredVal */
function toOrderItem(metric: SeedMetric, seq: number, kind: ItemResultKind): InspectionItem {
  const base: InspectionItem = {
    seq,
    itemCode: metric.itemCode,
    name: metric.name,
    dataType: metric.dataType,
    metricCategory: metric.metricCategory,
    standardText: metric.standardText,
    nominalValue: metric.nominalValue,
    upperTolerance: metric.upperTolerance,
    lowerTolerance: metric.lowerTolerance,
    sampleSize: metric.sampleSize,
    unit: metric.unit,
    result: 'PENDING',
  };

  if (kind === 'PENDING') {
    // 未检验：保留 PENDING 且不写实测值
    return base;
  }

  // 只让第 1 项偏离公差，其余项合格，保证 "FAILED -> 至少 1 项 FAILED"
  const failed = kind !== 'ALL_PASSED' && seq === 1;
  const measuredVal = failed ? outOfTolerance(metric) : withinTolerance(metric);

  return {
    ...base,
    measuredVal,
    result: failed ? 'FAILED' : 'PASSED',
    ...(failed
      ? { defectReason: `${metric.name} 实测 ${measuredVal}${metric.unit} 超出公差上限` }
      : {}),
  };
}

/** 组装工单实测项列表 */
function buildOrderItems(version: SeedPlanVersion, kind: ItemResultKind): InspectionItem[] {
  return version.items.map((metric, index) => toOrderItem(metric, index + 1, kind));
}

/** 组装完整的方案版本快照（planId / versionId 均指向该版本行 UUID） */
function buildSnapshot(plan: SeedPlan, version: SeedPlanVersion, snapshotAt: string): PlanSnapshot {
  return {
    planId: version.id,
    planCode: plan.planCode,
    planName: plan.planName,
    versionId: version.id,
    versionNo: version.versionNo,
    samplingScheme: SAMPLING.samplingScheme,
    aqlLevel: SAMPLING.aqlLevel,
    strictness: SAMPLING.strictness,
    items: version.items.map((metric, index) => toPlanItem(metric, index + 1)),
    snapshotAt,
  };
}

/** 依据工单判定形态推导合格 / 不合格数量 */
function deriveQty(sampleQty: number, kind: ItemResultKind): { passQty: number; failQty: number } {
  if (kind === 'PENDING') {
    return { passQty: 0, failQty: 0 };
  }
  if (kind === 'ALL_PASSED') {
    return { passQty: sampleQty, failQty: 0 };
  }
  const failQty = Math.max(1, Math.round(sampleQty * 0.125));
  return { passQty: sampleQty - failQty, failQty };
}

// ============================================================================
// 2. 核心播种逻辑
// ============================================================================

/**
 * 幂等播种：先 TRUNCATE 18 张业务表，再按依赖顺序写入演示数据。
 *
 * @param db Kysely 实例（须已注册 CamelCasePlugin，与运行时一致）
 */
export async function seed(db: Kysely<Database>): Promise<void> {
  // ------------------------------------------------------------------
  // 2.1 清空 18 张业务表（单条 TRUNCATE；UUID 主键无需 RESTART IDENTITY）
  // ------------------------------------------------------------------
  await sql`
    TRUNCATE TABLE
      materials,
      inventory_categories,
      suppliers,
      customers,
      workshops,
      employees,
      inspection_plans,
      inspection_orders,
      review_flows,
      mrb_reviews,
      batch_trace_relations,
      batch_trace_nodes,
      audit_logs,
      idempotency_keys,
      outbox_events,
      integration_configs,
      integration_sync_logs,
      material_permissions
  `.execute(db);

  // ------------------------------------------------------------------
  // 2.2 ERP 主数据（无 save() 方法，直接 insertInto）
  // ------------------------------------------------------------------
  await db.insertInto('inventoryCategories').values(seedCategories).execute();
  await db.insertInto('materials').values(seedMaterials).execute();
  await db.insertInto('suppliers').values(seedSuppliers).execute();
  await db.insertInto('customers').values(seedCustomers).execute();
  await db.insertInto('workshops').values(seedWorkshops).execute();
  await db.insertInto('employees').values(seedEmployees).execute();

  // ------------------------------------------------------------------
  // 2.3 质检方案（走仓储，保证 items / sampling_config 的 JSONB 映射一致）
  // ------------------------------------------------------------------
  const planRepo = new KyselyInspectionPlanRepository(db);
  for (const plan of seedPlans) {
    const dto: InspectionPlan = {
      planCode: plan.planCode,
      planName: plan.planName,
      inspectionType: plan.inspectionType,
      materialCode: plan.materialCode,
      versions: plan.versions.map((version) => ({
        id: version.id,
        planId: version.id,
        versionNo: version.versionNo,
        status: version.status,
        samplingScheme: SAMPLING.samplingScheme,
        aqlLevel: SAMPLING.aqlLevel,
        strictness: SAMPLING.strictness,
        items: version.items.map((metric, index) => toPlanItem(metric, index + 1)),
        createdBy: version.createdBy,
        createdAt: '2023-10-01T08:00:00.000Z',
      })),
      createdAt: '2023-10-01T08:00:00.000Z',
      updatedAt: '2023-10-01T08:00:00.000Z',
    };

    await planRepo.save(dto);
  }

  // ------------------------------------------------------------------
  // 2.4 检验工单（plan_snapshot 完整，planId 指向真实方案版本行）
  // ------------------------------------------------------------------
  const orderRepo = new KyselyInspectionOrderRepository(db);
  for (const spec of seedOrders) {
    const plan = seedPlans.find((candidate) => candidate.planCode === spec.planCode);
    if (!plan) {
      throw new Error(`SEED_PLAN_NOT_FOUND: 工单 [${spec.orderNo}] 引用了不存在的方案 [${spec.planCode}]`);
    }
    const version = planVersionOf(spec.planCode, spec.versionNo);
    const { passQty, failQty } = deriveQty(spec.sampleQty, spec.itemKind);

    const order = {
      id: spec.id,
      orderNo: spec.orderNo,
      inspectionType: spec.orderType,
      materialCode: spec.materialCode,
      materialName: materialNameOf(spec.materialCode),
      batchNo: spec.batchNo,
      sampleQty: spec.sampleQty,
      passQty,
      failQty,
      isMandatoryGate: spec.isMandatoryGate,
      status: spec.status,
      inspectorId: spec.inspectorId,
      inspectionNotes: spec.inspectionNotes,
      planVersionId: version.id,
      planSnapshot: buildSnapshot(plan, version, spec.snapshotAt),
      // items 原样传数组：JSON 序列化由仓储 save() 统一负责（见文件顶部双编码说明）
      items: buildOrderItems(version, spec.itemKind),
      ...(spec.supplierCode !== undefined ? { supplierCode: spec.supplierCode } : {}),
      ...(spec.customerCode !== undefined ? { customerCode: spec.customerCode } : {}),
      ...(spec.judgment !== null ? { overallDecision: spec.judgment } : {}),
    };

    await orderRepo.save(order);
  }

  // ------------------------------------------------------------------
  // 2.5 可配置评审流程
  // ------------------------------------------------------------------
  const flowRepo = new KyselyReviewFlowRepository(db);
  for (const flow of seedReviewFlows) {
    await flowRepo.save(flow);
  }

  // ------------------------------------------------------------------
  // 2.6 MRB 评审单（source_order_no 均命中已播种工单号）
  // ------------------------------------------------------------------
  const mrbRepo = new KyselyMRBReviewRepository(db);
  for (const review of seedMrbReviews) {
    await mrbRepo.save(review);
  }

  // ------------------------------------------------------------------
  // 2.7 批次追溯图（主链路 DAG + 独立环分量）
  // ------------------------------------------------------------------
  const traceRepo = new KyselyBatchTraceRepository(db);
  for (const node of seedTraceNodes) {
    await traceRepo.saveNode(node);
  }
  for (const edge of seedTraceEdges) {
    await traceRepo.saveEdge(edge);
  }

  // ------------------------------------------------------------------
  // 2.8 PBAC 物料行级权限（三个 jsonb 数组列原样传数组，序列化由仓储负责）
  // ------------------------------------------------------------------
  const permissionRepo = new KyselyMaterialPermissionRepository(db);
  for (const permission of seedMaterialPermissions) {
    await permissionRepo.save(permission);
  }

  // ------------------------------------------------------------------
  // 2.9 MES / ERP 集成配置与同步日志（订阅车间/工序为 jsonb 数组列）
  // ------------------------------------------------------------------
  await db
    .insertInto('integrationConfigs')
    .values(
      seedIntegrationConfigs.map((config) => ({
        ...config,
        subscribedWorkshops: JSON.stringify(config.subscribedWorkshops ?? []),
        subscribedProcesses: JSON.stringify(config.subscribedProcesses ?? []),
      }))
    )
    .execute();
  await db.insertInto('integrationSyncLogs').values(seedSyncLogs).execute();

  // ------------------------------------------------------------------
  // 2.10 审计日志（append-only，仅 INSERT）与 Outbox 事件
  // ------------------------------------------------------------------
  await db.insertInto('auditLogs').values(seedAuditLogs).execute();
  await db.insertInto('outboxEvents').values(seedOutboxEvents).execute();

  // ------------------------------------------------------------------
  // 2.11 打印行数汇总
  // ------------------------------------------------------------------
  await printRowCountSummary(db);
}

// ============================================================================
// 3. 汇总打印
// ============================================================================

/** 统计并打印每张业务表的行数 */
export async function printRowCountSummary(db: Kysely<Database>): Promise<void> {
  const rows: Array<{ table: string; count: number }> = [];

  for (const table of BUSINESS_TABLES) {
    const row = await db
      .selectFrom(table)
      .select((eb) => eb.fn.countAll().as('count'))
      .executeTakeFirst();
    const physicalName = TABLE_PHYSICAL_NAMES[table] ?? table;
    rows.push({ table: physicalName, count: row ? Number(row.count) : 0 });
  }

  const total = rows.reduce((sum, item) => sum + item.count, 0);
  const width = rows.reduce((max, item) => Math.max(max, item.table.length), 0);

  console.log('');
  console.log('[Seeder] ==============================================');
  console.log('[Seeder] 演示数据播种完成，各表行数汇总：');
  console.log(`[Seeder]   ${'table'.padEnd(width)} | rows`);
  console.log(`[Seeder]   ${'-'.repeat(width)}-+------`);
  for (const item of rows) {
    console.log(`[Seeder]   ${item.table.padEnd(width)} | ${String(item.count).padStart(4)}`);
  }
  console.log(`[Seeder]   ${'-'.repeat(width)}-+------`);
  console.log(`[Seeder]   ${'TOTAL (18 tables)'.padEnd(width)} | ${String(total).padStart(4)}`);
  console.log('[Seeder] ==============================================');
  console.log('');
}

// ============================================================================
// 4. CLI 入口
// ============================================================================

/** 创建连接 -> 播种 -> 释放连接；失败时抛出由调用方处理 */
export async function main(): Promise<void> {
  const db = createDatabaseConnection();
  try {
    console.log('[Seeder] 开始播种演示数据 ...');
    await seed(db);
    console.log(`[Seeder] 播种完成。系统操作人 UUID 示例：${EMPLOYEE_IDS.zhangQiang}`);
  } finally {
    await db.destroy();
  }
}

// 允许命令行直接调用: tsx src/seeds/runner.ts
if (require.main === module) {
  main()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      // 打印可读的失败原因（含数据库返回的原始报错），并以非零码退出
      console.error('[Seeder] 演示数据播种失败，请检查数据库连接与约束配置。');
      console.error('[Seeder] Fatal error:', err instanceof Error ? err.message : err);
      if (err instanceof Error && err.stack) {
        console.error(err.stack);
      }
      process.exit(1);
    });
}
