/* 补充探查：MES 任务-检验单关联与 ERP 回指列填充率（只读） */
const path = require('path');
const m = path.join(__dirname, '..', 'packages', 'infrastructure', 'node_modules');
require(path.join(m, 'dotenv')).config({ path: path.join(__dirname, '..', '.env') });
const mysql = require(path.join(m, 'mysql2', 'promise'));

(async () => {
  const p = await mysql.createPool({
    host: process.env.MES_DB_HOST,
    port: parseInt(process.env.MES_DB_PORT || '3306', 10),
    database: process.env.MES_DB_NAME,
    user: process.env.MES_DB_USER,
    password: process.env.MES_DB_PASSWORD,
    connectionLimit: 2,
  });

  const [a] = await p.query(
    "SELECT COUNT(*) total, SUM(erp_bill_no IS NOT NULL AND erp_bill_no<>'') withErpNo, " +
      "SUM(erp_bill_head_id IS NOT NULL AND erp_bill_head_id<>'') withHead, " +
      "SUM(erp_bill_body_id IS NOT NULL AND erp_bill_body_id<>'') withBody " +
      "FROM t_production_task WHERE del_flag=0"
  );
  console.log('task erp-link fill:', JSON.stringify(a[0]));

  const [b] = await p.query("SELECT COUNT(*) total FROM t_check_report WHERE del_flag=0");
  console.log('check_report total:', JSON.stringify(b[0]));

  const [c] = await p.query(
    "SELECT COUNT(*) n FROM t_check_report r JOIN t_production_task t ON r.task_id=t.id " +
      "WHERE r.del_flag=0 AND t.del_flag=0 AND t.heat_number IS NOT NULL AND t.heat_number<>''"
  );
  console.log('check_report joined task with heat:', JSON.stringify(c[0]));

  const [d] = await p.query(
    "SELECT r.bill_no rep_no, t.bill_no task_no, t.work_no, t.heat_number, t.steel_mill, m.code mat " +
      "FROM t_check_report r JOIN t_production_task t ON r.task_id=t.id " +
      "LEFT JOIN t_materiel m ON r.materiel_id=m.id " +
      "WHERE r.del_flag=0 AND t.del_flag=0 AND t.heat_number IS NOT NULL AND t.heat_number<>'' " +
      "ORDER BY r.create_time DESC LIMIT 10"
  );
  console.log('joinable sample:');
  d.forEach((r) => console.log('  ' + JSON.stringify(r)));

  // 工序分布：检验单关联工序名 → QMS IPQC 类型映射的可行性
  const [e] = await p.query(
    "SELECT p.name proc, COUNT(*) n, SUM(t.heat_number IS NOT NULL AND t.heat_number<>'') withHeat " +
      "FROM t_check_report r JOIN t_production_task t ON r.task_id=t.id " +
      "LEFT JOIN t_procedure p ON r.procedure_id=p.id " +
      "WHERE r.del_flag=0 AND t.del_flag=0 GROUP BY p.name ORDER BY n DESC LIMIT 20"
  );
  console.log('check_report by procedure:');
  e.forEach((r) => console.log('  ' + JSON.stringify(r)));

  await p.end();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
