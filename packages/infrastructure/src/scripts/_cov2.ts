import dotenv from 'dotenv';
dotenv.config();
import { getErpConnectionPool } from '../adapters/erp-pool.js';

async function main() {
  const pool = await getErpConnectionPool();
  if (!pool) {
    console.log('ERP_UNREACHABLE');
    return;
  }
  const leaf = await pool
    .request()
    .query('SELECT COUNT(*) AS n FROM Ptype WHERE deleted = 0 AND sonnum = 0');
  console.log('PTYPE_LEAF_TOTAL=' + leaf.recordset[0].n);

  // 来料送检/检验相关单（146 采购送检单 / 147 采购检验单）涉及的去重物料
  const inInspect = await pool
    .request()
    .query(
      "SELECT COUNT(DISTINCT d.PtypeId) AS n FROM DlyCheck d WHERE d.Vchtype IN (146, 147) AND d.PtypeId IS NOT NULL AND d.PtypeId <> ''"
    );
  console.log('PTYPE_IN_INCOMING_146_147=' + inInspect.recordset[0].n);

  // 全 DlyCheck 涉及的去重物料（含所有检验类型）
  const allInspect = await pool
    .request()
    .query(
      "SELECT COUNT(DISTINCT d.PtypeId) AS n FROM DlyCheck d WHERE d.PtypeId IS NOT NULL AND d.PtypeId <> ''"
    );
  console.log('PTYPE_IN_ALL_DLYCHECK=' + allInspect.recordset[0].n);
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('ERR', e);
    process.exit(1);
  });
