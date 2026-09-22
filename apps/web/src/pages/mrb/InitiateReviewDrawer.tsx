import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  RefreshCw,
  Send,
  ShieldAlert,
  X,
} from 'lucide-react';
import type { PendingDefectItem } from '@letian/contracts';
import { api, errorMessage } from '../../lib/api';
import { PrintTemplateModal } from '../../components/common/PrintTemplateModal';

/**
 * 不合格待审核池抽屉（阶段 1，对应 docs/19-MRB不合格品处置页整合设计.md §7.1）
 *
 * 职责：把各检验环节判定不合格、尚未发起评审的记录集中呈现，支持逐条核实后
 * 选用评审流程发起独立 MRB 工单（POST /mrb/pending-pool/initiate）。
 *
 * 数据纪律：接口异常或池为空时展示空态 + 显式错误提示，**不回退到写死的演示行**
 * （否则“接口是否真打通”无法判断，见 docs/09-界面与开源组件.md §2.4）。
 */

const POOL_PAGE_SIZE = 100;

interface ReviewFlowOption {
  id: string;
  flowCode: string;
  flowName: string;
  description?: string;
}

interface PendingPoolResponse {
  items?: PendingDefectItem[];
  list?: PendingDefectItem[];
  total?: number;
}

export interface InitiateReviewDrawerProps {
  open: boolean;
  onClose: () => void;
  /** 发起成功回调：把生成的 MRB 单号回传给主页面（刷新列表 + 提示） */
  onInitiated: (mrbNo: string) => void;
}

