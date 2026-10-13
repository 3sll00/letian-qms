/* 探查：工序字典表（GxTypeId 参照）+ DlyCheck/T_SC_DlyCheck 质检单结构 */
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

  // 工序/工位/工艺候选表
  const t = await pool.request().query(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' AND (" +
      "TABLE_NAME LIKE '%Gx%' OR TABLE_NAME LIKE '%GX%' OR TABLE_NAME LIKE '%Process%' " +
      "OR TABLE_NAME LIKE '%WorkP%' OR TABLE_NAME LIKE '%Procedure%' OR TABLE_NAME LIKE '%Working%')" +
      ' ORDER BY TABLE_NAME'
  );
  console.log('=== gx candidate tables ===');
  for (const r of t.recordset) console.log('  ' + r.TABLE_NAME);

  // DlyCheck（采购质检明细）列结构 —— 检验单怎么记指标
  const c1 = await pool.request().query(
    "SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='DlyCheck' ORDER BY ORDINAL_POSITION"
  );
  console.log('\n=== DlyCheck cols ===');
  for (const c of c1.recordset) console.log('  ' + c.COLUMN_NAME + ' ' + c.DATA_TYPE);

  const c2 = await pool.request().query(
    "SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='T_SC_DlyCheck' ORDER BY ORDINAL_POSITION"
  );
  console.log('\n=== T_SC_DlyCheck cols ===');
  for (const c of c2.recordset) console.log('  ' + c.COLUMN_NAME + ' ' + c.DATA_TYPE);

  // T_Jxc_BuyTestDlyTestItem —— 单据上的检验项目明细（最可能存实测值）
  const c3 = await pool.request().query(
    "SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='T_Jxc_BuyTestDlyTestItem' ORDER BY ORDINAL_POSITION"
  );
  console.log('\n=== T_Jxc_BuyTestDlyTestItem cols ===');
  for (const c of c3.recordset) console.log('  ' + c.COLUMN_NAME + ' ' + c.DATA_TYPE);
  const n3 = await pool.request().query('SELECT COUNT(*) AS n FROM T_Jxc_BuyTestDlyTestItem');
  console.log('rows:', n3.recordset[0].n);

  await pool.close();
}
main().catch((e) => { console.error('ERR:', e && e.message ? e.message : e); process.exit(1); });
