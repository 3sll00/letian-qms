import React, { useState, useEffect } from 'react';
import {
  ShieldAlert,
  Clock,
  FileSignature,
  FileSpreadsheet,
  AlertOctagon,
  Users,
  Building,
  Wrench,
  Send,
} from 'lucide-react';
import { StatusBadge } from '../../components/StatusBadge';
import type { MrbReviewRecord } from '@letian/contracts';
import { api, errorMessage } from '../../lib/api';

// 页面四方会签席位 → MRB 审批角色编码
const ROLE_CODE_MAP = {
  QUALITY: 'QA_MGR',
  ENGINEERING: 'TECH_DIR',
  PRODUCTION: 'PROD_SUP',
  MANAGEMENT: 'MGMT_DIR',
} as const;

// 页面页签 → MRB 评审状态枚举
const TAB_STATUS_MAP: Record<string, string> = {
  PENDING: 'PENDING_REVIEW',
  APPROVED: 'DISPOSED',
  REJECTED: 'REJECTED',
};

// 四方会签席位定义。
// role 必须约束为 ROLE_CODE_MAP 的真实键 (而不是宽泛的 string)，
// 否则 ROLE_CODE_MAP[node.role] 会因缺少索引签名而报 TS7053。
interface MrbSignOffNode {
  role: keyof typeof ROLE_CODE_MAP;
  label: string;
  desc: string;
  icon: React.ComponentType<{ className?: string }>;
}

const MRB_SIGNOFF_NODES: MrbSignOffNode[] = [
  {
    role: 'QUALITY',
    label: '质量部负责人 (QC Leader)',
    desc: '尺寸规格与放行风控评估',
    icon: ShieldAlert,
  },
  {
    role: 'ENGINEERING',
    label: '工程技术部 (PE/ME)',
    desc: '机械强度与装配公差校核',
    icon: Wrench,
  },
  {
    role: 'PRODUCTION',
    label: '生产车间主管 (Workshop)',
    desc: '机台停机隔离与返修可行性',
    icon: Building,
  },
  {
    role: 'MANAGEMENT',
    label: '质量总监 (Director/MRB)',
    desc: '特采最终批准与放行指令',
    icon: Users,
  },
];

