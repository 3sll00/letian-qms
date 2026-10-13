require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('pg');

// 出货检验（OQC_SH）全局通用方案（material_code='' & category_code=''），
// 作为 findActivePlan 第三级兜底：让 ERP 同步来的任意物料（尤其是不在 QMS 主数据 /
// 不属于 CAT-FIN-BOLT 成品螺栓族的）都能落到有效方案，不会建单失败。
// 形态：工艺级定性项（外观 + 标识合格证 + 包装防护），testItemCode 复用 ERP 字典 '00001'(外观)。
const GENERIC = {
  planCode: 'QP-OQC-SH-GENERIC',
  planName: '出货检验与客户放行通用验收规范（全局兜底）',
  stage: 'OQC_SH',
  items: [
    { seq: 1, itemCode: 'VIS-001', name: '外观质量', dataType: 'QUALITATIVE', metricCategory: 'APPEARANCE',
      standardText: '表面无锈蚀、无磕碰划伤、无变形、无污渍；涂层/镀层/氧化皮完整均匀', acceptableValues: ['合格'],
      sampleSize: 20, unit: '', measurementTool: '目视', isMandatory: true, testItemCode: '00001' },
    { seq: 2, itemCode: 'LBL-001', name: '产品标识与合格证', dataType: 'QUALITATIVE', metricCategory: 'APPEARANCE',
      standardText: '铭牌/标识清晰可辨，随件合格证/材质证明齐全有效', acceptableValues: ['合格'],
      sampleSize: 20, unit: '', measurementTool: '目视 / 核对单证', isMandatory: true, testItemCode: '00001' },
    { seq: 3, itemCode: 'PKG-001', name: '包装与防护', dataType: 'QUALITATIVE', metricCategory: 'APPEARANCE',
      standardText: '防锈/防护包装有效完好，装箱数量与发货单一致，无混装错装', acceptableValues: ['合格'],
      sampleSize: 5, unit: '', measurementTool: '目视', isMandatory: false, testItemCode: '00001' },
  ],
};

const SAMPLING = { samplingScheme: 'GB_T_2828', aqlLevel: 'II', strictness: 'NORMAL' };
const CREATED_BY = '11000000-0000-4000-8000-000000000002'; // 与现存家族方案一致的创建人，避免外键约束问题

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const c = await pool.connect();
  try {
    const res = await c.query(
      `INSERT INTO inspection_plans
        (plan_code, plan_name, material_code, category_code, version, version_status,
         inspection_stage, inspection_types, items, sampling_config, created_by, updated_at)
       VALUES ($1,$2,'','', 'v1.0','ACTIVE', $3, $4, $5, $6, $7, now())
       ON CONFLICT (plan_code, version) DO NOTHING
       RETURNING plan_code`,
      [GENERIC.planCode, GENERIC.planName, GENERIC.stage, JSON.stringify([GENERIC.stage]),
       JSON.stringify(GENERIC.items), JSON.stringify(SAMPLING), CREATED_BY]
    );
    if (res.rowCount > 0) console.log('插入全局 OQC_SH 兜底方案:', GENERIC.planCode);
    else console.log('已存在跳过:', GENERIC.planCode);
  } catch (e) {
    console.error('INSERT FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
})();
