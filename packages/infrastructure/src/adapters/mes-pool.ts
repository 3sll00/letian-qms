import dotenv from 'dotenv';
dotenv.config();
import mysql, { type Pool, type PoolOptions } from 'mysql2/promise';

let pool: Pool | null = null;

export const STRICT_MES_TARGET_DB = 'mes_letian_test';

export function assertSafeMesDatabase(dbName?: string): void {
  const target = dbName || process.env.MES_DB_NAME || STRICT_MES_TARGET_DB;
  if (target !== STRICT_MES_TARGET_DB) {
    throw new Error(
      `[MES 安全拦截] 客户与系统规范强制限定仅允许操作数据库 '${STRICT_MES_TARGET_DB}'，检测到试图访问 '${target}'，操作已被阻断！`
    );
  }
}

export function getMesDbConfig(): PoolOptions | null {
  const host = process.env.MES_DB_HOST || '120.26.99.40';
  const portStr = process.env.MES_DB_PORT || '3306';
  const database = process.env.MES_DB_NAME || STRICT_MES_TARGET_DB;
  const user = process.env.MES_DB_USER || 'backup';
  const password = process.env.MES_DB_PASSWORD || 'WXjszl123456';

  // 严格限定安全库名
  assertSafeMesDatabase(database);

  if (!host || !user || !password) {
    return null;
  }

  return {
    host,
    port: parseInt(portStr, 10),
    database: STRICT_MES_TARGET_DB,
    user,
    password,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: 8000,
    timezone: '+08:00',
    charset: 'utf8mb4',
  };
}

export async function getMesConnectionPool(): Promise<Pool | null> {
  const cfg = getMesDbConfig();
  if (!cfg) {
    return null;
  }

  if (pool) {
    return pool;
  }

  try {
    pool = mysql.createPool(cfg);
    return pool;
  } catch (err) {
    console.error('[MesPool] 建立与 MES MySQL 连接池失败:', err);
    return null;
  }
}

export async function closeMesConnectionPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * 安全查询辅助方法，自动附带安全库名校验与异常捕获
 */
export async function queryMes<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  assertSafeMesDatabase();
  const p = await getMesConnectionPool();
  if (!p) {
    throw new Error('[MesPool] MES 数据库未配置或连接池初始化失败');
  }

  const [rows] = await p.query(sql, params);
  return rows as T[];
}

export interface MesPagedReadOptions {
  search?: string;
  page: number;
  pageSize: number;
}

export async function fetchMesProductionTasks(
  options: MesPagedReadOptions
): Promise<Record<string, unknown>[]> {
  const offset = (options.page - 1) * options.pageSize;
  let sql = `
    SELECT
      t.id, t.bill_no, t.heat_number, t.steel_mill, t.cutting_length, t.production_num, t.bill_date,
      m.code as materiel_code, m.name as materiel_name, m.spec as materiel_spec
    FROM t_production_task t
    LEFT JOIN t_materiel m ON t.materiel_id = m.id
  `;
  const params: unknown[] = [];
  if (options.search) {
    sql += ` WHERE t.bill_no LIKE ? OR t.heat_number LIKE ? OR m.code LIKE ? OR m.name LIKE ?`;
    const search = `%${options.search}%`;
    params.push(search, search, search, search);
  }
  sql += ` ORDER BY t.bill_date DESC LIMIT ? OFFSET ?`;
  params.push(options.pageSize, offset);
  return queryMes<Record<string, unknown>>(sql, params);
}

export async function fetchMesCheckReports(
  options: MesPagedReadOptions
): Promise<Record<string, unknown>[]> {
  const offset = (options.page - 1) * options.pageSize;
  let sql = `
    SELECT
      r.id, r.bill_no, r.bill_date, r.check_date,
      r.check_qty, r.qualified_qty, r.unqualified_qty, r.is_qualified, r.remarks,
      t.bill_no as task_bill_no, t.heat_number, t.steel_mill,
      m.code as materiel_code, m.name as materiel_name,
      p.name as procedure_name,
      u.realname as inspector_name
    FROM t_check_report r
    LEFT JOIN t_production_task t ON r.task_id = t.id
    LEFT JOIN t_materiel m ON r.materiel_id = m.id
    LEFT JOIN t_procedure p ON r.procedure_id = p.id
    LEFT JOIN sys_user u ON r.create_user_id = u.id
  `;
  const params: unknown[] = [];
  if (options.search) {
    sql += ` WHERE r.bill_no LIKE ? OR t.bill_no LIKE ? OR t.heat_number LIKE ? OR m.name LIKE ?`;
    const search = `%${options.search}%`;
    params.push(search, search, search, search);
  }
  sql += ` ORDER BY r.create_time DESC LIMIT ? OFFSET ?`;
  params.push(options.pageSize, offset);
  return queryMes<Record<string, unknown>>(sql, params);
}

export async function fetchMesProcedures(): Promise<Record<string, unknown>[]> {
  return queryMes<Record<string, unknown>>(
    'SELECT id, code, name, remarks FROM t_procedure ORDER BY code ASC'
  );
}

