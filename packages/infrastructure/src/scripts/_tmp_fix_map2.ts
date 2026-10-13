import dotenv from 'dotenv';
dotenv.config();
import { closeErpConnectionPool, getErpConnectionPool } from '../adapters/erp-pool.js';
import { queryErpReadOnly, type ErpQueryParam, type ErpQueryRunner } from '../sync/erp-readonly.js';

async function main() {
  const pool = await getErpConnectionPool();
  if (!pool) {
    console.log('ERP 不可用');
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

  // 放宽：物料名含「不锈钢」或「线材」
  const matLoose = await queryErpReadOnly<{ typeId: string; userCode: string | null; fullName: string | null; name: string | null }>(
    runner,
    `SELECT TOP 20 typeId, UserCode, FullName, Name FROM Ptype WHERE FullName LIKE @a OR FullName LIKE @b OR Name LIKE @a OR Name LIKE @b`,
    [
      { name: 'a', value: '%不锈钢%' },
      { name: 'b', value: '%线材%' },
    ],
  );
  console.log('=== ERP Ptype 含[不锈钢/线材] ===', JSON.stringify(matLoose, null, 2));

  // 供应商：查之前占位名片段
  const supLoose = await queryErpReadOnly<{ typeId: string; userCode: string | null; fullName: string | null }>(
    runner,
    `SELECT TOP 20 typeId, UserCode, FullName, Name FROM Btype WHERE FullName LIKE @a OR FullName LIKE @b OR Name LIKE @a OR Name LIKE @b`,
    [
      { name: 'a', value: '%超超%' },
      { name: 'b', value: '%匠工%' },
    ],
  );
  console.log('=== ERP Btype 含[超超/匠工] ===', JSON.stringify(supLoose, null, 2));

  // 员工：列出全部（看是否真有陈静或相似）
  const emps = await queryErpReadOnly<{ typeId: string; userCode: string | null; name: string | null }>(
    runner,
    `SELECT TOP 100 typeId, UserCode, Name FROM Employee ORDER BY Name`,
  );
  console.log('=== ERP Employee 全部(前100) ===', JSON.stringify(emps, null, 2));

  await closeErpConnectionPool();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
