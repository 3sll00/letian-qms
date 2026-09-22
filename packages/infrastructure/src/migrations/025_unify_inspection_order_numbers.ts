import { Kysely, sql } from 'kysely';
import {
  MAX_INSPECTION_ORDER_NO_SEQ,
  resolveInspectionOrderNoPrefix,
  toLocalDayKey,
} from '@letian/domain';

/**
 * 迁移 025：检验单号历史遗留统一（方案 B）
 *
 * 背景：012 迁移只建了单号流水号池并回填「合规」历史号，对三段式历史号
 * `INS-{YYYYMMDD}-{NNN}`（如委外表处的 `INS-20231012-005`）刻意未处理，导致同一台账
 * 同时出现 `INS-…` 与 `OQC-SF-…` 两代形态；且 `INS-` 本是 IQC / IPQC 的中性前缀，
 * 却被 2 条委外（`OQC_SF`）历史行占用，语义错位。详见 docs/31。
 *
 * 本迁移在同一事务内做四件事：
 *  1. 建映射表 `inspection_order_no_renumberings`（旧号 → 新号，长期留痕 + down 依据）；
 *  2. 把不合规单号按领域唯一口径 `resolveInspectionOrderNoPrefix(order_type)` 重编为
 *     `{前缀}-{YYYYMMDD}-{NNNN}`：日期段保留原单自身日期，流水续排「该 (前缀, 日期) 已有最大流水」之后；
 *  3. 同步改写**活引用**：`inspection_orders.order_no`（含 `-R{n}` 复检行）、`mrb_reviews.source_order_no`、
 *     `pending_mrb_items.source_order_no`、`batch_trace_nodes.order_no` / `inspection_order_no`、
 *     `external_document_mappings.local_aggregate_id`、**未投递**（`PENDING` / `FAILED`）Outbox 事件的
 *     `aggregate_id` 与 payload 内的单号键；
 *  4. 补写单号池 `inspection_order_no_sequences`，保证后续新建单不与历史号撞号。
 *
 * 历史留痕红线（见 docs/31 §2）：
 *  - `audit_logs` 由 `prevent_audit_log_tampering` 触发器强制 append-only（UPDATE / DELETE 抛 `55000`），
 *    **零改动**；本迁移也**不插入伪审计事件**——批量写入并非真实业务动作的记录会污染看板「最近动态」
 *    （其口径为 `order by occurred_at desc limit 6`）与审计统计；
 *  - **已投递**（非 `PENDING` / `FAILED`）的 Outbox 事件保留原值，仅追加 `renumberedFrom`，避免与外部系统不可对账；
 *  - 自由文本日志（`authorization_logs.detail` / `integration_sync_logs.error_message`）改写会篡改留痕，保持原样。
 *
 * 单号池高水位只增不减：down（回滚）不回收本次补写的 (前缀, 日期) 键，避免回滚后新单撞上历史号。
 */

/** 合规单号（含复检轮次后缀）：`{前缀}-{YYYYMMDD}-{NNNN}` */
const COMPLIANT_ORDER_NO_PATTERN = '^[A-Z0-9]+(-[A-Z0-9]+)*-[0-9]{8}-[0-9]{4}(-R[0-9]+)?$';
/** 复检轮次后缀 `-R{n}` */
const ROUND_SUFFIX_PATTERN = /(-R[0-9]+)$/;
/** 合规单号拆解：前缀 / 日期段 / 流水段 / 复检后缀 */
const COMPLIANT_ORDER_NO_JS = /^(.+)-([0-9]{8})-([0-9]{4})(-R[0-9]+)?$/;
/** 历史单号里的日期段（`...-{YYYYMMDD}-{序}`，序可为 3 位三段式或即席长数字） */
const LEGACY_DAY_KEY_JS = /^.*?([0-9]{8})-([0-9]+)$/;
/** Outbox payload 中可能出现单号的键（与 use-cases 实际写入的键一致） */
const OUTBOX_ORDER_NO_KEYS = [
  'orderNo',
  'sourceOrderNo',
  'originalOrderNo',
  'reinspectionOrderNo',
  'inspectionOrderNo',
] as const;
/** 未投递状态：引用必须改新号，否则对端会收到失效单号 */
const UNDELIVERED_STATUS_SQL = "('PENDING', 'FAILED')";

