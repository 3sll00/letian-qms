import { Kysely, sql } from 'kysely';

/**
 * 迁移 041：QMS ↔ ERP 编码映射表 `qms_erp_code_mapping`
 *
 * 背景（ERP 回写项目，见 docs/ERP 回写）：QMS 把检验结果写回管家婆时，需要把
 *   - 物料  —— QMS `inspection_orders.material_code`  → ERP `Ptype.typeId`
 *   - 供应商 —— QMS `inspection_orders.supplier_code`  → ERP `Btype.typeId`
 *   - 检验员 —— QMS `inspection_orders.inspector_name` → ERP `Employee.typeId`
 *   （QMS 演示/种子单的编码是合成码（如 MAT-* 物料、SUP-001 供应商），与 ERP `UserCode` 对不上；
 *    而真从 ERP 同步来的单，material_code/supplier_code 本就等于 ERP `UserCode`。）
 *
 * 本表是「自动解析 + 手工兜底」两层映射的统一落点：
 *   - `source='auto'`：由回填脚本 `build-code-mapping.ts` 按 ERP `UserCode`/`Name` 自动解析写入；
 *   - `source='manual'`：合成码等无法自动解析时，由运维直接 INSERT 补（如 SUP-001→0019900001）。
 *
 * 解析优先级（回写脚本 `writeback-inspection.ts`）：本表命中 → 回退 erp-reads 实时反查 →
 * 最后才用 `--ptype/--btype/--etype` 覆盖。本表让回写在生产 ERP 不可达时也能靠已落映射继续。
 *
 * 幂等：`CREATE TABLE IF NOT EXISTS`；down 直接 DROP（映射属可重建的派生数据，无业务留痕）。
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS qms_erp_code_mapping (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_type VARCHAR(20) NOT NULL,   -- 'MATERIAL' | 'SUPPLIER' | 'EMPLOYEE'
      qms_code VARCHAR(120) NOT NULL,     -- material_code / supplier_code / inspector_name
      erp_type_id VARCHAR(50) NOT NULL,   -- ERP Ptype / Btype / Employee 的 typeId
      erp_user_code VARCHAR(120),         -- ERP UserCode（物料/供应商，备查）
      erp_full_name VARCHAR(255),         -- ERP FullName / Employee.Name（备查）
      source VARCHAR(20) NOT NULL DEFAULT 'manual',  -- 'auto' | 'manual'
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT qms_erp_code_mapping_uc UNIQUE (entity_type, qms_code)
    );
  `.execute(db);

  await sql`
    COMMENT ON TABLE qms_erp_code_mapping IS
      'QMS 编码 → ERP typeId 映射（物料/供应商/检验员）。auto=回填脚本自动解析，manual=运维手工补合成码';
  `.execute(db);

  console.log('[041] 已创建 qms_erp_code_mapping（QMS↔ERP 编码映射表）');
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS qms_erp_code_mapping`.execute(db);
  console.log('[041] 已删除 qms_erp_code_mapping');
}
