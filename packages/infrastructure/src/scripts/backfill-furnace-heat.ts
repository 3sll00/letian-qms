/**
 * 存量检验单「炉批号」回填（docs/52-炉批号数据来源映射口径）
 * ───────────────────────────────────────────────────────────────────────────
 * 背景：
 *   `inspection_orders.furnace_heat_batch_no` 全库为空（ERP 探查已证实无炉号字段；
 *   MES `t_production_task.heat_number`/`steel_mill` 是唯一真实上游）。
 *   MES 同步建单时已自动携带 `furnaceHeatNo`，缺口只存在于**存量单**。
 *
 * 映射口径（docs/52 §2/§3，实测命中率 4,915/4,920 = 99.9%）：
 *   join 键：`inspection_orders.work_order_no` ↔ `t_production_task.bill_no`（PT 号，
 *             `work_no` 兜底）。
 *   分类：
 *     HIT        = 任务命中且 heat_number 非空 → 回填
 *     NO_HEAT    = 任务命中但 heat_number 为空 → 仅报告（冷镦/搓丝任务在 MES
 *                  不带炉号，口径 docs/52 §4：短期手工录入，中期 MES 侧补数）
 *     MISS       = work_order_no 在 MES 任务表中找不到（演示单等）→ 仅报告
 *     CONFLICT   = 已有炉号且归一化后与 MES 值不一致 → 仅报告，**不覆盖**人工值
 *     FILLED     = 已有炉号且与 MES 一致（或 MES 无值）→ 跳过
 *
 * 写入路径（docs/52 §3.1 硬约束）：
 *   复用 `UpdateInspectionHeatFieldsUseCase` —— 与 PATCH /inspections/{id}/header
 *   同一应用层路径，炉批号 + 服务端重解析的 heat_source_type/order_no + audit_logs
 *   在同一事务落库；同事务顺带把 `batch_trace_nodes.furnace_heat_batch_no`
 *   按 order.batch_no 同步（节点由终判登记，这里只更新既有行，不新建）。
 *   steel_mill 无独立列，不落库（docs/52 §3），仅在清单中展示备核。
 *
 * 安全模型：
 *   - MES 侧全部走 `queryMesReadOnly`（SELECT-only 守门）。
 *   - 默认 dryRun：打印命中/未命中/无炉号/冲突清单，不写 QMS 库。
 *   - `--commit` 才真实写入；逐单事务，单失败不影响其他单，可安全重跑（幂等）。
 *
 * 运行（Git Bash / PowerShell，仓库根目录）：
 *   node node_modules/tsx/dist/cli.mjs packages/infrastructure/src/scripts/backfill-furnace-heat.ts
 *   node node_modules/tsx/dist/cli.mjs packages/infrastructure/src/scripts/backfill-furnace-heat.ts --order=CR20260600168
 *   node node_modules/tsx/dist/cli.mjs packages/infrastructure/src/scripts/backfill-furnace-heat.ts --commit
 */

import dotenv from 'dotenv';
dotenv.config();
import { sql } from 'kysely';
import { normalizeHeatBatchNo } from '@letian/domain';
import { UpdateInspectionHeatFieldsUseCase } from '@letian/application';
import { db } from '../database/connection.js';
import { KyselyUnitOfWork } from '../tx/kysely-unit-of-work.js';
import { closeMesConnectionPool, getMesConnectionPool } from '../adapters/mes-pool.js';
import { queryMesReadOnly, mesReadOnlyAudit } from '../sync/mes-readonly.js';

const BACKFILL_OPERATOR_ID = 'system:backfill-furnace-heat';
const BACKFILL_OPERATOR_NAME = '炉批号回填(MES)';
const MES_IN_CHUNK = 500;

interface CliArgs {
  commit: boolean;
  orderNo: string | null;
  limit: number | null;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { commit: false, orderNo: null, limit: null };
  for (const raw of argv) {
    if (raw === '--commit') args.commit = true;
    else if (raw.startsWith('--order=')) args.orderNo = raw.slice('--order='.length).trim();
    else if (raw.startsWith('--limit=')) {
      const n = Number.parseInt(raw.slice('--limit='.length), 10);
      if (Number.isFinite(n) && n > 0) args.limit = n;
    }
  }
  return args;
}

interface OrderRow {
  id: string;
  orderNo: string;
  orderType: string;
  workOrderNo: string | null | undefined;
  batchNo: string;
  materialCode: string | null;
  furnaceHeatBatchNo: string | null | undefined;
}

interface MesTaskRow {
  bill_no: string;
  work_no: string | null;
  heat_number: string | null;
  steel_mill: string | null;
}

