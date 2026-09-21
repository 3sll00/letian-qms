import { Kysely } from 'kysely';
import type { Database } from '../database/schema.js';
import type { InspectionType, TraceNodeStatus, TraceRelationType } from '@letian/contracts';
import { db as defaultDb } from '../database/connection.js';
import { queryMes, assertSafeMesDatabase, STRICT_MES_TARGET_DB } from './mes-pool.js';

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
  limit: number = 200
): Promise<{ total: number; inserted: number }> {
  assertSafeMesDatabase();
  const db = customDb || defaultDb;

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

  const reports = await queryMes<MesCheckReportRow>(sql, [limit]);
  if (!reports || reports.length === 0) {
    return { total: 0, inserted: 0 };
  }

  // 查出默认或任意有效的检验方案 ID 与版本
  const defaultPlan = await db.selectFrom('inspectionPlans').select(['id', 'version']).executeTakeFirst();
  const planId = defaultPlan?.id || '00000000-0000-0000-0000-000000000001';
  const planVersionId = defaultPlan ? `${defaultPlan.id}-v${defaultPlan.version}` : 'v1.0';

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
    if (procName.includes('冷镦')) {
      orderType = 'IPQC_CT';
    } else if (procName.includes('搓丝') || procName.includes('滚丝')) {
      orderType = 'IPQC_RL';
    } else if (procName.includes('检测入库') || procName.includes('入库') || procName.includes('力学检验')) {
      orderType = 'IPQC_FN';
    }

    const checkDate = rep.check_date ? new Date(rep.check_date) : (rep.bill_date ? new Date(rep.bill_date) : new Date());

    const sampleItems = [
      {
        seq: 1,
        itemCode: 'MES-QC-01',
        itemName: `${procName}质检项目`,
        standardValue: '图纸公差与工艺规程',
        measuredValue: isQualified ? '合格' : '不合格',
        result: isQualified ? 'PASSED' : 'FAILED',
        remarks: rep.remarks || undefined,
      },
    ];

    const planSnapshot = {
      planId,
      version: 1,
      name: `MES现场质检标准-${procName}`,
      items: sampleItems,
    };

    await db
      .insertInto('inspectionOrders')
      .values({
        orderNo: rep.bill_no,
        orderType,
        planId,
        planVersionId,
        planSnapshot: JSON.stringify(planSnapshot) as any,
        batchNo: rep.task_bill_no || rep.heat_number || rep.bill_no,
        materialCode: rep.materiel_code || 'MAT-MES-DEFAULT',
        materialName: rep.materiel_name || 'MES紧固件产品',
        workshopCode: procName,
        inspectorId: rep.inspector_name || 'MES检验员',
        inspectorName: rep.inspector_name || 'MES检验员',
        totalQty,
        sampleQty: totalQty,
        passQty,
        failQty,
        status: isQualified ? 'PASSED' : 'FAILED',
        judgment: isQualified ? 'PASSED' : 'FAILED',
        items: JSON.stringify(sampleItems) as any,
        isMandatoryGate: procName.includes('检测入库') || procName.includes('力学检验'),
        inspectionNotes: `[MES实绩同步] 生产工单:${rep.task_bill_no || '-'} 熔炼炉号:${rep.heat_number || '-'} 钢厂:${rep.steel_mill || '-'} 工序:${procName}`,
        workOrderNo: rep.task_bill_no || undefined,
        blankingLength: rep.cutting_length ? parseFloat(String(rep.cutting_length)) : undefined,
        processStep: procName,
        threadSpec: rep.materiel_spec || undefined,
        completedAt: checkDate,
        createdAt: checkDate,
        updatedAt: checkDate,
      })
      .execute();

    existingOrderNos.add(rep.bill_no);
    insertedCount++;
  }

  return { total: reports.length, inserted: insertedCount };
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