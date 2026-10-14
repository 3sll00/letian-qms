import { Kysely, sql } from 'kysely';

/**
 * 设备管理台账（系统管理 → 设备管理）。
 *
 * 客户需求（2026-10-14）：空白表起步，界面「新增设备」由后端自动生成 6 位顺序编码
 * （000001 起）作为主码；业务字段（名称/型号/出厂序列号/设备类型/所属车间/状态/
 * 采购日期/保修期）全部可空，不强制填写。
 *
 * - qms_equipments.equipment_code CHAR(6) 主键即业务主码（用户口径「主码」），
 *   由 qms_equipment_code_sequences 原子发号 —— 与检验单号/方案编码流水池
 *   （迁移 012/017）同构：INSERT ... ON CONFLICT DO UPDATE last_seq + 1 RETURNING，
 *   行锁保证并发下不重号；发号与插入同事务，回滚不留空洞。
 * - purchase_date 以 'YYYY-MM-DD' 文本存储：纯展示字段，与检验单 dispatch_date
 *   等展示型日期同口径，规避 pg DATE 列读出时的时区跨日问题；入口 zod 已约束格式。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS qms_equipments (
      equipment_code CHAR(6) PRIMARY KEY,
      name VARCHAR(255),
      model VARCHAR(255),
      factory_serial_no VARCHAR(255),
      equipment_type VARCHAR(100),
      workshop VARCHAR(100),
      status VARCHAR(20),
      purchase_date CHAR(10),
      warranty_period VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS qms_equipment_code_sequences (
      code_key VARCHAR(32) PRIMARY KEY,
      last_seq INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ
    );
  `.execute(db);
  await sql`
    COMMENT ON TABLE qms_equipments IS '设备管理台账：equipment_code CHAR(6) 主码由 qms_equipment_code_sequences 发号（000001 起），业务字段全部可空'
  `.execute(db);
  console.log('[049] 已创建设备管理台账 qms_equipments 与设备编码流水池 qms_equipment_code_sequences');
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS qms_equipments`.execute(db);
  await sql`DROP TABLE IF EXISTS qms_equipment_code_sequences`.execute(db);
  console.log('[049] 已删除 qms_equipments 与 qms_equipment_code_sequences');
}
