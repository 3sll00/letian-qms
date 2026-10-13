import { Kysely } from 'kysely';
import type { Database } from '../database/schema.js';
import type { InspectionType, TraceNodeStatus, TraceRelationType } from '@letian/contracts';
import { db as defaultDb } from '../database/connection.js';
import { queryMes, assertSafeMesDatabase, STRICT_MES_TARGET_DB } from './mes-pool.js';
import { createFixtureMesReads, type MesFixtureData } from '../sync/mes-reads.js';
import { CreateInspectionOrderUseCase } from '@letian/application';
import { createUnitOfWork } from '../tx/kysely-unit-of-work.js';

export interface MesSyncResult {
  success: boolean;
  targetDatabase: string;
  durationMs: number;
  syncedWorkshops: number;
  syncedInspectionOrders: number;
  syncedTraceNodes: number;
  syncedTraceRelations: number;
  details: string[];
}

/**
 * 1. 同步 MES 工序主数据至 QMS workshops 字典表
 */
/**
 * MES 侧只有检验员**姓名**、没有 QMS 用户主键，而契约 `InspectionOrderSchema`
 * 要求 `inspectorId` 为 uuid。故检验员编号统一落这个固定占位 UUID，真实姓名留在
 * `inspectorName` 上（详情页按姓名展示，不因占位编号影响可读性）。
 */
const MES_INSPECTOR_PLACEHOLDER_ID = '00000000-0000-4000-8000-000000004d53';

export async function syncMesWorkshops(
  customDb?: Kysely<Database>
): Promise<{ total: number; inserted: number }> {
  assertSafeMesDatabase();
  const db = customDb || defaultDb;

  interface MesProcedureRow {
    id: string;
    code: string;
    name: string;
    remarks?: string;
  }

  const procedures = await queryMes<MesProcedureRow>(
    'SELECT id, code, name, remarks FROM t_procedure WHERE name IS NOT NULL AND name != "" ORDER BY code ASC'
  );

  if (!procedures || procedures.length === 0) {
    return { total: 0, inserted: 0 };
  }

  const existing = await db.selectFrom('workshops').select('workshopCode').execute();
  const existingCodes = new Set(existing.map((w) => w.workshopCode));

  let insertedCount = 0;
  for (const proc of procedures) {
    const workshopCode = `WS-MES-${proc.code || proc.id.substring(0, 4)}`;
    if (!existingCodes.has(workshopCode)) {
      await db
        .insertInto('workshops')
        .values({
          workshopCode,
          workshopName: `${proc.name} (MES)`,
          createdAt: new Date(),
        })
        .execute();
      existingCodes.add(workshopCode);
      insertedCount++;
    }
  }

  return { total: procedures.length, inserted: insertedCount };
}

/**
 * 2. 同步 MES 检验单 (t_check_report) 至 QMS inspection_orders
 */
