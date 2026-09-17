import React, { useEffect, useState } from 'react';
import {
  Search,
  PlusCircle,
  Download,
  ShieldCheck,
  FileCheck2,
  XCircle,
  AlertTriangle,
  Scissors,
  X,
  ChevronRight,
} from 'lucide-react';
import { StatusBadge } from '../../components/StatusBadge';
import type {
  CreateInspectionOrderRequest,
  InspectionOrder,
  InspectionPlan,
  InspectionType,
} from '@letian/contracts';
import { api, errorMessage } from '../../lib/api';
import {
  INSPECTION_FILTER_TABS,
  INSPECTION_GROUPS,
  INSPECTION_STATUS_LABELS,
  inspectionTypeLabel,
  type InspectionFilterTab,
  type InspectionGroup,
} from '../../lib/inspectionTypes';

// 页面筛选页签、展示名与录入表单的检验类型映射统一收敛到
// src/lib/inspectionTypes.ts (契约 InspectionTypeEnum 为唯一真理源)。

/** 可绑定的方案版本（来自 GET /api/v1/plans，契约 InspectionPlan.versions） */
interface PlanVersionOption {
  planId: string;
  planCode: string;
  planName: string;
  /** 取契约 InspectionTypeEnum，保证能直接交给 inspectionTypeLabel 做穷举映射 */
  inspectionType: InspectionType;
  versionId: string;
  versionNo: string;
  status: string;
}

interface PagedInspections {
  total: number;
  page: number;
  pageSize: number;
  items: InspectionOrder[];
}

