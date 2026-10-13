/**
 * 只读探查：炉批号（furnace_heat_batch_no）的上游数据来源定位。
 *
 * 背景：QMS `inspection_orders.furnace_heat_batch_no` 全库为空，录入 PATCH 已可写，
 * 缺数据来源。炉号物理上来自原材料钢厂炉号，候选上游：
 *   - ERP(管家婆 SQL Server)：采购入库/检验单的 Blockno(批号) / UserDefine* / Remark
 *   - MES(MySQL)：t_production_task.heat_number / steel_mill，及领料单类表
 *
 * 输出三块：
 *   A. ERP：所有含 Blockno 列的表 → 非空行数 + 样例值 + 关联物料；
 *      DlyNdxCheck/DlyCheck 全列清单 + 样例；名称像炉号/炉批的列全库检索
 *   B. MES：t_production_task 炉号填充率 + 样例；领料/发料类表清单及其炉号字段
 *   C. 关联性抽查：MES erp_bill_body_id 是否能回指 ERP 明细行（决定走哪条链）
 *
 * 用法：node tools/probe-heat-batch.cjs [--skip-erp|--skip-mes]
 * 只读：全部语句为 SELECT；ERP/MES 连接均只读账号。
 */
const path = require('path');
const infraModules = path.join(__dirname, '..', 'packages', 'infrastructure', 'node_modules');
require(path.join(infraModules, 'dotenv')).config({ path: path.join(__dirname, '..', '.env') });
const sql = require(path.join(infraModules, 'mssql'));
const mysql = require(path.join(infraModules, 'mysql2', 'promise'));

const SKIP_ERP = process.argv.includes('--skip-erp');
const SKIP_MES = process.argv.includes('--skip-mes');

const show = (label, rows, limit = 12) => {
  console.log(`\n=== ${label} ===`);
  const arr = Array.isArray(rows) ? rows : [rows];
  for (const r of arr.slice(0, limit)) console.log('  ' + JSON.stringify(r));
  if (arr.length > limit) console.log(`  ... 共 ${arr.length} 行，截断显示 ${limit}`);
};

async function probeErp() {
  const pool = await new sql.ConnectionPool({
    server: process.env.ERP_DB_HOST,
    port: parseInt(process.env.ERP_DB_PORT || '1433', 10),
    database: process.env.ERP_DB_NAME,
    user: process.env.ERP_DB_USER,
    password: process.env.ERP_DB_PASSWORD,
    options: { encrypt: true, trustServerCertificate: true, connectTimeout: 15000 },
  }).connect();
  console.log('=== ERP connected ===');

  // A1) 全库含 Blockno 列的表
  const blockTables = await pool.request().query(
    "SELECT TABLE_NAME, COUNT(*) AS colCnt FROM INFORMATION_SCHEMA.COLUMNS " +
      "WHERE COLUMN_NAME = 'Blockno' GROUP BY TABLE_NAME ORDER BY TABLE_NAME"
  );
  show('ERP: 含 Blockno 列的表', blockTables.recordset, 50);

  // A2) 每张含 Blockno 的表：非空行数（逐表 COUNT，表名已在上一步枚举，安全拼接）
  for (const t of blockTables.recordset.map((r) => r.TABLE_NAME)) {
    const stat = await pool.request().query(
      `SELECT COUNT(*) AS rowsTotal, ` +
        `SUM(CASE WHEN Blockno IS NOT NULL AND LTRIM(RTRIM(Blockno)) <> '' THEN 1 ELSE 0 END) AS withBlockno ` +
        `FROM [${t}]`
    );
    const s = stat.recordset[0];
    if (s.withBlockno > 0) {
      const sample = await pool.request().query(
        `SELECT TOP 5 Blockno FROM [${t}] WHERE Blockno IS NOT NULL AND LTRIM(RTRIM(Blockno)) <> ''`
      );
      console.log(
        `\n  [${t}] rows=${s.rowsTotal} withBlockno=${s.withBlockno} 样例: ` +
          sample.recordset.map((r) => r.Blockno).join(' | ')
      );
    } else {
      console.log(`\n  [${t}] rows=${s.rowsTotal} withBlockno=0（全空，跳过）`);
    }
  }

  // A3) 名称疑似炉号/炉批/炼钢的列，全库检索
  const heatCols = await pool.request().query(
    "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE " +
      "COLUMN_NAME LIKE '%heat%' OR COLUMN_NAME LIKE '%lu%' OR COLUMN_NAME LIKE '%furnace%' " +
      "OR COLUMN_NAME LIKE '%smelt%' OR COLUMN_NAME LIKE '%stove%' ORDER BY TABLE_NAME, COLUMN_NAME"
  );
  show('ERP: 列名疑似炉号的字段', heatCols.recordset, 50);

  // A4) 检验单 DlyNdxCheck / DlyCheck：列结构 + 非空统计 + 样例
  for (const t of ['DlyNdxCheck', 'DlyCheck']) {
    const cols = await pool.request()
      .input('t', sql.NVarChar, t)
      .query(
        'SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH AS LEN FROM INFORMATION_SCHEMA.COLUMNS ' +
          'WHERE TABLE_NAME = @t ORDER BY ORDINAL_POSITION'
      );
    console.log(`\n=== ${t} 列结构 (${cols.recordset.length} 列) ===`);
    for (const c of cols.recordset) {
      console.log(`    ${c.COLUMN_NAME} : ${c.DATA_TYPE}${c.LEN != null ? '(' + c.LEN + ')' : ''}`);
    }
    const cnt = await pool.request().query(`SELECT COUNT(*) AS n FROM [${t}]`);
    console.log(`    rows: ${cnt.recordset[0].n}`);
    if (cnt.recordset[0].n > 0) {
      const sample = await pool.request().query(`SELECT TOP 3 * FROM [${t}] ORDER BY 1 DESC`);
      show(`${t} 样例`, sample.recordset, 3);
    }
  }

  // A5) 采购入库单明细（进货单 VchType=11 -> Dly 或专用表）：找 Blockno 是否有值且形如炉号
  //     管家婆进货/收料明细常见表：Dly（含 VchType 归类）——先看含 Blockno 的 Dly 系表中谁的批号最像炉号
  const dlyDist = await pool.request().query(
    "SELECT TOP 20 Blockno, COUNT(*) AS n FROM DlyCheck " +
      "WHERE Blockno IS NOT NULL AND LTRIM(RTRIM(Blockno)) <> '' " +
      "GROUP BY Blockno ORDER BY n DESC"
  );
  show('ERP: DlyCheck.Blockno 值分布 TOP20', dlyDist.recordset, 20);

  await pool.close();
}

