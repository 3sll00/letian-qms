import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ShieldCheck,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  Layers,
  FileText,
  Printer,
  RefreshCw,
  Search,
  RotateCcw,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Sliders,
  X
} from 'lucide-react';
import { CertificatePrintModal } from '../../../components/certificate/CertificatePrintModal';
import { PlanMatchBanner } from '../../../components/common/PlanMatchBanner';
import { buildIpqcCertificateData } from '../../../lib/certificateDataService';
import type { QualityCertificateData } from '../../../lib/inspectionTypes';
import { api, errorMessage } from '../../../lib/api';
import { loadCompanyProfile } from '../../../lib/companyProfile';
import { StatusBadge, BadgeTone } from '../../../components/StatusBadge';
import { useMatchedPlan } from '../../../hooks/useMatchedPlan';
import {
  DECISION_LABEL,
  decisionTone,
  judgeIndicatorRow,
  parseMeasuredNumber,
  summarizeJudgements,
  type PlanIndicatorRow,
} from '../../../lib/planMatch';
import type { InspectionType } from '@letian/contracts';

/**
 * 回看行的判定徽标样式。
 * 判定值域是契约的 PASSED / FAILED / PENDING / EXEMPT（**不是** FAIL），
 * 之前弹窗里写的是 `result === 'FAIL'`，导致不合格项一律显示成 OK —— 回看结论必须与落库判定一字不差。
 */
const DECISION_BADGE_CLASS: Record<ReturnType<typeof decisionTone>, string> = {
  pass: 'px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600 font-semibold text-[10px]',
  fail: 'px-1.5 py-0.5 rounded bg-rose-50 text-rose-600 font-semibold text-[10px]',
  pending: 'px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 font-semibold text-[10px]',
  exempt: 'px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 font-semibold text-[10px]',
};

export interface IpqcViewsProps {
  sub: 'overview' | 'blanking' | 'rolling' | 'finished';
  onChangeSub: (sub: 'overview' | 'blanking' | 'rolling' | 'finished') => void;
  onInspect: (item: any) => void;
}

interface OverviewGroupStats {
  total: number;
  pending: number;
  inspecting: number;
  passed: number;
  failed: number;
  passRate: number;
}

interface IpqcOverviewData {
  blanking: OverviewGroupStats;
  rolling: OverviewGroupStats;
  finished: OverviewGroupStats;
  summary: OverviewGroupStats;
  timestamp?: string;
}

interface InspectionItemData {
  id: string;
  orderNo: string;
  inspectionType: string;
  materialCode: string;
  materialName: string;
  specification?: string;
  unit?: string;
  batchNo?: string;
  workOrderNo?: string;
  sampleQty: number;
  totalQty?: number;
  passQty?: number;
  failQty?: number;
  status: string;
  judgment?: string;
  inspectorName?: string;
  /** 质量负责人签核人姓名（inspection_orders.approver_name，docs/35 §5）：未签核即空 */
  approverName?: string;
  /** 签核时间（inspection_orders.approved_at） */
  approvedAt?: string;
  createdAt: string;
  completedAt?: string;
  inspectionNotes?: string;
  isMandatoryGate?: boolean;
  processStep?: string;
  blankingLength?: number;
  threadSpec?: string;
  operatorName?: string;
  operatorId?: string;
  equipmentCode?: string;
  equipmentName?: string;
  inspectionTeam?: string;
  items?: Array<{
    itemCode: string;
    name: string;
    nominalValue?: number;
    measuredVal?: number;
    upperTolerance?: number;
    lowerTolerance?: number;
    standardRequirement?: string;
    unit?: string;
    result?: string;
  }>;
}

/**
 * 断料长度展示：`25.15` -> `25.15 mm`、`200` -> `200 mm`（整数不带小数，否则保留 1 位）。
 * 值为空/非法一律 `--`：下料检验台账「断料长度」列只认库列 blanking_length，不做字段间推导。
 */
export function formatBlankingLengthMm(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '--';
  const num = Number(value);
  if (!Number.isFinite(num)) return '--';
  return `${Number.isInteger(num) ? String(num) : num.toFixed(1)} mm`;
}

/**
 * 台账时间列展示：ISO8601(`2026-07-06T08:30:00.000Z`) -> `2026-07-06 08:30`。
 * 沿用本页既有的「直接截取 ISO 串」口径（与详情弹窗一致），解析不出来即 `--`，绝不回落到其它字段。
 */
export function formatLedgerDateTime(value: string | null | undefined): string {
  if (!value) return '--';
  const match = /^(\d{4}-\d{2}-\d{2})(?:T| )(\d{2}:\d{2})/.exec(value);
  return match ? `${match[1]} ${match[2]}` : '--';
}

export function formatIpqcStatus(status: string): { label: string; tone: BadgeTone } {
  const s = (status || '').toUpperCase();
  if (['PASSED', 'PASS', 'COMPLETED', 'QUALIFIED', '已合格', '合格'].includes(s)) {
    return { label: '已合格', tone: 'green' };
  }
  if (['FAILED', 'FAIL', 'REJECT', 'REJECTED', '不合格'].includes(s)) {
    return { label: '不合格', tone: 'red' };
  }
  if (['INSPECTING', 'RE_INSPECTING', 'IN_PROGRESS', '检验中'].includes(s)) {
    return { label: '检验中', tone: 'blue' };
  }
  if (['IN_MRB_REVIEW'].includes(s)) {
    return { label: 'MRB评审', tone: 'purple' };
  }
  return { label: '待检验', tone: 'amber' };
}

/** 过程检验台账三页代号：下料 / 滚丝 / 成品检 */
type IpQcLedgerSub = 'blanking' | 'rolling' | 'finished';

/** 台账列定义：表头与数据行共用同一份口径，杜绝「表头改了行没改」的口径漂移 */
interface IpQcLedgerColumn {
  key: string;
  title: string;
  /** 表头单元格附加样式（仅用于对齐） */
  thClass?: string;
  /** 数据单元格附加样式 */
  tdClass?: string;
  render: (row: InspectionItemData) => React.ReactNode;
}

interface IpQcLedgerHandlers {
  onOpenDetail: (row: InspectionItemData) => void;
  onOpenInspect: (row: InspectionItemData) => void;
  /** 行级证书入口（docs/35 §10 M9）：所有行可点，未录入的项留白 */
  onOpenCert: (row: InspectionItemData) => void;
}

const LEDGER_TH_CLASS = 'py-2.5 px-3 whitespace-nowrap';
const LEDGER_TD_CLASS = 'py-2.5 px-3';

/** 台账单元格取值：只认库字段本身，缺失（含空串）一律 `--`，绝不用其它字段顶替 */
const ledgerText = (value?: string | number | null): string | number =>
  value === undefined || value === null || value === '' ? '--' : value;

/**
 * 过程检验台账列集（三页各 11 列，见 docs/29 §2 下料 / docs/30 §2 滚丝·成品检）：
 *
 *   检验单号 | [★ 强制检关卡，仅成品检] | MES工单号 | 物料编码 | 物料名称 | 数量 |
 *   工序专有列… | 完成时间 | 状态 | [检验人，仅滚丝/成品检] | 操作
 *
 * 「工序专有列」是三页唯一的分叉点（其余列逐列同构）：
 *   - 下料检验：断料长度 · 操作员 · 设备
 *   - 滚丝检验：操作员 · 设备
 *   - 成品检  ：终检组
 *
 * 所有单元格一律直连库字段（order_no / work_order_no / material_code / material_name / total_qty /
 * blanking_length / operator_name / equipment_code / inspection_team / inspector_name / completed_at
 * 以及 is_mandatory_gate），缺值统一展示 `--`，**严禁**用 sampleQty 等其它字段推导假值。
 */
