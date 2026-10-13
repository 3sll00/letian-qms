import dotenv from 'dotenv';
dotenv.config({ path: 'D:/乐天/letian-qms/.env' });
import pg from 'pg';
async function main() {
  const pool = new pg.Pool({ host: process.env.DB_HOST || 'localhost', port: +process.env.DB_PORT, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  const r = await pool.query(`SELECT order_no, inspection_type, work_order_no, batch_no, material_code, furnace_heat_batch_no, status FROM inspection_orders ORDER BY order_no`);
  console.log('total orders:', r.rowCount);
  r.rows.forEach(o => console.log(JSON.stringify(o)));
  const agg = await pool.query(`SELECT inspection_type, count(*) total, count(work_order_no) filter (where work_order_no is not null and work_order_no<>'') withWo, count(*) filter (where furnace_heat_batch_no is not null and furnace_heat_batch_no<>'') withHeat FROM inspection_orders GROUP BY inspection_type ORDER BY inspection_type`);
  console.log('by type:'); agg.rows.forEach(o => console.log(' ', JSON.stringify(o)));
  const nodes = await pool.query(`SELECT batch_no, furnace_heat_batch_no, stage_name, node_status FROM batch_trace_nodes ORDER BY batch_no LIMIT 30`);
  console.log('trace nodes:', nodes.rowCount); nodes.rows.forEach(o => console.log(' ', JSON.stringify(o)));
  await pool.end();
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