export interface MesOqcSourceOptions {
  materialCode?: string;
  batchNo?: string;
  salesOrderNo?: string;
}

export interface MesOqcSourceBundle {
  productionTrace: Record<string, unknown>[];
  serials: Record<string, unknown>[];
  processInspections: Record<string, unknown>[];
}

export async function fetchMesOqcSourceBundle(
  options: MesOqcSourceOptions
): Promise<MesOqcSourceBundle> {
  const materialCode = options.materialCode ?? '';
  const batchNo = options.batchNo ?? '';
  const salesOrderNo = options.salesOrderNo ?? '';
  if (!materialCode && !batchNo && !salesOrderNo) {
    return { productionTrace: [], serials: [], processInspections: [] };
  }

  const productionTrace = await queryMes<Record<string, unknown>>(
    `SELECT id, bill_no, work_no, bill_date, materiel_id, batch_no, heat_number, steel_mill,
            production_num, production_type, plan_begin_date, plan_end_date, delivery_date, finished_date,
            status, bill_status, material_code, erp_bill_no
     FROM t_production_task
     WHERE del_flag = 0 AND (material_code = ? OR batch_no = ? OR erp_bill_no = ?)
     ORDER BY create_time DESC LIMIT 50`,
    [materialCode, batchNo, salesOrderNo]
  );
  const taskIds = productionTrace.map((task) => task.id).filter(Boolean) as string[];
  if (taskIds.length === 0) {
    return { productionTrace, serials: [], processInspections: [] };
  }

  const taskPlaceholders = taskIds.map(() => '?').join(',');
  const serials = await queryMes<Record<string, unknown>>(
    `SELECT id, task_id, materiel_id, serial_number
     FROM t_pro_task_serial_number
     WHERE del_flag = 0 AND task_id IN (${taskPlaceholders}) LIMIT 500`,
    taskIds
  );
  const reports = await queryMes<Record<string, unknown>>(
    `SELECT r.id, r.bill_no, r.bill_date, r.check_qty, r.qualified_qty, r.unqualified_qty,
            r.is_qualified, r.check_date, r.remarks, r.task_id,
            t.bill_no AS task_bill_no, t.heat_number, t.batch_no
     FROM t_check_report r
     LEFT JOIN t_production_task t ON r.task_id = t.id
     WHERE r.del_flag = 0 AND (r.task_id IN (${taskPlaceholders}) OR r.materiel_id = ?)
     ORDER BY r.create_time DESC LIMIT 100`,
    [...taskIds, materialCode]
  );
  const reportIds = reports.map((report) => report.id).filter(Boolean) as string[];
  if (reportIds.length === 0) {
    return { productionTrace, serials, processInspections: reports };
  }

  const reportPlaceholders = reportIds.map(() => '?').join(',');
  const reportParams = await queryMes<Record<string, unknown>>(
    `SELECT id, report_id, parameter_id, parameter_value, determine, control_id
     FROM t_check_report_parameter
     WHERE del_flag = 0 AND report_id IN (${reportPlaceholders}) LIMIT 500`,
    reportIds
  );
  const paramsByReportId = new Map<unknown, Record<string, unknown>[]>();
  for (const param of reportParams) {
    const items = paramsByReportId.get(param.report_id) ?? [];
    items.push(param);
    paramsByReportId.set(param.report_id, items);
  }

  return {
    productionTrace,
    serials,
    processInspections: reports.map((report) => ({
      ...report,
      parameters: paramsByReportId.get(report.id) ?? [],
    })),
  };
}

/**
 * 测试 MES 数据库物理连通性
 */
export async function testMesConnection(): Promise<{
  connected: boolean;
  database: string;
  tablesCount: number;
  latencyMs: number;
  message: string;
}> {
  const start = Date.now();
  try {
    assertSafeMesDatabase();
    const ping = await queryMes<{ currentDb: string }>('SELECT DATABASE() as currentDb');
    const tables = await queryMes<{ totalTables: number }>(
      'SELECT COUNT(1) as totalTables FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
      [STRICT_MES_TARGET_DB]
    );

    const firstPing = ping && ping.length > 0 ? ping[0] : undefined;
    const firstTable = tables && tables.length > 0 ? tables[0] : undefined;

    const currentDb = (firstPing && firstPing.currentDb) || STRICT_MES_TARGET_DB;
    const totalTables = (firstTable && Number(firstTable.totalTables)) || 0;

    return {
      connected: true,
      database: currentDb,
      tablesCount: totalTables,
      latencyMs: Date.now() - start,
      message: 'MES 数据库连接正常，安全边界有效',
    };
  } catch (err: any) {
    return {
      connected: false,
      database: STRICT_MES_TARGET_DB,
      tablesCount: 0,
      latencyMs: Date.now() - start,
      message: `MES 数据库连接失败: ${err?.message || String(err)}`,
    };
  }
}