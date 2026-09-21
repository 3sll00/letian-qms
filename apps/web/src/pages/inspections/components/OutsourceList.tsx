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
import { CertificatePrintModal } from '../../../components/certificate/CertificatePrintModal';
import { convertOutsourceToManufacturingCert } from '../../../lib/certificateDataService';
import { ManufacturingCertData } from '../../../lib/inspectionTypes';
import { api } from '../../../lib/api';

interface OutsourceListProps {
  onInspect: (item: any) => void;
  initialTab?: 'surface' | 'machining' | 'heat';
}

export interface OutsourceListItem {
  id: string;
  docNo: string;
  outsourceNo: string;
  processType?: string;
  materialCode: string;
  materialName: string;
  qty: number;
  vendor: string;
  returnDate: string;
  status: '待检验' | '检验中' | '已合格' | '不合格';
  inspector: string;
  tabType: 'surface' | 'machining' | 'heat';
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

interface OrderRow {
  id?: string;
  orderNo: string;
  materialCode: string;
  materialName: string;
  batchNo: string;
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

  const [printModalOpen, setPrintModalOpen] = useState(false);
  const [currentCertData, setCurrentCertData] = useState<ManufacturingCertData | null>(null);

  // 表格数据一律来自 GET /inspections，未加载完成前保持空列表，不再渲染写死的演示行
  const [rows, setRows] = useState<OutsourceListItem[]>([]);
  const [rowTotal, setRowTotal] = useState<number>(0);
  const [listLoading, setListLoading] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 10;

  // 切换 Tab 同步 URL 查询参数
  const handleTabChange = (newTab: 'surface' | 'machining' | 'heat') => {
    setTab(newTab);
    setPage(1);
    setDoc('');
    setType('全部');
    setVendor('');
    setStatus('全部');
    const newParams = new URLSearchParams(searchParams);
    newParams.set('tab', newTab);
    setSearchParams(newParams);
  };