export function InitiateReviewDrawer({ open, onClose, onInitiated }: InitiateReviewDrawerProps) {
  const [items, setItems] = useState<PendingDefectItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [keyword, setKeyword] = useState('');
  const [stage, setStage] = useState('');
  const [poolStatus, setPoolStatus] = useState('PENDING_INITIATE');

  const [flows, setFlows] = useState<ReviewFlowOption[]>([]);
  const [selectedFlowId, setSelectedFlowId] = useState('');
  const [flawedFlows, setFlowLoadFailed] = useState(false);

  const [selectedItem, setSelectedItem] = useState<PendingDefectItem | null>(null);
  const [urgencyLevel, setUrgencyLevel] = useState<'NORMAL' | 'URGENT' | 'CRITICAL'>('NORMAL');
  const [reviewNotes, setReviewNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [printOrderNo, setPrintOrderNo] = useState<string | null>(null);

  const loadPool = useCallback(async () => {
    setLoading(true);
    try {
      const query: Record<string, string | number | undefined> = {
        page: 1,
        pageSize: POOL_PAGE_SIZE,
      };
      if (stage !== '') query.stage = stage;
      if (poolStatus !== '') query.status = poolStatus;
      const res = await api.get<PendingPoolResponse>('/mrb/pending-pool', query);
      setItems(res.items ?? res.list ?? []);
      setLoadError(null);
    } catch (err) {
      setItems([]);
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [stage, poolStatus]);

  useEffect(() => {
    if (!open) return;
    void loadPool();
  }, [open, loadPool]);

  // 评审流程定义：取真实接口；取不到就不猜流程（flowId 在契约中为可选，省略即按不合格类型自动匹配）
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const loadFlows = async () => {
      try {
        const res = await api.get<{ items?: ReviewFlowOption[] } | ReviewFlowOption[]>('/review-flows');
        const list = Array.isArray(res) ? res : res.items ?? [];
        if (cancelled) return;
        setFlows(list.filter((flow) => flow.id !== undefined));
        setFlowLoadFailed(false);
        if (list.length > 0) {
          setSelectedFlowId(list[0]?.id ?? '');
        }
      } catch {
        if (cancelled) return;
        setFlows([]);
        setFlowLoadFailed(true);
      }
    };
    void loadFlows();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const filteredItems = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (kw === '') return items;
    return items.filter((item) => {
      const haystack = `${item.orderNo} ${item.batchNo} ${item.materialName} ${item.materialCode}`.toLowerCase();
      return haystack.includes(kw);
    });
  }, [items, keyword]);

  const openInitiateModal = (item: PendingDefectItem) => {
    setSelectedItem(item);
    setUrgencyLevel('NORMAL');
    setSubmitError(null);
    setReviewNotes(
      `针对检验单 [${item.orderNo}] 批次 [${item.batchNo}] 不合格项发起独立评审。不合格描述: ${item.defectDescription}`
    );
  };

  const handleSubmitInitiate = async () => {
    if (selectedItem === null) return;
    try {
      setSubmitting(true);
      setSubmitError(null);
      const res = await api.post<{ mrbNo?: string; id?: string }>('/mrb/pending-pool/initiate', {
        pendingDefectId: selectedItem.id,
        ...(selectedFlowId !== '' ? { flowId: selectedFlowId } : {}),
        urgencyLevel,
        ...(reviewNotes.trim() !== '' ? { reviewNotes: reviewNotes.trim() } : {}),
      });
      const mrbNo = res.mrbNo ?? selectedItem.orderNo;
      setSelectedItem(null);
      onInitiated(mrbNo);
      void loadPool();
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
        onClick={onClose}
        role="presentation"
      />

      <div className="relative h-full w-full max-w-7xl bg-[#F5F7FA] shadow-2xl flex flex-col">
        {/* 抽屉头部 */}
        <div className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <span className="p-2 bg-rose-50 text-rose-600 border border-rose-200 rounded-xl">
              <ShieldAlert className="w-5 h-5" />
            </span>
            <div>
              <h3 className="text-base font-bold text-slate-900">不合格待审核池</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                各检验环节独立不合并 · 集中入池待审 · 逐条人工发起 MRB 评审
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 抽屉内容 */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* 筛选条 */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <label className="block md:col-span-2">
                <span className="block text-xs font-medium text-slate-600 mb-1.5">
                  关键字（检验单号 / 批次号 / 物料）
                </span>
                <input
                  type="text"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="如 IQC-20260706-0002 或 OQC-SF-20260706-0001"
                  className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 placeholder-slate-400 focus:outline-none focus:border-blue-500"
                />
              </label>
              <label className="block">
                <span className="block text-xs font-medium text-slate-600 mb-1.5">检验环节</span>
                <select
                  value={stage}
                  onChange={(e) => setStage(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-blue-500"
                >
                  <option value="">全部环节</option>
                  <option value="IQC">来料检验 (IQC)</option>
                  <option value="IPQC">过程检验 (IPQC)</option>
                  <option value="FQC">成品检验 (FQC)</option>
                  <option value="OQC">出货检验 (OQC)</option>
                </select>
              </label>
              <label className="block">
                <span className="block text-xs font-medium text-slate-600 mb-1.5">池状态</span>
                <select
                  value={poolStatus}
                  onChange={(e) => setPoolStatus(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-blue-500"
                >
                  <option value="PENDING_INITIATE">待发起评审</option>
                  <option value="INITIATED">已入评审</option>
                  <option value="">全部状态</option>
                </select>
              </label>
            </div>
            <div className="flex items-center justify-between mt-3.5">
              <span className="text-xs text-slate-400">
                共 {filteredItems.length} 条待审不合格记录
              </span>
              <button
                type="button"
                onClick={() => void loadPool()}
                disabled={loading}
                className="px-3.5 py-1.5 text-xs text-slate-600 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 flex items-center gap-1.5 transition-colors"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                <span>刷新待审池</span>
              </button>
            </div>
          </div>

          {loadError !== null && (
            <div className="bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl px-4 py-3">
              待审核池加载失败：{loadError}
            </div>
          )}

          {/* 待审清单 */}
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50 text-slate-500 border-b border-slate-100">
                    <th className="py-3 px-4 font-semibold">检验单号 / 环节</th>
                    <th className="py-3 px-4 font-semibold">物料品类与编码</th>
                    <th className="py-3 px-4 font-semibold">炉批号</th>
                    <th className="py-3 px-4 font-semibold text-center whitespace-nowrap">不合格数 / 抽样数</th>
                    <th className="py-3 px-4 font-semibold text-center">不良率</th>
                    <th className="py-3 px-4 font-semibold">超差项目与判定原因</th>
                    <th className="py-3 px-4 font-semibold text-center whitespace-nowrap">池状态</th>
                    <th className="py-3 px-4 font-semibold text-center whitespace-nowrap">发现时间</th>
                    <th className="py-3 px-4 font-semibold text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredItems.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="text-center py-14 text-slate-400">
                        <CheckCircle2 className="w-8 h-8 mx-auto text-emerald-400 mb-2" />
                        {loading
                          ? '正在加载待审核池…'
                          : '当前条件下没有待审不合格记录，各环节检验均合格或已完成评审发起'}
                      </td>
                    </tr>
                  ) : (
                    filteredItems.map((item) => {
                      const isInitiated = item.status === 'INITIATED';
                      const stageColor =
                        item.inspectionType === 'IQC'
                          ? 'bg-blue-50 text-blue-700 border-blue-200'
                          : item.inspectionType === 'IPQC'
                            ? 'bg-amber-50 text-amber-700 border-amber-200'
                            : 'bg-emerald-50 text-emerald-700 border-emerald-200';
                      return (
                        <tr key={item.id} className="hover:bg-slate-50/80 transition-colors">
                          <td className="py-3 px-4">
                            <div className="font-mono font-bold text-slate-800">{item.orderNo}</div>
                            <div className="mt-1">
                              <span
                                className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold border ${stageColor}`}
                              >
                                {item.inspectionType}
                              </span>
                            </div>
                          </td>
                          <td className="py-3 px-4">
                            <div className="font-semibold text-slate-800">{item.materialName}</div>
                            <div className="text-[11px] text-slate-400 font-mono">
                              {item.materialCode}
                            </div>
                            {item.supplierName !== undefined && (
                              <div className="text-[10px] text-slate-500 mt-0.5">
                                供应商: {item.supplierName}
                              </div>
                            )}
                            {item.customerName !== undefined && (
                              <div className="text-[10px] text-slate-500 mt-0.5">
                                客户: {item.customerName}
                              </div>
                            )}
                          </td>
                          <td className="py-3 px-4 font-mono text-slate-600">{item.batchNo}</td>
                          <td className="py-3 px-4 text-center font-mono text-slate-700">
                            <span className="font-bold text-rose-600">{item.defectQty}</span>
                            <span className="text-slate-400"> / {item.totalQty}</span>
                          </td>
                          <td className="py-3 px-4 text-center font-bold font-mono text-rose-600">
                            {((item.defectQty / (item.totalQty || 1)) * 100).toFixed(1)}%
                          </td>
                          <td className="py-3 px-4 max-w-xs">
                            <div
                              className="text-rose-700 font-medium truncate"
                              title={item.defectDescription}
                            >
                              {item.defectDescription}
                            </div>
                            {item.defectItemCode !== undefined && (
                              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                                指标项: {item.defectItemCode}
                              </div>
                            )}
                          </td>
                          <td className="py-3 px-4 text-center">
                            {isInitiated ? (
                              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-purple-50 text-purple-700 border border-purple-200 rounded-full text-[11px] font-semibold whitespace-nowrap">
                                <Clock className="w-3 h-3" />
                                已入评审
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-rose-50 text-rose-700 border border-rose-200 rounded-full text-[11px] font-semibold whitespace-nowrap">
                                <AlertCircle className="w-3 h-3" />
                                待发起评审
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-4 text-center text-slate-400 text-[11px] font-mono">
                            {item.createdAt.slice(0, 16).replace('T', ' ')}
                          </td>
                          <td className="py-3 px-4 text-right space-x-2 whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => setPrintOrderNo(item.orderNo)}
                              className="px-2.5 py-1 text-slate-500 hover:text-slate-800 border border-slate-200 hover:bg-slate-100 rounded-lg text-xs transition-colors"
                            >
                              质检凭单
                            </button>
                            {!isInitiated && (
                              <button
                                type="button"
                                onClick={() => openInitiateModal(item)}
                                className="px-3 py-1 font-bold text-white bg-rose-600 hover:bg-rose-700 rounded-lg text-xs shadow-sm transition-colors inline-flex items-center gap-1"
                              >
                                <Send className="w-3 h-3" />
                                <span>发起评审</span>
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* 发起评审弹窗 */}
        {selectedItem !== null && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 overflow-y-auto">
            <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-xl overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/60">
                <div className="flex items-center gap-2.5">
                  <span className="p-2 bg-rose-50 text-rose-600 border border-rose-200 rounded-xl">
                    <ShieldAlert className="w-5 h-5" />
                  </span>
                  <div>
                    <h3 className="text-base font-bold text-slate-900">发起独立 MRB 不合格品评审</h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      为该检验单生成独立闭环评审工单，并指派对应会签流程
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedItem(null)}
                  className="p-1 text-slate-400 hover:text-slate-600 rounded-lg"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-6 space-y-4">
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 text-xs space-y-1.5">
                  <div className="flex flex-wrap justify-between items-center gap-2 text-slate-600">
                    <span>
                      源检验单:{' '}
                      <strong className="font-mono text-slate-900">{selectedItem.orderNo}</strong>
                    </span>
                    <span>
                      检验环节: <strong className="text-blue-700">{selectedItem.inspectionType}</strong>
                    </span>
                    <span>
                      炉批号:{' '}
                      <strong className="font-mono text-slate-900">{selectedItem.batchNo}</strong>
                    </span>
                  </div>
                  <div className="text-slate-700">
                    物料品名: <strong>{selectedItem.materialName}</strong> ({selectedItem.materialCode})
                  </div>
                  <div className="text-rose-700 font-medium">
                    不合格描述: {selectedItem.defectDescription}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="text-xs font-bold text-slate-700 flex items-center justify-between">
                    <span>选用评审流程定义</span>
                    <span className="text-[11px] text-slate-400 font-normal">
                      根据超差严重程度指定流程
                    </span>
                  </div>
                  {flows.length === 0 ? (
                    <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                      {flowUnavailableHint(flawedFlows)}
                    </div>
                  ) : (
                    <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                      {flows.map((flow) => {
                        const isSelected = flow.id === selectedFlowId;
                        return (
                          <div
                            key={flow.id}
                            onClick={() => setSelectedFlowId(flow.id)}
                            role="presentation"
                            className={`p-3 rounded-xl border text-xs cursor-pointer transition-all ${
                              isSelected
                                ? 'border-blue-500 bg-blue-50/60 ring-1 ring-blue-500/30'
                                : 'border-slate-200 hover:border-slate-300 bg-white'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-semibold text-slate-900">{flow.flowName}</span>
                              <span className="font-mono text-[10px] text-slate-400 shrink-0">
                                {flow.flowCode}
                              </span>
                            </div>
                            {flow.description !== undefined && (
                              <p className="text-[11px] text-slate-500 mt-1">{flow.description}</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="space-y-1.5">
                  <div className="text-xs font-bold text-slate-700">紧急程度</div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    {(
                      [
                        { value: 'NORMAL', label: '普通 (常规排期)' },
                        { value: 'URGENT', label: '紧急 (24小时内)' },
                        { value: 'CRITICAL', label: '特急 (停线级)' },
                      ] as const
                    ).map((option) => (
                      <label
                        key={option.value}
                        className={`p-2 rounded-xl border flex items-center gap-2 cursor-pointer transition-colors ${
                          urgencyLevel === option.value
                            ? 'border-blue-500 bg-blue-50/70 font-bold text-slate-900'
                            : 'border-slate-200 text-slate-600 hover:border-slate-300'
                        }`}
                      >
                        <input
                          type="radio"
                          name="mrb-urgency"
                          checked={urgencyLevel === option.value}
                          onChange={() => setUrgencyLevel(option.value)}
                          className="text-blue-600"
                        />
                        <span>{option.label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="text-xs font-bold text-slate-700">
                    发起说明 / 初步建议处置方向
                  </div>
                  <textarea
                    rows={3}
                    value={reviewNotes}
                    onChange={(e) => setReviewNotes(e.target.value)}
                    placeholder="填写初步判定依据或建议处置方案（如：建议退货、降级使用或提请特采让步）..."
                    className="w-full border border-slate-200 rounded-xl p-3 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
                  />
                </div>

                {submitError !== null && (
                  <div className="bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl px-3 py-2">
                    发起评审失败：{submitError}
                  </div>
                )}
              </div>

              <div className="px-6 py-4 border-t border-slate-100 bg-slate-50/70 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setSelectedItem(null)}
                  className="px-4 py-2 text-xs text-slate-600 hover:text-slate-800 border border-slate-200 rounded-xl hover:bg-slate-100"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void handleSubmitInitiate()}
                  disabled={submitting}
                  className="px-5 py-2 text-xs font-bold text-white bg-rose-600 hover:bg-rose-700 rounded-xl shadow-sm flex items-center gap-1.5 disabled:opacity-50"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>{submitting ? '提交发起中...' : '确认发起独立评审'}</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <PrintTemplateModal
        open={printOrderNo !== null}
        onClose={() => setPrintOrderNo(null)}
        orderNo={printOrderNo ?? ''}
      />
    </div>
  );
}

/** 流程定义取不到时的显式提示：绝不猜测流程，交由后端按不合格类型自动匹配 */
function flowUnavailableHint(loadFailed: boolean): string {
  return loadFailed
    ? '评审流程定义加载失败（GET /review-flows），本次发起将不指定流程，由后端按不合格类型自动匹配生效流程。'
    : '尚未配置评审流程定义，本次发起将不指定流程，由后端按不合格类型自动匹配生效流程。';
}
