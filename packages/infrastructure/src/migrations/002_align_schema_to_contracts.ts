import { Kysely, sql } from 'kysely';

/**
 * 002 —— 把库表结构对齐到 packages/contracts 的权威契约。
 *
 * 001 是"第一版建表"，其中若干字段的值域与列集合是按早期草稿写的，
 * 与 contracts 里已经定稿的枚举（InspectionType / InspectionStatus /
 * OverallDecision / MRBStatus / AuditAction / TraceRelationType 等）
 * 以及工单必须携带的 plan_snapshot / items 快照字段不一致。
 * 契约是系统唯一真理源，因此这里用一版对齐迁移把差异收敛掉，
 * 而不是在仓储层做"翻译"把不一致藏起来。
 *
 * 说明：本迁移中的 SET NOT NULL 只对空表成立；若库里已有数据且无法满足
 * 约束，迁移会显式报错中止，而不是静默跳过。
 *
 * @param db Kysely 实例
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // ==========================================================================
  // 1. 质检方案 inspection_plans
  // ==========================================================================
  // 检验类型：契约取 6 类（IQC / IPQC_CT / IPQC_RL / IPQC_FN / OQC_SF / OQC_SH），
  // 001 只允许 IQC/IPQC/FQC/OQC 四类，滚丝、成品检、委外、出货等单据无法落库。
  await sql`ALTER TABLE inspection_plans DROP CONSTRAINT IF EXISTS inspection_plans_inspection_stage_check`.execute(db);
  await sql`
    ALTER TABLE inspection_plans ADD CONSTRAINT inspection_plans_inspection_stage_check
      CHECK (inspection_stage IN ('IQC', 'IPQC_CT', 'IPQC_RL', 'IPQC_FN', 'OQC_SF', 'OQC_SH'))
  `.execute(db);

  // 版本状态：契约 PlanVersionStatusEnum 为 DRAFT/ACTIVE/INACTIVE，001 写成了 ARCHIVED
  await sql`ALTER TABLE inspection_plans DROP CONSTRAINT IF EXISTS inspection_plans_version_status_check`.execute(db);
  await sql`
    ALTER TABLE inspection_plans ADD CONSTRAINT inspection_plans_version_status_check
      CHECK (version_status IN ('DRAFT', 'ACTIVE', 'INACTIVE'))
  `.execute(db);

  // ==========================================================================
  // 2. 检验工单 inspection_orders
  // ==========================================================================
  await sql`ALTER TABLE inspection_orders DROP CONSTRAINT IF EXISTS inspection_orders_order_type_check`.execute(db);
  await sql`
    ALTER TABLE inspection_orders ADD CONSTRAINT inspection_orders_order_type_check
      CHECK (order_type IN ('IQC', 'IPQC_CT', 'IPQC_RL', 'IPQC_FN', 'OQC_SF', 'OQC_SH'))
  `.execute(db);

  // 状态：契约 8 态（含 MRB 会签与返工复检），001 只有 4 态且含契约中不存在的 CANCELLED
  await sql`ALTER TABLE inspection_orders DROP CONSTRAINT IF EXISTS inspection_orders_status_check`.execute(db);
  await sql`
    ALTER TABLE inspection_orders ADD CONSTRAINT inspection_orders_status_check
      CHECK (status IN ('PENDING', 'INSPECTING', 'DRAFT', 'PASSED', 'FAILED', 'IN_MRB_REVIEW', 'RE_INSPECTING', 'COMPLETED'))
  `.execute(db);

  // 综合结论：契约 OverallDecision 为 PASSED/FAILED/CONCESSION 且未判定时应为空，
  // 001 的 QUALIFIED/UNQUALIFIED 属于旧词汇，且 NOT NULL 会强迫未判定工单先填假结论。
  await sql`ALTER TABLE inspection_orders DROP CONSTRAINT IF EXISTS inspection_orders_judgment_check`.execute(db);
  await sql`ALTER TABLE inspection_orders ALTER COLUMN judgment DROP NOT NULL`.execute(db);
  await sql`
    ALTER TABLE inspection_orders ADD CONSTRAINT inspection_orders_judgment_check
      CHECK (judgment IS NULL OR judgment IN ('PASSED', 'FAILED', 'CONCESSION'))
  `.execute(db);
  // 001 的列默认值 'PENDING' 不在新词汇表内，留着会让"不写 judgment 的插入"直接违反 CHECK 约束
  await sql`ALTER TABLE inspection_orders ALTER COLUMN judgment DROP DEFAULT`.execute(db);

  // 批量数：契约工单不带批总量字段（由 AQL 抽样在领域层使用），改为可空以免强制造数
  await sql`ALTER TABLE inspection_orders ALTER COLUMN total_qty DROP NOT NULL`.execute(db);

  // 契约要求但库中缺失的列：工单必须自带方案版本快照与深拷贝实测项
  await sql`
    ALTER TABLE inspection_orders
      ADD COLUMN IF NOT EXISTS material_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS customer_code VARCHAR(64),
      ADD COLUMN IF NOT EXISTS pass_qty NUMERIC(15,4) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS fail_qty NUMERIC(15,4) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS is_mandatory_gate BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS inspection_notes TEXT,
      ADD COLUMN IF NOT EXISTS plan_version_id UUID,
      ADD COLUMN IF NOT EXISTS plan_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS items JSONB NOT NULL DEFAULT '[]'::jsonb
  `.execute(db);

  await sql`ALTER TABLE inspection_orders ALTER COLUMN material_name SET NOT NULL`.execute(db);
  await sql`ALTER TABLE inspection_orders ALTER COLUMN plan_version_id SET NOT NULL`.execute(db);

  // 实测值与缺陷明细已由 items JSONB 逐项承载，删掉这两列以免出现两个数据源
  await sql`ALTER TABLE inspection_orders DROP COLUMN IF EXISTS measured_values`.execute(db);
  await sql`ALTER TABLE inspection_orders DROP COLUMN IF EXISTS defect_details`.execute(db);

  // ==========================================================================
  // 3. MRB 评审单 mrb_reviews
  // ==========================================================================
  // 状态：契约 4 态 PENDING_REVIEW / UNDER_REVIEW / DISPOSED / REJECTED
  await sql`ALTER TABLE mrb_reviews DROP CONSTRAINT IF EXISTS mrb_reviews_status_check`.execute(db);
  await sql`
    ALTER TABLE mrb_reviews ADD CONSTRAINT mrb_reviews_status_check
      CHECK (status IN ('PENDING_REVIEW', 'UNDER_REVIEW', 'DISPOSED', 'REJECTED'))
  `.execute(db);
  // 001 的列默认值 'PENDING' 已不属于新状态机，改为新状态机的起始态
  await sql`ALTER TABLE mrb_reviews ALTER COLUMN status SET DEFAULT 'PENDING_REVIEW'`.execute(db);

  // ==========================================================================
  // 4. 审计日志 audit_logs
  // ==========================================================================
  // 动作：契约 AuditActionEnum 的 8 类业务动作，001 的 DML 动作语义无法区分"关卡拦截/鉴权失败"等合规事件
  await sql`ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_action_check`.execute(db);
  await sql`
    ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_check
      CHECK (action IN ('CREATE', 'UPDATE', 'STATUS_CHANGE', 'DISPOSE', 'GATE_BLOCKED', 'AUTH_FAILED', 'VALIDATION_REJECTED', 'SYNC_TRIGGER'))
  `.execute(db);

  // 链路追踪 ID 与执行结果：契约 AuditLog 必带 traceId/status，缺失会导致审计与 RFC 7807 响应无法对齐
  await sql`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS trace_id VARCHAR(64)`.execute(db);
  await sql`ALTER TABLE audit_logs ALTER COLUMN trace_id SET NOT NULL`.execute(db);
  await sql`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS status VARCHAR(32) NOT NULL DEFAULT 'SUCCESS'`.execute(db);
  await sql`
    ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_status_check
      CHECK (status IN ('SUCCESS', 'REJECTED', 'FAILED'))
  `.execute(db);

  // 契约 diffPatch 是对象（键值补丁），001 的默认值是数组
  await sql`ALTER TABLE audit_logs ALTER COLUMN diff_patch SET DEFAULT '{}'::jsonb`.execute(db);

  // ==========================================================================
  // 5. 事务外件箱 outbox_events
  // ==========================================================================
  await sql`ALTER TABLE outbox_events DROP CONSTRAINT IF EXISTS outbox_events_status_check`.execute(db);
  await sql`
    ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_status_check
      CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED', 'DEAD_LETTER'))
  `.execute(db);
  // 幂等重试失败原因与链路 ID：死信告警需要可读的失败原因，链路需要与审计/响应同源
  await sql`ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS trace_id VARCHAR(64)`.execute(db);
  await sql`ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS error_reason TEXT`.execute(db);

  // ==========================================================================
  // 6. 集成配置与同步日志
  // ==========================================================================
  // 契约以"订阅的车间/工序"驱动增量同步，需要 JSONB 数组列承载
  await sql`
    ALTER TABLE integration_configs
      ADD COLUMN IF NOT EXISTS subscribed_workshops JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS subscribed_processes JSONB NOT NULL DEFAULT '[]'::jsonb
  `.execute(db);

  // 同步日志：契约要求按批次号与同步方向（PULL/PUSH）记录，状态含部分成功
  await sql`ALTER TABLE integration_sync_logs DROP CONSTRAINT IF EXISTS integration_sync_logs_status_check`.execute(db);
  await sql`
    ALTER TABLE integration_sync_logs ADD CONSTRAINT integration_sync_logs_status_check
      CHECK (status IN ('SUCCESS', 'PARTIAL_FAIL', 'FAILED'))
  `.execute(db);
  await sql`ALTER TABLE integration_sync_logs ADD COLUMN IF NOT EXISTS batch_no VARCHAR(64)`.execute(db);
  await sql`ALTER TABLE integration_sync_logs ADD COLUMN IF NOT EXISTS sync_direction VARCHAR(16)`.execute(db);
  await sql`ALTER TABLE integration_sync_logs ALTER COLUMN batch_no SET NOT NULL`.execute(db);
  await sql`ALTER TABLE integration_sync_logs ALTER COLUMN sync_direction SET NOT NULL`.execute(db);
  await sql`
    ALTER TABLE integration_sync_logs ADD CONSTRAINT integration_sync_logs_sync_direction_check
      CHECK (sync_direction IN ('PULL', 'PUSH'))
  `.execute(db);

  // ==========================================================================
  // 7. 批次追溯：关系类型对齐契约，并补建节点表
  // ==========================================================================
  // 契约 TraceRelationType 描述的是"原材料→工序→委外→成品→出货"的工序流转语义，
  // 001 的 TRANSFORM/ASSEMBLE/SPLIT/MERGE 是制造工艺动词，无法表达追溯链路含义。
  await sql`ALTER TABLE batch_trace_relations DROP CONSTRAINT IF EXISTS batch_trace_relations_relation_type_check`.execute(db);
  await sql`
    ALTER TABLE batch_trace_relations ADD CONSTRAINT batch_trace_relations_relation_type_check
      CHECK (relation_type IN ('RAW_TO_PROCESS', 'PROCESS_TO_PROCESS', 'PROCESS_TO_OUTSOURCE', 'OUTSOURCE_TO_FINISH', 'FINISH_TO_SHIPMENT'))
  `.execute(db);

  // 追溯节点：契约 TraceNode 需要工序名称、物料名称、执行人、节点状态、
  // 关联单据与供应商/客户，这些信息无法从关系边推导，必须独立成表。
  await sql`
    CREATE TABLE IF NOT EXISTS batch_trace_nodes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      batch_no VARCHAR(64) UNIQUE NOT NULL,
      stage_name VARCHAR(128) NOT NULL,
      material_name VARCHAR(255) NOT NULL,
      operator_name VARCHAR(64) NOT NULL,
      node_status VARCHAR(32) NOT NULL DEFAULT 'PENDING'
        CHECK (node_status IN ('PASSED', 'FAILED', 'INSPECTING', 'PENDING', 'STORED')),
      order_no VARCHAR(64),
      supplier_or_customer VARCHAR(255),
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_trace_nodes_status ON batch_trace_nodes(node_status)`.execute(db);

  // ==========================================================================
  // 8. PBAC 行级数据权限表
  // ==========================================================================
  // 契约 MaterialPermission 需要三维授权（物料分类/物料编码/供应商），
  // 001 完全没有承载它的表，导致行级数据隔离无落地基础。
  await sql`
    CREATE TABLE IF NOT EXISTS material_permissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      user_name VARCHAR(64) NOT NULL,
      role_code VARCHAR(64) NOT NULL,
      material_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
      material_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
      supplier_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_permission_user_role UNIQUE (user_id, role_code)
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_permissions_role ON material_permissions(role_code)`.execute(db);
}

/**
 * 回退 002：逐项撤销，恢复到 001 结束时的库表结构。
 *
 * @param db Kysely 实例
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS material_permissions CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS batch_trace_nodes CASCADE`.execute(db);

  await sql`ALTER TABLE integration_sync_logs DROP CONSTRAINT IF EXISTS integration_sync_logs_sync_direction_check`.execute(db);
  await sql`ALTER TABLE integration_sync_logs DROP COLUMN IF EXISTS sync_direction`.execute(db);
  await sql`ALTER TABLE integration_sync_logs DROP COLUMN IF EXISTS batch_no`.execute(db);
  await sql`ALTER TABLE integration_sync_logs DROP CONSTRAINT IF EXISTS integration_sync_logs_status_check`.execute(db);
  await sql`
    ALTER TABLE integration_sync_logs ADD CONSTRAINT integration_sync_logs_status_check
      CHECK (status IN ('SUCCESS', 'FAILED'))
  `.execute(db);
  await sql`ALTER TABLE integration_configs DROP COLUMN IF EXISTS subscribed_processes`.execute(db);
  await sql`ALTER TABLE integration_configs DROP COLUMN IF EXISTS subscribed_workshops`.execute(db);

  await sql`ALTER TABLE outbox_events DROP COLUMN IF EXISTS error_reason`.execute(db);
  await sql`ALTER TABLE outbox_events DROP COLUMN IF EXISTS trace_id`.execute(db);
  await sql`ALTER TABLE outbox_events DROP CONSTRAINT IF EXISTS outbox_events_status_check`.execute(db);
  await sql`
    ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_status_check
      CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED'))
  `.execute(db);

  await sql`ALTER TABLE audit_logs ALTER COLUMN diff_patch SET DEFAULT '[]'::jsonb`.execute(db);
  await sql`ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_status_check`.execute(db);
  await sql`ALTER TABLE audit_logs DROP COLUMN IF EXISTS status`.execute(db);
  await sql`ALTER TABLE audit_logs DROP COLUMN IF EXISTS trace_id`.execute(db);
  await sql`ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_action_check`.execute(db);
  await sql`
    ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_check
      CHECK (action IN ('INSERT', 'UPDATE', 'DELETE', 'EXECUTE'))
  `.execute(db);

  await sql`ALTER TABLE mrb_reviews DROP CONSTRAINT IF EXISTS mrb_reviews_status_check`.execute(db);
  await sql`
    ALTER TABLE mrb_reviews ADD CONSTRAINT mrb_reviews_status_check
      CHECK (status IN ('PENDING', 'REVIEWING', 'APPROVED', 'REJECTED', 'CLOSED'))
  `.execute(db);
  await sql`ALTER TABLE mrb_reviews ALTER COLUMN status SET DEFAULT 'PENDING'`.execute(db);

  await sql`ALTER TABLE inspection_orders ADD COLUMN IF NOT EXISTS defect_details JSONB NOT NULL DEFAULT '[]'::jsonb`.execute(db);
  await sql`ALTER TABLE inspection_orders ADD COLUMN IF NOT EXISTS measured_values JSONB NOT NULL DEFAULT '{}'::jsonb`.execute(db);
  await sql`ALTER TABLE inspection_orders DROP COLUMN IF EXISTS items`.execute(db);
  await sql`ALTER TABLE inspection_orders DROP COLUMN IF EXISTS plan_snapshot`.execute(db);
  await sql`ALTER TABLE inspection_orders DROP COLUMN IF EXISTS plan_version_id`.execute(db);
  await sql`ALTER TABLE inspection_orders DROP COLUMN IF EXISTS inspection_notes`.execute(db);
  await sql`ALTER TABLE inspection_orders DROP COLUMN IF EXISTS is_mandatory_gate`.execute(db);
  await sql`ALTER TABLE inspection_orders DROP COLUMN IF EXISTS fail_qty`.execute(db);
  await sql`ALTER TABLE inspection_orders DROP COLUMN IF EXISTS pass_qty`.execute(db);
  await sql`ALTER TABLE inspection_orders DROP COLUMN IF EXISTS customer_code`.execute(db);
  await sql`ALTER TABLE inspection_orders DROP COLUMN IF EXISTS material_name`.execute(db);
  await sql`ALTER TABLE inspection_orders ALTER COLUMN total_qty SET NOT NULL`.execute(db);
  await sql`ALTER TABLE inspection_orders DROP CONSTRAINT IF EXISTS inspection_orders_judgment_check`.execute(db);
  await sql`ALTER TABLE inspection_orders ALTER COLUMN judgment SET NOT NULL`.execute(db);
  await sql`
    ALTER TABLE inspection_orders ADD CONSTRAINT inspection_orders_judgment_check
      CHECK (judgment IN ('QUALIFIED', 'UNQUALIFIED', 'CONCESSION', 'PENDING'))
  `.execute(db);
  await sql`ALTER TABLE inspection_orders ALTER COLUMN judgment SET DEFAULT 'PENDING'`.execute(db);
  await sql`ALTER TABLE inspection_orders DROP CONSTRAINT IF EXISTS inspection_orders_status_check`.execute(db);
  await sql`
    ALTER TABLE inspection_orders ADD CONSTRAINT inspection_orders_status_check
      CHECK (status IN ('PENDING', 'INSPECTING', 'COMPLETED', 'CANCELLED'))
  `.execute(db);
  await sql`ALTER TABLE inspection_orders DROP CONSTRAINT IF EXISTS inspection_orders_order_type_check`.execute(db);
  await sql`
    ALTER TABLE inspection_orders ADD CONSTRAINT inspection_orders_order_type_check
      CHECK (order_type IN ('IQC', 'IPQC', 'FQC', 'OQC'))
  `.execute(db);

  await sql`ALTER TABLE inspection_plans DROP CONSTRAINT IF EXISTS inspection_plans_version_status_check`.execute(db);
  await sql`
    ALTER TABLE inspection_plans ADD CONSTRAINT inspection_plans_version_status_check
      CHECK (version_status IN ('DRAFT', 'ACTIVE', 'ARCHIVED'))
  `.execute(db);
  await sql`ALTER TABLE inspection_plans DROP CONSTRAINT IF EXISTS inspection_plans_inspection_stage_check`.execute(db);
  await sql`
    ALTER TABLE inspection_plans ADD CONSTRAINT inspection_plans_inspection_stage_check
      CHECK (inspection_stage IN ('IQC', 'IPQC', 'FQC', 'OQC'))
  `.execute(db);
}
