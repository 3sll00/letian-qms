const m = 'D:/乐天/letian-qms/packages/infrastructure/node_modules';
require(m + '/dotenv').config({ path: 'D:/乐天/letian-qms/.env' });
const pg = require(m + '/pg');
const mysql = require(m + '/mysql2/promise');
(async () => {
  const pgp = new pg.Pool({ host: process.env.DB_HOST || 'localhost', port: +process.env.DB_PORT, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  const orders = await pgp.query(`SELECT order_no, order_type, work_order_no FROM inspection_orders WHERE order_type IN ('IPQC_FN','IPQC_CT','IPQC_RL') AND work_order_no IS NOT NULL AND work_order_no<>''`);
  console.log('ipqc orders with wo:', orders.rowCount);
  const mes = await mysql.createPool({ host: process.env.MES_DB_HOST, port: +process.env.MES_DB_PORT, database: process.env.MES_DB_NAME, user: process.env.MES_DB_USER, password: process.env.MES_DB_PASSWORD, connectionLimit: 3 });
  const [tasks] = await mes.query(`SELECT bill_no, work_no, heat_number, steel_mill, material_code FROM t_production_task WHERE del_flag=0`);
  const byBill = new Map(), byWork = new Map();
  let dupBill = 0;
  for (const t of tasks) {
    if (t.bill_no) { if (byBill.has(t.bill_no)) dupBill++; byBill.set(t.bill_no, t); }
    if (t.work_no) byWork.set(t.work_no, t);
  }
  console.log('mes tasks:', tasks.length, 'dup bill_no:', dupBill);
  let hitBill=0, hitWork=0, hitHeat=0, hitNoHeat=0, miss=0;
  const byType = {};
  const misses = [];
  for (const o of orders.rows) {
    const t = byBill.get(o.work_order_no) || byWork.get(o.work_order_no);
    const k = o.order_type;
    byType[k] = byType[k] || {total:0,hit:0,heat:0};
    byType[k].total++;
    if (!t) { miss++; byType[k]; if (misses.length<8) misses.push(o.order_no+'/'+o.work_order_no); continue; }
    if (byBill.get(o.work_order_no)) hitBill++; else hitWork++;
    byType[k].hit++;
    if (t.heat_number && String(t.heat_number).trim()!=='') { hitHeat++; byType[k].heat++; } else hitNoHeat++;
  }
  console.log('join: billHit='+hitBill+' workHit='+hitWork+' withHeat='+hitHeat+' hitNoHeat='+hitNoHeat+' miss='+miss);
  console.log('byType:', JSON.stringify(byType));
  console.log('miss samples:', misses.join(' | '));
  await pgp.end(); await mes.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
