import dotenv from 'dotenv';
dotenv.config();
import { getErpConnectionPool } from '../adapters/erp-pool.js';
import { db } from '../database/connection.js';
import { resolveOutsourceProcessType } from '@letian/application';

/**
 * 委外检验台账「加工类型 / 加工商」回填。
 *
 * 背景：ERP 同步建单（sync-erp-outsource-inspections）早期不映射 process_type /
 * vendor_name，存量约 5000 张同步单两列恒为 NULL，台账「加工类型 / 回厂日期 / 加工商」
 * 只能显示 `-`（回厂日期 ERP 委外单上无来源，不回填 —— 由录入页手工登记）。
 *
 * 来源（与同步用例同一口径，只取 ERP 真实数据，不推导）：
 *   - process_type ← DlySC.Comment 命中的工艺词（发黑 / 镀锌 / 热处理 …），
 *     关键词解析复用应用层 `resolveOutsourceProcessType`；未命中一律跳过；
 *   - vendor_name  ← DlyndxSC.BtypeID → Btype.FullName（与该单 supplier_code 同源）。
 *
 * 只回填**当前为空**的列，人工已补录/修正过的值一律不覆盖。
 *
 * 用法：pnpm run db:backfill:outsource-process-type
 */
export async function backfillOutsourceProcessType(): Promise<{
  success: boolean;
  scannedOrders: number;
  erpRowsMatched: number;
  processTypeUpdated: number;
  vendorNameUpdated: number;
}> {
  const orders = await db
    .selectFrom('inspectionOrders')
    .select(['id', 'orderNo', 'outsourceNo', 'materialCode'])
    .where('orderType', 'in', ['OQC_SF', 'OQC_MACH', 'OQC_HEAT'])
    .where('outsourceNo', 'is not', null)
    .where('outsourceNo', '<>', '')
    .where((eb) =>
      eb.or([
        eb('processType', 'is', null),
        eb('processType', '=', ''),
        eb('vendorName', 'is', null),
        eb('vendorName', '=', ''),
      ])
    )
    .execute();

  if (orders.length === 0) {
    console.log('=== [Backfill] 没有需要回填的委外检验单，跳过 ===');
    return { success: true, scannedOrders: 0, erpRowsMatched: 0, processTypeUpdated: 0, vendorNameUpdated: 0 };
  }

  const numbers = [...new Set(orders.map((o) => o.outsourceNo).filter((n): n is string => !!n))];
  console.log(`=== [Backfill] 待回填检验单 ${orders.length} 条，涉及委外加工单 ${numbers.length} 张 ===`);

  const pool = await getErpConnectionPool();
  if (!pool) {
    console.error('Cannot connect to ERP SQL Server — 未做任何修改。');
    return { success: false, scannedOrders: orders.length, erpRowsMatched: 0, processTypeUpdated: 0, vendorNameUpdated: 0 };
  }

  // 「单号|物料编码」-> 首个非空明细备注；「单号」-> 加工商全名（表头级，明细行相同）
  const commentByKey = new Map<string, string>();
  const vendorByNumber = new Map<string, string>();
  const CHUNK = 300;
  for (let i = 0; i < numbers.length; i += CHUNK) {
    const chunk = numbers.slice(i, i + CHUNK);
    const inList = chunk.map((c) => `'${c.replace(/'/g, "''")}'`).join(',');
    const result = await pool.request().query(
      `SELECT n.Number, ISNULL(p.UserCode, N'') AS UserCode,
              ISNULL(d.Comment, N'') AS Comment,
              ISNULL(b.FullName, N'') AS BtypeFullName
         FROM DlySC d
         JOIN DlyndxSC n ON n.Vchcode = d.Vchcode
         LEFT JOIN Ptype p ON p.typeId = d.PtypeID
         LEFT JOIN Btype b ON b.typeId = n.BtypeID
        WHERE n.VchType = 181 AND n.Number IN (${inList})`
    );
    for (const row of result.recordset as {
      Number: string; UserCode: string; Comment: string; BtypeFullName: string;
    }[]) {
      const key = `${row.Number}|${row.UserCode}`;
      const comment = (row.Comment ?? '').trim();
      if (comment !== '' && !commentByKey.has(key)) commentByKey.set(key, comment);
      const vendor = (row.BtypeFullName ?? '').trim();
      if (vendor !== '' && !vendorByNumber.has(row.Number)) vendorByNumber.set(row.Number, vendor);
    }
  }

  let erpRowsMatched = 0;
  let processTypeUpdated = 0;
  let vendorNameUpdated = 0;

  for (const order of orders) {
    const key = `${order.outsourceNo}|${order.materialCode}`;
    const comment = commentByKey.get(key);
    const processType = comment !== undefined ? resolveOutsourceProcessType(comment) : undefined;
    const vendorName = vendorByNumber.get(order.outsourceNo ?? '');

    if (processType === undefined && vendorName === undefined) continue;
    erpRowsMatched += 1;

    // 只更新「当前仍为空」的列：每列单独一条 UPDATE + NULL/'' 谓词，
    // 一列已被人工补过不拖住另一列，也不会把人工补录的值覆盖掉
    if (processType !== undefined) {
      const res = await db
        .updateTable('inspectionOrders')
        .set({ processType })
        .where('id', '=', order.id)
        .where((eb) => eb.or([eb('processType', 'is', null), eb('processType', '=', '')]))
        .executeTakeFirst();
      processTypeUpdated += Number(res.numUpdatedRows ?? 0);
    }
    if (vendorName !== undefined) {
      const res = await db
        .updateTable('inspectionOrders')
        .set({ vendorName })
        .where('id', '=', order.id)
        .where((eb) => eb.or([eb('vendorName', 'is', null), eb('vendorName', '=', '')]))
        .executeTakeFirst();
      vendorNameUpdated += Number(res.numUpdatedRows ?? 0);
    }
  }

  console.log(
    `=== [Backfill] 完成：ERP 命中 ${erpRowsMatched} 条；` +
    `process_type 更新 ${processTypeUpdated} 条，vendor_name 更新 ${vendorNameUpdated} 条 ===`
  );
  return { success: true, scannedOrders: orders.length, erpRowsMatched, processTypeUpdated, vendorNameUpdated };
}

if (process.argv[1]?.endsWith('backfill-outsource-process-type.ts')) {
  backfillOutsourceProcessType()
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.success ? 0 : 1);
    })
    .catch((err) => {
      console.error('Backfill failed:', err);
      process.exit(1);
    });
}
