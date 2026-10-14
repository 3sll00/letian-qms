import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ClipboardList, Plus, Trash2, X } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { INSPECTION_TYPES } from '../../lib/inspectionTypes';
import type { Equipment, InspectionPlan, InspectionType } from '@letian/contracts';

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
 * 检验项目的填写方式（2026-10 表格化改版）：
 *   「检验项目」区为逐行表格，列依次为 项目名称 / 检验类型 / 检验设备 / 标准值 / 上限值 /
 *   下限值 / 判定方式，按检验类型条件显隐：
 *     - 双边公差：标准值 + 上限值 + 下限值（绝对值口径，提交时折算 tolerance 偏移），
 *       落 NUMERIC，判定器按 [nominal-lower, nominal+upper] 公差带自动判定；
 *     - 单边公差：标准值（门槛值）+ 判定方式（≥ ＞ ≤ ＜ ＝，必填），落 NUMERIC，
 *       judgmentMethod 一并落库，判定器按操作符直接比较（忽略公差带）；
 *     - 外观：标准值为文字描述（落 remark，供检验员参考；判定器对无基准文本项返回
 *       PENDING 挂起人工确认），无上限/下限/判定方式。
 *   检验设备列为选填下拉，选项来自「系统管理-检验设备」台账，取「设备编码 设备名称」
 *   组合串直接落 measurementTool（ERP CheckDevice 口径，展示链路复用既有字段）。
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

/** 检验项目表格的行草稿：按「检验类型」条件显隐列，提交时折算成契约 InspectionPlanItem */
type ToleranceKind = 'BILATERAL' | 'UNILATERAL' | 'APPEARANCE';

interface DraftItemRow {
  uid: number;
  /** 项目名称（必填） */
  name: string;
  kind: ToleranceKind;
  /** 检验设备：『设备编码 设备名称』组合串（直接落 measurementTool），空 = 未选（选填） */
  equipment: string;
  /** 标准值：双边/单边为数字文本，外观为文字描述 */
  standard: string;
  /** 上限值 / 下限值：双边公差的绝对值口径，提交时折算成 tolerance 偏移 */
  upper: string;
  lower: string;
  /** 判定方式：单边公差必填（≥ ＞ ≤ ＜ ＝） */
  judgment: string;
}

const TOLERANCE_KIND_OPTIONS: { value: ToleranceKind; label: string }[] = [
  { value: 'BILATERAL', label: '双边公差' },
  { value: 'UNILATERAL', label: '单边公差' },
  { value: 'APPEARANCE', label: '外观' },
];

const JUDGMENT_METHOD_OPTIONS = ['≥', '＞', '≤', '＜', '＝'];

