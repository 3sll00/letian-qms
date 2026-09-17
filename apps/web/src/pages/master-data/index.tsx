import React, { useState, useEffect } from 'react';
import {
  Database,
  Building2,
  Users2,
  Factory,
  Package,
  Search,
  Plus,
  Edit,
} from 'lucide-react';
import { StatusBadge } from '../../components/StatusBadge';
import { api, errorMessage } from '../../lib/api';

type MasterDataTab = 'SUPPLIER' | 'CUSTOMER' | 'INVENTORY' | 'WORKSHOP' | 'EMPLOYEE';

/**
 * 行数据类型直接取自后端返回字段。
 *
 * 说明：页面原有的部分列（供应商评级/供货范围、客户行业与体系、车间工段与主任编制、
 * 员工资质与 MRB 席位、存货库存与状态）在 `packages/contracts` 与数据库中都没有对应字段，
 * 后端不会返回这些值，因此这里按「后端真实字段」建模，缺失列统一渲染为 `-`，
 * 避免用 Mock 常量冒充实库数据。
 */
const EMPTY_CELL = '-';

interface SupplierRow {
  id: string;
  supplierCode: string;
  supplierName: string;
  contactPerson?: string;
  phone?: string;
}

interface CustomerRow {
  id: string;
  customerCode: string;
  customerName: string;
  contactPerson?: string;
}

interface MaterialRow {
  id: string;
  materialCode: string;
  materialName: string;
  categoryName?: string;
  unit?: string;
  planCode?: string;
}

interface WorkshopRow {
  id: string;
  workshopCode: string;
  workshopName: string;
}

interface EmployeeRow {
  id: string;
  employeeCode: string;
  name: string;
  department?: string;
  isActive?: boolean;
}

const TABS: { key: MasterDataTab; label: string; icon: typeof Building2 }[] = [
  { key: 'SUPPLIER', label: '供应商 (Suppliers)', icon: Building2 },
  { key: 'CUSTOMER', label: '客户名录 (Customers)', icon: Users2 },
  { key: 'INVENTORY', label: '存货料品 (Inventory)', icon: Package },
  { key: 'WORKSHOP', label: '生产车间 (Workshops)', icon: Factory },
  { key: 'EMPLOYEE', label: '职员与检验员 (Staff)', icon: Users2 },
];