export function MrbPage() {
  const [records, setRecords] = useState<MrbReviewRecord[]>([]);
  const [activeTab, setActiveTab] = useState<'ALL' | 'PENDING' | 'APPROVED' | 'REJECTED'>('ALL');
  const [selectedRecord, setSelectedRecord] = useState<MrbReviewRecord | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [signError, setSignError] = useState<string | null>(null);

  // Signoff form modal
  const [signingRole, setSigningRole] = useState<'QUALITY' | 'ENGINEERING' | 'PRODUCTION' | 'MANAGEMENT'>('QUALITY');
  const [approverName, setApproverName] = useState('张强 (质量主管)');
  const [action, setAction] = useState<'APPROVED' | 'REJECTED'>('APPROVED');
  const [comment, setComment] = useState('');

  const fetchRecords = () => {
    const query: Record<string, string | undefined> = {};
    if (activeTab !== 'ALL') query.status = TAB_STATUS_MAP[activeTab];

    api
      .get<{ items: MrbReviewRecord[] }>('/mrb/records', query)
      .then((data) => {
        const items = data.items ?? [];
        setRecords(items);
        setLoadError(null);
        if (items.length > 0) {
          // 已选中的记录也要刷新（会签后状态/签核人变化）
          setSelectedRecord((current) =>
            current ? items.find((item) => item.id === current.id) ?? items[0] ?? null : items[0] ?? null
          );
        } else {
          setSelectedRecord(null);
        }
      })
      .catch((err) => {
        setLoadError(errorMessage(err));
        console.error('Fetch MRB error:', err);
      });
  };

  useEffect(() => {
    fetchRecords();
  }, [activeTab]);

  const handleSignSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRecord) return;

    try {
      const updated = await api.post<MrbReviewRecord>(
        `/mrb/records/${selectedRecord.id}/signatures`,
        {
          roleCode: ROLE_CODE_MAP[signingRole],
          approverName,
          action,
          comment,
        }
      );
      setSelectedRecord(updated);
      setSignError(null);
      fetchRecords();
      setComment('');
    } catch (err) {
      setSignError(errorMessage(err));
      console.error('Signing error:', err);
    }
  };

  // 5 Top metrics cards
  const totalMrb = records.length;
  const pendingCount = records.filter(
    (r) => r.status === 'PENDING_REVIEW' || r.status === 'UNDER_REVIEW'
  ).length;
  const concessionCount = records.filter((r) => r.disposition === 'CONCESSION').length;
  const scrapCount = records.filter((r) => r.disposition === 'SCRAP').length;
  const reworkCount = records.filter((r) => r.disposition === 'REWORK').length;

  return (
    <div className="space-y-6">
      {/* 5 Big MRB Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 shadow flex items-center justify-between">
          <div>
            <div className="text-xs text-slate-400">MRB 评审总单数</div>
            <div className="text-2xl font-bold font-mono text-white mt-1">{totalMrb} 份</div>
            <div className="text-[10px] text-slate-400 mt-0.5">累计评审流</div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-400">
            <FileSpreadsheet className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 shadow flex items-center justify-between">
          <div>
            <div className="text-xs text-slate-400">待四方会签核</div>
            <div className="text-2xl font-bold font-mono text-amber-400 mt-1">{pendingCount} 份</div>
            <div className="text-[10px] text-amber-400 mt-0.5 animate-pulse">待质检/工程批准</div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
            <Clock className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 shadow flex items-center justify-between">
          <div>
            <div className="text-xs text-slate-400">让步特采放行</div>
            <div className="text-2xl font-bold font-mono text-purple-400 mt-1">{concessionCount} 批</div>
            <div className="text-[10px] text-slate-400 mt-0.5">非关键尺寸放行</div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400">
            <FileSignature className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 shadow flex items-center justify-between">
          <div>
            <div className="text-xs text-slate-400">返工 / 返修</div>
            <div className="text-2xl font-bold font-mono text-blue-400 mt-1">{reworkCount} 批</div>
            <div className="text-[10px] text-slate-400 mt-0.5">回火 / 滚牙处理</div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
            <Wrench className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 shadow flex items-center justify-between">
          <div>
            <div className="text-xs text-slate-400">报废处置</div>
            <div className="text-2xl font-bold font-mono text-rose-400 mt-1">{scrapCount} 批</div>
            <div className="text-[10px] text-slate-400 mt-0.5">破坏不可逆残次</div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400">
            <AlertOctagon className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* 4 Tabs Filter */}
      <div className="flex items-center gap-2 bg-slate-900 p-1 rounded-lg border border-slate-800 w-fit">
        {(['ALL', 'PENDING', 'APPROVED', 'REJECTED'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-1.5 rounded-md text-xs font-medium transition ${
              activeTab === tab
                ? 'bg-sky-600 text-white shadow'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            {tab === 'ALL'
              ? '全部评审'
              : tab === 'PENDING'
              ? '待会签评审'
              : tab === 'APPROVED'
              ? '已批准生效'
              : '已驳回否决'}
          </button>
        ))}
      </div>

      {/* Main Content Area: Left List + Right Signoff Workbench */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: MRB Records (5 cols) */}
        <div className="lg:col-span-5 space-y-3">
          {records.map((r) => {
            const active = selectedRecord?.id === r.id;
            return (
              <div
                key={r.id}
                onClick={() => setSelectedRecord(r)}
                className={`p-4 rounded-xl border transition cursor-pointer ${
                  active
                    ? 'bg-slate-800/90 border-sky-500/60 shadow-lg shadow-sky-950/40'
                    : 'bg-slate-900/80 border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono font-bold text-xs text-sky-400">{r.id}</span>
                  <StatusBadge status={r.status} />
                </div>
                <div className="text-sm font-semibold text-white mt-1.5 flex items-center gap-2">
                  <span>批次: {r.batchNo}</span>
                  <span className="text-xs font-mono font-normal text-slate-400">
                    ({r.defectQty} 件)
                  </span>
                </div>
                <div className="text-xs text-rose-300 mt-1 line-clamp-1">
                  异常: {r.defectDescription}
                </div>
                <div className="flex items-center justify-between mt-3 pt-2 border-t border-slate-800 text-[11px] text-slate-400 font-mono">
                  <span>处置建议: {r.disposition}</span>
                  <span>来源: {r.sourceType}</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Right Column: Interactive MRB Flow & Signoff (7 cols) */}
        <div className="lg:col-span-7 bg-slate-900/90 border border-slate-800 rounded-xl p-6 shadow-xl space-y-6">
          {selectedRecord ? (
            <>
              {/* Header Info */}
              <div className="border-b border-slate-800 pb-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="w-5 h-5 text-rose-400" />
                    <h3 className="font-semibold text-white text-base">
                      MRB 不合格品评审表单 ({selectedRecord.id})
                    </h3>
                  </div>
                  <StatusBadge status={selectedRecord.status} />
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3 text-xs bg-slate-950/60 p-3 rounded-lg border border-slate-800">
                  <div>
                    <span className="text-slate-400">关联批次:</span>
                    <div className="font-mono text-sky-300 font-bold mt-0.5">
                      {selectedRecord.batchNo}
                    </div>
                  </div>
                  <div>
                    <span className="text-slate-400">影响批量:</span>
                    <div className="font-mono text-white mt-0.5">
                      {selectedRecord.defectQty} 件
                    </div>
                  </div>
                  <div>
                    <span className="text-slate-400">处置决策:</span>
                    <div className="font-mono text-amber-300 font-semibold mt-0.5">
                      {selectedRecord.disposition}
                    </div>
                  </div>
                  <div>
                    <span className="text-slate-400">发起时间:</span>
                    <div className="font-mono text-slate-300 mt-0.5 text-[11px]">
                      {new Date(selectedRecord.createdAt).toLocaleDateString('zh-CN')}
                    </div>
                  </div>
                </div>
              </div>

              {/* Defect Details Card */}
              <div className="p-3.5 bg-rose-950/20 border border-rose-500/30 rounded-lg text-xs space-y-1">
                <div className="font-semibold text-rose-400 flex items-center gap-1.5">
                  <AlertOctagon className="w-4 h-4" />
                  不合格缺陷描述与工程影响评估:
                </div>
                <div className="text-slate-200">{selectedRecord.defectDescription}</div>
              </div>

              {/* Four-Party Flow Chart (Visual Flow) */}
              <div>
                <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-3">
                  四方联合签核流程进展 (可配置节点)
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {MRB_SIGNOFF_NODES.map((node) => {
                    const sig = selectedRecord.approvers.find(
                      (a) => a.roleCode === ROLE_CODE_MAP[node.role]
                    );
                    const isApproved = sig?.action === 'APPROVED';
                    const isRejected = sig?.action === 'REJECTED';
                    const Icon = node.icon;

                    return (
                      <div
                        key={node.role}
                        className={`p-3 rounded-lg border text-xs space-y-1.5 ${
                          isApproved
                            ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-200'
                            : isRejected
                            ? 'bg-rose-950/30 border-rose-500/40 text-rose-200'
                            : 'bg-slate-950/50 border-slate-800 text-slate-400'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-semibold flex items-center gap-1.5 text-white">
                            <Icon className="w-3.5 h-3.5 text-sky-400" />
                            {node.label}
                          </span>
                          {isApproved ? (
                            <span className="text-[10px] font-mono bg-emerald-900/80 text-emerald-300 px-1.5 py-0.5 rounded border border-emerald-500/40">
                              已签署通过
                            </span>
                          ) : isRejected ? (
                            <span className="text-[10px] font-mono bg-rose-900/80 text-rose-300 px-1.5 py-0.5 rounded border border-rose-500/40">
                              已驳回
                            </span>
                          ) : (
                            <span className="text-[10px] font-mono bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded">
                              待签核
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-400">{node.desc}</div>
                        {sig && (
                          <div className="pt-1.5 border-t border-slate-800/60 font-mono text-[10px] text-slate-300 space-y-0.5">
                            <div>签核人: {sig.userName}</div>
                            {sig.comment && (
                              <div className="text-slate-400 italic">“{sig.comment}”</div>
                            )}
                            <div className="text-[9px] text-slate-400">
                              {new Date(sig.signedAt).toLocaleString('zh-CN')}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Interactive Signoff Action Panel */}
              <div className="p-4 bg-slate-950/80 rounded-xl border border-slate-800 space-y-3">
                <h4 className="text-xs font-semibold text-sky-400 flex items-center gap-1.5">
                  <FileSignature className="w-4 h-4" />
                  执行电子签名签核 (模拟当前在线席位)
                </h4>

                <form onSubmit={handleSignSubmit} className="space-y-3 text-xs">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <div>
                      <label className="block text-slate-400 mb-1">会签席位</label>
                      <select
                        value={signingRole}
                        onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                          setSigningRole(
                            e.target.value as 'QUALITY' | 'ENGINEERING' | 'PRODUCTION' | 'MANAGEMENT'
                          )
                        }
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-200 focus:outline-none focus:border-sky-500"
                      >
                        <option value="QUALITY">质量部 (QUALITY)</option>
                        <option value="ENGINEERING">工程技术部 (ENGINEERING)</option>
                        <option value="PRODUCTION">生产制造部 (PRODUCTION)</option>
                        <option value="MANAGEMENT">质量总监 (MANAGEMENT)</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-slate-400 mb-1">签署人姓名</label>
                      <input
                        type="text"
                        value={approverName}
                        onChange={(e) => setApproverName(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-200 focus:outline-none focus:border-sky-500"
                      />
                    </div>

                    <div>
                      <label className="block text-slate-400 mb-1">决策意见</label>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setAction('APPROVED')}
                          className={`flex-1 py-1.5 rounded text-xs font-semibold border ${
                            action === 'APPROVED'
                              ? 'bg-emerald-600 border-emerald-500 text-white'
                              : 'bg-slate-900 border-slate-800 text-slate-400'
                          }`}
                        >
                          同意放行
                        </button>
                        <button
                          type="button"
                          onClick={() => setAction('REJECTED')}
                          className={`flex-1 py-1.5 rounded text-xs font-semibold border ${
                            action === 'REJECTED'
                              ? 'bg-rose-600 border-rose-500 text-white'
                              : 'bg-slate-900 border-slate-800 text-slate-400'
                          }`}
                        >
                          驳回否决
                        </button>
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="block text-slate-400 mb-1">评审特采意见备注</label>
                    <input
                      type="text"
                      placeholder="例如: 经扭矩破坏与金相组织复核，不影响装配使用，同意本批让步特采放行..."
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                      className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-slate-200 focus:outline-none focus:border-sky-500"
                    />
                  </div>

                  <div className="flex justify-end">
                    <button
                      type="submit"
                      className="flex items-center gap-1.5 px-4 py-1.5 bg-sky-600 hover:bg-sky-500 text-white font-semibold rounded text-xs shadow-md shadow-sky-600/30"
                    >
                      <Send className="w-3.5 h-3.5" />
                      提交电子签核
                    </button>
                  </div>
                </form>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-64 text-slate-400">
              请在左侧选择一份 MRB 评审记录
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
