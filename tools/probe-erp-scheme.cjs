/* 探查 ERP 检验方案相关表：候选表清单 + Ndx/Dly 数据形态 + TIType 字典 */
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

  // 1) 候选表：名字含 Check / Scheme / TI / GX / Standard 的表
  const t = await pool.request().query(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' AND (" +
      "TABLE_NAME LIKE '%Check%' OR TABLE_NAME LIKE '%Scheme%' OR TABLE_NAME LIKE '%TIType%' " +
      "OR TABLE_NAME LIKE '%GxType%' OR TABLE_NAME LIKE '%Standard%' OR TABLE_NAME LIKE '%Item%')" +
      ' ORDER BY TABLE_NAME'
  );
  console.log('=== candidate tables ===');
  for (const r of t.recordset) console.log('  ' + r.TABLE_NAME);

  // 2) Dly 里 RecNdx 的分布范围（Ndx 为空 => 明细引用的主表是谁？）
  const d = await pool.request().query(
    'SELECT MIN(RecNdx) AS mn, MAX(RecNdx) AS mx, COUNT(DISTINCT RecNdx) AS ndxCount, COUNT(*) AS rows FROM T_Inf_PtypeCheckingSchemeDly'
  );
  console.log('\n=== Dly RecNdx stats ===', JSON.stringify(d.recordset));

  // 3) TITypeId 取值分布
  const ti = await pool.request().query(
    'SELECT TOP 20 TITypeId, COUNT(*) AS n FROM T_Inf_PtypeCheckingSchemeDly GROUP BY TITypeId ORDER BY n DESC'
  );
  console.log('\n=== top TITypeId ===', JSON.stringify(ti.recordset));

  await pool.close();
}
main().catch((e) => { console.error('ERR:', e && e.message ? e.message : e); process.exit(1); });