export async function syncMesInspectionOrders(
  customDb?: Kysely<Database>,
  limit: number = 200,
  options: { reports?: readonly MesCheckReportJoinedRow[]; notesPrefix?: string } = {}
): Promise<{ total: number; inserted: number }> {
  const db = customDb || defaultDb;
  const notesPrefix = options.notesPrefix ?? '[MES实绩同步]';

  interface MesCheckReportRow {
    id: string;
    bill_no: string;
    bill_date: Date | string | null;
    check_date: Date | string | null;
    check_qty: string | number;
    qualified_qty: string | number;
    unqualified_qty: string | number;
    is_qualified: string | number;
    remarks?: string | null;
    task_bill_no?: string | null;
    heat_number?: string | null;
    steel_mill?: string | null;
    cutting_length?: string | number | null;
    materiel_code?: string | null;
    materiel_name?: string | null;
    materiel_spec?: string | null;
    procedure_code?: string | null;
    procedure_name?: string | null;
    inspector_name?: string | null;
  }

  const sql = `
    SELECT 
      r.id, r.bill_no, r.bill_date, r.check_date,
      r.check_qty, r.qualified_qty, r.unqualified_qty, r.is_qualified, r.remarks,
      t.bill_no as task_bill_no, t.heat_number, t.steel_mill, t.cutting_length,
      m.code as materiel_code, m.name as materiel_name, m.spec as materiel_spec,
      p.code as procedure_code, p.name as procedure_name,
      u.realname as inspector_name
    FROM t_check_report r
    LEFT JOIN t_production_task t ON r.task_id = t.id
    LEFT JOIN t_materiel m ON r.materiel_id = m.id
    LEFT JOIN t_procedure p ON r.procedure_id = p.id
    LEFT JOIN sys_user u ON r.create_user_id = u.id
    ORDER BY r.create_time DESC
    LIMIT ?
  `;

  // 传入 reports 时走离线/测试数据源，不触碰 MES 连接（演示模式与单测使用）
  let reports: readonly MesCheckReportJoinedRow[] | undefined = options.reports;
  if (!reports) {
    assertSafeMesDatabase();
    reports = await queryMes<MesCheckReportJoinedRow>(sql, [limit]);
  }
  if (!reports || reports.length === 0) {
    return { total: 0, inserted: 0 };
  }

  // 创建检验单统一使用建单用例，由物料专属或分类通用方案绑定真实版本与快照
  const creator = new CreateInspectionOrderUseCase(createUnitOfWork(db));
  // MES 只有整单检验结论，没有逐指标实测；不可借用任意方案 UUID 或固定占位 UUID。
  // 不存在生效方案时建单失败，不把其它物料的判标错误绑定到本单。
  // 历史结论保留在整单状态与数量中，方案检验项仍标记未录入。
  const operatorId = 'SYS-MES-SYNC';

  // 查出已存在的检验工单号，避免重复
  const existingOrders = await db.selectFrom('inspectionOrders').select('orderNo').execute();
  const existingOrderNos = new Set(existingOrders.map((o) => o.orderNo));

  let insertedCount = 0;
  for (const rep of reports) {
    if (!rep.bill_no || existingOrderNos.has(rep.bill_no)) {
      continue;
    }

    const isQualified = String(rep.is_qualified) === '1';
    const totalQty = parseFloat(String(rep.check_qty || 0));
    const passQty = parseFloat(String(rep.qualified_qty || 0));
    const failQty = parseFloat(String(rep.unqualified_qty || 0));

    // 根据工序映射为合规的 InspectionType 枚举
    const procName = rep.procedure_name || '工序检验';
    let orderType: InspectionType = 'IPQC_FN';
    // 工序归类按 MES 真实 t_procedure 字典（t_check_report 实际出现的工序名）：
    //   冷镦 / 断料 → 下料检验；搓丝(含组合搓丝) / 滚丝 / 滚牙 / 滚长头 → 滚丝检验；其余（检测入库/力学检验/挑选等）→ 成品检
    if (procName.includes('冷镦') || procName.includes('断料')) {
      orderType = 'IPQC_CT';
    } else if (
      procName.includes('搓丝') ||
      procName.includes('滚丝') ||
      procName.includes('滚牙') ||
      procName.includes('滚长头')
    ) {
      orderType = 'IPQC_RL';
    } else if (procName.includes('检测入库') || procName.includes('入库') || procName.includes('力学检验')) {
      orderType = 'IPQC_FN';
    }

    const checkDate = rep.check_date ? new Date(rep.check_date) : (rep.bill_date ? new Date(rep.bill_date) : new Date());

    // 历史实绩必须使用真实方案快照；MES 只提供整单判定，不提供逐指标测量值。
    //   建单用例生成与生效方案一致的检验项，单项保留 PENDING（不得伪造「合格」实测）。
    //   原始合格数量、不合格数量与整单结论仍在同一事务落库。
    //   来源单号、工单号、炉号、工序及原始备注按 MES 原值记录，不猜测物料编码。
    //   如果无物料编码或生效方案，显式失败，避免将别的产品方案错绑到此单。
    //   未经检验项实测验证的历史结论，不由本次导入自动重新终判或触发 MRB。
    if (!rep.materiel_code?.trim()) {
      throw new Error(`MES_IMPORT_MATERIAL_MISSING: ${rep.bill_no}`);
    }
    if (!Number.isFinite(totalQty) || totalQty <= 0 || !Number.isFinite(passQty) || !Number.isFinite(failQty)) {
      throw new Error(`MES_IMPORT_QUANTITY_INVALID: ${rep.bill_no}`);
    }
    const notes = `${notesPrefix} 生产工单:${rep.task_bill_no || '-'} 熔炼炉号:${rep.heat_number || '-'} 钢厂:${rep.steel_mill || '-'} 工序:${procName}${rep.remarks ? ` 备注:${rep.remarks}` : ''}`;
    await creator.execute({
      orderNo: rep.bill_no,
      inspectionType: orderType,
      materialCode: rep.materiel_code,
      ...(rep.materiel_name ? { materialName: rep.materiel_name } : {}),
      batchNo: rep.task_bill_no || rep.heat_number || rep.bill_no,
      batchQty: totalQty,
      sampleSize: totalQty,
      totalQty,
      inspectorId: MES_INSPECTOR_PLACEHOLDER_ID,
      inspectorName: rep.inspector_name || 'MES检验员',
      mandatoryGate: procName.includes('检测入库') || procName.includes('力学检验'),
      ...(rep.task_bill_no ? { workOrderNo: rep.task_bill_no } : {}),
      ...(rep.heat_number ? { furnaceHeatNo: rep.heat_number } : {}),
      ...(rep.cutting_length ? { blankingLength: Number(rep.cutting_length) } : {}),
      ...(rep.materiel_spec ? { threadSpec: rep.materiel_spec } : {}),
      processStep: procName,
      completedAt: checkDate.toISOString(),
      historicalResult: {
        source: 'MES',
        occurredAt: checkDate,
        passQty,
        failQty,
        judgment: isQualified ? 'PASSED' : 'FAILED',
        notes,
      },
      operatorId,
      operatorName: 'MES同步服务',
    });

    existingOrderNos.add(rep.bill_no);
    insertedCount++;
  }

  return { total: reports.length, inserted: insertedCount };
}

