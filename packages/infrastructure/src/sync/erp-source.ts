/**
 * ERP 数据源（读侧）—— 真连接与本地样例两套实现，同步逻辑只依赖 `ErpSource` 接口。
 *
 * 为什么要两套：本机/交付环境常常**连不上 ERP**（docs/35 §R1：`ERP_DB_*` 已配但网络不通），
 * 于是「同步到底跑没跑通」无法验证。fixture 源让最小闭环（Ptype -> materials）在没有 ERP 的机器上
 * 也能真跑；真源到位后只改一个 `--source` 参数，业务代码零改动。
 *
 * 只读保证：真源的每一次查询都经 `queryErpReadOnly()`（写语句直接抛错）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type sql from 'mssql';
import { queryErpReadOnly, type ErpQueryRunner } from './erp-readonly.js';

export interface ErpPtypeRow {
  typeId: number;
  userCode: string;
  fullName: string | null;
  standard: string | null;
  unitName: string | null;
  comment: string | null;
  /** ERP 分类编码（取不到时为 null，交由映射表 / 兜底分类决定，不猜） */
  parentCode: string | null;
}

export interface ErpSource {
  readonly name: string;
  readonly kind: 'mssql' | 'fixture';
  fetchPtype(limit: number): Promise<ErpPtypeRow[]>;
}

/** Ptype 取数 SQL（**只读**；`sonnum = 0` 只取叶子物料，与既有 `scripts/sync-master-data.ts` 同口径） */
export const PTYPE_SELECT_SQL = [
  'SELECT TOP (@limit) typeId, UserCode, FullName, Standard,',
  "       ISNULL(Unit1, N'件') AS UnitName, Comment, NULL AS ParentCode",
  '  FROM Ptype',
  ' WHERE deleted = 0 AND sonnum = 0',
  "   AND UserCode IS NOT NULL AND UserCode <> N''",
  ' ORDER BY typeId DESC',
].join('\n');

export function normalizeLimit(limit: number | undefined): number {
  const value = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : 500;
  return Math.min(Math.max(value, 1), 20000);
}

function toRunner(pool: sql.ConnectionPool): ErpQueryRunner {
  return {
    async query(sqlText, params = []) {
      const request = pool.request();
      for (const param of params) request.input(param.name, param.value);
      const result = await request.query(sqlText);
      return { recordset: (result?.recordset ?? []) as unknown[] };
    },
  };
}

/** 真 ERP（管家婆 SQL Server）数据源；所有取数经只读守门 */
export function createMssqlErpSource(pool: sql.ConnectionPool): ErpSource {
  const runner = toRunner(pool);
  return {
    name: 'guanjiapo-erp(mssql)',
    kind: 'mssql',
    async fetchPtype(limit) {
      return queryErpReadOnly<ErpPtypeRow>(runner, PTYPE_SELECT_SQL, [
        { name: 'limit', value: normalizeLimit(limit) },
      ]);
    },
  };
}

const asText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

function coerceRow(raw: unknown, index: number): ErpPtypeRow {
  const row = (raw ?? {}) as Record<string, unknown>;
  const userCode = asText(row.userCode);
  if (userCode === null) {
    throw new Error(`[erp-source] 第 ${index + 1} 行缺少 userCode，样例数据不合法`);
  }
  return {
    typeId: typeof row.typeId === 'number' ? row.typeId : index + 1,
    userCode,
    fullName: asText(row.fullName),
    standard: asText(row.standard),
    unitName: asText(row.unitName),
    comment: asText(row.comment),
    parentCode: asText(row.parentCode),
  };
}

/** 本地样例源：数据来自 JSON 数组（用于无 ERP 环境下的最小可运行验证） */
export function createFixtureErpSource(rows: readonly unknown[], name = 'fixture(本地样例)'): ErpSource {
  return {
    name,
    kind: 'fixture',
    async fetchPtype(limit) {
      return rows.slice(0, normalizeLimit(limit)).map(coerceRow);
    },
  };
}

export function loadFixtureErpSource(filePath: string): ErpSource {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error(`[erp-source] 样例文件必须是 JSON 数组：${filePath}`);
  }
  return createFixtureErpSource(parsed, `fixture:${path.basename(filePath)}`);
}
