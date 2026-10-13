/**
 * MES 生产/质量数据读取层（读侧，单向只读）—— MES（MySQL，`mes_letian_test`）。
 *
 * 与 `erp-reads.ts`（管家婆 ERP 主数据/订单）互补：本文件面向 QMS 需要的
 * 「核心标识与追溯 / 过程执行证据 / 检验与测试结果」三大类取数，
 * 全部走 `queryMesReadOnly` 只读守门（见 `mes-readonly.ts`，写语句直接抛错，fail-closed）。
 *
 * 表结构依据：2026-10 对 `mes_letian_test` 库 information_schema 实连核对（113 张表）。
 *
 * ── 需求项 → MES 表 映射（已实连核对）────────────────────────────────────
 * 核心标识与追溯
 *   工单号                 → t_production_task（bill_no 生产任务单号 / work_no 工作令号 / erp_bill_no 上游 ERP 单号） ✅
 *   批次                   → t_production_task.batch_no + heat_number(炉号)/steel_mill(钢厂)                        ✅
 *   序列号                 → t_pro_task_serial_number(+_body 关联到工序)                                            ✅（当前库空表，结构在）
 *   操作序号（工序）       → t_production_task_body.no（工序号）+ procedure_id → t_procedure                        ✅
 *   部件谱系（父子关系）   → t_production_task.parent_task_id（任务级谱系）+ t_task_trace（追溯日志，空表）           ⚠️ 任务级谱系有，件级 BOM 谱系无
 * 过程执行证据
 *   操作员 ID              → t_task_report.operator_id（+ t_task_report_auxiliary_operator 辅助工）                  ✅
 *   设备/工装 ID           → t_task_report.equipment_id / station_id → t_equipment / t_station                       ✅（设备台账当前空表）
 *   校准状态               → MES 无直接字段；t_iot_equipment_check_standard(点检标准)等 IOT 表全空                   ❌ 不存在
 *   关键工艺参数           → t_check_report_parameter.parameter_value（实测）+ t_procedure_parameter /                ✅
 *                            t_process_route_body_parameter / t_quality_control_parameter（标准+上下限）
 *   返工/返修记录          → t_task_report.rework_num（返工数）+ t_handle_task_report（处理单：handle_type/责任/费用） ✅
 *   操作开始/结束/暂停时间戳 → t_task_report.create_time/finished_date + t_production_task_body.plan_begin/plan_end
 *                            + finished_date + t_task_pause_resume（暂停/恢复单）                                    ✅
 * 检验与测试结果
 *   过程检验（IPQC）       → t_check_report（检验单：送检数/合格数/不合格数/判定）                                   ✅
 *   测量值                 → t_check_report_parameter（parameter_value + determine 判定）                            ✅（当前空表）
 *   抽样计划/检验标准      → t_quality_control（控制计划：frequency 频次/version）+ t_quality_control_parameter       ✅
 *   检验设备               → 检验单无设备字段                                                                        ❌ 不存在
 * ───────────────────────────────────────────────────────────────────────────────
 */
import type { Pool as MySqlPool } from 'mysql2/promise';
import { queryMesReadOnly, type MesQueryParam, type MesQueryRunner } from './mes-readonly.js';

/* ----------------------------- 行类型定义 ----------------------------- */

/** 生产任务单（t_production_task） */
export interface MesProductionTaskRow {
  id: string;
  billNo: string | null;
  workNo: string | null;
  billDate: string | null;
  materielId: string | null;
  batchNo: string | null;
  heatNumber: string | null;
  steelMill: string | null;
  productionNum: number | null;
  productionType: string | null;
  planBeginDate: string | null;
  planEndDate: string | null;
  deliveryDate: string | null;
  finishedDate: string | null;
  routeId: string | null;
  routeCode: string | null;
  routeName: string | null;
  parentTaskId: string | null;
  planId: string | null;
  planBodyId: string | null;
  erpBillNo: string | null;
  erpBillHeadId: string | null;
  erpBillBodyId: string | null;
  isSerialNumberManage: string | null;
  qualityControlId: string | null;
  status: string | null;
  billStatus: string | null;
  materialCode: string | null;
  customerId: string | null;
}

