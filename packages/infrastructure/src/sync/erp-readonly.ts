/**
 * ERP 只读守门 —— 「QMS 绝不回写 ERP」的代码层闸门（口径见 docs/45-ERP只读单向同步设计（Ptype到materials）.md §2）。
 *
 * 三道闸门（本文件是第 1、2 道；第 3 道在运维侧）：
 *   ① 断言：交给 ERP 连接的 SQL 必须是 SELECT / WITH 查询，出现任何写关键字即**抛异常中止**（fail-closed）；
 *   ② 单一入口：`queryErpReadOnly()` 是**唯一**允许的 ERP 取数函数，内部先过 ①；
 *   ③ 账号权限（运维）：ERP 侧给 QMS 的登录只授 `db_datareader`，物理上不给写权限。
 *
 * 为什么不做「记日志 + 继续跑」：只读约定一旦被一次手误破坏，产出的是**外部系统的脏数据**，
 * 事后再清理的成本远高于同步失败重跑。所以这里直接抛错，并把 SQL 原文带出来定位。
 */
export class ErpReadOnlyViolation extends Error {
  public constructor(sqlText: string, reason: string) {
    super(`[ERP 只读守门] ${reason}；SQL: ${sqlText.replace(/\s+/g, ' ').slice(0, 200)}`);
    this.name = 'ErpReadOnlyViolation';
  }
}

/** 写关键字（命中即拒绝）；`into` 用于拦 `SELECT ... INTO`（建表写操作） */
const WRITE_KEYWORDS = [
  'insert',
  'update',
  'delete',
  'merge',
  'truncate',
  'drop',
  'alter',
  'create',
  'into',
  'exec',
  'execute',
  'grant',
  'revoke',
  'deny',
  'backup',
  'restore',
  'bulk',
  'shutdown',
  'sp_',
  'xp_',
] as const;

/** 去掉注释与字符串字面量，避免「字符串里出现 update 字样」被误判 */
function stripLiteralsAndComments(sqlText: string): string {
  return sqlText
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

/** 只读断言：不满足即抛 `ErpReadOnlyViolation`（调用方不捕获 = 本轮同步直接失败） */
export function assertReadOnlyErpSql(sqlText: string): void {
  if (typeof sqlText !== 'string' || sqlText.trim() === '') {
    throw new ErpReadOnlyViolation(String(sqlText), 'SQL 为空');
  }
  const scanned = stripLiteralsAndComments(sqlText);
  if (!/^\s*(select|with)\b/i.test(scanned)) {
    throw new ErpReadOnlyViolation(sqlText, 'ERP 侧只允许以 SELECT / WITH 开头的查询');
  }
  for (const keyword of WRITE_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`, 'i').test(scanned)) {
      throw new ErpReadOnlyViolation(sqlText, `出现写关键字 "${keyword}"`);
    }
  }
}

/** ERP 取数审计：供 CLI / 探针打印「本次只发了 N 条 SELECT，全部为只读」 */
export interface ErpQueryAuditEntry {
  sqlText: string;
  at: string;
}

export const erpReadOnlyAudit: ErpQueryAuditEntry[] = [];

export function resetErpReadOnlyAudit(): void {
  erpReadOnlyAudit.length = 0;
}

export interface ErpQueryParam {
  name: string;
  value: string | number;
}

/** 只读查询执行器：`erp-readonly.ts` 之外不得直接持有（`pnpm verify:erp-readonly` 静态门禁会检查） */
export interface ErpQueryRunner {
  query(sqlText: string, params?: readonly ErpQueryParam[]): Promise<{ recordset: unknown[] }>;
}

/** **唯一** ERP 取数入口：先过只读断言，再下发，并记入审计 */
export async function queryErpReadOnly<T>(
  runner: ErpQueryRunner,
  sqlText: string,
  params: readonly ErpQueryParam[] = []
): Promise<T[]> {
  assertReadOnlyErpSql(sqlText);
  erpReadOnlyAudit.push({ sqlText: sqlText.replace(/\s+/g, ' ').trim(), at: new Date().toISOString() });
  const result = await runner.query(sqlText, params);
  return (result?.recordset ?? []) as T[];
}
