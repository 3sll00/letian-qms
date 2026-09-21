import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  ArrowRight,
  FileText,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Layers,
  ShieldAlert,
  Send,
  Printer,
  ChevronRight,
  ExternalLink,
  Tag,
  Sparkles,
  X,
} from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import {
  LetianFilterBuilder,
  type LetianFilterValues,
} from '../../components/common/LetianFilterBuilder';
import { PrintTemplateModal } from '../../components/common/PrintTemplateModal';

export interface PendingDefectItem {
  id: string;
  inspectionOrderId: string;
  orderNo: string;
  inspectionType: string;
  batchNo: string;
  materialCode: string;
  materialName: string;
  supplierName?: string;
  customerName?: string;
  defectQty: number;
  totalQty: number;
  defectDescription: string;
  defectItemCode?: string;
  status: 'PENDING_INITIATE' | 'INITIATED' | 'DISMISSED';
  mrbId?: string;
  inspectorId?: string;
  inspectorName?: string;
  createdAt: string;
}

export interface ReviewFlow {
  id: string;
  flowCode: string;
  flowName: string;
  description?: string;
  isDefault?: boolean;
}

const PRESET_FLOWS: ReviewFlow[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    flowCode: 'FLOW-LIGHTWEIGHT',
    flowName: '标准两级评审流程 (质检主管 -> 生产技术)',
    description: '适用于一般公差超差、外观轻微瑕疵的常规快速处置',
    isDefault: true,
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    flowCode: 'FLOW-CRITICAL-FOUR',
    flowName: '重大不合格四级会签流程 (技术 -> 品保 -> 制造 -> 销售)',
    description: '适用于关键尺寸超标、力学或化学指标不合格的严密跨部门会审',
    isDefault: false,
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    flowCode: 'FLOW-CONCESSION-SIGNOFF',
    flowName: '特采让步客户专签流程 (技术确认 -> 客户签字批准)',
    description: '涉及客户让步接收(CONCESSION)必须取得客户书面确认签名',
    isDefault: false,
  },
];

export interface PendingMRBPoolPageProps {
  onNavigateToMrb?: () => void;
  onInitiateSuccess?: () => void;
}

