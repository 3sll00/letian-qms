import { Kysely, sql } from 'kysely';

/**
 * 迁移 015：MRB 不合格品处置「待审核池 → 评审单」字段与接口打通
 *
 * 背景：docs/21-MRB不合格品处置数据字段与接口打通设计.md §3.2（断链清单 D1~D4）。
 * 合并页面上线后，界面字段与物理列之间仍有 4 处断链，本迁移一次性补齐：
 *
 *  1. **D1 池字段缺失**：`pending_mrb_items` 无 `total_qty / defect_item_code /
 *     supplier_name / customer_name / inspector_id / inspector_name`，
 *     导致池抽屉的「供应商 / 客户 / 不合格指标项 / 检验人 / 不良率」在真实链路下恒为空。
 *  2. **D2 池状态口径分叉**：004 建表时 `status` 默认写成 `'PENDING_REVIEW'`，
 *     而契约 `PendingDefectStatusEnum` 只有 PENDING_INITIATE / INITIATED / DISMISSED，
 *     于是「按待发起评审筛选」在 SQL 层匹配 0 行。
 *  3. **D3 池表无写入方**：库内 0 行，界面靠实时投影 `FAILED` 检验单兜底。
 *     本迁移先把存量 `FAILED` / `IN_MRB_REVIEW` 工单补录为池记录（幂等，按 source_order_id 去重），
 *     运行时入池由 `CollectPendingDefectUseCase` 承担。
 *  4. **D4 发起参数无落点**：`mrb_reviews` 缺 `pending_defect_id / review_flow_id /
 *     urgency_level / review_notes / disposed_at / disposed_by`，契约里这几个字段读写都没着落。
 *
 * 幂等约定：DDL 全部带 IF NOT EXISTS / DROP ... IF EXISTS；回填只在目标列为 NULL 时生效，
 * 不覆盖业务已写入的值；池去重保留 `created_at` 最新的一条。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // ---------------------------------------------------------------------------
  // 1. 待审核池：补齐界面字段对应的 6 个物理列
  // ---------------------------------------------------------------------------
  await sql`
    ALTER TABLE pending_mrb_items
      ADD COLUMN IF NOT EXISTS total_qty NUMERIC,
      ADD COLUMN IF NOT EXISTS defect_item_code VARCHAR(64),
      ADD COLUMN IF NOT EXISTS supplier_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS inspector_id VARCHAR(64),
      ADD COLUMN IF NOT EXISTS inspector_name VARCHAR(64);
  `.execute(db);

  // ---------------------------------------------------------------------------
  // 2. 池状态口径归一：默认值改为契约起始态，历史值映射到 3 态枚举
  // ---------------------------------------------------------------------------
  await sql`ALTER TABLE pending_mrb_items ALTER COLUMN status SET DEFAULT 'PENDING_INITIATE'`.execute(db);
  await sql`
    UPDATE pending_mrb_items SET status = 'INITIATED'
    WHERE status IN ('REVIEWING', 'RESOLVED', 'IN_REVIEW', 'APPROVED', 'CLOSED')
  `.execute(db);
  await sql`
    UPDATE pending_mrb_items SET status = 'PENDING_INITIATE'
    WHERE status NOT IN ('PENDING_INITIATE', 'INITIATED', 'DISMISSED')
  `.execute(db);
  await sql`ALTER TABLE pending_mrb_items DROP CONSTRAINT IF EXISTS pending_mrb_items_status_check`.execute(db);
  await sql`
    ALTER TABLE pending_mrb_items ADD CONSTRAINT pending_mrb_items_status_check
      CHECK (status IN ('PENDING_INITIATE', 'INITIATED', 'DISMISSED'))
  `.execute(db);

  // ---------------------------------------------------------------------------
  // 3. 存量池记录回填：新增列的取值来源是源检验单
  // ---------------------------------------------------------------------------
  // 供应商口径与运行时/种子保持一致（委外工序取加工商 vendor_name 优先，
  // 其次按 supplier_code 回查主数据；inspection_orders.supplier_name 多为空，
  // 只认它会让抽屉「供应商」在存量数据上依旧是空的）
  await sql`
    UPDATE pending_mrb_items p SET
      total_qty = COALESCE(p.total_qty, o.sample_qty, o.total_qty, p.defect_qty),
      supplier_name = COALESCE(p.supplier_name, o.vendor_name, sup.supplier_name, o.supplier_name),
      customer_name = COALESCE(p.customer_name, o.customer_name, cus.customer_name),
      inspector_id = COALESCE(p.inspector_id, o.inspector_id),
      inspector_name = COALESCE(p.inspector_name, o.inspector_name),
      defect_item_code = COALESCE(
        p.defect_item_code,
        (SELECT i ->> 'itemCode' FROM jsonb_array_elements(o.items) i
          WHERE i ->> 'result' = 'FAILED' LIMIT 1)
      )
    FROM inspection_orders o
    LEFT JOIN suppliers sup ON sup.supplier_code = o.supplier_code
    LEFT JOIN customers cus ON cus.customer_code = o.customer_code
    WHERE (o.id::text = p.source_order_id OR o.order_no = p.source_order_no)
  `.execute(db);

  // 不良率与新增的报检总数保持同一口径（避免列与派生值互相打架）
  await sql`
    UPDATE pending_mrb_items
    SET defect_rate = CASE
      WHEN COALESCE(total_qty, 0) > 0 THEN ROUND(defect_qty / total_qty * 100, 4)
      ELSE 0
    END
  `.execute(db);

  await sql`UPDATE pending_mrb_items SET total_qty = defect_qty WHERE total_qty IS NULL`.execute(db);
  await sql`ALTER TABLE pending_mrb_items ALTER COLUMN total_qty SET NOT NULL`.execute(db);

  // ---------------------------------------------------------------------------
  // 4. 存量不合格工单补录入池（D3）：FAILED -> 待发起评审，IN_MRB_REVIEW -> 已入评审
  // ---------------------------------------------------------------------------
  await sql`
    INSERT INTO pending_mrb_items (
      source_order_id, source_order_no, source_stage, material_code, material_name, batch_no,
      defect_qty, defect_rate, fail_reason, failed_items, status, mrb_review_id,
      review_started_at, review_started_by, created_at,
      total_qty, defect_item_code, supplier_name, customer_name, inspector_id, inspector_name
    )
    SELECT
      o.id::text,
      o.order_no,
      COALESCE(o.order_type, 'IQC'),
      o.material_code,
      o.material_name,
      o.batch_no,
      COALESCE(o.fail_qty, 0),
      CASE
        WHEN COALESCE(o.sample_qty, o.total_qty, 0) > 0
          THEN ROUND(COALESCE(o.fail_qty, 0) / COALESCE(o.sample_qty, o.total_qty) * 100, 4)
        ELSE 0
      END,
      COALESCE(NULLIF(o.inspection_notes, ''), '判定不合格，待发起 MRB 评审'),
      COALESCE(o.items, '[]'::jsonb),
      -- 已开 MRB 或工单已进入评审：池状态收敛为「已入评审」，
      -- 否则「待发起评审」页签会把已有评审单的不合格品重复列出（口径分叉，见 docs/20 §6.1）
      CASE WHEN o.status = 'IN_MRB_REVIEW' OR m.mrb_id IS NOT NULL THEN 'INITIATED' ELSE 'PENDING_INITIATE' END,
      m.mrb_id,
      CASE WHEN o.status = 'IN_MRB_REVIEW' OR m.mrb_id IS NOT NULL THEN o.updated_at ELSE NULL END,
      CASE WHEN o.status = 'IN_MRB_REVIEW' OR m.mrb_id IS NOT NULL THEN o.inspector_name ELSE NULL END,
      o.created_at,
      COALESCE(o.sample_qty, o.total_qty, o.fail_qty, 0),
      (SELECT i ->> 'itemCode' FROM jsonb_array_elements(o.items) i
        WHERE i ->> 'result' = 'FAILED' LIMIT 1),
      COALESCE(o.vendor_name, sup.supplier_name, o.supplier_name),
      COALESCE(o.customer_name, cus.customer_name),
      o.inspector_id,
      o.inspector_name
    FROM inspection_orders o
    LEFT JOIN suppliers sup ON sup.supplier_code = o.supplier_code
    LEFT JOIN customers cus ON cus.customer_code = o.customer_code
    LEFT JOIN LATERAL (
      SELECT id::text AS mrb_id FROM mrb_reviews
      WHERE source_order_no = o.order_no
      ORDER BY created_at DESC
      LIMIT 1
    ) m ON true
    WHERE o.status IN ('FAILED', 'IN_MRB_REVIEW')
      AND NOT EXISTS (
        SELECT 1 FROM pending_mrb_items p WHERE p.source_order_id = o.id::text
      )
  `.execute(db);

  // ---------------------------------------------------------------------------
  // 5. 入池幂等键：一张检验单在池中只有一条记录（去重保留最新）
  // ---------------------------------------------------------------------------
  await sql`
    DELETE FROM pending_mrb_items a
    USING pending_mrb_items b
    WHERE a.source_order_id = b.source_order_id
      AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.id < b.id))
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_mrb_source_order
      ON pending_mrb_items (source_order_id)
  `.execute(db);

  // ---------------------------------------------------------------------------
  // 6. MRB 评审单：补齐发起参数与处置闭环字段
  // ---------------------------------------------------------------------------
  await sql`
    ALTER TABLE mrb_reviews
      ADD COLUMN IF NOT EXISTS pending_defect_id UUID,
      ADD COLUMN IF NOT EXISTS review_flow_id UUID,
      ADD COLUMN IF NOT EXISTS urgency_level VARCHAR(16) NOT NULL DEFAULT 'NORMAL',
      ADD COLUMN IF NOT EXISTS review_notes TEXT,
      ADD COLUMN IF NOT EXISTS disposed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS disposed_by VARCHAR(64);
  `.execute(db);

  await sql`
    UPDATE mrb_reviews SET urgency_level = 'NORMAL'
    WHERE urgency_level IS NULL OR urgency_level NOT IN ('NORMAL', 'URGENT', 'CRITICAL')
  `.execute(db);
  await sql`ALTER TABLE mrb_reviews DROP CONSTRAINT IF EXISTS mrb_reviews_urgency_level_check`.execute(db);
  await sql`
    ALTER TABLE mrb_reviews ADD CONSTRAINT mrb_reviews_urgency_level_check
      CHECK (urgency_level IN ('NORMAL', 'URGENT', 'CRITICAL'))
  `.execute(db);

  await sql`ALTER TABLE mrb_reviews DROP CONSTRAINT IF EXISTS fk_mrb_pending_defect`.execute(db);
  await sql`
    ALTER TABLE mrb_reviews ADD CONSTRAINT fk_mrb_pending_defect
      FOREIGN KEY (pending_defect_id) REFERENCES pending_mrb_items(id) ON DELETE SET NULL
  `.execute(db);
  await sql`ALTER TABLE mrb_reviews DROP CONSTRAINT IF EXISTS fk_mrb_review_flow`.execute(db);
  await sql`
    ALTER TABLE mrb_reviews ADD CONSTRAINT fk_mrb_review_flow
      FOREIGN KEY (review_flow_id) REFERENCES review_flows(id) ON DELETE SET NULL
  `.execute(db);

  await sql`CREATE INDEX IF NOT EXISTS idx_mrb_pending_defect ON mrb_reviews(pending_defect_id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_mrb_review_flow ON mrb_reviews(review_flow_id)`.execute(db);

  // 存量关联回填：池 -> MRB 的正向指针，以及按不合格类型匹配的生效流程
  await sql`
    UPDATE mrb_reviews m SET pending_defect_id = (
      SELECT p.id FROM pending_mrb_items p
      WHERE p.mrb_review_id = m.id::text
      ORDER BY p.created_at DESC
      LIMIT 1
    )
    WHERE m.pending_defect_id IS NULL
  `.execute(db);
  await sql`
    UPDATE mrb_reviews m SET review_flow_id = (
      SELECT f.id FROM review_flows f
      WHERE f.is_active = true AND f.applicable_type = m.source_type
      ORDER BY f.created_at
      LIMIT 1
    )
    WHERE m.review_flow_id IS NULL
      AND m.source_type IN ('INCOMING_FAIL', 'PROCESS_FAIL', 'SHIPMENT_FAIL', 'SUBCONTRACT_FAIL')
  `.execute(db);
  await sql`
    UPDATE mrb_reviews SET disposed_at = updated_at
    WHERE status = 'DISPOSED' AND disposed_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // 回滚范围：仅 DDL 与状态默认值。
  // 第 4 步补录的池记录、第 3 步回填的列值不做反向删除（无法与业务真实写入区分），
  // 因此 down 之后池表仍保留运行时数据，属预期行为。
  await sql`DROP INDEX IF EXISTS idx_mrb_review_flow`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_mrb_pending_defect`.execute(db);
  await sql`ALTER TABLE mrb_reviews DROP CONSTRAINT IF EXISTS fk_mrb_review_flow`.execute(db);
  await sql`ALTER TABLE mrb_reviews DROP CONSTRAINT IF EXISTS fk_mrb_pending_defect`.execute(db);
  await sql`ALTER TABLE mrb_reviews DROP CONSTRAINT IF EXISTS mrb_reviews_urgency_level_check`.execute(db);
  await sql`
    ALTER TABLE mrb_reviews
      DROP COLUMN IF EXISTS disposed_by,
      DROP COLUMN IF EXISTS disposed_at,
      DROP COLUMN IF EXISTS review_notes,
      DROP COLUMN IF EXISTS urgency_level,
      DROP COLUMN IF EXISTS review_flow_id,
      DROP COLUMN IF EXISTS pending_defect_id;
  `.execute(db);

  await sql`DROP INDEX IF EXISTS uq_pending_mrb_source_order`.execute(db);
  await sql`ALTER TABLE pending_mrb_items ALTER COLUMN total_qty DROP NOT NULL`.execute(db);
  await sql`ALTER TABLE pending_mrb_items DROP CONSTRAINT IF EXISTS pending_mrb_items_status_check`.execute(db);
  await sql`ALTER TABLE pending_mrb_items ALTER COLUMN status SET DEFAULT 'PENDING_REVIEW'`.execute(db);
  await sql`UPDATE pending_mrb_items SET status = 'PENDING_REVIEW' WHERE status = 'PENDING_INITIATE'`.execute(db);
  await sql`UPDATE pending_mrb_items SET status = 'REVIEWING' WHERE status = 'INITIATED'`.execute(db);
  await sql`
    ALTER TABLE pending_mrb_items
      DROP COLUMN IF EXISTS inspector_name,
      DROP COLUMN IF EXISTS inspector_id,
      DROP COLUMN IF EXISTS customer_name,
      DROP COLUMN IF EXISTS supplier_name,
      DROP COLUMN IF EXISTS defect_item_code,
      DROP COLUMN IF EXISTS total_qty;
  `.execute(db);
}