/** MES 检验单（t_check_report）联表结果行形状：真实 SQL 与离线演示数据都产出这一形状 */
export interface MesCheckReportJoinedRow {
  id: string;
  bill_no: string;
  bill_date: Date | string | null;
  check_date: Date | string | null;
  check_qty: string | number;
  qualified_qty: string | number;
  unqualified_qty: string | number;
  is_qualified: string | number;
  remarks?: string | null;
  task_bill_no?: string | null;
  heat_number?: string | null;
  steel_mill?: string | null;
  cutting_length?: string | number | null;
  materiel_code?: string | null;
  materiel_name?: string | null;
  materiel_spec?: string | null;
  procedure_code?: string | null;
  procedure_name?: string | null;
  inspector_name?: string | null;
}

/* --------------------------------------------------------------------------
 * MES 离线演示数据源
 * 用途：本环境无外网、MES（120.26.99.40）不可达时，用本地样例把
 *      「MES 读取 → 映射 → QMS 落库」整条管线真实跑通（可观察、可验证）。
 * 边界：仅当 MES_SYNC_DEMO=1 时启用；落库备注统一打 [MES演示同步] 前缀，
 *      与真实同步的 [MES实绩同步] 明确区分，便于识别与清理。
 * ------------------------------------------------------------------------ */
const DEMO_PROCEDURE_NAMES: Record<string, string> = {
  'proc-cd': '冷镦成型',
  'proc-cs': '搓丝成型',
  'proc-rk': '检测入库',
};

const DEMO_TASK_META: Record<string, { billNo: string; heatNumber: string; steelMill: string }> = {
  'task-01': { billNo: 'SC-20261010-001', heatNumber: 'H-241001', steelMill: '兴澄特钢' },
  'task-02': { billNo: 'SC-20261010-002', heatNumber: 'H-241002', steelMill: '中信泰富特钢' },
};

const DEMO_MES_FIXTURE: MesFixtureData = {
  processInspections: [
    {
      id: 'demo-cr-01',
      billNo: 'MES-IPQC-20261010-001',
      billDate: '2026-10-10T08:30:00',
      taskId: 'task-01',
      taskBodyId: null,
      materielId: null,
      procedureId: 'proc-cd',
      checkQty: 120,
      qualifiedQty: 120,
      unqualifiedQty: 0,
      isQualified: '1',
      checkUserName: '冷镦工序质检·王强',
      checkDate: '2026-10-10T09:20:00',
      remarks: '首件三检确认合格',
      billStatus: '3',
      createTime: '2026-10-10T09:20:00',
    },
    {
      id: 'demo-cr-02',
      billNo: 'MES-IPQC-20261010-002',
      billDate: '2026-10-10T10:05:00',
      taskId: 'task-01',
      taskBodyId: null,
      materielId: null,
      procedureId: 'proc-cs',
      checkQty: 90,
      qualifiedQty: 89,
      unqualifiedQty: 1,
      isQualified: '1',
      checkUserName: '搓丝工序质检·李敏',
      checkDate: '2026-10-10T10:40:00',
      remarks: '螺纹通止规抽检 1 件返修后合格',
      billStatus: '3',
      createTime: '2026-10-10T10:40:00',
    },
    {
      id: 'demo-cr-03',
      billNo: 'MES-IPQC-20261010-003',
      billDate: '2026-10-10T13:15:00',
      taskId: 'task-02',
      taskBodyId: null,
      materielId: null,
      procedureId: 'proc-rk',
      checkQty: 60,
      qualifiedQty: 56,
      unqualifiedQty: 4,
      isQualified: '0',
      checkUserName: '成品入库检验·赵磊',
      checkDate: '2026-10-10T14:00:00',
      remarks: '硬度抽检 4 件低于下限，判不合格待评审',
      billStatus: '3',
      createTime: '2026-10-10T14:00:00',
    },
    {
      id: 'demo-cr-04',
      billNo: 'MES-IPQC-20261010-004',
      billDate: '2026-10-10T15:20:00',
      taskId: 'task-02',
      taskBodyId: null,
      materielId: null,
      procedureId: 'proc-cd',
      checkQty: 120,
      qualifiedQty: 118,
      unqualifiedQty: 2,
      isQualified: '1',
      checkUserName: '冷镦工序质检·王强',
      checkDate: '2026-10-10T16:05:00',
      remarks: '巡检第 2 轮，2 件外观磕伤已挑出',
      billStatus: '3',
      createTime: '2026-10-10T16:05:00',
    },
  ],
};

