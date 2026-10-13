/* 探查：工序字典（WorkProcess / xwc_Procedures / DlyGX）+ 单据实测表样例值 */
const path = require('path');
const infraModules = path.join(__dirname, '..', 'packages', 'infrastructure', 'node_modules');
require(path.join(infraModules, 'dotenv')).config({ path: path.join(__dirname, '..', '.env') });
const sql = require(path.join(infraModules, 'mssql'));

async function cols(pool, t) {
  const r = await pool.request().input('t', sql.NVarChar, t).query(
    'SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME=@t ORDER BY ORDINAL_POSITION'
  );
  return r.recordset.map((c) => c.COLUMN_NAME + ':' + c.DATA_TYPE).join(', ');
}

async function main() {
  const pool = await new sql.ConnectionPool({
    server: process.env.ERP_DB_HOST,
    port: parseInt(process.env.ERP_DB_PORT || '1433', 10),
    database: process.env.ERP_DB_NAME,
    user: process.env.ERP_DB_USER,
    password: process.env.ERP_DB_PASSWORD,
    options: { encrypt: true, trustServerCertificate: true, connectTimeout: 15000 },
  }).connect();

  for (const t of ['WorkProcess', 'xwc_Procedures', 'DlyGX', 'DlyNdxGX', 'WorkPlan', 'WorkPlanDetail']) {
    try {
      console.log('\n=== ' + t + ' cols ===\n  ' + (await cols(pool, t)));
      const n = await pool.request().query('SELECT COUNT(*) AS n FROM ' + t);
      console.log('  rows: ' + n.recordset[0].n);
      const s = await pool.request().query('SELECT TOP 5 * FROM ' + t);
      console.log('  sample: ' + JSON.stringify(s.recordset).slice(0, 2500));
    } catch (e) {
      console.log('  ERR ' + t + ': ' + e.message);
    }
  }

  // 单据实测表非空样例（看标准值/公差/检验方式/设备的实际填写形态）
  const filled = await pool.request().query(
    'SELECT TOP 8 TITypeId, TestStandard, StandardValue, Dif, CheckWay, CheckDevice, Result01, Result02, ResultMode ' +
      "FROM T_Jxc_BuyTestDlyTestItem WHERE ISNULL(StandardValue,'')<>'' OR ISNULL(Dif,'')<>'' OR ISNULL(CheckWay,'')<>'' OR ISNULL(CheckDevice,'')<>''"
  );
  console.log('\n=== T_Jxc_BuyTestDlyTestItem filled ===', JSON.stringify(filled.recordset, null, 1).slice(0, 5000));

  // TestItem 上 TestStandard / ETypeID 是否有值
  const tst = await pool.request().query(
    "SELECT TOP 10 TypeID, FullName, TestStandard, ETypeID FROM TestItem WHERE deleted=0 AND (ISNULL(TestStandard,'')<>'' OR ISNULL(ETypeID,'')<>'')"
  );
  console.log('\n=== TestItem with standard ===', JSON.stringify(tst.recordset));

  await pool.close();
}
main().catch((e) => { console.error('ERR:', e && e.message ? e.message : e); process.exit(1); });
