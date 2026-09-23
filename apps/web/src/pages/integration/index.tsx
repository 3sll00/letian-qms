import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Upload,
  Plus,
  Search,
  X,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  Pencil,
  Eye,
  Copy,
  Trash2,
} from 'lucide-react';
import type {
  MaterialPermission,
  Role,
  PermissionCheckResponse,
  AuthorizationLog,
} from '@letian/contracts';
import {
  api,
  fetchAuthUsers,
  errorMessage,
  type AuthUserOption,
} from '../../lib/api';
import logIc1 from '../../assets/log_ic1.png';
import logIc2 from '../../assets/log_ic2.png';
import logIc3 from '../../assets/log_ic3.png';
import logIc4 from '../../assets/log_ic4.png';

interface IntegrationProps {
  initialTab?: 'permissions' | 'logs';
}

export function IntegrationPage({ initialTab = 'permissions' }: IntegrationProps) {
  const [tab, setTab] = useState<'permissions' | 'logs'>(initialTab);

  React.useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  if (tab === 'logs') {
    return <OperationLogsView />;
  }

  return <MaterialPermissionsView />;
}

// ==================================================================
// 公共类型与工具
// ==================================================================

interface PageResult<T> {
  total: number;
  page: number;
  pageSize: number;
  items: T[];
}

interface OptionItem {
  value: string;
  label: string;
}

/** 列表页的三维文本：空数组或含 '*' 显示「全部」 */
function dimsText(list: readonly string[]): string {
  if (list.length === 0 || list.includes('*')) return '全部';
  return list.join(', ');
}

function shortUserId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}


// ==================================================================
// 三维多选标签编辑器（编辑弹窗 / 按角色批量配置共用）
// ==================================================================

interface TagSelectProps {
  label: string;
  options: OptionItem[];
  value: string[];
  onChange: (next: string[]) => void;
}

function TagSelect({ label, options, value, onChange }: TagSelectProps) {
  const [draft, setDraft] = useState('');

  const available = useMemo(
    () => options.filter((o) => !value.includes(o.value)),
    [options, value]
  );

  function add(item: string) {
    const text = item.trim();
    if (text === '' || value.includes(text)) return;
    onChange([...value, text]);
    setDraft('');
  }

  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium text-slate-600">{label}</div>
      <div className="min-h-[34px] border border-slate-200 rounded px-2 py-1.5 flex flex-wrap items-center gap-1.5 bg-white focus-within:border-blue-500">
        {value.length === 0 && (
          <span className="text-[11px] text-slate-400">未选择 = 不限（全部可见）</span>
        )}
        {value.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-[11px] font-medium border border-blue-100"
          >
            {options.find((o) => o.value === tag)?.label ?? tag}
            <button
              type="button"
              onClick={() => onChange(value.filter((v) => v !== tag))}
              className="text-blue-400 hover:text-blue-700"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        <select
          value=""
          onChange={(e) => e.target.value !== '' && add(e.target.value)}
          className="text-[11px] text-slate-500 outline-none bg-transparent min-w-[90px]"
        >
          <option value="">+ 从列表选择</option>
          <option value="*">全部（* 通配）</option>
          {available.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(draft);
            }
          }}
          placeholder="输入编码后回车添加（支持不在列表中的编码）"
          className="flex-1 border border-slate-200 rounded px-2 py-1 text-[11px] text-slate-700 focus:outline-none focus:border-blue-500"
        />
        <button
          type="button"
          onClick={() => add(draft)}
          disabled={draft.trim() === ''}
          className="px-2.5 py-1 rounded border border-slate-200 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-40"
        >
          添加
        </button>
      </div>
    </div>
  );
}

// ==================================================================
// 编辑 / 新增 / 复制 权限规则弹窗
// ==================================================================

interface RuleModalProps {
  mode: 'create' | 'edit' | 'copy';
  /** edit/copy 时的原规则 */
  rule: MaterialPermission | null;
  employees: AuthUserOption[];
  roles: Role[];
  materialOptions: OptionItem[];
  categoryOptions: OptionItem[];
  supplierOptions: OptionItem[];
  onClose: () => void;
  onSaved: () => void;
}