type RowKind = 'HIT' | 'NO_HEAT' | 'MISS' | 'CONFLICT' | 'FILLED';

interface ClassifiedRow {
  kind: RowKind;
  order: OrderRow;
  mesHeat: string | null;
  steelMill: string | null;
}

/** 拉取待评估检验单：work_order_no 非空才可能有 MES 关联 */
async function loadOrders(orderNo: string | null, limit: number | null): Promise<OrderRow[]> {
  let query = db
    .selectFrom('inspectionOrders')
    .select(['id', 'orderNo', 'orderType', 'workOrderNo', 'batchNo', 'materialCode', 'furnaceHeatBatchNo'])
    .where('workOrderNo', 'is not', null)
    .where('workOrderNo', '<>', '')
    .orderBy('orderNo');
  if (orderNo !== null) query = query.where('orderNo', '=', orderNo);
  if (limit !== null) query = query.limit(limit);
  return await query.execute();
}

/** 按 work_order_no 批量反查 MES 任务（bill_no / work_no 双键兜底，全部只读） */
async function loadMesTasks(workOrderNos: readonly string[]): Promise<Map<string, MesTaskRow>> {
  const pool = await getMesConnectionPool();
  if (!pool) {
    throw new Error('[backfill-heat] MES 连接不可用：请检查 MES_DB_* 环境变量');
  }
  const runner = {
    query: async (sqlText: string, params: readonly (string | number | null)[] = []) => {
      const [rows] = await pool.query(sqlText, [...params]);
      return { rows: rows as unknown[] };
    },
  };

  const tasks = new Map<string, MesTaskRow>();
  const unique = [...new Set(workOrderNos)];
  for (let i = 0; i < unique.length; i += MES_IN_CHUNK) {
    const chunk = unique.slice(i, i + MES_IN_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await queryMesReadOnly<MesTaskRow>(
      runner,
      `SELECT bill_no, work_no, heat_number, steel_mill
         FROM t_production_task
        WHERE del_flag = 0
          AND (bill_no IN (${placeholders}) OR work_no IN (${placeholders}))`,
      [...chunk, ...chunk],
    );
    for (const row of rows) {
      // bill_no 优先登记；同一 work_no 首次命中即登记（work_no 非唯一键，不覆盖 bill_no 命中）
      if (row.bill_no && !tasks.has(row.bill_no)) tasks.set(row.bill_no, row);
      if (row.work_no && !tasks.has(row.work_no)) tasks.set(row.work_no, row);
    }
  }
  return tasks;
}

function classify(orders: readonly OrderRow[], tasks: ReadonlyMap<string, MesTaskRow>): ClassifiedRow[] {
  return orders.map((order) => {
    const task = tasks.get(order.workOrderNo ?? '');
    if (!task) return { kind: 'MISS', order, mesHeat: null, steelMill: null };

    const mesHeat = (task.heat_number ?? '').trim() || null;
    const existing = (order.furnaceHeatBatchNo ?? '').trim();

    if (existing !== '') {
      // 已有值：与 MES 一致 → FILLED；不一致 → CONFLICT（人工值不覆盖）
      const same = mesHeat !== null && normalizeHeatBatchNo(existing) === normalizeHeatBatchNo(mesHeat);
      return { kind: same || mesHeat === null ? 'FILLED' : 'CONFLICT', order, mesHeat, steelMill: task.steel_mill };
    }
    if (mesHeat === null) return { kind: 'NO_HEAT', order, mesHeat: null, steelMill: task.steel_mill };
    return { kind: 'HIT', order, mesHeat, steelMill: task.steel_mill };
  });
}

function printList(title: string, rows: readonly ClassifiedRow[], render: (r: ClassifiedRow) => string, cap = 40): void {
  console.log(`  ${title} (${rows.length})`);
  rows.slice(0, cap).forEach((r) => console.log(`    ${render(r)}`));
  if (rows.length > cap) console.log(`    … 其余 ${rows.length - cap} 条略`);
}

/**
 * 单条回填：复用表头更新用例（服务端重解析 heat_source_*、写 audit_logs），
 * 同事务同步 batch_trace_nodes.furnace_heat_batch_no（仅更新既有节点行）。
 */
async function backfillOne(order: OrderRow, heat: string): Promise<{ sourceType: string; nodeSynced: number }> {
  return await db.transaction().execute(async (trx) => {
    const useCase = new UpdateInspectionHeatFieldsUseCase(new KyselyUnitOfWork(trx));
    const result = await useCase.execute({
      orderId: order.id,
      furnaceHeatNo: heat,
      operatorId: BACKFILL_OPERATOR_ID,
      operatorName: BACKFILL_OPERATOR_NAME,
    });

    const nodeRows = await sql<{ n: number }>`
      UPDATE batch_trace_nodes
         SET furnace_heat_batch_no = ${heat}
       WHERE batch_no = ${order.batchNo}
         AND (furnace_heat_batch_no IS NULL OR furnace_heat_batch_no <> ${heat})
    `.execute(trx);

    return { sourceType: result.sourceType, nodeSynced: Number(nodeRows.numAffectedRows ?? 0) };
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[backfill-heat] mode=${args.commit ? 'COMMIT(真实写入)' : 'DRY-RUN(仅预览)'}${args.orderNo ? ` order=${args.orderNo}` : ''}${args.limit ? ` limit=${args.limit}` : ''}`);

  const orders = await loadOrders(args.orderNo, args.limit);
  console.log(`[backfill-heat] 待评估检验单 ${orders.length} 张（work_order_no 非空）`);
  if (orders.length === 0) return;

  const tasks = await loadMesTasks(orders.map((o) => o.workOrderNo ?? ''));
  console.log(`[backfill-heat] MES 任务命中键 ${tasks.size} 个；MES 侧共发 ${mesReadOnlyAudit.length} 条 SELECT（全部只读）`);

  const rows = classify(orders, tasks);
  const by = (kind: RowKind) => rows.filter((r) => r.kind === kind);
  const [hits, noHeat, miss, conflict, filled] = [by('HIT'), by('NO_HEAT'), by('MISS'), by('CONFLICT'), by('FILLED')];

  console.log(`[backfill-heat] 分类：HIT(待回填)=${hits.length}  NO_HEAT(任务无炉号)=${noHeat.length}  MISS(MES无此工单)=${miss.length}  CONFLICT(已有值不一致)=${conflict.length}  FILLED(已有一致)=${filled.length}`);

  printList('HIT 回填清单', hits, (r) => `${r.order.orderNo} [${r.order.orderType}] ${r.order.workOrderNo} → heat=${r.mesHeat} 钢厂=${r.steelMill ?? '-'}`);
  printList('MISS 未命中', miss, (r) => `${r.order.orderNo} [${r.order.orderType}] work_order_no=${r.order.workOrderNo}`);
  printList('CONFLICT 冲突', conflict, (r) => `${r.order.orderNo} 现有=${r.order.furnaceHeatBatchNo} ↔ MES=${r.mesHeat}（跳过，不覆盖）`);
  // NO_HEAT 量大且口径已定（docs/52 §4 方案 B+C），只打印汇总分布
  const noHeatByType = noHeat.reduce<Record<string, number>>((acc, r) => {
    acc[r.order.orderType] = (acc[r.order.orderType] ?? 0) + 1;
    return acc;
  }, {});
  if (noHeat.length > 0) console.log(`  NO_HEAT 分布：${JSON.stringify(noHeatByType)}（转手工录入口径，不逐条展开）`);

  if (!args.commit) {
    console.log('[backfill-heat] 预览结束，未写入任何数据。确认清单无误后加 --commit 执行。');
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const row of hits) {
    try {
      const res = await backfillOne(row.order, row.mesHeat as string);
      ok += 1;
      console.log(`  ✔ ${row.order.orderNo} heat=${row.mesHeat} source=${res.sourceType} 节点同步=${res.nodeSynced}`);
    } catch (error) {
      failed += 1;
      console.error(`  ✘ ${row.order.orderNo} 回填失败（本单事务已回滚，其余不受影响）：`, error instanceof Error ? error.message : error);
    }
  }
  console.log(`[backfill-heat] 完成：成功 ${ok} / 失败 ${failed} / 跳过 ${rows.length - hits.length}`);

  // 回填后复核：仍为空且 work_order_no 非空的剩余数量
  const remaining = await db
    .selectFrom('inspectionOrders')
    .select((eb) => eb.fn.countAll().as('n'))
    .where('workOrderNo', 'is not', null)
    .where('workOrderNo', '<>', '')
    .where((eb) => eb.or([eb('furnaceHeatBatchNo', 'is', null), eb('furnaceHeatBatchNo', '=', '')]))
    .executeTakeFirst();
  console.log(`[backfill-heat] 复核：work_order_no 非空且炉号仍为空的单 = ${remaining?.n ?? '?'}（NO_HEAT/MISS 属预期缺口）`);
}

main()
  .then(async () => {
    await closeMesConnectionPool();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error('[backfill-heat] 执行失败：', error);
    await closeMesConnectionPool().catch(() => undefined);
    process.exit(1);
  });
