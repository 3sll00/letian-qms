import { Kysely, sql } from 'kysely';

/**
 * 迁移 028：委外单号号段与委外批次号口径收口（docs/34 §2）
 *
 * 背景（承接 docs/32 §5 遗留 Q1 / Q3）：
 *  - Q1：`inspection_orders.outsource_no` 是 **ERP 委外加工单号（`DlyndxSC.Number`，VchType=181）的镜像列**，
 *    ERP 侧号段为 `WWJG-`（适配器 `OutsourceSevenCategoryAdapter` 按 `'WWJG-' + VchCode` 拼装；
 *    `docs/07` §4.2 记「委外加工单 (WWJG, VchType=181)」），而库里 7 行写的是 `WW-` 形态，
 *    与 ERP 侧对不上账。本迁移只改**前缀**：`WW-{YYYYMMDD}-{NNN}` -> `WWJG-{YYYYMMDD}-{NNN}`。
 *  - Q3：同 7 行把 `outsource_no` 原值同时写进 `batch_no`，导致「委外批次号」与「委外加工单号」恒同值
 *    （制造证书的 `Heat/Batch No.` 与 `Subcontract No.` 也同值）。本迁移把 `batch_no` 改为批次号形态
 *    `B{YYYYMMDD}-{NNN}`（与两条 2023 行的 `B20231010-03` / `B20231013-05` 同族）。
 *
 * 本迁移在同一事务内做三件事：
 *  1. 建留痕表 `outsource_reference_renumberings`（kind = OUTSOURCE_NO | BATCH_NO，逐条留痕 + down 依据）；
 *  2. 改写 `inspection_orders.outsource_no` / `inspection_orders.batch_no`；
 *  3. 同步改写活引用：`pending_mrb_items.batch_no` / `mrb_reviews.batch_no` / `batch_trace_nodes.batch_no`
 *     （追溯主键）与**未投递** Outbox 事件的 `payload.batchNo` / `payload.outsourceNo`。
 *
 * 留痕红线（与 025 / 026 同款，见 docs/31 §2.3）：
 *  - `audit_logs` / `authorization_logs` 不改写（append-only）；
 *  - 已投递的 Outbox 事件保留原值，仅追加 `batchNoRenumberedFrom` / `outsourceNoRenumberedFrom`；
 *  - 两条 2023 行的 `outsource_no` 为 NULL（ERP 无对账单，口径见 docs/34 §3），不参与本次改号。
 *
 * 幂等：留痕表已记录的行由 `ON CONFLICT (order_id, kind) DO NOTHING` 跳过；全新库（种子已是新口径）
 * 命中 0 行，迁移不做任何改写。
 */

/** 改号前前缀（委外单号 / 批次号共用同一历史形态） */
const SOURCE_PREFIX = 'WW-';
/** 委外单号目标前缀：对齐 ERP `DlyndxSC`(VchType=181) 号段 */
const OUTSOURCE_TARGET_PREFIX = 'WWJG-';
/** 委外批次号目标前缀：批次号族（与 2023 历史行 B20231010-03 同族） */
const BATCH_TARGET_PREFIX = 'B';
/** 前缀长度 + 1（SQL `substr` 从 1 开始计数） */
const SOURCE_PREFIX_OFFSET = SOURCE_PREFIX.length + 1;

/** 承载 `batch_no` 活引用的表（`authorization_logs` 属留痕，不在其列） */
const BATCH_REFERENCE_TABLES = ['pending_mrb_items', 'mrb_reviews', 'batch_trace_nodes'] as const;

