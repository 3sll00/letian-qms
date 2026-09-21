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