/** 任务工序行（t_production_task_body）—— 工单的操作序号明细 */
export interface MesTaskStepRow {
  id: string;
  taskId: string;
  no: number | null;
  procedureId: string | null;
  standardWorkTime: number | null;
  prepareWorkTime: number | null;
  technologyRequire: string | null;
  operatorId: string | null;
  lastReportNum: number | null;
  thisReportNum: number | null;
  lastQualifiedNum: number | null;
  thisQualifiedNum: number | null;
  finishedStatus: string | null;
  finishedDate: string | null;
  planBeginDate: string | null;
  planEndDate: string | null;
  isCheck: string | null;
  checkType: string | null;
  checkMethod: string | null;
}

/** 生产汇报记录（t_task_report）—— 过程执行证据 */
export interface MesTaskReportRow {
  id: string;
  billNo: string | null;
  billDate: string | null;
  taskId: string | null;
  taskBodyId: string | null;
  procedureId: string | null;
  operatorId: string | null;
  teamId: string | null;
  equipmentId: string | null;
  stationId: string | null;
  serialNumberId: string | null;
  finishedNum: number | null;
  qualifiedNum: number | null;
  unqualifiedNum: number | null;
  scrapNum: number | null;
  reworkNum: number | null;
  industrialWasteNum: number | null;
  materialWasteNum: number | null;
  concessionReceptionNum: number | null;
  unqualifiedReason: string | null;
  finishedDate: string | null;
  createTime: string | null;
  billStatus: string | null;
}

/** 过程检验单（t_check_report）—— IPQC 判定证据 */
export interface MesCheckReportRow {
  id: string;
  billNo: string | null;
  billDate: string | null;
  taskId: string | null;
  taskBodyId: string | null;
  materielId: string | null;
  procedureId: string | null;
  checkQty: number | null;
  qualifiedQty: number | null;
  unqualifiedQty: number | null;
  isQualified: string | null;
  checkUserName: string | null;
  checkDate: string | null;
  remarks: string | null;
  billStatus: string | null;
  createTime: string | null;
}

/** 检验实测参数（t_check_report_parameter）—— 测量值与判定 */
export interface MesCheckParameterRow {
  id: string;
  reportId: string | null;
  parameterId: string | null;
  parameterValue: string | null;
  determine: string | null;
  controlId: string | null;
  controlParameterId: string | null;
  createTime: string | null;
}

/** 返工/返修处理单（t_handle_task_report） */
export interface MesReworkHandleRow {
  id: string;
  billNo: string | null;
  billDate: string | null;
  taskReportId: string | null;
  handleType: string | null;
  qty: number | null;
  usedQty: number | null;
  isUsed: string | null;
  dutyTaskId: string | null;
  dutyTaskBodyId: string | null;
  dutyProcedureId: string | null;
  dutyOperatorId: string | null;
  dutyOperatorRealname: string | null;
  dutySupplierId: string | null;
  dutySupplierRealname: string | null;
  cost: number | null;
  handleUserName: string | null;
  handleDate: string | null;
  finishedDate: string | null;
  billStatus: string | null;
}

/** 暂停/恢复单（t_task_pause_resume）—— 操作暂停时间戳 */
export interface MesPauseResumeRow {
  id: string;
  billNo: string | null;
  billDate: string | null;
  taskId: string | null;
  materielId: string | null;
  type: string | null;
  finishedDate: string | null;
  billUserName: string | null;
  billStatus: string | null;
}

/** 序列号（t_pro_task_serial_number + _body） */
export interface MesSerialNumberRow {
  id: string;
  taskId: string | null;
  materielId: string | null;
  serialNumber: string | null;
  bodies: { taskBodyId: string; procedureId: string }[];
}

/** 任务追溯日志（t_task_trace）—— 件级谱系/追溯备注 */
export interface MesTaskTraceRow {
  id: string;
  taskId: string | null;
  taskBodyId: string | null;
  synopsis: string | null;
  content: string | null;
  createTime: string | null;
}

/** 控制计划（t_quality_control）—— 抽样计划/检验标准 */
export interface MesQualityControlRow {
  id: string;
  code: string | null;
  version: string | null;
  frequency: string | null;
  materielId: string | null;
  procedureId: string | null;
  routeId: string | null;
  routeBodyId: string | null;
}

/** 控制计划参数（t_quality_control_parameter）—— 标准/上下限 */
export interface MesQualityControlParameterRow {
  id: string;
  controlId: string | null;
  parameterName: string | null;
  standardValue: string | null;
  parameterType: string | null;
  upperLimit: number | null;
  lowerLimit: number | null;
  judge: string | null;
  checkType: string | null;
  checkTypeText: string | null;
}

