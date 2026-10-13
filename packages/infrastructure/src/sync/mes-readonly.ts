/**
 * MES 只读守门 —— 「QMS 绝不回写 MES」的代码层闸门（与 `erp-readonly.ts` 同构，MySQL 版）。
 *
 * 三道闸门（本文件是第 1、2 道；第 3 道在运维侧）：
 *   ① 断言：交给 MES 连接的 SQL 必须是 SELECT / WITH 查询，出现任何写关键字即**抛异常中止**（fail-closed）；
 *   ② 单一入口：`queryMesReadOnly()` 是**唯一**允许的 MES 取数函数，内部先过 ①；
 *   ③ 账号权限（运维）：MES 侧给 QMS 的登录（backup）只授 SELECT 权限，物理上不给写权限。
 *
 * 为什么直接抛错而不是记日志继续：只读约定被一次手误破坏，产出的是**外部系统的脏数据**，
 * 事后清理成本远高于同步失败重跑。
 */
export class MesReadOnlyViolation extends Error {
  public constructor(sqlText: string, reason: string) {
    super(`[MES 只读守门] ${reason}；SQL: ${sqlText.replace(/\s+/g, ' ').slice(0, 200)}`);
    this.name = 'MesReadOnlyViolation';
  }
}

/** 写关键字（命中即拒绝）；`into outfile`/`into dumpfile` 由 `into` 覆盖 */
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
  'call',
  'grant',
  'revoke',
  'rename',
  'lock',
  'handler',
  'load',
  'shutdown',
  'set',
] as const;

/** 去掉注释与字符串字面量，避免「字符串里出现 update 字样」被误判 */
function stripLiteralsAndComments(sqlText: string): string {
  return sqlText
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

/** 只读断言：不满足即抛 `MesReadOnlyViolation`（调用方不捕获 = 本轮同步直接失败） */
export function assertReadOnlyMesSql(sqlText: string): void {
  if (typeof sqlText !== 'string' || sqlText.trim() === '') {
    throw new MesReadOnlyViolation(String(sqlText), 'SQL 为空');
  }
  const scanned = stripLiteralsAndComments(sqlText);
  if (!/^\s*(select|with)\b/i.test(scanned)) {
    throw new MesReadOnlyViolation(sqlText, 'MES 侧只允许以 SELECT / WITH 开头的查询');
  }
  for (const keyword of WRITE_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`, 'i').test(scanned)) {
      throw new MesReadOnlyViolation(sqlText, `出现写关键字 "${keyword}"`);
    }
  }
}

/** MES 取数审计：供 CLI / 探针打印「本次只发了 N 条 SELECT，全部为只读」 */
export interface MesQueryAuditEntry {
  sqlText: string;
  at: string;
}

export const mesReadOnlyAudit: MesQueryAuditEntry[] = [];

export function resetMesReadOnlyAudit(): void {
  mesReadOnlyAudit.length = 0;
}

/** MySQL 侧用位置参数（`?`），与 mssql 命名参数不同 */
export type MesQueryParam = string | number | null;

/** 只读查询执行器：`mes-readonly.ts` 之外不得直接持有 */
export interface MesQueryRunner {
  query(sqlText: string, params?: readonly MesQueryParam[]): Promise<{ rows: unknown[] }>;
}

/** **唯一** MES 取数入口：先过只读断言，再下发，并记入审计 */
export async function queryMesReadOnly<T>(
  runner: MesQueryRunner,
  sqlText: string,
  params: readonly MesQueryParam[] = [],
): Promise<T[]> {
  assertReadOnlyMesSql(sqlText);
  mesReadOnlyAudit.push({ sqlText: sqlText.replace(/\s+/g, ' ').trim(), at: new Date().toISOString() });
  const result = await runner.query(sqlText, params);
  return (result?.rows ?? []) as T[];
}