export function InspectionsPage() {
  const [records, setRecords] = useState<InspectionOrder[]>([]);
  const [filterType, setFilterType] = useState<InspectionFilterTab>('ALL');
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<InspectionOrder | null>(null);
  const [staffNameMap, setStaffNameMap] = useState<Record<string, string>>({});
  const [planVersions, setPlanVersions] = useState<PlanVersionOption[]>([]);
  const [planVersionId, setPlanVersionId] = useState('');
  const [listError, setListError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  // New inspection form state
  const [newBatchNo, setNewBatchNo] = useState('');
  const [newMaterialCode, setNewMaterialCode] = useState('MAT-304SS-05');
  const [newMaterialName, setNewMaterialName] = useState('不锈钢圆线材 Φ5.0mm');
  const [newOrderNo, setNewOrderNo] = useState('MO-2023101501');
  const [newOrderQty, setNewOrderQty] = useState(5000);
  const [newType, setNewType] = useState<InspectionGroup>('IPQC');
  const [newBlankingLength, setNewBlankingLength] = useState(25.0);
  const [newDefect, setNewDefect] = useState('');
  const [newOverallResult, setNewOverallResult] = useState<'PASS' | 'FAIL' | 'CONCESSION'>('PASS');

  useEffect(() => {
    api
      .get<{ id: string; name: string }[]>('/master-data/employees')
      .then((list) => {
        const map: Record<string, string> = {};
        list.forEach((e) => {
          if (e.id) map[e.id] = e.name;
        });
        setStaffNameMap(map);
      })
      .catch((err) => console.error('Failed to fetch staff list:', err));

    // 新建工单必须绑定真实存在的方案版本主键，否则后端返回 404（无法生成方案快照）
    api
      .get<{ items: InspectionPlan[] }>('/plans', { pageSize: 100 })
      .then((data) => {
        const options: PlanVersionOption[] = [];
        for (const plan of data.items) {
          for (const version of plan.versions ?? []) {
            // 契约里方案 id 与版本 id 都是可选字段，缺任一主键都无法作为落库引用，直接跳过
            const planId = plan.id ?? version.planId;
            if (!version.id || !planId) continue;
            options.push({
              planId,
              planCode: plan.planCode,
              planName: plan.planName,
              inspectionType: plan.inspectionType,
              versionId: version.id,
              versionNo: version.versionNo,
              status: version.status,
            });
          }
        }
        setPlanVersions(options);
        const firstActive = options.find((o) => o.status === 'ACTIVE') ?? options[0];
        if (firstActive) setPlanVersionId(firstActive.versionId);
      })
      .catch((err) => console.error('Failed to fetch inspection plans:', err));
  }, []);

  const fetchRecords = () => {
    const query: Record<string, string | undefined> = {};
    if (filterType !== 'ALL') query.type = filterType;
    if (search) query.keyword = search;

    api
      .get<PagedInspections>('/inspections', query)
      .then((data) => {
        setRecords(data.items ?? []);
        setListError(null);
      })
      .catch((err) => {
        setListError(errorMessage(err));
        console.error('Failed to fetch inspection records:', err);
      });
  };

  useEffect(() => {
    fetchRecords();
  }, [filterType, search]);

  const handleCreateInspection = async (e: React.FormEvent) => {
    e.preventDefault();

    const payload: CreateInspectionOrderRequest = {
      orderNo: newOrderNo,
      inspectionType: INSPECTION_GROUPS[newType].submitType,
      materialCode: newMaterialCode,
      materialName: newMaterialName,
      batchNo: newBatchNo || `B20231015-${Math.floor(Math.random() * 90 + 10)}`,
      sampleQty: Number(newOrderQty),
      planVersionId,
      isMandatoryGate: newType === 'FQC',
    };

    try {
      await api.post<InspectionOrder>('/inspections', payload);
      setShowModal(false);
      setCreateError(null);
      fetchRecords();
    } catch (err) {
      setCreateError(errorMessage(err));
      console.error('Create inspection error:', err);
    }
  };

  const handleExportCSV = async () => {
    try {
      const csv = await api.getText('/export/inspections', { format: 'csv' });
      const link = document.createElement('a');
      link.setAttribute(
        'href',
        `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`
      );
      link.setAttribute('download', `QMS质检记录台账_${Date.now()}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      console.error('Export CSV error:', err);
      setListError(`导出失败：${errorMessage(err)}`);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-slate-900/80 border border-slate-800 p-5 rounded-xl">
        <div>
          <h2 className="text-base font-semibold text-white flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-sky-400" />
            质检执行工作台与 11 列高精度下料质检台账
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            涵盖 IQC 来料检验、下料/冷镦/搓丝 IPQC 巡检、FQC 终检强制标识与不合格红标报警
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExportCSV}
            className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg border border-slate-700 transition shadow"
          >
            <Download className="w-4 h-4 text-slate-400" />
            导出检验报表 (CSV)
          </button>
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold rounded-lg shadow-lg shadow-sky-600/30 transition"
          >
            <PlusCircle className="w-4 h-4" />
            录入检验记录
          </button>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4">
        <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-lg border border-slate-800">
          {INSPECTION_FILTER_TABS.map((t) => (
            <button
              key={t}
              onClick={() => setFilterType(t)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${
                filterType === t
                  ? 'bg-sky-600 text-white shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {t === 'ALL' ? '全部类型' : `${t} 检验`}
            </button>
          ))}
        </div>

        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
          <input
            type="text"
            placeholder="搜索批次号、物料名、工单号..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full sm:w-72 bg-slate-900 border border-slate-800 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-400 focus:outline-none focus:border-sky-500"
          />
        </div>
      </div>

      {listError !== null && (
        <div className="p-3 rounded-lg bg-rose-950/40 border border-rose-500/40 text-rose-300 text-xs">
          台账数据加载失败：{listError}
        </div>
      )}

      {/* 11-column Precision Table */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950/80 text-slate-400 uppercase font-mono tracking-wider border-b border-slate-800">
              <tr>
                <th className="px-3.5 py-3">序号 / 记录ID</th>
                <th className="px-3.5 py-3">检验类型</th>
                <th className="px-3.5 py-3">生产批次号</th>
                <th className="px-3.5 py-3">物料编码 / 名称</th>
                <th className="px-3.5 py-3">生产工单</th>
                <th className="px-3.5 py-3">批量 (件)</th>
                <th className="px-3.5 py-3">下料实测尺寸</th>
                <th className="px-3.5 py-3">检验结果</th>
                <th className="px-3.5 py-3">成品强检印章</th>
                <th className="px-3.5 py-3">检验员</th>
                <th className="px-3.5 py-3">操作 / 明细</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-sans">
              {records.map((rec, idx) => {
                const isFail = rec.overallDecision === 'FAILED';
                const isConcession = rec.overallDecision === 'CONCESSION';
                const dimItem = rec.items.find((i) => i.measuredVal !== undefined);
                const firstFailedItem = rec.items.find((i) => i.result === 'FAILED');

                return (
                  <tr
                    key={rec.id}
                    className={`transition ${
                      isFail
                        ? 'bg-rose-950/30 hover:bg-rose-950/50 border-l-4 border-l-rose-500'
                        : isConcession
                        ? 'bg-amber-950/20 hover:bg-amber-950/40 border-l-4 border-l-amber-500'
                        : 'hover:bg-slate-800/40 border-l-4 border-l-transparent'
                    }`}
                  >
                    {/* 1. ID */}
                    <td className="px-3.5 py-3 font-mono text-slate-400 whitespace-nowrap">
                      <span className="text-[11px] text-slate-400 mr-1.5">{idx + 1}.</span>
                      <span className="text-sky-400 font-medium">{rec.id}</span>
                    </td>

                    {/* 2. Type */}
                    <td className="px-3.5 py-3 whitespace-nowrap">
                      <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono text-[11px] border border-slate-700">
                        {inspectionTypeLabel(rec.inspectionType)}
                      </span>
                    </td>

                    {/* 3. Batch No */}
                    <td className="px-3.5 py-3 font-mono font-medium text-white whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <span>{rec.batchNo}</span>
                        {isFail && (
                          <span className="text-[10px] bg-rose-600 text-white px-1.5 py-0.2 rounded font-mono font-bold animate-pulse">
                            LOCK
                          </span>
                        )}
                      </div>
                    </td>

                    {/* 4. Material */}
                    <td className="px-3.5 py-3">
                      <div className="text-slate-200 font-medium">{rec.materialName}</div>
                      <div className="text-[10px] text-slate-400 font-mono">
                        {rec.materialCode}
                      </div>
                    </td>

                    {/* 5. Order Number */}
                    <td className="px-3.5 py-3 font-mono text-slate-300 text-[11px] whitespace-nowrap">
                      {rec.orderNo}
                    </td>

                    {/* 6. Sample Quantity */}
                    <td className="px-3.5 py-3 font-mono text-slate-300 text-[11px] whitespace-nowrap">
                      {rec.sampleQty.toLocaleString()}
                    </td>

                    {/* 7. Blanking precision measurement */}
                    <td className="px-3.5 py-3 whitespace-nowrap font-mono">
                      {dimItem ? (
                        <div className="flex items-center gap-1">
                          <Scissors className="w-3.5 h-3.5 text-sky-400" />
                          <span
                            className={
                              isFail
                                ? 'text-rose-400 font-bold bg-rose-950/80 px-1 rounded'
                                : 'text-emerald-400'
                            }
                          >
                            {dimItem.measuredVal} {dimItem.unit}
                          </span>
                        </div>
                      ) : (
                        <span className="text-slate-400">-</span>
                      )}
                    </td>

                    {/* 8. Inspection Result */}
                    <td className="px-3.5 py-3 whitespace-nowrap">
                      {isFail ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold font-mono bg-rose-600 text-white shadow-lg shadow-rose-600/40 animate-pulse">
                          <XCircle className="w-3.5 h-3.5" />
                          不合格 (FAIL)
                        </span>
                      ) : isConcession ? (
                        <StatusBadge status="CONCESSION">特采放行</StatusBadge>
                      ) : rec.overallDecision === 'PASSED' ? (
                        <StatusBadge status="PASS">合格通过</StatusBadge>
                      ) : (
                        // 尚未形成综合判定 (待检 / 录入中 / 草稿 / MRB / 复检)：按后端真实状态展示。
                        // 早期实现把除 FAILED/CONCESSION 之外的一律显示为「合格通过」，
                        // 会让刚创建、未录入任何实测值的工单在台账上被误读为已检验放行。
                        <StatusBadge status={rec.status}>
                          {INSPECTION_STATUS_LABELS[rec.status]}
                        </StatusBadge>
                      )}
                      {firstFailedItem?.defectReason && (
                        <div className="text-[10px] text-rose-300 truncate max-w-[160px] mt-0.5">
                          {firstFailedItem.defectReason}
                        </div>
                      )}
                    </td>

                    {/* 9. Finished Product Mandatory Seal */}
                    <td className="px-3.5 py-3 whitespace-nowrap">
                      {rec.isMandatoryGate && rec.overallDecision === 'PASSED' ? (
                        <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-950/80 border border-emerald-500 text-emerald-300 text-[11px] font-mono font-bold shadow">
                          <FileCheck2 className="w-3.5 h-3.5 text-emerald-400" />
                          QC-SEAL-PASS
                        </div>
                      ) : rec.isMandatoryGate ? (
                        <span className="text-[10px] text-rose-400 font-mono">缺失强检印章!</span>
                      ) : (
                        <span className="text-slate-400">-</span>
                      )}
                    </td>

                    {/* 10. Inspector */}
                    <td className="px-3.5 py-3 text-slate-300 whitespace-nowrap text-[11px]">
                      {(rec.inspectorId && staffNameMap[rec.inspectorId]) || '-'}
                    </td>

                    {/* 11. Actions */}
                    <td className="px-3.5 py-3 whitespace-nowrap">
                      <button
                        onClick={() => setSelectedRecord(rec)}
                        className="text-sky-400 hover:text-sky-300 flex items-center gap-1 font-medium text-[11px] hover:underline"
                      >
                        详情 / 测定值
                        <ChevronRight className="w-3 h-3" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* POPUP 1: Record Details Modal */}
      {selectedRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-2xl overflow-hidden shadow-2xl">
            <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-sky-400" />
                <h3 className="font-semibold text-white text-sm">
                  质检明细测定报告 - {selectedRecord.orderNo}
                </h3>
              </div>
              <button
                onClick={() => setSelectedRecord(null)}
                className="text-slate-400 hover:text-white p-1 rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-950/60 p-3 rounded-lg border border-slate-800 text-xs">
                <div>
                  <span className="text-slate-400">批次号:</span>
                  <div className="font-mono text-sky-300 font-bold mt-0.5">
                    {selectedRecord.batchNo}
                  </div>
                </div>
                <div>
                  <span className="text-slate-400">检验类型:</span>
                  <div className="font-mono text-slate-200 mt-0.5">
                    {inspectionTypeLabel(selectedRecord.inspectionType)}
                  </div>
                </div>
                <div>
                  <span className="text-slate-400">工单号:</span>
                  <div className="font-mono text-slate-200 mt-0.5">
                    {selectedRecord.orderNo}
                  </div>
                </div>
                <div>
                  <span className="text-slate-400">总判定:</span>
                  <div className="mt-0.5">
                    <StatusBadge status={selectedRecord.overallDecision ?? 'PENDING'} />
                  </div>
                </div>
              </div>

              {/* Measurements Table */}
              <div>
                <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                  实测项目尺寸与公差列表
                </h4>
                <table className="w-full text-xs text-left border border-slate-800 rounded-lg overflow-hidden">
                  <thead className="bg-slate-950 text-slate-400 font-mono">
                    <tr>
                      <th className="p-2.5">检查特征项</th>
                      <th className="p-2.5">工程标准公差</th>
                      <th className="p-2.5">实测值</th>
                      <th className="p-2.5">单项判定</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800 bg-slate-900/50">
                    {selectedRecord.items.map((m) => (
                      <tr key={m.id ?? m.itemCode}>
                        <td className="p-2.5 text-slate-200 font-medium">{m.name}</td>
                        <td className="p-2.5 font-mono text-slate-400">
                          {m.standardText ||
                            `${m.nominalValue}${m.upperTolerance !== undefined ? `+${m.upperTolerance}` : ''}${m.lowerTolerance !== undefined ? `/${m.lowerTolerance}` : ''} ${m.unit ?? ''}`}
                        </td>
                        <td className="p-2.5 font-mono font-bold text-white">
                          {m.measuredVal ?? '-'} {m.unit}
                        </td>
                        <td className="p-2.5">
                          <StatusBadge status={m.result} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Defect note if any */}
              {selectedRecord.items.find((i) => i.result === 'FAILED')?.defectReason && (
                <div className="p-3 bg-rose-950/40 border border-rose-500/40 rounded-lg text-xs text-rose-300">
                  <span className="font-bold flex items-center gap-1 text-rose-400 mb-1">
                    <AlertTriangle className="w-3.5 h-3.5" /> 缺陷原因与超差说明:
                  </span>
                  {selectedRecord.items.find((i) => i.result === 'FAILED')?.defectReason}
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t border-slate-800 bg-slate-950 flex justify-end gap-2">
              <button
                onClick={() => setSelectedRecord(null)}
                className="px-4 py-1.5 rounded-lg bg-slate-800 text-slate-300 text-xs hover:bg-slate-700"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* POPUP 2: New Inspection Entry Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-lg overflow-hidden shadow-2xl">
            <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950">
              <div className="flex items-center gap-2">
                <PlusCircle className="w-5 h-5 text-sky-400" />
                <h3 className="font-semibold text-white text-sm">录入全新质检数据 (下料/制程)</h3>
              </div>
              <button
                onClick={() => setShowModal(false)}
                className="text-slate-400 hover:text-white p-1 rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateInspection} className="p-5 space-y-3.5 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">检验类型</label>
                  <select
                    value={newType}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                      setNewType(e.target.value as InspectionGroup)
                    }
                    className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-sky-500"
                  >
                    <option value="IPQC">IPQC 过程制程检验</option>
                    <option value="IQC">IQC 来料进货检验</option>
                    <option value="FQC">FQC 成品入库终检</option>
                    <option value="OQC">OQC 出货前抽检</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">批次号 (留空自动生成)</label>
                  <input
                    type="text"
                    placeholder="例: B20231015-88"
                    value={newBatchNo}
                    onChange={(e) => setNewBatchNo(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-sky-500 font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-400 mb-1">物料代码 / 物料名称</label>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    value={newMaterialCode}
                    onChange={(e) => setNewMaterialCode(e.target.value)}
                    className="bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200 font-mono focus:outline-none focus:border-sky-500"
                  />
                  <input
                    type="text"
                    value={newMaterialName}
                    onChange={(e) => setNewMaterialName(e.target.value)}
                    className="bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-sky-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">工单号</label>
                  <input
                    type="text"
                    value={newOrderNo}
                    onChange={(e) => setNewOrderNo(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200 font-mono focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">批量 (件)</label>
                  <input
                    type="number"
                    value={newOrderQty}
                    onChange={(e) => setNewOrderQty(Number(e.target.value))}
                    className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200 font-mono focus:outline-none focus:border-sky-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-400 mb-1">
                  绑定质检方案版本 (必选，快照基准)
                </label>
                <select
                  value={planVersionId}
                  onChange={(e) => setPlanVersionId(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-sky-500"
                >
                  {planVersions.length === 0 && <option value="">暂无可用方案版本</option>}
                  {planVersions.map((v) => (
                    <option key={v.versionId} value={v.versionId}>
                      {v.planCode} / {v.versionNo} ({inspectionTypeLabel(v.inspectionType)}) /{' '}
                      {v.status}
                    </option>
                  ))}
                </select>
              </div>

              {/* Blanking length input */}
              <div className="bg-slate-950/80 p-3 rounded-lg border border-slate-800 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-slate-300 font-medium flex items-center gap-1.5">
                    <Scissors className="w-3.5 h-3.5 text-sky-400" />
                    下料工序关键尺寸 (标称 25.0±0.1mm)
                  </span>
                </div>
                <input
                  type="number"
                  step="0.01"
                  value={newBlankingLength}
                  onChange={(e) => setNewBlankingLength(Number(e.target.value))}
                  className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-slate-100 font-mono font-bold focus:outline-none focus:border-sky-500"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">综合判定结果</label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setNewOverallResult('PASS')}
                    className={`py-1.5 rounded text-xs font-semibold font-mono border ${
                      newOverallResult === 'PASS'
                        ? 'bg-emerald-600 border-emerald-500 text-white'
                        : 'bg-slate-950 border-slate-800 text-slate-400'
                    }`}
                  >
                    PASS 合格
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewOverallResult('FAIL')}
                    className={`py-1.5 rounded text-xs font-semibold font-mono border ${
                      newOverallResult === 'FAIL'
                        ? 'bg-rose-600 border-rose-500 text-white'
                        : 'bg-slate-950 border-slate-800 text-slate-400'
                    }`}
                  >
                    FAIL 不合格 (红标)
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewOverallResult('CONCESSION')}
                    className={`py-1.5 rounded text-xs font-semibold font-mono border ${
                      newOverallResult === 'CONCESSION'
                        ? 'bg-amber-600 border-amber-500 text-white'
                        : 'bg-slate-950 border-slate-800 text-slate-400'
                    }`}
                  >
                    CONCESSION 特采
                  </button>
                </div>
              </div>

              {newOverallResult === 'FAIL' && (
                <div>
                  <label className="block text-rose-400 mb-1 font-semibold">
                    不合格原因描述 (将同步触发 MES 锁机)
                  </label>
                  <textarea
                    rows={2}
                    value={newDefect}
                    onChange={(e) => setNewDefect(e.target.value)}
                    placeholder="例如: 下料长度超标 +0.42mm，端面毛刺超标 30%..."
                    className="w-full bg-slate-950 border border-rose-500/50 rounded px-2.5 py-1.5 text-rose-200 placeholder:text-rose-900 focus:outline-none focus:border-rose-500"
                  />
                </div>
              )}

              {createError !== null && (
                <div className="p-2.5 rounded bg-rose-950/50 border border-rose-500/40 text-rose-300 text-[11px]">
                  保存失败：{createError}
                </div>
              )}

              <div className="pt-2 flex justify-end gap-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-1.5 rounded bg-slate-800 text-slate-300 text-xs hover:bg-slate-700"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded bg-sky-600 text-white text-xs font-semibold hover:bg-sky-500 shadow-md shadow-sky-600/30"
                >
                  保存并提报
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
