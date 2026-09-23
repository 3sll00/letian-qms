import { Kysely, sql } from 'kysely';

/**
 * 迁移 033：委外表处理检验（OQC_SF）族级通用质检方案补齐
 *
 * 背景（详见 docs/36-委外检验数据字段与数据库接口对接核查设计.md §9）：
 *   委外三个页签（表面处理 / 机加工 / 热处理）的**读取**链路早已打通，
 *   **写入**链路（POST /api/v1/inspections 不带 planVersionId 时由服务端两级匹配选方案）
 *   此前只有 `QP-OQC-SF` 一份 ACTIVE 方案且绑定单个料号 `MAT-BLT-109-M10`：
 *   台账里真实的委外表处理单还落在 `MAT-BLT-88-M12`（镀镍，CAT-FIN-BOLT）与
 *   `MAT-NUT-10-M10`（发黑，CAT-FIN-NUT）上，这两类物料在录入页建单直接 400
 *   `inspection-plan-not-found` —— 与迁移 032 处理的机加工 / 热处理是同一类缺口。
 *
 * 本次动作：为**成品紧固件**两个分类各新增一份分类通用（material_code = ''）表面处理方案：
 *   - QP-OQC-SF-FAMILY-BOLT / OQC_SF / CAT-FIN-BOLT
 *   - QP-OQC-SF-FAMILY-NUT  / OQC_SF / CAT-FIN-NUT
 *
 * 指标归属规则（沿用 docs/37 已确立口径：按「判标是否依赖具体规格」二分）：
 *   不依赖 -> 族级承载；依赖（镀层厚度 μm、色差 ΔE、盐雾小时数、扭矩系数、回厂硬度）
 *   -> 物料级承载。故族级只承载**工艺级通用要求**：镀覆层外观、镀覆层附着力、表面防护与包装；
 *   本次不引入任何新的判标数值（定性指标以 `acceptableValues` 清单判标，TBD-06）。
 *   `QP-OQC-SF` v2.0 的 4 条数值指标（镀层厚度 / 回厂硬度 / 镀层色差 / 扭矩系数）**不动、不复制**。
 *
 * 安全边界：**纯新增两行**；不修改 / 不删除任何既有方案与工单；不改物理列（无 ALTER TABLE）。
 */

/** 成品紧固件族表面处理族级指标：外观、附着力（必检）+ 表面防护与包装（选检） */
const familyItems = JSON.stringify([
  {
    seq: 1,
    itemCode: 'VIS-003',
    name: '镀覆层外观',
    dataType: 'QUALITATIVE',
    metricCategory: 'APPEARANCE',
    standardText: '镀覆层均匀完整，无漏镀、无起泡、无剥落、无烧焦、无锈蚀',
    acceptableValues: ['合格'],
    sampleSize: 20,
    unit: '',
    measurementTool: '目视',
    isMandatory: true,
  },
  {
    seq: 2,
    itemCode: 'ADH-001',
    name: '镀覆层附着力',
    dataType: 'QUALITATIVE',
    metricCategory: 'APPEARANCE',
    standardText: '划格 / 弯曲试验后镀覆层无剥落、无起皮（GB/T 5270）',
    acceptableValues: ['合格'],
    sampleSize: 3,
    unit: '',
    measurementTool: '划格器 / 弯曲试验',
    isMandatory: true,
  },
  {
    seq: 3,
    itemCode: 'PRT-002',
    name: '表面防护与包装',
    dataType: 'QUALITATIVE',
    metricCategory: 'APPEARANCE',
    standardText: '经防潮、防碰伤包装，随件标识完整、运输后无锈蚀',
    acceptableValues: ['合格'],
    sampleSize: 5,
    unit: '',
    measurementTool: '目视',
    isMandatory: false,
  },
]);

/** 抽样配置：与既有委外 / 出货方案同值（版本级属性，与 AQL / 严格度同属 sampling_config） */
const samplingConfig = JSON.stringify({
  samplingScheme: 'GB_T_2828',
  aqlLevel: 'II',
  strictness: 'NORMAL',
});

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    INSERT INTO inspection_plans (
      id, plan_code, plan_name, material_code, category_code,
      version, version_status, inspection_stage,
      items, sampling_config, created_by, confidentiality_level, created_at, updated_at
    )
    VALUES
      (
        '26000000-0000-4000-8000-000000000301',
        'QP-OQC-SF-FAMILY-BOLT',
        '成品螺栓族表面处理委外回厂通用验收规范',
        '',
        'CAT-FIN-BOLT',
        'v1.0',
        'ACTIVE',
        'OQC_SF',
        ${familyItems}::jsonb,
        ${samplingConfig}::jsonb,
        '11000000-0000-4000-8000-000000000007',
        1,
        now(),
        now()
      ),
      (
        '26000000-0000-4000-8000-000000000302',
        'QP-OQC-SF-FAMILY-NUT',
        '成品螺母 / 垫圈族表面处理委外回厂通用验收规范',
        '',
        'CAT-FIN-NUT',
        'v1.0',
        'ACTIVE',
        'OQC_SF',
        ${familyItems}::jsonb,
        ${samplingConfig}::jsonb,
        '11000000-0000-4000-8000-000000000007',
        1,
        now(),
        now()
      )
    ON CONFLICT (plan_code, version) DO NOTHING;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // 只删本迁移新增的两份方案（不动任何既有方案行）
  await sql`
    DELETE FROM inspection_plans
    WHERE plan_code IN ('QP-OQC-SF-FAMILY-BOLT', 'QP-OQC-SF-FAMILY-NUT');
  `.execute(db);
}
