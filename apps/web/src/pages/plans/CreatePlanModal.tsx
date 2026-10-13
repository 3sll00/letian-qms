import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Eye, Ruler, X, Zap } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { INSPECTION_TYPES } from '../../lib/inspectionTypes';
import {
  ALL_PLAN_PRESETS,
  DEFAULT_ENABLED_PLAN_CATEGORIES,
  PLAN_CHECK_CATEGORIES,
  parsePlanStandardValue,
  type PlanCategoryKey,
  type PlanPresetItem,
} from '@letian/contracts';
import type { InspectionPlan, InspectionType } from '@letian/contracts';

/**
 * 新建质检方案弹窗（质检方案设计页「新建质检方案」入口）。
 *
 * 与 ERP 检验方案表的对接口径（管家婆 `T_Inf_PtypeCheckingSchemeNdx/Dly`）：
 *   方案主表：PtypeId(物料) + GxTypeId(工序类型)
 *     -> 本弹窗的「物料编码(三级联动) + 质检类型(工序阶段)」；
 *   方案明细：TITypeId(检验项目) + StandardValue(标准值) + Dif(公差)
 *            + CheckWay(检验方式) + CheckDevice(检验设备) + Summary(备注)；
 *   契约字段映射：TITypeId->testItemCode、CheckWay->checkWay、CheckDevice->measurementTool、
 *     Summary->remark；
 *
 * 检验项目的填写方式（2026-10 交互改版）：
 *   不再是「下拉选字典 + 逐行手填」的表格，改为「选择检验类型卡片 + 预置检验项目勾选清单」：
 *     1. 三张类别卡片（外观检验 / 尺寸检验 / 性能检验）各带「启用」勾选，启用后才展开
 *        该类别的项目清单；
 *     2. 清单项按紧固件检验惯例预置（表面毛疵、对边 s、牙距 P、硬度 HRC/HV 等），
 *        勾选即纳入方案；右侧为可编辑的标准值输入框（默认预填该项的默认要求，可改）；
 *     3. 标准值口径决定判定方式（2026-10-08 二次改版）：输入数值口径（36±0.5 / 36+0.2/-0.1
 *        / 36）解析为公称值+上下公差，指标落 NUMERIC，判定器（tolerance-evaluator）按公差带
 *        自动判定；文字要求（如「按产品标准」「清理干净…」）落 remark 供检验员参考，
 *        dataType 保持 TEXT/QUALITATIVE、standardText 留空 —— 判定器对无基准的文本项返回
 *        PENDING 挂起人工确认，绝不把说明语当可接受值逐字比对（否则永远判不合格）。
 *   testItemCode 只在能与 ERP 检验项目字典（迁移 037）语义对上时回链（外观->00001、
 *   尺寸->00002、通止->00003、硬度->00004、拉伸->00005），对不上的预置项省略该字段
 *   （契约 optional），保证 ERP 同步与指标统计不被脏编码污染。
 *
 *   质检类型（IQC/IPQC/OQC 工序阶段）与检验类别（外观/尺寸/性能）是两个维度：
 *   前者决定方案服务哪个检验环节（ERP GxTypeId 口径，保留在基础信息区），
 *   后者只决定本方案包含哪些检验项目。
 *
 *   dataType/metricCategory 为 QMS 判定域枚举（ERP 无此列）：外观/螺纹实配等定性项落
 *   QUALITATIVE，其余预置项落 TEXT（「按产品标准」解析不出数值边界，不捏造基准）；
 *   方案版本不走「草稿 → 审批」链路（已按产品口径删除）：保存即启用，不合适的方案
 *   由用户在方案列表直接「停用」；
 *   planCode 不前端拼：省略该字段由服务端按 QP-{YYYYMMDD}-{NNN} 取号（TBD-11）。
 */

/** 物料编码下拉的「分类通用」占位值：选中即不绑定单一物料（materialCode 空、categoryCode 已选） */
const GENERIC_MATERIAL = '__GENERIC__';

