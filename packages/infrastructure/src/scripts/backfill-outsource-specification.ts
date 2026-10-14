import dotenv from 'dotenv';
dotenv.config();
import { getErpConnectionPool } from '../adapters/erp-pool.js';
import { db } from '../database/connection.js';

/**
 * 委外检验规格快照回填（docs/51 模板A 的「规格尺寸」列）。
 *
 * 背景：`OUTSOURCE_INSPECTION_SELECT_SQL` 早期只取 Ptype 的 UserCode / FullName，
 * 规格列 `Ptype.Standard` 从未被读出，而建单用例对 specification 的唯一兜底是
 * QMS `materials.spec_model`。`sync-master-data` 的物料范围只 JOIN `DlyCheck`（来料送检单），
 * 于是「只出现在委外加工单 DlySC、从未来料送检单」的物料从未进过 QMS 主数据 ——
 * 这类物料同步进来的检验单 specification 恒为 NULL，台账与制造证书两处规格都空。
 *
 * 本脚本只回填 **当前为空** 的行，且只写 ERP 真实存在 `Ptype.Standard` 的物料；
 * ERP 查不到、或 Standard 为空的物料一律跳过并如实计数，不做任何推导或占位。
 *
 * 用法：pnpm run db:backfill:outsource-spec
 */
export async function backfillOutsourceSpecification(): Promise<{
  success: boolean;
  scannedCodes: number;
  matchedCodes: number;
  updatedRows: number;
  unmatchedCodes: string[];
}> {
  const empty = await db
    .selectFrom('inspectionOrders')
    .select((eb) => eb.fn.countAll().as('total'))
    .where('orderType', '=', 'OQC_SF')
    .where((eb) => eb.or([eb('specification', 'is', null), eb('specification', '=', '')]))
    .executeTakeFirstOrThrow();

  const targetCount = Number(empty.total ?? 0);
  if (targetCount === 0) {
    console.log('=== [Backfill] 没有需要回填的委外检验单，跳过 ===');
    return { success: true, scannedCodes: 0, matchedCodes: 0, updatedRows: 0, unmatchedCodes: [] };
  }

  const codes = await db
    .selectFrom('inspectionOrders')
    .select('materialCode')
    .distinct()
    .where('orderType', '=', 'OQC_SF')
    .where((eb) => eb.or([eb('specification', 'is', null), eb('specification', '=', '')]))
    .execute();
  const codeList = [...new Set(codes.map((r) => r.materialCode).filter((c): c is string => !!c))];
  console.log(`=== [Backfill] 待回填检验单 ${targetCount} 条，涉及物料编码 ${codeList.length} 个 ===`);

  const pool = await getErpConnectionPool();
  if (!pool) {
    console.error('Cannot connect to ERP SQL Server — 未做任何修改。');
    return { success: false, scannedCodes: codeList.length, matchedCodes: 0, updatedRows: 0, unmatchedCodes: codeList };
  }

  // ERP Ptype：UserCode 即 QMS materialCode，Standard 即规格
  const standardByCode = new Map<string, string>();
  const CHUNK = 400;
  for (let i = 0; i < codeList.length; i += CHUNK) {
    const chunk = codeList.slice(i, i + CHUNK);
    const inList = chunk.map((c) => `'${c.replace(/'/g, "''")}'`).join(',');
    const result = await pool.request().query(
      `SELECT UserCode, ISNULL(Standard, N'') AS Standard
         FROM Ptype
        WHERE deleted = 0 AND UserCode IN (${inList})`
    );
    for (const row of result.recordset as { UserCode: string; Standard: string }[]) {
      const std = (row.Standard ?? '').trim();
      if (row.UserCode && std !== '') standardByCode.set(row.UserCode, std);
    }
  }

  const unmatchedCodes = codeList.filter((c) => !standardByCode.has(c));
  console.log(`-> ERP 命中规格 ${standardByCode.size} 个编码；未命中 ${unmatchedCodes.length} 个（保持留白，不推导）`);

  // 只更新「当前仍为空」的委外检验单，避免覆盖期间被人工补录的值
  let updatedRows = 0;
  for (const [code, std] of standardByCode) {
    const res = await db
      .updateTable('inspectionOrders')
      .set({ specification: std })
      .where('orderType', '=', 'OQC_SF')
      .where('materialCode', '=', code)
      .where((eb) => eb.or([eb('specification', 'is', null), eb('specification', '=', '')]))
      .executeTakeFirst();
    updatedRows += Number(res.numUpdatedRows ?? 0);
  }

  console.log(`=== [Backfill] 完成：更新 ${updatedRows} 条 ===`);
  return {
    success: true,
    scannedCodes: codeList.length,
    matchedCodes: standardByCode.size,
    updatedRows,
    unmatchedCodes,
  };
}

if (process.argv[1]?.endsWith('backfill-outsource-specification.ts')) {
  backfillOutsourceSpecification()
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.success ? 0 : 1);
    })
    .catch((err) => {
      console.error('Backfill failed:', err);
      process.exit(1);
    });
}