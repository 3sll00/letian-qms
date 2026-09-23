import { Kysely, sql } from 'kysely';

/**
 * 迁移 032：委外检验（机加工检验 / 热处理检验）族级通用质检方案补齐
 *
 * 背景（详见 docs/36-委外检验数据字段与数据库接口对接核查设计.md §9）：
 *   市面 QMS（SAP QM 检验计划选择 / Odoo 质量控制点 / ERPNext 检验模板）一致采用
 *   「物料级 -> 物料组/分类级」两级检验计划选择：族内通用特性由**分类通用方案**承载，
 *   件专有特性由**物料专属方案**承载并优先命中（本项目两级匹配实现见 docs/17 §7.3）。
 *
 *   委外检验三个页签的**读取**链路（GET /api/v1/inspections?inspectionType=...）早已打通，
 *   但**写入**链路（POST /api/v1/inspections，不带 planVersionId 由后端自动选方案）此前只有
 *   表面处理 OQC_SF 可用：库中 ACTIVE 的委外方案只有 QP-OQC-SF（绑定 MAT-BLT-109-M10），
 *   机加工 OQC_MACH 与热处理 OQC_HEAT 一份方案都没有 —— 建单直接 400
 *   `inspection-plan-not-found`，两个页签「能看不能录」。
 *
 * 本次动作：新增三份**分类通用**（material_code = ''）委外检验方案，三份均为 ACTIVE：
 *   - QP-OQC-MACH-FAMILY     / OQC_MACH / CAT-FIN-MACH
 *   - QP-OQC-HEAT-FAMILY-BOLT/ OQC_HEAT / CAT-FIN-BOLT
 *   - QP-OQC-HEAT-FAMILY-NUT / OQC_HEAT / CAT-FIN-NUT
 *
 * 指标归属规则（沿用 docs/37 已确立口径：按「判标是否依赖具体规格」二分）：
 *   不依赖 -> 族级承载；依赖（硬度 / 力学性能 / 尺寸 / 螺纹 / 粗糙度）-> 物料级承载。
 *   故族级只承载**工艺级通用要求**（外观、表面防护、过程记录可追溯性），
 *   本次不引入任何新的判标数值，不把一个件的公差推广到全族（QMS 判标红线）。
 *   热处理属特殊过程（IATF 16949 §8.5.1.1 / CQI-9），族级额外承载
 *   「炉号 / 装炉记录 / 工艺曲线随单归档并可追溯」的过程记录要求。
 *
 * 与种子的双路径：`pnpm db:seed` 会 TRUNCATE 全部业务表后重播，
 *   同一批方案在 packages/infrastructure/src/seeds/data.ts（seedPlans）中**同码同 UUID**存在，
 *   保证「迁移库」与「播种库」两条初始化路径落库结果一致（030 / 031 同例）。
 *
 * 安全边界：**纯新增三行**；不修改 / 不删除任何既有方案与工单；不改物理列（无 ALTER TABLE）。
 */

/** 机加工委外族级指标：外观与棱边质量（必检）、表面防护与包装（选检） */
const machItems = JSON.stringify([
  {
    seq: 1,
    itemCode: 'VIS-001',
    name: '外观与棱边质量',
    dataType: 'QUALITATIVE',
    metricCategory: 'APPEARANCE',
    standardText: '无毛刺、无磕碰划伤、无锈蚀，棱边倒角完整',
    acceptableValues: ['合格'],
    sampleSize: 20,
    unit: '',
    measurementTool: '目视 / 手感',
    isMandatory: true,
  },
  {
    seq: 2,
    itemCode: 'PRT-001',
    name: '表面防护与包装',
    dataType: 'QUALITATIVE',
    metricCategory: 'APPEARANCE',
    standardText: '加工面防锈处理有效、无锈蚀；随件防护包装完好',
    acceptableValues: ['合格'],
    sampleSize: 5,
    unit: '',
    measurementTool: '目视',
    isMandatory: false,
  },
]);

/**
 * 热处理委外族级指标：过程记录可追溯性 + 热处理外观。
 * 螺栓族（CAT-FIN-BOLT）与螺母 / 垫圈族（CAT-FIN-NUT）工艺级要求同款，
 * 但两级匹配按 category_code 兜底（一个分类一行，UNIQUE(plan_code, version)），故各存一份。
 */
const heatItems = JSON.stringify([
  {
    seq: 1,
    itemCode: 'TRC-001',
    name: '热处理过程记录可追溯性',
    dataType: 'QUALITATIVE',
    metricCategory: 'APPEARANCE',
    standardText: '炉号 / 装炉记录 / 工艺曲线随单归档并可追溯（CQI-9 特殊过程确认）',
    acceptableValues: ['合格'],
    sampleSize: 1,
    unit: '',
    measurementTool: '记录核查',
    isMandatory: true,
  },
  {
    seq: 2,
    itemCode: 'VIS-002',
    name: '热处理外观',
    dataType: 'QUALITATIVE',
    metricCategory: 'APPEARANCE',
    standardText: '无氧化皮、无裂纹、无过烧、无碰伤',
    acceptableValues: ['合格'],
    sampleSize: 20,
    unit: '',
    measurementTool: '目视',
    isMandatory: true,
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
        '26000000-0000-4000-8000-000000000201',
        'QP-OQC-MACH-FAMILY',
        '机加工件委外回厂通用验收规范',
        '',
        'CAT-FIN-MACH',
        'v1.0',
        'ACTIVE',
        'OQC_MACH',
        ${machItems}::jsonb,
        ${samplingConfig}::jsonb,
        '11000000-0000-4000-8000-000000000002',
        1,
        now(),
        now()
      ),
      (
        '26000000-0000-4000-8000-000000000202',
        'QP-OQC-HEAT-FAMILY-BOLT',
        '紧固件（螺栓）热处理委外回厂通用验收规范',
        '',
        'CAT-FIN-BOLT',
        'v1.0',
        'ACTIVE',
        'OQC_HEAT',
        ${heatItems}::jsonb,
        ${samplingConfig}::jsonb,
        '11000000-0000-4000-8000-000000000006',
        1,
        now(),
        now()
      ),
      (
        '26000000-0000-4000-8000-000000000203',
        'QP-OQC-HEAT-FAMILY-NUT',
        '紧固件（螺母 / 垫圈）热处理委外回厂通用验收规范',
        '',
        'CAT-FIN-NUT',
        'v1.0',
        'ACTIVE',
        'OQC_HEAT',
        ${heatItems}::jsonb,
        ${samplingConfig}::jsonb,
        '11000000-0000-4000-8000-000000000006',
        1,
        now(),
        now()
      )
    ON CONFLICT (plan_code, version) DO NOTHING;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // 只删本迁移新增的三份方案（不动任何既有方案行）
  await sql`
    DELETE FROM inspection_plans
    WHERE plan_code IN (
      'QP-OQC-MACH-FAMILY',
      'QP-OQC-HEAT-FAMILY-BOLT',
      'QP-OQC-HEAT-FAMILY-NUT'
    );
  `.execute(db);
}