export function MasterDataPage() {
  const [activeTab, setActiveTab] = useState<MasterDataTab>('SUPPLIER');
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [inventory, setInventory] = useState<MaterialRow[]>([]);
  const [workshops, setWorkshops] = useState<WorkshopRow[]>([]);
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [search, setSearch] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.get<SupplierRow[]>('/master-data/suppliers'),
      api.get<CustomerRow[]>('/master-data/customers'),
      api.get<MaterialRow[]>('/master-data/inventory'),
      api.get<WorkshopRow[]>('/master-data/workshops'),
      api.get<EmployeeRow[]>('/master-data/employees'),
    ])
      .then(([sup, cus, inv, ws, emp]) => {
        setSuppliers(sup);
        setCustomers(cus);
        setInventory(inv);
        setWorkshops(ws);
        setEmployees(emp);
        setLoadError(null);
      })
      .catch((err) => {
        setLoadError(errorMessage(err));
        console.error('Master data load error:', err);
      });
  }, []);

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-slate-900/80 border border-slate-800 p-5 rounded-xl">
        <div>
          <h2 className="text-base font-semibold text-white flex items-center gap-2">
            <Database className="w-5 h-5 text-sky-400" />
            企业主数据管理中心 (Master Data Hub)
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            统一维护供应商、客户、存货料品、制造车间与质检职员主档案
          </p>
        </div>
        <button className="flex items-center gap-1.5 px-3.5 py-2 bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold rounded-lg shadow-lg shadow-sky-600/30 transition">
          <Plus className="w-4 h-4" />
          新增主数据档案
        </button>
      </div>

      {loadError ? (
        <div className="bg-rose-950/40 border border-rose-500/40 text-rose-200 text-xs rounded-xl px-4 py-3">
          主数据加载失败: {loadError}
        </div>
      ) : null}

      {/* Tabs Row */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4">
        <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-lg border border-slate-800 overflow-x-auto">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = activeTab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition ${
                  active ? 'bg-sky-600 text-white shadow' : 'text-slate-400 hover:text-white'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {t.label}
              </button>
            );
          })}
        </div>

        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
          <input
            type="text"
            placeholder="搜索编码、名称..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full sm:w-64 bg-slate-900 border border-slate-800 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-400 focus:outline-none focus:border-sky-500"
          />
        </div>
      </div>

      {/* Tables Container */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
        {activeTab === 'SUPPLIER' && (
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950 text-slate-400 uppercase font-mono border-b border-slate-800">
              <tr>
                <th className="px-4 py-3">供应商代码</th>
                <th className="px-4 py-3">企业名称</th>
                <th className="px-4 py-3">供应主要物料</th>
                <th className="px-4 py-3">质量等级评级</th>
                <th className="px-4 py-3">联系人 / 电话</th>
                <th className="px-4 py-3">状态</th>
                <th className="px-4 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-sans">
              {suppliers.map((s) => (
                <tr key={s.id} className="hover:bg-slate-800/40">
                  <td className="px-4 py-3 font-mono text-sky-400 font-bold">{s.supplierCode}</td>
                  <td className="px-4 py-3 font-medium text-white">{s.supplierName}</td>
                  <td className="px-4 py-3 text-slate-400">{EMPTY_CELL}</td>
                  <td className="px-4 py-3 font-mono text-slate-400">{EMPTY_CELL}</td>
                  <td className="px-4 py-3 text-slate-400 font-mono text-[11px]">
                    {s.contactPerson ?? EMPTY_CELL} · {s.phone ?? EMPTY_CELL}
                  </td>
                  <td className="px-4 py-3 text-slate-400">{EMPTY_CELL}</td>
                  <td className="px-4 py-3 text-right space-x-2">
                    <button className="text-sky-400 hover:text-sky-300 p-1">
                      <Edit className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {activeTab === 'CUSTOMER' && (
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950 text-slate-400 uppercase font-mono border-b border-slate-800">
              <tr>
                <th className="px-4 py-3">客户编号</th>
                <th className="px-4 py-3">客户企业名称</th>
                <th className="px-4 py-3">行业应用领域</th>
                <th className="px-4 py-3">特殊要求体系</th>
                <th className="px-4 py-3">客户联系人</th>
                <th className="px-4 py-3">状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-sans">
              {customers.map((c) => (
                <tr key={c.id} className="hover:bg-slate-800/40">
                  <td className="px-4 py-3 font-mono text-sky-400 font-bold">{c.customerCode}</td>
                  <td className="px-4 py-3 font-medium text-white">{c.customerName}</td>
                  <td className="px-4 py-3 text-slate-400">{EMPTY_CELL}</td>
                  <td className="px-4 py-3 font-mono text-slate-400 text-[11px]">{EMPTY_CELL}</td>
                  <td className="px-4 py-3 text-slate-400 font-mono text-[11px]">
                    {c.contactPerson ?? EMPTY_CELL}
                  </td>
                  <td className="px-4 py-3 text-slate-400">{EMPTY_CELL}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {activeTab === 'INVENTORY' && (
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950 text-slate-400 uppercase font-mono border-b border-slate-800">
              <tr>
                <th className="px-4 py-3">存货编码</th>
                <th className="px-4 py-3">物料规格型号</th>
                <th className="px-4 py-3">分类大类</th>
                <th className="px-4 py-3">计量单位</th>
                <th className="px-4 py-3">安全库存 / 现存量</th>
                <th className="px-4 py-3">检验方案</th>
                <th className="px-4 py-3">状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-sans">
              {inventory.map((inv) => (
                <tr key={inv.id} className="hover:bg-slate-800/40">
                  <td className="px-4 py-3 font-mono text-sky-400 font-bold">{inv.materialCode}</td>
                  <td className="px-4 py-3 font-medium text-white">{inv.materialName}</td>
                  <td className="px-4 py-3 text-slate-300 font-mono text-[11px]">
                    {inv.categoryName ?? EMPTY_CELL}
                  </td>
                  <td className="px-4 py-3 font-mono text-slate-400">{inv.unit ?? EMPTY_CELL}</td>
                  <td className="px-4 py-3 font-mono text-slate-400 text-[11px]">{EMPTY_CELL}</td>
                  <td className="px-4 py-3 font-mono text-cyan-400 text-[11px]">
                    {inv.planCode ?? '未配置检验方案'}
                  </td>
                  <td className="px-4 py-3 text-slate-400">{EMPTY_CELL}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {activeTab === 'WORKSHOP' && (
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950 text-slate-400 uppercase font-mono border-b border-slate-800">
              <tr>
                <th className="px-4 py-3">车间编码</th>
                <th className="px-4 py-3">车间名称</th>
                <th className="px-4 py-3">主要工段与设备</th>
                <th className="px-4 py-3">车间主任</th>
                <th className="px-4 py-3">质检员编制</th>
                <th className="px-4 py-3">状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-sans">
              {workshops.map((w) => (
                <tr key={w.id} className="hover:bg-slate-800/40">
                  <td className="px-4 py-3 font-mono text-sky-400 font-bold">{w.workshopCode}</td>
                  <td className="px-4 py-3 font-medium text-white">{w.workshopName}</td>
                  <td className="px-4 py-3 text-slate-400">{EMPTY_CELL}</td>
                  <td className="px-4 py-3 text-slate-400">{EMPTY_CELL}</td>
                  <td className="px-4 py-3 font-mono text-slate-400 text-[11px]">{EMPTY_CELL}</td>
                  <td className="px-4 py-3 text-slate-400">{EMPTY_CELL}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {activeTab === 'EMPLOYEE' && (
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950 text-slate-400 uppercase font-mono border-b border-slate-800">
              <tr>
                <th className="px-4 py-3">工号</th>
                <th className="px-4 py-3">姓名</th>
                <th className="px-4 py-3">部门 / 职务</th>
                <th className="px-4 py-3">质检资质认证</th>
                <th className="px-4 py-3">MRB 席位权限</th>
                <th className="px-4 py-3">在职状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-sans">
              {employees.map((e) => (
                <tr key={e.id} className="hover:bg-slate-800/40">
                  <td className="px-4 py-3 font-mono text-sky-400 font-bold">{e.employeeCode}</td>
                  <td className="px-4 py-3 font-medium text-white">{e.name}</td>
                  <td className="px-4 py-3 text-slate-300">{e.department ?? EMPTY_CELL}</td>
                  <td className="px-4 py-3 font-mono text-slate-400 text-[11px]">{EMPTY_CELL}</td>
                  <td className="px-4 py-3 font-mono text-slate-400 text-[11px]">{EMPTY_CELL}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={e.isActive === false ? 'INACTIVE' : 'ACTIVE'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