  const loadList = useCallback(async (targetPage: number) => {
    setListLoading(true);
    const backendType = tab === 'machining' ? 'OQC_MACH' : tab === 'heat' ? 'OQC_HEAT' : 'OQC_SF';
    try {
      const res = await api.get<{ total: number; list?: OrderRow[]; items?: OrderRow[] }>('/inspections', {
        inspectionType: backendType,
        page: targetPage,
        pageSize,
        ...(doc.trim() !== '' ? { outsourceNo: doc.trim() } : {}),
        ...(status !== '全部' && CN_TO_STATUSES[status] !== undefined
          ? { statuses: CN_TO_STATUSES[status] }
          : {}),
        // 「加工类型」与「加工商」同样下沉到后端：加工类型为精确匹配，加工商走 partner 模糊匹配
        // （后端 partner 命中供应商名称/编码），避免出现「接口返回一页、前端再筛一次」的双口径
        ...(type !== '全部' ? { processType: type } : {}),
        ...(vendor.trim() !== '' ? { partner: vendor.trim() } : {}),
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
          outsourceNo: o.outsourceNo ?? '-',
          processType: o.processType,
          materialCode: o.materialCode,
          materialName: o.materialName,
          qty: o.sampleQty,
          vendor: o.vendorName ?? o.supplierName ?? o.supplierCode ?? '',
          // 缺失即显示 '-'：不再用 createdAt 近似「回厂日期」（制单时间不是回厂时间）
          returnDate: o.returnDate ?? '-',
          status: STATUS_TO_CN[o.status] ?? '待检验',
          inspector: o.inspectorName || o.inspector || '-',
          tabType: tab,
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
  }, [tab, doc, status, type, vendor]);

  useEffect(() => {
    loadList(page);
  }, [loadList, page]);

  // 筛选已全部下沉到后端（inspectionType / outsourceNo / statuses / processType / partner），
  // 前端不再二次过滤：列表直接渲染服务端返回的当前页数据，页脚条数取服务端命中总数。
  const filteredList = rows;

  const handleOpenCert = (item: OutsourceListItem) => {
    const cert = convertOutsourceToManufacturingCert({
      docNo: item.docNo,
      orderNo: item.outsourceNo,
      materialCode: item.materialCode,
      materialName: item.materialName,
      processType: item.processType ?? (tab === 'machining' ? '精密机加工' : tab === 'heat' ? '热处理' : '表面处理'),
      quantity: item.qty,
      supplier: item.vendor,
      receiveDate: item.returnDate,
      inspector: item.inspector === '-' ? '' : item.inspector,
      status: item.status,
    });
    setCurrentCertData(cert);
    setPrintModalOpen(true);
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-bold text-slate-800">委外检验</h2>
        <p className="text-xs text-slate-400 mt-0.5">
          数据来源: ERP委外加工单 + MES表面处理工序 · 委外件回厂后生成检验任务
        </p>
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

      {/* Filters: 仅在表面处理检验展示，机加工与热处理按原型直接展示表格 */}
      {tab === 'surface' && (
        <div className="bg-white border border-slate-200/80 rounded-lg p-4 shadow-sm flex flex-wrap items-center gap-4 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-slate-600 font-medium">委外加工单号</span>
            <input
              type="text"
              placeholder="WW-20260706-001"
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

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setDoc('');
                setType('全部');
                setVendor('');
                setStatus('全部');
                setPage(1);
                void loadList(1);
              }}
              className="px-3.5 py-1.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 cursor-pointer"
            >
              重置
            </button>
            <button
              type="button"
              onClick={() => {
                setPage(1);
                void loadList(1);
              }}
              className="px-4 py-1.5 rounded bg-blue-600 text-white font-medium hover:bg-blue-700 shadow-sm cursor-pointer"
            >
              查询
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-white border border-slate-200/80 rounded-lg shadow-sm overflow-hidden">
        <table className="w-full text-xs text-left">
          <thead className="bg-[#F8FAFC] text-slate-600 font-medium border-b border-slate-200">
            <tr>
              <th className="py-3 px-4">检验单号</th>
              <th className="py-3 px-4">委外加工单号</th>
              {tab === 'surface' && <th className="py-3 px-4">加工类型</th>}
              <th className="py-3 px-4">物料编码</th>
              <th className="py-3 px-4">物料名称</th>
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
                <td colSpan={tab === 'surface' ? 11 : 10} className="py-10 text-center text-slate-400">
                  加载中...
                </td>
              </tr>
            )}
            {!listLoading && filteredList.length === 0 && (
              <tr>
                <td colSpan={tab === 'surface' ? 11 : 10} className="py-10 text-center text-slate-400">
                  暂无检验单数据
                </td>
              </tr>
            )}
            {!listLoading &&
              filteredList.map((item) => (
                <tr key={item.id} className="hover:bg-slate-50/60 transition-colors">
                  <td className="py-3 px-4">
                    <span
                      onClick={() => onInspect({ ...item })}
                      className="font-medium text-blue-600 hover:underline cursor-pointer"
                    >
                      {item.docNo}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-slate-600">{item.outsourceNo}</td>
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
                    <button
                      onClick={() => onInspect({ ...item })}
                      className="text-blue-600 hover:underline cursor-pointer"
                    >
                      {item.status === '待检验' ? '检验' : '详情'}
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-xs text-slate-500 pt-2">
        <div>共 {rowTotal} 条委外检验记录</div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="px-2.5 py-1 rounded border border-slate-200 disabled:opacity-40 hover:bg-slate-50 cursor-pointer disabled:cursor-not-allowed"
          >
            上一页
          </button>
          <span>第 {page} 页</span>
          <button
            type="button"
            disabled={page * pageSize >= rowTotal}
            onClick={() => setPage((p) => p + 1)}
            className="px-2.5 py-1 rounded border border-slate-200 disabled:opacity-40 hover:bg-slate-50 cursor-pointer disabled:cursor-not-allowed"
          >
            下一页
          </button>
        </div>
      </div>

      {/* 委外制造证书导出与打印模态框 */}
      <CertificatePrintModal
        isOpen={printModalOpen}
        onClose={() => setPrintModalOpen(false)}
        type="manufacturing"
        manufacturingData={currentCertData}
      />
    </div>
  );
};
