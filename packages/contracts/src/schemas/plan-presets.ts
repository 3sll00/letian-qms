import { z } from 'zod';
import { MetricCategoryEnum } from './inspection';

/** QMS 判定域（与 dtos 的 MetricCategory 同构：此处按枚举推导，避免与 dtos 导出同名冲突） */
export type PlanMetricCategory = z.infer<typeof MetricCategoryEnum>;

/**
 * 预置检验项目清单（质检方案指标项的「唯一定义源」）。
 *
 * 为什么放在契约包：
 *   【新建质检方案】弹窗（勾选清单）与【导入方案】Excel 模板（填写清单）必须逐字同源 ——
 *   两处各写一份必然漂移，漂移的后果是「模板能导入出一个弹窗里根本建不出来的方案」。
 *   因此清单、编码查找、标准值解析口径统一定义在此，前端 UI 与后端导入解析器共用。
 *
 * 口径要点：
 *   1. 三大检验类别（外观 / 尺寸 / 性能）各带一组预置项目，类别决定清单归属，
 *      与 metricCategory（QMS 判定域）是两个维度 —— 例如「钢印/标签/包装」归尺寸检验类别，
 *      但判定域是 APPEARANCE；
 *   2. testItemCode 只在能与 ERP 检验项目字典语义对上时回链（外观 00001 / 尺寸 00002 /
 *      通止 00003 / 硬度 00004 / 拉伸 00005），对不上就不带（契约 optional），
 *      避免脏编码污染 ERP 同步；
 *   3. 标准值口径决定判定方式：数值口径（36±0.5 / 36+0.2/-0.1 / 36）解析为
 *      公称值 + 上下公差 → dataType NUMERIC，录入时按公差带自动判定；
 *      文字要求（「按产品标准」「通止规通过」等）解析不出边界 → 保持 TEXT / QUALITATIVE、
 *      原文落 remark、standardText 留空，录入时挂 PENDING 由检验员人工确认。
 *      （判定器会把 standardText 按 , ， / | 拆成可接受值逐字比对，把说明语写进
 *       standardText 会导致录入永远判不合格 —— 这条是硬口径，两侧都不许破。）
 */

/** 预置项的判定数据类型：数值口径在解析标准值时升级为 NUMERIC，故清单侧只有这两种 */
export type PlanPresetDataType = 'QUALITATIVE' | 'TEXT';

/** 预置检验项目 */
export interface PlanPresetItem {
  /** 弹窗内唯一指标编码（落库 itemCode = `ITEM-${code}`） */
  code: string;
  /** 项目名称（清单显示名 / 落库 name） */
  name: string;
  /** 默认要求：标准值输入框的默认值，可改 */
  hint: string;
  /** QMS 判定域（决定录入表单里该指标落在哪个分区） */
  metricCategory: PlanMetricCategory;
  /** 清单默认判定类型（数值口径解析成功后升级为 NUMERIC） */
  dataType: PlanPresetDataType;
  /** ERP 检验项目字典回链（TestItem.TypeID）；仅语义能对上时携带 */
  testItemCode?: string;
}

/** 检验类别 key：与「选择检验类型」三张卡片一一对应 */
export type PlanCategoryKey = 'APPEARANCE' | 'DIMENSION' | 'PERFORMANCE';

/** 检验类别（卡片）：items 为该类别下的预置项目清单 */
export interface PlanCheckCategory {
  key: PlanCategoryKey;
  name: string;
  items: PlanPresetItem[];
}

/** 外观检验预置项目（定性判读，回链字典 00001 外观） */
export const APPEARANCE_PRESETS: readonly PlanPresetItem[] = [
  { code: 'AP-01', name: '表面毛疵', hint: '清理干净，美观光滑平整无毛刺', metricCategory: 'APPEARANCE', dataType: 'QUALITATIVE', testItemCode: '00001' },
  { code: 'AP-02', name: '表面缺陷', hint: '不得有裂纹、磕碰、涂层脱落及弯曲', metricCategory: 'APPEARANCE', dataType: 'QUALITATIVE', testItemCode: '00001' },
  { code: 'AP-03', name: '螺纹完整性', hint: '螺纹完整，没有缺牙、残渣等', metricCategory: 'APPEARANCE', dataType: 'QUALITATIVE', testItemCode: '00001' },
  { code: 'AP-04', name: '表面防护', hint: '是否镀锌，有涂层或其他包装', metricCategory: 'APPEARANCE', dataType: 'QUALITATIVE', testItemCode: '00001' },
  { code: 'AP-05', name: '外观标准符合性', hint: '对应产品标准的外观要求', metricCategory: 'APPEARANCE', dataType: 'QUALITATIVE', testItemCode: '00001' },
];