let draftUidSeed = 0;
function emptyDraftRow(): DraftItemRow {
  draftUidSeed += 1;
  return {
    uid: draftUidSeed,
    name: '',
    kind: 'BILATERAL',
    equipment: '',
    standard: '',
    upper: '',
    lower: '',
    judgment: '',
  };
}

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
  /** 检验项目表格行草稿：每行独立编辑，提交时按检验类型折算成契约指标 */
  const [draftRows, setDraftRows] = useState<DraftItemRow[]>([emptyDraftRow()]);
  /** 检验设备下拉选项（检验设备台账：「编码 名称」组合串） */
  const [equipmentOptions, setEquipmentOptions] = useState<string[]>([]);

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
    setDraftRows([emptyDraftRow()]);
    setSubmitting(false);

    let cancelled = false;
    void (async () => {
      const [categories, inventory, equipmentPage] = await Promise.all([
        api.get<CategoryNode[]>('/master-data/categories').catch(() => null),
        api
          .get<{ materialCode?: string; materialName?: string; categoryCode?: string; unit?: string }[]>(
            '/master-data/inventory'
          )
          .catch(() => null),
        // 检验设备选项域：检验设备台账（系统管理-检验设备），格式「编码 名称」；加载失败不阻断建方案
        api
          .get<{ items?: Equipment[]; list?: Equipment[] }>('/equipments', { page: 1, pageSize: 100 })
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
      setEquipmentOptions(
        (equipmentPage?.items ?? equipmentPage?.list ?? [])
          .map((row) => `${row.equipmentCode} ${row.name ?? ''}`.trim())
          .filter((label) => label !== '')
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

  /** 行编辑：局部更新一行草稿（按 uid 定位） */
  const updateRow = (uid: number, patch: Partial<DraftItemRow>) => {
    setDraftRows((rows) => rows.map((row) => (row.uid === uid ? { ...row, ...patch } : row)));
  };
  const removeRow = (uid: number) => setDraftRows((rows) => rows.filter((row) => row.uid !== uid));
  const addRow = () => setDraftRows((rows) => [...rows, emptyDraftRow()]);

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
    if (draftRows.length === 0) {
      alert('请至少添加一个检验项目');
      return;
    }
    // 行级校验：名称必填；数值口径校验数字与上下限关系；单边公差必选判定方式
    for (let index = 0; index < draftRows.length; index += 1) {
      const row = draftRows[index]!;
      const no = index + 1;
      if (row.name.trim() === '') {
        alert(`第 ${no} 行：请填写项目名称`);
        return;
      }
      if (row.kind !== 'APPEARANCE') {
        if (row.standard.trim() === '' || !Number.isFinite(Number(row.standard))) {
          alert(`第 ${no} 行【${row.name.trim()}】：标准值必须是数字`);
          return;
        }
        if (row.kind === 'UNILATERAL' && row.judgment === '') {
          alert(`第 ${no} 行【${row.name.trim()}】：单边公差必须选择判定方式（≥ ＞ ≤ ＜ ＝）`);
          return;
        }
        if (row.kind === 'BILATERAL') {
          if (row.upper.trim() !== '' && !Number.isFinite(Number(row.upper))) {
            alert(`第 ${no} 行【${row.name.trim()}】：上限值必须是数字`);
            return;
          }
          if (row.lower.trim() !== '' && !Number.isFinite(Number(row.lower))) {
            alert(`第 ${no} 行【${row.name.trim()}】：下限值必须是数字`);
            return;
          }
          if (
            row.upper.trim() !== '' &&
            row.lower.trim() !== '' &&
            Number(row.upper) <= Number(row.lower)
          ) {
            alert(`第 ${no} 行【${row.name.trim()}】：上限值必须大于下限值`);
            return;
          }
        }
      }
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
            items: draftRows.map((row, index) => {
              const base = {
                seq: index + 1,
                itemCode: `ITEM-${String(index + 1).padStart(2, '0')}`,
                name: row.name.trim(),
                // 检验设备（选填）：『编码 名称』组合串直接落 measurementTool（ERP CheckDevice 口径）
                ...(row.equipment !== '' ? { measurementTool: row.equipment } : {}),
                isMandatory: true,
              };
              // 外观：文字描述落 remark（判定器对无基准文本项返回 PENDING 挂起人工确认，
              // 绝不把说明语当可接受值逐字比对）；无上限/下限/判定方式。
              if (row.kind === 'APPEARANCE') {
                return {
                  ...base,
                  dataType: 'QUALITATIVE' as const,
                  metricCategory: 'APPEARANCE' as const,
                  toleranceKind: 'APPEARANCE' as const,
                  ...(row.standard.trim() !== '' ? { remark: row.standard.trim() } : {}),
                };
              }
              const nominal = Number(row.standard);
              // 单边公差：标准值即门槛值，判定方式落 judgmentMethod，判定器按操作符直接比较
              if (row.kind === 'UNILATERAL') {
                return {
                  ...base,
                  dataType: 'NUMERIC' as const,
                  metricCategory: 'DIMENSION' as const,
                  toleranceKind: 'UNILATERAL' as const,
                  nominalValue: nominal,
                  judgmentMethod: row.judgment,
                };
              }
              // 双边公差：上限值/下限值为绝对值口径，折算成公差偏移
              //（nominal ± offset 与判定器/证书/台账的公差带口径一致）
              const upperTolerance = row.upper.trim() !== '' ? Number(row.upper) - nominal : undefined;
              const lowerTolerance = row.lower.trim() !== '' ? nominal - Number(row.lower) : undefined;
              return {
                ...base,
                dataType: 'NUMERIC' as const,
                metricCategory: 'DIMENSION' as const,
                toleranceKind: 'BILATERAL' as const,
                nominalValue: nominal,
                ...(upperTolerance !== undefined ? { upperTolerance } : {}),
                ...(lowerTolerance !== undefined ? { lowerTolerance } : {}),
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

          {/* 检验项目表格：列 = 项目名称 / 检验类型 / 检验设备 / 标准值 / 上限值 / 下限值 / 判定方式 / 操作 */}
          <div className="mt-6">
            <div className={sectionTitle}>
              <span className={sectionBar} />
              <h3 className={sectionHeading}>检验项目</h3>
              <span className="ml-auto text-[12px] text-[#94A3B8]">已添加 {draftRows.length} 项</span>
              <button
                type="button"
                onClick={addRow}
                className="ml-3 inline-flex items-center gap-1 h-8 px-3 text-[12px] font-medium text-white bg-[#2B5AED] rounded-lg hover:bg-[#2450D4] transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                添加检验项目
              </button>
            </div>

            <div className="rounded-xl border border-[#E2E8F0] bg-white overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-[12px] text-left border-collapse min-w-[980px]">
                  <thead>
                    <tr className="bg-[#F8FAFC] text-[#64748B] font-medium border-b border-[#E2E8F0]">
                      <th className="py-2.5 px-3 w-10 text-center">#</th>
                      <th className="py-2.5 px-2">项目名称 <span className="text-rose-500">*</span></th>
                      <th className="py-2.5 px-2 w-28">检验类型</th>
                      <th className="py-2.5 px-2 w-44">检验设备</th>
                      <th className="py-2.5 px-2 w-28">标准值</th>
                      <th className="py-2.5 px-2 w-24">上限值</th>
                      <th className="py-2.5 px-2 w-24">下限值</th>
                      <th className="py-2.5 px-2 w-24">判定方式</th>
                      <th className="py-2.5 px-2 w-12 text-center">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#F1F5F9]">
                    {draftRows.length === 0 && (
                      <tr>
                        <td colSpan={9} className="py-10 text-center text-[#94A3B8]">
                          点击右上角「添加检验项目」新增一行
                        </td>
                      </tr>
                    )}
                    {draftRows.map((row, index) => {
                      const isAppearance = row.kind === 'APPEARANCE';
                      const isUnilateral = row.kind === 'UNILATERAL';
                      const cellInput =
                        'w-full h-8 px-2 text-[12px] bg-white border border-[#E2E8F0] rounded-md placeholder-[#94A3B8] focus:outline-none focus:border-[#2B5AED] transition-colors';
                      const cellSelect = `${cellInput} cursor-pointer`;
                      const dashCell = 'py-2.5 px-2 text-center text-[#CBD5E1] select-none';
                      return (
                        <tr key={row.uid} className="hover:bg-[#FAFBFE]">
                          <td className="py-2.5 px-3 text-center text-[#94A3B8] font-mono">{index + 1}</td>
                          <td className="py-2.5 px-2">
                            <input
                              type="text"
                              value={row.name}
                              onChange={(e) => updateRow(row.uid, { name: e.target.value })}
                              placeholder="如：对边宽度 s"
                              className={cellInput}
                            />
                          </td>
                          <td className="py-2.5 px-2">
                            <select
                              value={row.kind}
                              onChange={(e) => updateRow(row.uid, { kind: e.target.value as ToleranceKind })}
                              className={cellSelect}
                            >
                              {TOLERANCE_KIND_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2.5 px-2">
                            <select
                              value={row.equipment}
                              onChange={(e) => updateRow(row.uid, { equipment: e.target.value })}
                              className={cellSelect}
                              title="选填；选项来自「系统管理-检验设备」台账，格式：设备编码 设备名称"
                            >
                              <option value="">不指定（选填）</option>
                              {equipmentOptions.map((label) => (
                                <option key={label} value={label}>
                                  {label}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2.5 px-2">
                            {isAppearance ? (
                              <input
                                type="text"
                                value={row.standard}
                                onChange={(e) => updateRow(row.uid, { standard: e.target.value })}
                                placeholder="文字描述，如：表面无毛刺、无裂纹"
                                className={cellInput}
                              />
                            ) : (
                              <input
                                type="number"
                                step="any"
                                value={row.standard}
                                onChange={(e) => updateRow(row.uid, { standard: e.target.value })}
                                placeholder={isUnilateral ? '门槛值，如 650' : '如 36'}
                                title={isUnilateral ? '单边公差：标准值即门槛值，与判定方式组合成 ≥650 等' : '双边公差：公称值，与上限值/下限值组成公差带'}
                                className={`${cellInput} text-right font-mono`}
                              />
                            )}
                          </td>
                          {/* 上限值 / 下限值：仅双边公差可填（绝对值口径，提交时折算公差偏移） */}
                          {isAppearance || isUnilateral ? (
                            <>
                              <td className={dashCell}>—</td>
                              <td className={dashCell}>—</td>
                            </>
                          ) : (
                            <>
                              <td className="py-2.5 px-2">
                                <input
                                  type="number"
                                  step="any"
                                  value={row.upper}
                                  onChange={(e) => updateRow(row.uid, { upper: e.target.value })}
                                  placeholder="如 36.5"
                                  title="绝对值口径（= 标准值 + 上偏差）"
                                  className={`${cellInput} text-right font-mono`}
                                />
                              </td>
                              <td className="py-2.5 px-2">
                                <input
                                  type="number"
                                  step="any"
                                  value={row.lower}
                                  onChange={(e) => updateRow(row.uid, { lower: e.target.value })}
                                  placeholder="如 35.5"
                                  title="绝对值口径（= 标准值 - 下偏差）"
                                  className={`${cellInput} text-right font-mono`}
                                />
                              </td>
                            </>
                          )}
                          {/* 判定方式：仅单边公差可填（必填） */}
                          {isAppearance ? (
                            <td className={dashCell}>—</td>
                          ) : isUnilateral ? (
                            <td className="py-2.5 px-2">
                              <select
                                value={row.judgment}
                                onChange={(e) => updateRow(row.uid, { judgment: e.target.value })}
                                className={cellSelect}
                                title="单边公差必填：判定器按 标准值 与该操作符直接比较"
                              >
                                <option value="">必选</option>
                                {JUDGMENT_METHOD_OPTIONS.map((op) => (
                                  <option key={op} value={op}>
                                    {op}
                                  </option>
                                ))}
                              </select>
                            </td>
                          ) : (
                            <td
                              className="py-2.5 px-2 text-center text-[#94A3B8] select-none"
                              title="双边公差按 [下限值, 上限值] 公差带自动判定，无需选择"
                            >
                              自动
                            </td>
                          )}
                          <td className="py-2.5 px-2 text-center">
                            <button
                              type="button"
                              onClick={() => removeRow(row.uid)}
                              title="删除本行"
                              className="inline-flex items-center justify-center w-7 h-7 rounded-md text-[#EF4444] hover:bg-red-50 transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <p className="mt-3 text-[12px] text-[#94A3B8]">
            <span className="inline-flex items-center gap-1">
              <ClipboardList className="w-3.5 h-3.5" />
              双边公差按 [下限值, 上限值] 自动判定；单边公差按「判定方式 + 标准值」比较（如 ≥650）；
              外观项的标准值为文字要求，由检验员在录入时人工确认。
            </span>
          </p>

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
