/**
 * 临时只读探针：确认 146/147 的 ToQty/ToQty2 真实取值 + 2023 期间结账状态。
 * 用完即删。
 */
import { getErpConnectionPool } from '../adapters/erp-pool.js';

async function main() {
  const pool = await getErpConnectionPool();
  if (!pool) throw new Error('ERP 不可用');

  const q = async (label: string, sql: string) => {
    console.log(`\n===== ${label} =====`);
    const rs = await pool.request().query(sql);
    const rows = (rs.recordset ?? []) as Record<string, unknown>[];
    if (rows.length === 0) {
      console.log('(无数据)');
      return;
    }
    console.log(Object.keys(rows[0]!).join(' | '));
    for (const r of rows) console.log(Object.values(r).map((v) => String(v)).join(' | '));
  };

  await q(
    '真实 146 明细完整字段（排除我们写的 9645/9646）',
    [
      'SELECT TOP 8 d.Vchcode, d.Vchtype, d.Qty, d.Qty2, d.Qty3, d.ToQty, d.ToQty2,',
      '       d.[Mode], d.KtypeID, d.SourceVchcode, d.SourceVchtype, d.Draft, d.period',
      '  FROM DlyCheck d WHERE d.Vchtype = 146 AND d.Vchcode < 9600',
      ' ORDER BY d.Vchcode DESC',
    ].join('\n'),
  );

  await q(
    '真实 147 明细完整字段',
    [
      'SELECT TOP 8 d.Vchcode, d.Vchtype, d.Qty, d.Qty2, d.Qty3, d.ToQty, d.ToQty2,',
      '       d.[Mode], d.KtypeID, d.SourceVchcode, d.SourceVchtype, d.Draft, d.period',
      '  FROM DlyCheck d WHERE d.Vchtype = 147 AND d.Vchcode < 9600',
      ' ORDER BY d.Vchcode DESC',
    ].join('\n'),
  );

  await q(
    '2023 各期间结账状态',
    [
      'SELECT period, MonthName, isjxc, ispmjz, isjzsy FROM T_GBL_MonthProc',
      ' WHERE period >= 202301 AND period <= 202412 ORDER BY period',
    ].join('\n'),
  );
}

main()
  .catch((e) => {
    console.error('FAILED:', e);
    process.exit(1);
  })
  .finally(() => process.exit(0));
