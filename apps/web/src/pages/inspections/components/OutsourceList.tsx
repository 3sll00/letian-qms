import React, { useCallback, useEffect, useState } from 'react';
function useSearchParams() {
  const [params, setParamsState] = useState(() => new URLSearchParams(typeof window !== 'undefined' ? window.location.search : ''));
  const setParams = useCallback((newParams: URLSearchParams) => {
    if (typeof window !== 'undefined') {
      const newUrl = window.location.pathname + '?' + newParams.toString() + window.location.hash;
      window.history.replaceState(null, '', newUrl);
      setParamsState(new URLSearchParams(newParams));
    }
  }, []);
  return [params, setParams] as const;
}
import { DateInput } from '../../../components/common/DateInput';
import { CertificatePrintModal } from '../../../components/certificate/CertificatePrintModal';
import { NewInspectionModal, type NewInspectionFieldDef } from './NewInspectionModal';
import {
  buildOqcCertificateData,
  convertOutsourceToManufacturingCert,
} from '../../../lib/certificateDataService';
import type {
  CertTemplateKind,
  ManufacturingCertData,
  QualityCertificateData,
} from '../../../lib/inspectionTypes';
import { api } from '../../../lib/api';
import { loadCompanyProfile } from '../../../lib/companyProfile';
import type { TransferStateFields } from '../../../lib/transferGateFormat';

interface OutsourceListProps {
  /** readOnly = true 表示只读回看（TBD-07）：走本单方案快照，而不是按物料匹配当前生效方案 */
  /** isSurface = 是否来自「表面检验」页签（委外表面处理场景，docs/51：仅此处弹模板选择框） */
  onInspect: (item: any, readOnly?: boolean, isSurface?: boolean) => void;
  initialTab?: 'surface' | 'machining' | 'heat';
}

export interface OutsourceListItem {
  id: string;
  docNo: string;
  outsourceNo: string;
  processType?: string;
  materialCode: string;
  materialName: string;
  /** 规格型号快照（inspection_orders.specification）；无来源即空串，界面与证书都不编造 */
  specification?: string;
  /** 计量单位快照（inspection_orders.unit），与 qty 组成「交付数量」 */
  unit?: string;
  /** 委外批次号（inspection_orders.batch_no）：委外检验录入表单「委外批次号」的唯一真实来源 */
  batchNo?: string;
  qty: number;
  vendor: string;
  returnDate: string;
  status: '待检验' | '检验中' | '已合格' | '不合格';
  inspector: string;
  tabType: 'surface' | 'machining' | 'heat';
  /** 质量负责人签核人姓名（inspection_orders.approver_name，docs/35 §5）：未签核即空 */
  approverName?: string;
  /** 签核时间（inspection_orders.approved_at） */
  approvedAt?: string;
  /** 030 委外录入页业务事实字段（docs/36）：材质牌号 / 执行技术标准 / 检验日期，均只取物理列 */
  materialGrade?: string;
  techStandard?: string;
  inspectedDate?: string;
  /**
   * 完成时间 / 建单时间（inspection_orders.completed_at / created_at）。
   * 仅作制造证书「Issue Date」在 inspected_date 为空时的回落档（docs/36 §6），只读、不参与录入。
   */
  completedAt?: string;
  createdAt?: string;
  /** 证书模板（docs/51）：建单前选定的版式；历史单无值即按本模块缺省出证 */
  certTemplate?: CertTemplateKind;
  /** 证书专用补充字段袋（cert_fields） */
  certFields?: Record<string, string>;
  /**
   * 「合格后传递」派生字段（docs/48 §4.6，服务端 `withTransferState` 回填）：
   * canTransfer / transferCode / blockedBy / predecessorOrderNo / chainKey。
   * 字段缺失 = 服务端未下发判定（**不等于「允许」**），徽标据此显示 —。
   */
  canTransfer?: boolean | null;
  transferCode?: string | null;
  predecessorOrderNo?: string | null;
  chainKey?: string | null;
  blockedBy?: TransferStateFields['blockedBy'];
}


const STATUS_TO_CN: Record<string, '待检验' | '检验中' | '已合格' | '不合格'> = {
  PENDING: '待检验',
  INSPECTING: '检验中',
  DRAFT: '检验中',
  RE_INSPECTING: '检验中',
  PASSED: '已合格',
  COMPLETED: '已合格',
  FAILED: '不合格',
  IN_MRB_REVIEW: '不合格',
};

