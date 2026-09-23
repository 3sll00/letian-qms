import React, { useState, useEffect } from 'react';
import { GitMerge, ArrowRight, UserCheck, RefreshCw } from 'lucide-react';
import type { ReviewFlow, ReviewFlowNode } from '@letian/contracts';
import { api, errorMessage } from '../../lib/api';

/**
 * 节点展示口径（docs/21 §10.2 / §10.3）：
 * - 顺序读契约 `nodeLevel`（PRD §3.6「1~3 级审批节点」），不再自建 `nodeSeq`；
 * - 授权签署角色优先取 `roleName`，未配置时回退 `roleCode`（历史数据里 roleCode 存的是中文角色名）。
 */
const nodeSeqOf = (node: ReviewFlowNode): number => node.nodeLevel;
const roleLabelOf = (node: ReviewFlowNode): string =>
  node.roleName !== undefined && node.roleName !== '' ? node.roleName : node.roleCode;

const TYPE_NAME_MAP: Record<string, string> = {
  INCOMING_FAIL: '来料检验不合格 (IQC)',
  PROCESS_FAIL: '制造过程不合格 (IPQC)',
  SHIPMENT_FAIL: '出货成品不合格 (OQC)',
  SUBCONTRACT_FAIL: '委外加工不合格 (Outsource)',
};

