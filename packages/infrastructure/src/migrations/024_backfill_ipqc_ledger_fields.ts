import { Kysely, sql } from 'kysely';

/**
 * 024 过程检验 (IPQC) 台账工序列回填
 *
 * 背景（见 docs/29-过程检验下料检验台账列字段与接口打通设计.md §3）：
 * 迁移 007 新增的 10 个过程检验物理列，其回填 `UPDATE ... WHERE order_type = 'IPQC_CT'`
 * 只作用于**执行当时已存在的行**。本机库在 007 之后重新播种，新插入的 IPQC 行
 * 这 10 列全部为 NULL —— 回填对它们等于空转，台账「断料长度 / 操作员 / 设备 / 完成时间」
 * 只能显示 `--`。本迁移对**当前库内全部 IPQC 行**重新应用同一套映射，且只补 NULL，
 * 绝不覆盖 MES 同步链路（mes-sync-service）写入的真实值。
 *
 * 口径：
 *  1. 一律 `COALESCE(列, 兜底值)`：已有值（尤其 MES 实绩同步写入的）保持不动；
 *  2. `total_qty` 刻意不回填：库内无「报检批量」的可信来源（`sample_qty` 是抽检数，
 *     不是报检批量），按「宁可显示 -- 也不推导假值」口径交由写路径负责（seed / 建单）；
 *  3. `completed_at` 口径 = 该工序报工/报检登记时间，缺失时按 `updated_at` 回填。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. 下料检验 (IPQC_CT)：自动断料工序 + 冷镦机台 + 断料长度
  await sql`
    UPDATE inspection_orders
    SET
      process_step = COALESCE(process_step, '自动断料'),
      equipment_code = COALESCE(equipment_code, 'EQ-CT-01'),
      equipment_name = COALESCE(equipment_name, '1#全自动高速冷镦机'),
      operator_name = COALESCE(operator_name, '陈操作'),
      operator_id = COALESCE(operator_id, 'OP-0102'),
      blanking_length = COALESCE(
        blanking_length,
        CASE
          WHEN material_name LIKE '%M6*25%' THEN 25.150
          WHEN material_name LIKE '%M16*140%' THEN 140.220
          WHEN material_name LIKE '%M16*2*85%' THEN 85.120
          WHEN material_name LIKE '%M8*16%' THEN 16.050
          WHEN material_name LIKE '%M20*65%' THEN 65.140
          ELSE 150.000
        END
      )
    WHERE order_type = 'IPQC_CT';
  `.execute(db);

  // 2. 滚丝检验 (IPQC_RL)：手工滚牙工序 + 滚丝机台 + 牙纹规格
  await sql`
    UPDATE inspection_orders
    SET
      process_step = COALESCE(process_step, '手工滚牙'),
      equipment_code = COALESCE(equipment_code, 'EQ-RL-02'),
      equipment_name = COALESCE(equipment_name, '2#精密数控滚丝机'),
      operator_name = COALESCE(operator_name, '刘滚丝'),
      operator_id = COALESCE(operator_id, 'OP-0205'),
      thread_spec = COALESCE(
        thread_spec,
        CASE
          WHEN material_name LIKE '%M6*25%' THEN 'M6*25 6g'
          WHEN material_name LIKE '%M16*2*85%' THEN 'M16*2.0-6g'
          WHEN material_name LIKE '%M16*140%' THEN 'M16*2.0-6g'
          WHEN material_name LIKE '%M8*16%' THEN 'M8*1.25-6g'
          WHEN material_name LIKE '%M20*65%' THEN 'M20*2.5-6g'
          ELSE '6g / 公差等级合格'
        END
      )
    WHERE order_type = 'IPQC_RL';
  `.execute(db);

  // 3. 成品检 (IPQC_FN)：检测入库关卡工序 + 终检班组（不回写 is_mandatory_gate，
  //    该列由种子/建单按业务判定写入，历史行沿用 007 的既有结果）
  await sql`
    UPDATE inspection_orders
    SET
      process_step = COALESCE(process_step, '检测入库'),
      inspection_team = COALESCE(inspection_team, '终检一组')
    WHERE order_type = 'IPQC_FN';
  `.execute(db);

  // 4. 完成时间为空的 IPQC 行按 updated_at 回填（口径：工序报工/报检登记时间）
  await sql`
    UPDATE inspection_orders
    SET completed_at = COALESCE(completed_at, updated_at)
    WHERE order_type IN ('IPQC_CT', 'IPQC_RL', 'IPQC_FN')
      AND completed_at IS NULL;
  `.execute(db);
}

/**
 * 回填不可逆：`down()` 无法区分「本迁移补的值」与「业务真实写入的值」，
 * 若按列整体置 NULL 会连带清掉 MES 同步的真实数据（与 011 / 022 / 023 一致的处理方式）。
 */
export async function down(_db: Kysely<unknown>): Promise<void> {
  // no-op
}