interface LegacyOrderRow {
  id: string;
  orderNo: string;
  orderType: string;
  createdAt: Date;
}

interface Renumbering {
  oldNo: string;
  newNo: string;
  orderId: string;
  orderType: string;
}

const sequenceKeyOf = (prefix: string, dayKey: string): string => prefix + '\u0000' + dayKey;

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. 映射表：旧号 → 新号（长期留痕 + down 依据）
  await sql`
    CREATE TABLE IF NOT EXISTS inspection_order_no_renumberings (
      old_no VARCHAR(64) PRIMARY KEY,
      new_no VARCHAR(64) NOT NULL UNIQUE,
      order_id UUID NOT NULL,
      order_type VARCHAR(32) NOT NULL,
      migrated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db);

  // 2. 取全部不合规单号（排除已在本表留痕的行，保证重复执行幂等）
  const { rows: legacyRows } = await sql<LegacyOrderRow>`
    SELECT id::text AS "id",
           order_no AS "orderNo",
           order_type AS "orderType",
           created_at AS "createdAt"
    FROM inspection_orders
    WHERE order_no !~ ${COMPLIANT_ORDER_NO_PATTERN}
      AND order_no NOT IN (SELECT old_no FROM inspection_order_no_renumberings)
    ORDER BY order_no
  `.execute(db);

  if (legacyRows.length === 0) {
    console.log('[025] 库中不存在不合规历史单号，无需改号');
    return;
  }

  // 3. 汇总「已用最大流水」：库中合规单号 + 单号池高水位
  const usedSeq = new Map<string, number>();
  const { rows: existingRows } = await sql<{ orderNo: string }>`
    SELECT order_no AS "orderNo" FROM inspection_orders
  `.execute(db);
  for (const row of existingRows) {
    const matched = COMPLIANT_ORDER_NO_JS.exec(row.orderNo);
    if (!matched) continue;
    const key = sequenceKeyOf(matched[1] ?? '', matched[2] ?? '');
    usedSeq.set(key, Math.max(usedSeq.get(key) ?? 0, Number(matched[3])));
  }
  const { rows: poolRows } = await sql<{ prefix: string; dayKey: string; lastSeq: number }>`
    SELECT prefix, day_key AS "dayKey", last_seq AS "lastSeq" FROM inspection_order_no_sequences
  `.execute(db);
  for (const row of poolRows) {
    const key = sequenceKeyOf(row.prefix, row.dayKey);
    usedSeq.set(key, Math.max(usedSeq.get(key) ?? 0, Number(row.lastSeq)));
  }

  // 4. 计算映射：前缀按领域规则、日期段保留原单日期、流水续排
  const renumberings: Renumbering[] = [];
  for (const row of legacyRows) {
    const roundSuffix = ROUND_SUFFIX_PATTERN.exec(row.orderNo)?.[1] ?? '';
    const base = roundSuffix === '' ? row.orderNo : row.orderNo.slice(0, -roundSuffix.length);
    const dayKey = LEGACY_DAY_KEY_JS.exec(base)?.[1] ?? toLocalDayKey(new Date(row.createdAt));
    const prefix = resolveInspectionOrderNoPrefix(row.orderType);
    const key = sequenceKeyOf(prefix, dayKey);
    const nextSeq = (usedSeq.get(key) ?? 0) + 1;
    if (nextSeq > MAX_INSPECTION_ORDER_NO_SEQ) {
      throw new Error(
        `ORDER_NO_RENUMBER_SEQ_OVERFLOW: ${prefix}-${dayKey} 当日流水已耗尽（上限 ${MAX_INSPECTION_ORDER_NO_SEQ}）`
      );
    }
    usedSeq.set(key, nextSeq);
    renumberings.push({
      oldNo: row.orderNo,
      newNo: `${prefix}-${dayKey}-${String(nextSeq).padStart(4, '0')}`,
      orderId: row.id,
      orderType: row.orderType,
    });
  }

  for (const item of renumberings) {
    await sql`
      INSERT INTO inspection_order_no_renumberings (old_no, new_no, order_id, order_type)
      VALUES (${item.oldNo}, ${item.newNo}, ${item.orderId}, ${item.orderType})
    `.execute(db);
  }
  console.log(
    `[025] 改号 ${renumberings.length} 条：` +
      renumberings.map((item) => `${item.oldNo} -> ${item.newNo}`).join('; ')
  );

  // 5. 活引用改写（精确引用 + `-R{n}` 复检后缀两种形态）
  const rewriteExact = async (table: string, column: string): Promise<number> => {
    const { rows } = await sql<{ hit: number }>`
      UPDATE ${sql.table(table)} AS t
      SET ${sql.ref(column)} = m.new_no
      FROM inspection_order_no_renumberings AS m
      WHERE t.${sql.ref(column)} = m.old_no
      RETURNING 1 AS "hit"
    `.execute(db);
    return rows.length;
  };
  const rewriteRound = async (table: string, column: string): Promise<number> => {
    const { rows } = await sql<{ hit: number }>`
      UPDATE ${sql.table(table)} AS t
      SET ${sql.ref(column)} = m.new_no || substring(t.${sql.ref(column)} from '(-R[0-9]+)$')
      FROM inspection_order_no_renumberings AS m
      WHERE t.${sql.ref(column)} ~ ('^' || m.old_no || '-R[0-9]+$')
      RETURNING 1 AS "hit"
    `.execute(db);
    return rows.length;
  };

  const rewritten: string[] = [];
  for (const [table, column] of [
    ['inspection_orders', 'order_no'],
    ['mrb_reviews', 'source_order_no'],
    ['pending_mrb_items', 'source_order_no'],
    ['batch_trace_nodes', 'order_no'],
    ['batch_trace_nodes', 'inspection_order_no'],
    ['external_document_mappings', 'local_aggregate_id'],
  ] as const) {
    const exact = await rewriteExact(table, column);
    const round = await rewriteRound(table, column);
    if (exact + round > 0) {
      rewritten.push(`${table}.${column}=${exact + round}`);
    }
  }

  // 6. Outbox：未投递改引用（+ 追加 renumberedFrom），已投递仅追加 renumberedFrom
  for (const key of OUTBOX_ORDER_NO_KEYS) {
    await sql`
      UPDATE outbox_events AS e
      SET payload = jsonb_set(
                      jsonb_set(e.payload, ARRAY[${key}], to_jsonb(m.new_no), true),
                      ARRAY['renumberedFrom'], to_jsonb(m.old_no), true
                    )
      FROM inspection_order_no_renumberings AS m
      WHERE e.payload ->> ${key} = m.old_no
        AND e.status IN ${sql.raw(UNDELIVERED_STATUS_SQL)}
    `.execute(db);

    await sql`
      UPDATE outbox_events AS e
      SET payload = jsonb_set(
                      jsonb_set(
                        e.payload,
                        ARRAY[${key}],
                        to_jsonb(m.new_no || substring(e.payload ->> ${key} from '(-R[0-9]+)$')),
                        true
                      ),
                      ARRAY['renumberedFrom'], to_jsonb(m.old_no), true
                    )
      FROM inspection_order_no_renumberings AS m
      WHERE e.payload ->> ${key} ~ ('^' || m.old_no || '-R[0-9]+$')
        AND e.status IN ${sql.raw(UNDELIVERED_STATUS_SQL)}
    `.execute(db);

    await sql`
      UPDATE outbox_events AS e
      SET payload = jsonb_set(e.payload, ARRAY['renumberedFrom'], to_jsonb(m.old_no), true)
      FROM inspection_order_no_renumberings AS m
      WHERE e.payload ->> ${key} = m.old_no
        AND e.status NOT IN ${sql.raw(UNDELIVERED_STATUS_SQL)}
    `.execute(db);
  }
  await sql`
    UPDATE outbox_events AS e
    SET aggregate_id = m.new_no
    FROM inspection_order_no_renumberings AS m
    WHERE e.aggregate_id = m.old_no
      AND e.status IN ${sql.raw(UNDELIVERED_STATUS_SQL)}
  `.execute(db);

  // 7. 单号池补写（只抬升高水位，不回退）
  await sql`
    INSERT INTO inspection_order_no_sequences (prefix, day_key, last_seq, updated_at)
    SELECT (regexp_match(new_no, '^(.+)-([0-9]{8})-([0-9]{4})$'))[1],
           (regexp_match(new_no, '^(.+)-([0-9]{8})-([0-9]{4})$'))[2],
           MAX(((regexp_match(new_no, '^(.+)-([0-9]{8})-([0-9]{4})$'))[3])::int),
           now()
    FROM inspection_order_no_renumberings
    GROUP BY 1, 2
    ON CONFLICT (prefix, day_key) DO UPDATE
      SET last_seq = GREATEST(inspection_order_no_sequences.last_seq, EXCLUDED.last_seq),
          updated_at = now()
  `.execute(db);

  console.log(`[025] 活引用改写：${rewritten.length === 0 ? '无' : rewritten.join(', ')}；单号池高水位已抬升`);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const { rows } = await sql<{ total: string }>`
    SELECT count(*)::text AS "total" FROM inspection_order_no_renumberings
  `.execute(db);
  if (Number(rows[0]?.total ?? '0') === 0) {
    await sql`DROP TABLE IF EXISTS inspection_order_no_renumberings`.execute(db);
    return;
  }

  const restoreExact = async (table: string, column: string): Promise<void> => {
    await sql`
      UPDATE ${sql.table(table)} AS t
      SET ${sql.ref(column)} = m.old_no
      FROM inspection_order_no_renumberings AS m
      WHERE t.${sql.ref(column)} = m.new_no
    `.execute(db);
  };
  const restoreRound = async (table: string, column: string): Promise<void> => {
    await sql`
      UPDATE ${sql.table(table)} AS t
      SET ${sql.ref(column)} = m.old_no || substring(t.${sql.ref(column)} from '(-R[0-9]+)$')
      FROM inspection_order_no_renumberings AS m
      WHERE t.${sql.ref(column)} ~ ('^' || m.new_no || '-R[0-9]+$')
    `.execute(db);
  };

  for (const [table, column] of [
    ['inspection_orders', 'order_no'],
    ['mrb_reviews', 'source_order_no'],
    ['pending_mrb_items', 'source_order_no'],
    ['batch_trace_nodes', 'order_no'],
    ['batch_trace_nodes', 'inspection_order_no'],
    ['external_document_mappings', 'local_aggregate_id'],
  ] as const) {
    await restoreExact(table, column);
    await restoreRound(table, column);
  }

  for (const key of OUTBOX_ORDER_NO_KEYS) {
    await sql`
      UPDATE outbox_events AS e
      SET payload = jsonb_set(e.payload, ARRAY[${key}], to_jsonb(m.old_no), true)
      FROM inspection_order_no_renumberings AS m
      WHERE e.payload ->> ${key} = m.new_no
    `.execute(db);
    await sql`
      UPDATE outbox_events AS e
      SET payload = e.payload - 'renumberedFrom'
      FROM inspection_order_no_renumberings AS m
      WHERE e.payload ->> 'renumberedFrom' = m.old_no
    `.execute(db);
  }
  await sql`
    UPDATE outbox_events AS e
    SET aggregate_id = m.old_no
    FROM inspection_order_no_renumberings AS m
    WHERE e.aggregate_id = m.new_no
  `.execute(db);

  // 单号池高水位不回收（只增不减），避免回滚后新建单与历史号撞号
  await sql`DELETE FROM inspection_order_no_renumberings`.execute(db);
  await sql`DROP TABLE IF EXISTS inspection_order_no_renumberings`.execute(db);
  console.log('[025] 已按映射表回滚改号并删除留痕表（单号池高水位保留）');
}