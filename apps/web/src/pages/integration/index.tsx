import React, { useState, useEffect } from 'react';
import {
  Server,
  Cpu,
  Lock,
  Unlock,
  RefreshCw,
  Sliders,
} from 'lucide-react';
import { StatusBadge } from '../../components/StatusBadge';
import { api, errorMessage } from '../../lib/api';

// 契约包 (packages/contracts) 中没有设备映射与拦截规则的 Schema，数据库也没有对应表，
// 后端 GET /integration/equipment|rules 返回的是进程内静态目录 (apps/api/src/data/mes-gateway.ts)。
// 这里按该接口的真实返回结构声明本地类型，不再依赖 Mock 数据类型。
interface MesEquipment {
  id: string;
  equipmentCode: string;
  equipmentName: string;
  stationCode: string;
  workshop: string;
  protocol: string;
  ipAddress: string;
  status: 'ONLINE' | 'INTERCEPTED' | 'OFFLINE';
}

interface MesRule {
  id: string;
  ruleName: string;
  stage: string;
  condition: string;
  action: string;
  autoLock: boolean;
  status: string;
}

export function IntegrationPage() {
  const [equipmentList, setEquipmentList] = useState<MesEquipment[]>([]);
  const [rules, setRules] = useState<MesRule[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const fetchData = () => {
    Promise.all([
      api.get<MesEquipment[]>('/integration/equipment'),
      api.get<MesRule[]>('/integration/rules'),
    ])
      .then(([eq, ru]) => {
        setEquipmentList(eq);
        setRules(ru);
        setLoadError(null);
      })
      .catch((err) => {
        setLoadError(errorMessage(err));
        console.error('Integration fetch error:', err);
      });
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleToggleLock = async (eqId: string, currentStatus: MesEquipment['status']) => {
    const nextStatus: MesEquipment['status'] =
      currentStatus === 'INTERCEPTED' ? 'ONLINE' : 'INTERCEPTED';
    try {
      await api.put(`/integration/equipment/${encodeURIComponent(eqId)}/status`, {
        status: nextStatus,
      });
      setToggleError(null);
      fetchData();
    } catch (err) {
      setToggleError(errorMessage(err));
      console.error('Toggle lock error:', err);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-slate-900/80 border border-slate-800 p-5 rounded-xl">
        <div>
          <h2 className="text-base font-semibold text-white flex items-center gap-2">
            <Server className="w-5 h-5 text-sky-400" />
            MES 制造执行系统集成配置中心与工控机拦截网关
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            支持 OPC UA / Modbus TCP / MQTT 工业协议，实时下发 PLC 停机信号与硬放行阻断
          </p>
        </div>
        <button
          onClick={fetchData}
          className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg border border-slate-700 transition"
        >
          <RefreshCw className="w-4 h-4 text-slate-400" />
          刷新工控状态
        </button>
      </div>

      {loadError ? (
        <div className="bg-rose-950/40 border border-rose-500/40 text-rose-200 text-xs rounded-xl px-4 py-3">
          设备与规则清单加载失败: {loadError}
        </div>
      ) : null}

      {toggleError ? (
        <div className="bg-rose-950/40 border border-rose-500/40 text-rose-200 text-xs rounded-xl px-4 py-3">
          工控状态切换失败: {toggleError}
        </div>
      ) : null}

      {/* Equipment Grid */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-2">
            <Cpu className="w-4 h-4 text-sky-400" />
            车间机台工位与 PLC 停机联动状态 (现场实控)
          </h3>
          <span className="text-xs font-mono text-emerald-400 bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-500/30">
            双向心跳正常 (100ms)
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {equipmentList.map((eq) => {
            const isBlocked = eq.status === 'INTERCEPTED';
            return (
              <div
                key={eq.id}
                className={`p-4 rounded-xl border transition ${
                  isBlocked
                    ? 'bg-rose-950/30 border-rose-500/50 shadow-lg shadow-rose-950/50'
                    : 'bg-slate-900/90 border-slate-800'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs font-bold text-white">{eq.equipmentCode}</span>
                  <StatusBadge status={eq.status} />
                </div>

                <div className="mt-2">
                  <div className="text-sm font-semibold text-slate-200">{eq.equipmentName}</div>
                  <div className="text-xs text-slate-400 font-mono mt-0.5">
                    工位: {eq.stationCode} · {eq.workshop}
                  </div>
                </div>

                <div className="mt-3 pt-3 border-t border-slate-800/80 text-xs font-mono space-y-1 text-slate-400">
                  <div className="flex justify-between">
                    <span>通讯协议:</span>
                    <span className="text-slate-200">{eq.protocol}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>IP 地址:</span>
                    <span className="text-slate-200">{eq.ipAddress}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>阻断机制:</span>
                    <span className="text-sky-300">PLC 互锁跳闸</span>
                  </div>
                </div>

                <div className="mt-4 pt-2">
                  <button
                    onClick={() => handleToggleLock(eq.id, eq.status)}
                    className={`w-full py-1.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition border ${
                      isBlocked
                        ? 'bg-emerald-600 hover:bg-emerald-500 text-white border-emerald-500 shadow-md shadow-emerald-900/40'
                        : 'bg-rose-600/90 hover:bg-rose-600 text-white border-rose-500 shadow-md shadow-rose-900/40'
                    }`}
                  >
                    {isBlocked ? (
                      <>
                        <Unlock className="w-3.5 h-3.5" /> 解除锁死 / 恢复运行
                      </>
                    ) : (
                      <>
                        <Lock className="w-3.5 h-3.5" /> 立即手动停机拦截
                      </>
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Rules Configuration Table */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 shadow-xl space-y-4">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div>
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Sliders className="w-4 h-4 text-cyan-400" />
              QMS - MES 质量门禁自动阻断规则策略库
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              当质检指标触碰红色极限时，系统将在 150ms 内经网关直接下达机台抱闸停机或看板报警
            </p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950 text-slate-400 font-mono uppercase border-b border-slate-800">
              <tr>
                <th className="px-3 py-2.5">规则名称</th>
                <th className="px-3 py-2.5">适用工序工段</th>
                <th className="px-3 py-2.5">触发触发条件 (Condition)</th>
                <th className="px-3 py-2.5">执行工控动作 (Action)</th>
                <th className="px-3 py-2.5">自动锁死</th>
                <th className="px-3 py-2.5">状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-sans">
              {rules.map((rule) => (
                <tr key={rule.id} className="hover:bg-slate-800/40">
                  <td className="px-3 py-3 font-medium text-white">{rule.ruleName}</td>
                  <td className="px-3 py-3 font-mono text-slate-300">
                    <span className="px-2 py-0.5 rounded bg-slate-800 text-[11px]">
                      {rule.stage}
                    </span>
                  </td>
                  <td className="px-3 py-3 font-mono text-rose-300">{rule.condition}</td>
                  <td className="px-3 py-3 font-mono text-sky-400 font-bold">{rule.action}</td>
                  <td className="px-3 py-3 font-mono">
                    {rule.autoLock ? (
                      <span className="text-rose-400 bg-rose-950/80 px-2 py-0.5 rounded border border-rose-500/30">
                        硬阻断
                      </span>
                    ) : (
                      <span className="text-amber-400 bg-amber-950/80 px-2 py-0.5 rounded border border-amber-500/30">
                        软报警
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <StatusBadge status={rule.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
