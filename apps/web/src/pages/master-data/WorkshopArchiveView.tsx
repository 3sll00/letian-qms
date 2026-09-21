import React, { useState, useEffect } from "react";
import { Search, RotateCcw, RefreshCw, Plus, CheckCircle2 } from "lucide-react";
import { api, errorMessage } from "../../lib/api";

export interface Workshop {
  id: string;
  workshopCode: string;
  workshopName: string;
  createdAt?: string;
}

export function WorkshopArchiveView({
  refreshKey,
  onOpenCreate,
}: {
  refreshKey?: number;
  onOpenCreate: () => void;
}) {
  const [keyword, setKeyword] = useState("");
  const [workshops, setWorkshops] = useState<Workshop[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchWorkshops = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<Workshop[]>("/master-data/workshops", keyword ? { keyword } : undefined);
      setWorkshops(data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchWorkshops();
  }, [refreshKey]);

  const handleSearch = () => {
    void fetchWorkshops();
  };

  const handleReset = () => {
    setKeyword("");
    setTimeout(() => {
      void api.get<Workshop[]>("/master-data/workshops").then(setWorkshops);
    }, 0);
  };

  const handleSyncMes = async () => {
    setSyncing(true);
    setSyncMsg(null);
    setError(null);
    try {
      await api.post('/integration/mes/sync', {});
      await fetchWorkshops();
      setSyncMsg('MES车间工序数据同步成功！已更新车间与工序列表。');
      setTimeout(() => setSyncMsg(null), 4000);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-lg shadow-sm">
      {error && (
        <div className="m-4 p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded">
          {error}
        </div>
      )}

      {syncMsg && (
        <div className="m-4 p-3 bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs rounded-lg flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
          <span>{syncMsg}</span>
        </div>
      )}

      {/* 查询工具条 */}
      <div className="p-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 font-medium">车间查询</span>
            <input
              type="text"
              placeholder="车间编码 / 名称"
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
            onClick={() => void handleSyncMes()}
            disabled={syncing}
            className="flex items-center gap-1.5 px-3 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-xs font-medium shadow-sm transition disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "正在同步 MES..." : "同步 MES 工序"}
          </button>
          <button
            type="button"
            onClick={onOpenCreate}
            className="flex items-center gap-1 px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-medium shadow-sm transition"
          >
            <Plus className="w-3.5 h-3.5" />
            新增车间
          </button>
          <button
            type="button"
            onClick={() => void fetchWorkshops()}
            disabled={loading}
            className="flex items-center gap-1 px-3 py-1 border border-slate-200 hover:bg-slate-50 text-slate-700 rounded text-xs font-medium transition disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 text-blue-600 ${loading ? "animate-spin" : ""}`} />
            刷新
          </button>
        </div>
      </div>

      {/* 列表表格 */}
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 font-semibold">
              <th className="py-2.5 px-4">序号</th>
              <th className="py-2.5 px-4">车间编码</th>
              <th className="py-2.5 px-4">车间/工序名称</th>
              <th className="py-2.5 px-4">创建时间</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr>
                <td colSpan={4} className="py-8 text-center text-slate-400">
                  <div className="flex items-center justify-center gap-2">
                    <RefreshCw className="w-4 h-4 animate-spin text-blue-500" />
                    <span>加载中...</span>
                  </div>
                </td>
              </tr>
            ) : workshops.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-8 text-center text-slate-400">
                  暂无车间数据
                </td>
              </tr>
            ) : (
              workshops.map((ws, idx) => (
                <tr key={ws.id} className="hover:bg-slate-50 transition">
                  <td className="py-2.5 px-4 text-slate-400">{idx + 1}</td>
                  <td className="py-2.5 px-4 font-mono font-medium text-slate-700">
                    {ws.workshopCode}
                  </td>
                  <td className="py-2.5 px-4 text-slate-800 font-medium">
                    {ws.workshopName}
                  </td>
                  <td className="py-2.5 px-4 text-slate-400">
                    {ws.createdAt ? new Date(ws.createdAt).toLocaleString() : "-"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="p-3 border-t border-slate-100 text-right text-xs text-slate-400">
        共 {workshops.length} 条车间与工段记录
      </div>
    </div>
  );
}