/**
 * 「选择检验类型」卡片配置：启用即展开该类别的预置项目清单。
 * 项目清单本身来自契约包（@letian/contracts 的 PLAN_CHECK_CATEGORIES），
 * 与【导入方案】Excel 模板共用同一份定义，杜绝两处漂移；此处只补 UI 的图标与说明。
 */
interface CheckCategory {
  key: PlanCategoryKey;
  name: string;
  desc: string;
  icon: typeof Eye;
  iconClass: string;
  items: PlanPresetItem[];
}

const CHECK_CATEGORIES: CheckCategory[] = [
  { key: 'APPEARANCE', name: '外观检验', desc: '表面毛疵、缺陷、螺纹完整性等', icon: Eye, iconClass: 'bg-amber-100 text-amber-500', items: PLAN_CHECK_CATEGORIES[0]!.items },
  { key: 'DIMENSION', name: '尺寸检验', desc: '对边、对角、厚度、螺纹等', icon: Ruler, iconClass: 'bg-blue-100 text-blue-500', items: PLAN_CHECK_CATEGORIES[1]!.items },
  { key: 'PERFORMANCE', name: '性能检验', desc: '硬度、强度、扭矩、表面处理等', icon: Zap, iconClass: 'bg-emerald-100 text-emerald-500', items: PLAN_CHECK_CATEGORIES[2]!.items },
];

/** 弹窗打开时的默认勾选态：启用 外观 + 尺寸，性能不启用（与交互稿一致） */
const DEFAULT_ENABLED_CATEGORIES: PlanCategoryKey[] = [...DEFAULT_ENABLED_PLAN_CATEGORIES];
const DEFAULT_CHECKED_ITEMS = CHECK_CATEGORIES.filter((category) =>
  DEFAULT_ENABLED_CATEGORIES.includes(category.key)
).flatMap((category) => category.items.map((item) => item.code));

/** 标准值输入框的默认值（各预置项的默认要求） */
const DEFAULT_STANDARD_INPUTS: Record<string, string> = Object.fromEntries(
  ALL_PLAN_PRESETS.map((item) => [item.code, item.hint])
);

interface CategoryNode {
  id: string;
  code: string;
  name: string;
  children?: CategoryNode[];
}

interface MaterialOption {
  materialCode: string;
  materialName: string;
  categoryCode: string;
  unit?: string;
}

/** 分类树 → 下拉选项（仅取有编码的节点，父级在前，与列表页「产品分类」筛选同一拍平口径） */
function flattenCategories(nodes: CategoryNode[], depth = 0): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [];
  for (const node of nodes) {
    if (node.code) {
      options.push({ value: node.code, label: `${'　'.repeat(depth)}${node.name || node.code}` });
    }
    if (node.children && node.children.length > 0) {
      options.push(...flattenCategories(node.children, depth + 1));
    }
  }
  return options;
}

/** 质检类型短名（「IQC 来料检验」→「来料检验」），用于方案名称自动建议 */
function shortTypeLabel(type: InspectionType): string {
  const label = INSPECTION_TYPES[type].label;
  const spaceIndex = label.indexOf(' ');
  return spaceIndex >= 0 ? label.slice(spaceIndex + 1) : label;
}