/** 工序参数标准（t_procedure_parameter）—— 关键工艺参数的标准值/上下限 */
export interface MesProcedureParameterRow {
  id: string;
  procedureId: string | null;
  parameterName: string | null;
  standardValue: string | null;
  parameterType: string | null;
  upperLimit: number | null;
  lowerLimit: number | null;
  judge: string | null;
  checkType: string | null;
  checkTypeText: string | null;
}

/** 设备台账（t_equipment） */
export interface MesEquipmentRow {
  id: string;
  code: string | null;
  name: string | null;
  spec: string | null;
  type: string | null;
  useStatus: string | null;
  purpose: string | null;
  maintenancePeriod: string | null;
  maintenanceCycle: string | null;
  newMaintainDate: string | null;
  manufacturer: string | null;
  position: string | null;
}

/** 工单任务级谱系父子对（由 t_production_task.parent_task_id 投影） */
export interface MesTaskGenealogyRow {
  taskId: string;
  taskBillNo: string | null;
  parentTaskId: string | null;
  parentBillNo: string | null;
}

/* ----------------------------- 取数接口 ----------------------------- */

export interface MesReads {
  readonly name: string;
  readonly kind: 'mysql' | 'fixture';
  /** 生产任务单（工单号/批次/炉号/上游 ERP 单号/任务谱系 parent_task_id） */
  fetchProductionTasks(limit: number): Promise<MesProductionTaskRow[]>;
  /** 任务工序明细（操作序号） */
  fetchTaskSteps(limit: number): Promise<MesTaskStepRow[]>;
  /** 生产汇报记录（操作员/设备/返工数/时间戳） */
  fetchTaskReports(limit: number): Promise<MesTaskReportRow[]>;
  /** 过程检验单（IPQC 判定证据） */
  fetchProcessInspections(limit: number): Promise<MesCheckReportRow[]>;
  /** 检验实测参数（测量值/判定） */
  fetchCheckParameters(limit: number): Promise<MesCheckParameterRow[]>;
  /** 返工/返修处理单 */
  fetchReworkHandles(limit: number): Promise<MesReworkHandleRow[]>;
  /** 暂停/恢复单（操作暂停时间戳） */
  fetchPauseResume(limit: number): Promise<MesPauseResumeRow[]>;
  /** 序列号（含与工序的关联） */
  fetchSerialNumbers(limit: number): Promise<MesSerialNumberRow[]>;
  /** 任务追溯日志 */
  fetchTaskTrace(limit: number): Promise<MesTaskTraceRow[]>;
  /** 控制计划（抽样计划/检验标准头） */
  fetchQualityControls(limit: number): Promise<MesQualityControlRow[]>;
  /** 控制计划参数（标准/上下限） */
  fetchQualityControlParameters(limit: number): Promise<MesQualityControlParameterRow[]>;
  /** 工序参数标准（关键工艺参数标准值/上下限） */
  fetchProcedureParameters(limit: number): Promise<MesProcedureParameterRow[]>;
  /** 设备台账 */
  fetchEquipments(limit: number): Promise<MesEquipmentRow[]>;
  /** 工单任务级谱系（父子对，含双方单号） */
  fetchTaskGenealogy(limit: number): Promise<MesTaskGenealogyRow[]>;
}

/* ----------------------------- SQL 常量（全部只读 SELECT） ----------------------------- */

/** MES 通用过滤：del_flag（0=未删除，MySQL 侧为 int） */
const ALIVE = 'del_flag = 0';

export const PRODUCTION_TASK_SELECT_SQL = [
  'SELECT id, bill_no, work_no, bill_date, materiel_id, batch_no, heat_number, steel_mill,',
  '       production_num, production_type, plan_begin_date, plan_end_date, delivery_date, finished_date,',
  '       route_id, route_code, route_name, NULLIF(parent_task_id, \'\') AS parent_task_id,',
  '       plan_id, plan_body_id, erp_bill_no, erp_bill_head_id, erp_bill_body_id,',
  '       is_serial_number_manage, quality_control_id, status, bill_status, material_code, customer_id',
  '  FROM t_production_task',
  ` WHERE ${ALIVE}`,
  ' ORDER BY create_time DESC',
  ' LIMIT ?',
].join('\n');