/** 尺寸检验预置项目：几何尺寸按产品标准（无具体基准不捏造），通止实配回链 00003 */
export const DIMENSION_PRESETS: readonly PlanPresetItem[] = [
  { code: 'DM-01', name: '对边 s', hint: '按产品标准', metricCategory: 'DIMENSION', dataType: 'TEXT', testItemCode: '00002' },
  { code: 'DM-02', name: '对角 e', hint: '按产品标准', metricCategory: 'DIMENSION', dataType: 'TEXT', testItemCode: '00002' },
  { code: 'DM-03', name: '厚度 k/m', hint: '按产品标准', metricCategory: 'DIMENSION', dataType: 'TEXT', testItemCode: '00002' },
  { code: 'DM-04', name: '螺纹大径 d', hint: '按产品标准', metricCategory: 'DIMENSION', dataType: 'TEXT', testItemCode: '00002' },
  { code: 'DM-05', name: '螺杆直径 ds', hint: '按产品标准', metricCategory: 'DIMENSION', dataType: 'TEXT', testItemCode: '00002' },
  { code: 'DM-06', name: '长度 L', hint: '按产品标准', metricCategory: 'DIMENSION', dataType: 'TEXT', testItemCode: '00002' },
  { code: 'DM-07', name: '螺纹长度 b', hint: '按产品标准', metricCategory: 'DIMENSION', dataType: 'TEXT', testItemCode: '00002' },
  { code: 'DM-08', name: '牙距 P', hint: '按产品标准', metricCategory: 'DIMENSION', dataType: 'TEXT', testItemCode: '00002' },
  { code: 'DM-09', name: '螺纹实配', hint: '通止规通过', metricCategory: 'DIMENSION', dataType: 'QUALITATIVE', testItemCode: '00003' },
  { code: 'DM-10', name: '锌层', hint: '按产品标准', metricCategory: 'COATING_THICKNESS', dataType: 'TEXT' },
  { code: 'DM-11', name: '钢印', hint: '清晰完整', metricCategory: 'APPEARANCE', dataType: 'QUALITATIVE' },
  { code: 'DM-12', name: '标签', hint: '内容正确、粘贴牢固', metricCategory: 'APPEARANCE', dataType: 'QUALITATIVE' },
  { code: 'DM-13', name: '包装', hint: '包装完好，防护措施到位', metricCategory: 'APPEARANCE', dataType: 'QUALITATIVE' },
];

/** 性能检验预置项目：力学/防腐按产品标准，硬度/拉伸回链字典 00004 / 00005 */
export const PERFORMANCE_PRESETS: readonly PlanPresetItem[] = [
  { code: 'PF-01', name: '硬度 (HRC/HV)', hint: '按产品标准', metricCategory: 'HARDNESS', dataType: 'TEXT', testItemCode: '00004' },
  { code: 'PF-02', name: '抗拉强度 (MPa)', hint: '按产品标准', metricCategory: 'TENSILE_STRENGTH', dataType: 'TEXT', testItemCode: '00005' },
  { code: 'PF-03', name: '保证载荷/楔负载', hint: '按产品标准', metricCategory: 'MECHANICAL_PERFORMANCE', dataType: 'TEXT' },
  { code: 'PF-04', name: '扭矩试验', hint: '按产品标准', metricCategory: 'MECHANICAL_PERFORMANCE', dataType: 'TEXT' },
  { code: 'PF-05', name: '表面处理检验', hint: '符合防腐要求', metricCategory: 'COATING_THICKNESS', dataType: 'QUALITATIVE' },
  { code: 'PF-06', name: '形位公差', hint: '按产品标准', metricCategory: 'DIMENSION', dataType: 'TEXT' },
  // 化学成分（光谱）：多元素限值是文本区间，判定器按文本处理 → 录入挂 PENDING 人工确认；
  // metricCategory 落 CHEMICAL_COMPOSITION —— 检验录入表单据此把该指标归入化学成分分区。
  {
    code: 'PF-07',
    name: '化学成分（光谱）',
    hint: '按产品标准（如 C≤0.08 Si≤1 Mn≤2 P≤0.045 S≤0.03）',
    metricCategory: 'CHEMICAL_COMPOSITION',
    dataType: 'TEXT',
    testItemCode: '00006',
  },
];

