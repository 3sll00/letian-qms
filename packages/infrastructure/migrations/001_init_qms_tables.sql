-- ============================================================================
-- 乐天质量管理系统 (Letian QMS) 生产基准 DDL 迁移脚本
-- 对齐架构版本：v2.5.0 (生产基准级)
-- 适用数据库：PostgreSQL 14+
-- 包含约束：UUID主键、TIMESTAMPTZ、方案快照、行级防篡改触发器、DAG双向索引、幂等防重
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. 基础主数据与组织档案 (Materials, Categories, Suppliers, Customers, Workshops, Employees)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS materials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    material_code VARCHAR(64) NOT NULL UNIQUE,
    material_name VARCHAR(128) NOT NULL,
    spec_model VARCHAR(128),
    category_code VARCHAR(64) NOT NULL,
    unit VARCHAR(16) NOT NULL DEFAULT '个',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_materials_category ON materials(category_code);

CREATE TABLE IF NOT EXISTS inventory_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_code VARCHAR(64) NOT NULL UNIQUE,
    category_name VARCHAR(128) NOT NULL,
    parent_code VARCHAR(64),
    level INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS suppliers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_code VARCHAR(64) NOT NULL UNIQUE,
    supplier_name VARCHAR(128) NOT NULL,
    contact_person VARCHAR(64),
    phone VARCHAR(32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_code VARCHAR(64) NOT NULL UNIQUE,
    customer_name VARCHAR(128) NOT NULL,
    contact_person VARCHAR(64),
    phone VARCHAR(32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workshops (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workshop_code VARCHAR(64) NOT NULL UNIQUE,
    workshop_name VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS employees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_no VARCHAR(64) NOT NULL UNIQUE,
    name VARCHAR(64) NOT NULL,
    department VARCHAR(64) NOT NULL,
    role VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 2. 质检方案与指标规格库 (Inspection Plans, Versions, Items)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inspection_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_code VARCHAR(64) NOT NULL UNIQUE,
    plan_name VARCHAR(128) NOT NULL,
    inspection_type VARCHAR(32) NOT NULL, -- IQC, IPQC_CT, IPQC_RL, IPQC_FN, OQC_SF, OQC_SH
    material_code VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_plans_type_mat ON inspection_plans(inspection_type, material_code);

CREATE TABLE IF NOT EXISTS inspection_plan_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES inspection_plans(id) ON DELETE CASCADE,
    version_no VARCHAR(32) NOT NULL, -- e.g. v1.0.0
    status VARCHAR(16) NOT NULL DEFAULT 'DRAFT', -- DRAFT / ACTIVE / INACTIVE
    sampling_scheme VARCHAR(32) NOT NULL DEFAULT 'GB_T_2828',
    aql_level VARCHAR(16) NOT NULL DEFAULT 'II',
    strictness VARCHAR(16) NOT NULL DEFAULT 'NORMAL',
    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uk_plan_version UNIQUE (plan_id, version_no)
);

CREATE TABLE IF NOT EXISTS inspection_plan_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version_id UUID NOT NULL REFERENCES inspection_plan_versions(id) ON DELETE CASCADE,
    item_code VARCHAR(64) NOT NULL,
    item_name VARCHAR(128) NOT NULL,
    data_type VARCHAR(32) NOT NULL, -- NUMERIC / TEXT / QUALITATIVE
    metric_category VARCHAR(32) NOT NULL, -- DIMENSION, APPEARANCE, HARDNESS, COATING_THICKNESS, TENSILE_STRENGTH
    target_val NUMERIC(12, 4),
    upper_tolerance NUMERIC(12, 4),
    lower_tolerance NUMERIC(12, 4),
    unit VARCHAR(16),
    measurement_tool VARCHAR(64),
    is_mandatory BOOLEAN NOT NULL DEFAULT TRUE,
    seq INT NOT NULL DEFAULT 1,
    CONSTRAINT uk_plan_item UNIQUE (version_id, item_code)
);

-- ----------------------------------------------------------------------------
-- 3. 检验单与指标明细表 (Inspection Orders & Items with Snapshot)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inspection_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_no VARCHAR(64) NOT NULL UNIQUE,
    inspection_type VARCHAR(32) NOT NULL, -- IQC, IPQC_CT, IPQC_RL, IPQC_FN, OQC_SF, OQC_SH
    material_code VARCHAR(64) NOT NULL,
    material_name VARCHAR(128) NOT NULL,
    batch_no VARCHAR(64) NOT NULL,
    supplier_code VARCHAR(64),
    customer_code VARCHAR(64),
    sample_qty NUMERIC(12, 2) NOT NULL,
    pass_qty NUMERIC(12, 2) NOT NULL DEFAULT 0,
    fail_qty NUMERIC(12, 2) NOT NULL DEFAULT 0,
    is_mandatory_gate BOOLEAN NOT NULL DEFAULT FALSE,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING', -- PENDING, INSPECTING, DRAFT, PASSED, FAILED, IN_MRB_REVIEW, RE_INSPECTING, COMPLETED
    overall_decision VARCHAR(32), -- PASSED, FAILED, CONCESSION
    inspector_id UUID,
    inspection_notes TEXT,
    plan_version_id UUID NOT NULL REFERENCES inspection_plan_versions(id) ON DELETE RESTRICT,
    plan_snapshot JSONB NOT NULL, -- 固化检验方案版本元数据、指标上下限、抽样规则快照
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_batch ON inspection_orders(batch_no);
CREATE INDEX IF NOT EXISTS idx_orders_status ON inspection_orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_type_created ON inspection_orders(inspection_type, created_at DESC);

CREATE TABLE IF NOT EXISTS inspection_order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES inspection_orders(id) ON DELETE CASCADE,
    item_code VARCHAR(64) NOT NULL,
    item_name VARCHAR(128) NOT NULL,
    data_type VARCHAR(32) NOT NULL, -- NUMERIC / TEXT / QUALITATIVE
    metric_category VARCHAR(32) NOT NULL, -- DIMENSION, APPEARANCE, HARDNESS, COATING_THICKNESS, TENSILE_STRENGTH
    target_val NUMERIC(12, 4),
    upper_tolerance NUMERIC(12, 4),
    lower_tolerance NUMERIC(12, 4),
    unit VARCHAR(16),
    measured_val NUMERIC(12, 4),
    measured_text VARCHAR(255),
    decision VARCHAR(16) NOT NULL DEFAULT 'PENDING', -- PENDING / PASSED / FAILED
    defect_reason VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uk_order_item UNIQUE (order_id, item_code)
);
CREATE INDEX IF NOT EXISTS idx_order_items_metric ON inspection_order_items(item_code, decision);
CREATE INDEX IF NOT EXISTS idx_order_items_category ON inspection_order_items(metric_category, decision);