export const TASK_STEP_SELECT_SQL = [
  'SELECT b.id, b.task_id, b.no, b.procedure_id, b.standard_work_time, b.prepare_work_time,',
  '       b.technology_require, b.operator_id, b.last_report_num, b.this_report_num,',
  '       b.last_qualified_num, b.this_qualified_num, b.finished_status, b.finished_date,',
  '       b.plan_begin_date, b.plan_end_date, b.is_check, b.check_type, b.check_method',
  '  FROM t_production_task_body b',
  '  INNER JOIN t_production_task t ON t.id = b.task_id AND t.del_flag = 0',
  ` WHERE b.${ALIVE}`,
  ' ORDER BY b.task_id, b.no',
  ' LIMIT ?',
].join('\n');

export const TASK_REPORT_SELECT_SQL = [
  'SELECT id, bill_no, bill_date, task_id, task_body_id, procedure_id, operator_id, team_id,',
  '       equipment_id, station_id, serial_number_id, finished_num, qualified_num, unqualified_num,',
  '       scrap_num, rework_num, industrial_waste_num, material_waste_num, concession_reception_num,',
  '       unqualified_reason, finished_date, create_time, bill_status',
  '  FROM t_task_report',
  ` WHERE ${ALIVE}`,
  ' ORDER BY create_time DESC',
  ' LIMIT ?',
].join('\n');

export const CHECK_REPORT_SELECT_SQL = [
  'SELECT id, bill_no, bill_date, task_id, task_body_id, materiel_id, procedure_id,',
  '       check_qty, qualified_qty, unqualified_qty, is_qualified, check_user_name, check_date,',
  '       remarks, bill_status, create_time',
  '  FROM t_check_report',
  ` WHERE ${ALIVE}`,
  ' ORDER BY create_time DESC',
  ' LIMIT ?',
].join('\n');

export const CHECK_PARAMETER_SELECT_SQL = [
  'SELECT id, report_id, parameter_id, parameter_value, determine, control_id, control_parameter_id, create_time',
  '  FROM t_check_report_parameter',
  ` WHERE ${ALIVE}`,
  ' ORDER BY create_time DESC',
  ' LIMIT ?',
].join('\n');

export const REWORK_HANDLE_SELECT_SQL = [
  'SELECT id, bill_no, bill_date, task_report_id, handle_type, qty, used_qty, is_used,',
  '       duty_task_id, duty_task_body_id, duty_procedure_id, duty_operator_id, duty_operator_realname,',
  '       duty_supplier_id, duty_supplier_realname, cost, handle_user_name, handle_date, finished_date, bill_status',
  '  FROM t_handle_task_report',
  ` WHERE ${ALIVE}`,
  ' ORDER BY create_time DESC',
  ' LIMIT ?',
].join('\n');

export const PAUSE_RESUME_SELECT_SQL = [
  'SELECT id, bill_no, bill_date, task_id, materiel_id, type, finished_date, bill_user_name, bill_status',
  '  FROM t_task_pause_resume',
  ` WHERE ${ALIVE}`,
  ' ORDER BY bill_date DESC',
  ' LIMIT ?',
].join('\n');

export const SERIAL_NUMBER_SELECT_SQL = [
  'SELECT id, task_id, materiel_id, serial_number',
  '  FROM t_pro_task_serial_number',
  ` WHERE ${ALIVE}`,
  ' ORDER BY create_time DESC',
  ' LIMIT ?',
].join('\n');

export const SERIAL_NUMBER_BODY_SELECT_SQL = [
  'SELECT id, task_body_id, procedure_id, serial_number_id',
  '  FROM t_pro_task_serial_number_body',
  ` WHERE ${ALIVE}`,
  ' LIMIT ?',
].join('\n');

export const TASK_TRACE_SELECT_SQL = [
  'SELECT id, task_id, task_body_id, synopsis, content, create_time',
  '  FROM t_task_trace',
  ` WHERE ${ALIVE}`,
  ' ORDER BY create_time DESC',
  ' LIMIT ?',
].join('\n');

export const QUALITY_CONTROL_SELECT_SQL = [
  'SELECT id, code, version, frequency, materiel_id, procedure_id, route_id, route_body_id',
  '  FROM t_quality_control',
  ` WHERE ${ALIVE}`,
  ' ORDER BY create_time DESC',
  ' LIMIT ?',
].join('\n');