const CN_TO_STATUSES: Record<string, string> = {
  待检验: 'PENDING',
  检验中: 'INSPECTING,DRAFT,RE_INSPECTING',
  已合格: 'PASSED,COMPLETED',
  不合格: 'FAILED,IN_MRB_REVIEW',
};

/**
 * 台账展示上限：命中超过 1 万条时只展示前 1 万条，并提示缩小日期范围
 * （与来料检验台账 IqcList 的 MAX_DISPLAY_ROWS 同一口径），避免无界翻页拖垮后端。
 */
const MAX_DISPLAY_ROWS = 10000;

/**
 * 「新增检验」弹窗字段：委外三页签台账的建单录入列（检验单号 / 状态 / 操作为建单后派生列，不录入）。
 * 固定七槽位四行：委外加工单号（委外检验的「入库单号」槽位）· 批次号 → 物料编码 · 物料名称 →
 * 规格型号 · 数量 → 检验人；
 * 物料编码 / 批次号 / 数量是服务端建单硬约束，标记必填；
 * 「检验人」默认当前登录用户、可下拉改选，由 NewInspectionModal 内部统一承载。
 */
const NEW_OUTSOURCE_FIELD_SETS: Record<'surface' | 'machining' | 'heat', { title: string; fields: NewInspectionFieldDef[] }> = {
  surface: {
    title: '委外检验 · 表面处理检验',
    fields: [
      { key: 'outsourceNo', label: '委外加工单号' },
      { key: 'batchNo', label: '批次号', serverRequired: true },
      { key: 'materialCode', label: '物料编码', serverRequired: true },
      { key: 'materialName', label: '物料名称' },
      { key: 'specification', label: '规格型号' },
      { key: 'sampleQty', label: '数量', type: 'number', serverRequired: true },
      { key: 'inspectorName', label: '检验人' },
    ],
  },
  machining: {
    title: '委外检验 · 机加工检验',
    fields: [
      { key: 'outsourceNo', label: '委外加工单号' },
      { key: 'batchNo', label: '批次号', serverRequired: true },
      { key: 'materialCode', label: '物料编码', serverRequired: true },
      { key: 'materialName', label: '物料名称' },
      { key: 'specification', label: '规格型号' },
      { key: 'sampleQty', label: '数量', type: 'number', serverRequired: true },
      { key: 'inspectorName', label: '检验人' },
    ],
  },
  heat: {
    title: '委外检验 · 热处理检验',
    fields: [
      { key: 'outsourceNo', label: '委外加工单号' },
      { key: 'batchNo', label: '批次号', serverRequired: true },
      { key: 'materialCode', label: '物料编码', serverRequired: true },
      { key: 'materialName', label: '物料名称' },
      { key: 'specification', label: '规格型号' },
      { key: 'sampleQty', label: '数量', type: 'number', serverRequired: true },
      { key: 'inspectorName', label: '检验人' },
    ],
  },
};

/**
 * 默认「回厂日期」区间 = 本月（月初 ~ 月末），与「默认显示本月」口径一致。
 * 每次调用都重新计算，跨月长驻页面时「重置」也能回到当月。
 */
function currentMonthRange(): { from: string; to: string } {
  // 默认不限日期：空串表示不下发 returnDateFrom/To，列表返回全部（与过程检验口径一致）。
  // 委外同步单的回厂日期多为空或历史，默认本月会把历史单全过滤掉，故改为默认不限。
  return { from: '', to: '' };
}

/**
 * 界面筛选条件集合。
 * 「查询 / 重置」按钮把新值直接作为参数送进 loadList，而不是靠 setState 后的闭包重渲染
 * —— 否则按钮里的 loadList 读到的仍是上一次渲染的旧筛选值（先发旧请求、后发新请求，
 * 若旧请求更晚返回还会把正确结果覆盖掉）。
 */
interface OutsourceFilters {
  doc: string;
  type: string;
  vendor: string;
  status: string;
  dateFrom: string;
  dateTo: string;
}

