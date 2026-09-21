import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. 添加过程检验核心物理列
  await sql`
    ALTER TABLE inspection_orders
      ADD COLUMN IF NOT EXISTS work_order_no VARCHAR(64),
      ADD COLUMN IF NOT EXISTS blanking_length NUMERIC(10,3),
      ADD COLUMN IF NOT EXISTS operator_name VARCHAR(64),
      ADD COLUMN IF NOT EXISTS operator_id VARCHAR(64),
      ADD COLUMN IF NOT EXISTS equipment_code VARCHAR(64),
      ADD COLUMN IF NOT EXISTS equipment_name VARCHAR(128),
      ADD COLUMN IF NOT EXISTS thread_spec VARCHAR(64),
      ADD COLUMN IF NOT EXISTS inspection_team VARCHAR(64),
      ADD COLUMN IF NOT EXISTS process_step VARCHAR(64),
      ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
  `.execute(db);

  // 2. 建立针对 MES 工单与机台设备的查询加速索引
  await sql`
    CREATE INDEX IF NOT EXISTS idx_inspection_orders_work_order_no
      ON inspection_orders (work_order_no);
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_inspection_orders_equipment_code
      ON inspection_orders (equipment_code);
  `.execute(db);

  // 3. 回填现有历史与种子数据
  // 3.1 统一回填 MES 工单号与检验员
  await sql`
    UPDATE inspection_orders
    SET
      work_order_no = COALESCE(work_order_no, batch_no, 'MO-' || to_char(created_at, 'YYYYMMDD') || '-01'),
      inspector_name = COALESCE(inspector_name, '张强')
    WHERE work_order_no IS NULL OR inspector_name IS NULL;
  `.execute(db);

  // 3.2 回填下料首巡检 (IPQC_CT) 数据
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

  // 3.3 回填滚丝首巡检 (IPQC_RL) 数据
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

  // 3.4 回填成品检 (IPQC_FN) 数据 (关卡工序)
  await sql`
    UPDATE inspection_orders
    SET
      process_step = COALESCE(process_step, '检测入库'),
      inspection_team = COALESCE(inspection_team, '终检一组'),
      is_mandatory_gate = TRUE
    WHERE order_type = 'IPQC_FN';
  `.execute(db);

  // 3.5 状态为终态的补齐完成时间
  await sql`
    UPDATE inspection_orders
    SET completed_at = updated_at
    WHERE completed_at IS NULL
      AND status IN ('COMPLETED', 'PASSED', 'FAILED');
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS idx_inspection_orders_equipment_code;
  `.execute(db);

  await sql`
    DROP INDEX IF EXISTS idx_inspection_orders_work_order_no;
  `.execute(db);

  await sql`
    ALTER TABLE inspection_orders
      DROP COLUMN IF EXISTS work_order_no,
      DROP COLUMN IF EXISTS blanking_length,
      DROP COLUMN IF EXISTS operator_name,
      DROP COLUMN IF EXISTS operator_id,
      DROP COLUMN IF EXISTS equipment_code,
      DROP COLUMN IF EXISTS equipment_name,
      DROP COLUMN IF EXISTS thread_spec,
      DROP COLUMN IF EXISTS inspection_team,
      DROP COLUMN IF EXISTS process_step,
      DROP COLUMN IF EXISTS completed_at;
  `.execute(db);
}
