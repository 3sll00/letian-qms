import dotenv from 'dotenv';
dotenv.config();
import { getErpConnectionPool } from '../adapters/erp-pool.js';
import { db } from '../database/connection.js';

export async function syncErpMasterData() {
  console.log('=== [QMS Master Data Sync] Starting sync from GuanjiaPo ERP ===');
  const pool = await getErpConnectionPool();
  if (!pool) {
    console.error('Cannot connect to GuanjiaPo SQL Server.');
    return { success: false, syncedMaterials: 0, syncedSuppliers: 0, syncedWarehouses: 0 };
  }

  // 1. Sync Warehouses (Stock -> warehouses)
  console.log('-> Syncing Warehouses...');
  const stockResult = await pool.request().query(
    'SELECT typeId, UserCode, FullName, comment FROM Stock WHERE deleted = 0'
  );
  let syncedWarehouses = 0;
  for (const row of stockResult.recordset) {
    if (!row.UserCode) continue;
    try {
      await db
        .insertInto('warehouses')
        .values({
          warehouseCode: row.UserCode,
          warehouseName: row.FullName || row.UserCode,
          warehouseType: 'PHYSICAL',
          })
        .onConflict((oc) =>
          oc.column('warehouseCode').doUpdateSet({
            warehouseName: row.FullName || row.UserCode,
            comment: row.comment || null,
          })
        )
        .execute();
      syncedWarehouses++;
    } catch (err) {
      // ignore individual duplicate/constraint errors
    }
  }
  console.log("Synced done.");

  // 2. Sync Suppliers & Customers (Btype -> suppliers / customers)
  console.log('-> Syncing Partners (Suppliers/Customers)...');
  const btypeResult = await pool.request().query(
    'SELECT typeId, UserCode, FullName, TelAndAddress, Comment FROM Btype WHERE deleted = 0 AND sonnum = 0 AND UserCode IS NOT NULL AND UserCode <> \'\''
  );
  let syncedSuppliers = 0;
  for (const row of btypeResult.recordset) {
    try {
      await db
        .insertInto('suppliers')
        .values({
          supplierCode: row.UserCode,
          supplierName: row.FullName || row.UserCode,
          contactPerson: null, phone: row.TelAndAddress || null,
          })
        .onConflict((oc) =>
          oc.column('supplierCode').doUpdateSet({
            supplierName: row.FullName || row.UserCode,
            phone: row.TelAndAddress || null,
          })
        )
        .execute();
      syncedSuppliers++;
    } catch (err) {
      // ignore individual duplicate/constraint errors
    }
  }
  console.log("Synced done.");

  // 3. Sync Materials (Ptype -> materials)
  console.log('-> Syncing Materials (top 500 active leaf items)...');
  const ptypeResult = await pool.request().query(
    "SELECT TOP 500 typeId, UserCode, FullName, Standard, ISNULL(Unit1, '件') AS UnitName, comment FROM Ptype WHERE deleted = 0 AND sonnum = 0 AND UserCode IS NOT NULL AND UserCode <> '' ORDER BY typeId DESC"
  );
  let syncedMaterials = 0;
  for (const row of ptypeResult.recordset) {
    try {
      await db
        .insertInto('materials')
        .values({
          materialCode: row.UserCode,
          materialName: row.FullName || row.UserCode,
          specModel: row.Standard || null,
          unit: row.UnitName || '件',
          categoryCode: 'FASTENER',
          })
        .onConflict((oc) =>
          oc.column('materialCode').doUpdateSet({
            materialName: row.FullName || row.UserCode,
            specModel: row.Standard || null,
            unit: row.UnitName || '件',
            updatedAt: new Date(),
          })
        )
        .execute();
      syncedMaterials++;
    } catch (err) {
      // ignore
    }
  }
  console.log("Synced done.");

  console.log('=== [QMS Master Data Sync] Finished successfully ===');
  return { success: true, syncedMaterials, syncedSuppliers, syncedWarehouses };
}

if (process.argv[1]?.includes('sync-master-data')) {
  syncErpMasterData().then(() => process.exit(0)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