export function ReviewWorkflowView() {
  const [flows, setFlows] = useState<ReviewFlow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedFlow, setSelectedFlow] = useState<ReviewFlow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadFlows = async () => {
    setLoading(true);
    try {
      const res = await api.get<{ total: number; items: ReviewFlow[] }>('/review-flows');
      const data = res.items ?? [];
      setFlows(data);
      // 选中项必须换成**本次取回的新对象**（按 id 重挂）：若沿用旧引用，
      // 右侧详情的状态标签与启停按钮会停在切换前的值——左侧卡片角标已变、
      // 右侧按钮文案未变，用户会以为「点了没反应」（docs/21 §10.1 E3 的同类根因）。
      setSelectedFlow((prev) =>
        data.length === 0 ? null : (data.find((flow) => flow.id === prev?.id) ?? data[0] ?? null)
      );
      setLoadError(null);
    } catch (err) {
      // 不再回退到本地写死的流程模板：那会把「接口 404 / 字段没打通」伪装成正常页面
      // （正是 docs/21 §10.1 E1~E3 长期未被发现的原因），这里改为可见错误态。
      setFlows([]);
      setSelectedFlow(null);
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFlows();
  }, []);

  const handleToggleFlow = async (flow: ReviewFlow) => {
    try {
      // 后端只注册了 /:id/toggle-active（docs/04 §3.5）；此前打的 /toggle 恒 404，
      // 又被 catch 当成"网络异常"本地翻转并弹成功文案，属假成功。
      await api.post(`/review-flows/${flow.id}/toggle-active`, {});
      alert(`流程「${flow.flowName}」状态已更新并落库`);
      loadFlows();
    } catch (err) {
      // 失败必须可见：不做本地翻转，避免刷新后回退造成的"改了又没改"
      alert(`流程「${flow.flowName}」状态更新失败：${errorMessage(err)}`);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="flex items-center justify-between bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-indigo-50 border border-indigo-200 flex items-center justify-center text-indigo-600">
            <GitMerge className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-slate-800">MRB 不合格品评审流程设置</h2>
            <p className="text-xs text-slate-500">配置来料、工序在制、委外与出货环节的多方会签审批链及节点权限</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadFlows}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </button>
        </div>
      </div>

      {loadError !== null && (
        <div className="bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl px-4 py-3">
          评审流程定义加载失败：{loadError}
        </div>
      )}

      {/* Main Grid: Left Flow List, Right Visual Pipeline */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Flow List */}
        <div className="space-y-3">
          <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider px-1">评审流程模板 ({flows.length})</h3>
          {flows.map((flow) => {
            const isSelected = selectedFlow?.id === flow.id;
            return (
              <div
                key={flow.id}
                onClick={() => setSelectedFlow(flow)}
                className={`p-4 rounded-xl border cursor-pointer transition-all ${
                  isSelected
                    ? 'bg-blue-50/70 border-blue-300 shadow-sm ring-1 ring-blue-400'
                    : 'bg-white border-slate-200 hover:border-slate-300 hover:bg-slate-50/50'
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[11px] font-mono font-semibold px-2 py-0.5 rounded bg-slate-100 text-slate-600">
                    {flow.flowCode}
                  </span>
                  <span
                    className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${
                      flow.isActive
                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                        : 'bg-slate-100 text-slate-500 border border-slate-200'
                    }`}
                  >
                    {flow.isActive ? '已启用' : '已停用'}
                  </span>
                </div>
                <h4 className="text-sm font-semibold text-slate-800 mb-1">{flow.flowName}</h4>
                <p className="text-xs text-slate-500 line-clamp-1 mb-2.5">{flow.description || '无详细描述'}</p>
                <div className="flex items-center justify-between pt-2 border-t border-slate-200/60 text-[11px] text-slate-500">
                  <span>{TYPE_NAME_MAP[flow.applicableType] || flow.applicableType}</span>
                  <span className="font-medium text-slate-700">{flow.nodes?.length || 0} 个会签节点</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Right Column: Visual Flow Nodes & Details */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200/80 p-6 shadow-sm space-y-6">
          {selectedFlow ? (
            <>
              <div className="flex items-start justify-between pb-4 border-b border-slate-200">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-mono bg-blue-100 text-blue-800 px-2 py-0.5 rounded font-semibold">
                      {selectedFlow.flowCode}
                    </span>
                    <h3 className="text-base font-bold text-slate-800">{selectedFlow.flowName}</h3>
                  </div>
                  <p className="text-xs text-slate-500">{selectedFlow.description}</p>
                </div>
                <button
                  onClick={() => handleToggleFlow(selectedFlow)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    selectedFlow.isActive
                      ? 'bg-rose-50 text-rose-600 border border-rose-200 hover:bg-rose-100'
                      : 'bg-emerald-50 text-emerald-600 border border-emerald-200 hover:bg-emerald-100'
                  }`}
                >
                  {selectedFlow.isActive ? '停用此流程' : '启用此流程'}
                </button>
              </div>

              {/* Visual Pipeline Pipeline */}
              <div>
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4">评审路由节点链</h4>
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 overflow-x-auto pb-3">
                  {selectedFlow.nodes.map((node, idx) => (
                    <React.Fragment key={node.nodeLevel}>
                      <div className="flex-1 min-w-[160px] bg-slate-50 border border-slate-200 rounded-xl p-3.5 hover:shadow-sm transition-shadow">
                        <div className="flex items-center justify-between mb-2">
                          <span className="w-5 h-5 rounded-full bg-blue-600 text-white flex items-center justify-center text-[10px] font-bold">
                            {nodeSeqOf(node)}
                          </span>
                          {node.isRequired && (
                            <span className="text-[10px] px-1.5 py-0.2 bg-rose-50 text-rose-600 rounded font-medium border border-rose-200">
                              必审
                            </span>
                          )}
                        </div>
                        <h5 className="text-xs font-bold text-slate-800 mb-1">{node.nodeName}</h5>
                        <div className="flex items-center gap-1 text-[11px] text-slate-500 mb-2">
                          <UserCheck className="w-3 h-3 text-slate-400" />
                          <span>{roleLabelOf(node)}</span>
                        </div>
                        <div className="text-[10px] text-slate-400 pt-1.5 border-t border-slate-200/80">
                          {node.allowConcession ? '具有让步特采建议权' : '仅限返工/报废判定'}
                        </div>
                      </div>
                      {idx < selectedFlow.nodes.length - 1 && (
                        <div className="hidden sm:flex items-center justify-center text-slate-300">
                          <ArrowRight className="w-5 h-5" />
                        </div>
                      )}
                    </React.Fragment>
                  ))}
                </div>
              </div>

              {/* Node Details Table */}
              <div>
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2.5">节点配置清单</h4>
                <div className="border border-slate-200 rounded-lg overflow-hidden">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead className="bg-slate-100 text-slate-700 font-medium">
                      <tr>
                        <th className="py-2.5 px-3 w-14 text-center">顺序</th>
                        <th className="py-2.5 px-3">节点名称</th>
                        <th className="py-2.5 px-3">授权签署角色</th>
                        <th className="py-2.5 px-3 text-center">是否必签</th>
                        <th className="py-2.5 px-3 text-center">特采审批权</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {selectedFlow.nodes.map((node) => (
                        <tr key={node.nodeLevel} className="hover:bg-slate-50">
                          <td className="py-2.5 px-3 text-center font-bold text-slate-400">{nodeSeqOf(node)}</td>
                          <td className="py-2.5 px-3 font-medium text-slate-800">{node.nodeName}</td>
                          <td className="py-2.5 px-3 text-slate-600">{roleLabelOf(node)}</td>
                          <td className="py-2.5 px-3 text-center">
                            <span className={node.isRequired ? 'text-rose-600 font-semibold' : 'text-slate-400'}>
                              {node.isRequired ? '是' : '否'}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 text-center">
                            <span className={node.allowConcession ? 'text-emerald-600 font-semibold' : 'text-slate-400'}>
                              {node.allowConcession ? '支持' : '不支持'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : (
            <div className="text-center py-16 text-slate-400 text-xs">请选择左侧评审流程查看配置</div>
          )}
        </div>
      </div>
    </div>
  );
}