/** 三大检验类别（顺序即弹窗卡片顺序、也是导入方案里指标项的展开顺序） */
export const PLAN_CHECK_CATEGORIES: readonly PlanCheckCategory[] = [
  { key: 'APPEARANCE', name: '外观检验', items: [...APPEARANCE_PRESETS] },
  { key: 'DIMENSION', name: '尺寸检验', items: [...DIMENSION_PRESETS] },
  { key: 'PERFORMANCE', name: '性能检验', items: [...PERFORMANCE_PRESETS] },
];

/** 弹窗打开时默认启用的类别（外观 + 尺寸；性能按需启用） */
export const DEFAULT_ENABLED_PLAN_CATEGORIES: readonly PlanCategoryKey[] = ['APPEARANCE', 'DIMENSION'];

/** 全部预置项目（按 类别 → 清单 顺序展开） */
export const ALL_PLAN_PRESETS: readonly PlanPresetItem[] = PLAN_CHECK_CATEGORIES.flatMap(
  (category) => category.items
);

/** 编码归一：去分隔符与空白并大写（'item ap-01' / 'AP_01' / 'AP-01' 视为同一项） */
function normalizePresetCode(text: string): string {
  return text.replace(/[\s_\-—–]/g, '').toUpperCase();
}

/** 名称归一：去空白后按大小写无关比较（中文名不受大小写影响） */
function normalizePresetName(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase();
}

/** 预置项落库的 itemCode */
export function planPresetItemCode(code: string): string {
  return `ITEM-${code}`;
}

/** 预置编码 → 所属类别 key；不属于任何类别返回 undefined */
export function planPresetCategoryKeyOf(code: string): PlanCategoryKey | undefined {
  return PLAN_CHECK_CATEGORIES.find((category) =>
    category.items.some((item) => item.code === code)
  )?.key;
}

/**
 * 按「编码或名称」查找预置项目。
 * 接受：AP-01 / ITEM-AP-01 / ap01 / 牙距 P（名称精确匹配，忽略空白与大小写）。
 */
export function findPlanPreset(
  input: string
): { category: PlanCheckCategory; item: PlanPresetItem } | undefined {
  const raw = input.trim();
  if (raw === '') return undefined;

  const token = normalizePresetCode(raw);
  const stripped = token.startsWith('ITEM') ? token.slice(4) : token;
  for (const category of PLAN_CHECK_CATEGORIES) {
    const byCode = category.items.find((item) => normalizePresetCode(item.code) === stripped);
    if (byCode !== undefined) return { category, item: byCode };
  }

  const nameToken = normalizePresetName(raw);
  for (const category of PLAN_CHECK_CATEGORIES) {
    const byName = category.items.find((item) => normalizePresetName(item.name) === nameToken);
    if (byName !== undefined) return { category, item: byName };
  }
  return undefined;
}

/** 数值标准值解析结果：公称值 + 上下公差（判定器按 [nominal-lower, nominal+upper] 自动判定） */
export interface ParsedPlanStandardValue {
  nominal: number;
  upper: number;
  lower: number;
  /** ERP Dif 口径的公差原文（如 '±0.5'）；纯数值无公差时省略 */
  dif?: string;
}

/**
 * 数值标准值解析：把「36±0.5」「36+0.2/-0.1」「36」解析为 公称值 + 上下公差。
 * 解析成功 → 指标落 NUMERIC 自动判定；失败（文字要求）→ 原文落 remark 人工确认。
 */
export function parsePlanStandardValue(text: string): ParsedPlanStandardValue | null {
  const value = text.trim();
  if (value === '') return null;
  let match = /^(\d+(?:\.\d+)?)\s*±\s*(\d+(?:\.\d+)?)$/.exec(value);
  if (match) {
    const tolerance = match[2]!;
    return { nominal: Number(match[1]), upper: Number(tolerance), lower: Number(tolerance), dif: `±${tolerance}` };
  }
  match = /^(\d+(?:\.\d+)?)\s*\+\s*(\d+(?:\.\d+)?)\s*\/?\s*-\s*(\d+(?:\.\d+)?)$/.exec(value);
  if (match) {
    return {
      nominal: Number(match[1]),
      upper: Number(match[2]),
      lower: Number(match[3]),
      dif: `+${match[2]}/-${match[3]}`,
    };
  }
  match = /^(\d+(?:\.\d+)?)$/.exec(value);
  if (match) {
    return { nominal: Number(match[1]), upper: 0, lower: 0 };
  }
  return null;
}
