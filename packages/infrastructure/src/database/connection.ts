import { Kysely, PostgresDialect, CamelCasePlugin } from 'kysely';
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'node:path';
import { Database } from './schema.js';

// 先尝试当前工作目录下的 .env（就近优先），再回退到 monorepo 根目录的 .env。
// 根目录路径从本模块自身位置推导（packages/infrastructure/src|dist/database → 根目录），
// 因此无论用 pnpm --filter 从包目录启动，还是从仓库根目录启动，都能读到同一份配置。
// dotenv 默认不覆盖已存在的环境变量，所以"就近优先"由调用顺序保证。
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

// node-postgres 默认把 NUMERIC(OID 1700) 解析成字符串以避免精度丢失。
// 本项目所有 numeric 列都是数量（最多 15 位整数 + 4 位小数），不会超出 JS 安全整数范围，
// 因此在连接层统一解析为 number，与 database/schema.ts 里 NumericColumnType 的
// SelectType 保持一致——否则会出现"类型写 number、运行时是 string"的静默不一致。
pg.types.setTypeParser(1700, (value: string) => (value === null ? null : Number(value)));

const { Pool } = pg;

export interface DatabaseConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  max?: number;
  ssl?: boolean | { rejectUnauthorized: boolean };
}

export function createDatabaseConnection(config?: DatabaseConfig): Kysely<Database> {
  const pool = new Pool({
    connectionString:
      config?.connectionString ||
      process.env.DATABASE_URL ||
      'postgres://postgres:postgres@localhost:5432/letian_qms',
    host: config?.host || process.env.DB_HOST,
    port: config?.port || (process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : undefined),
    database: config?.database || process.env.DB_NAME,
    user: config?.user || process.env.DB_USER,
    password: config?.password || process.env.DB_PASSWORD,
    max: config?.max || 20,
    ssl: config?.ssl || (process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined),
  });

  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool,
    }),
    plugins: [new CamelCasePlugin()],
  });
}

let defaultDbInstance: Kysely<Database> | null = null;

export function getDatabase(config?: DatabaseConfig): Kysely<Database> {
  if (!defaultDbInstance || config) {
    const instance = createDatabaseConnection(config);
    if (!config) {
      defaultDbInstance = instance;
    }
    return instance;
  }
  return defaultDbInstance;
}

export const db = getDatabase();
