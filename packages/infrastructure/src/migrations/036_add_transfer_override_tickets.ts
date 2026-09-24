import { Kysely, sql } from 'kysely';

/**
 * 迁移 036：「合格后传递」豁免审批流表（docs/48 §4.1 / §8 P2 / TBD-09）
 *
 * 业务背景：
 *   现场紧急排产、客户书面特批试制或实验室加急复验时，上游虽处于阻断状态
 *   （UPSTREAM_FAILED / UPSTREAM_INSPECTING / UPSTREAM_UNDER_MRB / CHAIN_TERMINATED），
 *   质量负责人拥有特批豁免放行权限。
 *
 * 实施原则（按项目经理拍板）：
 *   - 豁免工单先按「一单一核销」走，严格优先。
 *   - 完整生命周期：PENDING（待审核） -> APPROVED（已核准） / REJECTED（已驳回） -> CONSUMED（已核销建单）。
 *   - 真实落库留痕：建单后核销工单，回填 consumed_order_id 与 consumed_order_no。
 *   - 安全边界：纯新增独立表与索引，不修改、不污染既有表结构。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS transfer_override_tickets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_no VARCHAR(32) NOT NULL UNIQUE,
      batch_no VARCHAR(64) NOT NULL,
      material_code VARCHAR(64) NOT NULL,
      inspection_type VARCHAR(16) NOT NULL,
      work_order_no VARCHAR(64),
      furnace_heat_no VARCHAR(64),
      upstream_order_no VARCHAR(64),
      upstream_gate_code VARCHAR(32) NOT NULL,
      reason TEXT NOT NULL,
      applicant_id UUID NOT NULL,
      applicant_name VARCHAR(64),
      status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
      reviewer_id UUID,
      reviewer_name VARCHAR(64),
      review_notes TEXT,
      approval_doc_no VARCHAR(64),
      consumed_order_id UUID,
      consumed_order_no VARCHAR(64),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_at TIMESTAMPTZ,
      consumed_at TIMESTAMPTZ
    );
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_transfer_override_tickets_target
      ON transfer_override_tickets (batch_no, material_code, inspection_type, status);
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_transfer_override_tickets_ticket_no
      ON transfer_override_tickets (ticket_no);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_transfer_override_tickets_ticket_no;`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_transfer_override_tickets_target;`.execute(db);
  await sql`DROP TABLE IF EXISTS transfer_override_tickets;`.execute(db);
}
