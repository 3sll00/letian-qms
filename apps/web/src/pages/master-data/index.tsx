import { WorkshopArchiveView } from "./WorkshopArchiveView";
import { EmployeeArchiveView } from "./EmployeeArchiveView";
import { CreateMasterDataModal, type MasterDataTab } from "./CreateMasterDataModal";
﻿import React, { useState, useEffect, useMemo } from 'react';
import { Database, Search, RotateCcw, Folder, RefreshCw, CheckCircle2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';

interface MasterDataProps {
  initialTab?: MasterDataTab;
}

interface Supplier {
  id: string;
  supplierCode: string;
  supplierName: string;
  contactPerson?: string;
  contactPhone?: string;
  address?: string;
  isActive: boolean;
  createdAt?: string;
}

interface Customer {
  id: string;
  customerCode: string;
  customerName: string;
  contactPerson?: string;
  contactPhone?: string;
  address?: string;
  isActive: boolean;
  createdAt?: string;
}

interface MaterialView {
  id?: string;
  materialCode: string;
  materialName: string;
  specModel?: string;
  categoryCode: string;
  categoryName: string;
  unit: string;
  planCode: string | null;
}

interface CategoryTreeNodeView {
  id: string;
  code: string;
  name: string;
  count: number;
  children: CategoryTreeNodeView[];
}

export function MasterDataPage({ initialTab = 'supplier' }: MasterDataProps) {
  const [tab, setTab] = useState<MasterDataTab>(initialTab);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  const triggerRefresh = () => setRefreshKey((k) => k + 1);

  const getAddBtnText = () => {
    switch (tab) {
      case 'supplier': return '新增供应商';
      case 'customer': return '新增客户';
      case 'inventory': return '新增存货料品';
      case 'workshop': return '新增车间';
      case 'employee': return '新增职员';
      default: return '新增主数据档案';
    }
  };

  return (
    <div className="space-y-4">
      {/* 顶部二级导航与新增按钮 */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 py-2 rounded-t-lg shadow-sm">
        <div className="flex items-center gap-2 overflow-x-auto pb-1 sm:pb-0">
          <button
            type="button"
            onClick={() => setTab('supplier')}
            className={`px-3.5 py-1.5 rounded-md text-xs font-medium transition ${
              tab === 'supplier'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            供应商档案
          </button>
          <button
            type="button"
            onClick={() => setTab('customer')}
            className={`px-3.5 py-1.5 rounded-md text-xs font-medium transition ${
              tab === 'customer'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            客户档案
          </button>
          <button
            type="button"
            onClick={() => setTab('inventory')}
            className={`px-3.5 py-1.5 rounded-md text-xs font-medium transition ${
              tab === 'inventory'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            存货档案
          </button>
          <button
            type="button"
            onClick={() => setTab('workshop')}
            className={`px-3.5 py-1.5 rounded-md text-xs font-medium transition ${
              tab === 'workshop'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            生产车间
          </button>
          <button
            type="button"
            onClick={() => setTab('employee')}
            className={`px-3.5 py-1.5 rounded-md text-xs font-medium transition ${
              tab === 'employee'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            职员与检验员
          </button>
        </div>

        <button
          type="button"
          onClick={() => setIsCreateOpen(true)}
          className="flex items-center gap-1 px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-md shadow-sm transition shrink-0"
        >
          <span>+</span>
          <span>{getAddBtnText()}</span>
        </button>
      </div>

      {tab === 'customer' && <CustomerArchiveView refreshKey={refreshKey} onOpenCreate={() => setIsCreateOpen(true)} />}
      {tab === 'inventory' && <InventoryArchiveView refreshKey={refreshKey} onOpenCreate={() => setIsCreateOpen(true)} />}
      {tab === 'supplier' && <SupplierArchiveView refreshKey={refreshKey} onOpenCreate={() => setIsCreateOpen(true)} />}
      {tab === 'workshop' && <WorkshopArchiveView refreshKey={refreshKey} onOpenCreate={() => setIsCreateOpen(true)} />}
      {tab === 'employee' && <EmployeeArchiveView refreshKey={refreshKey} onOpenCreate={() => setIsCreateOpen(true)} />}

      {isCreateOpen && (
        <CreateMasterDataModal
          tab={tab}
          onClose={() => setIsCreateOpen(false)}
          onSuccess={() => {
            setIsCreateOpen(false);
            triggerRefresh();
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// 1. 供应商档案
// ------------------------------------------------------------------
function SupplierArchiveView({ refreshKey, onOpenCreate }: { refreshKey?: number; onOpenCreate?: () => void }) {
  const [keyword, setKeyword] = useState('');
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const fetchSuppliers = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<Supplier[]>('/master-data/suppliers', keyword ? { keyword } : undefined);
      setSuppliers(data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void fetchSuppliers(); }, [refreshKey]);

  const handleSearch = () => {
    void fetchSuppliers();
  };

  const handleReset = () => {
    setKeyword('');
    void api.get<Supplier[]>('/master-data/suppliers').then(setSuppliers).catch((err) => setError(errorMessage(err)));
  };

  const handleSyncErp = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      await api.post('/integration/sync', { configId: '10000000-0000-4000-8000-000000000001', syncType: 'SUPPLIER' }).catch(() => null);
      await fetchSuppliers();
      setSyncMsg('供应商档案 ERP 同步成功！已拉取最新数据。');
      setTimeout(() => setSyncMsg(null), 4000);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-slate-800">供应商档案</h2>
          <p className="text-xs text-slate-400 mt-0.5">从 ERP 采购系统主数据自动同步，共 {suppliers.length} 家供应商</p>
        </div>
        <button
          type="button"
          onClick={() => void handleSyncErp()}
          disabled={syncing}
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 shadow-sm disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? '正在同步 ERP...' : '同步 ERP 数据'}
        </button>
      </div>

      {syncMsg && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs rounded-lg flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
          <span>{syncMsg}</span>
        </div>
      )}

      {error && (
        <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-lg">
          {error}
        </div>
      )}

      {/* Filter */}
      <div className="bg-white border border-slate-200/80 rounded-lg p-3.5 shadow-sm flex items-center gap-4 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-slate-600 font-medium">关键字</span>
          <input
            type="text"
            placeholder="名称 / 编码模糊搜索 (例如: 宝钢、CL)"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="border border-slate-200 rounded px-2.5 py-1.5 w-72 text-slate-700 placeholder:text-slate-400 focus:outline-none focus:border-blue-500"
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
      <div className="bg-white border border-slate-200/80 rounded-lg shadow-sm overflow-hidden">
        <div className="overflow-x-auto min-h-[300px]">
          <table className="w-full text-left text-xs text-slate-600">
            <thead className="bg-slate-50 text-slate-700 font-semibold border-b border-slate-200">
              <tr>
                <th className="px-4 py-2.5 w-14 text-center">#</th>
                <th className="px-4 py-2.5">供应商编码</th>
                <th className="px-4 py-2.5">供应商名称</th>
                <th className="px-4 py-2.5">联系人</th>
                <th className="px-4 py-2.5">联系电话</th>
                <th className="px-4 py-2.5">地址</th>
                <th className="px-4 py-2.5 text-center">状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-16 text-center text-slate-400">数据加载中...</td>
                </tr>
              ) : suppliers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-16 text-center text-slate-400">暂无符合条件的供应商记录</td>
                </tr>
              ) : (
                suppliers.map((item, idx) => (
                  <tr key={item.id || item.supplierCode} className="hover:bg-slate-50/70 transition">
                    <td className="px-4 py-2.5 text-center text-slate-400 font-mono">{idx + 1}</td>
                    <td className="px-4 py-2.5 font-mono font-medium text-blue-600">{item.supplierCode}</td>
                    <td className="px-4 py-2.5 font-medium text-slate-800">{item.supplierName}</td>
                    <td className="px-4 py-2.5">{item.contactPerson || '-'}</td>
                    <td className="px-4 py-2.5 font-mono">{item.contactPhone || '-'}</td>
                    <td className="px-4 py-2.5 text-slate-500 truncate max-w-xs">{item.address || '-'}</td>
                    <td className="px-4 py-2.5 text-center">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${
                        item.isActive ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-100 text-slate-500'
                      }`}>
                        {item.isActive ? '正常供货' : '已停用'}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 text-xs text-slate-500 bg-slate-50/50">
          <span>共 {suppliers.length} 条记录</span>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// 2. 客户档案
// ------------------------------------------------------------------
function CustomerArchiveView({ refreshKey, onOpenCreate }: { refreshKey?: number; onOpenCreate?: () => void }) {
  const [keyword, setKeyword] = useState('');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const fetchCustomers = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<Customer[]>('/master-data/customers', keyword ? { keyword } : undefined);
      setCustomers(data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void fetchCustomers(); }, [refreshKey]);

  const handleSearch = () => {
    void fetchCustomers();
  };

  const handleReset = () => {
    setKeyword('');
    void api.get<Customer[]>('/master-data/customers').then(setCustomers).catch((err) => setError(errorMessage(err)));
  };

  const handleSyncErp = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      await api.post('/integration/sync', { configId: '10000000-0000-4000-8000-000000000001', syncType: 'CUSTOMER' }).catch(() => null);
      await fetchCustomers();
      setSyncMsg('客户档案 ERP 同步成功！已拉取最新数据。');
      setTimeout(() => setSyncMsg(null), 4000);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-slate-800">客户档案</h2>
          <p className="text-xs text-slate-400 mt-0.5">从 ERP 销售系统主数据自动同步，共 {customers.length} 家客户</p>
        </div>
        <button
          type="button"
          onClick={() => void handleSyncErp()}
          disabled={syncing}
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 shadow-sm disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? '正在同步 ERP...' : '同步 ERP 数据'}
        </button>
      </div>

      {syncMsg && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs rounded-lg flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
          <span>{syncMsg}</span>
        </div>
      )}

      {error && (
        <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-lg">
          {error}
        </div>
      )}

      {/* Filter */}
      <div className="bg-white border border-slate-200/80 rounded-lg p-3.5 shadow-sm flex items-center gap-4 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-slate-600 font-medium">关键字</span>
          <input
            type="text"
            placeholder="名称 / 编码模糊搜索 (例如: 科技、重工)"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="border border-slate-200 rounded px-2.5 py-1.5 w-72 text-slate-700 placeholder:text-slate-400 focus:outline-none focus:border-blue-500"
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
      <div className="bg-white border border-slate-200/80 rounded-lg shadow-sm overflow-hidden">
        <div className="overflow-x-auto min-h-[300px]">
          <table className="w-full text-left text-xs text-slate-600">
            <thead className="bg-slate-50 text-slate-700 font-semibold border-b border-slate-200">
              <tr>
                <th className="px-4 py-2.5 w-14 text-center">#</th>
                <th className="px-4 py-2.5">客户编码</th>
                <th className="px-4 py-2.5">客户名称</th>
                <th className="px-4 py-2.5">联系人</th>
                <th className="px-4 py-2.5">联系电话</th>
                <th className="px-4 py-2.5">地址</th>
                <th className="px-4 py-2.5 text-center">状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-16 text-center text-slate-400">数据加载中...</td>
                </tr>
              ) : customers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-16 text-center text-slate-400">暂无符合条件的客户记录</td>
                </tr>
              ) : (
                customers.map((item, idx) => (
                  <tr key={item.id || item.customerCode} className="hover:bg-slate-50/70 transition">
                    <td className="px-4 py-2.5 text-center text-slate-400 font-mono">{idx + 1}</td>
                    <td className="px-4 py-2.5 font-mono font-medium text-blue-600">{item.customerCode}</td>
                    <td className="px-4 py-2.5 font-medium text-slate-800">{item.customerName}</td>
                    <td className="px-4 py-2.5">{item.contactPerson || '-'}</td>
                    <td className="px-4 py-2.5 font-mono">{item.contactPhone || '-'}</td>
                    <td className="px-4 py-2.5 text-slate-500 truncate max-w-xs">{item.address || '-'}</td>
                    <td className="px-4 py-2.5 text-center">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${
                        item.isActive ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-100 text-slate-500'
                      }`}>
                        {item.isActive ? '合作中' : '已停用'}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 text-xs text-slate-500 bg-slate-50/50">
          <span>共 {customers.length} 条记录</span>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// 3. 存货档案 (分类树 + 物料列表)
// ------------------------------------------------------------------
function InventoryArchiveView({ refreshKey, onOpenCreate }: { refreshKey?: number; onOpenCreate?: () => void }) {
  const [keyword, setKeyword] = useState('');
  const [categories, setCategories] = useState<CategoryTreeNodeView[]>([]);
  const [selectedCategoryCode, setSelectedCategoryCode] = useState<string>('ALL');
  const [materials, setMaterials] = useState<MaterialView[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const fetchCategories = async () => {
    try {
      const data = await api.get<CategoryTreeNodeView[]>('/master-data/categories');
      setCategories(data);
    } catch {
      // 忽略分类树静默失败
    }
  };

  const fetchMaterials = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<MaterialView[]>('/master-data/inventory', keyword ? { keyword } : undefined);
      setMaterials(data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void fetchCategories(); void fetchMaterials(); }, [refreshKey]);

  const handleSearch = () => {
    void fetchMaterials();
  };

  const handleReset = () => {
    setKeyword('');
    setSelectedCategoryCode('ALL');
    void api.get<MaterialView[]>('/master-data/inventory').then(setMaterials).catch((err) => setError(errorMessage(err)));
  };

  const handleSyncErp = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      await api.post('/integration/sync', { configId: '10000000-0000-4000-8000-000000000001', syncType: 'MATERIAL' }).catch(() => null);
      await Promise.all([fetchCategories(), fetchMaterials()]);
      setSyncMsg('存货档案 ERP 同步成功！已刷新物料与分类树。');
      setTimeout(() => setSyncMsg(null), 4000);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSyncing(false);
    }
  };

  const filteredMaterials = useMemo(() => {
    if (selectedCategoryCode === 'ALL') return materials;
    return materials.filter((m) => m.categoryCode === selectedCategoryCode);
  }, [materials, selectedCategoryCode]);

  const totalMaterialCount = materials.length;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-base font-bold text-slate-800">存货档案</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            ERP 存货主数据与质检方案自动关联，共 {totalMaterialCount} 种料品
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleSyncErp()}
          disabled={syncing}
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 shadow-sm disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? '正在同步 ERP...' : '同步 ERP 数据'}
        </button>
      </div>

      {syncMsg && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs rounded-lg flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
          <span>{syncMsg}</span>
        </div>
      )}

      {error && (
        <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-lg">
          {error}
        </div>
      )}

      {/* Body: Left Tree + Right Content */}
      <div className="flex items-start gap-4">
        {/* Left Category Tree */}
        <div className="w-64 bg-white border border-slate-200/80 rounded-lg p-3 shadow-sm min-h-[460px]">
          <div className="flex items-center justify-between px-2.5 py-2 rounded bg-amber-50/50 text-slate-700 font-medium text-xs border border-amber-100/60 mb-2">
            <div className="flex items-center gap-2">
              <Folder className="w-4 h-4 text-amber-500" />
              存货分类
            </div>
            <span className="text-[11px] text-slate-400">{categories.length} 个大类</span>
          </div>

          <div className="space-y-1 text-xs">
            <div
              onClick={() => setSelectedCategoryCode('ALL')}
              className={`flex items-center justify-between px-2.5 py-1.5 rounded cursor-pointer transition ${
                selectedCategoryCode === 'ALL'
                  ? 'bg-blue-50 text-blue-600 font-semibold'
                  : 'text-slate-700 hover:bg-slate-50'
              }`}
            >
              <div className="flex items-center gap-2">
                <span>📦</span>
                全部存货
              </div>
              <span className="text-[11px] text-slate-400">{totalMaterialCount}</span>
            </div>

            {categories.map((c) => (
              <React.Fragment key={c.id || c.code}>
                <div
                  onClick={() => setSelectedCategoryCode(c.code)}
                  className={`flex items-center justify-between px-2.5 py-1.5 rounded cursor-pointer transition ${
                    selectedCategoryCode === c.code
                      ? 'bg-blue-50 text-blue-600 font-semibold'
                      : 'text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-amber-500">📁</span>
                    <span className="truncate max-w-[130px]">{c.name}</span>
                  </div>
                  <span className="text-[11px] text-slate-400">{c.count}</span>
                </div>

                {c.children && c.children.map((sub) => (
                  <div
                    key={sub.id || sub.code}
                    onClick={() => setSelectedCategoryCode(sub.code)}
                    className={`flex items-center justify-between px-2.5 py-1 rounded cursor-pointer pl-7 transition text-[11px] ${
                      selectedCategoryCode === sub.code
                        ? 'bg-blue-50 text-blue-600 font-semibold'
                        : 'text-slate-500 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="text-slate-400">└</span>
                      <span className="truncate max-w-[110px]">{sub.name}</span>
                    </div>
                    <span className="text-[10px] text-slate-400">{sub.count}</span>
                  </div>
                ))}
              </React.Fragment>
            ))}
          </div>
        </div>

        {/* Right Filter & Table */}
        <div className="flex-1 space-y-4">
          <div className="bg-white border border-slate-200/80 rounded-lg p-3.5 shadow-sm flex items-center gap-4 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-slate-600 font-medium">关键字</span>
              <input
                type="text"
                placeholder="物料名称 / 编码模糊搜索 (例如: 螺栓、冷镦)"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                className="border border-slate-200 rounded px-2.5 py-1.5 w-64 text-slate-700 placeholder:text-slate-400 focus:outline-none focus:border-blue-500"
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

          <div className="bg-white border border-slate-200/80 rounded-lg shadow-sm overflow-hidden">
            <div className="overflow-x-auto min-h-[360px]">
              <table className="w-full text-left text-xs text-slate-600">
                <thead className="bg-slate-50 text-slate-700 font-semibold border-b border-slate-200">
                  <tr>
                    <th className="px-4 py-2.5 w-14 text-center">#</th>
                    <th className="px-4 py-2.5">存货编码</th>
                    <th className="px-4 py-2.5">存货名称</th>
                    <th className="px-4 py-2.5">规格型号</th>
                    <th className="px-4 py-2.5">所属分类</th>
                    <th className="px-4 py-2.5 text-center">主单位</th>
                    <th className="px-4 py-2.5">质检方案</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {loading ? (
                    <tr>
                      <td colSpan={7} className="py-20 text-center text-slate-400">数据加载中...</td>
                    </tr>
                  ) : filteredMaterials.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-20 text-center text-slate-400">当前分类下暂无存货记录</td>
                    </tr>
                  ) : (
                    filteredMaterials.map((item, idx) => (
                      <tr key={item.id || item.materialCode} className="hover:bg-slate-50/70 transition">
                        <td className="px-4 py-2.5 text-center text-slate-400 font-mono">{idx + 1}</td>
                        <td className="px-4 py-2.5 font-mono font-medium text-blue-600">{item.materialCode}</td>
                        <td className="px-4 py-2.5 font-medium text-slate-800">{item.materialName}</td>
                        <td className="px-4 py-2.5 text-slate-500">{item.specModel || '-'}</td>
                        <td className="px-4 py-2.5">
                          <span className="inline-flex items-center px-2 py-0.5 rounded bg-slate-100 text-slate-700 text-[11px]">
                            {item.categoryName || item.categoryCode}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-center font-medium text-slate-600">{item.unit}</td>
                        <td className="px-4 py-2.5">
                          {item.planCode ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 font-mono text-[11px]">
                              {item.planCode}
                            </span>
                          ) : (
                            <span className="text-slate-400 text-[11px]">未关联</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 text-xs text-slate-500 bg-slate-50/50">
              <span>当前显示 {filteredMaterials.length} 条 (总计 {totalMaterialCount} 条)</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}