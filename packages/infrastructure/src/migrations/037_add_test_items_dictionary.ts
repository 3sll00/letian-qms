import { Kysely, sql } from 'kysely';

/**
 * 迁移 037：检验项目字典表 `test_items`（ERP `TestItem` 的 QMS 镜像）
 *
 * 背景：质检方案内容对齐 ERP 方案表口径（`T_Inf_PtypeCheckingSchemeNdx/Dly`）——
 * 方案明细行的「检验项目」不再用自由文本/内部枚举，而是参照 ERP 检验项目字典
 * （`T_Inf_PtypeCheckingSchemeDly.TITypeId -> TestItem.TypeID`）。
 *
 * 列口径（与 ERP TestItem 对齐）：
 *   test_item_code  <- TypeID     （如 '00001'，全局唯一，方案指标行 testItemCode 回链键）
 *   name            <- FullName   （如 '外观'）
 *   name_py         <- NamePY
 *   test_standard   <- TestStandard
 *   applies_to_*    <- bBuy / bProduce / bConsign（该项目在哪个质检阶段可选：
 *                      来料 IQC / 过程 IPQC*·FQC / 委外·出货 OQC*）
 *
 * 种子数据来源：**2026-09-28 实测乐天管家婆测试账套（CMCSYUN442316）TestItem 叶子行**，
 * 使离线/演示环境也能拿到与 ERP 一致的字典；后续 `erp:sync:test-items` 以 ERP 为准覆盖更新。
 *
 * 安全边界：纯新增独立表与索引；既有行用 ON CONFLICT DO NOTHING，不覆盖已被同步刷新的字段。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS test_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      test_item_code VARCHAR(16) NOT NULL UNIQUE,
      name VARCHAR(64) NOT NULL,
      name_py VARCHAR(66),
      test_standard VARCHAR(255),
      applies_to_buy BOOLEAN NOT NULL DEFAULT TRUE,
      applies_to_produce BOOLEAN NOT NULL DEFAULT TRUE,
      applies_to_consign BOOLEAN NOT NULL DEFAULT TRUE,
      sort_no INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `.execute(db);

  await sql`
    INSERT INTO test_items (test_item_code, name, name_py, applies_to_buy, applies_to_produce, applies_to_consign, sort_no)
    VALUES
      ('00001', '外观',             'WG',       TRUE, TRUE, TRUE, 1),
      ('00002', '尺寸',             'CC',       TRUE, TRUE, TRUE, 2),
      ('00003', '通止',             'TZ',       TRUE, TRUE, TRUE, 3),
      ('00004', '硬度实测值（5个）', 'YDSCZ5G',  TRUE, TRUE, TRUE, 4),
      ('00005', '拉伸检测（单号）', 'LSJCDH',   TRUE, TRUE, TRUE, 5),
      ('00006', '光谱试验（单号）', 'GPSYDH',   TRUE, TRUE, TRUE, 6),
      ('00007', '挑选工时',         'TXGS',     TRUE, TRUE, TRUE, 7),
      ('00008', '冲击试验（单号）', 'CJSYDH',   TRUE, TRUE, TRUE, 8),
      ('00009', '不良品描述',       'BLPMS',    TRUE, TRUE, TRUE, 9)
    ON CONFLICT (test_item_code) DO NOTHING;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS test_items;`.execute(db);
}