function buildIpqcLedgerColumns(sub: IpQcLedgerSub, handlers: IpQcLedgerHandlers): IpQcLedgerColumn[] {
  const columns: IpQcLedgerColumn[] = [
    {
      key: 'orderNo',
      title: '检验单号',
      tdClass: 'whitespace-nowrap',
      render: (row) => (
        <button
          type="button"
          onClick={() => handlers.onOpenDetail(row)}
          className="font-mono font-medium text-blue-600 hover:text-blue-800 hover:underline"
        >
          {row.orderNo}
        </button>
      ),
    },
  ];

  // 成品检专属：★ 强制检关卡标记列（物理列 is_mandatory_gate，设计图 WPS图片(7) 第 2 列）
  if (sub === 'finished') {
    columns.push({
      key: 'mandatoryGate',
      title: '★',
      thClass: 'text-center',
      tdClass: 'text-center',
      render: (row) => (
        <span
          className={row.isMandatoryGate ? 'font-bold text-amber-500' : 'text-slate-300'}
          title={row.isMandatoryGate ? '强制检关卡：未完成检验或判定不合格严禁入库流转' : '非强制检关卡'}
        >
          {row.isMandatoryGate ? '★' : '--'}
        </span>
      ),
    });
  }

  columns.push(
    {
      key: 'workOrderNo',
      title: 'MES工单号',
      tdClass: 'font-mono text-slate-700 whitespace-nowrap',
      render: (row) => <>{ledgerText(row.workOrderNo || row.batchNo)}</>,
    },
    {
      key: 'materialCode',
      title: '物料编码',
      tdClass: 'font-mono text-slate-700 whitespace-nowrap',
      render: (row) => <>{row.materialCode}</>,
    },
    {
      key: 'materialName',
      title: '物料名称',
      tdClass: 'text-slate-800 whitespace-nowrap',
      render: (row) => <>{row.materialName}</>,
    },
    {
      key: 'totalQty',
      title: '数量',
      tdClass: 'font-semibold text-slate-800 whitespace-nowrap',
      render: (row) => <>{ledgerText(row.totalQty)}</>,
    }
  );

  // 工序专有列：三页唯一的分叉点
  if (sub === 'blanking') {
    columns.push({
      key: 'blankingLength',
      title: '断料长度',
      tdClass: 'font-mono text-slate-800 whitespace-nowrap',
      render: (row) => <>{formatBlankingLengthMm(row.blankingLength)}</>,
    });
  }
  if (sub === 'blanking' || sub === 'rolling') {
    columns.push(
      {
        key: 'operatorName',
        title: '操作员',
        tdClass: 'text-slate-700 whitespace-nowrap',
        render: (row) => <>{ledgerText(row.operatorName)}</>,
      },
      {
        key: 'equipmentCode',
        title: '设备',
        tdClass: 'font-mono text-slate-700 whitespace-nowrap',
        render: (row) => <>{ledgerText(row.equipmentCode)}</>,
      }
    );
  }
  if (sub === 'finished') {
    columns.push({
      key: 'inspectionTeam',
      title: '终检组',
      tdClass: 'text-slate-700 whitespace-nowrap',
      render: (row) => <>{ledgerText(row.inspectionTeam)}</>,
    });
  }

  columns.push(
    {
      key: 'completedAt',
      title: '完成时间',
      tdClass: 'text-slate-500 whitespace-nowrap',
      render: (row) => <>{formatLedgerDateTime(row.completedAt)}</>,
    },
    {
      key: 'status',
      title: '状态',
      thClass: 'text-center',
      tdClass: 'text-center whitespace-nowrap',
      render: (row) => {
        const statusInfo = formatIpqcStatus(row.status);
        return <StatusBadge status={statusInfo.label} tone={statusInfo.tone} />;
      },
    }
  );

  // 「检验人」列只在滚丝 / 成品检出现：下料检验的设计图（原型 WPS图片(5)）为 11 列且不含检验人列
  if (sub !== 'blanking') {
    columns.push({
      key: 'inspectorName',
      title: '检验人',
      tdClass: 'text-slate-700 whitespace-nowrap',
      render: (row) => <>{ledgerText(row.inspectorName)}</>,
    });
  }

  columns.push(    {
      key: 'actions',
      title: '操作',
      thClass: 'text-center',
      tdClass: 'text-center whitespace-nowrap',
      render: (row) => {
        // 操作列文案按状态分派（逐页对齐设计图）：待检验 -> 检验；成品检「检验中」-> 继续（回到未完成的录入）；
        // 其余 -> 详情（只读回看，证书打印在详情弹窗内）。
        const statusInfo = formatIpqcStatus(row.status);
        const label =
          statusInfo.label === '待检验'
            ? '检验'
            : sub === 'finished' && statusInfo.label === '检验中'
              ? '继续'
              : '详情';
        const onClick = label === '详情' ? () => handlers.onOpenDetail(row) : () => handlers.onOpenInspect(row);
        return (
          <div className="flex items-center justify-center gap-3">
            <button type="button" onClick={onClick} className="text-blue-600 hover:text-blue-800 font-medium">
              {label}
            </button>
            <button
              type="button"
              onClick={() => handlers.onOpenCert(row)}
              title="按本行数据导出证书（未录入的项留白）"
              className="text-blue-600 hover:text-blue-800 font-medium"
            >
              证书
            </button>
          </div>
        );
      },
    }
  );

  return columns;
}

