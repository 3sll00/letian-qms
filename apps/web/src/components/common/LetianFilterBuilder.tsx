import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  Filter,
  Search,
  RotateCcw,
  Plus,
  Trash2,
  ChevronDown,
  ChevronUp,
  X,
  Check,
  Sparkles,
  Loader2,
} from 'lucide-react';
import { api, errorMessage } from '../../lib/api';

export interface FilterOption {
  value: string;
  label: string;
  color?: string;
}

export interface CustomCondition {
  id: string;
  field: string;
  operator: 'equals' | 'contains' | 'in' | 'notIn';
  value: string;
}

export interface LetianFilterValues {
  materialCodes: string[];
  supplierCodes: string[];
  statuses: string[];
  stages: string[];
  keyword: string;
  conditions: CustomCondition[];
  [key: string]: any;
}

export interface LetianFilterBuilderProps {
  /** 物料候选 {code,name}：缺省时组件自行拉取 GET /master-data/inventory（PBAC 过滤后的档案） */
  materials?: Array<{ code: string; name: string }>;
  /** 供应商候选 {code,name}：缺省时自行拉取 GET /master-data/suppliers */
  suppliers?: Array<{ code: string; name: string }>;
  statuses?: FilterOption[];
  stages?: FilterOption[];
  /** 「高级组合条件」行的可选字段：由各页面按其真实查询参数收敛（不支持的字段不展示） */
  conditionFields?: Array<{ value: string; label: string }>;
  /** 额外控件插槽：渲染在多选下拉与操作按钮之间（日期范围、检验人等页面自有维度） */
  children?: React.ReactNode;
  initialValues?: Partial<LetianFilterValues>;
  onFilter: (values: LetianFilterValues) => void;
  onReset?: () => void;
  loading?: boolean;
  className?: string;
}

const DEFAULT_STAGES: FilterOption[] = [
  { value: 'IQC', label: '来料检验 (IQC)', color: 'blue' },
  { value: 'IPQC', label: '过程检验 (IPQC)', color: 'amber' },
  { value: 'FQC', label: '成品检验 (FQC)', color: 'indigo' },
  { value: 'OQC', label: '出货检验 (OQC)', color: 'emerald' },
];

const DEFAULT_STATUSES: FilterOption[] = [
  { value: 'PENDING', label: '待检验', color: 'slate' },
  { value: 'PASSED', label: '合格', color: 'emerald' },
  { value: 'FAILED', label: '不合格', color: 'rose' },
  { value: 'IN_MRB_REVIEW', label: 'MRB评审中', color: 'purple' },
  { value: 'COMPLETED', label: '已完成', color: 'blue' },
];

/** 「高级组合条件」默认可选字段：仅为兜底，页面应按其真实查询参数传 conditionFields 收敛 */
const DEFAULT_CONDITION_FIELDS: Array<{ value: string; label: string }> = [
  { value: 'batchNo', label: '批次号 (batchNo)' },
  { value: 'orderNo', label: '检验单号 (orderNo)' },
  { value: 'inspectorName', label: '检验人 (inspectorName)' },
];

