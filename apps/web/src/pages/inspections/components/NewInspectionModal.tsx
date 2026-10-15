import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { DateInput } from '../../../components/common/DateInput';
import { api, errorMessage, getCurrentUser } from '../../../lib/api';
import type { InspectionType } from '@letian/contracts';

/**
 * 「新增检验」弹窗（各检验台账筛选栏的统一建单入口）：
 *
 * 按调用方传入的 fields 逐列渲染（两列网格，行序即数组序），统一收敛为七个槽位四行：
 *   单据号（入库单号 / MES工单号 / 委外加工单号 / 销售出库单号）· 批次号 →
 *   物料编码 · 物料名称 → 规格型号 · 数量 → 检验人。
 * 除服务端建单必填的物料编码 / 批次号 / 数量外一律选填（空串不下发，不落 NULL 覆盖）。
 *
 * 「检验人」不是手填框：默认取当前登录用户本人，可下拉改选职员档案（GET /master-data/employees）
 * 中的其他在职职员；选中后随单落 inspector_name + inspector_id。
 *
 * 检验单号由服务端按 {类型前缀}-{YYYYMMDD}-{NNNN} 规则取号；状态 / 检验单号 / 操作列
 * 属建单后的派生列，不在录入范围。
 */
export interface NewInspectionFieldDef {
  /** CreateInspectionOrderRequest 的字段名 */
  key: string;
  /** 台账列名（即弹窗里的字段名） */
  label: string;
  /** 服务端建单必填（物料编码 / 批次号 / 数量为硬约束） */
  serverRequired?: boolean;
  type?: 'text' | 'number' | 'date' | 'select';
  placeholder?: string;
  /** type = select 时的选项 */
  options?: string[];
  /** 占整行（备注类长字段） */
  fullRow?: boolean;
}

export interface NewInspectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** 建单成功后的回调（刷新台账等） */
  onCreated: () => void;
  /** 模块名，用于弹窗标题，如「来料检验」「下料检验」 */
  moduleTitle: string;
  inspectionType: InspectionType;
  /** 该台账前端展示的业务列（不含检验单号 / 状态 / 操作等派生列） */
  fields: NewInspectionFieldDef[];
}

/** 职员档案行（GET /master-data/employees 响应项）：只声明弹窗实际读取的字段 */
interface EmployeeOption {
  id?: string;
  name?: string;
  employeeCode?: string;
  isActive?: boolean;
}

/** 存货主数据行（GET /master-data/inventory）：物料编码选择器选项来源 */
interface InventoryOption {
  materialCode?: string;
  materialName?: string;
  specModel?: string;
  unit?: string;
}

/** 建单响应：控制器 201 回吐整单，这里只声明回执要用的键 */
interface CreatedOrder {
  id?: string;
  orderNo?: string;
}

