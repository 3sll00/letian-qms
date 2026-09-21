import { Migrator, Migration, MigrationProvider } from 'kysely';
import { getDatabase } from '../database/connection.js';
import * as initMigration from './001_init_qms_tables.js';
import * as alignToContractsMigration from './002_align_schema_to_contracts.js';
import * as permissionManagementMigration from './003_permission_management.js';
import * as v26FeaturesMigration from './004_v26_extensibility_features.js';
import * as erpExtendedFieldsMigration from './005_erp_extended_fields.js';
import * as incomingReceiptFieldsMigration from './006_add_incoming_receipt_fields.js';
import * as ipqcProcessInspectionMigration from './007_add_ipqc_process_inspection_fields.js';
import * as oqcShipmentInspectionMigration from './008_add_oqc_shipment_inspection_fields.js';
import * as outsourceProcessInspectionMigration from './009_add_outsource_process_inspection_fields.js';
import * as alignInspectorNameMigration from './010_align_inspector_name_with_employees.js';
import * as backfillOutsourceVendorNameMigration from './011_backfill_outsource_vendor_name.js';
import * as inspectionOrderNoSequencesMigration from './012_inspection_order_no_sequences.js';

class DynamicMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return {
      '001_init_qms_tables': initMigration,
      '002_align_schema_to_contracts': alignToContractsMigration,
      '003_permission_management': permissionManagementMigration,
      '004_v26_extensibility_features': v26FeaturesMigration,
      '005_erp_extended_fields': erpExtendedFieldsMigration,
      '006_add_incoming_receipt_fields': incomingReceiptFieldsMigration,
      '007_add_ipqc_process_inspection_fields': ipqcProcessInspectionMigration,
      '008_add_oqc_shipment_inspection_fields': oqcShipmentInspectionMigration,
      '009_add_outsource_process_inspection_fields': outsourceProcessInspectionMigration,
      '010_align_inspector_name_with_employees': alignInspectorNameMigration,
      '011_backfill_outsource_vendor_name': backfillOutsourceVendorNameMigration,
      '012_inspection_order_no_sequences': inspectionOrderNoSequencesMigration,
    };
  }
}

export async function runMigrations(direction: 'up' | 'down' = 'up'): Promise<void> {
  const db = getDatabase();

  const migrator = new Migrator({
    db,
    provider: new DynamicMigrationProvider(),
  });

  if (direction === 'up') {
    console.log('[Migrator] Running migrations UP...');
    const { error, results } = await migrator.migrateToLatest();

    results?.forEach((it) => {
      if (it.status === 'Success') {
        console.log(`[Migrator] Migration "${it.migrationName}" was executed successfully.`);
      } else if (it.status === 'Error') {
        console.error(`[Migrator] Failed to execute migration "${it.migrationName}".`);
      }
    });

    if (error) {
      console.error('[Migrator] Failed to migrate:', error);
      process.exit(1);
    }
  } else {
    console.log('[Migrator] Running migration DOWN (step 1)...');
    const { error, results } = await migrator.migrateDown();

    results?.forEach((it) => {
      if (it.status === 'Success') {
        console.log(`[Migrator] Migration "${it.migrationName}" was reverted successfully.`);
      } else if (it.status === 'Error') {
        console.error(`[Migrator] Failed to revert migration "${it.migrationName}".`);
      }
    });

    if (error) {
      console.error('[Migrator] Failed to revert:', error);
      process.exit(1);
    }
  }
}

// 命令行直接调用支持: tsx src/migrations/runner.ts [up|down]
const entryScript = process.argv[1] ?? '';
if (/[\\/]runner\.(ts|js|mjs|cjs)$/.test(entryScript)) {
  const direction = process.argv[2] === 'down' ? 'down' : 'up';
  runMigrations(direction)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[Migrator] Fatal migration error:', err);
      process.exit(1);
    });
}
