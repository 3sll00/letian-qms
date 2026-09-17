import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // 0. 开启 uuid-ossp 扩展
  await sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`.execute(db);

  // 1. materials 表
  await sql`
    CREATE TABLE IF NOT EXISTS materials (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      material_code VARCHAR(64) UNIQUE NOT NULL,
      material_name VARCHAR(255) NOT NULL,
      spec_model VARCHAR(255),
      category_code VARCHAR(64) NOT NULL,
      unit VARCHAR(32) NOT NULL DEFAULT 'PCS',
      confidentiality_level SMALLINT NOT NULL DEFAULT 1 CHECK (confidentiality_level BETWEEN 1 AND 4),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  await sql`CREATE INDEX IF NOT EXISTS idx_materials_category ON materials(category_code)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_materials_confidentiality ON materials(confidentiality_level)`.execute(db);

  // 2. inventory_categories 表
  await sql`
    CREATE TABLE IF NOT EXISTS inventory_categories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      category_code VARCHAR(64) UNIQUE NOT NULL,
      category_name VARCHAR(128) NOT NULL,
      parent_code VARCHAR(64),
      level SMALLINT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  // 3. suppliers 表
  await sql`
    CREATE TABLE IF NOT EXISTS suppliers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      supplier_code VARCHAR(64) UNIQUE NOT NULL,
      supplier_name VARCHAR(255) NOT NULL,
      contact_person VARCHAR(64),
      phone VARCHAR(64),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  // 4. customers 表
  await sql`
    CREATE TABLE IF NOT EXISTS customers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_code VARCHAR(64) UNIQUE NOT NULL,
      customer_name VARCHAR(255) NOT NULL,
      contact_person VARCHAR(64),
      phone VARCHAR(64),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  // 5. workshops 表
  await sql`
    CREATE TABLE IF NOT EXISTS workshops (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workshop_code VARCHAR(64) UNIQUE NOT NULL,
      workshop_name VARCHAR(128) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  // 6. employees 表
  await sql`
    CREATE TABLE IF NOT EXISTS employees (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_code VARCHAR(64) UNIQUE NOT NULL,
      name VARCHAR(64) NOT NULL,
      department VARCHAR(128),
      phone VARCHAR(64),
      email VARCHAR(128),
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  // 7. inspection_plans 表
  await sql`
    CREATE TABLE IF NOT EXISTS inspection_plans (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_code VARCHAR(64) NOT NULL,
      plan_name VARCHAR(255) NOT NULL,
      material_code VARCHAR(64) NOT NULL,
      version VARCHAR(32) NOT NULL DEFAULT 'v1.0.0',
      version_status VARCHAR(32) NOT NULL DEFAULT 'DRAFT' CHECK (version_status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
      inspection_stage VARCHAR(32) NOT NULL CHECK (inspection_stage IN ('IQC', 'IPQC', 'FQC', 'OQC')),
      items JSONB NOT NULL DEFAULT '[]'::jsonb,
      sampling_config JSONB NOT NULL DEFAULT '{}'::jsonb,
      workshop_code VARCHAR(64),
      confidentiality_level SMALLINT NOT NULL DEFAULT 1 CHECK (confidentiality_level BETWEEN 1 AND 4),
      created_by VARCHAR(64) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_plan_code_version UNIQUE (plan_code, version)
    )
  `.execute(db);

  await sql`CREATE INDEX IF NOT EXISTS idx_plans_material ON inspection_plans(material_code)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_plans_status ON inspection_plans(version_status)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_plans_stage ON inspection_plans(inspection_stage)`.execute(db);

  // 8. inspection_orders 表
  await sql`
    CREATE TABLE IF NOT EXISTS inspection_orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_no VARCHAR(64) UNIQUE NOT NULL,
      order_type VARCHAR(32) NOT NULL CHECK (order_type IN ('IQC', 'IPQC', 'FQC', 'OQC')),
      plan_id UUID NOT NULL,
      batch_no VARCHAR(64) NOT NULL,
      material_code VARCHAR(64) NOT NULL,
      supplier_code VARCHAR(64),
      workshop_code VARCHAR(64),
      inspector_id VARCHAR(64),
      total_qty NUMERIC(15, 4) NOT NULL,
      sample_qty NUMERIC(15, 4) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'INSPECTING', 'COMPLETED', 'CANCELLED')),
      judgment VARCHAR(32) NOT NULL DEFAULT 'PENDING' CHECK (judgment IN ('QUALIFIED', 'UNQUALIFIED', 'CONCESSION', 'PENDING')),
      measured_values JSONB NOT NULL DEFAULT '{}'::jsonb,
      defect_details JSONB NOT NULL DEFAULT '[]'::jsonb,
      confidentiality_level SMALLINT NOT NULL DEFAULT 1 CHECK (confidentiality_level BETWEEN 1 AND 4),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  await sql`CREATE INDEX IF NOT EXISTS idx_orders_batch ON inspection_orders(batch_no)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_orders_material ON inspection_orders(material_code)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_orders_status ON inspection_orders(status)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_orders_judgment ON inspection_orders(judgment)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_orders_workshop ON inspection_orders(workshop_code)`.execute(db);

  // 9. review_flows 表
  await sql`
    CREATE TABLE IF NOT EXISTS review_flows (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      flow_code VARCHAR(64) NOT NULL,
      flow_name VARCHAR(128) NOT NULL,
      applicable_type VARCHAR(64) NOT NULL CHECK (applicable_type IN ('INCOMING_FAIL', 'PROCESS_FAIL', 'SHIPMENT_FAIL', 'SUBCONTRACT_FAIL')),
      version VARCHAR(32) NOT NULL DEFAULT 'v1.0.0',
      is_active BOOLEAN NOT NULL DEFAULT true,
      nodes JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_flow_code_version UNIQUE (flow_code, version)
    )
  `.execute(db);

  // 10. mrb_reviews 表
  await sql`
    CREATE TABLE IF NOT EXISTS mrb_reviews (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      mrb_no VARCHAR(64) UNIQUE NOT NULL,
      source_type VARCHAR(64) NOT NULL CHECK (source_type IN ('INCOMING_FAIL', 'PROCESS_FAIL', 'SHIPMENT_FAIL', 'SUBCONTRACT_FAIL')),
      source_order_no VARCHAR(64) NOT NULL,
      batch_no VARCHAR(64) NOT NULL,
      material_code VARCHAR(64) NOT NULL,
      material_name VARCHAR(255) NOT NULL,
      workshop_code VARCHAR(64),
      defect_description TEXT NOT NULL,
      defect_qty NUMERIC(15, 4) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'REVIEWING', 'APPROVED', 'REJECTED', 'CLOSED')),
      disposition VARCHAR(32) CHECK (disposition IN ('RETURN_TO_VENDOR', 'REWORK', 'CONCESSION', 'SCRAP')),
      disposition_notes TEXT,
      approvers JSONB NOT NULL DEFAULT '[]'::jsonb,
      concession_attachment_url TEXT,
      confidentiality_level SMALLINT NOT NULL DEFAULT 1 CHECK (confidentiality_level BETWEEN 1 AND 4),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  await sql`CREATE INDEX IF NOT EXISTS idx_mrb_batch ON mrb_reviews(batch_no)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_mrb_status ON mrb_reviews(status)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_mrb_source ON mrb_reviews(source_order_no)`.execute(db);

  // 11. batch_trace_relations 表 (双向索引)
  await sql`
    CREATE TABLE IF NOT EXISTS batch_trace_relations (
      parent_batch VARCHAR(64) NOT NULL,
      child_batch VARCHAR(64) NOT NULL,
      relation_type VARCHAR(32) NOT NULL CHECK (relation_type IN ('TRANSFORM', 'ASSEMBLE', 'SPLIT', 'MERGE')),
      qty NUMERIC(15, 4) NOT NULL,
      operator VARCHAR(64) NOT NULL,
      operation_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (parent_batch, child_batch)
    )
  `.execute(db);

  // DAG 双向覆盖索引
  await sql`CREATE INDEX IF NOT EXISTS idx_batch_trace_parent ON batch_trace_relations(parent_batch, child_batch)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_batch_trace_child ON batch_trace_relations(child_batch, parent_batch)`.execute(db);

  // 12. audit_logs 表 (不可变审计日志单表 + 防篡改触发器)
  await sql`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_name VARCHAR(64) NOT NULL,
      entity_id VARCHAR(64) NOT NULL,
      action VARCHAR(32) NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE', 'EXECUTE')),
      operator_id VARCHAR(64) NOT NULL,
      operator_name VARCHAR(64) NOT NULL,
      diff_patch JSONB NOT NULL DEFAULT '[]'::jsonb,
      client_ip VARCHAR(64),
      user_agent TEXT,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  await sql`CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_name, entity_id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_operator ON audit_logs(operator_id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(occurred_at DESC)`.execute(db);

  // 防篡改触发器函数 (标准单表触发器，严禁更新和物理删除)
  await sql`
    CREATE OR REPLACE FUNCTION prevent_audit_log_tampering()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'PERMISSION DENIED: audit_logs is append-only and immutable. UPDATE and DELETE are strictly forbidden.'
        USING ERRCODE = '55000';
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);

  await sql`DROP TRIGGER IF EXISTS audit_logs_tamper_protection ON audit_logs`.execute(db);
  await sql`
    CREATE TRIGGER audit_logs_tamper_protection
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION prevent_audit_log_tampering();
  `.execute(db);

  // 13. idempotency_keys 表 (复合主键 + 24h TTL)
  await sql`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      user_id UUID NOT NULL,
      endpoint VARCHAR(128) NOT NULL,
      idempotency_key VARCHAR(128) NOT NULL,
      payload_hash CHAR(64) NOT NULL,
      response_code INT NOT NULL,
      response_body JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (user_id, endpoint, idempotency_key)
    )
  `.execute(db);

  await sql`CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at)`.execute(db);

  // 14. outbox_events 表 (事务外件箱)
  await sql`
    CREATE TABLE IF NOT EXISTS outbox_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      aggregate_type VARCHAR(64) NOT NULL,
      aggregate_id VARCHAR(64) NOT NULL,
      event_type VARCHAR(64) NOT NULL,
      payload JSONB NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED')),
      retry_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ
    )
  `.execute(db);

  await sql`CREATE INDEX IF NOT EXISTS idx_outbox_status_created ON outbox_events(status, created_at)`.execute(db);

  // 15. integration_configs 表
  await sql`
    CREATE TABLE IF NOT EXISTS integration_configs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      system_code VARCHAR(32) UNIQUE NOT NULL CHECK (system_code IN ('ERP', 'MES')),
      system_name VARCHAR(64) NOT NULL,
      base_url VARCHAR(255) NOT NULL,
      auth_type VARCHAR(32) NOT NULL DEFAULT 'BEARER_TOKEN' CHECK (auth_type IN ('BEARER_TOKEN', 'BASIC', 'API_KEY')),
      auth_secret TEXT,
      timeout_ms INT NOT NULL DEFAULT 5000,
      is_enabled BOOLEAN NOT NULL DEFAULT true,
      sync_schedule VARCHAR(64),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  // 16. integration_sync_logs 表
  await sql`
    CREATE TABLE IF NOT EXISTS integration_sync_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      system_code VARCHAR(32) NOT NULL CHECK (system_code IN ('ERP', 'MES')),
      task_name VARCHAR(64) NOT NULL,
      status VARCHAR(32) NOT NULL CHECK (status IN ('SUCCESS', 'FAILED')),
      records_processed INT NOT NULL DEFAULT 0,
      error_message TEXT,
      duration_ms INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  await sql`CREATE INDEX IF NOT EXISTS idx_sync_logs_system ON integration_sync_logs(system_code, created_at DESC)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS audit_logs_tamper_protection ON audit_logs`.execute(db);
  await sql`DROP FUNCTION IF EXISTS prevent_audit_log_tampering()`.execute(db);

  await sql`DROP TABLE IF EXISTS integration_sync_logs CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS integration_configs CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS outbox_events CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS idempotency_keys CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS audit_logs CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS batch_trace_relations CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS mrb_reviews CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS review_flows CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS inspection_orders CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS inspection_plans CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS employees CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS workshops CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS customers CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS suppliers CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS inventory_categories CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS materials CASCADE`.execute(db);
}