async function probeMes() {
  const pool = await mysql.createPool({
    host: process.env.MES_DB_HOST,
    port: parseInt(process.env.MES_DB_PORT || '3306', 10),
    database: process.env.MES_DB_NAME,
    user: process.env.MES_DB_USER,
    password: process.env.MES_DB_PASSWORD,
    charset: process.env.MES_DB_CHARSET || 'utf8mb4',
    connectionLimit: 2,
    connectTimeout: 15000,
  });
  console.log('\n=== MES connected ===');

  // B1) t_production_task 炉号填充率 + 样例
  const [taskStat] = await pool.query(
    "SELECT COUNT(*) AS total, " +
      "SUM(heat_number IS NOT NULL AND TRIM(heat_number) <> '') AS withHeat, " +
      "SUM(batch_no IS NOT NULL AND TRIM(batch_no) <> '') AS withBatch " +
      "FROM t_production_task WHERE del_flag = 0"
  );
  console.log('\n=== t_production_task 填充率 ===');
  console.log('  ' + JSON.stringify(taskStat[0]));

  const [taskSample] = await pool.query(
    "SELECT bill_no, work_no, batch_no, heat_number, steel_mill, material_code, " +
      "       erp_bill_no, erp_bill_head_id, erp_bill_body_id " +
      "  FROM t_production_task WHERE del_flag = 0 AND heat_number IS NOT NULL AND TRIM(heat_number) <> '' " +
      "  ORDER BY create_time DESC LIMIT 15"
  );
  show('MES: 有炉号的任务单样例', taskSample, 15);

  // B2) 领料/发料/出入库类表清单 + 是否含 heat/batch 列
  const [matTables] = await pool.query(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND (" +
      "TABLE_NAME LIKE '%requisition%' OR TABLE_NAME LIKE '%picking%' OR TABLE_NAME LIKE '%issue%' " +
      "OR TABLE_NAME LIKE '%stock%' OR TABLE_NAME LIKE '%material%' OR TABLE_NAME LIKE '%store%' " +
      "OR TABLE_NAME LIKE '%warehouse%' OR TABLE_NAME LIKE '%receive%' OR TABLE_NAME LIKE '%feed%') " +
      "ORDER BY TABLE_NAME"
  );
  show('MES: 领料/库存类候选表', matTables.map((r) => r.TABLE_NAME), 60);

  for (const r of matTables) {
    const t = r.TABLE_NAME;
    const [cols] = await pool.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() " +
        "AND TABLE_NAME = ? AND (COLUMN_NAME LIKE '%heat%' OR COLUMN_NAME LIKE '%batch%' " +
        "OR COLUMN_NAME LIKE '%furnace%' OR COLUMN_NAME LIKE '%lu_hao%' OR COLUMN_NAME LIKE '%steel%')",
      [t]
    );
    if (cols.length === 0) continue;
    const colNames = cols.map((c) => c.COLUMN_NAME);
    const [stat] = await pool.query(
      `SELECT COUNT(*) AS total FROM \`${t}\``
    );
    const counts = [];
    for (const c of colNames) {
      const [cc] = await pool.query(
        `SELECT COUNT(*) AS n FROM \`${t}\` WHERE \`${c}\` IS NOT NULL AND TRIM(\`${c}\`) <> ''`
      );
      if (cc[0].n > 0) {
        const [sv] = await pool.query(
          `SELECT \`${c}\` AS v FROM \`${t}\` WHERE \`${c}\` IS NOT NULL AND TRIM(\`${c}\`) <> '' LIMIT 3`
        );
        counts.push(`${c}: ${cc[0].n} 行 样例[${sv.map((x) => x.v).join(', ')}]`);
      }
    }
    console.log(`\n  [${t}] total=${stat[0].total} 炉号/批次相关列: ${colNames.join(', ')}`);
    for (const line of counts) console.log('    ' + line);
  }

  // B3) MES -> ERP 明细关联抽查：erp_bill_body_id 在非空时能否对上 DlyCheck/DlySale 的 Rec/Ndx
  const [linkRows] = await pool.query(
    "SELECT bill_no, heat_number, erp_bill_no, erp_bill_head_id, erp_bill_body_id " +
      "  FROM t_production_task WHERE del_flag = 0 " +
      "  AND erp_bill_body_id IS NOT NULL AND TRIM(erp_bill_body_id) <> '' LIMIT 10"
  );
  show('MES: 带 erp_bill_body_id 的任务（待 ERP 侧核对）', linkRows, 10);

  await pool.end();
}

async function main() {
  if (!SKIP_ERP) await probeErp();
  if (!SKIP_MES) await probeMes();
}

main().catch((e) => {
  console.error('ERR:', e && e.message ? e.message : e);
  process.exit(1);
});