/**
 * 离线演示同步：读取本地 MES 样例检验单，复用与真实同步完全相同的映射与落库逻辑。
 * MES 不可达（无外网）时用它把管线跑通；MES 可达时请关闭演示模式走真实同步。
 */
export async function syncMesDemoInspectionOrders(
  customDb?: Kysely<Database>,
  limit: number = 200
): Promise<{ total: number; inserted: number }> {
  const reads = createFixtureMesReads(DEMO_MES_FIXTURE, 'fixture(MES演示样例)');
  const inspections = await reads.fetchProcessInspections(limit);

  const reports: MesCheckReportJoinedRow[] = inspections.map((row) => {
    const task = DEMO_TASK_META[row.taskId ?? ''] ?? null;
    const procedureName = DEMO_PROCEDURE_NAMES[row.procedureId ?? ''] ?? '工序检验';
    return {
      id: row.id,
      bill_no: row.billNo ?? row.id,
      bill_date: row.billDate ?? row.checkDate,
      check_date: row.checkDate ?? row.billDate,
      check_qty: row.checkQty ?? 0,
      qualified_qty: row.qualifiedQty ?? 0,
      unqualified_qty: row.unqualifiedQty ?? 0,
      is_qualified: row.isQualified === '1' ? '1' : '0',
      remarks: row.remarks,
      task_bill_no: task?.billNo ?? null,
      heat_number: task?.heatNumber ?? null,
      steel_mill: task?.steelMill ?? null,
      cutting_length: null,
      materiel_code: row.procedureId === 'proc-cd'
        ? 'MAT-SCR-M6-25'
        : row.procedureId === 'proc-cs'
          ? 'MAT-THRD-M6-25'
          : 'MAT-BLT-109-M10',
      materiel_name: null,
      materiel_spec: null,
      procedure_code: row.procedureId,
      procedure_name: procedureName,
      inspector_name: row.checkUserName,
    };
  });

  return syncMesInspectionOrders(customDb, limit, {
    reports,
    notesPrefix: '[MES演示同步]',
  });
}

/**
 * 3. 同步 MES 生产任务与炉批号节点 (t_production_task) 至 QMS 批次追溯拓扑
 */
