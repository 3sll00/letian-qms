import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw, Search, X, Cog } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { DateInput } from '../../components/common';
import { EQUIPMENT_STATUS_OPTIONS } from '@letian/contracts';
import type { Equipment, Workshop } from '@letian/contracts';

interface EquipmentListResponse {
  total: number;
  page: number;
  pageSize: number;
  items: Equipment[];
  list: Equipment[];
}

interface AppliedFilter {
  page: number;
  keyword: string;
  status: string;
  workshop: string;
}

const PAGE_SIZE = 10;

/** 状态 → 角标配色（未设置 / 未知值统一落灰）；设备领用周转口径：领出/归还/维修/保养/点检 */
const STATUS_BADGE_CLASS: Record<string, string> = {
  '领出': 'bg-amber-100/70 text-amber-700',
  '归还': 'bg-emerald-100/70 text-emerald-700',
  '维修': 'bg-rose-100/70 text-rose-700',
  '保养': 'bg-sky-100/70 text-sky-700',
  '点检': 'bg-violet-100/70 text-violet-700',
};

/** 空字段统一展示灰色占位 */
function TextOrDash({ value }: { value: string | undefined }) {
  if (value === undefined || value === '') {
    return <span className="text-slate-300">-</span>;
  }
  return <>{value}</>;
}