interface CreatePlanModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function CreatePlanModal({ isOpen, onClose, onSuccess }: CreatePlanModalProps) {
  const [categoryCode, setCategoryCode] = useState('');
  const [materialCode, setMaterialCode] = useState('');
  const [planName, setPlanName] = useState('');
  /** 方案名称是否被手工改过：未改过时随「物料名称-质检类型」自动建议，改过后不再覆盖 */
  const [planNameTouched, setPlanNameTouched] = useState(false);
  // 质检类型多选（039）：inspectionTypes[0] 为主类型（契约 inspectionType），全集落 inspection_types
  const [inspectionTypes, setInspectionTypes] = useState<InspectionType[]>(['IQC']);
  const [typeDropdownOpen, setTypeDropdownOpen] = useState(false);
  /** 启用的检验类别（卡片勾选）：启用才展开对应清单，且其项目才会参与提交 */
  const [enabledCategories, setEnabledCategories] = useState<PlanCategoryKey[]>([...DEFAULT_ENABLED_CATEGORIES]);
  /** 勾选的预置检验项目 code 清单（跨类别全局收集，提交时按 类别->预置顺序 展开） */
  const [checkedItems, setCheckedItems] = useState<string[]>([...DEFAULT_CHECKED_ITEMS]);
  /** 各预置项的标准值输入（code -> 输入原文）：默认取预置 hint，用户可随时改写 */
  const [standardInputs, setStandardInputs] = useState<Record<string, string>>(() => ({ ...DEFAULT_STANDARD_INPUTS }));

