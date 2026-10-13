import dotenv from 'dotenv';
dotenv.config();
import { getErpConnectionPool } from '../adapters/erp-pool.js';
import { createMssqlErpReads } from '../sync/erp-reads.js';
import { writeFileSync } from 'fs';

async function main() {
  const pool = await getErpConnectionPool();
  if (!pool) {
    console.log('ERP_UNREACHABLE');
    return;
  }
  const reads = createMssqlErpReads(pool);
  const rows = await reads.fetchIncomingInspections(20000);
  const erpCodes = [...new Set(rows.map((r) => r.ptypeUserCode).filter(Boolean))];
  writeFileSync('/tmp/erp_codes.json', JSON.stringify(erpCodes));
  console.log('ERP_ROWS=' + rows.length + ' ERP_DISTINCT_MATERIALS=' + erpCodes.length);
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('ERR', e);
    process.exit(1);
  });
