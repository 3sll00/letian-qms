import { Kysely, sql } from 'kysely';

/**
 * 迁移 026：物料编码历史遗留统一（原型遗留编码 -> 主数据 `MAT-*` 口径）
 *
 * 背景：`materials` 里并存两套编码族——`MAT-*`（10 条，ERP 主数据口径，见 docs/26/27/30 的
 * `Ptype.UserCode` -> `materials.material_code` 对齐）与 `CP-*`（7 条，WPS 设计稿原型遗留，
 * 见 docs/16 §6.3）。【委外检验】三个页签同时命中两族（表面处理 Tab 全 `MAT-*`，
 * 机加工 Tab `CP-004`/`CP-005`，热处理 Tab `CP-006`/`CP-007`），同一列出现两代形态。详见 docs/32。
 *
 * 本迁移在同一事务内做三件事：
 *  1. 建留痕表 `material_code_renumberings`（旧编码 -> 新编码，长期留痕 + down 依据）；
 *  2. 按**固定字典**（编码口径是决策，不从数据推导）把 `materials.material_code` 改名为 `MAT-*` 口径；
 *  3. 同步改写活引用：`inspection_orders` / `batch_trace_nodes` / `inspection_plans` /
 *     `mrb_reviews` / `pending_mrb_items` 的 `material_code`、`material_permissions.material_codes`
 *     （JSONB 数组元素）、**未投递** Outbox 事件的 `payload.materialCode`。
 *
 * 留痕红线（与 025 同款，见 docs/31 §2.3）：
 *  - `material_name` / `specification` / `unit` 是物料主数据快照，不随编码改名；
 *  - `authorization_logs.material_code` 属权限校验留痕，**保持原值**，迁移只打印命中数；
 *  - 已投递（非 `PENDING` / `FAILED`）的 Outbox 事件保留原值，仅追加 `materialCodeRenumberedFrom`。
 *
 * 幂等：留痕表已存在且已记录的行会被 `ON CONFLICT DO NOTHING` 跳过；若 `materials` 里已经
 * 没有旧编码（例如全新库直接播种新口径种子），映射表为空，迁移不做任何改写。
 */

/** 固定映射字典：原型遗留编码 -> `MAT-*` 主数据口径编码（命名规则见 docs/32 §3.1） */
const MATERIAL_CODE_RENUMBERINGS: ReadonlyArray<{ oldCode: string; newCode: string; note: string }> = [
  { oldCode: 'CP-001', newCode: 'MAT-BLT-88-M10', note: '六角螺栓M10 M10×30/8.8级/蓝白锌' },
  { oldCode: 'CP-002', newCode: 'MAT-BLT-88-M12-40', note: '六角螺栓M12 M12×40/8.8级/发黑；与 MAT-BLT-88-M12(M12*60) 同等级同直径，追加长度消歧' },
  { oldCode: 'CP-003', newCode: 'MAT-BLT-FLG-M8', note: '法兰螺栓 M8×25/法兰面/镀锌' },
  { oldCode: 'CP-004', newCode: 'MAT-SLV-45-20-30', note: '精密轴套 Φ20×30mm/45# 钢/精磨外圆' },
  { oldCode: 'CP-005', newCode: 'MAT-CON-M12', note: '连接件 M12/机加工成品' },
  { oldCode: 'CP-006', newCode: 'MAT-BLT-109-M10-HT', note: '高强度螺栓 M10×45/10.9级/热处理回厂；与成品态 MAT-BLT-109-M10(蓝白锌) 追加工艺阶段消歧' },
  { oldCode: 'CP-007', newCode: 'MAT-WSH-SPR-M10', note: '弹簧垫圈 Φ10/65Mn/热处理回厂' },
];

/** 承载 `material_code` 活引用的表（`authorization_logs` 属留痕，不在其列） */
const MATERIAL_CODE_REFERENCE_TABLES = [
  'inspection_orders',
  'batch_trace_nodes',
  'inspection_plans',
  'mrb_reviews',
  'pending_mrb_items',
] as const;