  const [categoryOptions, setCategoryOptions] = useState<{ value: string; label: string }[]>([]);
  const [materials, setMaterials] = useState<MaterialOption[]>([]);
  const [masterDataReady, setMasterDataReady] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // 每次打开弹窗重置为初始态，并拉取 物料分类 / 存货档案 作为选项域；
  // 主数据不可用时保持空选项并在字段下提示，绝不回落硬编码物料
  useEffect(() => {
    if (!isOpen) return;
    setCategoryCode('');
    setMaterialCode('');
    setPlanName('');
    setPlanNameTouched(false);
    setInspectionTypes(['IQC']);
    setTypeDropdownOpen(false);
    setEnabledCategories([...DEFAULT_ENABLED_CATEGORIES]);
    setCheckedItems([...DEFAULT_CHECKED_ITEMS]);
    setStandardInputs({ ...DEFAULT_STANDARD_INPUTS });
    setSubmitting(false);

    let cancelled = false;
    void (async () => {
      const [categories, inventory] = await Promise.all([
        api.get<CategoryNode[]>('/master-data/categories').catch(() => null),
        api
          .get<{ materialCode?: string; materialName?: string; categoryCode?: string; unit?: string }[]>(
            '/master-data/inventory'
          )
          .catch(() => null),
      ]);
      if (cancelled) return;
      setCategoryOptions(Array.isArray(categories) ? flattenCategories(categories) : []);
      setMaterials(
        Array.isArray(inventory)
          ? inventory
              .filter((row) => row !== null && typeof row === 'object' && String(row.materialCode ?? '') !== '')
              .map((row) => ({
                materialCode: String(row.materialCode),
                materialName: String(row.materialName ?? ''),
                categoryCode: String(row.categoryCode ?? ''),
                ...(row.unit !== undefined ? { unit: String(row.unit) } : {}),
              }))
          : []
      );
      setMasterDataReady(Array.isArray(categories) && Array.isArray(inventory));
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  /** 当前分类下的物料清单（编码/名称两个下拉共用同一份选项域） */
  const categoryMaterials = useMemo(
    () => materials.filter((row) => row.categoryCode === categoryCode),
    [materials, categoryCode]
  );

  const selectedMaterial = categoryMaterials.find((row) => row.materialCode === materialCode);
  const isGenericPlan = materialCode === GENERIC_MATERIAL;

  /** 方案名称建议值：物料名称-质检类型短名（仅未手工编辑时回填/跟随） */
  const suggestPlanName = (material: MaterialOption | undefined, type: InspectionType): string => {
    const materialName = material?.materialName ?? '';
    if (materialName === '') return '';
    return `${materialName}-${shortTypeLabel(type)}`;
  };

  const handleCategoryChange = (value: string) => {
    setCategoryCode(value);
    // 换分类后原物料选择失效，编码/名称一并清空回到待选态
    setMaterialCode('');
  };

  const handleMaterialChange = (value: string) => {
    setMaterialCode(value);
    const material = categoryMaterials.find((row) => row.materialCode === value);
    if (!planNameTouched) setPlanName(suggestPlanName(material, inspectionTypes[0] ?? 'IQC'));
  };

  /** 勾选/取消一个质检类型：集合顺序即选择顺序，首个为主类型（契约 inspectionType） */
  const handleTypeToggle = (type: InspectionType) => {
    const next = inspectionTypes.includes(type)
      ? inspectionTypes.filter((item) => item !== type)
      : [...inspectionTypes, type];
    setInspectionTypes(next);
    // 方案名称建议跟随主类型（首个选中项）；集合清空时不改写名称，等重新勾选再跟随
    if (!planNameTouched && next.length > 0) setPlanName(suggestPlanName(selectedMaterial, next[0]!));
  };

  /**
   * 启用/停用一个检验类别：启用时默认勾选该类别全部预置项（用户可在清单里再挑），
   * 停用时同步取消该类别全部勾选，保证「未启用的类别绝不混进提交数据」。
   */
  const handleCategoryToggle = (key: PlanCategoryKey) => {
    const category = CHECK_CATEGORIES.find((entry) => entry.key === key);
    if (!category) return;
    const codes = category.items.map((item) => item.code);
    if (enabledCategories.includes(key)) {
      setEnabledCategories(enabledCategories.filter((entry) => entry !== key));
      setCheckedItems(checkedItems.filter((code) => !codes.includes(code)));
    } else {
      setEnabledCategories([...enabledCategories, key]);
      setCheckedItems([...new Set([...checkedItems, ...codes])]);
    }
  };

  const handleItemCheck = (code: string) => {
    setCheckedItems(
      checkedItems.includes(code) ? checkedItems.filter((entry) => entry !== code) : [...checkedItems, code]
    );
  };

  /** 提交用的指标清单：按 类别 -> 预置顺序 展开，只含已勾选项 */
  const selectedPresets = useMemo(
    () => CHECK_CATEGORIES.flatMap((category) => category.items.filter((item) => checkedItems.includes(item.code))),
    [checkedItems]
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (categoryCode === '') {
      alert('请选择物料分类');
      return;
    }
    if (materialCode === '') {
      alert('请选择物料编码（或选「该分类通用」做分类通用方案）');
      return;
    }
    if (planName.trim() === '') {
      alert('请填写方案名称');
      return;
    }
    if (inspectionTypes.length === 0) {
      alert('请至少选择一个质检类型');
      return;
    }
    if (selectedPresets.length === 0) {
      alert('请至少勾选一个检验项目');
      return;
    }

    setSubmitting(true);
    try {
      const created = await api.post<InspectionPlan>('/plans', {
        planName: planName.trim(),
        // 契约：inspectionType = 主类型（多选集合第一个）；inspectionTypes = 适用类型全集
        inspectionType: inspectionTypes[0],
        inspectionTypes,
        ...(isGenericPlan ? {} : { materialCode }),
        categoryCode,
        versions: [
          {
            versionNo: 'V1.0',
            samplingScheme: 'GB_T_2828',
            aqlLevel: 'II',
            strictness: 'NORMAL',
            items: selectedPresets.map((preset, index) => {
              const rawStandard = (standardInputs[preset.code] ?? '').trim();
              const parsed = parsePlanStandardValue(rawStandard);
              const base = {
                seq: index + 1,
                itemCode: `ITEM-${preset.code}`,
                name: preset.name,
                metricCategory: preset.metricCategory,
                ...(preset.testItemCode !== undefined ? { testItemCode: preset.testItemCode } : {}),
                isMandatory: true,
              };
              if (parsed) {
                // 数值口径：按公差带自动判定（[nominal-lower, nominal+upper]），dif 承载公差原文（ERP Dif 口径）
                return {
                  ...base,
                  dataType: 'NUMERIC' as const,
                  nominalValue: parsed.nominal,
                  upperTolerance: parsed.upper,
                  lowerTolerance: parsed.lower,
                  ...(parsed.dif !== undefined ? { dif: parsed.dif } : {}),
                };
              }
              // 文字要求 / 留空：落 remark 供检验员参考，standardText 留空 ——
              // 判定器对无基准的文本项返回 PENDING 挂起人工确认，
              // 绝不把「按产品标准」这类说明语当可接受值逐字比对（否则录入永远判不合格）。
              return {
                ...base,
                dataType: preset.dataType,
                ...(rawStandard !== '' ? { remark: rawStandard } : {}),
              };
            }),
          },
        ],
      });

      // 服务端落库即启用（已删除「草稿 → 审批」链路）；方案不合适时在方案列表直接「停用」
      alert(`质检方案 ${created.planCode} 已保存并启用，可直接参与检验录入的自动匹配。`);
      onSuccess();
      onClose();
    } catch (err) {
      alert(`保存质检方案失败：${errorMessage(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  const fieldLabel = 'block text-[13px] text-[#1E293B] mb-1.5';
  const inputClass =
    'w-full h-10 px-3.5 text-[14px] bg-white border border-[#E2E8F0] rounded-lg placeholder-[#94A3B8] focus:outline-none focus:border-[#2B5AED] transition-colors disabled:bg-slate-50 disabled:text-[#94A3B8]';
  const selectClass = `${inputClass} appearance-none pr-9 cursor-pointer disabled:cursor-not-allowed`;
  const sectionTitle = 'relative flex items-center mb-3';
  const sectionBar = 'w-[3px] h-4 rounded-full bg-[#2B5AED]';
  const sectionHeading = 'ml-2 text-[15px] font-bold text-[#1E293B]';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 pt-5 pb-4 flex items-center justify-between">
          <h2 className="text-[17px] font-bold text-[#1E293B]">新建质检方案</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-[#94A3B8] hover:bg-slate-100 hover:text-[#475569] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-6 pb-5">
          {/* 基础信息：物料分类 → 物料编码 ⇄ 物料名称 三级联动 */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-5 gap-y-4">
            <div>
              <label className={fieldLabel}>
                物料分类 <span className="text-rose-500">*</span>
              </label>
              <div className="relative">
                <select
                  value={categoryCode}
                  onChange={(e) => handleCategoryChange(e.target.value)}
                  className={selectClass}
                >
                  <option value="">— 请选择物料分类 —</option>
                  {categoryOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#94A3B8]" />
              </div>
            </div>

            <div>
              <label className={fieldLabel}>
                物料编码 <span className="text-rose-500">*</span>
              </label>
              <div className="relative">
                <select
                  value={materialCode}
                  onChange={(e) => handleMaterialChange(e.target.value)}
                  disabled={categoryCode === ''}
                  className={`${selectClass} font-mono`}
                >
                  <option value="">
                    {categoryCode === '' ? '— 请选择物料分类 —' : '— 请选择物料编码 —'}
                  </option>
                  {categoryCode !== '' && <option value={GENERIC_MATERIAL}>该分类通用（不绑定单一物料）</option>}
                  {categoryMaterials.map((option) => (
                    <option key={option.materialCode} value={option.materialCode}>
                      {option.materialCode}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#94A3B8]" />
              </div>
            </div>

            <div>
              <label className={fieldLabel}>物料名称</label>
              <div className="relative">
                <select
                  // 名称与编码指向同一份物料：选名称等价于选编码，两者保持同步
                  value={isGenericPlan ? '' : materialCode}
                  onChange={(e) => handleMaterialChange(e.target.value)}
                  disabled={categoryCode === '' || isGenericPlan}
                  className={selectClass}
                >
                  <option value="">
                    {categoryCode === ''
                      ? '— 请选择物料分类 —'
                      : isGenericPlan
                        ? '— 分类通用方案 —'
                        : '— 请选择物料名称 —'}
                  </option>
                  {categoryMaterials.map((option) => (
                    <option key={option.materialCode} value={option.materialCode}>
                      {option.materialName || option.materialCode}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#94A3B8]" />
              </div>
            </div>

            <div>
              <label className={fieldLabel}>
                方案名称 <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="例如 碳钢圆钢-来料检验"
                value={planName}
                onChange={(e) => {
                  setPlanName(e.target.value);
                  setPlanNameTouched(true);
                }}
                className={inputClass}
              />
            </div>

            <div>
              <label className={fieldLabel}>
                质检类型 <span className="text-rose-500">*</span>
                <span className="ml-1 font-normal text-[#94A3B8]">（可多选）</span>
              </label>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setTypeDropdownOpen((open) => !open)}
                  className={`${inputClass} flex items-center justify-between text-left`}
                >
                  <span className={inspectionTypes.length === 0 ? 'text-[#94A3B8]' : ''}>
                    {inspectionTypes.length === 0
                      ? '请选择质检类型（可多选）'
                      : inspectionTypes.map(shortTypeLabel).join('、')}
                  </span>
                  <ChevronDown className="w-4 h-4 text-[#94A3B8] shrink-0 ml-2" />
                </button>
                {typeDropdownOpen && (
                  <>
                    {/* 透明遮罩：点击面板外任意处收起下拉（多选面板不在选项点击时关闭） */}
                    <div className="fixed inset-0 z-10" onClick={() => setTypeDropdownOpen(false)} />
                    <div className="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto rounded-lg border border-[#E2E8F0] bg-white shadow-lg py-1">
                      {(Object.keys(INSPECTION_TYPES) as InspectionType[]).map((type) => {
                        const checked = inspectionTypes.includes(type);
                        return (
                          <label
                            key={type}
                            className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-[#F1F5F9] text-[13px] text-[#334155]"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => handleTypeToggle(type)}
                              className="w-4 h-4 accent-[#2563EB]"
                            />
                            {shortTypeLabel(type)}
                            {checked && type === inspectionTypes[0] && (
                              <span className="ml-auto text-[11px] text-[#2563EB]">主类型</span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          <p className="mt-2 text-[12px] text-[#94A3B8]">
            保存后方案即启用并参与检验录入的自动匹配；不再需要的方案请在方案列表「停用」。
          </p>

          {!masterDataReady && (
            <p className="mt-3 text-[12px] text-amber-600">
              物料主数据加载失败，相关选项为空；请确认主数据已维护后重试。
            </p>
          )}

          {/* 选择检验类型：三张类别卡片，启用即展开对应预置项目清单 */}
          <div className="mt-6">
            <div className={sectionTitle}>
              <span className={sectionBar} />
              <h3 className={sectionHeading}>选择检验类型</h3>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {CHECK_CATEGORIES.map((category) => {
                const enabled = enabledCategories.includes(category.key);
                const Icon = category.icon;
                return (
                  <button
                    key={category.key}
                    type="button"
                    onClick={() => handleCategoryToggle(category.key)}
                    className={`text-left rounded-xl border p-4 transition-colors cursor-pointer ${
                      enabled
                        ? 'border-[#2B5AED] bg-[#EEF3FE]'
                        : 'border-[#E2E8F0] bg-white hover:border-[#C7D4F5]'
                    }`}
                  >
                    <span
                      className={`inline-flex items-center justify-center w-11 h-11 rounded-xl ${category.iconClass}`}
                    >
                      <Icon className="w-6 h-6" />
                    </span>
                    <div className="mt-3 text-[15px] font-bold text-[#1E293B]">{category.name}</div>
                    <div className="mt-0.5 text-[12px] text-[#94A3B8]">{category.desc}</div>
                    <label
                      className="mt-3 flex items-center gap-2 text-[13px] text-[#334155]"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={() => handleCategoryToggle(category.key)}
                        className="w-4 h-4 accent-[#2563EB] cursor-pointer"
                      />
                      启用
                    </label>
                  </button>
                );
              })}
            </div>
          </div>

          <p className="mt-3 text-[12px] text-[#94A3B8]">
            检验项目右侧的标准值可直接修改：填数值口径（如 36±0.5、36+0.2/-0.1）保存后按公差自动判定；
            文字要求（如「按产品标准」）在检验录入后由检验员人工确认。
          </p>

          {/* 各启用类别的预置检验项目勾选清单 */}
          {CHECK_CATEGORIES.filter((category) => enabledCategories.includes(category.key)).map((category) => (
            <div className="mt-6" key={category.key}>
              <div className={sectionTitle}>
                <span className={sectionBar} />
                <h3 className={sectionHeading}>{category.name}项目</h3>
                <span className="ml-auto text-[12px] text-[#94A3B8]">
                  已选 {category.items.filter((item) => checkedItems.includes(item.code)).length}/{category.items.length}
                </span>
              </div>
              <div className="rounded-xl bg-[#F8FAFC] p-2.5 space-y-2">
                {category.items.map((preset) => {
                  const checked = checkedItems.includes(preset.code);
                  const rawStandard = standardInputs[preset.code] ?? '';
                  const parsed = parsePlanStandardValue(rawStandard);
                  const inputId = `preset-check-${preset.code}`;
                  return (
                    <div
                      key={preset.code}
                      className={`flex items-center gap-3 rounded-lg border bg-white px-4 py-2.5 transition-colors ${
                        checked
                          ? 'border-[#C7D4F5] hover:border-[#2B5AED]'
                          : 'border-[#F1F5F9] hover:border-[#E2E8F0]'
                      }`}
                    >
                      <input
                        type="checkbox"
                        id={inputId}
                        checked={checked}
                        onChange={() => handleItemCheck(preset.code)}
                        className="w-[18px] h-[18px] accent-[#2563EB] rounded cursor-pointer shrink-0"
                      />
                      <label htmlFor={inputId} className="text-[14px] text-[#1E293B] cursor-pointer select-none">
                        {preset.name}
                      </label>
                      <div className="ml-auto flex items-center gap-2 shrink-0">
                        {parsed && (
                          <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#EEF3FE] text-[#2B5AED] whitespace-nowrap">
                            自动判定
                          </span>
                        )}
                        <input
                          type="text"
                          value={rawStandard}
                          disabled={!checked}
                          onChange={(e) =>
                            setStandardInputs((prev) => ({ ...prev, [preset.code]: e.target.value }))
                          }
                          placeholder="标准值，如 36±0.5"
                          title="数值口径（36±0.5 / 36+0.2/-0.1 / 36）保存后按公差自动判定；文字要求由检验员人工确认"
                          className="w-56 h-8 px-2.5 text-[12px] text-right bg-white border border-[#E2E8F0] rounded-md placeholder-[#94A3B8] focus:outline-none focus:border-[#2B5AED] transition-colors disabled:bg-slate-50 disabled:text-[#94A3B8] disabled:cursor-not-allowed"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {selectedPresets.length === 0 && (
            <p className="mt-4 text-[12px] text-amber-600">请至少勾选一个检验项目（启用对应检验类型后在清单中勾选）。</p>
          )}

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-3 pt-5 mt-5 border-t border-[#F1F5F9]">
            <button
              type="button"
              onClick={onClose}
              className="h-10 px-6 text-[14px] text-[#475569] bg-white border border-[#E2E8F0] rounded-lg hover:bg-slate-50 transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="h-10 px-6 text-[14px] font-medium text-white bg-[#2B5AED] rounded-lg hover:bg-[#2450D4] disabled:opacity-50 transition-colors"
            >
              {submitting ? '保存中...' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