/** 未投递状态：引用必须改新值，否则对端会收到已不存在的单号 / 批次号 */
const UNDELIVERED_STATUS_SQL = "('PENDING', 'FAILED')";

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. 留痕表
  await sql`
    CREATE TABLE IF NOT EXISTS outsource_reference_renumberings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id UUID,
      order_no VARCHAR(64),
      kind VARCHAR(16) NOT NULL,
      old_value VARCHAR(64) NOT NULL,
      new_value VARCHAR(64) NOT NULL,
      note TEXT,
      migrated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (order_id, kind)
    )
  `.execute(db);

  // 2. 记录映射（只为确实存在旧形态的行留痕，保证 down 不误改）
  await sql`
    INSERT INTO outsource_reference_renumberings (order_id, order_no, kind, old_value, new_value, note)
    SELECT o.id,
           o.order_no,
           'OUTSOURCE_NO',
           o.outsource_no,
           ${OUTSOURCE_TARGET_PREFIX} || substr(o.outsource_no, ${SOURCE_PREFIX_OFFSET}),
           '委外加工单号号段对齐 ERP（DlyndxSC VchType=181: WWJG-*）'
    FROM inspection_orders AS o
    WHERE o.outsource_no LIKE ${SOURCE_PREFIX + '%'}
      AND o.outsource_no NOT LIKE ${OUTSOURCE_TARGET_PREFIX + '%'}
    ON CONFLICT (order_id, kind) DO NOTHING
  `.execute(db);

  await sql`
    INSERT INTO outsource_reference_renumberings (order_id, order_no, kind, old_value, new_value, note)
    SELECT o.id,
           o.order_no,
           'BATCH_NO',
           o.batch_no,
           ${BATCH_TARGET_PREFIX} || substr(o.batch_no, ${SOURCE_PREFIX_OFFSET}),
           '委外批次号与委外加工单号解耦（批次号形态 B{YYYYMMDD}-{NNN}）'
    FROM inspection_orders AS o
    WHERE o.batch_no LIKE ${SOURCE_PREFIX + '%'}
      AND o.batch_no NOT LIKE ${OUTSOURCE_TARGET_PREFIX + '%'}
    ON CONFLICT (order_id, kind) DO NOTHING
  `.execute(db);

  const { rows: countRows } = await sql<{ kind: string; total: string }>`
    SELECT kind, count(*)::text AS "total"
    FROM outsource_reference_renumberings
    GROUP BY kind
  `.execute(db);
  const mappedOutsource = Number(countRows.find((row) => row.kind === 'OUTSOURCE_NO')?.total ?? '0');
  const mappedBatch = Number(countRows.find((row) => row.kind === 'BATCH_NO')?.total ?? '0');

  if (mappedOutsource === 0 && mappedBatch === 0) {
    console.log('[028] 无 `WW-` 形态的委外单号 / 批次号（库已是新口径），无需改号');
    return;
  }

  const rewritten: string[] = [];

  // 3. 检验单：单号 + 批次号
  const outsourceResult = await sql`
    UPDATE inspection_orders AS o
    SET outsource_no = r.new_value
    FROM outsource_reference_renumberings AS r
    WHERE r.kind = 'OUTSOURCE_NO'
      AND o.id = r.order_id
      AND o.outsource_no = r.old_value
  `.execute(db);
  const outsourceAffected = Number(outsourceResult.numAffectedRows ?? 0);
  if (outsourceAffected > 0) rewritten.push(`inspection_orders.outsource_no=${outsourceAffected}`);

  const batchResult = await sql`
    UPDATE inspection_orders AS o
    SET batch_no = r.new_value
    FROM outsource_reference_renumberings AS r
    WHERE r.kind = 'BATCH_NO'
      AND o.id = r.order_id
      AND o.batch_no = r.old_value
  `.execute(db);
  const batchAffected = Number(batchResult.numAffectedRows ?? 0);
  if (batchAffected > 0) rewritten.push(`inspection_orders.batch_no=${batchAffected}`);

  // 4. 批次号活引用（追溯主键 / MRB 侧快照）
  for (const table of BATCH_REFERENCE_TABLES) {
    const result = await sql`
      UPDATE ${sql.table(table)} AS t
      SET batch_no = r.new_value
      FROM outsource_reference_renumberings AS r
      WHERE r.kind = 'BATCH_NO' AND t.batch_no = r.old_value
    `.execute(db);
    const affected = Number(result.numAffectedRows ?? 0);
    if (affected > 0) rewritten.push(`${table}.batch_no=${affected}`);
  }

  // 5. Outbox：未投递改引用 + 追加来源；已投递仅追加来源
  for (const [kind, key, fromKey] of [
    ['BATCH_NO', 'batchNo', 'batchNoRenumberedFrom'],
    ['OUTSOURCE_NO', 'outsourceNo', 'outsourceNoRenumberedFrom'],
  ] as const) {
    const undelivered = await sql`
      UPDATE outbox_events AS e
      SET payload = jsonb_set(
                      jsonb_set(e.payload, ARRAY[${key}], to_jsonb(r.new_value), true),
                      ARRAY[${fromKey}], to_jsonb(r.old_value), true
                    )
      FROM outsource_reference_renumberings AS r
      WHERE r.kind = ${kind}
        AND e.payload ->> ${key} = r.old_value
        AND e.status IN ${sql.raw(UNDELIVERED_STATUS_SQL)}
    `.execute(db);
    const undeliveredAffected = Number(undelivered.numAffectedRows ?? 0);
    if (undeliveredAffected > 0) rewritten.push(`outbox_events.payload.${key}=${undeliveredAffected}`);

    const delivered = await sql`
      UPDATE outbox_events AS e
      SET payload = jsonb_set(e.payload, ARRAY[${fromKey}], to_jsonb(r.old_value), true)
      FROM outsource_reference_renumberings AS r
      WHERE r.kind = ${kind}
        AND e.payload ->> ${key} = r.old_value
        AND e.status NOT IN ${sql.raw(UNDELIVERED_STATUS_SQL)}
    `.execute(db);
    const deliveredAffected = Number(delivered.numAffectedRows ?? 0);
    if (deliveredAffected > 0) rewritten.push(`outbox_events.payload.${fromKey}=${deliveredAffected}`);
  }

  console.log(
    `[028] 委外单号改号 ${mappedOutsource} 条（WW- -> WWJG-）、委外批次号改号 ${mappedBatch} 条（WW- -> B…）；` +
      `活引用改写：${rewritten.length === 0 ? '无' : rewritten.join(', ')}`
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const { rows } = await sql<{ total: string }>`
    SELECT count(*)::text AS "total" FROM outsource_reference_renumberings
  `.execute(db);
  if (Number(rows[0]?.total ?? '0') === 0) {
    await sql`DROP TABLE IF EXISTS outsource_reference_renumberings`.execute(db);
    console.log('[028] 无改号留痕，直接删除留痕表');
    return;
  }

  // 1. Outbox 还原并去掉来源标记
  for (const [kind, key, fromKey] of [
    ['BATCH_NO', 'batchNo', 'batchNoRenumberedFrom'],
    ['OUTSOURCE_NO', 'outsourceNo', 'outsourceNoRenumberedFrom'],
  ] as const) {
    await sql`
      UPDATE outbox_events AS e
      SET payload = jsonb_set(e.payload, ARRAY[${key}], to_jsonb(r.old_value), true)
      FROM outsource_reference_renumberings AS r
      WHERE r.kind = ${kind} AND e.payload ->> ${key} = r.new_value
    `.execute(db);
    await sql`
      UPDATE outbox_events AS e
      SET payload = e.payload - ${fromKey}
      FROM outsource_reference_renumberings AS r
      WHERE r.kind = ${kind} AND e.payload ->> ${fromKey} = r.old_value
    `.execute(db);
  }

  // 2. 活引用还原（批次号）
  for (const table of BATCH_REFERENCE_TABLES) {
    await sql`
      UPDATE ${sql.table(table)} AS t
      SET batch_no = r.old_value
      FROM outsource_reference_renumberings AS r
      WHERE r.kind = 'BATCH_NO' AND t.batch_no = r.new_value
    `.execute(db);
  }

  // 3. 检验单还原
  await sql`
    UPDATE inspection_orders AS o
    SET batch_no = r.old_value
    FROM outsource_reference_renumberings AS r
    WHERE r.kind = 'BATCH_NO' AND o.id = r.order_id AND o.batch_no = r.new_value
  `.execute(db);
  await sql`
    UPDATE inspection_orders AS o
    SET outsource_no = r.old_value
    FROM outsource_reference_renumberings AS r
    WHERE r.kind = 'OUTSOURCE_NO' AND o.id = r.order_id AND o.outsource_no = r.new_value
  `.execute(db);

  await sql`DELETE FROM outsource_reference_renumberings`.execute(db);
  await sql`DROP TABLE IF EXISTS outsource_reference_renumberings`.execute(db);
  console.log('[028] 已按留痕表回滚委外单号与批次号并删除留痕表');
}