-- ----------------------------------------------------------------------------
-- 4. 批次全链路 DAG 追溯拓扑 (Batch Trace Edges)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS batch_trace_edges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_batch_no VARCHAR(64) NOT NULL,
    target_batch_no VARCHAR(64) NOT NULL,
    relation_type VARCHAR(32) NOT NULL, -- RAW_TO_PROCESS, PROCESS_TO_PROCESS, PROCESS_TO_OUTSOURCE, OUTSOURCE_TO_FINISH, FINISH_TO_SHIPMENT
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uk_trace_edge UNIQUE (source_batch_no, target_batch_no)
);
CREATE INDEX IF NOT EXISTS idx_trace_edges_source ON batch_trace_edges(source_batch_no);
CREATE INDEX IF NOT EXISTS idx_trace_edges_target ON batch_trace_edges(target_batch_no);

-- ----------------------------------------------------------------------------
-- 5. 不合格品处置与可配置审批流 (MRB Records & Configurable Workflows)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS review_flow_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    flow_code VARCHAR(64) NOT NULL UNIQUE,
    flow_name VARCHAR(128) NOT NULL,
    applicable_type VARCHAR(32) NOT NULL, -- INCOMING_FAIL, PROCESS_FAIL, SHIPMENT_FAIL, SUBCONTRACT_FAIL
    version_no VARCHAR(32) NOT NULL DEFAULT 'v1.0.0',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS review_flow_nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    flow_id UUID NOT NULL REFERENCES review_flow_definitions(id) ON DELETE CASCADE,
    node_level INT NOT NULL, -- 1, 2, 3...
    node_name VARCHAR(64) NOT NULL,
    approver_role VARCHAR(32) NOT NULL, -- QUALITY_MANAGER, TECH_DEPT, PROD_DEPT, FACTORY_DIRECTOR
    is_customer_approval_required BOOLEAN NOT NULL DEFAULT FALSE, -- 特采特批场景
    timeout_hours INT NOT NULL DEFAULT 24,
    CONSTRAINT uk_flow_node UNIQUE (flow_id, node_level)
);

CREATE TABLE IF NOT EXISTS mrb_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mrb_no VARCHAR(64) NOT NULL UNIQUE,
    inspection_order_id UUID NOT NULL REFERENCES inspection_orders(id) ON DELETE RESTRICT,
    batch_no VARCHAR(64) NOT NULL,
    material_code VARCHAR(64) NOT NULL,
    defect_desc TEXT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING_REVIEW', -- PENDING_REVIEW, UNDER_REVIEW, DISPOSED, REJECTED
    disposition VARCHAR(32), -- RETURN_TO_VENDOR, REWORK, CONCESSION, SCRAP
    flow_snapshot JSONB NOT NULL, -- 快照锁定当前审批节点与会签规则
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mrb_batch ON mrb_records(batch_no);
CREATE INDEX IF NOT EXISTS idx_mrb_status ON mrb_records(status);