interface OrderRow {
  id?: string;
  orderNo: string;
  materialCode: string;
  materialName: string;
  batchNo: string;
  /** 规格型号快照：仓储 mapRow 同时输出 specification 与只读别名 spec */
  specification?: string;
  spec?: string;
  unit?: string;
  supplierCode?: string;
  sampleQty: number;
  status: string;
  inspectorName?: string;
  inspector?: string;
  createdAt?: string;
  processType?: string;
  /** 009 委外检验台账字段：委外加工单号 / 加工商名称 / 回厂日期 */
  outsourceNo?: string;
  vendorName?: string;
  supplierName?: string;
  returnDate?: string;
  /** 质量负责人签核人姓名（inspection_orders.approver_name，docs/35 §5）：未签核即空 */
  approverName?: string | null;
  /** 签核时间（inspection_orders.approved_at） */
  approvedAt?: string | null;
  /** 030 委外录入页业务事实字段（docs/36）：材质牌号 / 执行技术标准 / 检验日期 */
  materialGrade?: string;
  techStandard?: string;
  inspectedDate?: string;
  /** 完成时间（inspection_orders.completed_at）：签发日期回落的第二档 */
  completedAt?: string | null;
  /** 038 证书模板与证书专用字段袋：只取物理列，列为空即不下发该键 */
  certTemplate?: CertTemplateKind | null;
  certFields?: Record<string, string> | null;
  /** 「合格后传递」派生字段（服务端回填，docs/48 §4.6）：字段缺失即未下发，不是「允许」 */
  canTransfer?: boolean | null;
  transferCode?: string | null;
  predecessorOrderNo?: string | null;
  chainKey?: string | null;
  blockedBy?: TransferStateFields['blockedBy'];
}

