import { Kysely, sql } from 'kysely';

/**
 * 迁移 031：出货检验族级（分类通用）质检方案补齐
 *
 * 背景（详见 docs/37-出货检验族级分类通用方案补齐设计（市面QMS口径）.md）：
 *   市面 QMS（SAP QM 检验计划选择 / Odoo 质量控制点 / ERPNext 检验模板）一致采用
 *   「物料级 -> 物料组/分类级」两级检验计划选择：族内通用特性由**分类通用方案**承载，
 *   件专有特性由**物料专属方案**承载并优先命中。
 *
 *   本项目 docs/17 §7.3 的两级匹配代码已按此口径实现，但库中 `material_code = ''`
 *   的分类通用方案一份都没有，族级兜底这一层在真实数据上**空转**：
 *   OQC_SH 仅 QP-OQC-SH 一份且绑定 MAT-BLT-109-M10，导致出货检验台账 4 条原型成品中
 *   MAT-BLT-88-M10 / MAT-BLT-88-M12-40 / MAT-BLT-FLG-M8 匹配不到任何方案
 *   （GET /plans/match 404 inspection-plan-not-found；不带 planVersionId 建单 400 同错误码）。
 *
 * 本次动作：为成品螺栓族 CAT-FIN-BOLT 新增一份分类通用出货检验方案
 *   `QP-OQC-SH-FAMILY`（material_code = ''，category_code = 'CAT-FIN-BOLT'，ACTIVE）。
 *
 * 指标归属规则（本次唯一新增口径）：按「判标是否依赖具体规格」二分 ——
 *   不依赖 -> 族级承载；依赖（尺寸 / 装箱重量）-> 物料级承载。
 *   故族级只取 QP-OQC-SH v1.2 中的 THR-003（通规通过率）与 MAR-001（标识印记高度），
 *   两项**逐值照抄**（仅重排 seq），本次不引入任何新的判标数值；
 *   PKG-001（包装重量，随装箱规格变）与 LEN-003（总长 45.0±0.2mm，M10×45 专有）留在
 *   物料专属方案 QP-OQC-SH —— 把一个件的公差推广到全族属 QMS 判标红线，必须避免。
 *
 * 安全边界：**纯新增一行**；不修改 / 不删除任何既有方案与工单；不改物理列（无 ALTER TABLE）。
 */
export async function up(db: Kysely<any>): Promise<void> {
  // 族级指标：逐值照抄 QP-OQC-SH v1.2 的 THR-003 / MAR-001（仅 seq 重排）
  const familyItems = JSON.stringify([
    {
      seq: 1,
      itemCode: 'THR-003',
      name: '通规通过率',
      dataType: 'NUMERIC',
      metricCategory: 'DIMENSION',
      standardText: '100%',
      nominalValue: 100,
      upperTolerance: 1,
      lowerTolerance: 0,
      sampleSize: 200,
      unit: '%',
      measurementTool: '螺纹通止规',
      isMandatory: true,
    },
    {
      seq: 2,
      itemCode: 'MAR-001',
      name: '标识印记高度',
      dataType: 'NUMERIC',
      metricCategory: 'APPEARANCE',
      standardText: '0.5±0.1mm',
      nominalValue: 0.5,
      upperTolerance: 0.1,
      lowerTolerance: 0.1,
      sampleSize: 20,
      unit: 'mm',
      measurementTool: '影像测量仪',
      isMandatory: false,
    },
  ]);

  // 抽样配置与既有出货检验方案同值（版本级属性，与 AQL / 严格度同属 sampling_config）
  const samplingConfig = JSON.stringify({
    samplingScheme: 'GB_T_2828',
    aqlLevel: 'II',
    strictness: 'NORMAL',
  });

  await sql`
    INSERT INTO inspection_plans (
      id, plan_code, plan_name, material_code, category_code,
      version, version_status, inspection_stage,
      items, sampling_config, created_by, confidentiality_level, created_at, updated_at
    )
    VALUES (
      '27000000-0000-4000-8000-000000000002',
      'QP-OQC-SH-FAMILY',
      '成品螺栓族出货检验与客户放行通用规范',
      '',
      'CAT-FIN-BOLT',
      'v1.0',
      'ACTIVE',
      'OQC_SH',
      ${familyItems}::jsonb,
      ${samplingConfig}::jsonb,
      '11000000-0000-4000-8000-000000000003',
      1,
      now(),
      now()
    )
    ON CONFLICT (plan_code, version) DO NOTHING;
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // 只删本迁移新增的那一份方案（不动任何既有方案行）
  await sql`DELETE FROM inspection_plans WHERE plan_code = 'QP-OQC-SH-FAMILY';`.execute(db);
}