CREATE TABLE IF NOT EXISTS mrb_review_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mrb_id UUID NOT NULL REFERENCES mrb_records(id) ON DELETE CASCADE,
    node_level INT NOT NULL,
    approver_id UUID NOT NULL,
    approver_role VARCHAR(32) NOT NULL,
    action VARCHAR(32) NOT NULL, -- APPROVE, REJECT, CONCESSION_SIGN
    comment TEXT,
    attachment_url VARCHAR(255),
    action_time TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 6. 物料行级数据权限策略规则 (PBAC Rules)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS material_permission_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID,
    role_code VARCHAR(32),
    material_categories JSONB NOT NULL DEFAULT '[]', -- 允许访问的物料分类数组
    material_codes JSONB NOT NULL DEFAULT '[]',      -- 允许访问的具体物料编码白名单数组
    supplier_codes JSONB NOT NULL DEFAULT '[]',      -- 允许访问的供应商编码白名单数组
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_perm_user ON material_permission_rules(user_id);
CREATE INDEX IF NOT EXISTS idx_perm_role ON material_permission_rules(role_code);

-- ----------------------------------------------------------------------------
-- 7. 审计日志与不可篡改行级触发器 (Immutable Audit Logs)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trace_id VARCHAR(64) NOT NULL,
    user_id UUID NOT NULL,
    user_name VARCHAR(64) NOT NULL,
    action VARCHAR(32) NOT NULL, -- CREATE, UPDATE, STATUS_CHANGE, DISPOSE, GATE_BLOCKED, AUTH_FAILED, VALIDATION_REJECTED, SYNC_TRIGGER
    resource_type VARCHAR(64) NOT NULL,
    resource_id VARCHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'SUCCESS', -- SUCCESS / REJECTED / FAILED
    diff_patch JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_filter ON audit_logs(action, status, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_composite ON audit_logs(user_id, action, created_at DESC);

-- 行级防篡改触发器函数 (PG 14+ 严格稳定执行)
CREATE OR REPLACE FUNCTION forbid_audit_tampering() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'QMS_AUDIT_LOG_IMMUTABLE: 审计日志严禁物理修改或物理删除操作';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_immutable ON audit_logs;
CREATE TRIGGER trg_audit_immutable
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION forbid_audit_tampering();

-- ----------------------------------------------------------------------------
-- 8. 权限拦截与过滤审计日志 (Authorization Logs - 180天自动生命周期)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS authorization_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trace_id VARCHAR(64) NOT NULL,
    user_id UUID NOT NULL,
    user_role VARCHAR(32) NOT NULL,
    action VARCHAR(32) NOT NULL, -- QUERY, EXPORT, REPORT
    requested_resource VARCHAR(128) NOT NULL,
    filter_rules_applied JSONB NOT NULL, -- 注入的物料/分类/供应商白名单
    matched_count INT NOT NULL DEFAULT 0,
    is_intercepted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_logs_created ON authorization_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_auth_logs_user ON authorization_logs(user_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- 9. 系统集成配置与同步流水 (Integration Configs & Sync Logs)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integration_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    system_type VARCHAR(32) NOT NULL, -- MES / ERP
    service_url VARCHAR(255) NOT NULL,
    auth_token VARCHAR(255),
    subscribed_workshops JSONB NOT NULL DEFAULT '[]', -- MES: 订阅车间数组; ERP: 保持 []
    subscribed_processes JSONB NOT NULL DEFAULT '[]', -- MES: 订阅工序数组; ERP: 保持 []
    cron_schedule VARCHAR(64) NOT NULL DEFAULT '0 */5 * * * *', -- 每5分钟轮询
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uk_integration_system UNIQUE (system_type)
);

CREATE TABLE IF NOT EXISTS integration_sync_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_no VARCHAR(64) NOT NULL,
    system_type VARCHAR(32) NOT NULL, -- MES / ERP
    sync_direction VARCHAR(16) NOT NULL, -- PULL / PUSH
    status VARCHAR(16) NOT NULL, -- SUCCESS / PARTIAL_FAIL / FAILED
    records_count INT NOT NULL DEFAULT 0,
    error_details TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sync_logs_batch ON integration_sync_logs(batch_no, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_logs_system ON integration_sync_logs(system_type, status, created_at DESC);

-- ----------------------------------------------------------------------------
-- 10. 事务 Outbox 消息流表 (Transactional Outbox for Event-Driven Integrations)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL UNIQUE,  -- UUIDv7 全局唯一事件 ID，用于 MES 消费端去重
    event_type VARCHAR(64) NOT NULL,  -- BATCH_LOCKED, MRB_TRIGGERED, INSPECTION_COMPLETED
    aggregate_type VARCHAR(32) NOT NULL DEFAULT 'BATCH', -- BATCH / ORDER
    aggregate_id VARCHAR(64) NOT NULL,  -- 聚合根业务主键 (batch_no 或 order_no)
    payload JSONB NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'PENDING',  -- PENDING / SENT / FAILED / DEAD_LETTER
    retry_count INT NOT NULL DEFAULT 0,
    max_retries INT NOT NULL DEFAULT 5,
    occurred_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events(status, created_at);

-- ----------------------------------------------------------------------------
-- 11. 接口幂等防重表 (Idempotency Keys with Payload Hash & 24h TTL)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idempotency_keys (
    user_id UUID NOT NULL,
    endpoint VARCHAR(128) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    payload_hash CHAR(64) NOT NULL,
    response_code INT NOT NULL,
    response_body JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL, -- 严格 24h TTL
    PRIMARY KEY (user_id, endpoint, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);

COMMIT;