export const OutsourceList: React.FC<OutsourceListProps> = ({ onInspect, initialTab }) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlTab = searchParams.get('tab') as 'surface' | 'machining' | 'heat' | null;
  const initialResolvedTab =
    urlTab && ['surface', 'machining', 'heat'].includes(urlTab)
      ? urlTab
      : initialTab && ['surface', 'machining', 'heat'].includes(initialTab)
      ? initialTab
      : 'surface';

  const [tab, setTab] = useState<'surface' | 'machining' | 'heat'>(initialResolvedTab);
  const [doc, setDoc] = useState('');
  const [type, setType] = useState('全部');
  const [vendor, setVendor] = useState('');
  const [status, setStatus] = useState('全部');
  // 「回厂日期」区间：默认本月（月初 ~ 月末），即「默认显示本月筛选内容」；清空即不限
  const [dateFrom, setDateFrom] = useState(() => currentMonthRange().from);
  const [dateTo, setDateTo] = useState(() => currentMonthRange().to);

  const [printModalOpen, setPrintModalOpen] = useState(false);
  const [certKind, setCertKind] = useState<CertTemplateKind>('MANUFACTURING');
  const [currentCertData, setCurrentCertData] = useState<ManufacturingCertData | null>(null);
  const [currentQualityData, setCurrentQualityData] = useState<QualityCertificateData | null>(null);

  // 表格数据一律来自 GET /inspections，未加载完成前保持空列表，不再渲染写死的演示行
  const [rows, setRows] = useState<OutsourceListItem[]>([]);
  const [rowTotal, setRowTotal] = useState<number>(0);
  const [listLoading, setListLoading] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 10;

  // 「新增检验」弹窗（筛选栏入口）：字段集与检验类型按当前页签（表面 / 机加 / 热处理）切换
  const [newInspectionOpen, setNewInspectionOpen] = useState(false);

  // 切换 Tab 同步 URL 查询参数
  const handleTabChange = (newTab: 'surface' | 'machining' | 'heat') => {
    const defaults = currentMonthRange();
    setTab(newTab);
    setPage(1);
    setDoc('');
    setType('全部');
    setVendor('');
    setStatus('全部');
    // 切页签同样回到「本月」：与其余筛选框统一清回默认态
    setDateFrom(defaults.from);
    setDateTo(defaults.to);
    const newParams = new URLSearchParams(searchParams);
    newParams.set('tab', newTab);
    setSearchParams(newParams);
  };

  const loadList = useCallback(async (targetPage: number, override?: Partial<OutsourceFilters>) => {
    // 按钮触发时以传入的新值为准（setState 是异步的，闭包里读到的还是上一次渲染的旧值）
    const f: OutsourceFilters = { doc, type, vendor, status, dateFrom, dateTo, ...override };
    // 起止日期选反时自动对调，避免「选反了查空」的困惑
    const [safeFrom, safeTo] =
      f.dateFrom !== '' && f.dateTo !== '' && f.dateFrom > f.dateTo
        ? [f.dateTo, f.dateFrom]
        : [f.dateFrom, f.dateTo];
    setListLoading(true);
    const backendType = tab === 'machining' ? 'OQC_MACH' : tab === 'heat' ? 'OQC_HEAT' : 'OQC_SF';
    try {
      const res = await api.get<{ total: number; list?: OrderRow[]; items?: OrderRow[] }>('/inspections', {
        inspectionType: backendType,
        page: targetPage,
        pageSize,
        ...(f.doc.trim() !== '' ? { outsourceNo: f.doc.trim() } : {}),
        ...(f.status !== '全部' && CN_TO_STATUSES[f.status] !== undefined
          ? { statuses: CN_TO_STATUSES[f.status] }
          : {}),
        // 「加工类型」与「加工商」同样下沉到后端：加工类型为精确匹配，加工商走 partner 模糊匹配
        // （后端 partner 命中供应商名称/编码），避免出现「接口返回一页、前端再筛一次」的双口径
        ...(f.type !== '全部' ? { processType: f.type } : {}),
        ...(f.vendor.trim() !== '' ? { partner: f.vendor.trim() } : {}),
        // 「回厂日期」区间下沉到后端 return_date 列：与 dateFrom/To 的建单时间、
        // inboundDate* 的来料入库日期是三套不同口径；留空即不限，展示上限由 MAX_DISPLAY_ROWS 兜住
        ...(safeFrom !== '' ? { returnDateFrom: safeFrom } : {}),
        ...(safeTo !== '' ? { returnDateTo: safeTo } : {}),
      });

      // 真实后端 GET /inspections 的响应信封为 { total, list, statusCounts }；
      // 离线 Mock（MSW）为 { items, total }，两种信封都兼容。
      const rows = Array.isArray(res?.list) ? res.list : Array.isArray(res?.items) ? res.items : [];

      if (rows.length > 0) {
        const mapped: OutsourceListItem[] = rows.map((o, idx) => ({
          id: o.id ?? `row-${targetPage}-${idx}`,
          docNo: o.orderNo,
          // 委外加工单号 / 加工类型 / 回厂日期 / 加工商 全部取自数据库列，
          // 不再用 batchNo 或写死厂名兜底，避免与真实台账口径不一致
          // 缺失即显示 '-'：不再回落到 batchNo（批次号 ≠ 委外加工单号，混用会让台账口径失真）
          outsourceNo: o.outsourceNo ?? '',
          processType: o.processType,
          materialCode: o.materialCode,
          materialName: o.materialName,
          // 规格型号 / 单位 / 委外批次号同样只取物理列：缺失即空串，
          // 录入表单按「无来源就留空」渲染，绝不用演示值顶替
          specification: o.specification ?? o.spec,
          unit: o.unit,
          batchNo: o.batchNo,
          qty: o.sampleQty,
          vendor: o.vendorName ?? o.supplierName ?? o.supplierCode ?? '',
          // 缺失即显示 '-'：不再用 createdAt 近似「回厂日期」（制单时间不是回厂时间）
          returnDate: o.returnDate ?? '-',
          status: STATUS_TO_CN[o.status] ?? '待检验',
          inspector: o.inspectorName || o.inspector || '-',
          // 030 委外录入页业务事实字段：同样只取物理列，缺失即空串（详情页按「无来源就留空」渲染）
          materialGrade: o.materialGrade ?? '',
          techStandard: o.techStandard ?? '',
          inspectedDate: o.inspectedDate ?? '',
          // 签发日期回落档（制造证书用）：同样只取物理列，缺失即空串
          completedAt: o.completedAt ?? '',
          createdAt: o.createdAt ?? '',
          approverName: o.approverName || '',
          approvedAt: o.approvedAt || '',
          certTemplate: o.certTemplate ?? undefined,
          certFields: o.certFields ?? undefined,
          tabType: tab,
          // 传递派生字段原样透传，前端不做任何推导（docs/48 §2.1：规则在领域、执法在应用、其余只呈现）
          canTransfer: o.canTransfer ?? null,
          transferCode: o.transferCode ?? null,
          predecessorOrderNo: o.predecessorOrderNo ?? null,
          chainKey: o.chainKey ?? null,
          blockedBy: o.blockedBy ?? null,
        }));
        setRows(mapped);
        setRowTotal(res.total ?? mapped.length);
      } else {
        setRows([]);
        setRowTotal(res?.total ?? 0);
      }
    } catch {
      setRows([]);
      setRowTotal(0);
    } finally {
      setListLoading(false);
    }
  }, [tab, doc, status, type, vendor, dateFrom, dateTo]);

  useEffect(() => {
    loadList(page);
  }, [loadList, page]);

  /** 建单成功后刷新当前页签台账（回厂日期默认不限，新单直接可见） */
  const handleInspectionCreated = useCallback(() => {
    setPage(1);
    void loadList(1);
  }, [loadList]);

  // 筛选已全部下沉到后端（inspectionType / outsourceNo / statuses / processType / partner /
  // returnDateFrom / returnDateTo），前端不再二次过滤：列表直接渲染服务端返回的当前页数据，
  // 页脚条数取服务端命中总数。
  const filteredList = rows;

  // 展示上限：命中超过 1 万条时只允许浏览前 1 万条（1000 页 × 10 条/页），
  // 计数显示「10,000+」并提示缩小日期范围——避免无界翻页拖垮后端。
  const overCap = rowTotal > MAX_DISPLAY_ROWS;
  const displayTotal = Math.min(rowTotal, MAX_DISPLAY_ROWS);
  const maxPage = Math.max(1, Math.ceil(displayTotal / pageSize));

  /** 查询：把界面条件提交并回到第 1 页（新值直接传参，避免闭包读到上一次渲染的旧值） */
  const handleSearch = () => {
    const from = dateFrom.trim();
    const to = dateTo.trim();
    // 起止选反时自动对调，避免「选反了查空」的困惑
    const [safeFrom, safeTo] = from !== '' && to !== '' && from > to ? [to, from] : [from, to];
    setDateFrom(safeFrom);
    setDateTo(safeTo);
    setPage(1);
    void loadList(1, { dateFrom: safeFrom, dateTo: safeTo });
  };

  /** 重置：清空界面条件并把「回厂日期」恢复为默认本月（与「默认显示本月」口径一致） */
  const handleReset = () => {
    const defaults = currentMonthRange();
    setDoc('');
    setType('全部');
    setVendor('');
    setStatus('全部');
    setDateFrom(defaults.from);
    setDateTo(defaults.to);
    setPage(1);
    void loadList(1, {
      doc: '',
      type: '全部',
      vendor: '',
      status: '全部',
      dateFrom: defaults.from,
      dateTo: defaults.to,
    });
  };

  /**
   * 行级证书（docs/35 §10 M9，委外台账为基准）：按本行真实数据组装，未录入的项留白。
   * 企业档案（抬头）取主数据、质量负责人取真实签核人；两者都没有来源即留白。
   */
  const handleOpenCert = (item: OutsourceListItem) => {
    void (async () => {
      const companyProfile = await loadCompanyProfile();
      // 版式取本单建单时选定的 cert_template（docs/51）；历史单无值按本模块缺省 MANUFACTURING 出证
      const kind: CertTemplateKind = item.certTemplate ?? 'MANUFACTURING';
      if (kind === 'QUALITY') {
        setCurrentQualityData(
          buildOqcCertificateData({
            orderNo: item.docNo,
            docNo: item.docNo,
            productName: item.materialName,
            materialName: item.materialName,
            specification: item.specification,
            batchNo: item.batchNo,
            quantity: item.qty > 0 ? String(item.qty) : '',
            inspector: item.inspector === '-' ? '' : item.inspector,
            standard: item.techStandard,
            inspectionDate: item.inspectedDate,
            certFields: item.certFields,
            ...(item.approverName !== undefined && item.approverName !== ''
              ? { approverName: item.approverName }
              : {}),
            ...(companyProfile !== null ? { companyProfile } : {}),
          })
        );
        setCurrentCertData(null);
      } else {
        setCurrentQualityData(null);
        setCurrentCertData(convertOutsourceToManufacturingCert({
        docNo: item.docNo,
        outsourceNo: item.outsourceNo,
        materialCode: item.materialCode,
        materialName: item.materialName,
        specification: item.specification,
        // 材质牌号随台账行一起带到证书「材料级别」列（此前只在录入页传，台账入口漏传）
        materialGrade: item.materialGrade,
        process: item.processType,
        quantityPcs: item.qty > 0 ? String(item.qty) : '',
        vendor: item.vendor,
        batchNo: item.batchNo,
        inspector: item.inspector === '-' ? '' : item.inspector,
        // 030 字段接入制造证书（docs/36 §6）：「Specification (执行规范)」行读 tech_standard；
        // 签发日期按 inspected_date → completed_at → created_at 回落（与录入页证书同一口径），
        // 三档皆空时才由 buildManufacturingCertData 取「今天」（本证书生成动作的真实日期）
        standard: item.techStandard,
        dateOfIssue: (item.inspectedDate || item.completedAt || item.createdAt || '').slice(0, 10),
        // 印章结论取台账状态（真实落库值）；待检验 / 检验中不下结论
        overallDecision:
          item.status === '已合格' ? 'PASSED' : item.status === '不合格' ? 'FAILED' : '',
        // 质量负责人只有真实签核过才有值；未签核即空（不打印编造人名）
        ...(item.approverName !== undefined && item.approverName !== '' ? { approverName: item.approverName } : {}),
        certFields: item.certFields,
        ...(companyProfile !== null ? { companyProfile } : {}),
        }));
      }
      setCertKind(kind);
      setPrintModalOpen(true);
    })();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h2 className="text-base font-bold text-slate-800">委外检验</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            数据来源: ERP委外加工单 + MES表面处理工序 · 委外件回厂后生成检验任务
          </p>
        </div>
        {/*
          新建委外检验单（docs/35 §8 M7）：此前「新建」路径 UI 不可达（入口总带 id），
          表单的 POST /inspections 建单能力因此从未被用户走到。这里补上入口，传空对象而不是 null
          （父页以 `if (activeOutsourceRecord)` 判断是否进入录入页，null 会留在列表页）；
          物料编码由表单内的选择器从存货主数据选择（不再由 materialCode 为空静默拦下）。
        */}
        <button
          type="button"
          // 带上当前页签：表单按 `initialItem.tabType` 推导 inspectionType，
          // 不带的话在「热处理」页点新建会建成 OQC_SF（表面处理）—— 建单类型与用户所在页不符，
          // 传递门禁也会按错误环节判定（docs/48 §2.2 锚点与环节类型相关）。
          onClick={() => onInspect({ tabType: tab }, false, tab === 'surface')}
          className="px-4 py-1.5 rounded bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 shadow-sm flex items-center gap-1.5 shrink-0"
        >
          <span aria-hidden="true">+</span> 新建委外检验单
        </button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-6 border-b border-slate-200 text-xs">
        <button
          onClick={() => handleTabChange('surface')}
          className={`pb-2.5 font-medium transition-colors relative ${
            tab === 'surface'
              ? 'text-blue-600 border-b-2 border-blue-600'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          表面处理检验
        </button>
        <button
          onClick={() => handleTabChange('machining')}
          className={`pb-2.5 font-medium transition-colors relative ${
            tab === 'machining'
              ? 'text-blue-600 border-b-2 border-blue-600'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          机加工检验
        </button>
        <button
          onClick={() => handleTabChange('heat')}
          className={`pb-2.5 font-medium transition-colors relative ${
            tab === 'heat'
              ? 'text-blue-600 border-b-2 border-blue-600'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          热处理检验
        </button>
      </div>

      {/*
        Filters：「回厂日期」区间在三个页签通用 —— 委外件关注的业务时点是「回厂」；
        其余筛选框（委外加工单号 / 加工类型 / 加工商 / 检验状态）按原型仅在表面处理展示。
      */}
      <div className="bg-white border border-slate-200/80 rounded-lg p-4 shadow-sm flex flex-wrap items-center gap-4 text-xs">
        {tab === 'surface' && (
          <>
            <div className="flex items-center gap-2">
              <span className="text-slate-600 font-medium">委外加工单号</span>
              <input
                type="text"
                placeholder="WWJG-20260706-001"
                value={doc}
                onChange={(e) => setDoc(e.target.value)}
                className="border border-slate-200 rounded px-2.5 py-1.5 w-40 text-slate-700 placeholder-slate-400 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-slate-600 font-medium">加工类型</span>
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="border border-slate-200 rounded px-2.5 py-1.5 w-28 text-slate-700 bg-white focus:outline-none focus:border-blue-500"
              >
                <option value="全部">全部</option>
                <option value="镀锌">镀锌</option>
                <option value="镀镍">镀镍</option>
                <option value="发黑">发黑</option>
                <option value="磷化">磷化</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-slate-600 font-medium">加工商</span>
              <input
                type="text"
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
                className="border border-slate-200 rounded px-2.5 py-1.5 w-36 text-slate-700 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-slate-600 font-medium">检验状态</span>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="border border-slate-200 rounded px-2.5 py-1.5 w-28 text-slate-700 bg-white focus:outline-none focus:border-blue-500"
              >
                <option value="全部">全部</option>
                <option value="待检验">待检验</option>
                <option value="已合格">已合格</option>
                <option value="不合格">不合格</option>
              </select>
            </div>
          </>
        )}

        {/* 回厂日期区间：默认本月；两个框都清空即不限（展示上限仍为 MAX_DISPLAY_ROWS） */}
        <div className="flex items-center gap-2">
          <span className="text-slate-600 font-medium">回厂日期</span>
          <DateInput
            wrapClassName="w-36"
            placeholder="开始日期"
            value={dateFrom}
            // 改日期即回到第 1 页：新区间的结果集与当前页次无关，留在原页容易看到空列表
            onChange={(e) => {
              setDateFrom(e.target.value);
              setPage(1);
            }}
            className="px-2 py-1.5 text-xs border border-slate-200 rounded text-slate-700 focus:outline-none focus:border-blue-500"
          />
          <span className="text-slate-400">~</span>
          <DateInput
            wrapClassName="w-36"
            placeholder="结束日期"
            value={dateTo}
            onChange={(e) => {
              setDateTo(e.target.value);
              setPage(1);
            }}
            className="px-2 py-1.5 text-xs border border-slate-200 rounded text-slate-700 focus:outline-none focus:border-blue-500"
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setNewInspectionOpen(true)}
            className="px-3.5 py-1.5 rounded bg-emerald-600 text-white font-medium hover:bg-emerald-700 shadow-sm cursor-pointer flex items-center gap-1"
          >
            <span aria-hidden="true" className="text-[14px] leading-none">+</span> 新增检验
          </button>
          <button
            type="button"
            onClick={handleReset}
            className="px-3.5 py-1.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 cursor-pointer"
          >
            重置
          </button>
          <button
            type="button"
            onClick={handleSearch}
            className="px-4 py-1.5 rounded bg-blue-600 text-white font-medium hover:bg-blue-700 shadow-sm cursor-pointer"
          >
            查询
          </button>
        </div>
      </div>

      {/* Table */}
      {/* 台账列数已到 12 列：给表格一个最小宽度并允许横向滚动，
          否则中文表头会被压成竖排单字、规格字符串被逐字折行（1280 宽下必现） */}
      <div className="bg-white border border-slate-200/80 rounded-lg shadow-sm overflow-x-auto">
        <table className="w-full min-w-[1200px] text-xs text-left">
          <thead className="bg-[#F8FAFC] text-slate-600 font-medium border-b border-slate-200">
            <tr>
              <th className="py-3 px-4">检验单号</th>
              <th className="py-3 px-4">委外加工单号</th>
              {tab === 'surface' && <th className="py-3 px-4">加工类型</th>}
              <th className="py-3 px-4">物料编码</th>
              <th className="py-3 px-4">物料名称</th>
              <th className="py-3 px-4 whitespace-nowrap">规格尺寸</th>
              <th className="py-3 px-4">数量</th>
              <th className="py-3 px-4">加工商</th>
              <th className="py-3 px-4">回厂日期</th>
              <th className="py-3 px-4">状态</th>
              <th className="py-3 px-4">检验人</th>
              <th className="py-3 px-4">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-slate-700">
            {listLoading && (
              <tr>
                <td colSpan={tab === 'surface' ? 12 : 11} className="py-10 text-center text-slate-400">
                  加载中...
                </td>
              </tr>
            )}
            {!listLoading && filteredList.length === 0 && (
              <tr>
                <td colSpan={tab === 'surface' ? 12 : 11} className="py-10 text-center text-slate-400">
                  暂无检验单数据
                </td>
              </tr>
            )}
            {!listLoading &&
              filteredList.map((item) => (
                <tr
                  key={item.id}
                  className={`transition-colors ${
                    item.canTransfer === false ? 'bg-rose-50/40 hover:bg-rose-50/60' : 'hover:bg-slate-50/60'
                  }`}
                >
                  <td className="py-3 px-4">
                    <span
                      onClick={() => onInspect({ ...item }, item.status !== '待检验' && item.status !== '检验中', tab === 'surface')}
                      className="font-medium text-blue-600 hover:underline cursor-pointer"
                    >
                      {item.docNo}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-slate-600">
                    {item.outsourceNo !== '' ? (
                      item.outsourceNo
                    ) : (
                      // 历史导入行 ERP 侧无委外加工单：如实留空并说明，绝不编造单号（docs/34 §3）
                      <span className="text-slate-400" title="ERP 无委外加工单（历史导入行）">
                        —
                      </span>
                    )}
                  </td>
                  {tab === 'surface' && (
                    <td className="py-3 px-4">
                      {/* process_type 为空的委外工单（如历史数据）不渲染徽标，禁用空胶囊占位 */}
                      {item.processType ? (
                        <span className="px-2 py-0.5 rounded bg-sky-100 text-sky-700 text-[11px]">
                          {item.processType}
                        </span>
                      ) : (
                        <span className="text-slate-400">-</span>
                      )}
                    </td>
                  )}
                  <td className="py-3 px-4 font-medium text-slate-900">{item.materialCode}</td>
                  <td className="py-3 px-4 text-slate-800">{item.materialName}</td>
                  {/* 规格尺寸取 inspection_orders.specification 真实列（API 已随台账返回）；
                      历史导入行该列为空即如实留白，不用物料名称里的型号顶替 */}
                  <td className="py-3 px-4 text-slate-600 min-w-[170px]">
                    {item.specification !== '' && item.specification !== undefined ? (
                      <span title={item.specification}>{item.specification}</span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="py-3 px-4">{item.qty}</td>
                  <td className="py-3 px-4 text-slate-600">{item.vendor}</td>
                  <td className="py-3 px-4 text-slate-500">{item.returnDate}</td>
                  <td className="py-3 px-4">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium ${
                        item.status === '已合格'
                          ? 'bg-emerald-100 text-emerald-700'
                          : item.status === '不合格'
                          ? 'bg-rose-100 text-rose-700'
                          : item.status === '检验中'
                          ? 'bg-blue-100 text-blue-700'
                          : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {item.status}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-slate-600">{item.inspector}</td>
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-3">
                      {(item.status === '待检验' || item.status === '检验中') && (
                        <button
                          onClick={() => onInspect({ ...item }, false, tab === 'surface')}
                          className="text-blue-600 hover:underline cursor-pointer"
                        >
                          {item.status === '待检验' ? '检验' : '继续'}
                        </button>
                      )}
                      <button
                        onClick={() => onInspect({ ...item }, true, tab === 'surface')}
                        className="text-blue-600 hover:underline cursor-pointer"
                      >
                        详情
                      </button>
                      <button
                        onClick={() => handleOpenCert(item)}
                        className="text-indigo-600 hover:underline cursor-pointer"
                        title="按本行数据导出制造证书（未录入的项留白）"
                      >
                        证书
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-xs text-slate-500 pt-2">
        <div>
          共 {overCap ? `${MAX_DISPLAY_ROWS.toLocaleString()}+` : rowTotal} 条委外检验记录
          {overCap && (
            <span className="ml-2 text-amber-600">
              （展示前 {MAX_DISPLAY_ROWS.toLocaleString()} 条，请缩小日期范围）
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="px-2.5 py-1 rounded border border-slate-200 disabled:opacity-40 hover:bg-slate-50 cursor-pointer disabled:cursor-not-allowed"
          >
            上一页
          </button>
          <span>
            第 {page} / {maxPage} 页
          </span>
          <button
            type="button"
            disabled={page >= maxPage}
            onClick={() => setPage((p) => p + 1)}
            className="px-2.5 py-1 rounded border border-slate-200 disabled:opacity-40 hover:bg-slate-50 cursor-pointer disabled:cursor-not-allowed"
          >
            下一页
          </button>
        </div>
      </div>

      {/* 证书导出与打印模态框（版式按本单 cert_template，docs/51） */}
      <CertificatePrintModal
        isOpen={printModalOpen}
        onClose={() => setPrintModalOpen(false)}
        type={certKind === 'QUALITY' ? 'quality' : 'manufacturing'}
        manufacturingData={currentCertData}
        qualityData={currentQualityData}
      />

      {/* 新增检验弹窗（筛选栏「新增检验」入口，按当前页签配置字段与检验类型） */}
      <NewInspectionModal
        isOpen={newInspectionOpen}
        onClose={() => setNewInspectionOpen(false)}
        onCreated={handleInspectionCreated}
        moduleTitle={NEW_OUTSOURCE_FIELD_SETS[tab].title}
        inspectionType={tab === 'machining' ? 'OQC_MACH' : tab === 'heat' ? 'OQC_HEAT' : 'OQC_SF'}
        fields={NEW_OUTSOURCE_FIELD_SETS[tab].fields}
      />
    </div>
  );
};
