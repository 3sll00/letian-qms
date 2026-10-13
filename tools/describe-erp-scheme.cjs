/* 一次性探查脚本：只读连接 ERP，输出检验方案表的列结构与样例行 */
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
  console.log('CONNECTED');

  const tables = ['T_Inf_PtypeCheckingSchemeNdx', 'T_Inf_PtypeCheckingSchemeDly'];
  for (const t of tables) {
    const cols = await pool.request().input('t', sql.NVarChar, t).query(
      'SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH AS LEN, IS_NULLABLE ' +
        'FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @t ORDER BY ORDINAL_POSITION'
    );
    console.log('\n=== ' + t + ' (' + cols.recordset.length + ' cols) ===');
    for (const c of cols.recordset) {
      console.log('  ' + c.COLUMN_NAME + ' : ' + c.DATA_TYPE + '(' + (c.LEN == null ? '' : c.LEN) + ') ' + c.IS_NULLABLE);
    }
    const cnt = await pool.request().query('SELECT COUNT(*) AS n FROM ' + t);
    console.log('  rows: ' + cnt.recordset[0].n);
    const sample = await pool.request().query('SELECT TOP 3 * FROM ' + t);
    console.log('  sample:', JSON.stringify(sample.recordset, null, 1).slice(0, 4000));
  }
  await pool.close();
}
main().catch((e) => { console.error('ERR:', e && e.message ? e.message : e); process.exit(1); });
