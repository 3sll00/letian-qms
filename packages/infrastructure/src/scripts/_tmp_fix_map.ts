import dotenv from 'dotenv';
dotenv.config();
import { db } from '../database/connection.js';
import { closeErpConnectionPool, getErpConnectionPool } from '../adapters/erp-pool.js';
import { queryErpReadOnly, type ErpQueryParam, type ErpQueryRunner } from '../sync/erp-readonly.js';

async function main() {
  // 1) 映射表现有记录
  const maps = await db.selectFrom('qmsErpCodeMapping').selectAll().execute();
  console.log('=== 映射表现有记录 ===');
  console.log(JSON.stringify(maps, null, 2));

  // 2) QMS 里这几个编码对应的真实名称（材料/供应商来自 inspection_orders；员工来自同表）
  const mat = await db
    .selectFrom('inspectionOrders')
    .select(['materialCode', 'materialName'])
    .where('materialCode', '=', 'MAT-304SS-05')
    .limit(1)
    .execute();
  const sup = await db
    .selectFrom('inspectionOrders')
    .select(['supplierCode', 'supplierName'])
    .where('supplierCode', '=', 'SUP-001')
    .limit(1)
    .execute();
  const emp = await db
    .selectFrom('inspectionOrders')
    .select(['inspectorName'])
    .where('inspectorName', '=', '陈静')
    .limit(1)
    .execute();
  console.log('=== QMS 名称（探查） ===');
  console.log('MAT:', JSON.stringify(mat));
  console.log('SUP:', JSON.stringify(sup));
  console.log('EMP:', JSON.stringify(emp));

  // 3) ERP 反查真实实体
  const pool = await getErpConnectionPool();
  if (!pool) {
    console.log('ERP 不可用，跳过反查');
    return;
  }
  const runner: ErpQueryRunner = {
    async query(sqlText: string, params: readonly ErpQueryParam[] = []) {
      const request = pool.request();
      for (const p of params) request.input(p.name, p.value);
      const result = await request.query(sqlText);
      return { recordset: (result?.recordset ?? []) as unknown[] };
    },
  };

  const matName = mat[0]?.materialName;
  if (matName) {
    const ptypes = await queryErpReadOnly<{ typeId: string; userCode: string | null; fullName: string | null; name: string | null }>(
      runner,
      `SELECT TOP 10 typeId, UserCode, FullName, Name FROM Ptype WHERE FullName LIKE @n OR Name LIKE @n`,
      [{ name: 'n', value: `%${matName}%` }],
    );
    console.log('=== ERP Ptype 候选（物料名匹配） ===', JSON.stringify(ptypes, null, 2));
  } else {
    console.log('MAT-304SS-05 在 inspection_orders 无 materialName，尝试按编码反查');
    const ptypes = await queryErpReadOnly<{ typeId: string; userCode: string | null; fullName: string | null; name: string | null }>(
      runner,
      `SELECT TOP 10 typeId, UserCode, FullName, Name FROM Ptype WHERE UserCode LIKE @n`,
      [{ name: 'n', value: `%MAT-304SS-05%` }],
    );
    console.log('=== ERP Ptype 候选（物料编码匹配） ===', JSON.stringify(ptypes, null, 2));
  }

  const supName = sup[0]?.supplierName;
  if (supName) {
    const btypes = await queryErpReadOnly<{ typeId: string; userCode: string | null; fullName: string | null; name: string | null }>(
      runner,
      `SELECT TOP 10 typeId, UserCode, FullName, Name FROM Btype WHERE FullName LIKE @n OR Name LIKE @n`,
      [{ name: 'n', value: `%${supName}%` }],
    );
    console.log('=== ERP Btype 候选（供应商名匹配） ===', JSON.stringify(btypes, null, 2));
  }

  const emps = await queryErpReadOnly<{ typeId: string; userCode: string | null; name: string | null }>(
    runner,
    `SELECT TOP 10 typeId, UserCode, Name FROM Employee WHERE Name = @n`,
    [{ name: 'n', value: '陈静' }],
  );
  console.log('=== ERP Employee 陈静 ===', JSON.stringify(emps, null, 2));

  await closeErpConnectionPool();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
