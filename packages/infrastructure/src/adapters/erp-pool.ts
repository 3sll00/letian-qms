import dotenv from 'dotenv';
dotenv.config();
import sql from 'mssql';

let pool: sql.ConnectionPool | null = null;

export function getErpSqlConfig(): sql.config | null {
  const host = process.env.ERP_DB_HOST;
  const portStr = process.env.ERP_DB_PORT;
  const database = process.env.ERP_DB_NAME;
  const user = process.env.ERP_DB_USER;
  const password = process.env.ERP_DB_PASSWORD;

  if (!host || !database || !user || !password) {
    return null;
  }

  return {
    server: host,
    port: portStr ? parseInt(portStr, 10) : 1433,
    database,
    user,
    password,
    options: {
      encrypt: process.env.ERP_DB_ENCRYPT !== 'false',
      trustServerCertificate: process.env.ERP_DB_TRUST_SERVER_CERTIFICATE !== 'false',
      connectTimeout: 15000,
    },
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000,
    },
  };
}

export async function getErpConnectionPool(): Promise<sql.ConnectionPool | null> {
  const cfg = getErpSqlConfig();
  if (!cfg) {
    return null;
  }

  if (pool && pool.connected) {
    return pool;
  }

  try {
    pool = await new sql.ConnectionPool(cfg).connect();
    return pool;
  } catch (err) {
    console.error('[ErpPool] Failed to connect to ERP SQL Server:', err);
    return null;
  }
}

export async function closeErpConnectionPool(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = null;
  }
}
