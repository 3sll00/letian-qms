import { Kysely, sql } from 'kysely';

/**
 * 004 —— 会议决议与 v2.6.0 扩展：
 * 1. 质检方案扩展：分类关联与有效周期
 * 2. 检验工单扩展：免检标记、炉批号与继承留痕
 * 3. 待审核池扩展：MRB 待审核工单表 pending_mrb_items
 * 4. 质检报告模板管理表 report_templates
 * 5. 管家婆与外部系统映射表 external_document_mappings
 * 6. 委外 13 张表镜像/映射结构与七分类支持
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. inspection_plans 扩充字段
  await sql`
    ALTER TABLE inspection_plans
      ADD COLUMN IF NOT EXISTS category_id VARCHAR(64),
      ADD COLUMN IF NOT EXISTS category_name VARCHAR(128),
      ADD COLUMN IF NOT EXISTS is_category_default BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ;
  `.execute(db);

  // 2. inspection_orders 扩充炉批号与留痕字段
  await sql`
    ALTER TABLE inspection_orders
      ADD COLUMN IF NOT EXISTS furnace_heat_batch_no VARCHAR(64),
      ADD COLUMN IF NOT EXISTS is_exempt_order BOOLEAN NOT NULL DEFAULT false;
  `.execute(db);

  // 3. 不合格待审核池表 pending_mrb_items
  await sql`
    CREATE TABLE IF NOT EXISTS pending_mrb_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      source_order_id VARCHAR(64) NOT NULL,
      source_order_no VARCHAR(64) NOT NULL,
      source_stage VARCHAR(32) NOT NULL,
      material_code VARCHAR(64) NOT NULL,
      material_name VARCHAR(255) NOT NULL,
      batch_no VARCHAR(64) NOT NULL,
      defect_qty NUMERIC NOT NULL,
      defect_rate NUMERIC NOT NULL,
      fail_reason TEXT NOT NULL,
      failed_items JSONB NOT NULL DEFAULT '[]',
      status VARCHAR(32) NOT NULL DEFAULT 'PENDING_REVIEW',
      mrb_review_id VARCHAR(64),
      review_started_at TIMESTAMPTZ,
      review_started_by VARCHAR(64),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pending_mrb_status ON pending_mrb_items(status);
    CREATE INDEX IF NOT EXISTS idx_pending_mrb_order ON pending_mrb_items(source_order_no);
  `.execute(db);

  // 4. 质检报告模板表 report_templates
  await sql`
    CREATE TABLE IF NOT EXISTS report_templates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      template_code VARCHAR(64) NOT NULL UNIQUE,
      template_name VARCHAR(128) NOT NULL,
      template_type VARCHAR(32) NOT NULL DEFAULT 'INSPECTION_GENERAL',
      applicable_types JSONB NOT NULL DEFAULT '["IQC", "IPQC", "FQC", "OQC"]',
      is_default BOOLEAN NOT NULL DEFAULT false,
      is_active BOOLEAN NOT NULL DEFAULT true,
      layout_config JSONB NOT NULL DEFAULT '{}',
      supported_formats JSONB NOT NULL DEFAULT '["PDF", "EXCEL"]',
      sections_included JSONB NOT NULL DEFAULT '["APPEARANCE", "DIMENSION", "MECHANICAL_PERFORMANCE", "CHEMICAL_COMPOSITION"]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `.execute(db);

  // 插入系统初始模板
  await sql`
    INSERT INTO report_templates (template_code, template_name, template_type, applicable_types, is_default, sections_included)
    VALUES
      ('TPL_GENERAL_FOUR_STAGE', '紧固件标准四段式质检报告模板', 'INSPECTION_GENERAL', '["IQC", "IPQC", "FQC", "OQC"]', true, '["APPEARANCE", "DIMENSION", "MECHANICAL_PERFORMANCE", "CHEMICAL_COMPOSITION"]'),
      ('TPL_OUTSOURCE_HEAT', '委外热处理/表面处理专用质检报告模板', 'OUTSOURCE_SPECIAL', '["OUTSOURCE"]', true, '["APPEARANCE", "DIMENSION", "MECHANICAL_PERFORMANCE", "CHEMICAL_COMPOSITION"]'),
        ('TPL_COA_RAW', '原材料 COA 理化检验报告模板', 'SUPPLIER_COA', '["IQC"]', false, '["APPEARANCE", "DIMENSION", "MECHANICAL_PERFORMANCE", "CHEMICAL_COMPOSITION"]')
    ON CONFLICT (template_code) DO NOTHING;
  `.execute(db);

  // 5. 外部系统单据关联映射表 external_document_mappings (管家婆选单与溯源)
  await sql`
    CREATE TABLE IF NOT EXISTS external_document_mappings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      external_system VARCHAR(32) NOT NULL,
      external_bill_type VARCHAR(64) NOT NULL,
      external_bill_no VARCHAR(64) NOT NULL,
      external_entry_id VARCHAR(64),
      local_aggregate_type VARCHAR(64) NOT NULL,
      local_aggregate_id VARCHAR(64) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'BOUND',
      mapping_metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ext_doc_lookup ON external_document_mappings(external_system, external_bill_type, external_bill_no);
    CREATE INDEX IF NOT EXISTS idx_local_doc_lookup ON external_document_mappings(local_aggregate_type, local_aggregate_id);
  `.execute(db);

  // 6. 委外 13 张表挂载与数据分类回写配置表 outsource_table_registry
  await sql`
    CREATE TABLE IF NOT EXISTS outsource_table_registries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      table_code VARCHAR(64) NOT NULL UNIQUE,
      table_name VARCHAR(128) NOT NULL,
      category VARCHAR(32) NOT NULL,
      write_back_target_table VARCHAR(128) NOT NULL,
      mapping_rules JSONB NOT NULL DEFAULT '{}',
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `.execute(db);

  // 7. 仓库档案表 warehouses（对齐管家婆 Stock 档案结构）
  await sql`
    CREATE TABLE IF NOT EXISTS warehouses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_code VARCHAR(64) NOT NULL UNIQUE,
      warehouse_name VARCHAR(128) NOT NULL,
      warehouse_type VARCHAR(32) NOT NULL DEFAULT 'RAW_MATERIAL',
      location VARCHAR(255),
      manager_name VARCHAR(64),
      is_active BOOLEAN NOT NULL DEFAULT true,
      comment TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_warehouses_code ON warehouses(warehouse_code);
  `.execute(db);

  // 8. 操作审计日志 GIN 索引（加速 diff_patch JSONB 下钻查询）
  await sql`
    CREATE INDEX IF NOT EXISTS idx_audit_logs_diff_patch_gin ON audit_logs USING gin (diff_patch);
  `.execute(db);

}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_audit_logs_diff_patch_gin`.execute(db);
  await sql`DROP TABLE IF EXISTS warehouses`.execute(db);
  await sql`DROP TABLE IF EXISTS outsource_table_registries`.execute(db);
  await sql`DROP TABLE IF EXISTS external_document_mappings`.execute(db);
  await sql`DROP TABLE IF EXISTS report_templates`.execute(db);
  await sql`DROP TABLE IF EXISTS pending_mrb_items`.execute(db);
  await sql`
    ALTER TABLE inspection_orders
      DROP COLUMN IF EXISTS furnace_heat_batch_no,
      DROP COLUMN IF EXISTS is_exempt_order;
  `.execute(db);
  await sql`
    ALTER TABLE inspection_plans
      DROP COLUMN IF EXISTS category_id,
      DROP COLUMN IF EXISTS category_name,
      DROP COLUMN IF EXISTS is_category_default,
      DROP COLUMN IF EXISTS valid_from,
      DROP COLUMN IF EXISTS valid_to;
  `.execute(db);
}
