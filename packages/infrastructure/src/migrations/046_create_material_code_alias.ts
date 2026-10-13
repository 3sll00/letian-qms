import { Kysely, sql } from 'kysely';

/**
 * 迁移 046：物料编码别名表 `qms_material_code_alias`
 *
 * 背景（ERP 来料检验全量同步遗留的 8 条失败）：
 * ERP `Ptype` 里存在「已废弃的重复编码」——例如 `GB5783-24*120-8.8-`（多一个尾横杠，`deleted=1`）
 * 与现行有效编码 `GB5783-24*120-8.8`（`deleted=0`）指向同一个物料（六角头螺栓 / M24*120-8.8）。
 * QMS 主数据同步口径是 `deleted = 0 AND sonnum = 0`，废弃编码不会被同步进 `materials`（这是正确的），
 * 但 2023~2024 的历史来料检验单当年用的正是废弃旧编码，导致建单时查不到物料而失败。
 *
 * 解决：本表登记「废弃/历史编码 → 现行有效编码」的别名映射，由主数据仓储在按编码查不到时回退命中
 * （见 master-data-repository.ts 的 getMaterialByCode），从而
 *   - 历史报检数据能落到正确的现行物料上，不丢；
 *   - 主数据 `materials` 里仍然只有有效编码，不被废弃码污染。
 *
 * 幂等：CREATE TABLE IF NOT EXISTS；down 直接 DROP（别名属可重建的派生映射，无业务留痕）。
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS qms_material_code_alias (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      legacy_code VARCHAR(255) NOT NULL,   -- 废弃/历史编码（ERP Ptype deleted=1 或已停用）
      active_code VARCHAR(255) NOT NULL,   -- 现行有效编码（materials.material_code）
      note TEXT,                           -- 备注（为何映射）
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT qms_material_code_alias_uc UNIQUE (legacy_code)
    );
  `.execute(db);

  await sql`CREATE INDEX IF NOT EXISTS idx_qms_material_code_alias_active ON qms_material_code_alias (active_code)`.execute(db);

  await sql`
    COMMENT ON TABLE qms_material_code_alias IS
      '物料编码别名：废弃/历史编码 → 现行有效编码（ERP Ptype 重复废弃码映射，供历史单据归档用）';
  `.execute(db);

  console.log('[046] 已创建 qms_material_code_alias（物料编码别名表）');
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS qms_material_code_alias`.execute(db);
  console.log('[046] 已删除 qms_material_code_alias');
}
