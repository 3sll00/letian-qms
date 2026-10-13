const m = 'D:/乐天/letian-qms/packages/infrastructure/node_modules';
require(m + '/dotenv').config({ path: 'D:/乐天/letian-qms/.env' });
const pg = require(m + '/pg');
(async () => {
  const pool = new pg.Pool({ host: process.env.DB_HOST || 'localhost', port: +process.env.DB_PORT, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  const agg = await pool.query(`SELECT order_type, count(*) total, count(*) filter (where furnace_heat_batch_no is not null and furnace_heat_batch_no<>'') withHeat FROM inspection_orders GROUP BY order_type ORDER BY order_type`);
  console.log('heat coverage by type:'); agg.rows.forEach(o => console.log(' ', JSON.stringify(o)));
  const aud = await pool.query(`SELECT count(*) n FROM audit_logs WHERE operator_id='system:backfill-furnace-heat' AND action='UPDATE' AND status='SUCCESS'`);
  console.log('backfill audit rows:', aud.rows[0].n);
  const node = await pool.query(`SELECT batch_no, furnace_heat_batch_no, stage_name, node_status FROM batch_trace_nodes WHERE furnace_heat_batch_no IS NOT NULL LIMIT 5`);
  console.log('synced nodes:'); node.rows.forEach(o => console.log(' ', JSON.stringify(o)));
  const sample = await pool.query(`SELECT order_no, furnace_heat_batch_no, heat_source_type, heat_source_order_no FROM inspection_orders WHERE furnace_heat_batch_no IS NOT NULL ORDER BY order_no DESC LIMIT 5`);
  sample.rows.forEach(o => console.log('order:', JSON.stringify(o)));
  await pool.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