export const QUALITY_CONTROL_PARAMETER_SELECT_SQL = [
  'SELECT id, control_id, parameter_name, standard_value, parameter_type, upper_limit, lower_limit,',
  '       judge, check_type, check_type_text',
  '  FROM t_quality_control_parameter',
  ` WHERE ${ALIVE}`,
  ' LIMIT ?',
].join('\n');

export const PROCEDURE_PARAMETER_SELECT_SQL = [
  'SELECT id, procedure_id, parameter_name, standard_value, parameter_type, upper_limit, lower_limit,',
  '       judge, check_type, check_type_text',
  '  FROM t_procedure_parameter',
  ` WHERE ${ALIVE}`,
  ' LIMIT ?',
].join('\n');

export const EQUIPMENT_SELECT_SQL = [
  'SELECT id, code, name, spec, type, use_status, purpose, maintenance_period, maintenance_cycle,',
  '       new_maintain_date, manufacturer, position',
  '  FROM t_equipment',
  ` WHERE ${ALIVE}`,
  ' ORDER BY create_time DESC',
  ' LIMIT ?',
].join('\n');

/** 任务谱系：子任务 parent_task_id → 父任务单号（自连接，只取有父的任务） */
export const TASK_GENEALOGY_SELECT_SQL = [
  'SELECT c.id AS task_id, c.bill_no AS task_bill_no,',
  '       NULLIF(c.parent_task_id, \'\') AS parent_task_id, p.bill_no AS parent_bill_no',
  '  FROM t_production_task c',
  '  LEFT JOIN t_production_task p ON p.id = c.parent_task_id',
  ` WHERE c.${ALIVE} AND c.parent_task_id IS NOT NULL AND c.parent_task_id <> ''`,
  ' ORDER BY c.create_time DESC',
  ' LIMIT ?',
].join('\n');

/* ----------------------------- 工具函数 ----------------------------- */

export function normalizeLimit(limit: number | undefined): number {
  const value = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : 500;
  return Math.min(Math.max(value, 1), 50000);
}

const asText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

const asNum = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

const asIso = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return asText(value);
};

function toRunner(pool: MySqlPool): MesQueryRunner {
  return {
    async query(sqlText, params = []) {
      const [rows] = await pool.query(sqlText, [...params]);
      return { rows: rows as unknown[] };
    },
  };
}

/* ----------------------------- mysql2 真源实现 ----------------------------- */