function RuleEditorModal({
  mode,
  rule,
  employees,
  roles,
  materialOptions,
  categoryOptions,
  supplierOptions,
  onClose,
  onSaved,
}: RuleModalProps) {
  const [userId, setUserId] = useState(rule?.userId ?? employees[0]?.id ?? '');
  const [roleCode, setRoleCode] = useState(rule?.roleCode ?? roles[0]?.roleCode ?? '');
  const [categories, setCategories] = useState<string[]>(rule?.materialCategories ?? []);
  const [codes, setCodes] = useState<string[]>(rule?.materialCodes ?? []);
  const [suppliers, setSuppliers] = useState<string[]>(rule?.supplierCodes ?? []);
  const [isActive, setIsActive] = useState(rule?.isActive ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const title = mode === 'create' ? '新增权限配置' : mode === 'edit' ? '编辑权限配置' : '复制权限配置';

  async function handleSave() {
    if (userId === '' || roleCode === '') {
      setError('请选择用户与角色');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // 用户姓名是 material_permissions.user_name 的展示快照，编辑路径同样回传，
      // 保证「新增 / 编辑」两条链路的提交字段集合与后端契约完全一致。
      const userName = rule?.userName ?? employees.find((e) => e.id === userId)?.name;
      const body = {
        userId,
        ...(userName !== undefined ? { userName } : {}),
        roleCode,
        materialCategories: categories,
        materialCodes: codes,
        supplierCodes: suppliers,
        isActive,
      };
      if (mode === 'edit' && rule !== null && rule.id !== undefined) {
        await api.put<MaterialPermission>(`/permissions/materials/${rule.id}`, body);
      } else {
        await api.post<MaterialPermission>('/permissions/materials', body);
      }
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full p-6 space-y-4 max-h-[88vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-slate-200 pb-3">
          <h3 className="text-sm font-bold text-slate-800">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        {mode === 'copy' && rule !== null && (
          <div className="rounded bg-amber-50 border border-amber-200/60 px-3 py-2 text-[11px] text-amber-800">
            复制自 {rule.userName}（{rule.roleCode}）的规则，保存前请确认目标用户与角色组合未重复。
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 text-xs">
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium text-slate-600">用户</div>
            <select
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              disabled={mode === 'edit'}
              className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-slate-700 bg-white focus:outline-none focus:border-blue-500 disabled:bg-slate-50 disabled:text-slate-400"
            >
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}（{e.employeeCode ?? e.id.slice(0, 8)}）
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium text-slate-600">角色</div>
            <select
              value={roleCode}
              onChange={(e) => setRoleCode(e.target.value)}
              disabled={mode === 'edit'}
              className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-slate-700 bg-white focus:outline-none focus:border-blue-500 disabled:bg-slate-50 disabled:text-slate-400"
            >
              {roles.map((r) => (
                <option key={r.roleCode} value={r.roleCode}>
                  {r.roleName}（{r.roleCode}）
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-3.5">
          <TagSelect label="物料分类权限（维度一）" options={categoryOptions} value={categories} onChange={setCategories} />
          <TagSelect label="物料编码权限（维度二）" options={materialOptions} value={codes} onChange={setCodes} />
          <TagSelect label="供应商权限（维度三）" options={supplierOptions} value={suppliers} onChange={setSuppliers} />
        </div>

        <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            className="rounded border-slate-300 text-blue-600"
          />
          启用该规则（停用后该规则立即失去数据访问权，用于临时禁用而非删除）
        </label>

        {error && (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded border border-slate-200 text-xs text-slate-600 hover:bg-slate-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="px-4 py-1.5 rounded bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-60 shadow-sm"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ==================================================================
// 1. 物料权限管理 (WPS图片(20)) —— 前后端真实对接
// ==================================================================

function MaterialPermissionsView() {
  const [activeTab, setActiveTab] = useState<'users' | 'roles' | 'authlogs'>('users');

  // ---- 共享下拉数据源（首次挂载加载一次） ----
  const [employees, setEmployees] = useState<AuthUserOption[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [materialOptions, setMaterialOptions] = useState<OptionItem[]>([]);
  const [categoryOptions, setCategoryOptions] = useState<OptionItem[]>([]);
  const [supplierOptions, setSupplierOptions] = useState<OptionItem[]>([]);

  // ---- 列表状态 ----
  const [filterUserName, setFilterUserName] = useState('');
  const [filterRole, setFilterRole] = useState('');
  const [filterMatCode, setFilterMatCode] = useState('');
  const [applied, setApplied] = useState<{ userName: string; roleCode: string; materialCode: string; page: number }>({
    userName: '',
    roleCode: '',
    materialCode: '',
    page: 1,
  });
  const pageSize = 10;
  const [rows, setRows] = useState<MaterialPermission[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ---- 弹窗状态 ----
  const [modal, setModal] = useState<
    | null
    | { mode: 'create' | 'edit' | 'copy'; rule: MaterialPermission | null }
  >(null);

  // ---- 权限校验工具 ----
  const [checkUserId, setCheckUserId] = useState('');
  const [checkMatCode, setCheckMatCode] = useState('');
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<PermissionCheckResponse | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  // ---- 批量导入 ----
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importSummary, setImportSummary] = useState<string | null>(null);

  const roleNameByCode = useMemo(() => new Map(roles.map((r) => [r.roleCode, r.roleName])), [roles]);

  // 初始数据源
  useEffect(() => {
    void (async () => {
      try {
        const [userList, roleList, materials, suppliers] = await Promise.all([
          fetchAuthUsers(),
          api.get<readonly Role[]>('/permissions/roles'),
          api.get<readonly { materialCode: string; materialName: string; categoryCode: string; categoryName: string }[]>('/master-data/inventory'),
          api.get<readonly { supplierCode: string; supplierName: string }[]>('/master-data/suppliers'),
        ]);
        setEmployees(userList);
        setRoles([...roleList]);
        setMaterialOptions(
          materials.map((m) => ({ value: m.materialCode, label: `${m.materialCode} · ${m.materialName}` }))
        );
        const categoryMap = new Map<string, string>();
        for (const m of materials) {
          if (!categoryMap.has(m.categoryCode)) {
            categoryMap.set(m.categoryCode, m.categoryName || m.categoryCode);
          }
        }
        setCategoryOptions([...categoryMap.entries()].map(([code, name]) => ({ value: code, label: `${code} · ${name}` })));
        setSupplierOptions(suppliers.map((s) => ({ value: s.supplierCode, label: `${s.supplierCode} · ${s.supplierName}` })));
      } catch (err) {
        setLoadError(errorMessage(err));
      }
    })();
  }, []);

  const loadList = useCallback(async (q: { userName: string; roleCode: string; materialCode: string; page: number }) => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<PageResult<MaterialPermission>>('/permissions/materials', {
        page: q.page,
        pageSize,
        userName: q.userName || undefined,
        roleCode: q.roleCode || undefined,
        materialCode: q.materialCode || undefined,
      });
      setRows(res.items);
      setTotal(res.total);
    } catch (err) {
      setLoadError(errorMessage(err));
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'users') {
      void loadList(applied);
    }
  }, [activeTab, applied, loadList]);

  function handleSearch() {
    setApplied({
      userName: filterUserName.trim(),
      roleCode: filterRole,
      materialCode: filterMatCode.trim(),
      page: 1,
    });
  }

  function handleReset() {
    setFilterUserName('');
    setFilterRole('');
    setFilterMatCode('');
    setApplied({ userName: '', roleCode: '', materialCode: '', page: 1 });
  }

  async function handleToggleActive(rule: MaterialPermission) {
    try {
      await api.put<MaterialPermission>(`/permissions/materials/${rule.id}`, {
        userId: rule.userId,
        userName: rule.userName,
        roleCode: rule.roleCode,
        materialCategories: rule.materialCategories,
        materialCodes: rule.materialCodes,
        supplierCodes: rule.supplierCodes,
        isActive: !(rule.isActive ?? true),
      });
      void loadList(applied);
    } catch (err) {
      window.alert(`切换状态失败: ${errorMessage(err)}`);
    }
  }

  async function handleDelete(rule: MaterialPermission) {
    if (!window.confirm(`确认删除 ${rule.userName}（${rule.roleCode}）的权限规则？删除后该用户在此角色下将看不到任何数据。`)) {
      return;
    }
    try {
      await api.del(`/permissions/materials/${rule.id}`);
      void loadList(applied);
    } catch (err) {
      window.alert(`删除失败: ${errorMessage(err)}`);
    }
  }

  async function handleCheck() {
    if (checkUserId === '' || checkMatCode.trim() === '') {
      setCheckError('请选择用户并输入物料编码');
      return;
    }
    setChecking(true);
    setCheckError(null);
    setCheckResult(null);
    try {
      const res = await api.post<PermissionCheckResponse>('/permissions/check', {
        userId: checkUserId,
        materialCode: checkMatCode.trim(),
      });
      setCheckResult(res);
    } catch (err) {
      setCheckError(errorMessage(err));
    } finally {
      setChecking(false);
    }
  }

  /**
   * CSV 批量导入：每行 `用户姓名,角色编码,分类1|分类2,编码1|编码2,供应商1|供应商2`
   * 空维度或 `*` 表示通配；姓名须存在于职员档案。
   */
  async function handleImportFile(file: File) {
    const text = await file.text();
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '' && !/^用户|^user/i.test(l));
    const failures: string[] = [];
    let successCount = 0;
    for (const line of lines) {
      const cols = line.split(',').map((c) => c.trim());
      const [name, roleCode, cats = '', codes = '', sups = ''] = cols;
      const emp = employees.find((e) => e.name === name);
      if (emp === undefined || roleCode === undefined || roleCode === '') {
        failures.push(`${line} → 用户 [${name ?? ''}] 不在职员档案或角色为空`);
        continue;
      }
      const splitDim = (v: string) => (v === '' || v === '*' ? (v === '*' ? ['*'] : []) : v.split('|'));
      try {
        await api.post<MaterialPermission>('/permissions/materials', {
          userId: emp.id,
          roleCode,
          materialCategories: splitDim(cats),
          materialCodes: splitDim(codes),
          supplierCodes: splitDim(sups),
          isActive: true,
        });
        successCount += 1;
      } catch (err) {
        failures.push(`${line} → ${errorMessage(err)}`);
      }
    }
    setImportSummary(
      `批量导入完成：成功 ${successCount} 条` +
        (failures.length > 0 ? `，失败 ${failures.length} 条：\n${failures.join('\n')}` : '')
    );
    void loadList(applied);
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-base font-bold text-slate-800">物料权限管理</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            用户只能查看自己有权限的物料数据 · 权限维度: 物料编码 / 物料分类 / 供应商
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file !== undefined) {
                void handleImportFile(file);
              }
              e.target.value = '';
            }}
          />
          <button
            type="button"
            title="CSV 格式：用户姓名,角色编码,分类(多个用|分隔),物料编码(多个用|分隔),供应商(多个用|分隔)；留空或 * 表示全部"
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1 px-3 py-1.5 rounded border border-slate-200 bg-white text-slate-700 text-xs font-medium hover:bg-slate-50 shadow-sm"
          >
            <Upload className="w-3.5 h-3.5 text-blue-600" />
            批量导入
          </button>
          <button
            type="button"
            onClick={() => setModal({ mode: 'create', rule: null })}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 shadow-sm"
          >
            <Plus className="w-3.5 h-3.5" />
            + 新增权限配置
          </button>
        </div>
      </div>

      {importSummary && (
        <div className="bg-sky-50 border border-sky-200/70 rounded-md px-3.5 py-2 text-xs text-sky-800 whitespace-pre-line flex items-start justify-between gap-3">
          <span>{importSummary}</span>
          <button onClick={() => setImportSummary(null)} className="text-sky-400 hover:text-sky-700 shrink-0">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Yellow Tip Banner */}
      <div className="bg-amber-50/60 border border-amber-200/60 rounded-md px-3.5 py-2 text-xs text-amber-800 flex items-center gap-2">
        <span className="text-amber-500">🔒</span>
        <span>权限过滤逻辑: 所有查询接口在数据访问层自动追加物料权限过滤条件，用户只能看见自己有权限的物料相关检验数据。</span>
      </div>

      {/* Tabs */}
      <div className="border-b border-slate-200 flex gap-6 text-xs font-medium">
        {(
          [
            ['users', '用户权限列表'],
            ['roles', '按角色批量配置'],
            ['authlogs', '权限校验日志'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`pb-2 transition ${
              activeTab === key
                ? 'text-blue-600 border-b-2 border-blue-600 font-semibold'
                : 'text-slate-600 hover:text-slate-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'users' && (
        <>
          {/* Filter Bar */}
          <div className="bg-white border border-slate-200/80 rounded-lg p-3.5 shadow-sm flex flex-wrap items-center gap-4 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-slate-600 font-medium">用户姓名</span>
              <input
                type="text"
                value={filterUserName}
                onChange={(e) => setFilterUserName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                className="border border-slate-200 rounded px-2.5 py-1.5 w-32 text-slate-700 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div className="flex items-center gap-2">
              <span className="text-slate-600 font-medium">角色</span>
              <select
                value={filterRole}
                onChange={(e) => setFilterRole(e.target.value)}
                className="border border-slate-200 rounded px-2.5 py-1.5 w-36 text-slate-700 focus:outline-none focus:border-blue-500 bg-white"
              >
                <option value="">全部</option>
                {roles.map((r) => (
                  <option key={r.roleCode} value={r.roleCode}>
                    {r.roleName}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-slate-600 font-medium">物料编码</span>
              <input
                type="text"
                value={filterMatCode}
                onChange={(e) => setFilterMatCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                className="border border-slate-200 rounded px-2.5 py-1.5 w-36 text-slate-700 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={handleReset}
                className="px-3.5 py-1.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50"
              >
                重置
              </button>
              <button
                type="button"
                onClick={handleSearch}
                className="px-4 py-1.5 rounded bg-blue-600 text-white font-medium hover:bg-blue-700 shadow-sm"
              >
                查询
              </button>
            </div>
          </div>

          {/* Table */}
          <div className="bg-white border border-slate-200/80 rounded-lg shadow-sm overflow-hidden text-xs">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50/70 border-b border-slate-200/80 text-slate-500 font-medium">
                  <th className="py-2.5 px-3">用户姓名</th>
                  <th className="py-2.5 px-3">用户ID</th>
                  <th className="py-2.5 px-3">角色</th>
                  <th className="py-2.5 px-3">物料编码权限</th>
                  <th className="py-2.5 px-3">物料分类权限</th>
                  <th className="py-2.5 px-3">供应商权限</th>
                  <th className="py-2.5 px-3">状态</th>
                  <th className="py-2.5 px-3 text-center">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading && (
                  <tr>
                    <td colSpan={8} className="py-10 text-center text-slate-400">加载中...</td>
                  </tr>
                )}
                {!loading && loadError !== null && (
                  <tr>
                    <td colSpan={8} className="py-10 text-center text-rose-500">{loadError}</td>
                  </tr>
                )}
                {!loading && loadError === null && rows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="py-10 text-center text-slate-400">
                      暂无匹配的权限规则，点击右上角「+ 新增权限配置」创建
                    </td>
                  </tr>
                )}
                {!loading &&
                  rows.map((row) => (
                    <tr key={row.id} className="hover:bg-blue-50/20 text-slate-700 transition">
                      <td className="py-3 px-3 font-medium text-slate-800">{row.userName}</td>
                      <td className="py-3 px-3 text-slate-400 font-mono" title={row.userId}>
                        {shortUserId(row.userId)}
                      </td>
                      <td className="py-3 px-3">
                        <span className="px-2 py-0.5 rounded text-[11px] bg-sky-100/70 text-sky-700 font-medium">
                          {roleNameByCode.get(row.roleCode) ?? row.roleCode}
                        </span>
                      </td>
                      <td className="py-3 px-3 font-mono">{dimsText(row.materialCodes)}</td>
                      <td className="py-3 px-3">{dimsText(row.materialCategories)}</td>
                      <td className="py-3 px-3">{dimsText(row.supplierCodes)}</td>
                      <td className="py-3 px-3">
                        <button
                          type="button"
                          onClick={() => void handleToggleActive(row)}
                          title="点击切换启用 / 停用"
                          className={`relative inline-flex h-4.5 w-9 items-center rounded-full transition-colors ${
                            (row.isActive ?? true) ? 'bg-emerald-500' : 'bg-slate-300'
                          }`}
                        >
                          <span
                            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                              (row.isActive ?? true) ? 'translate-x-[18px]' : 'translate-x-[3px]'
                            }`}
                          />
                        </button>
                      </td>
                      <td className="py-3 px-3 text-center">
                        <div className="flex items-center justify-center gap-2.5">
                          <button
                            className="text-blue-600 hover:text-blue-700 inline-flex items-center gap-0.5"
                            onClick={() => setModal({ mode: 'edit', rule: row })}
                          >
                            <Pencil className="w-3 h-3" /> 编辑
                          </button>
                          <button
                            className="text-amber-600 hover:text-amber-700 inline-flex items-center gap-0.5"
                            onClick={() => setModal({ mode: 'copy', rule: row })}
                          >
                            <Copy className="w-3 h-3" /> 复制
                          </button>
                          <button
                            className="text-rose-500 hover:text-rose-600 inline-flex items-center gap-0.5"
                            onClick={() => void handleDelete(row)}
                          >
                            <Trash2 className="w-3 h-3" /> 删除
                          </button>
                        </div>
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
                <span className="px-2.5 py-1 bg-blue-600 text-white rounded font-medium">{applied.page} / {totalPages}</span>
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
        </>
      )}

      {activeTab === 'roles' && (
        <RoleBatchView
          roles={roles}
          materialOptions={materialOptions}
          categoryOptions={categoryOptions}
          supplierOptions={supplierOptions}
          onApplied={() => {
            setActiveTab('users');
            setApplied((a) => ({ ...a, page: 1 }));
          }}
        />
      )}

      {activeTab === 'authlogs' && <AuthLogsView employees={employees} />}

      {/* Bottom Tool：权限校验工具 */}
      <div className="bg-white border border-slate-200/80 rounded-lg p-3.5 shadow-sm text-xs space-y-2.5">
        <div className="flex items-center gap-2 text-slate-700 font-medium">
          <Search className="w-3.5 h-3.5 text-blue-600" />
          权限校验工具
          <span className="font-normal text-slate-400">— 校验某用户对某物料是否有数据访问权（与运行时过滤同一口径）</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={checkUserId}
            onChange={(e) => setCheckUserId(e.target.value)}
            className="border border-slate-200 rounded px-2.5 py-1.5 text-slate-700 bg-white focus:outline-none focus:border-blue-500"
          >
            <option value="">选择用户</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}（{e.employeeCode ?? e.roleCode ?? ''}）
              </option>
            ))}
          </select>
          <input
            type="text"
            value={checkMatCode}
            onChange={(e) => setCheckMatCode(e.target.value)}
            placeholder="输入物料编码，如 MAT-304SS-05"
            className="border border-slate-200 rounded px-2.5 py-1.5 w-52 text-slate-700 focus:outline-none focus:border-blue-500"
          />
          <button
            type="button"
            onClick={() => void handleCheck()}
            disabled={checking}
            className="px-4 py-1.5 rounded bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-60 shadow-sm"
          >
            {checking ? '校验中...' : '开始校验'}
          </button>
          {checkError && <span className="text-rose-500">{checkError}</span>}
        </div>
        {checkResult && (
          <div
            className={`rounded border px-3 py-2 flex items-start gap-2 ${
              checkResult.allowed
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : 'border-rose-200 bg-rose-50 text-rose-800'
            }`}
          >
            {checkResult.allowed ? (
              <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5" />
            ) : (
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
            )}
            <div className="space-y-0.5">
              <p className="font-medium">{checkResult.message}</p>
              {checkResult.matchedRule !== null && (
                <p className="text-[11px] opacity-80">
                  命中规则：角色 [{checkResult.matchedRule.roleCode}] · 分类 {dimsText(checkResult.matchedRule.materialCategories)} · 编码 {dimsText(checkResult.matchedRule.materialCodes)} · 供应商 {dimsText(checkResult.matchedRule.supplierCodes)}
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Edit/Create/Copy Modal */}
      {modal !== null && (
        <RuleEditorModal
          mode={modal.mode}
          rule={modal.rule}
          employees={employees}
          roles={roles}
          materialOptions={materialOptions}
          categoryOptions={categoryOptions}
          supplierOptions={supplierOptions}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            void loadList(applied);
          }}
        />
      )}
    </div>
  );
}

// ==================================================================
// 按角色批量配置
// ==================================================================

interface RoleBatchViewProps {
  roles: Role[];
  materialOptions: OptionItem[];
  categoryOptions: OptionItem[];
  supplierOptions: OptionItem[];
  onApplied: () => void;
}

function RoleBatchView({ roles, materialOptions, categoryOptions, supplierOptions, onApplied }: RoleBatchViewProps) {
  const [roleCode, setRoleCode] = useState(roles[0]?.roleCode ?? '');
  const [categories, setCategories] = useState<string[]>([]);
  const [codes, setCodes] = useState<string[]>([]);
  const [suppliers, setSuppliers] = useState<string[]>([]);
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (roleCode === '' && roles.length > 0) {
      setRoleCode(roles[0]?.roleCode ?? '');
    }
  }, [roles, roleCode]);

  async function handleApply() {
    if (roleCode === '') return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await api.post<{ message: string; affectedCount: number }>('/permissions/apply-role', {
        roleCode,
        materialCategories: categories,
        materialCodes: codes,
        supplierCodes: suppliers,
        isActive,
      });
      setMessage({ ok: true, text: res.message });
      // 应用成功后切回用户列表查看效果
      setTimeout(onApplied, 800);
    } catch (err) {
      setMessage({ ok: false, text: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  if (roles.length === 0) {
    return (
      <div className="bg-white border border-slate-200/80 rounded-lg p-8 shadow-sm text-xs text-slate-400 text-center">
        角色字典加载中或为空
      </div>
    );
  }

  return (
    <div className="bg-white border border-slate-200/80 rounded-lg p-5 shadow-sm text-xs space-y-4">
      <div>
        <h3 className="text-sm font-bold text-slate-800">按角色批量配置</h3>
        <p className="text-slate-400 mt-0.5">
          选定角色后统一改写该角色下所有用户规则的三维权限；与个体配置冲突时，以「任一规则命中即放行」的 OR 语义合并。
        </p>
      </div>

      <div className="max-w-sm space-y-1.5">
        <div className="text-[11px] font-medium text-slate-600">目标角色</div>
        <select
          value={roleCode}
          onChange={(e) => setRoleCode(e.target.value)}
          className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-slate-700 bg-white focus:outline-none focus:border-blue-500"
        >
          {roles.map((r) => (
            <option key={r.roleCode} value={r.roleCode}>
              {r.roleName}（{r.roleCode}）
            </option>
          ))}
        </select>
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        <TagSelect label="物料分类权限" options={categoryOptions} value={categories} onChange={setCategories} />
        <TagSelect label="物料编码权限" options={materialOptions} value={codes} onChange={setCodes} />
        <TagSelect label="供应商权限" options={supplierOptions} value={suppliers} onChange={setSuppliers} />
      </div>

      <label className="flex items-center gap-2 text-slate-700 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
          className="rounded border-slate-300 text-blue-600"
        />
        应用后置为启用状态
      </label>

      {message && (
        <div
          className={`rounded border px-3 py-2 ${
            message.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-800'
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void handleApply()}
          disabled={saving || roleCode === ''}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-60 shadow-sm"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${saving ? 'animate-spin' : ''}`} />
          {saving ? '应用中...' : '应用到该角色全部用户'}
        </button>
      </div>
    </div>
  );
}

// ==================================================================
// 权限校验日志
// ==================================================================

function AuthLogsView({ employees }: { employees: AuthUserOption[] }) {
  const [filterUser, setFilterUser] = useState('');
  const [filterDecision, setFilterDecision] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 10;

  const [logs, setLogs] = useState<AuthorizationLog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const userNameById = useMemo(() => new Map(employees.map((e) => [e.id, e.name])), [employees]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.get<PageResult<AuthorizationLog>>('/permissions/logs', {
          page,
          pageSize,
          userId: filterUser || undefined,
          decision: filterDecision || undefined,
        });
        if (!cancelled) {
          setLogs(res.items);
          setTotal(res.total);
        }
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [page, filterUser, filterDecision]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="bg-white border border-slate-200/80 rounded-lg shadow-sm overflow-hidden text-xs">
      <div className="p-3.5 border-b border-slate-100 flex flex-wrap items-center gap-4">
        <span className="font-medium text-slate-700">权限校验日志</span>
        <span className="text-slate-400">记录每次敏感数据查询的行级过滤与拦截（PRD 要求保留 ≥180 天）</span>
        <div className="ml-auto flex items-center gap-2">
          <select
            value={filterUser}
            onChange={(e) => {
              setFilterUser(e.target.value);
              setPage(1);
            }}
            className="border border-slate-200 rounded px-2 py-1.5 bg-white text-slate-700 focus:outline-none focus:border-blue-500"
          >
            <option value="">全部用户</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <select
            value={filterDecision}
            onChange={(e) => {
              setFilterDecision(e.target.value);
              setPage(1);
            }}
            className="border border-slate-200 rounded px-2 py-1.5 bg-white text-slate-700 focus:outline-none focus:border-blue-500"
          >
            <option value="">全部结果</option>
            <option value="ALLOWED">放行</option>
            <option value="DENIED">拦截</option>
          </select>
        </div>
      </div>

      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="bg-slate-50/70 border-b border-slate-200/80 text-slate-500 font-medium">
            <th className="py-2.5 px-3">时间</th>
            <th className="py-2.5 px-3">用户</th>
            <th className="py-2.5 px-3">资源</th>
            <th className="py-2.5 px-3">动作</th>
            <th className="py-2.5 px-3">结果</th>
            <th className="py-2.5 px-3">明细</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {loading && (
            <tr>
              <td colSpan={6} className="py-10 text-center text-slate-400">加载中...</td>
            </tr>
          )}
          {!loading && error !== null && (
            <tr>
              <td colSpan={6} className="py-10 text-center text-rose-500">{error}</td>
            </tr>
          )}
          {!loading && error === null && logs.length === 0 && (
            <tr>
              <td colSpan={6} className="py-10 text-center text-slate-400">
                暂无校验日志（全量通配用户的查询不产生噪音记录）
              </td>
            </tr>
          )}
          {!loading &&
            logs.map((log) => (
              <tr key={log.id} className="hover:bg-blue-50/20 text-slate-700 transition">
                <td className="py-2.5 px-3 font-mono text-slate-500">{log.createdAt?.replace('T', ' ').slice(0, 19)}</td>
                <td className="py-2.5 px-3 font-medium text-slate-800">
                  {log.userName || userNameById.get(log.userId) || shortUserId(log.userId)}
                </td>
                <td className="py-2.5 px-3 text-slate-600">
                  {log.resourceType}
                  {log.materialCode ? ` · ${log.materialCode}` : ''}
                  {log.resourceId ? ` · ${shortUserId(log.resourceId)}` : ''}
                </td>
                <td className="py-2.5 px-3">
                  <span className="px-2 py-0.5 rounded text-[11px] bg-sky-100/70 text-sky-700 font-mono">{log.action}</span>
                </td>
                <td className="py-2.5 px-3">
                  <span
                    className={`px-2 py-0.5 rounded text-[11px] font-medium ${
                      log.decision === 'ALLOWED' ? 'bg-emerald-100/70 text-emerald-700' : 'bg-rose-100/70 text-rose-700'
                    }`}
                  >
                    {log.decision === 'ALLOWED' ? '放行' : '拦截'}
                  </span>
                </td>
                <td className="py-2.5 px-3 text-slate-500 max-w-[320px] truncate" title={log.detail}>
                  {log.detail ?? '-'}
                </td>
              </tr>
            ))}
        </tbody>
      </table>

      <div className="p-3 border-t border-slate-100 flex items-center justify-end gap-2 text-slate-500">
        <span>共 {total} 条</span>
        <div className="flex items-center gap-1">
          <button
            className="px-2 py-1 border border-slate-200 rounded disabled:text-slate-300 enabled:hover:bg-slate-50"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            &lt;
          </button>
          <span className="px-2.5 py-1 bg-blue-600 text-white rounded font-medium">{page} / {totalPages}</span>
          <button
            className="px-2 py-1 border border-slate-200 rounded disabled:text-slate-300 enabled:hover:bg-slate-50"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            &gt;
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// ------------------------------------------------------------------
// 2. 操作日志 (真实审计日志与统计驱动)
// ------------------------------------------------------------------

interface AuditLogItem {
  id: string;
  traceId?: string;
  userId: string;
  userName: string;
  action: string;
  resourceType: string;
  resourceId: string;
  status: 'SUCCESS' | 'REJECTED' | 'FAILED';
  detail?: string;
  diffPatch?: Record<string, unknown>;
  ip?: string;
  createdAt: string;
}

interface AuditStatsData {
  totalLogs: number;
  successCount: number;
  failedCount: number;
  todayCount: number;
}

const ACTION_LABELS: Record<string, { label: string; color: string }> = {
  CREATE: { label: '新增创建', color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  UPDATE: { label: '属性更新', color: 'bg-blue-50 text-blue-700 border-blue-200' },
  STATUS_CHANGE: { label: '状态流转', color: 'bg-purple-50 text-purple-700 border-purple-200' },
  DISPOSE: { label: '评审处置', color: 'bg-amber-50 text-amber-700 border-amber-200' },
  GATE_BLOCKED: { label: '卡口阻断', color: 'bg-rose-50 text-rose-700 border-rose-200' },
  AUTH_FAILED: { label: '越权拒绝', color: 'bg-red-50 text-red-700 border-red-200' },
  VALIDATION_REJECTED: { label: '校验失败', color: 'bg-orange-50 text-orange-700 border-orange-200' },
  SYNC_TRIGGER: { label: '触发同步', color: 'bg-sky-50 text-sky-700 border-sky-200' },
};

const RESOURCE_TYPE_LABELS: Record<string, string> = {
  INSPECTION_ORDER: '检验工单',
  INSPECTION_PLAN: '质检方案',
  MRB_REVIEW: 'MRB 评审',
  MATERIAL_PERMISSION: '物料权限',
  BATCH_TRACE: '批次追溯',
  RELEASE_GATE: '放行卡口',
  INTEGRATION: 'ERP/MES 同步',
};

function OperationLogsView() {
  const [resourceType, setResourceType] = useState('全部');
  const [action, setAction] = useState('全部');
  const [status, setStatus] = useState('全部');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(15);

  const [stats, setStats] = useState<AuditStatsData>({
    totalLogs: 0,
    successCount: 0,
    failedCount: 0,
    todayCount: 0,
  });

  const [logs, setLogs] = useState<AuditLogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedLogForDiff, setSelectedLogForDiff] = useState<AuditLogItem | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      const res = await api.get<AuditStatsData>('/audit/stats');
      setStats(res);
    } catch {
      // 保持兜底状态
    }
  }, []);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const query: Record<string, string | number | undefined> = {
        page,
        pageSize,
      };
      if (resourceType !== '全部') query.resourceType = resourceType;
      if (action !== '全部') query.action = action;
      if (status !== '全部') query.status = status;
      if (keyword.trim()) query.keyword = keyword.trim();

      const res = await api.get<{
        total: number;
        page: number;
        pageSize: number;
        items?: AuditLogItem[];
        list?: AuditLogItem[];
      }>('/audit/logs', query);

      const items = res.items ?? res.list ?? [];
      setLogs(items);
      setTotal(res.total ?? items.length);
    } catch {
      setLogs([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, resourceType, action, status, keyword]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchLogs();
  };

  const handleReset = () => {
    setResourceType('全部');
    setAction('全部');
    setStatus('全部');
    setKeyword('');
    setPage(1);
  };

  const totalPages = Math.ceil(total / pageSize) || 1;

  return (
    <div className="space-y-4">
      {/* 4 个统计 KPI 卡片 */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-[0_1px_2px_rgba(0,0,0,0.04)] flex items-center justify-between">
          <div>
            <div className="text-xs font-medium text-slate-500 mb-1">操作日志总数</div>
            <div className="text-2xl font-bold tracking-tight text-slate-900">{stats.totalLogs}</div>
          </div>
          <img src={logIc1} alt="total" className="w-10 h-10 object-contain" />
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-[0_1px_2px_rgba(0,0,0,0.04)] flex items-center justify-between">
          <div>
            <div className="text-xs font-medium text-slate-500 mb-1">成功操作</div>
            <div className="text-2xl font-bold tracking-tight text-emerald-600">{stats.successCount}</div>
          </div>
          <img src={logIc2} alt="success" className="w-10 h-10 object-contain" />
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-[0_1px_2px_rgba(0,0,0,0.04)] flex items-center justify-between">
          <div>
            <div className="text-xs font-medium text-slate-500 mb-1">拦截 / 失败</div>
            <div className="text-2xl font-bold tracking-tight text-rose-600">{stats.failedCount}</div>
          </div>
          <img src={logIc3} alt="failed" className="w-10 h-10 object-contain" />
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-[0_1px_2px_rgba(0,0,0,0.04)] flex items-center justify-between">
          <div>
            <div className="text-xs font-medium text-slate-500 mb-1">今日新增记录</div>
            <div className="text-2xl font-bold tracking-tight text-blue-600">{stats.todayCount}</div>
          </div>
          <img src={logIc4} alt="today" className="w-10 h-10 object-contain" />
        </div>
      </div>

      {/* 搜索与过滤工具栏 */}
      <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        <form onSubmit={handleSearch} className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-slate-500">业务模块:</span>
            <select
              value={resourceType}
              onChange={(e) => {
                setResourceType(e.target.value);
                setPage(1);
              }}
              className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 bg-slate-50/50 text-slate-700 outline-none focus:border-blue-500"
            >
              <option value="全部">全部模块</option>
              <option value="INSPECTION_ORDER">检验工单</option>
              <option value="INSPECTION_PLAN">质检方案</option>
              <option value="MRB_REVIEW">MRB 评审</option>
              <option value="MATERIAL_PERMISSION">物料权限</option>
              <option value="BATCH_TRACE">批次追溯</option>
              <option value="RELEASE_GATE">放行卡口</option>
              <option value="INTEGRATION">ERP/MES 同步</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-slate-500">操作动作:</span>
            <select
              value={action}
              onChange={(e) => {
                setAction(e.target.value);
                setPage(1);
              }}
              className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 bg-slate-50/50 text-slate-700 outline-none focus:border-blue-500"
            >
              <option value="全部">全部动作</option>
              <option value="CREATE">新增创建</option>
              <option value="UPDATE">属性更新</option>
              <option value="STATUS_CHANGE">状态流转</option>
              <option value="DISPOSE">评审处置</option>
              <option value="GATE_BLOCKED">卡口阻断</option>
              <option value="AUTH_FAILED">越权拒绝</option>
              <option value="VALIDATION_REJECTED">校验失败</option>
              <option value="SYNC_TRIGGER">触发同步</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-slate-500">执行状态:</span>
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
              className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 bg-slate-50/50 text-slate-700 outline-none focus:border-blue-500"
            >
              <option value="全部">全部状态</option>
              <option value="SUCCESS">执行成功 (SUCCESS)</option>
              <option value="REJECTED">阻断拒绝 (REJECTED)</option>
              <option value="FAILED">系统失败 (FAILED)</option>
            </select>
          </div>

          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
            <input
              type="text"
              placeholder="搜索操作人、目标 ID、描述或 TraceID..."
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-slate-50/50 outline-none focus:border-blue-500"
            />
          </div>

          <div className="flex items-center gap-2 ml-auto">
            <button
              type="submit"
              className="px-3.5 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 shadow-sm transition"
            >
              查询
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="px-3.5 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition"
            >
              重置
            </button>
            <button
              type="button"
              onClick={() => {
                fetchStats();
                fetchLogs();
              }}
              className="p-1.5 text-slate-500 hover:text-slate-800 rounded-lg hover:bg-slate-100 transition"
              title="刷新数据"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </form>
      </div>

      {/* 日志数据表格 */}
      <div className="bg-white rounded-xl border border-slate-200/80 shadow-[0_1px_2px_rgba(0,0,0,0.04)] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50/80 border-b border-slate-200 text-slate-600">
                <th className="py-3 px-4 font-semibold">记录时间</th>
                <th className="py-3 px-4 font-semibold">业务模块</th>
                <th className="py-3 px-4 font-semibold">操作动作</th>
                <th className="py-3 px-4 font-semibold">操作人</th>
                <th className="py-3 px-4 font-semibold">目标资源</th>
                <th className="py-3 px-4 font-semibold">执行状态</th>
                <th className="py-3 px-4 font-semibold">明细描述</th>
                <th className="py-3 px-4 font-semibold text-center">变更差异</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-400">
                    <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-slate-400" />
                    正在加载审计日志...
                  </td>
                </tr>
              ) : logs.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-400">
                    未检索到符合条件的操作日志
                  </td>
                </tr>
              ) : (
                logs.map((log) => {
                  const actMeta = ACTION_LABELS[log.action] ?? {
                    label: log.action,
                    color: 'bg-slate-50 text-slate-700 border-slate-200',
                  };
                  const resName = RESOURCE_TYPE_LABELS[log.resourceType] ?? log.resourceType;
                  const hasDiff = log.diffPatch && Object.keys(log.diffPatch).length > 0;

                  return (
                    <tr key={log.id} className="hover:bg-slate-50/70 transition">
                      <td className="py-3 px-4 font-mono text-slate-500 whitespace-nowrap">
                        {log.createdAt ? new Date(log.createdAt).toLocaleString('zh-CN', { hour12: false }) : '-'}
                      </td>
                      <td className="py-3 px-4 text-slate-800 font-medium whitespace-nowrap">
                        {resName}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-medium ${actMeta.color}`}>
                          {actMeta.label}
                        </span>
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span className="font-medium text-slate-900">{log.userName || log.userId}</span>
                        {log.ip && <span className="block text-[10px] text-slate-400">{log.ip}</span>}
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-600 max-w-[150px] truncate" title={log.resourceId}>
                        {log.resourceId || '-'}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        {log.status === 'SUCCESS' ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                            成功
                          </span>
                        ) : log.status === 'REJECTED' ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-50 text-amber-700 border border-amber-200">
                            拦截 / 拒绝
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-rose-50 text-rose-700 border border-rose-200">
                            失败
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-slate-600 max-w-[260px] truncate" title={log.detail}>
                        {log.detail || '-'}
                      </td>
                      <td className="py-3 px-4 text-center whitespace-nowrap">
                        {hasDiff ? (
                          <button
                            type="button"
                            onClick={() => setSelectedLogForDiff(log)}
                            className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 font-medium px-2 py-0.5 rounded hover:bg-blue-50 transition"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            查看明细
                          </button>
                        ) : (
                          <span className="text-slate-300 text-xs">-</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* 分页栏 */}
        <div className="p-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
          <div>
            共 <span className="font-semibold text-slate-700">{total}</span> 条日志记录，第{' '}
            <span className="font-semibold text-slate-700">{page}</span> / {totalPages} 页
          </div>
          <div className="flex items-center gap-2">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="px-2.5 py-1 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              上一页
            </button>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="px-2.5 py-1 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              下一页
            </button>
          </div>
        </div>
      </div>

      {/* 变更明细 Diff Modal */}
      {selectedLogForDiff && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[85vh] flex flex-col overflow-hidden border border-slate-200">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">审计变更明细对比 (Diff Patch)</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  资源: {selectedLogForDiff.resourceType} #{selectedLogForDiff.resourceId} | 操作人: {selectedLogForDiff.userName}
                </p>
              </div>
              <button
                onClick={() => setSelectedLogForDiff(null)}
                className="p-1 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 overflow-y-auto space-y-4">
              {selectedLogForDiff.detail && (
                <div className="text-xs bg-slate-50 p-3 rounded-lg border border-slate-100 text-slate-700">
                  <span className="font-medium text-slate-900">描述: </span>
                  {selectedLogForDiff.detail}
                </div>
              )}
              <div>
                <div className="text-xs font-semibold text-slate-700 mb-1.5">变更快照 Payload:</div>
                <pre className="bg-slate-900 text-slate-100 text-xs font-mono p-3 rounded-lg overflow-x-auto max-h-96">
                  {JSON.stringify(selectedLogForDiff.diffPatch, null, 2)}
                </pre>
              </div>
            </div>
            <div className="px-5 py-3 border-t border-slate-100 bg-slate-50 flex justify-end">
              <button
                onClick={() => setSelectedLogForDiff(null)}
                className="px-4 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 shadow-sm"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