export const NewInspectionModal: React.FC<NewInspectionModalProps> = ({
  isOpen,
  onClose,
  onCreated,
  moduleTitle,
  inspectionType,
  fields,
}) => {
  const [employeeOptions, setEmployeeOptions] = useState<EmployeeOption[]>([]);
  const [inventoryOptions, setInventoryOptions] = useState<InventoryOption[]>([]);

  const [form, setForm] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  /** 同步防重复提交闸门：state 置位到重渲染之间存在窗口，连点会让两次提交都通过 submitting 检查 */
  const submittingRef = useRef(false);
  const [formError, setFormError] = useState('');
  /** 建单成功回执（绿色提示条，列表已在后台刷新；不弹 alert 打断连续录入） */
  const [submitNotice, setSubmitNotice] = useState('');

  const hasInspectorField = fields.some((f) => f.key === 'inspectorName');

  /** 空白草稿：「检验人」默认填当前登录用户本人（可下拉改选其他职员） */
  const initialForm = (): Record<string, string> => {
    const me = getCurrentUser()?.userName ?? '';
    return hasInspectorField && me !== '' ? { inspectorName: me } : {};
  };

  // 每次打开弹窗都重置为空白草稿（不残留上一次的半成品输入）
  useEffect(() => {
    if (!isOpen) return;
    setForm(initialForm());
    setFormError('');
    setSubmitNotice('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // 职员档案：「检验人」字段存在时加载，作为下拉的可改选名单（在职职员）
  useEffect(() => {
    if (!isOpen || !hasInspectorField) return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await api.get<EmployeeOption[]>('/master-data/employees');
        if (!cancelled && Array.isArray(rows)) {
          setEmployeeOptions(
            rows.filter(
              (row) =>
                row !== null &&
                typeof row === 'object' &&
                row.isActive !== false &&
                String(row.name ?? '') !== ''
            )
          );
        }
      } catch {
        if (!cancelled) setEmployeeOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, hasInspectorField]);

  // 存货主数据：物料编码字段存在时加载（主数据不可用时退化为手填）
  useEffect(() => {
    if (!isOpen || !fields.some((f) => f.key === 'materialCode')) return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await api.get<InventoryOption[]>('/master-data/inventory');
        if (!cancelled && Array.isArray(rows)) {
          setInventoryOptions(
            rows.filter((row) => row !== null && typeof row === 'object' && String(row.materialCode ?? '') !== '')
          );
        }
      } catch {
        if (!cancelled) setInventoryOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, fields]);

  /**
   * 「检验人」下拉选项：在职职员名单；当前登录用户不在名单时置顶补入本人选项，
   * 保证「默认填本人」在名单接口失败 / 档案缺失时依然成立（此时只可再选已加载的职员）。
   */
  const inspectorOptions = useMemo(() => {
    const seen = new Set<string>();
    const list: Array<{ id?: string; name: string; employeeCode?: string }> = [];
    const me = getCurrentUser()?.userName ?? '';
    if (me !== '') {
      seen.add(me);
      list.push({ name: me });
    }
    for (const emp of employeeOptions) {
      const name = String(emp.name ?? '').trim();
      if (name === '' || seen.has(name)) continue;
      seen.add(name);
      list.push({
        ...(emp.id !== undefined && emp.id !== '' ? { id: emp.id } : {}),
        name,
        ...(emp.employeeCode !== undefined && emp.employeeCode !== '' ? { employeeCode: emp.employeeCode } : {}),
      });
    }
    return list;
  }, [employeeOptions]);

  /** 选物料编码：只在对应字段为空时回填名称 / 规格，不覆盖已手填的值 */
  const handleMaterialCodeChange = (code: string) => {
    setForm((prev) => ({ ...prev, materialCode: code }));
    const option = inventoryOptions.find((row) => row.materialCode === code);
    if (option === undefined) return;
    setForm((prev) => {
      const next = { ...prev };
      if ((next.materialName ?? '') === '' && option.materialName) next.materialName = option.materialName;
      if ((next.specification ?? '') === '' && option.specModel) next.specification = option.specModel;
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    // 服务端建单硬约束：物料编码 / 批次号 / 数量（sampleQty 正数）
    const missing = fields.filter((f) => f.serverRequired && (form[f.key] ?? '').trim() === '');
    if (missing.length > 0) {
      setFormError(`服务端建单必填项缺失：${missing.map((f) => f.label).join('、')}`);
      return;
    }

    const body: Record<string, unknown> = {
      inspectionType,
    };
    for (const field of fields) {
      const raw = (form[field.key] ?? '').trim();
      if (raw === '') continue;
      if (field.type === 'number') {
        const num = Number(raw);
        if (!Number.isFinite(num)) {
          setFormError(`「${field.label}」不是有效数字：${raw}`);
          return;
        }
        body[field.key] = num;
      } else {
        body[field.key] = raw;
      }
    }
    // 「数量」一列同时落 sampleQty 与 totalQty：台账「数量」列在 IQC/OQC 读 sampleQty、
    // IPQC 读 totalQty，成对下发保证各台账都能看到建单时填的数量
    if (body.sampleQty !== undefined && body.totalQty === undefined) {
      body.totalQty = body.sampleQty;
    }
    // 「检验人」选中在职职员时成对落 inspector_id / inspector_name
    // （读侧只认库中真实列；名单加载不到时仅落姓名快照，不推导假 id）
    if (typeof body.inspectorName === 'string') {
      const matched = employeeOptions.find((emp) => String(emp.name ?? '').trim() === body.inspectorName);
      if (matched?.id !== undefined && matched.id !== '') {
        body.inspectorId = matched.id;
      }
    }

    submittingRef.current = true;
    setSubmitting(true);
    setFormError('');
    try {
      const created = await api.post<CreatedOrder>('/inspections', body);
      // 回执单号（服务端取号）就地绿条提示，列表在后台刷新；表单清空便于连续建单
      const orderNo = created?.orderNo ?? '';
      setSubmitNotice(
        orderNo !== '' ? `建单成功：${orderNo}（状态：待检验，列表已刷新）` : '建单成功（状态：待检验，列表已刷新）'
      );
      setForm(initialForm());
      onCreated();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  const inputClass =
    'w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs text-slate-700 placeholder:text-slate-400 focus:outline-none focus:border-blue-500';

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-2xl max-h-[88vh] overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100 bg-slate-50/70">
          <div className="flex items-center gap-2">
            <Plus className="w-4 h-4 text-emerald-600" />
            <h3 className="text-sm font-bold text-slate-800">新增检验 · {moduleTitle}</h3>
            <span className="px-2 py-0.5 rounded text-[10px] bg-blue-50 text-blue-600 font-mono border border-blue-200">
              {inspectionType}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col min-h-0 flex-1">
          <div className="p-5 overflow-y-auto space-y-4 text-xs">
            {/* 台账业务列（按调用方配置渲染；除服务端必填三项外一律选填） */}
            <div className="grid grid-cols-2 gap-3">
              {fields.map((field) => {
                const isMaterial = field.key === 'materialCode';
                const isInspector = field.key === 'inspectorName';
                const useMaterialSelect = isMaterial && inventoryOptions.length > 0;
                return (
                  <div key={field.key} className={field.fullRow ? 'col-span-2' : ''}>
                    <label className="block font-medium text-slate-700 mb-1">
                      {field.label}
                      {(field.serverRequired || isMaterial) && <span className="text-rose-500"> *</span>}
                    </label>
                    {field.type === 'date' ? (
                      <DateInput
                        value={form[field.key] ?? ''}
                        placeholder={field.placeholder ?? '请选择日期'}
                        onChange={(e) => setForm((prev) => ({ ...prev, [field.key]: e.target.value }))}
                        className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs text-slate-700 focus:outline-none focus:border-blue-500"
                      />
                    ) : field.type === 'select' ? (
                      <select
                        value={form[field.key] ?? ''}
                        onChange={(e) => setForm((prev) => ({ ...prev, [field.key]: e.target.value }))}
                        className={`${inputClass} bg-white`}
                      >
                        <option value="">{field.placeholder ?? '不填写'}</option>
                        {(field.options ?? []).map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    ) : useMaterialSelect ? (
                      <select
                        value={form[field.key] ?? ''}
                        onChange={(e) => handleMaterialCodeChange(e.target.value)}
                        className={`${inputClass} bg-white`}
                      >
                        <option value="">请选择物料编码</option>
                        {inventoryOptions.map((opt) => (
                          <option key={opt.materialCode} value={opt.materialCode}>
                            {opt.materialCode}
                            {opt.materialName ? ` · ${opt.materialName}` : ''}
                          </option>
                        ))}
                      </select>
                    ) : isInspector ? (
                      <select
                        value={form.inspectorName ?? ''}
                        onChange={(e) =>
                          setForm((prev) => ({ ...prev, inspectorName: e.target.value }))
                        }
                        className={`${inputClass} bg-white`}
                      >
                        <option value="">请选择检验人</option>
                        {inspectorOptions.map((opt) => (
                          <option key={opt.id ?? opt.name} value={opt.name}>
                            {opt.name}
                            {opt.employeeCode ? `（${opt.employeeCode}）` : ''}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={field.type === 'number' ? 'number' : 'text'}
                        min={field.type === 'number' ? 0 : undefined}
                        step={field.type === 'number' ? 'any' : undefined}
                        placeholder={field.placeholder ?? ''}
                        value={form[field.key] ?? ''}
                        onChange={(e) => setForm((prev) => ({ ...prev, [field.key]: e.target.value }))}
                        className={inputClass}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            {formError !== '' && (
              <div className="p-2.5 bg-rose-50 border border-rose-200 rounded text-rose-700">{formError}</div>
            )}
            {submitNotice !== '' && (
              <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded text-emerald-700">
                {submitNotice}
              </div>
            )}
          </div>

          <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/50 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-3.5 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-50"
            >
              关闭
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 shadow-sm disabled:bg-slate-300 disabled:cursor-not-allowed"
            >
              {submitting ? '建单中…' : '确认新增'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
