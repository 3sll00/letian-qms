import dotenv from 'dotenv';
dotenv.config();
import { closeErpConnectionPool, getErpConnectionPool } from '../adapters/erp-pool.js';

async function main() {
  const pool = await getErpConnectionPool();
  if (!pool) throw new Error('ERP 不可用');
  const fromArg = process.argv.slice(2)[0];
  const vcs = fromArg ? fromArg.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0) : [9639, 9640];
  const inList = vcs.join(', ');
  const hdr = await pool.request().query<{ VchType: number; NUMBER: string; Vchcode: number; Draft: number; period: number; DATE: string }>(
    `SELECT VchType, NUMBER, Vchcode, Draft, period, DATE FROM DlyNdxCheck WHERE Vchcode IN (${inList}) ORDER BY VchType`,
  );
  console.log('HEADERS:', JSON.stringify(hdr.recordset, null, 2));
  const dtl = await pool.request().query<{ Vchcode: number; VchType: number; RowNo: number; Qty: number; Qty2: number; Qty3: number; Blockno: string | null; QMReason: string | null }>(
    `SELECT Vchcode, VchType, RowNo, Qty, Qty2, Qty3, Blockno, QMReason FROM DlyCheck WHERE Vchcode IN (${inList}) ORDER BY VchType, RowNo`,
  );
  console.log('DETAILS:', JSON.stringify(dtl.recordset, null, 2));
  await closeErpConnectionPool();
  process.exit(0);
}
main().catch((e) => {
  console.error('PROBE_ERR:', e);
  process.exit(1);
});
