const m = 'D:/乐天/letian-qms/packages/infrastructure/node_modules';
require(m + '/dotenv').config({ path: 'D:/乐天/letian-qms/.env' });
const pg = require(m + '/pg');
(async () => {
  const pool = new pg.Pool({ host: process.env.DB_HOST || 'localhost', port: +process.env.DB_PORT, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='inspection_orders' ORDER BY ordinal_position`);
  console.log(cols.rows.map(r=>r.column_name).join(', '));
  await pool.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