export const LetianFilterBuilder: React.FC<LetianFilterBuilderProps> = ({
  materials = [],
  suppliers = [],
  statuses = DEFAULT_STATUSES,
  stages = DEFAULT_STAGES,
  conditionFields = DEFAULT_CONDITION_FIELDS,
  children,
  initialValues,
  onFilter,
  onReset,
  loading = false,
  className = '',
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [keyword, setKeyword] = useState(initialValues?.keyword || '');
  const [selectedMaterials, setSelectedMaterials] = useState<string[]>(
    initialValues?.materialCodes || []
  );
  const [selectedSuppliers, setSelectedSuppliers] = useState<string[]>(
    initialValues?.supplierCodes || []
  );
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>(
    initialValues?.statuses || []
  );
  const [selectedStages, setSelectedStages] = useState<string[]>(
    initialValues?.stages || []
  );
  const [conditions, setConditions] = useState<CustomCondition[]>(
    initialValues?.conditions || []
  );

  const [openDropdown, setOpenDropdown] = useState<string | null>(null);

  // 物料 / 供应商候选：调用方未提供时自行从主数据接口拉取（真实档案，绝不内置兜底数据）
  const [fetchedMaterials, setFetchedMaterials] = useState<Array<{ code: string; name: string }>>([]);
  const [fetchedSuppliers, setFetchedSuppliers] = useState<Array<{ code: string; name: string }>>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState('');
  const optionsRequestedRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const effectiveMaterials = materials.length > 0 ? materials : fetchedMaterials;
  const effectiveSuppliers = suppliers.length > 0 ? suppliers : fetchedSuppliers;

  useEffect(() => {
    if (materials.length > 0 && suppliers.length > 0) return;
    if (optionsRequestedRef.current) return;
    optionsRequestedRef.current = true;
    setOptionsLoading(true);
    (async () => {
      try {
        const [inventory, supplierList] = await Promise.all([
          materials.length === 0
            ? api.get<Array<{ materialCode: string; materialName: string }>>(
                '/master-data/inventory'
              )
            : Promise.resolve(null),
          suppliers.length === 0
            ? api.get<Array<{ supplierCode: string; supplierName: string }>>(
                '/master-data/suppliers'
              )
            : Promise.resolve(null),
        ]);
        if (inventory !== null) {
          setFetchedMaterials(
            inventory.map((m) => ({ code: m.materialCode, name: m.materialName }))
          );
        }
        if (supplierList !== null) {
          setFetchedSuppliers(
            supplierList.map((s) => ({ code: s.supplierCode, name: s.supplierName }))
          );
        }
      } catch (err) {
        setOptionsError(errorMessage(err));
      } finally {
        setOptionsLoading(false);
      }
    })();
    // 候选由 props 决定且只在挂载时拉取一次（主数据档案，字典量级小）
  }, []);

  // 点击组件外部时收起展开中的下拉（此前只有再次点击按钮才能关闭）
  useEffect(() => {
    if (openDropdown === null) return;
    const onDocClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpenDropdown(null);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [openDropdown]);

  const toggleSelection = (
    list: string[],
    setList: React.Dispatch<React.SetStateAction<string[]>>,
    val: string
  ) => {
    setList((prev) =>
      prev.includes(val) ? prev.filter((item) => item !== val) : [...prev, val]
    );
  };

  const handleApply = () => {
    setOpenDropdown(null);
    onFilter({
      materialCodes: selectedMaterials,
      supplierCodes: selectedSuppliers,
      statuses: selectedStatuses,
      stages: selectedStages,
      keyword: keyword.trim(),
      conditions,
    });
  };

  const handleReset = () => {
    setKeyword('');
    setSelectedMaterials([]);
    setSelectedSuppliers([]);
    setSelectedStatuses([]);
    setSelectedStages([]);
    setConditions([]);
    setOpenDropdown(null);
    if (onReset) {
      onReset();
    } else {
      onFilter({
        materialCodes: [],
        supplierCodes: [],
        statuses: [],
        stages: [],
        keyword: '',
        conditions: [],
      });
    }
  };

  const addCondition = () => {
    const newId = `c_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    setConditions((prev) => [
      ...prev,
      {
        id: newId,
        field: conditionFields[0]?.value ?? 'batchNo',
        operator: 'contains',
        value: '',
      },
    ]);
  };

  const updateCondition = (
    id: string,
    field: keyof CustomCondition,
    val: any
  ) => {
    setConditions((prev) =>
      prev.map((c) => (c.id === id ? { ...c, [field]: val } : c))
    );
  };

  const removeCondition = (id: string) => {
    setConditions((prev) => prev.filter((c) => c.id !== id));
  };

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (keyword.trim()) count++;
    count += selectedMaterials.length;
    count += selectedSuppliers.length;
    count += selectedStatuses.length;
    count += selectedStages.length;
    count += conditions.filter((c) => c.value.trim()).length;
    return count;
  }, [
    keyword,
    selectedMaterials,
    selectedSuppliers,
    selectedStatuses,
    selectedStages,
    conditions,
  ]);
  return (
    <div
      ref={rootRef}
      className={`bg-white border border-slate-200 rounded-xl shadow-sm transition-all duration-200 ${className}`}
    >
      {/* 顶部主筛选栏 */}
      <div className="p-4 flex flex-wrap items-center justify-between gap-3">
        {/* 左侧筛选快捷项 */}
        <div className="flex flex-wrap items-center gap-2.5 flex-1 min-w-[300px]">
          {/* 关键字搜索输入 */}
          <div className="relative min-w-[200px] max-w-xs flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              placeholder="搜索检验单号、炉批号..."
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleApply()}
              className="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-colors"
            />
          </div>

          {/* 检验环节多选下拉 */}
          <div className="relative">
            <button
              type="button"
              onClick={() =>
                setOpenDropdown(openDropdown === 'stage' ? null : 'stage')
              }
              className={`px-3 py-1.5 text-xs border rounded-lg flex items-center gap-1.5 transition-colors ${
                selectedStages.length > 0
                  ? 'border-blue-300 bg-blue-50/70 text-blue-700 font-medium'
                  : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
              }`}
            >
              <span>检验环节</span>
              {selectedStages.length > 0 && (
                <span className="w-4 h-4 bg-blue-600 text-white rounded-full text-[10px] flex items-center justify-center font-bold">
                  {selectedStages.length}
                </span>
              )}
              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            </button>
            {openDropdown === 'stage' && (
              <div className="absolute top-full left-0 mt-1 w-52 bg-white border border-slate-200 rounded-lg shadow-lg z-30 p-2 text-xs space-y-1">
                <div className="text-[11px] text-slate-400 px-2 py-1 font-semibold">
                  选择检验环节 (多选)
                </div>
                {stages.map((st) => {
                  const checked = selectedStages.includes(st.value);
                  return (
                    <div
                      key={st.value}
                      onClick={() =>
                        toggleSelection(
                          selectedStages,
                          setSelectedStages,
                          st.value
                        )
                      }
                      className={`flex items-center justify-between px-2.5 py-1.5 rounded cursor-pointer transition-colors ${
                        checked ? 'bg-blue-50 text-blue-700' : 'hover:bg-slate-50'
                      }`}
                    >
                      <span>{st.label}</span>
                      {checked && <Check className="w-3.5 h-3.5 text-blue-600" />}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 物料多选下拉 */}
          <div className="relative">
            <button
              type="button"
              onClick={() =>
                setOpenDropdown(openDropdown === 'material' ? null : 'material')
              }
              className={`px-3 py-1.5 text-xs border rounded-lg flex items-center gap-1.5 transition-colors ${
                selectedMaterials.length > 0
                  ? 'border-blue-300 bg-blue-50/70 text-blue-700 font-medium'
                  : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
              }`}
            >
              <span>多选物料</span>
              {selectedMaterials.length > 0 && (
                <span className="w-4 h-4 bg-blue-600 text-white rounded-full text-[10px] flex items-center justify-center font-bold">
                  {selectedMaterials.length}
                </span>
              )}
              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            </button>
            {openDropdown === 'material' && (
              <div className="absolute top-full left-0 mt-1 w-64 max-h-60 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg z-30 p-2 text-xs space-y-1">
                <div className="text-[11px] text-slate-400 px-2 py-1 font-semibold">
                  选择物料品类与编码
                </div>
                {optionsError !== '' && (
                  <div className="px-2 py-1 text-rose-500">档案加载失败: {optionsError}</div>
                )}
                {optionsLoading && effectiveMaterials.length === 0 ? (
                  <div className="px-2 py-2 text-slate-400 flex items-center gap-1.5">
                    <Loader2 className="w-3 h-3 animate-spin" /> 加载物料档案…
                  </div>
                ) : effectiveMaterials.length === 0 ? (
                  <div className="px-2 py-2 text-slate-400">暂无物料档案</div>
                ) : (
                  effectiveMaterials.map((mat) => {
                  const checked = selectedMaterials.includes(mat.code);
                  return (
                    <div
                      key={mat.code}
                      onClick={() =>
                        toggleSelection(
                          selectedMaterials,
                          setSelectedMaterials,
                          mat.code
                        )
                      }
                      className={`flex items-center justify-between px-2.5 py-1.5 rounded cursor-pointer transition-colors ${
                        checked ? 'bg-blue-50 text-blue-700' : 'hover:bg-slate-50'
                      }`}
                    >
                      <div className="truncate pr-2">
                        <div className="font-medium truncate">{mat.name}</div>
                        <div className="text-[10px] text-slate-400">{mat.code}</div>
                      </div>
                      {checked && <Check className="w-3.5 h-3.5 text-blue-600 shrink-0" />}
                    </div>
                  );
                  })
                )}
              </div>
            )}
          </div>

          {/* 供应商多选下拉 */}
          <div className="relative">
            <button
              type="button"
              onClick={() =>
                setOpenDropdown(openDropdown === 'supplier' ? null : 'supplier')
              }
              className={`px-3 py-1.5 text-xs border rounded-lg flex items-center gap-1.5 transition-colors ${
                selectedSuppliers.length > 0
                  ? 'border-blue-300 bg-blue-50/70 text-blue-700 font-medium'
                  : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
              }`}
            >
              <span>多选供应商</span>
              {selectedSuppliers.length > 0 && (
                <span className="w-4 h-4 bg-blue-600 text-white rounded-full text-[10px] flex items-center justify-center font-bold">
                  {selectedSuppliers.length}
                </span>
              )}
              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            </button>
            {openDropdown === 'supplier' && (
              <div className="absolute top-full left-0 mt-1 w-64 max-h-60 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg z-30 p-2 text-xs space-y-1">
                <div className="text-[11px] text-slate-400 px-2 py-1 font-semibold">
                  选择供应商
                </div>
                {optionsError !== '' && (
                  <div className="px-2 py-1 text-rose-500">档案加载失败: {optionsError}</div>
                )}
                {optionsLoading && effectiveSuppliers.length === 0 ? (
                  <div className="px-2 py-2 text-slate-400 flex items-center gap-1.5">
                    <Loader2 className="w-3 h-3 animate-spin" /> 加载供应商档案…
                  </div>
                ) : effectiveSuppliers.length === 0 ? (
                  <div className="px-2 py-2 text-slate-400">暂无供应商档案</div>
                ) : (
                  effectiveSuppliers.map((sup) => {
                  const checked = selectedSuppliers.includes(sup.code);
                  return (
                    <div
                      key={sup.code}
                      onClick={() =>
                        toggleSelection(
                          selectedSuppliers,
                          setSelectedSuppliers,
                          sup.code
                        )
                      }
                      className={`flex items-center justify-between px-2.5 py-1.5 rounded cursor-pointer transition-colors ${
                        checked ? 'bg-blue-50 text-blue-700' : 'hover:bg-slate-50'
                      }`}
                    >
                      <div className="truncate pr-2">
                        <div className="font-medium truncate">{sup.name}</div>
                        <div className="text-[10px] text-slate-400">{sup.code}</div>
                      </div>
                      {checked && <Check className="w-3.5 h-3.5 text-blue-600 shrink-0" />}
                    </div>
                  );
                  })
                )}
              </div>
            )}
          </div>

          {/* 状态多选下拉 */}
          <div className="relative">
            <button
              type="button"
              onClick={() =>
                setOpenDropdown(openDropdown === 'status' ? null : 'status')
              }
              className={`px-3 py-1.5 text-xs border rounded-lg flex items-center gap-1.5 transition-colors ${
                selectedStatuses.length > 0
                  ? 'border-blue-300 bg-blue-50/70 text-blue-700 font-medium'
                  : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
              }`}
            >
              <span>单据状态</span>
              {selectedStatuses.length > 0 && (
                <span className="w-4 h-4 bg-blue-600 text-white rounded-full text-[10px] flex items-center justify-center font-bold">
                  {selectedStatuses.length}
                </span>
              )}
              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            </button>
            {openDropdown === 'status' && (
              <div className="absolute top-full left-0 mt-1 w-52 bg-white border border-slate-200 rounded-lg shadow-lg z-30 p-2 text-xs space-y-1">
                <div className="text-[11px] text-slate-400 px-2 py-1 font-semibold">
                  选择状态 (多选)
                </div>
                {statuses.map((st) => {
                  const checked = selectedStatuses.includes(st.value);
                  return (
                    <div
                      key={st.value}
                      onClick={() =>
                        toggleSelection(
                          selectedStatuses,
                          setSelectedStatuses,
                          st.value
                        )
                      }
                      className={`flex items-center justify-between px-2.5 py-1.5 rounded cursor-pointer transition-colors ${
                        checked ? 'bg-blue-50 text-blue-700' : 'hover:bg-slate-50'
                      }`}
                    >
                      <span>{st.label}</span>
                      {checked && <Check className="w-3.5 h-3.5 text-blue-600" />}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 页面自有维度插槽（日期范围 / 检验人等，随「应用筛选」一同生效） */}
          {children}
        </div>

        {/* 右侧操作按钮组 */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="px-3 py-1.5 text-xs text-slate-600 hover:text-slate-900 border border-slate-200 hover:border-slate-300 rounded-lg flex items-center gap-1 bg-white"
          >
            <Filter className="w-3.5 h-3.5 text-slate-400" />
            <span>高级组合筛选</span>
            {conditions.length > 0 && (
              <span className="bg-amber-500 text-white rounded-full w-4 h-4 text-[10px] flex items-center justify-center font-bold">
                {conditions.length}
              </span>
            )}
            {isExpanded ? (
              <ChevronUp className="w-3 h-3 text-slate-400 ml-0.5" />
            ) : (
              <ChevronDown className="w-3 h-3 text-slate-400 ml-0.5" />
            )}
          </button>

          <button
            type="button"
            onClick={handleReset}
            disabled={loading}
            className="px-3 py-1.5 text-xs text-slate-500 hover:text-slate-800 border border-slate-200 rounded-lg flex items-center gap-1 hover:bg-slate-50 disabled:opacity-50"
          >
            <RotateCcw className="w-3.5 h-3.5 text-slate-400" />
            <span>重置</span>
          </button>

          <button
            type="button"
            onClick={handleApply}
            disabled={loading}
            className="px-4 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg flex items-center gap-1.5 shadow-sm transition-colors disabled:opacity-50"
          >
            <Search className="w-3.5 h-3.5" />
            <span>{loading ? '查询中...' : '应用筛选'}</span>
          </button>
        </div>
      </div>

      {/* 展开的高级组合条件面板 */}
      {isExpanded && (
        <div className="p-4 pt-2 border-t border-slate-100 bg-slate-50/50 space-y-3">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span className="font-semibold flex items-center gap-1.5 text-slate-700">
              <Sparkles className="w-3.5 h-3.5 text-amber-500" />
              自定义多条件组合逻辑 (AND)
            </span>
            <button
              type="button"
              onClick={addCondition}
              className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1 font-medium"
            >
              <Plus className="w-3.5 h-3.5" />
              添加筛选条件行
            </button>
          </div>

          {conditions.length === 0 ? (
            <div className="text-center py-4 border border-dashed border-slate-200 rounded-lg text-xs text-slate-400 bg-white">
              点击上方“添加筛选条件行”构建针对公差、判定结果或自定义字段的组合规则
            </div>
          ) : (
            <div className="space-y-2">
              {conditions.map((cond) => (
                <div
                  key={cond.id}
                  className="flex items-center gap-2 bg-white p-2 border border-slate-200 rounded-lg text-xs"
                >
                  <select
                    value={cond.field}
                    onChange={(e) => updateCondition(cond.id, 'field', e.target.value)}
                    className="border border-slate-200 rounded px-2.5 py-1 text-xs bg-white text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    {conditionFields.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>

                  <select
                    value={cond.operator}
                    onChange={(e) => updateCondition(cond.id, 'operator', e.target.value as any)}
                    className="border border-slate-200 rounded px-2.5 py-1 text-xs bg-white text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="contains">包含 (contains)</option>
                    <option value="equals">精确等于 (equals)</option>
                    <option value="in">属于集合 (in)</option>
                    <option value="notIn">不属于 (not in)</option>
                  </select>

                  <input
                    type="text"
                    placeholder="输入匹配值..."
                    value={cond.value}
                    onChange={(e) => updateCondition(cond.id, 'value', e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleApply()}
                    className="flex-1 border border-slate-200 rounded px-2.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />

                  <button
                    type="button"
                    onClick={() => removeCondition(cond.id)}
                    className="p-1 text-slate-400 hover:text-rose-600 rounded hover:bg-rose-50 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 已选筛选项徽章摘要条 */}
      {activeFilterCount > 0 && (
        <div className="px-4 py-2 border-t border-slate-100 bg-slate-50 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-slate-400 font-medium mr-1 text-[11px]">
            当前生效筛选 ({activeFilterCount}):
          </span>

          {keyword.trim() && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-100 text-blue-800 rounded-md text-[11px]">
              关键字: {keyword}
              <X
                className="w-3 h-3 cursor-pointer hover:text-blue-950"
                onClick={() => setKeyword('')}
              />
            </span>
          )}

          {selectedStages.map((st) => (
            <span
              key={`tag_st_${st}`}
              className="inline-flex items-center gap-1 px-2 py-0.5 bg-sky-100 text-sky-800 rounded-md text-[11px]"
            >
              环节: {stages.find((s) => s.value === st)?.label || st}
              <X
                className="w-3 h-3 cursor-pointer hover:text-sky-950"
                onClick={() =>
                  toggleSelection(selectedStages, setSelectedStages, st)
                }
              />
            </span>
          ))}

          {selectedMaterials.map((mCode) => (
            <span
              key={`tag_mat_${mCode}`}
              className="inline-flex items-center gap-1 px-2 py-0.5 bg-indigo-100 text-indigo-800 rounded-md text-[11px]"
            >
              物料: {effectiveMaterials.find((m) => m.code === mCode)?.name || mCode}
              <X
                className="w-3 h-3 cursor-pointer hover:text-indigo-950"
                onClick={() =>
                  toggleSelection(
                    selectedMaterials,
                    setSelectedMaterials,
                    mCode
                  )
                }
              />
            </span>
          ))}

          {selectedSuppliers.map((supCode) => (
            <span
              key={`tag_sup_${supCode}`}
              className="inline-flex items-center gap-1 px-2 py-0.5 bg-violet-100 text-violet-800 rounded-md text-[11px]"
            >
              供应商: {effectiveSuppliers.find((s) => s.code === supCode)?.name || supCode}
              <X
                className="w-3 h-3 cursor-pointer hover:text-violet-950"
                onClick={() =>
                  toggleSelection(
                    selectedSuppliers,
                    setSelectedSuppliers,
                    supCode
                  )
                }
              />
            </span>
          ))}

          {selectedStatuses.map((st) => (
            <span
              key={`tag_status_${st}`}
              className="inline-flex items-center gap-1 px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded-md text-[11px]"
            >
              状态: {statuses.find((s) => s.value === st)?.label || st}
              <X
                className="w-3 h-3 cursor-pointer hover:text-emerald-950"
                onClick={() =>
                  toggleSelection(
                    selectedStatuses,
                    setSelectedStatuses,
                    st
                  )
                }
              />
            </span>
          ))}

          {conditions
            .filter((c) => c.value.trim())
            .map((c) => (
              <span
                key={`tag_cond_${c.id}`}
                className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-100 text-amber-900 rounded-md text-[11px]"
              >
                {conditionFields.find((f) => f.value === c.field)?.label ?? c.field} {c.operator}{' '}
                &quot;{c.value}&quot;
                <X
                  className="w-3 h-3 cursor-pointer hover:text-amber-950"
                  onClick={() => removeCondition(c.id)}
                />
              </span>
            ))}

          <button
            type="button"
            onClick={handleReset}
            className="text-[11px] text-slate-400 hover:text-rose-600 underline ml-2"
          >
            清空所有条件
          </button>
        </div>
      )}
    </div>
  );
};
