import React, { useState, useEffect } from 'react';
import { GitMerge, Plus, ShieldCheck, CheckCircle2, ArrowRight, UserCheck, Settings2, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';

interface ReviewNode {
  nodeSeq: number;
  nodeName: string;
  roleName: string;
  isRequired: boolean;
  allowConcession?: boolean;
}

interface ReviewFlow {
  id: string;
  flowCode: string;
  flowName: string;
  applicableType: 'INCOMING_FAIL' | 'PROCESS_FAIL' | 'SHIPMENT_FAIL' | 'SUBCONTRACT_FAIL';
  nodes: ReviewNode[];
  isActive: boolean;
  description?: string;
  updatedAt?: string;
}

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

  const loadFlows = async () => {
    setLoading(true);
    try {
      const res = await api.get<ReviewFlow[]>('/review-flows');
      const data = Array.isArray(res) ? res : (res as any)?.items || [];
      setFlows(data);
      if (data.length > 0 && !selectedFlow) {
        setSelectedFlow(data[0]);
      }
    } catch (err) {
      console.warn('Load review flows fallback to defaults', err);
      const defaults: ReviewFlow[] = [
        {
          id: '1',
          flowCode: 'FLOW-IQC-DEFAULT',
          flowName: '来料不合格多方会签标准流程',
          applicableType: 'INCOMING_FAIL',
          isActive: true,
          description: '用于供应商供料尺寸、性能或外观不合格时的评审处置流转',
          nodes: [
            { nodeSeq: 1, nodeName: '质检员初审', roleName: '质检员', isRequired: true, allowConcession: false },
            { nodeSeq: 2, nodeName: '采购工程师协同', roleName: '采购专员', isRequired: true, allowConcession: false },
            { nodeSeq: 3, nodeName: '质量部长审批', roleName: '质量主管/部长', isRequired: true, allowConcession: true },
            { nodeSeq: 4, nodeName: '客户让步确认', roleName: '客户代表/销售', isRequired: false, allowConcession: true },
          ],
        },
        {
          id: '2',
          flowCode: 'FLOW-IPQC-DEFAULT',
          flowName: '下料与滚丝工序不合格评审流程',
          applicableType: 'PROCESS_FAIL',
          isActive: true,
          description: '用于车间内部在制加工异常的分流与返工判定',
          nodes: [
            { nodeSeq: 1, nodeName: '车间巡检初判', roleName: '巡检员', isRequired: true, allowConcession: false },
            { nodeSeq: 2, nodeName: '车间技术主任会签', roleName: '生产主管', isRequired: true, allowConcession: false },
            { nodeSeq: 3, nodeName: '工艺工程部决议', roleName: '工艺工程师', isRequired: true, allowConcession: true },
          ],
        },
        {
          id: '3',
          flowCode: 'FLOW-SUBCONTRACT-DEFAULT',
          flowName: '委外热处理与表面处理不合格流程',
          applicableType: 'SUBCONTRACT_FAIL',
          isActive: true,
          description: '管控委外加工商硬度、达克罗镀层等关键指标异常',
          nodes: [
            { nodeSeq: 1, nodeName: '委外检验录入', roleName: '委外质检员', isRequired: true, allowConcession: false },
            { nodeSeq: 2, nodeName: '外协供应商确认', roleName: '外协专员', isRequired: true, allowConcession: false },
            { nodeSeq: 3, nodeName: '总工程师终审', roleName: '总工程师', isRequired: true, allowConcession: true },
          ],
        },
      ];
      setFlows(defaults);
      if (!selectedFlow) setSelectedFlow(defaults[0]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFlows();
  }, []);

  const handleToggleFlow = async (flow: ReviewFlow) => {
    try {
      await api.post(`/review-flows/${flow.id}/toggle`, {});
      alert(`流程 ${flow.flowName} 状态已更新！`);
      loadFlows();
    } catch {
      // Toggle local fallback
      const updated = flows.map((f) => (f.id === flow.id ? { ...f, isActive: !f.isActive } : f));
      setFlows(updated);
      if (selectedFlow?.id === flow.id) {
        setSelectedFlow({ ...selectedFlow, isActive: !selectedFlow.isActive });
      }
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
                    <React.Fragment key={node.nodeSeq}>
                      <div className="flex-1 min-w-[160px] bg-slate-50 border border-slate-200 rounded-xl p-3.5 hover:shadow-sm transition-shadow">
                        <div className="flex items-center justify-between mb-2">
                          <span className="w-5 h-5 rounded-full bg-blue-600 text-white flex items-center justify-center text-[10px] font-bold">
                            {node.nodeSeq}
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
                          <span>{node.roleName}</span>
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
                        <tr key={node.nodeSeq} className="hover:bg-slate-50">
                          <td className="py-2.5 px-3 text-center font-bold text-slate-400">{node.nodeSeq}</td>
                          <td className="py-2.5 px-3 font-medium text-slate-800">{node.nodeName}</td>
                          <td className="py-2.5 px-3 text-slate-600">{node.roleName}</td>
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