export function createMysqlMesReads(pool: MySqlPool): MesReads {
  const runner = toRunner(pool);
  const select = <T>(sql: string, params: readonly MesQueryParam[] = []): Promise<T[]> =>
    queryMesReadOnly<T>(runner, sql, params);

  return {
    name: 'mes-letian-reads(mysql)',
    kind: 'mysql',

    async fetchProductionTasks(limit) {
      const rows = await select<Record<string, unknown>>(PRODUCTION_TASK_SELECT_SQL, [
        normalizeLimit(limit),
      ]);
      return rows.map((r) => ({
        id: String(r.id ?? ''),
        billNo: asText(r.bill_no),
        workNo: asText(r.work_no),
        billDate: asIso(r.bill_date),
        materielId: asText(r.materiel_id),
        batchNo: asText(r.batch_no),
        heatNumber: asText(r.heat_number),
        steelMill: asText(r.steel_mill),
        productionNum: asNum(r.production_num),
        productionType: asText(r.production_type),
        planBeginDate: asIso(r.plan_begin_date),
        planEndDate: asIso(r.plan_end_date),
        deliveryDate: asIso(r.delivery_date),
        finishedDate: asIso(r.finished_date),
        routeId: asText(r.route_id),
        routeCode: asText(r.route_code),
        routeName: asText(r.route_name),
        parentTaskId: asText(r.parent_task_id),
        planId: asText(r.plan_id),
        planBodyId: asText(r.plan_body_id),
        erpBillNo: asText(r.erp_bill_no),
        erpBillHeadId: asText(r.erp_bill_head_id),
        erpBillBodyId: asText(r.erp_bill_body_id),
        isSerialNumberManage: asText(r.is_serial_number_manage),
        qualityControlId: asText(r.quality_control_id),
        status: asText(r.status),
        billStatus: asText(r.bill_status),
        materialCode: asText(r.material_code),
        customerId: asText(r.customer_id),
      }));
    },

    async fetchTaskSteps(limit) {
      const rows = await select<Record<string, unknown>>(TASK_STEP_SELECT_SQL, [
        normalizeLimit(limit),
      ]);
      return rows.map((r) => ({
        id: String(r.id ?? ''),
        taskId: String(r.task_id ?? ''),
        no: asNum(r.no),
        procedureId: asText(r.procedure_id),
        standardWorkTime: asNum(r.standard_work_time),
        prepareWorkTime: asNum(r.prepare_work_time),
        technologyRequire: asText(r.technology_require),
        operatorId: asText(r.operator_id),
        lastReportNum: asNum(r.last_report_num),
        thisReportNum: asNum(r.this_report_num),
        lastQualifiedNum: asNum(r.last_qualified_num),
        thisQualifiedNum: asNum(r.this_qualified_num),
        finishedStatus: asText(r.finished_status),
        finishedDate: asIso(r.finished_date),
        planBeginDate: asIso(r.plan_begin_date),
        planEndDate: asIso(r.plan_end_date),
        isCheck: asText(r.is_check),
        checkType: asText(r.check_type),
        checkMethod: asText(r.check_method),
      }));
    },

    async fetchTaskReports(limit) {
      const rows = await select<Record<string, unknown>>(TASK_REPORT_SELECT_SQL, [
        normalizeLimit(limit),
      ]);
      return rows.map((r) => ({
        id: String(r.id ?? ''),
        billNo: asText(r.bill_no),
        billDate: asIso(r.bill_date),
        taskId: asText(r.task_id),
        taskBodyId: asText(r.task_body_id),
        procedureId: asText(r.procedure_id),
        operatorId: asText(r.operator_id),
        teamId: asText(r.team_id),
        equipmentId: asText(r.equipment_id),
        stationId: asText(r.station_id),
        serialNumberId: asText(r.serial_number_id),
        finishedNum: asNum(r.finished_num),
        qualifiedNum: asNum(r.qualified_num),
        unqualifiedNum: asNum(r.unqualified_num),
        scrapNum: asNum(r.scrap_num),
        reworkNum: asNum(r.rework_num),
        industrialWasteNum: asNum(r.industrial_waste_num),
        materialWasteNum: asNum(r.material_waste_num),
        concessionReceptionNum: asNum(r.concession_reception_num),
        unqualifiedReason: asText(r.unqualified_reason),
        finishedDate: asIso(r.finished_date),
        createTime: asIso(r.create_time),
        billStatus: asText(r.bill_status),
      }));
    },

    async fetchProcessInspections(limit) {
      const rows = await select<Record<string, unknown>>(CHECK_REPORT_SELECT_SQL, [
        normalizeLimit(limit),
      ]);
      return rows.map((r) => ({
        id: String(r.id ?? ''),
        billNo: asText(r.bill_no),
        billDate: asIso(r.bill_date),
        taskId: asText(r.task_id),
        taskBodyId: asText(r.task_body_id),
        materielId: asText(r.materiel_id),
        procedureId: asText(r.procedure_id),
        checkQty: asNum(r.check_qty),
        qualifiedQty: asNum(r.qualified_qty),
        unqualifiedQty: asNum(r.unqualified_qty),
        isQualified: asText(r.is_qualified),
        checkUserName: asText(r.check_user_name),
        checkDate: asIso(r.check_date),
        remarks: asText(r.remarks),
        billStatus: asText(r.bill_status),
        createTime: asIso(r.create_time),
      }));
    },

    async fetchCheckParameters(limit) {
      const rows = await select<Record<string, unknown>>(CHECK_PARAMETER_SELECT_SQL, [
        normalizeLimit(limit),
      ]);
      return rows.map((r) => ({
        id: String(r.id ?? ''),
        reportId: asText(r.report_id),
        parameterId: asText(r.parameter_id),
        parameterValue: asText(r.parameter_value),
        determine: asText(r.determine),
        controlId: asText(r.control_id),
        controlParameterId: asText(r.control_parameter_id),
        createTime: asIso(r.create_time),
      }));
    },

    async fetchReworkHandles(limit) {
      const rows = await select<Record<string, unknown>>(REWORK_HANDLE_SELECT_SQL, [
        normalizeLimit(limit),
      ]);
      return rows.map((r) => ({
        id: String(r.id ?? ''),
        billNo: asText(r.bill_no),
        billDate: asIso(r.bill_date),
        taskReportId: asText(r.task_report_id),
        handleType: asText(r.handle_type),
        qty: asNum(r.qty),
        usedQty: asNum(r.used_qty),
        isUsed: asText(r.is_used),
        dutyTaskId: asText(r.duty_task_id),
        dutyTaskBodyId: asText(r.duty_task_body_id),
        dutyProcedureId: asText(r.duty_procedure_id),
        dutyOperatorId: asText(r.duty_operator_id),
        dutyOperatorRealname: asText(r.duty_operator_realname),
        dutySupplierId: asText(r.duty_supplier_id),
        dutySupplierRealname: asText(r.duty_supplier_realname),
        cost: asNum(r.cost),
        handleUserName: asText(r.handle_user_name),
        handleDate: asIso(r.handle_date),
        finishedDate: asIso(r.finished_date),
        billStatus: asText(r.bill_status),
      }));
    },

    async fetchPauseResume(limit) {
      const rows = await select<Record<string, unknown>>(PAUSE_RESUME_SELECT_SQL, [
        normalizeLimit(limit),
      ]);
      return rows.map((r) => ({
        id: String(r.id ?? ''),
        billNo: asText(r.bill_no),
        billDate: asIso(r.bill_date),
        taskId: asText(r.task_id),
        materielId: asText(r.materiel_id),
        type: asText(r.type),
        finishedDate: asIso(r.finished_date),
        billUserName: asText(r.bill_user_name),
        billStatus: asText(r.bill_status),
      }));
    },

    async fetchSerialNumbers(limit) {
      const heads = await select<Record<string, unknown>>(SERIAL_NUMBER_SELECT_SQL, [
        normalizeLimit(limit),
      ]);
      const headIds = heads.map((r) => String(r.id ?? '')).filter((id) => id !== '');
      const bodiesByHead = new Map<string, { taskBodyId: string; procedureId: string }[]>();
      if (headIds.length > 0) {
        const bodyRows = await select<Record<string, unknown>>(
          SERIAL_NUMBER_BODY_SELECT_SQL.replace('LIMIT ?', `LIMIT ${headIds.length * 100}`),
        );
        const idSet = new Set(headIds);
        for (const b of bodyRows) {
          const headId = String(b.serial_number_id ?? '');
          if (!idSet.has(headId)) continue;
          const list = bodiesByHead.get(headId) ?? [];
          list.push({ taskBodyId: String(b.task_body_id ?? ''), procedureId: String(b.procedure_id ?? '') });
          bodiesByHead.set(headId, list);
        }
      }
      return heads.map((r) => ({
        id: String(r.id ?? ''),
        taskId: asText(r.task_id),
        materielId: asText(r.materiel_id),
        serialNumber: asText(r.serial_number),
        bodies: bodiesByHead.get(String(r.id ?? '')) ?? [],
      }));
    },

    async fetchTaskTrace(limit) {
      const rows = await select<Record<string, unknown>>(TASK_TRACE_SELECT_SQL, [
        normalizeLimit(limit),
      ]);
      return rows.map((r) => ({
        id: String(r.id ?? ''),
        taskId: asText(r.task_id),
        taskBodyId: asText(r.task_body_id),
        synopsis: asText(r.synopsis),
        content: asText(r.content),
        createTime: asIso(r.create_time),
      }));
    },

    async fetchQualityControls(limit) {
      const rows = await select<Record<string, unknown>>(QUALITY_CONTROL_SELECT_SQL, [
        normalizeLimit(limit),
      ]);
      return rows.map((r) => ({
        id: String(r.id ?? ''),
        code: asText(r.code),
        version: asText(r.version),
        frequency: asText(r.frequency),
        materielId: asText(r.materiel_id),
        procedureId: asText(r.procedure_id),
        routeId: asText(r.route_id),
        routeBodyId: asText(r.route_body_id),
      }));
    },

    async fetchQualityControlParameters(limit) {
      const rows = await select<Record<string, unknown>>(QUALITY_CONTROL_PARAMETER_SELECT_SQL, [
        normalizeLimit(limit),
      ]);
      return rows.map((r) => ({
        id: String(r.id ?? ''),
        controlId: asText(r.control_id),
        parameterName: asText(r.parameter_name),
        standardValue: asText(r.standard_value),
        parameterType: asText(r.parameter_type),
        upperLimit: asNum(r.upper_limit),
        lowerLimit: asNum(r.lower_limit),
        judge: asText(r.judge),
        checkType: asText(r.check_type),
        checkTypeText: asText(r.check_type_text),
      }));
    },

    async fetchProcedureParameters(limit) {
      const rows = await select<Record<string, unknown>>(PROCEDURE_PARAMETER_SELECT_SQL, [
        normalizeLimit(limit),
      ]);
      return rows.map((r) => ({
        id: String(r.id ?? ''),
        procedureId: asText(r.procedure_id),
        parameterName: asText(r.parameter_name),
        standardValue: asText(r.standard_value),
        parameterType: asText(r.parameter_type),
        upperLimit: asNum(r.upper_limit),
        lowerLimit: asNum(r.lower_limit),
        judge: asText(r.judge),
        checkType: asText(r.check_type),
        checkTypeText: asText(r.check_type_text),
      }));
    },

    async fetchEquipments(limit) {
      const rows = await select<Record<string, unknown>>(EQUIPMENT_SELECT_SQL, [
        normalizeLimit(limit),
      ]);
      return rows.map((r) => ({
        id: String(r.id ?? ''),
        code: asText(r.code),
        name: asText(r.name),
        spec: asText(r.spec),
        type: asText(r.type),
        useStatus: asText(r.use_status),
        purpose: asText(r.purpose),
        maintenancePeriod: asText(r.maintenance_period),
        maintenanceCycle: asText(r.maintenance_cycle),
        newMaintainDate: asIso(r.new_maintain_date),
        manufacturer: asText(r.manufacturer),
        position: asText(r.position),
      }));
    },

    async fetchTaskGenealogy(limit) {
      const rows = await select<Record<string, unknown>>(TASK_GENEALOGY_SELECT_SQL, [
        normalizeLimit(limit),
      ]);
      return rows.map((r) => ({
        taskId: String(r.task_id ?? ''),
        taskBillNo: asText(r.task_bill_no),
        parentTaskId: asText(r.parent_task_id),
        parentBillNo: asText(r.parent_bill_no),
      }));
    },
  };
}

