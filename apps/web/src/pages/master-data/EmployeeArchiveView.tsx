import React, { useState, useEffect } from "react";
import { Search, RotateCcw, RefreshCw, Plus } from "lucide-react";
import { api, errorMessage } from "../../lib/api";

export interface Employee {
  id: string;
  employeeCode: string;
  name: string;
  department?: string;
  phone?: string;
  email?: string;
  isActive: boolean;
  roleCode?: string;
  createdAt?: string;
}

export function EmployeeArchiveView({
  refreshKey,
  onOpenCreate,
}: {
  refreshKey?: number;
  onOpenCreate: () => void;
}) {
  const [keyword, setKeyword] = useState("");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchEmployees = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<Employee[]>("/master-data/employees", keyword ? { keyword } : undefined);
      setEmployees(data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchEmployees();
  }, [refreshKey]);

  const handleSearch = () => {
    void fetchEmployees();
  };

  const handleReset = () => {
    setKeyword("");
    setTimeout(() => {
      void api.get<Employee[]>("/master-data/employees").then(setEmployees);
    }, 0);
  };

  return (
    <div className="bg-white border border-slate-200 rounded-lg shadow-sm">
      {error && (
        <div className="m-4 p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded">
          {error}
        </div>
      )}

      {/* 查询工具条 */}
      <div className="p-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 font-medium">人员查询</span>
            <input
              type="text"
              placeholder="工号 / 姓名 / 部门"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              className="border border-slate-200 rounded px-2.5 py-1 text-xs w-48 focus:outline-none focus:border-blue-500"
            />
          </div>
          <button
            type="button"
            onClick={handleSearch}
            className="flex items-center gap-1 px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-medium transition"
          >
            <Search className="w-3 h-3" />
            查询
          </button>
          <button
            type="button"
            onClick={handleReset}
            className="flex items-center gap-1 px-3 py-1 border border-slate-200 hover:bg-slate-50 text-slate-600 rounded text-xs transition"
          >
            <RotateCcw className="w-3 h-3" />
            重置
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenCreate}
            className="flex items-center gap-1 px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-medium shadow-sm transition"
          >
            <Plus className="w-3.5 h-3.5" />
            新增职员
          </button>
          <button
            type="button"
            onClick={() => void fetchEmployees()}
            disabled={loading}
            className="flex items-center gap-1 px-3 py-1 border border-slate-200 hover:bg-slate-50 text-slate-700 rounded text-xs font-medium transition disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 text-blue-600 ${loading ? "animate-spin" : ""}`} />
            刷新
          </button>
        </div>
      </div>

      {/* 数据表格 */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead className="bg-slate-50 text-slate-600 font-medium border-b border-slate-200">
            <tr>
              <th className="py-2.5 px-4">序号</th>
              <th className="py-2.5 px-4">职员工号</th>
              <th className="py-2.5 px-4">姓名</th>
              <th className="py-2.5 px-4">部门 / 岗位</th>
              <th className="py-2.5 px-4">联系电话</th>
              <th className="py-2.5 px-4">电子邮箱</th>
              <th className="py-2.5 px-4">状态</th>
              <th className="py-2.5 px-4">建档时间</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr>
                <td colSpan={8} className="text-center py-8 text-slate-400">
                  正在加载职员档案...
                </td>
              </tr>
            ) : employees.length === 0 ? (
              <tr>
                <td colSpan={8} className="text-center py-8 text-slate-400">
                  暂无匹配的职员档案
                </td>
              </tr>
            ) : (
              employees.map((item, idx) => (
                <tr key={item.id || item.employeeCode} className="hover:bg-slate-50/80 transition">
                  <td className="py-2.5 px-4 text-slate-400 font-mono">{idx + 1}</td>
                  <td className="py-2.5 px-4 font-mono text-blue-600 font-semibold">
                    {item.employeeCode}
                  </td>
                  <td className="py-2.5 px-4 text-slate-800 font-medium">{item.name}</td>
                  <td className="py-2.5 px-4 text-slate-600">{item.department || "-"}</td>
                  <td className="py-2.5 px-4 text-slate-600 font-mono">{item.phone || "-"}</td>
                  <td className="py-2.5 px-4 text-slate-600 font-mono">{item.email || "-"}</td>
                  <td className="py-2.5 px-4">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium ${
                        item.isActive !== false
                          ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                          : "bg-slate-100 text-slate-500"
                      }`}
                    >
                      {item.isActive !== false ? "在职" : "离职"}
                    </span>
                  </td>
                  <td className="py-2.5 px-4 text-slate-400 font-mono">
                    {item.createdAt ? new Date(item.createdAt).toLocaleDateString() : "-"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
