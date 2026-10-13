/* 探查：TestItem 字典 + Dly 有效值样例 + Ndx 是否真的全空 */
const path = require('path');
const infraModules = path.join(__dirname, '..', 'packages', 'infrastructure', 'node_modules');
require(path.join(infraModules, 'dotenv')).config({ path: path.join(__dirname, '..', '.env') });
const sql = require(path.join(infraModules, 'mssql'));

async function main() {
  const pool = await new sql.ConnectionPool({
    server: process.env.ERP_DB_HOST,
    port: parseInt(process.env.ERP_DB_PORT || '1433', 10),
    database: process.env.ERP_DB_NAME,
    user: process.env.ERP_DB_USER,
    password: process.env.ERP_DB_PASSWORD,
    options: { encrypt: true, trustServerCertificate: true, connectTimeout: 15000 },
  }).connect();

  const cols = await pool.request().query(
    "SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH AS LEN FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='TestItem' ORDER BY ORDINAL_POSITION"
  );
  console.log('=== TestItem cols ===', JSON.stringify(cols.recordset));
  const ti = await pool.request().query('SELECT TOP 30 * FROM TestItem');
  console.log('=== TestItem rows ===', JSON.stringify(ti.recordset, null, 1).slice(0, 6000));

  // Dly 里真正有内容的行（标准值/公差/检验方式/设备/说明任一非空）
  const filled = await pool.request().query(
    "SELECT TOP 10 * FROM T_Inf_PtypeCheckingSchemeDly WHERE " +
      "(ISNULL(StandardValue,'')<>'' OR ISNULL(Dif,'')<>'' OR ISNULL(CheckWay,'')<>'' OR ISNULL(CheckDevice,'')<>'' OR ISNULL(Summary,'')<>'')"
  );
  console.log('\n=== Dly filled sample ===', JSON.stringify(filled.recordset, null, 1).slice(0, 6000));
  const filledCnt = await pool.request().query(
    "SELECT COUNT(*) AS n FROM T_Inf_PtypeCheckingSchemeDly WHERE " +
      "(ISNULL(StandardValue,'')<>'' OR ISNULL(Dif,'')<>'' OR ISNULL(CheckWay,'')<>'' OR ISNULL(CheckDevice,'')<>'' OR ISNULL(Summary,'')<>'')"
  );
  console.log('filled rows:', filledCnt.recordset[0].n);

  // RecNdx 是否就是 Ptype.typeId？拿一个 RecNdx 去对 Ptype
  const j = await pool.request().query(
    'SELECT TOP 5 d.RecNdx, p.typeId, p.UserCode, p.FullName FROM T_Inf_PtypeCheckingSchemeDly d ' +
      'LEFT JOIN Ptype p ON p.typeId = d.RecNdx GROUP BY d.RecNdx, p.typeId, p.UserCode, p.FullName ORDER BY d.RecNdx'
  );
  console.log('\n=== RecNdx vs Ptype.typeId ===', JSON.stringify(j.recordset, null, 1));

  await pool.close();
}
main().catch((e) => { console.error('ERR:', e && e.message ? e.message : e); process.exit(1); });