export const IpqcViews: React.FC<IpqcViewsProps> = ({ sub, onChangeSub }) => {
  const [overviewData, setOverviewData] = useState<IpqcOverviewData | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);

  const [items, setItems] = useState<InspectionItemData[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(10);
  const [tableLoading, setTableLoading] = useState(false);
  const [tableError, setTableError] = useState<string | null>(null);

  // 过程检验台账筛选：单号拆成两个独立口径（docs/28）
  // 「检验工单」= 检验单号 order_no，「生产工单」= MES 生产工单号 work_order_no（物理列为空时后端按批次号兜底）
  const [filterOrderNo, setFilterOrderNo] = useState('');
  const [filterWorkOrderNo, setFilterWorkOrderNo] = useState('');
  const [filterMaterial, setFilterMaterial] = useState('');
  const [filterStatus, setFilterStatus] = useState('全部');

  const [printModalOpen, setPrintModalOpen] = useState(false);
  const [certData, setCertData] = useState<QualityCertificateData | undefined>(undefined);
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<InspectionItemData | null>(null);
  const [inspectModalOpen, setInspectModalOpen] = useState(false);
  const [inspectingOrder, setInspectingOrder] = useState<InspectionItemData | null>(null);
  const [inspectVerdict, setInspectVerdict] = useState<'PASSED' | 'FAILED' | 'INSPECTING'>('PASSED');
  const [inspectPassQty, setInspectPassQty] = useState<number>(0);
  const [inspectFailQty, setInspectFailQty] = useState<number>(0);
  const [inspectRemark, setInspectRemark] = useState('');
  const [inspectSubmitting, setInspectSubmitting] = useState(false);
  /** 提交失败文案（docs/35 §4 M3：失败就地红字提示，不再 alert 弹窗打断） */
  const [inspectError, setInspectError] = useState('');

  // 判定依据来源（口径：docs/17-检验录入界面说明与质检方案匹配口径.md §7）：按物料 + 检验类型匹配当前生效方案
  const inspectPlanMatch = useMatchedPlan(
    inspectingOrder?.materialCode ?? null,
    (inspectingOrder?.inspectionType as InspectionType | undefined) ?? null
  );
  const [inspectPlanRows, setInspectPlanRows] = useState<PlanIndicatorRow[]>([]);

  useEffect(() => {
    setInspectPlanRows(inspectPlanMatch.rows);
  }, [inspectPlanMatch.rows]);

  const inspectJudgement = summarizeJudgements(inspectPlanRows.map(judgeIndicatorRow));

  /**
   * 只读回看的数据源（TBD-07）：详情弹窗一律读 `GET /inspections/{id}` 的**本单方案快照**，
   * 指标 / 标准值 / 实测值 / 单项判定全部取工单落库值，不按当前生效方案重算（口径见 docs/17 §7.8）。
   * 只用列表行上的 `items` 会漏掉历史基准，也拿不到落库判定。
   */
  const detailPlanMatch = useMatchedPlan(
    selectedOrder?.materialCode ?? null,
    (selectedOrder?.inspectionType as InspectionType | undefined) ?? null,
    { orderId: selectedOrder?.id ?? null, readOnly: true }
  );
  const detailPlanRows = detailPlanMatch.rows;

  const activeType = useMemo(() => {
    if (sub === 'blanking') return 'IPQC_CT';
    if (sub === 'rolling') return 'IPQC_RL';
    if (sub === 'finished') return 'IPQC_FN';
    return 'IPQC';
  }, [sub]);

  const fetchOverview = useCallback(async () => {
    setOverviewLoading(true);
    try {
      const res = await api.get<IpqcOverviewData>('/inspections/ipqc-overview');
      setOverviewData(res);
    } catch (err) {
      console.error('Failed to load IPQC overview stats:', err);
    } finally {
      setOverviewLoading(false);
    }
  }, []);

  const fetchTableData = useCallback(async () => {
    if (sub === 'overview') return;
    setTableLoading(true);
    setTableError(null);

    try {
      const queryParams: Record<string, any> = {
        type: activeType,
        page,
        pageSize,
      };

      if (filterOrderNo.trim()) {
        queryParams.orderNo = filterOrderNo.trim();
      }
      if (filterWorkOrderNo.trim()) {
        queryParams.workOrderNo = filterWorkOrderNo.trim();
      }
      if (filterMaterial.trim()) {
        queryParams.materialCode = filterMaterial.trim();
      }
      if (filterStatus && filterStatus !== '全部') {
        if (filterStatus === '待检验') queryParams.status = 'PENDING';
        else if (filterStatus === '检验中') queryParams.status = 'INSPECTING';
        else if (filterStatus === '已合格') queryParams.status = 'PASSED';
        else if (filterStatus === '不合格') queryParams.status = 'FAILED';
      }

      const res = await api.get<{
        items: InspectionItemData[];
        total: number;
        statusCounts?: Record<string, number>;
      }>('/inspections', queryParams);

      setItems(res.items || []);
      setTotal(res.total || 0);
    } catch (err: any) {
      console.error('Failed to load IPQC table data:', err);
      setTableError(err?.message || '加载过程检验台账失败，请检查网络或后端连接');
    } finally {
      setTableLoading(false);
    }
  }, [activeType, sub, page, pageSize, filterOrderNo, filterWorkOrderNo, filterMaterial, filterStatus]);

  useEffect(() => {
    if (sub === 'overview') {
      fetchOverview();
    } else {
      setPage(1);
      fetchTableData();
    }
  }, [sub, fetchOverview]);

  useEffect(() => {
    if (sub !== 'overview') {
      fetchTableData();
    }
  }, [page, pageSize, fetchTableData, sub]);

  const handleSearch = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setPage(1);
    fetchTableData();
  };

  const handleReset = () => {
    setFilterOrderNo('');
    setFilterWorkOrderNo('');
    setFilterMaterial('');
    setFilterStatus('全部');
    setPage(1);
  };

  /**
   * 行级证书（docs/35 §10 M9）：所有行可点，未录入的项留白。
   * 企业档案（抬头 / 印章 / 供货单位·产地）取主数据，未维护即留白（不回落硬编码抬头）。
   */
  const handleOpenCert = (item: InspectionItemData) => {
    void (async () => {
      const companyProfile = await loadCompanyProfile();
      const data = buildIpqcCertificateData({
      // 证书编号读 orderNo：旧实现把单号写进 `id` 键，builder 读不到 -> 证书编号与弹窗标题恒空白
      orderNo: item.orderNo,
      // 抬头字段一律只下发库中真实值（docs/34 §5.1）。旧实现用一串 `||` 兜底，等于把
      // 「没有数据」打印成「有数据」：`spec || '标准紧固件'`（编造规格）、`quantity || 100 件`
      // （编造数量）、`sampleQty || 32`（编造抽检数）、`|| '2026-09-20'`（编造固定日期）、
      // `conclusion: isFail ? 'FAIL' : 'PASS'`（给未判定单补一个 PASS）—— 全部去掉。
      workOrder: item.workOrderNo,
      material: item.materialName,
      spec: item.specification,
      quantity: item.totalQty === undefined ? '' : `${item.totalQty} ${item.unit ?? ''}`.trim(),
      sampleQty: item.sampleQty,
      passQty: item.passQty,
      failQty: item.failQty,
      inspector: item.inspectorName,
      // 实测分区由证书服务从**原始工单实测项**里按 metricCategory 取真实数据（docs/34 §5.1）：
      // 这里不再预拼「符合」「OK」之类的展示文案 —— 那会把未录入的项说成已检合格。
        items: item.items,
        ...(item.approverName !== undefined && item.approverName !== '' ? { approverName: item.approverName } : {}),
        ...(companyProfile !== null ? { companyProfile } : {}),
      });
      setCertData(data);
      setPrintModalOpen(true);
    })();
  };

  const handleOpenDetail = (item: InspectionItemData) => {
    setSelectedOrder(item);
    setDetailModalOpen(true);
  };

  const handleOpenInspect = (item: InspectionItemData) => {
    setInspectingOrder(item);
    setInspectVerdict(item.status === 'FAILED' ? 'FAILED' : 'PASSED');
    setInspectPassQty(item.passQty ?? item.sampleQty ?? 32);
    setInspectFailQty(item.failQty ?? 0);
    setInspectRemark(item.inspectionNotes || '');
    setInspectError('');
    setInspectModalOpen(true);
  };

  const handleSubmitInspect = async () => {
    if (!inspectingOrder) return;
    setInspectSubmitting(true);
    try {
      // 先落库方案指标实测值：只提交属于本单方案快照的指标编码，避免服务端 400 校验失败。
      // 未录入任何实测值时跳过，保持"快速终判"轻量流程不变。
      const knownCodes = new Set((inspectingOrder.items ?? []).map((item) => item.itemCode));
      const measured = inspectPlanRows.filter(
        (row) => !row.isExempt && row.actual.trim() !== '' && knownCodes.has(row.itemCode)
      );
      if (measured.length > 0) {
        await api.post(`/inspections/${inspectingOrder.id}/submit-measurements`, {
          isDraft: false,
          items: measured.map((row) => {
            const numeric = row.planItem.dataType === 'NUMERIC' ? parseMeasuredNumber(row.actual) : undefined;
            return {
              itemCode: row.itemCode,
              ...(numeric !== undefined ? { measuredVal: numeric } : {}),
              measuredText: row.actual,
            };
          }),
        });
      }
      await api.post(`/inspections/${inspectingOrder.id}/status`, {
        status: inspectVerdict,
        passQty: inspectPassQty,
        failQty: inspectFailQty,
        judgment: inspectVerdict,
        remark: inspectRemark.trim() || undefined,
        inspectionNotes: inspectRemark.trim() || undefined,
      });
      setInspectModalOpen(false);
      setInspectingOrder(null);
      await fetchTableData();
      if (sub === 'overview') {
        await fetchOverview();
      }
    } catch (err) {
      // 就地红字提示（ApiError 文案由 errorMessage 统一抽取），不再用 alert 打断录入上下文
      setInspectError(errorMessage(err));
    } finally {
      setInspectSubmitting(false);
    }
  };

  // OVERVIEW VIEW
  if (sub === 'overview') {
    const blanking = overviewData?.blanking || { total: 0, pending: 0, inspecting: 0, passed: 0, failed: 0, passRate: 100 };
    const rolling = overviewData?.rolling || { total: 0, pending: 0, inspecting: 0, passed: 0, failed: 0, passRate: 100 };
    const finished = overviewData?.finished || { total: 0, pending: 0, inspecting: 0, passed: 0, failed: 0, passRate: 100 };
    const summary = overviewData?.summary || { total: 0, pending: 0, inspecting: 0, passed: 0, failed: 0, passRate: 100 };

    return (
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
              <Layers className="w-5 h-5 text-blue-600" />
              过程检验总览 (IPQC)
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              数据源: MES车间工序同频 · 下料检验 (IPQC-CT) / 滚丝检验 (IPQC-RL) / 成品检 (IPQC-FN)
            </p>
          </div>
          <button
            onClick={fetchOverview}
            disabled={overviewLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-600 hover:bg-slate-50 shadow-sm transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${overviewLoading ? 'animate-spin text-blue-600' : ''}`} />
            刷新看板
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* 下料检验 Card */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm hover:shadow transition-all relative overflow-hidden flex flex-col justify-between">
            <div className="flex items-start justify-between mb-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-slate-800 text-sm">下料检验</h3>
                  <span className="px-2 py-0.5 rounded text-[10px] bg-emerald-50 text-emerald-700 font-medium">
                    IPQC-CT
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-0.5">工序: 自动断料 · 冷镦毛坯</p>
              </div>
              <div className="px-2 py-1 bg-emerald-50 text-emerald-700 rounded text-xs font-bold">
                合格率 {blanking.passRate}%
              </div>
            </div>

            <div className="grid grid-cols-4 gap-2 bg-slate-50 rounded-lg p-2.5 text-center my-2">
              <div>
                <span className="block text-[11px] text-slate-500">待检验</span>
                <span className="text-base font-bold text-amber-600">{blanking.pending}</span>
              </div>
              <div>
                <span className="block text-[11px] text-slate-500">检验中</span>
                <span className="text-base font-bold text-blue-600">{blanking.inspecting}</span>
              </div>
              <div>
                <span className="block text-[11px] text-slate-500">已合格</span>
                <span className="text-base font-bold text-emerald-600">{blanking.passed}</span>
              </div>
              <div>
                <span className="block text-[11px] text-slate-500">不合格</span>
                <span className="text-base font-bold text-rose-600">{blanking.failed}</span>
              </div>
            </div>

            <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
              <span className="text-slate-500">MES 1#冷镦车间</span>
              <button
                onClick={() => onChangeSub('blanking')}
                className="text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1 group"
              >
                进入下料台账 ({blanking.total})
                <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
              </button>
            </div>
          </div>

          {/* 滚丝检验 Card */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm hover:shadow transition-all relative overflow-hidden flex flex-col justify-between">
            <div className="flex items-start justify-between mb-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-slate-800 text-sm">滚丝检验</h3>
                  <span className="px-2 py-0.5 rounded text-[10px] bg-blue-50 text-blue-700 font-medium">
                    IPQC-RL
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-0.5">工序: 手工滚牙 · 牙形校验</p>
              </div>
              <div className="px-2 py-1 bg-blue-50 text-blue-700 rounded text-xs font-bold">
                合格率 {rolling.passRate}%
              </div>
            </div>

            <div className="grid grid-cols-4 gap-2 bg-slate-50 rounded-lg p-2.5 text-center my-2">
              <div>
                <span className="block text-[11px] text-slate-500">待检验</span>
                <span className="text-base font-bold text-amber-600">{rolling.pending}</span>
              </div>
              <div>
                <span className="block text-[11px] text-slate-500">检验中</span>
                <span className="text-base font-bold text-blue-600">{rolling.inspecting}</span>
              </div>
              <div>
                <span className="block text-[11px] text-slate-500">已合格</span>
                <span className="text-base font-bold text-emerald-600">{rolling.passed}</span>
              </div>
              <div>
                <span className="block text-[11px] text-slate-500">不合格</span>
                <span className="text-base font-bold text-rose-600">{rolling.failed}</span>
              </div>
            </div>

            <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
              <span className="text-slate-500">MES 2#滚丝车间</span>
              <button
                onClick={() => onChangeSub('rolling')}
                className="text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1 group"
              >
                进入滚丝台账 ({rolling.total})
                <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
              </button>
            </div>
          </div>

          {/* 成品检 Card */}
          <div className="bg-white border border-rose-200/80 rounded-xl p-4 shadow-sm hover:shadow transition-all relative overflow-hidden flex flex-col justify-between">
            <div className="flex items-start justify-between mb-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-slate-800 text-sm flex items-center gap-1">
                    成品检
                    <span className="text-amber-500 text-xs">★</span>
                  </h3>
                  <span className="px-2 py-0.5 rounded text-[10px] bg-rose-50 text-rose-600 border border-rose-100 font-medium">
                    强制关卡
                  </span>
                  <span className="px-2 py-0.5 rounded text-[10px] bg-purple-50 text-purple-700 font-medium">
                    IPQC-FN
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-0.5">工序: 检测入库 · 关卡阻断</p>
              </div>
              <div className="px-2 py-1 bg-purple-50 text-purple-700 rounded text-xs font-bold">
                合格率 {finished.passRate}%
              </div>
            </div>

            <div className="grid grid-cols-4 gap-2 bg-slate-50 rounded-lg p-2.5 text-center my-2">
              <div>
                <span className="block text-[11px] text-slate-500">待检验</span>
                <span className="text-base font-bold text-amber-600">{finished.pending}</span>
              </div>
              <div>
                <span className="block text-[11px] text-slate-500">检验中</span>
                <span className="text-base font-bold text-blue-600">{finished.inspecting}</span>
              </div>
              <div>
                <span className="block text-[11px] text-slate-500">已合格</span>
                <span className="text-base font-bold text-emerald-600">{finished.passed}</span>
              </div>
              <div>
                <span className="block text-[11px] text-slate-500">不合格</span>
                <span className="text-base font-bold text-rose-600">{finished.failed}</span>
              </div>
            </div>

            <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
              <span className="text-rose-600 font-medium text-[11px]">物理阻断已启用</span>
              <button
                onClick={() => onChangeSub('finished')}
                className="text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1 group"
              >
                进入成品台账 ({finished.total})
                <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
              </button>
            </div>
          </div>
        </div>

        {/* Global Summary Banner */}
        <div className="bg-gradient-to-r from-slate-900 to-slate-800 rounded-xl p-4 text-white shadow-sm flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-white/10 flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-emerald-400" />
            </div>
            <div>
              <div className="text-xs text-slate-400">今日过程检验管控总量</div>
              <div className="text-xl font-bold">{summary.total} 批次</div>
            </div>
          </div>

          <div className="flex items-center gap-6 text-xs">
            <div>
              <span className="text-slate-400 block">待检排队</span>
              <span className="text-base font-bold text-amber-400">{summary.pending}</span>
            </div>
            <div className="w-px h-8 bg-slate-700" />
            <div>
              <span className="text-slate-400 block">检验中</span>
              <span className="text-base font-bold text-sky-400">{summary.inspecting}</span>
            </div>
            <div className="w-px h-8 bg-slate-700" />
            <div>
              <span className="text-slate-400 block">合格放行</span>
              <span className="text-base font-bold text-emerald-400">{summary.passed}</span>
            </div>
            <div className="w-px h-8 bg-slate-700" />
            <div>
              <span className="text-slate-400 block">不合格拦截</span>
              <span className="text-base font-bold text-rose-400">{summary.failed}</span>
            </div>
            <div className="w-px h-8 bg-slate-700" />
            <div>
              <span className="text-slate-400 block">综合合格率</span>
              <span className="text-base font-bold text-emerald-400">{summary.passRate}%</span>
            </div>
          </div>
        </div>

        {/* Breakdown Table */}
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
          <div className="p-4 border-b border-slate-100 flex items-center justify-between">
            <h3 className="font-semibold text-sm text-slate-800">工序控制指标汇总</h3>
            <span className="text-xs text-slate-400">对接 MES 实时工序采集终端</span>
          </div>
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-600 border-b border-slate-200 font-medium">
              <tr>
                <th className="py-2.5 px-4">工序代号</th>
                <th className="py-2.5 px-4">工序名称</th>
                <th className="py-2.5 px-4">MES执行车间</th>
                <th className="py-2.5 px-4 text-center">待检验</th>
                <th className="py-2.5 px-4 text-center">检验中</th>
                <th className="py-2.5 px-4 text-center">已合格</th>
                <th className="py-2.5 px-4 text-center">不合格</th>
                <th className="py-2.5 px-4 text-center">合格率</th>
                <th className="py-2.5 px-4 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              <tr className="hover:bg-slate-50/60 transition-colors">
                <td className="py-3 px-4 font-mono font-medium text-emerald-700">IPQC-CT</td>
                <td className="py-3 px-4 font-medium">下料首巡检 (自动断料)</td>
                <td className="py-3 px-4 text-slate-500">1#冷镦车间</td>
                <td className="py-3 px-4 text-center font-semibold text-amber-600">{blanking.pending}</td>
                <td className="py-3 px-4 text-center font-semibold text-blue-600">{blanking.inspecting}</td>
                <td className="py-3 px-4 text-center font-semibold text-emerald-600">{blanking.passed}</td>
                <td className="py-3 px-4 text-center font-semibold text-rose-600">{blanking.failed}</td>
                <td className="py-3 px-4 text-center font-bold text-emerald-600">{blanking.passRate}%</td>
                <td className="py-3 px-4 text-right">
                  <button
                    onClick={() => onChangeSub('blanking')}
                    className="text-blue-600 hover:text-blue-800 font-medium"
                  >
                    查看台账
                  </button>
                </td>
              </tr>
              <tr className="hover:bg-slate-50/60 transition-colors">
                <td className="py-3 px-4 font-mono font-medium text-blue-700">IPQC-RL</td>
                <td className="py-3 px-4 font-medium">滚丝首巡检 (手工滚牙)</td>
                <td className="py-3 px-4 text-slate-500">2#滚丝车间</td>
                <td className="py-3 px-4 text-center font-semibold text-amber-600">{rolling.pending}</td>
                <td className="py-3 px-4 text-center font-semibold text-blue-600">{rolling.inspecting}</td>
                <td className="py-3 px-4 text-center font-semibold text-emerald-600">{rolling.passed}</td>
                <td className="py-3 px-4 text-center font-semibold text-rose-600">{rolling.failed}</td>
                <td className="py-3 px-4 text-center font-bold text-emerald-600">{rolling.passRate}%</td>
                <td className="py-3 px-4 text-right">
                  <button
                    onClick={() => onChangeSub('rolling')}
                    className="text-blue-600 hover:text-blue-800 font-medium"
                  >
                    查看台账
                  </button>
                </td>
              </tr>
              <tr className="hover:bg-slate-50/60 transition-colors">
                <td className="py-3 px-4 font-mono font-medium text-purple-700">IPQC-FN</td>
                <td className="py-3 px-4 font-medium flex items-center gap-1.5">
                  成品全检 (检测入库)
                  <span className="text-rose-500 font-bold text-xs" title="MES入库强制物理关卡">★</span>
                </td>
                <td className="py-3 px-4 text-slate-500">包装与终检班组</td>
                <td className="py-3 px-4 text-center font-semibold text-amber-600">{finished.pending}</td>
                <td className="py-3 px-4 text-center font-semibold text-blue-600">{finished.inspecting}</td>
                <td className="py-3 px-4 text-center font-semibold text-emerald-600">{finished.passed}</td>
                <td className="py-3 px-4 text-center font-semibold text-rose-600">{finished.failed}</td>
                <td className="py-3 px-4 text-center font-bold text-emerald-600">{finished.passRate}%</td>
                <td className="py-3 px-4 text-right">
                  <button
                    onClick={() => onChangeSub('finished')}
                    className="text-blue-600 hover:text-blue-800 font-medium"
                  >
                    查看台账
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // SUBTAB DETAIL VIEWS (下料检验 / 滚丝检验 / 成品检)
  const isBlanking = sub === 'blanking';
  const isRolling = sub === 'rolling';
  const isFinished = sub === 'finished';

  const title = isBlanking ? '下料检验' : isRolling ? '滚丝检验' : '成品检';
  const codeTag = isBlanking ? 'IPQC-CT' : isRolling ? 'IPQC-RL' : 'IPQC-FN';
  const processDesc = isBlanking
    ? 'MES工序: 自动断料 · 冷镦毛坯 · 断料长度与外径公差把控'
    : isRolling
    ? 'MES工序: 手工滚牙 · 螺纹牙型与公差配合 · 人员设备强追溯'
    : 'MES工序: 检测入库 · ★入库关卡必检物理阻断 · 终检组全项合格入库';

  // 台账列表头与数据行共用同一份列定义（列集口径：docs/29 §2 下料 / docs/30 §2 滚丝·成品检）
  const ledgerColumns = buildIpqcLedgerColumns(sub, {
    onOpenDetail: handleOpenDetail,
    onOpenInspect: handleOpenInspect,
    onOpenCert: handleOpenCert,
  });

  return (
    <div className="space-y-4">
      {/* Top Header Bar */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-slate-800 flex items-center gap-1">
              {title}
              {isFinished && <span className="text-amber-500 text-sm">★</span>}
            </h2>
            {isFinished && (
              <span className="px-2 py-0.5 rounded text-[10px] bg-rose-50 text-rose-600 border border-rose-100 font-medium">
                关卡物理阻断
              </span>
            )}
            <span className="px-2 py-0.5 rounded text-[10px] bg-emerald-50 text-emerald-700 font-medium font-mono">
              {codeTag}
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">{processDesc}</p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => onChangeSub('overview')}
            className="flex items-center gap-1 px-3 py-1.5 rounded border border-slate-200 text-xs text-slate-600 hover:bg-slate-50 shadow-sm transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> 返回总览
          </button>
          <button
            onClick={fetchTableData}
            disabled={tableLoading}
            className="flex items-center gap-1 px-3 py-1.5 rounded border border-slate-200 text-xs text-slate-600 hover:bg-slate-50 shadow-sm transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${tableLoading ? 'animate-spin text-blue-600' : ''}`} />
            刷新
          </button>
        </div>
      </div>

      {/* Process Alerts */}
      {isRolling && (
        <div className="bg-amber-50 border border-amber-200/80 rounded-lg p-3 text-xs text-amber-800 flex items-center gap-2 shadow-sm">
          <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
          <span>滚丝为紧固件手工/机台复合工序，需严格核实操作工（操作员）与机台设备编号，确保全流程双向追溯。</span>
        </div>
      )}
      {isFinished && (
        <div className="bg-rose-50 border border-rose-200/80 rounded-lg p-3 text-xs text-rose-800 flex items-center gap-2 shadow-sm">
          <span className="text-rose-600 font-bold">★ 关卡必检提示:</span>
          <span>成品检为 MES 终检入库关卡工序（isMandatoryGate=true）。未完成检验或判定不合格批次将直接触发 MES 物理入库阻断。</span>
        </div>
      )}

      {/* Filter Bar */}
      <form onSubmit={handleSearch} className="bg-white border border-slate-200/80 rounded-lg p-4 shadow-sm flex flex-wrap items-center gap-4 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-slate-600 font-medium">检验工单</span>
          <input
            type="text"
            placeholder="检验单号"
            value={filterOrderNo}
            onChange={(e) => setFilterOrderNo(e.target.value)}
            className="border border-slate-200 rounded px-2.5 py-1.5 w-36 text-slate-700 focus:outline-none focus:border-blue-500"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-600 font-medium">生产工单</span>
          <input
            type="text"
            placeholder="MES生产工单号"
            value={filterWorkOrderNo}
            onChange={(e) => setFilterWorkOrderNo(e.target.value)}
            className="border border-slate-200 rounded px-2.5 py-1.5 w-36 text-slate-700 focus:outline-none focus:border-blue-500"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-600 font-medium">物料编码</span>
          <input
            type="text"
            placeholder="物料编码/品名"
            value={filterMaterial}
            onChange={(e) => setFilterMaterial(e.target.value)}
            className="border border-slate-200 rounded px-2.5 py-1.5 w-36 text-slate-700 focus:outline-none focus:border-blue-500"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-600 font-medium">检验状态</span>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="border border-slate-200 rounded px-2.5 py-1.5 w-28 text-slate-700 bg-white focus:outline-none focus:border-blue-500"
          >
            <option value="全部">全部</option>
            <option value="待检验">待检验</option>
            <option value="检验中">检验中</option>
            <option value="已合格">已合格</option>
            <option value="不合格">不合格</option>
          </select>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={handleReset}
            className="px-3.5 py-1.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center gap-1"
          >
            <RotateCcw className="w-3 h-3" /> 重置
          </button>
          <button
            type="submit"
            className="px-4 py-1.5 rounded bg-blue-600 text-white font-medium hover:bg-blue-700 shadow-sm flex items-center gap-1"
          >
            <Search className="w-3 h-3" /> 查询
          </button>
        </div>
      </form>

      {/* Error Alert */}
      {tableError && (
        <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-lg flex items-center justify-between">
          <span>{tableError}</span>
          <button onClick={fetchTableData} className="underline hover:text-rose-900 ml-2">重试</button>
        </div>
      )}

      {/* Main Table */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-slate-50 text-slate-600 border-b border-slate-200 font-medium select-none">
              <tr>
                {ledgerColumns.map((col) => (
                  <th key={col.key} className={`${LEDGER_TH_CLASS} ${col.thClass ?? ''}`}>
                    {col.title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {tableLoading ? (
                <tr>
                  <td colSpan={ledgerColumns.length} className="py-12 text-center text-slate-400">
                    <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-blue-600" />
                    正在连接数据库获取过程检验数据...
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={ledgerColumns.length} className="py-12 text-center text-slate-400">
                    暂无符合条件的过程检验数据
                  </td>
                </tr>
              ) : (
                items.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50/70 transition-colors">
                    {ledgerColumns.map((col) => (
                      <td key={col.key} className={`${LEDGER_TD_CLASS} ${col.tdClass ?? ''}`}>
                        {col.render(row)}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Bar */}
        <div className="p-3 bg-slate-50/70 border-t border-slate-200 flex items-center justify-between text-xs text-slate-500">
          <div>
            共 <span className="font-semibold text-slate-700">{total}</span> 条记录
            {total > 0 && (
              <span className="ml-2">
                (当前第 {(page - 1) * pageSize + 1} - {Math.min(page * pageSize, total)} 条)
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-2.5 py-1 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
            >
              <ChevronLeft className="w-3.5 h-3.5" /> 上一页
            </button>
            <span className="font-medium text-slate-700">
              {page} / {Math.max(1, Math.ceil(total / pageSize))}
            </span>
            <button
              onClick={() => setPage((p) => (p * pageSize < total ? p + 1 : p))}
              disabled={page * pageSize >= total}
              className="px-2.5 py-1 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
            >
              下一页 <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* DETAIL MODAL */}
      {detailModalOpen && selectedOrder && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-bold text-base text-slate-800">
                    检验单详情: {selectedOrder.orderNo}
                  </h3>
                  <span className="px-2 py-0.5 rounded text-xs bg-blue-50 text-blue-700 font-mono font-medium">
                    {selectedOrder.inspectionType}
                  </span>
                  <StatusBadge status={formatIpqcStatus(selectedOrder.status).label} tone={formatIpqcStatus(selectedOrder.status).tone} />
                </div>
                <p className="text-xs text-slate-400 mt-0.5">
                  MES生产工单: {selectedOrder.workOrderNo || selectedOrder.batchNo || '--'}
                </p>
              </div>
              <button
                onClick={() => setDetailModalOpen(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200/50 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-5 max-h-[70vh] overflow-y-auto text-xs">
              <div>
                <h4 className="font-semibold text-slate-700 mb-2.5 flex items-center gap-1.5">
                  <Layers className="w-4 h-4 text-blue-500" /> 基本信息与物料规格
                </h4>
                <div className="grid grid-cols-3 gap-3 bg-slate-50 p-3.5 rounded-lg border border-slate-100">
                  <div>
                    <span className="text-slate-400 block">物料编码</span>
                    <span className="font-mono font-medium text-slate-800">{selectedOrder.materialCode}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">物料名称</span>
                    <span className="font-medium text-slate-800">{selectedOrder.materialName}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">规格型号</span>
                    <span className="text-slate-800">{selectedOrder.specification || '--'}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">计划/报检总量</span>
                    <span className="font-semibold text-slate-800">{selectedOrder.totalQty || selectedOrder.sampleQty || 100} {selectedOrder.unit || '件'}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">抽检样本数量</span>
                    <span className="font-semibold text-slate-800">{selectedOrder.sampleQty || 32} 件</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">合格 / 不合格</span>
                    <span className="font-semibold text-emerald-600">{selectedOrder.passQty ?? 0}</span>
                    <span className="text-slate-400"> / </span>
                    <span className="font-semibold text-rose-600">{selectedOrder.failQty ?? 0}</span>
                  </div>
                </div>
              </div>

              <div>
                <h4 className="font-semibold text-slate-700 mb-2.5 flex items-center gap-1.5">
                  <Sliders className="w-4 h-4 text-blue-500" /> 过程工序追溯与机台设备
                </h4>
                <div className="grid grid-cols-3 gap-3 bg-slate-50 p-3.5 rounded-lg border border-slate-100">
                  <div>
                    <span className="text-slate-400 block">工序阶段</span>
                    <span className="font-medium text-slate-800">{selectedOrder.processStep || '工序巡检'}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">机台操作员</span>
                    <span className="font-medium text-slate-800">
                      {selectedOrder.operatorName || '--'}
                      {selectedOrder.operatorId && <span className="text-slate-400 text-[11px] ml-1">({selectedOrder.operatorId})</span>}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">生产设备</span>
                    <span className="font-medium text-slate-800">
                      {selectedOrder.equipmentName || selectedOrder.equipmentCode || '--'}
                      {selectedOrder.equipmentCode && selectedOrder.equipmentName && (
                        <span className="text-slate-400 text-[11px] ml-1">[{selectedOrder.equipmentCode}]</span>
                      )}
                    </span>
                  </div>
                  {selectedOrder.blankingLength !== undefined && selectedOrder.blankingLength !== null && (
                    <div>
                      <span className="text-slate-400 block">断料长度 (mm)</span>
                      <span className="font-mono font-bold text-slate-800">{Number(selectedOrder.blankingLength).toFixed(2)} mm</span>
                    </div>
                  )}
                  {selectedOrder.threadSpec && (
                    <div>
                      <span className="text-slate-400 block">牙纹/螺纹规格</span>
                      <span className="font-mono font-bold text-slate-800">{selectedOrder.threadSpec}</span>
                    </div>
                  )}
                  {selectedOrder.inspectionTeam && (
                    <div>
                      <span className="text-slate-400 block">终检班组</span>
                      <span className="font-medium text-slate-800">{selectedOrder.inspectionTeam}</span>
                    </div>
                  )}
                  <div>
                    <span className="text-slate-400 block">关卡物理阻断</span>
                    <span className={selectedOrder.isMandatoryGate ? 'font-bold text-rose-600' : 'text-slate-600'}>
                      {selectedOrder.isMandatoryGate ? '★ 强制阻断启用 (未合格不可入库)' : '普通工序'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">检验员</span>
                    <span className="font-medium text-slate-800">{selectedOrder.inspectorName || '--'}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">完成时间</span>
                    <span className="text-slate-800">{(selectedOrder.completedAt || selectedOrder.createdAt || '--').replace('T', ' ')}</span>
                  </div>
                </div>
              </div>

              <div>
                <h4 className="font-semibold text-slate-700 mb-2.5 flex items-center gap-1.5">
                  <FileText className="w-4 h-4 text-blue-500" /> 检验项目实测明细
                </h4>
                {/* 判定依据来源：本单方案快照（只读回看），不是列表行上的临时数据 */}
                <div className="mb-2.5">
                  <PlanMatchBanner
                    state={detailPlanMatch}
                    materialCode={selectedOrder.materialCode}
                    inspectionType={selectedOrder.inspectionType as InspectionType}
                  />
                </div>
                {detailPlanMatch.status === 'loading' ? (
                  <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg text-slate-500 text-center">
                    正在读取本单方案快照…
                  </div>
                ) : detailPlanRows.length > 0 ? (
                  <div className="border border-slate-200 rounded-lg overflow-hidden">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 text-slate-600 border-b border-slate-200 font-medium">
                        <tr>
                          <th className="py-2 px-3">项目编码</th>
                          <th className="py-2 px-3">检验项名称</th>
                          <th className="py-2 px-3">标准值/公差</th>
                          <th className="py-2 px-3">实测值</th>
                          <th className="py-2 px-3 text-center">判定</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {detailPlanRows.map((row) => {
                          const decision = judgeIndicatorRow(row);
                          return (
                            <tr key={row.itemCode} className="hover:bg-slate-50/50">
                              <td className="py-2 px-3 font-mono text-slate-500">{row.itemCode}</td>
                              <td className="py-2 px-3 font-medium text-slate-800">{row.name}</td>
                              <td className="py-2 px-3 text-slate-600">{row.standard}</td>
                              <td className="py-2 px-3 font-mono font-medium text-slate-800">
                                {row.isExempt
                                  ? '免检'
                                  : row.actual.trim() !== ''
                                  ? `${row.actual}${row.unit ? ` ${row.unit}` : ''}`
                                  : '未录入'}
                              </td>
                              <td className="py-2 px-3 text-center">
                                <span className={DECISION_BADGE_CLASS[decisionTone(decision)]}>
                                  {DECISION_LABEL[decision]}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg text-slate-500 text-center">
                    本单方案快照中没有指标项，无法回看判定依据。
                  </div>
                )}
              </div>

              {selectedOrder.inspectionNotes && (
                <div>
                  <h4 className="font-semibold text-slate-700 mb-1">检验巡检记录与说明:</h4>
                  <div className="p-2.5 bg-slate-50 border border-slate-100 rounded text-slate-700">
                    {selectedOrder.inspectionNotes}
                  </div>
                </div>
              )}
            </div>

            <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-between">
              <button
                onClick={() => {
                  handleOpenCert(selectedOrder);
                }}
                className="px-3.5 py-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-100 text-xs font-medium flex items-center gap-1.5 transition-colors"
              >
                <Printer className="w-3.5 h-3.5" /> 打印质检证书
              </button>
              <button
                onClick={() => setDetailModalOpen(false)}
                className="px-4 py-1.5 rounded-lg bg-slate-800 text-white hover:bg-slate-900 text-xs font-medium transition-colors"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* INSPECT MODAL */}
      {inspectModalOpen && inspectingOrder && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto animate-in fade-in zoom-in-95 duration-150">
            <div className="px-5 py-3.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-bold text-sm text-slate-800">
                录入过程检验结果: {inspectingOrder.orderNo}
              </h3>
              <button
                onClick={() => setInspectModalOpen(false)}
                className="p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-200/50"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs">
              <div className="bg-slate-50 p-3 rounded border border-slate-100 space-y-1">
                <div className="flex justify-between">
                  <span className="text-slate-400">物料:</span>
                  <span className="font-medium text-slate-800">{inspectingOrder.materialName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">工单号:</span>
                  <span className="font-mono text-slate-700">{inspectingOrder.workOrderNo || inspectingOrder.batchNo || '--'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">抽样基准:</span>
                  <span className="font-semibold text-slate-800">{inspectingOrder.sampleQty || 32} 件</span>
                </div>
              </div>

              <PlanMatchBanner
                state={inspectPlanMatch}
                materialCode={inspectingOrder.materialCode}
                inspectionType={inspectingOrder.inspectionType}
                compact
              />

              {/* 方案驱动的待检指标清单：需求"显示需要检验的指标清单"的落点 */}
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                  <span className="font-semibold text-slate-700">待检指标清单（按方案标准自动判定）</span>
                  <span className="text-[11px] text-slate-500">
                    共 {inspectJudgement.total} 项 · 免检 {inspectJudgement.exempt} 项 · 待判定{' '}
                    {inspectJudgement.pending} 项
                  </span>
                </div>
                <table className="w-full text-left">
                  <thead className="bg-white text-slate-500 border-b border-slate-100">
                    <tr>
                      <th className="py-1.5 px-3 w-40">检验指标</th>
                      <th className="py-1.5 px-3 w-40">标准要求</th>
                      <th className="py-1.5 px-3">实测值</th>
                      <th className="py-1.5 px-2 w-16 text-center">不解检</th>
                      <th className="py-1.5 px-3 w-20 text-center">单向判定</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {inspectPlanRows.length === 0 && (
                      <tr>
                        <td colSpan={5} className="py-4 px-3 text-center text-[11px] text-slate-400">
                          暂无待检指标：该物料未匹配到已启用的质检方案。
                        </td>
                      </tr>
                    )}
                    {inspectPlanRows.map((row, idx) => {
                      const decision = judgeIndicatorRow(row);
                      return (
                        <tr key={`${row.itemCode}-${idx}`}>
                          <td className="py-1.5 px-3 font-medium text-slate-800">{row.title}</td>
                          <td className="py-1.5 px-3 text-slate-600 font-mono">{row.standard}</td>
                          <td className="py-1.5 px-3">
                            <input
                              type="text"
                              value={row.actual}
                              disabled={row.isExempt}
                              placeholder={row.isExempt ? '免检' : `实测值${row.unit !== '' ? ` (${row.unit})` : ''}`}
                              onChange={(e) => {
                                const value = e.target.value;
                                setInspectPlanRows((prev) =>
                                  prev.map((candidate, position) =>
                                    position === idx ? { ...candidate, actual: value } : candidate
                                  )
                                );
                              }}
                              className={`w-36 border rounded px-2 py-0.5 font-mono focus:outline-none ${
                                row.isExempt
                                  ? 'bg-slate-100 border-slate-200 text-slate-400 italic'
                                  : decision === 'FAILED'
                                  ? 'border-rose-400 text-rose-600 bg-white'
                                  : 'border-slate-200 bg-white focus:border-blue-500'
                              }`}
                            />
                            {row.unit !== '' && !row.isExempt && (
                              <span className="ml-1 text-[10px] text-slate-400">{row.unit}</span>
                            )}
                          </td>
                          <td className="py-1.5 px-2 text-center">
                            <input
                              type="checkbox"
                              checked={row.isExempt}
                              onChange={(e) => {
                                const checked = e.target.checked;
                                setInspectPlanRows((prev) =>
                                  prev.map((candidate, position) =>
                                    position === idx ? { ...candidate, isExempt: checked } : candidate
                                  )
                                );
                              }}
                              className="rounded text-blue-600 focus:ring-blue-500"
                            />
                          </td>
                          <td className="py-1.5 px-3 text-center">
                            <span
                              className={`px-1.5 py-0.5 rounded font-semibold border ${
                                decision === 'PASSED'
                                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                  : decision === 'FAILED'
                                  ? 'bg-rose-50 text-rose-700 border-rose-200'
                                  : 'bg-slate-100 text-slate-500 border-slate-200'
                              }`}
                            >
                              {DECISION_LABEL[decision]}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div>
                <label className="block text-slate-600 font-medium mb-1.5">检验判定结论</label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setInspectVerdict('PASSED');
                      setInspectPassQty(inspectingOrder.sampleQty || 32);
                      setInspectFailQty(0);
                    }}
                    className={`py-2 rounded border text-xs font-semibold flex items-center justify-center gap-1 transition-all ${
                      inspectVerdict === 'PASSED'
                        ? 'bg-emerald-50 border-emerald-500 text-emerald-700 shadow-sm'
                        : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                    合格放行
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setInspectVerdict('FAILED');
                      setInspectPassQty(0);
                      setInspectFailQty(inspectingOrder.sampleQty || 32);
                    }}
                    className={`py-2 rounded border text-xs font-semibold flex items-center justify-center gap-1 transition-all ${
                      inspectVerdict === 'FAILED'
                        ? 'bg-rose-50 border-rose-500 text-rose-700 shadow-sm'
                        : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <XCircle className="w-3.5 h-3.5 text-rose-600" />
                    不合格拦截
                  </button>
                  <button
                    type="button"
                    onClick={() => setInspectVerdict('INSPECTING')}
                    className={`py-2 rounded border text-xs font-semibold flex items-center justify-center gap-1 transition-all ${
                      inspectVerdict === 'INSPECTING'
                        ? 'bg-blue-50 border-blue-500 text-blue-700 shadow-sm'
                        : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <Clock className="w-3.5 h-3.5 text-blue-600" />
                    检验中
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 font-medium mb-1">合格数量</label>
                  <input
                    type="number"
                    min={0}
                    value={inspectPassQty}
                    onChange={(e) => setInspectPassQty(Number(e.target.value))}
                    className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 font-medium mb-1">不合格数量</label>
                  <input
                    type="number"
                    min={0}
                    value={inspectFailQty}
                    onChange={(e) => setInspectFailQty(Number(e.target.value))}
                    className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-600 font-medium mb-1">巡检结论说明 / 备注</label>
                <textarea
                  rows={2}
                  value={inspectRemark}
                  onChange={(e) => setInspectRemark(e.target.value)}
                  placeholder="请输入过程巡检实测情况与处置说明..."
                  className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 focus:outline-none focus:border-blue-500 resize-none"
                />
              </div>
            </div>

            <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-2">
              {inspectError !== '' && (
                <span className="mr-auto text-xs text-rose-600" data-testid="ipqc-submit-error">
                  {inspectError}
                </span>
              )}
              <button
                type="button"
                onClick={() => setInspectModalOpen(false)}
                className="px-3.5 py-1.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-100 text-xs"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleSubmitInspect}
                disabled={inspectSubmitting}
                className="px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs shadow-sm disabled:opacity-50 flex items-center gap-1"
              >
                {inspectSubmitting ? '正在提交...' : '确认保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CERTIFICATE PRINT MODAL */}
      <CertificatePrintModal
        isOpen={printModalOpen}
        onClose={() => setPrintModalOpen(false)}
        type="quality"
        qualityData={certData}
      />
    </div>
  );
};
