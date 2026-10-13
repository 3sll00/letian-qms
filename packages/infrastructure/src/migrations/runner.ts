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
import * as permissionManagementHardeningMigration from './013_permission_management_hardening.js';
import * as planCategoryFallbackMigration from './014_plan_category_fallback_and_effective_period.js';
import * as mrbPoolAndFlowWiringMigration from './015_mrb_pool_and_flow_wiring.js';
import * as planFieldAlignmentMigration from './016_inspection_plan_field_alignment.js';
import * as inspectionPlanCodeSequencesMigration from './017_inspection_plan_code_sequences.js';
import * as pendingPoolHardeningMigration from './018_pending_pool_hardening.js';
import * as reviewFlowFieldWiringMigration from './019_review_flow_field_wiring.js';
import * as traceNodeLineageFieldsMigration from './020_trace_node_lineage_fields.js';
import * as renameReceiptFieldsToInboundMigration from './021_rename_receipt_fields_to_inbound.js';
import * as backfillSupplierNameSnapshotMigration from './022_backfill_supplier_name_snapshot.js';
import * as backfillInspectionOrderSpecSnapshotMigration from './023_backfill_inspection_order_spec_snapshot.js';
import * as backfillIpqcLedgerFieldsMigration from './024_backfill_ipqc_ledger_fields.js';
import * as unifyInspectionOrderNumbersMigration from './025_unify_inspection_order_numbers.js';
import * as unifyMaterialCodesMigration from './026_unify_material_codes.js';
import * as unifyMachinedMaterialCategoryMigration from './027_unify_machined_material_category.js';
import * as unifyOutsourceReferencesMigration from './028_unify_outsource_references.js';
import * as companyProfileAndOrderApprovalMigration from './029_company_profile_and_order_approval.js';
import * as outsourceEntryFieldsMigration from './030_add_outsource_entry_fields.js';
import * as oqcFamilyInspectionPlanMigration from './031_add_oqc_family_inspection_plan.js';
import * as outsourceMachHeatPlansMigration from './032_add_outsource_mach_heat_plans.js';
import * as outsourceSfFamilyPlansMigration from './033_add_outsource_sf_family_plans.js';
import * as inspectionHeatTraceFieldsMigration from './034_add_inspection_heat_trace_fields.js';
import * as transferTraceFieldsMigration from './035_add_transfer_trace_fields.js';
import * as transferOverrideTicketsMigration from './036_add_transfer_override_tickets.js';
import * as testItemsDictionaryMigration from './037_add_test_items_dictionary.js';
import * as certTemplateFieldsMigration from './038_add_cert_template_fields.js';
import * as planInspectionTypesMigration from './039_add_plan_inspection_types.js';
import * as updateCompanyProfileNameMigration from './040_update_company_profile_name.js';
import * as erpCodeMappingMigration from './041_create_qms_erp_code_mapping.js';
import * as writeLogMigration from './042_create_qms_write_log.js';
import * as widenOrderKeyColsMigration from './043_widen_inspection_order_key_columns.js';
import * as widenOutboxAuditIdColsMigration from './044_widen_outbox_audit_id_columns.js';
import * as widenChainKeyColsMigration from './045_widen_chain_key_columns.js';
import * as materialCodeAliasMigration from './046_create_material_code_alias.js';
import * as backgroundOpsJobFieldsMigration from './047_background_ops_job_fields.js';
import * as employeePasswordHashMigration from './048_add_employee_password_hash.js';

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
      '013_permission_management_hardening': permissionManagementHardeningMigration,
      '014_plan_category_fallback_and_effective_period': planCategoryFallbackMigration,
      '015_mrb_pool_and_flow_wiring': mrbPoolAndFlowWiringMigration,
      '016_inspection_plan_field_alignment': planFieldAlignmentMigration,
      '017_inspection_plan_code_sequences': inspectionPlanCodeSequencesMigration,
      '018_pending_pool_hardening': pendingPoolHardeningMigration,
      '019_review_flow_field_wiring': reviewFlowFieldWiringMigration,
      '020_trace_node_lineage_fields': traceNodeLineageFieldsMigration,
      '021_rename_receipt_fields_to_inbound': renameReceiptFieldsToInboundMigration,
      '022_backfill_supplier_name_snapshot': backfillSupplierNameSnapshotMigration,
      '023_backfill_inspection_order_spec_snapshot': backfillInspectionOrderSpecSnapshotMigration,
      '024_backfill_ipqc_ledger_fields': backfillIpqcLedgerFieldsMigration,
      '025_unify_inspection_order_numbers': unifyInspectionOrderNumbersMigration,
      '026_unify_material_codes': unifyMaterialCodesMigration,
      '027_unify_machined_material_category': unifyMachinedMaterialCategoryMigration,
      '028_unify_outsource_references': unifyOutsourceReferencesMigration,
      '029_company_profile_and_order_approval': companyProfileAndOrderApprovalMigration,
      '030_add_outsource_entry_fields': outsourceEntryFieldsMigration,
      '031_add_oqc_family_inspection_plan': oqcFamilyInspectionPlanMigration,
      '032_add_outsource_mach_heat_plans': outsourceMachHeatPlansMigration,
      '033_add_outsource_sf_family_plans': outsourceSfFamilyPlansMigration,
      '034_add_inspection_heat_trace_fields': inspectionHeatTraceFieldsMigration,
      '035_add_transfer_trace_fields': transferTraceFieldsMigration,
      '036_add_transfer_override_tickets': transferOverrideTicketsMigration,
      '037_add_test_items_dictionary': testItemsDictionaryMigration,
      '038_add_cert_template_fields': certTemplateFieldsMigration,
      '039_add_plan_inspection_types': planInspectionTypesMigration,
      '040_update_company_profile_name': updateCompanyProfileNameMigration,
      '041_create_qms_erp_code_mapping': erpCodeMappingMigration,
      '042_create_qms_write_log': writeLogMigration,
      '043_widen_inspection_order_key_columns': widenOrderKeyColsMigration,
      '044_widen_outbox_audit_id_columns': widenOutboxAuditIdColsMigration,
      '045_widen_chain_key_columns': widenChainKeyColsMigration,
      '046_create_material_code_alias': materialCodeAliasMigration,
      '047_background_ops_job_fields': backgroundOpsJobFieldsMigration,
      '048_add_employee_password_hash': employeePasswordHashMigration,
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