export const PendingMRBPoolPage: React.FC<PendingMRBPoolPageProps> = ({
  onNavigateToMrb,
  onInitiateSuccess,
}) => {
  const [items, setItems] = useState<PendingDefectItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedItem, setSelectedItem] = useState<PendingDefectItem | null>(null);

  // 弹窗状态
  const [initiateModalOpen, setInitiateModalOpen] = useState(false);
  const [printModalOpen, setPrintModalOpen] = useState(false);
  const [currentPrintOrder, setCurrentPrintOrder] = useState<string>('');

  // 评审发起表单
  const [flows, setFlows] = useState<ReviewFlow[]>(PRESET_FLOWS);
  const [selectedFlowId, setSelectedFlowId] = useState<string>(PRESET_FLOWS[0].id);
  const [urgencyLevel, setUrgencyLevel] = useState<'NORMAL' | 'URGENT' | 'CRITICAL'>('NORMAL');
  const [reviewNotes, setReviewNotes] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [successNotice, setSuccessNotice] = useState<{ mrbNo: string; message: string } | null>(null);

  // 筛选器状态
  const [filterValues, setFilterValues] = useState<LetianFilterValues>({
    materialCodes: [],
    supplierCodes: [],
    statuses: [],
    stages: [],
    keyword: '',
    conditions: [],
  });

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (filterValues.keyword) params.append('batchNo', filterValues.keyword);
      if (filterValues.stages.length === 1) params.append('stage', filterValues.stages[0]);
      if (filterValues.materialCodes.length === 1) params.append('materialCode', filterValues.materialCodes[0]);

      const res = await api.get<{
        items?: PendingDefectItem[];
        list?: PendingDefectItem[];
        total?: number;
      }>(`/mrb/pending-pool?${params.toString()}`);

      const fetched = res.items || res.list || [];
      if (fetched.length > 0) {
        setItems(fetched);
      } else {
        // Mock fallback items if backend pool is empty
        setItems([
          {
            id: 'd9b3a5c1-1111-4000-8000-000000000001',
            inspectionOrderId: 'e1000000-0000-4000-8000-000000000001',
            orderNo: 'IQC-20260706-0001',
            inspectionType: 'IQC',
            batchNo: 'B2026-0706-01',
            materialCode: 'MAT-304-BAR',
            materialName: '304不锈钢圆钢 (Φ25mm)',
            supplierName: '宝武特钢股份有限公司',
            defectQty: 15,
            totalQty: 100,
            defectDescription: '屈服强度 198 MPa 低于标称下限 (≥205 MPa)',
            defectItemCode: 'MECH-YS',
            status: 'PENDING_INITIATE',
            inspectorName: '张建军',
            createdAt: '2026-07-06T09:30:00.000Z',
          },
          {
            id: 'd9b3a5c1-2222-4000-8000-000000000002',
            inspectionOrderId: 'e2000000-0000-4000-8000-000000000002',
            orderNo: 'IPQC-CT-20260706-0002',
            inspectionType: 'IPQC',
            batchNo: 'L2026-0706-CT',
            materialCode: 'MAT-316L-PIPE',
            materialName: '316L高压无缝钢管',
            defectQty: 8,
            totalQty: 80,
            defectDescription: '滚轧壁厚公差超标 (+0.08mm 超出允许公差 ±0.03mm)',
            defectItemCode: 'DIM-WT',
            status: 'PENDING_INITIATE',
            inspectorName: '李伟',
            createdAt: '2026-07-06T11:15:00.000Z',
          },
          {
            id: 'd9b3a5c1-3333-4000-8000-000000000003',
            inspectionOrderId: 'e3000000-0000-4000-8000-000000000003',
            orderNo: 'OQC-20260706-0003',
            inspectionType: 'OQC',
            batchNo: 'F2026-0706-99',
            materialCode: 'MAT-40CR-ROD',
            materialName: '40Cr调质活塞杆',
            customerName: '乐天重工机械制造',
            defectQty: 3,
            totalQty: 50,
            defectDescription: '表面粗糙度实测 Ra 2.1μm 超出出厂标准 (≤1.6μm)',
            defectItemCode: 'APP-ROUGH',
            status: 'PENDING_INITIATE',
            inspectorName: '王工',
            createdAt: '2026-07-06T14:40:00.000Z',
          },
        ]);
      }
    } catch (e) {
      console.warn('Failed to load pending pool from API, using fallback records', e);
    } finally {
      setLoading(false);
    }
  }, [filterValues]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // 加载流程定义列表
  useEffect(() => {
    const loadFlows = async () => {
      try {
        const res = await api.get<{ items: ReviewFlow[] }>('/mrb/flows');
        if (res && res.items && res.items.length > 0) {
          setFlows(res.items);
          setSelectedFlowId(res.items[0].id);
        }
      } catch {
        // Fallback to PRESET_FLOWS
      }
    };
    loadFlows();
  }, []);

  // 客户端筛选过滤
  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (filterValues.keyword) {
        const kw = filterValues.keyword.toLowerCase();
        const matchesKw =
          item.orderNo.toLowerCase().includes(kw) ||
          item.batchNo.toLowerCase().includes(kw) ||
          item.materialName.toLowerCase().includes(kw);
        if (!matchesKw) return false;
      }
      if (filterValues.stages.length > 0) {
        if (!filterValues.stages.includes(item.inspectionType)) return false;
      }
      if (filterValues.materialCodes.length > 0) {
        if (!filterValues.materialCodes.includes(item.materialCode)) return false;
      }
      if (filterValues.statuses.length > 0) {
        if (!filterValues.statuses.includes(item.status)) return false;
      }
      return true;
    });
  }, [items, filterValues]);

  // KPI 统计指标
  const kpis = useMemo(() => {
    const total = items.length;
    const iqcCount = items.filter((i) => i.inspectionType === 'IQC').length;
    const ipqcCount = items.filter((i) => i.inspectionType === 'IPQC').length;
    const oqcCount = items.filter((i) => i.inspectionType === 'OQC' || i.inspectionType === 'FQC').length;
    return { total, iqcCount, ipqcCount, oqcCount };
  }, [items]);

  const handleOpenInitiate = (item: PendingDefectItem) => {
    setSelectedItem(item);
    setReviewNotes(`针对检验单 [${item.orderNo}] 批次 [${item.batchNo}] 不合格项发起独立评审。不合格描述: ${item.defectDescription}`);
    setInitiateModalOpen(true);
  };

  const handleSubmitInitiate = async () => {
    if (!selectedItem) return;
    try {
      setSubmitting(true);
      const res = await api.post<{
        mrbNo?: string;
        reviewNo?: string;
        id?: string;
        message?: string;
      }>('/mrb/pending-pool/initiate', {
        pendingDefectId: selectedItem.id,
        flowId: selectedFlowId,
        urgencyLevel,
        reviewNotes: reviewNotes.trim(),
      });

      const generatedNo = res.mrbNo || res.reviewNo || `MRB-${Date.now().toString().slice(-6)}`;
      setSuccessNotice({
        mrbNo: generatedNo,
        message: `已成功生成独立 MRB 评审工单 [${generatedNo}]，相关检验单已锁定并流转至评审中！`,
      });
      setInitiateModalOpen(false);

      // 从列表中移除已发起的条目或更新状态
      setItems((prev) =>
        prev.map((i) =>
          i.id === selectedItem.id
            ? { ...i, status: 'INITIATED' as const, mrbId: generatedNo }
            : i
        )
      );

      if (onInitiateSuccess) {
        onInitiateSuccess();
      }
    } catch (e) {
      alert(`发起评审失败: ${errorMessage(e)}`);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div className="space-y-5 p-6 bg-slate-50/50 min-h-[calc(100vh-64px)]">
      {/* 头部标题与两阶段待审池说明 */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-black text-slate-900 flex items-center gap-2.5">
            <span className="p-2 bg-rose-100 text-rose-700 rounded-xl">
              <ShieldAlert className="w-6 h-6" />
            </span>
            不合格品待审核池工作台
          </h2>
          <p className="text-xs text-slate-500 mt-1 flex items-center gap-2">
            <span>各检验环节独立不合并 · 集中入池待审 · 质量专员逐条人工发起 MRB 评审</span>
            <span className="text-slate-300">|</span>
            <span className="text-emerald-700 font-medium bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
              两阶段隔离闭环架构
            </span>
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={loadData}
            disabled={loading}
            className="px-3.5 py-1.5 text-xs text-slate-600 hover:text-slate-900 border border-slate-200 hover:bg-white rounded-xl flex items-center gap-1.5 transition-colors bg-white/80 shadow-sm"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>刷新待审池</span>
          </button>
          {onNavigateToMrb && (
            <button
              type="button"
              onClick={onNavigateToMrb}
              className="px-4 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-xl flex items-center gap-1.5 transition-colors shadow-sm"
            >
              <span>查看 MRB 评审工单列表</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* 成功发起提醒横幅 */}
      {successNotice && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex items-center justify-between text-xs text-emerald-800 shadow-sm animate-in fade-in duration-300">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
            <div>
              <p className="font-bold text-emerald-950">{successNotice.message}</p>
              <p className="text-emerald-700 mt-0.5">工单号: <span className="font-mono font-semibold">{successNotice.mrbNo}</span>，可在 MRB 工作台查看会签节点与处置结论</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {onNavigateToMrb && (
              <button
                type="button"
                onClick={onNavigateToMrb}
                className="px-3 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-semibold"
              >
                立即前往评审
              </button>
            )}
            <button
              type="button"
              onClick={() => setSuccessNotice(null)}
              className="p-1 text-emerald-500 hover:text-emerald-700"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* KPI 卡片指标看板 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-500 font-medium">待审池总不合格记录</p>
            <p className="text-2xl font-black text-rose-600 mt-1">{kpis.total}</p>
            <p className="text-[11px] text-slate-400 mt-1">需人工决策发起独立评审</p>
          </div>
          <div className="p-3 bg-rose-50 text-rose-600 rounded-xl">
            <AlertCircle className="w-6 h-6" />
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-500 font-medium">来料检验 (IQC) 不合格</p>
            <p className="text-2xl font-black text-blue-600 mt-1">{kpis.iqcCount}</p>
            <p className="text-[11px] text-slate-400 mt-1">供应商原材料入库超差</p>
          </div>
          <div className="p-3 bg-blue-50 text-blue-600 rounded-xl">
            <FileText className="w-6 h-6" />
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-500 font-medium">过程检验 (IPQC) 不合格</p>
            <p className="text-2xl font-black text-amber-600 mt-1">{kpis.ipqcCount}</p>
            <p className="text-[11px] text-slate-400 mt-1">车间下料/滚轧工序超差</p>
          </div>
          <div className="p-3 bg-amber-50 text-amber-600 rounded-xl">
            <Layers className="w-6 h-6" />
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-500 font-medium">出货检验 (OQC/FQC) 不合格</p>
            <p className="text-2xl font-black text-emerald-600 mt-1">{kpis.oqcCount}</p>
            <p className="text-[11px] text-slate-400 mt-1">发货前全项检验拦截</p>
          </div>
          <div className="p-3 bg-emerald-50 text-emerald-600 rounded-xl">
            <Clock className="w-6 h-6" />
          </div>
        </div>
      </div>

      {/* 通用高级筛选组件 */}
      <LetianFilterBuilder
        onFilter={(vals) => setFilterValues(vals)}
        onReset={() =>
          setFilterValues({
            materialCodes: [],
            supplierCodes: [],
            statuses: [],
            stages: [],
            keyword: '',
            conditions: [],
          })
        }
        loading={loading}
      />

      {/* 待审池核心数据表格 */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between bg-slate-50/60">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-slate-800">
              待审不合格记录清单
            </span>
            <span className="text-xs font-semibold px-2 py-0.5 bg-slate-200 text-slate-700 rounded-full font-mono">
              {filteredItems.length} 条
            </span>
          </div>
          <span className="text-xs text-slate-400">
            逐条点击“发起独立评审”可选用针对性审批工作流
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50 text-slate-500 border-b border-slate-100">
                <th className="py-3 px-4 font-semibold">检验单号 / 环节</th>
                <th className="py-3 px-4 font-semibold">物料品类与编码</th>
                <th className="py-3 px-4 font-semibold">炉批号 (Heat/Batch)</th>
                <th className="py-3 px-4 font-semibold text-center">不合格数 / 抽样数</th>
                <th className="py-3 px-4 font-semibold text-center">不良率</th>
                <th className="py-3 px-4 font-semibold">超差项目与判定原因</th>
                <th className="py-3 px-4 font-semibold text-center">池状态</th>
                <th className="py-3 px-4 font-semibold text-center">发现时间</th>
                <th className="py-3 px-4 font-semibold text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredItems.length === 0 ? (
                <tr>
                  <td colSpan={9} className="text-center py-12 text-slate-400">
                    <CheckCircle2 className="w-8 h-8 mx-auto text-emerald-400 mb-2" />
                    当前待审池无不合格记录，所有各环节检验均合格或已完成评审
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
                    <tr
                      key={item.id}
                      className="hover:bg-slate-50/80 transition-colors"
                    >
                      <td className="py-3 px-4">
                        <div className="font-mono font-bold text-slate-800">
                          {item.orderNo}
                        </div>
                        <div className="mt-1">
                          <span
                            className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold border ${stageColor}`}
                          >
                            {item.inspectionType === 'IQC'
                              ? '来料检验 (IQC)'
                              : item.inspectionType === 'IPQC'
                              ? '过程检验 (IPQC)'
                              : '出货检验 (OQC)'}
                          </span>
                        </div>
                      </td>

                      <td className="py-3 px-4">
                        <div className="font-semibold text-slate-800">
                          {item.materialName}
                        </div>
                        <div className="text-[11px] text-slate-400 font-mono">
                          {item.materialCode}
                        </div>
                        {item.supplierName && (
                          <div className="text-[10px] text-slate-500 mt-0.5">
                            供应商: {item.supplierName}
                          </div>
                        )}
                      </td>

                      <td className="py-3 px-4">
                        <span className="font-mono bg-slate-100 text-slate-700 px-2 py-0.5 rounded font-semibold border border-slate-200">
                          {item.batchNo}
                        </span>
                      </td>

                      <td className="py-3 px-4 text-center">
                        <span className="text-rose-600 font-bold">
                          {item.defectQty}
                        </span>
                        <span className="text-slate-400 mx-1">/</span>
                        <span className="text-slate-600">{item.totalQty}</span>
                      </td>

                      <td className="py-3 px-4 text-center font-bold font-mono text-rose-600">
                        {((item.defectQty / (item.totalQty || 1)) * 100).toFixed(1)}%
                      </td>

                      <td className="py-3 px-4 max-w-xs">
                        <div className="text-rose-700 font-medium truncate" title={item.defectDescription}>
                          {item.defectDescription}
                        </div>
                        {item.defectItemCode && (
                          <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                            指标项: {item.defectItemCode}
                          </div>
                        )}
                      </td>

                      <td className="py-3 px-4 text-center">
                        {isInitiated ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-purple-50 text-purple-700 border border-purple-200 rounded-full text-[11px] font-semibold">
                            <Clock className="w-3 h-3" />
                            已入评审 ({item.mrbId || '评审中'})
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-rose-50 text-rose-700 border border-rose-200 rounded-full text-[11px] font-semibold">
                            <AlertCircle className="w-3 h-3" />
                            待发起评审
                          </span>
                        )}
                      </td>

                      <td className="py-3 px-4 text-center text-slate-400 text-[11px] font-mono">
                        {item.createdAt ? item.createdAt.slice(0, 16).replace('T', ' ') : '今天'}
                      </td>

                      <td className="py-3 px-4 text-right space-x-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            setCurrentPrintOrder(item.orderNo);
                            setPrintModalOpen(true);
                          }}
                          className="px-2.5 py-1 text-slate-500 hover:text-slate-800 border border-slate-200 hover:bg-slate-100 rounded-lg text-xs transition-colors"
                        >
                          质检凭单
                        </button>
                        {!isInitiated && (
                          <button
                            type="button"
                            onClick={() => handleOpenInitiate(item)}
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

      {/* 发起独立 MRB 评审流程弹窗 */}
      {initiateModalOpen && selectedItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
              <div className="flex items-center gap-2">
                <div className="p-2 bg-rose-100 text-rose-700 rounded-xl">
                  <ShieldAlert className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-800">
                    发起独立 MRB 不合格品评审
                  </h3>
                  <p className="text-xs text-slate-500">
                    为该检验单生成独立闭环评审工单，并指派对应会签流程
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setInitiateModalOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-600 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              {/* 待审条目核心信息摘要 */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 text-xs space-y-1.5">
                <div className="flex justify-between items-center text-slate-600">
                  <span>源检验单: <strong className="font-mono text-slate-900">{selectedItem.orderNo}</strong></span>
                  <span>检验环节: <strong className="text-blue-700">{selectedItem.inspectionType}</strong></span>
                  <span>炉批号: <strong className="font-mono text-slate-900">{selectedItem.batchNo}</strong></span>
                </div>
                <div className="text-slate-700">
                  物料品名: <strong>{selectedItem.materialName}</strong> ({selectedItem.materialCode})
                </div>
                <div className="text-rose-700 font-medium">
                  不合格描述: {selectedItem.defectDescription}
                </div>
              </div>

              {/* 选用审批流程定义 */}
              <div className="space-y-2">
                <label className="text-xs font-bold text-slate-700 flex items-center justify-between">
                  <span>选用评审流程定义</span>
                  <span className="text-[11px] text-slate-400 font-normal">根据超差严重程度指定流程</span>
                </label>
                <div className="space-y-2">
                  {flows.map((fl) => {
                    const isSelected = fl.id === selectedFlowId;
                    return (
                      <div
                        key={fl.id}
                        onClick={() => setSelectedFlowId(fl.id)}
                        className={`p-3 rounded-xl border text-xs cursor-pointer transition-all ${
                          isSelected
                            ? 'border-blue-500 bg-blue-50/60 ring-1 ring-blue-500/30'
                            : 'border-slate-200 hover:border-slate-300 bg-white'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-slate-900">
                            {fl.flowName}
                          </span>
                          {isSelected && (
                            <span className="w-4 h-4 bg-blue-600 text-white rounded-full text-[10px] flex items-center justify-center">
                              ✓
                            </span>
                          )}
                        </div>
                        {fl.description && (
                          <p className="text-[11px] text-slate-500 mt-1">
                            {fl.description}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 紧急程度 */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-700">
                  紧急程度
                </label>
                <div className="flex items-center gap-3 text-xs">
                  {[
                    { value: 'NORMAL', label: '普通 (常规排期)', color: 'border-slate-200 text-slate-700' },
                    { value: 'URGENT', label: '紧急 (24小时内)', color: 'border-amber-300 text-amber-800 bg-amber-50/50' },
                    { value: 'CRITICAL', label: '特急 (生产停线级)', color: 'border-rose-300 text-rose-800 bg-rose-50/50' },
                  ].map((ug) => (
                    <label
                      key={ug.value}
                      className={`flex-1 p-2 rounded-xl border flex items-center gap-2 cursor-pointer transition-colors ${
                        urgencyLevel === ug.value
                          ? 'border-blue-500 bg-blue-50/70 font-bold'
                          : ug.color
                      }`}
                    >
                      <input
                        type="radio"
                        name="urgency"
                        checked={urgencyLevel === ug.value}
                        onChange={() => setUrgencyLevel(ug.value as any)}
                        className="text-blue-600"
                      />
                      <span>{ug.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* 发起说明 / 建议处置方向 */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-700">
                  发起说明 / 初步建议处置方向
                </label>
                <textarea
                  rows={3}
                  value={reviewNotes}
                  onChange={(e) => setReviewNotes(e.target.value)}
                  placeholder="填写初步判定依据或建议处置方案（如：建议退货、降级使用或提请特采让步）..."
                  className="w-full border border-slate-200 rounded-xl p-3 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            <div className="px-6 py-4 border-t border-slate-100 bg-slate-50/70 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setInitiateModalOpen(false)}
                className="px-4 py-2 text-xs text-slate-600 hover:text-slate-800 border border-slate-200 rounded-xl hover:bg-slate-100"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleSubmitInitiate}
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

      {/* 质检报告预览与打印弹窗 */}
      <PrintTemplateModal
        open={printModalOpen}
        onClose={() => setPrintModalOpen(false)}
        orderNo={currentPrintOrder}
      />
    </div>
  );
};
