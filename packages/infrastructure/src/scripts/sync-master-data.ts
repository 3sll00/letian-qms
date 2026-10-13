import dotenv from 'dotenv';
dotenv.config();
import { getErpConnectionPool } from '../adapters/erp-pool.js';
import { db } from '../database/connection.js';

export async function syncErpMasterData() {
  console.log('=== [QMS Master Data Sync] Starting sync from GuanjiaPo ERP ===');
  const pool = await getErpConnectionPool();
  if (!pool) {
    console.error('Cannot connect to GuanjiaPo SQL Server.');
    return { success: false, syncedMaterials: 0, syncedSuppliers: 0, syncedCustomers: 0, syncedWarehouses: 0 };
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

  // 2. Sync Partners (Btype -> suppliers / customers)，按 isclient 分流：
  //    isclient=0 → suppliers 表；isclient=1 → customers 表。
  //    ⚠️ 旧实现未分流，把客户也误写进 suppliers 表；现已修正为客户落 customers。
  console.log('-> Syncing Partners (Suppliers/Customers)...');
  const btypeResult = await pool.request().query(
    "SELECT typeId, UserCode, FullName, Person, TelAndAddress, Comment, isclient FROM Btype WHERE deleted = 0 AND sonnum = 0 AND UserCode IS NOT NULL AND UserCode <> ''"
  );
  let syncedSuppliers = 0;
  let syncedCustomers = 0;
  for (const row of btypeResult.recordset) {
    const isClient = row.isclient === 1 || row.isclient === true;
    try {
      if (isClient) {
        await db
          .insertInto('customers')
          .values({
            customerCode: row.UserCode,
            customerName: row.FullName || row.UserCode,
            contactPerson: row.Person || null,
            phone: row.TelAndAddress || null,
          })
          .onConflict((oc) =>
            oc.column('customerCode').doUpdateSet({
              customerName: row.FullName || row.UserCode,
              contactPerson: row.Person || null,
              phone: row.TelAndAddress || null,
            })
          )
          .execute();
        syncedCustomers++;
      } else {
        await db
          .insertInto('suppliers')
          .values({
            supplierCode: row.UserCode,
            supplierName: row.FullName || row.UserCode,
            contactPerson: row.Person || null,
            phone: row.TelAndAddress || null,
          })
          .onConflict((oc) =>
            oc.column('supplierCode').doUpdateSet({
              supplierName: row.FullName || row.UserCode,
              contactPerson: row.Person || null,
              phone: row.TelAndAddress || null,
            })
          )
          .execute();
        syncedSuppliers++;
      }
    } catch (err) {
      // ignore individual duplicate/constraint errors
    }
  }
  console.log("Synced done.");

  // 3. Sync Materials (Ptype -> materials)
  //    精准同步：只拉「检验单实际涉及」的叶子物料（DlyCheck 出现的 Ptype），
  //    避免把 ERP 全量 2.4 万物料灌进 QMS；UserCode 即 materialCode，
  //    与来料检验拉取（fetchIncomingInspections 的 ptypeUserCode）口径一致，
  //    从而保证 ERP -> QMS 来料建单时物料编码能对应上。
  console.log('-> Syncing Materials (inspection-referenced leaf items)...');
  const ptypeResult = await pool.request().query(
    "SELECT DISTINCT p.typeId, p.UserCode, p.FullName, p.Standard, ISNULL(p.Unit1, '件') AS UnitName, p.comment " +
      "FROM Ptype p " +
      "JOIN DlyCheck d ON d.PtypeId = p.typeId " +
      "WHERE p.deleted = 0 AND p.sonnum = 0 AND p.UserCode IS NOT NULL AND p.UserCode <> '' " +
      "  AND d.PtypeId IS NOT NULL AND d.PtypeId <> ''"
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
  return { success: true, syncedMaterials, syncedSuppliers, syncedCustomers, syncedWarehouses };
}

if (process.argv[1]?.includes('sync-master-data')) {
  syncErpMasterData().then(() => process.exit(0)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