export async function syncMesBatchTrace(
  customDb?: Kysely<Database>,
  limit: number = 200
): Promise<{ syncedNodes: number; syncedRelations: number }> {
  assertSafeMesDatabase();
  const db = customDb || defaultDb;

  interface MesTaskRow {
    bill_no: string;
    heat_number: string | null;
    steel_mill: string | null;
    cutting_length: string | number | null;
    production_num: string | number | null;
    bill_date: Date | string | null;
    mat_code: string | null;
    mat_name: string | null;
  }

  const sql = `
    SELECT 
      t.bill_no, t.heat_number, t.steel_mill, t.cutting_length, t.production_num, t.bill_date,
      m.code as mat_code, m.name as mat_name
    FROM t_production_task t
    LEFT JOIN t_materiel m ON t.materiel_id = m.id
    WHERE t.heat_number IS NOT NULL AND t.heat_number != ""
    ORDER BY t.bill_date DESC
    LIMIT ?
  `;

  const tasks = await queryMes<MesTaskRow>(sql, [limit]);
  if (!tasks || tasks.length === 0) {
    return { syncedNodes: 0, syncedRelations: 0 };
  }

  let nodeCount = 0;
  let relationCount = 0;

  for (const task of tasks) {
    const heatNo = task.heat_number!;
    const taskOrderNo = task.bill_no;
    const occurredAt = task.bill_date ? new Date(task.bill_date) : new Date();

    // 1. 原材料炉批号节点
    const existingHeatNode = await db
      .selectFrom('batchTraceNodes')
      .select('id')
      .where('batchNo', '=', heatNo)
      .where('stageName', '=', 'RAW_MATERIAL')
      .executeTakeFirst();

    let heatNodeId = existingHeatNode?.id;
    if (!heatNodeId) {
      const inserted = await db
        .insertInto('batchTraceNodes')
        .values({
          batchNo: heatNo,
          stageName: 'RAW_MATERIAL',
          materialName: `${task.mat_name || '特钢线材'} (炉号: ${heatNo})`,
          operatorName: '质检科收料员',
          supplierOrCustomer: task.steel_mill || '特钢厂',
          nodeStatus: 'PASSED' as TraceNodeStatus,
          occurredAt,
          createdAt: new Date(),
        })
        .returning('id')
        .executeTakeFirst();
      heatNodeId = inserted?.id;
      nodeCount++;
    }

    // 2. 车间生产工单批次节点
    const existingTaskNode = await db
      .selectFrom('batchTraceNodes')
      .select('id')
      .where('batchNo', '=', taskOrderNo)
      .where('stageName', '=', 'PRODUCTION')
      .executeTakeFirst();

    let taskNodeId = existingTaskNode?.id;
    if (!taskNodeId) {
      const inserted = await db
        .insertInto('batchTraceNodes')
        .values({
          batchNo: taskOrderNo,
          stageName: 'PRODUCTION',
          orderNo: taskOrderNo,
          materialName: task.mat_name || '紧固件半成品',
          operatorName: '车间班组长',
          supplierOrCustomer: '乐天智能车间',
          nodeStatus: 'PASSED' as TraceNodeStatus,
          occurredAt,
          createdAt: new Date(),
        })
        .returning('id')
        .executeTakeFirst();
      taskNodeId = inserted?.id;
      nodeCount++;
    }

    // 3. 上下游血缘关系关联：RAW_MATERIAL -> PRODUCTION
    if (heatNo && taskOrderNo) {
      const existingRel = await db
        .selectFrom('batchTraceRelations')
        .selectAll()
        .where('parentBatch', '=', heatNo)
        .where('childBatch', '=', taskOrderNo)
        .executeTakeFirst();

      if (!existingRel) {
        const relationType: TraceRelationType = 'RAW_TO_PROCESS';
        await db
          .insertInto('batchTraceRelations')
          .values({
            parentBatch: heatNo,
            childBatch: taskOrderNo,
            relationType,
            qty: parseFloat(String(task.production_num || 0)),
            operator: '车间操作员',
            operationTime: occurredAt,
          })
          .execute();
        relationCount++;
      }
    }
  }

  return { syncedNodes: nodeCount, syncedRelations: relationCount };
}

/**
 * 4. 统筹执行全部 MES 数据同步管道
 */
export async function syncMesAll(
  customDb?: Kysely<Database>,
  options: { limit?: number } = {}
): Promise<MesSyncResult> {
  assertSafeMesDatabase();
  const db = customDb || defaultDb;
  const start = Date.now();
  const limit = options.limit || 200;
  const details: string[] = [];

  try {
    // 1. 同步工序 -> workshops
    const workshopResult = await syncMesWorkshops(db);
    details.push(`工序字典同步: 盘点 ${workshopResult.total} 项，新增入库 ${workshopResult.inserted} 项`);

    // 2. 同步检验报告 -> inspectionOrders
    const inspectionResult = await syncMesInspectionOrders(db, limit);
    details.push(`检验单据同步: 读取 ${inspectionResult.total} 份，新增同步 ${inspectionResult.inserted} 份`);

    // 3. 同步炉批号与工单 -> 批次追溯图谱
    const traceResult = await syncMesBatchTrace(db, limit);
    details.push(`炉批号追溯同步: 生成追溯节点 ${traceResult.syncedNodes} 个，构筑血缘关系 ${traceResult.syncedRelations} 条`);

    return {
      success: true,
      targetDatabase: STRICT_MES_TARGET_DB,
      durationMs: Date.now() - start,
      syncedWorkshops: workshopResult.inserted,
      syncedInspectionOrders: inspectionResult.inserted,
      syncedTraceNodes: traceResult.syncedNodes,
      syncedTraceRelations: traceResult.syncedRelations,
      details,
    };
  } catch (err: any) {
    details.push(`同步中断异常: ${err?.message || String(err)}`);
    return {
      success: false,
      targetDatabase: STRICT_MES_TARGET_DB,
      durationMs: Date.now() - start,
      syncedWorkshops: 0,
      syncedInspectionOrders: 0,
      syncedTraceNodes: 0,
      syncedTraceRelations: 0,
      details,
    };
  }
}