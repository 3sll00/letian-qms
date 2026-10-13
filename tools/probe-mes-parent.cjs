const path = require('path');
const m = path.join('D:/乐天/letian-qms/packages/infrastructure/node_modules');
require(path.join(m,'dotenv')).config({path:'D:/乐天/letian-qms/.env'});
const mysql = require(path.join(m,'mysql2','promise'));
(async () => {
  const p = await mysql.createPool({host:process.env.MES_DB_HOST,port:+process.env.MES_DB_PORT,database:process.env.MES_DB_NAME,user:process.env.MES_DB_USER,password:process.env.MES_DB_PASSWORD,connectionLimit:2});
  // 1. parent_task_id 填充率 + 父任务炉号
  const [a] = await p.query("SELECT COUNT(*) total, SUM(parent_task_id IS NOT NULL AND parent_task_id<>'') withParent FROM t_production_task WHERE del_flag=0");
  console.log('parent fill:', JSON.stringify(a[0]));
  // 2. 子任务无炉号但父任务有炉号的数量（谱系回溯可达率）
  const [b] = await p.query("SELECT COUNT(*) n FROM t_production_task c JOIN t_production_task p ON c.parent_task_id=p.id WHERE c.del_flag=0 AND p.del_flag=0 AND (c.heat_number IS NULL OR c.heat_number='') AND p.heat_number IS NOT NULL AND p.heat_number<>''");
  console.log('child-no-heat but parent-has:', JSON.stringify(b[0]));
  // 3. 带炉号任务的工序类型分布（task 本身无工序列，用 route_name 近似）
  const [c] = await p.query("SELECT route_name, COUNT(*) n, SUM(heat_number IS NOT NULL AND heat_number<>'') withHeat FROM t_production_task WHERE del_flag=0 GROUP BY route_name ORDER BY n DESC LIMIT 15");
  console.log('tasks by route:');
  c.forEach(r=>console.log('  '+JSON.stringify(r)));
  // 4. 炉号→物料 多对一抽查：同一炉号出现在多少不同物料任务上
  const [d] = await p.query("SELECT heat_number, steel_mill, COUNT(DISTINCT material_code) mats, COUNT(*) tasks FROM t_production_task WHERE del_flag=0 AND heat_number IS NOT NULL AND heat_number<>'' GROUP BY heat_number, steel_mill ORDER BY tasks DESC LIMIT 10");
  console.log('heat->materials top:');
  d.forEach(r=>console.log('  '+JSON.stringify(r)));
  await p.end();
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});