/* ----------------------------- 本地 fixture 源（无 MES 也能跑通验证） ----------------------------- */

export interface MesFixtureData {
  productionTasks?: MesProductionTaskRow[];
  taskSteps?: MesTaskStepRow[];
  taskReports?: MesTaskReportRow[];
  processInspections?: MesCheckReportRow[];
  checkParameters?: MesCheckParameterRow[];
  reworkHandles?: MesReworkHandleRow[];
  pauseResume?: MesPauseResumeRow[];
  serialNumbers?: MesSerialNumberRow[];
  taskTrace?: MesTaskTraceRow[];
  qualityControls?: MesQualityControlRow[];
  qualityControlParameters?: MesQualityControlParameterRow[];
  procedureParameters?: MesProcedureParameterRow[];
  equipments?: MesEquipmentRow[];
  taskGenealogy?: MesTaskGenealogyRow[];
}

export function createFixtureMesReads(data: MesFixtureData, name = 'fixture(本地样例)'): MesReads {
  const take = <T>(arr?: T[]): T[] => (arr ?? []).slice(0, normalizeLimit(undefined));
  return {
    name,
    kind: 'fixture',
    fetchProductionTasks: () => Promise.resolve(take(data.productionTasks)),
    fetchTaskSteps: () => Promise.resolve(take(data.taskSteps)),
    fetchTaskReports: () => Promise.resolve(take(data.taskReports)),
    fetchProcessInspections: () => Promise.resolve(take(data.processInspections)),
    fetchCheckParameters: () => Promise.resolve(take(data.checkParameters)),
    fetchReworkHandles: () => Promise.resolve(take(data.reworkHandles)),
    fetchPauseResume: () => Promise.resolve(take(data.pauseResume)),
    fetchSerialNumbers: () => Promise.resolve(take(data.serialNumbers)),
    fetchTaskTrace: () => Promise.resolve(take(data.taskTrace)),
    fetchQualityControls: () => Promise.resolve(take(data.qualityControls)),
    fetchQualityControlParameters: () => Promise.resolve(take(data.qualityControlParameters)),
    fetchProcedureParameters: () => Promise.resolve(take(data.procedureParameters)),
    fetchEquipments: () => Promise.resolve(take(data.equipments)),
    fetchTaskGenealogy: () => Promise.resolve(take(data.taskGenealogy)),
  };
}