export function EquipmentPage() {
  // 筛选条草稿（点「查询」才提交到 applied）
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState('');
  const [workshop, setWorkshop] = useState('');
  // 已提交的筛选 + 分页状态：变化即触发 loadList
  const [applied, setApplied] = useState<AppliedFilter>({ page: 1, keyword: '', status: '', workshop: '' });

  const [rows, setRows] = useState<Equipment[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 所属车间下拉：生产车间主数据（/master-data/workshops）
  const [workshops, setWorkshops] = useState<Workshop[]>([]);

  // 新增设备弹窗
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  /** 同步防重复提交闸门：state 置位到重渲染之间存在窗口，连点会让两次提交都通过 creating 检查 */
  const creatingRef = useRef(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '',
    model: '',
    factorySerialNo: '',
    equipmentType: '',
    workshop: '',
    status: '',
    purchaseDate: '',
    warrantyPeriod: '',
  });

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const loadList = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<EquipmentListResponse>('/equipments', {
        page: applied.page,
        pageSize: PAGE_SIZE,
        ...(applied.keyword !== '' ? { keyword: applied.keyword } : {}),
        ...(applied.status !== '' ? { status: applied.status } : {}),
        ...(applied.workshop !== '' ? { workshop: applied.workshop } : {}),
      });
      setRows(res.items ?? res.list ?? []);
      setTotal(res.total);
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [applied]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    // 车间下拉选项加载一次；失败不阻断页面（仅下拉为空）
    void (async () => {
      try {
        const list = await api.get<Workshop[]>('/master-data/workshops');
        setWorkshops(list);
      } catch {
        setWorkshops([]);
      }
    })();
  }, []);

  function resetForm() {
    setForm({
      name: '',
      model: '',
      factorySerialNo: '',
      equipmentType: '',
      workshop: '',
      status: '',
      purchaseDate: '',
      warrantyPeriod: '',
    });
    setFormError(null);
  }

  /** 提交后回到第一页看最新建档；若已在第一页则手动刷新 */
  function refetchFromFirstPage() {
    if (applied.page === 1) {
      void loadList();
    } else {
      setApplied((a) => ({ ...a, page: 1 }));
    }
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setFormError(null);
    try {
      const pick = (v: string) => {
        const t = v.trim();
        return t !== '' ? t : undefined;
      };
      await api.post('/equipments', {
        ...(pick(form.name) !== undefined ? { name: pick(form.name) } : {}),
        ...(pick(form.model) !== undefined ? { model: pick(form.model) } : {}),
        ...(pick(form.factorySerialNo) !== undefined ? { factorySerialNo: pick(form.factorySerialNo) } : {}),
        ...(pick(form.equipmentType) !== undefined ? { equipmentType: pick(form.equipmentType) } : {}),
        ...(pick(form.workshop) !== undefined ? { workshop: pick(form.workshop) } : {}),
        ...(pick(form.status) !== undefined ? { status: pick(form.status) } : {}),
        ...(pick(form.purchaseDate) !== undefined ? { purchaseDate: pick(form.purchaseDate) } : {}),
        ...(pick(form.warrantyPeriod) !== undefined ? { warrantyPeriod: pick(form.warrantyPeriod) } : {}),
      });
      setIsCreateOpen(false);
      resetForm();
      refetchFromFirstPage();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const inputClass =
    'w-full border border-slate-300 rounded-lg px-3 py-2 text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-blue-500';

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-base font-bold text-slate-800">检验设备</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            设备台账：编码由系统自动发号（000001 起），其余字段均可选填
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsCreateOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 shadow-sm transition"
          >
            <Plus className="w-3.5 h-3.5" />
            新增设备
          </button>
          <button
            type="button"
            onClick={() => void loadList()}
            disabled={loading}
            className="flex items-center gap-1 px-3 py-1.5 rounded border border-slate-200 bg-white text-slate-700 text-xs font-medium hover:bg-slate-50 shadow-sm"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-blue-600 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </button>
        </div>
      </div>

      {loadError !== null && (
        <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-lg">
          {loadError}
        </div>
      )}

      {/* Filter Bar */}
      <div className="bg-white border border-slate-200/80 rounded-lg shadow-sm p-3 flex items-center gap-3 flex-wrap text-xs">
        <div className="relative w-64">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-2 text-slate-400" />
          <input
            type="text"
            placeholder="编码 / 名称 / 型号 / 出厂序列号 / 设备类型"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            className="border border-slate-200 rounded pl-8 pr-2.5 py-1.5 w-full text-xs text-slate-700 placeholder:text-slate-400 focus:outline-none focus:border-blue-500"
          />
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="border border-slate-200 rounded px-2.5 py-1.5 text-slate-700 focus:outline-none focus:border-blue-500"
        >
          <option value="">全部状态</option>
          {EQUIPMENT_STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={workshop}
          onChange={(e) => setWorkshop(e.target.value)}
          className="border border-slate-200 rounded px-2.5 py-1.5 text-slate-700 focus:outline-none focus:border-blue-500 max-w-[180px]"
        >
          <option value="">全部车间</option>
          {workshops.map((w) => (
            <option key={w.id ?? w.workshopCode} value={w.workshopName}>
              {w.workshopName}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setApplied({ page: 1, keyword: keyword.trim(), status, workshop })}
          className="px-4 py-1.5 rounded bg-blue-600 text-white font-medium hover:bg-blue-700 shadow-sm"
        >
          查询
        </button>
        <button
          type="button"
          onClick={() => {
            setKeyword('');
            setStatus('');
            setWorkshop('');
            setApplied({ page: 1, keyword: '', status: '', workshop: '' });
          }}
          className="px-4 py-1.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium"
        >
          重置
        </button>
      </div>

      {/* Table */}
      <div className="bg-white border border-slate-200/80 rounded-lg shadow-sm overflow-hidden text-xs">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-slate-50/70 border-b border-slate-200/80 text-slate-500 font-medium">
              <th className="py-2.5 px-3">编码</th>
              <th className="py-2.5 px-3">名称</th>
              <th className="py-2.5 px-3">型号</th>
              <th className="py-2.5 px-3">出厂序列号</th>
              <th className="py-2.5 px-3">设备类型</th>
              <th className="py-2.5 px-3">所属车间</th>
              <th className="py-2.5 px-3">状态</th>
              <th className="py-2.5 px-3">采购日期</th>
              <th className="py-2.5 px-3">保修期</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && (
              <tr>
                <td colSpan={9} className="py-10 text-center text-slate-400">加载中...</td>
              </tr>
            )}
            {!loading && loadError !== null && (
              <tr>
                <td colSpan={9} className="py-10 text-center text-rose-500">{loadError}</td>
              </tr>
            )}
            {!loading && loadError === null && rows.length === 0 && (
              <tr>
                <td colSpan={9} className="py-10 text-center text-slate-400">
                  暂无设备，点击右上角「新增设备」建档
                </td>
              </tr>
            )}
            {!loading &&
              rows.map((row) => (
                <tr key={row.equipmentCode} className="hover:bg-blue-50/20 text-slate-700 transition">
                  <td className="py-3 px-3 font-mono font-medium text-slate-800">{row.equipmentCode}</td>
                  <td className="py-3 px-3 font-medium text-slate-800">
                    <TextOrDash value={row.name} />
                  </td>
                  <td className="py-3 px-3">
                    <TextOrDash value={row.model} />
                  </td>
                  <td className="py-3 px-3 font-mono">
                    <TextOrDash value={row.factorySerialNo} />
                  </td>
                  <td className="py-3 px-3">
                    <TextOrDash value={row.equipmentType} />
                  </td>
                  <td className="py-3 px-3">
                    <TextOrDash value={row.workshop} />
                  </td>
                  <td className="py-3 px-3">
                    {row.status !== undefined && row.status !== '' ? (
                      <span
                        className={`px-2 py-0.5 rounded text-[11px] font-medium ${
                          STATUS_BADGE_CLASS[row.status] ?? 'bg-slate-100 text-slate-500'
                        }`}
                      >
                        {row.status}
                      </span>
                    ) : (
                      <span className="text-slate-300">-</span>
                    )}
                  </td>
                  <td className="py-3 px-3 font-mono">
                    <TextOrDash value={row.purchaseDate} />
                  </td>
                  <td className="py-3 px-3">
                    <TextOrDash value={row.warrantyPeriod} />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>

        {/* Pagination */}
        <div className="p-3 border-t border-slate-100 flex items-center justify-end gap-2 text-xs text-slate-500">
          <span>共 {total} 条</span>
          <div className="flex items-center gap-1">
            <button
              className="px-2 py-1 border border-slate-200 rounded disabled:text-slate-300 enabled:hover:bg-slate-50"
              disabled={applied.page <= 1}
              onClick={() => setApplied((a) => ({ ...a, page: a.page - 1 }))}
            >
              &lt;
            </button>
            <span className="px-2.5 py-1 bg-blue-600 text-white rounded font-medium">
              {applied.page} / {totalPages}
            </span>
            <button
              className="px-2 py-1 border border-slate-200 rounded disabled:text-slate-300 enabled:hover:bg-slate-50"
              disabled={applied.page >= totalPages}
              onClick={() => setApplied((a) => ({ ...a, page: a.page + 1 }))}
            >
              &gt;
            </button>
          </div>
        </div>
      </div>

      {/* 新增设备 Modal */}
      {isCreateOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl shadow-2xl w-full max-w-xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 bg-slate-50">
              <div className="flex items-center gap-2">
                <Cog className="w-4 h-4 text-blue-600" />
                <h3 className="font-bold text-sm text-slate-800">新增设备</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsCreateOpen(false)}
                className="text-slate-400 hover:text-slate-600 transition p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreate} className="p-5 space-y-4 text-xs">
              <div className="rounded-lg bg-blue-50/60 border border-blue-100 px-3 py-2 text-[11px] text-blue-700">
                编码由系统自动生成（6 位顺序码，从 000001 开始），无需填写；以下字段均为选填。
              </div>
              {formError !== null && (
                <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-rose-700">
                  {formError}
                </div>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">名称</label>
                  <input
                    type="text"
                    placeholder="例如：网带炉"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">型号</label>
                  <input
                    type="text"
                    placeholder="例如：RW-80"
                    value={form.model}
                    onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">出厂序列号</label>
                  <input
                    type="text"
                    placeholder="设备铭牌序列号"
                    value={form.factorySerialNo}
                    onChange={(e) => setForm((f) => ({ ...f, factorySerialNo: e.target.value }))}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">设备类型</label>
                  <input
                    type="text"
                    placeholder="例如：热处理设备 / 检测设备"
                    value={form.equipmentType}
                    onChange={(e) => setForm((f) => ({ ...f, equipmentType: e.target.value }))}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">所属车间</label>
                  <select
                    value={form.workshop}
                    onChange={(e) => setForm((f) => ({ ...f, workshop: e.target.value }))}
                    className={inputClass}
                  >
                    <option value="">不指定</option>
                    {workshops.map((w) => (
                      <option key={w.id ?? w.workshopCode} value={w.workshopName}>
                        {w.workshopName}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">状态</label>
                  <select
                    value={form.status}
                    onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}
                    className={inputClass}
                  >
                    <option value="">不设置</option>
                    {EQUIPMENT_STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">采购日期</label>
                  <DateInput
                    value={form.purchaseDate}
                    onChange={(e) => setForm((f) => ({ ...f, purchaseDate: e.target.value }))}
                    placeholder="请选择采购日期"
                    className="border border-slate-300 rounded-lg px-3 py-2 text-slate-800 focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">保修期</label>
                  <input
                    type="text"
                    placeholder="例如：12个月 或 2027-12-31"
                    value={form.warrantyPeriod}
                    onChange={(e) => setForm((f) => ({ ...f, warrantyPeriod: e.target.value }))}
                    className={inputClass}
                  />
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsCreateOpen(false)}
                  className="px-3.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium transition"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="px-4 py-1.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 transition shadow-sm disabled:opacity-50"
                >
                  {creating ? '保存中...' : '确认新增'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