/** 未投递状态：引用必须改新编码，否则对端会收到已不存在的物料编码 */
const UNDELIVERED_STATUS_SQL = "('PENDING', 'FAILED')";

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. 留痕表：旧编码 -> 新编码（长期留痕 + down 依据）
  await sql`
    CREATE TABLE IF NOT EXISTS material_code_renumberings (
      old_code VARCHAR(64) PRIMARY KEY,
      new_code VARCHAR(64) NOT NULL UNIQUE,
      material_id UUID,
      material_name VARCHAR(255),
      note TEXT,
      migrated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db);

  // 2. 记录映射：只为**确实存在于主数据**的旧编码留痕（未发生改名则不记录，保证 down 不会误改）
  let insertCount = 0;
  for (const entry of MATERIAL_CODE_RENUMBERINGS) {
    const result = await sql`
      INSERT INTO material_code_renumberings (old_code, new_code, material_id, material_name, note)
      SELECT ${entry.oldCode}, ${entry.newCode}, m.id, m.material_name, ${entry.note}
      FROM materials AS m
      WHERE m.material_code = ${entry.oldCode}
      ON CONFLICT (old_code) DO NOTHING
    `.execute(db);
    insertCount += Number(result.numAffectedRows ?? 0);
  }

  const { rows: mappedRows } = await sql<{ total: string }>`
    SELECT count(*)::text AS "total" FROM material_code_renumberings
  `.execute(db);
  const mapped = Number(mappedRows[0]?.total ?? '0');

  if (mapped === 0) {
    console.log('[026] 主数据中不存在原型遗留编码（CP-*），无需改号');
    return;
  }

  // 3. 主数据改名
  const materialsResult = await sql`
    UPDATE materials AS m
    SET material_code = r.new_code
    FROM material_code_renumberings AS r
    WHERE m.material_code = r.old_code
  `.execute(db);

  // 4. 活引用改写
  const rewritten: string[] = [];
  for (const table of MATERIAL_CODE_REFERENCE_TABLES) {
    const result = await sql`
      UPDATE ${sql.table(table)} AS t
      SET material_code = r.new_code
      FROM material_code_renumberings AS r
      WHERE t.material_code = r.old_code
    `.execute(db);
    const affected = Number(result.numAffectedRows ?? 0);
    if (affected > 0) {
      rewritten.push(`${table}.material_code=${affected}`);
    }
  }

  // 5. 权限白名单（JSONB 数组元素，保持原顺序）
  const permissionsResult = await sql`
    UPDATE material_permissions AS p
    SET material_codes = COALESCE(
          (
            SELECT jsonb_agg(COALESCE(r.new_code, e.elem) ORDER BY e.ord)
            FROM jsonb_array_elements_text(p.material_codes) WITH ORDINALITY AS e(elem, ord)
            LEFT JOIN material_code_renumberings AS r ON r.old_code = e.elem
          ),
          '[]'::jsonb
        )
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(p.material_codes) AS old(elem)
      JOIN material_code_renumberings AS r ON r.old_code = old.elem
    )
  `.execute(db);
  const permissionsAffected = Number(permissionsResult.numAffectedRows ?? 0);
  if (permissionsAffected > 0) {
    rewritten.push(`material_permissions.material_codes=${permissionsAffected}`);
  }

  // 6. Outbox：未投递改引用 + 追加来源；已投递仅追加来源
  const undelivered = await sql`
    UPDATE outbox_events AS e
    SET payload = jsonb_set(
                    jsonb_set(e.payload, ARRAY['materialCode'], to_jsonb(r.new_code), true),
                    ARRAY['materialCodeRenumberedFrom'], to_jsonb(r.old_code), true
                  )
    FROM material_code_renumberings AS r
    WHERE e.payload ->> 'materialCode' = r.old_code
      AND e.status IN ${sql.raw(UNDELIVERED_STATUS_SQL)}
  `.execute(db);
  const undeliveredAffected = Number(undelivered.numAffectedRows ?? 0);
  if (undeliveredAffected > 0) {
    rewritten.push(`outbox_events.payload.materialCode=${undeliveredAffected}`);
  }

  const delivered = await sql`
    UPDATE outbox_events AS e
    SET payload = jsonb_set(e.payload, ARRAY['materialCodeRenumberedFrom'], to_jsonb(r.old_code), true)
    FROM material_code_renumberings AS r
    WHERE e.payload ->> 'materialCode' = r.old_code
      AND e.status NOT IN ${sql.raw(UNDELIVERED_STATUS_SQL)}
  `.execute(db);
  if (Number(delivered.numAffectedRows ?? 0) > 0) {
    rewritten.push(`outbox_events.payload.materialCodeRenumberedFrom=${Number(delivered.numAffectedRows)}`);
  }

  // 7. 留痕表命中统计（不改写，仅对账；本机为 0）
  const { rows: logRows } = await sql<{ total: string }>`
    SELECT count(*)::text AS "total"
    FROM authorization_logs AS a
    JOIN material_code_renumberings AS r ON a.material_code = r.old_code
  `.execute(db);

  console.log(
    `[026] 物料编码改号 ${mapped} 条（本次新增留痕 ${insertCount} 条，主数据命中 ${Number(
      materialsResult.numAffectedRows ?? 0
    )} 行）；活引用改写：${rewritten.length === 0 ? '无' : rewritten.join(', ')}；` +
      `authorization_logs 留痕命中 ${logRows[0]?.total ?? '0'} 行（留痕不改写）`
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const { rows } = await sql<{ total: string }>`
    SELECT count(*)::text AS "total" FROM material_code_renumberings
  `.execute(db);
  if (Number(rows[0]?.total ?? '0') === 0) {
    await sql`DROP TABLE IF EXISTS material_code_renumberings`.execute(db);
    console.log('[026] 无改号留痕，直接删除留痕表');
    return;
  }

  // 1. 活引用还原
  for (const table of MATERIAL_CODE_REFERENCE_TABLES) {
    await sql`
      UPDATE ${sql.table(table)} AS t
      SET material_code = r.old_code
      FROM material_code_renumberings AS r
      WHERE t.material_code = r.new_code
    `.execute(db);
  }

  // 2. 权限白名单还原
  await sql`
    UPDATE material_permissions AS p
    SET material_codes = COALESCE(
          (
            SELECT jsonb_agg(COALESCE(r.old_code, e.elem) ORDER BY e.ord)
            FROM jsonb_array_elements_text(p.material_codes) WITH ORDINALITY AS e(elem, ord)
            LEFT JOIN material_code_renumberings AS r ON r.new_code = e.elem
          ),
          '[]'::jsonb
        )
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(p.material_codes) AS cur(elem)
      JOIN material_code_renumberings AS r ON r.new_code = cur.elem
    )
  `.execute(db);

  // 3. Outbox 还原并去掉来源标记
  await sql`
    UPDATE outbox_events AS e
    SET payload = jsonb_set(e.payload, ARRAY['materialCode'], to_jsonb(r.old_code), true)
    FROM material_code_renumberings AS r
    WHERE e.payload ->> 'materialCode' = r.new_code
  `.execute(db);
  await sql`
    UPDATE outbox_events AS e
    SET payload = e.payload - 'materialCodeRenumberedFrom'
    FROM material_code_renumberings AS r
    WHERE e.payload ->> 'materialCodeRenumberedFrom' = r.old_code
  `.execute(db);

  // 4. 主数据还原（引用先还原，主数据后还原，避免中途出现「引用指向不存在编码」）
  await sql`
    UPDATE materials AS m
    SET material_code = r.old_code
    FROM material_code_renumberings AS r
    WHERE m.material_code = r.new_code
  `.execute(db);

  await sql`DELETE FROM material_code_renumberings`.execute(db);
  await sql`DROP TABLE IF EXISTS material_code_renumberings`.execute(db);
  console.log('[026] 已按留痕表回滚物料编码并删除留痕表');
}

