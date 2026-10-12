import React, { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, FileCheck2, ShieldAlert } from 'lucide-react';
import type {
  InspectionType,
  PaginatedTransferOverrideTickets,
  TransferOverrideTicket,
} from '@letian/contracts';
import { api, errorMessage, getCurrentUser } from '../../../lib/api';

interface TransferOverridePanelProps {
  /** 本单批次号（提报与列表都用它定位工单；一张工单只能核销给同一批次） */
  batchNo: string;
  materialCode: string;
  inspectionType: InspectionType;
  /** 被豁免的上游单号（留痕指向它，便于事后追溯「凭什么放行」） */
  upstreamOrderNo?: string | undefined;
  workOrderNo?: string | undefined;
  furnaceHeatNo?: string | undefined;
  /** 选中一张已审批工单后回调父组件：父组件据此放开提交按钮并带上 transferOverride */
  onUseTicket: (ticket: TransferOverrideTicket | null) => void;
}

const STATUS_LABEL: Record<string, string> = {
  PENDING: '待审批',
  APPROVED: '已批准',
  REJECTED: '已驳回',
  CONSUMED: '已核销',
};

const STATUS_TONE: Record<string, string> = {
  PENDING: 'bg-amber-50 text-amber-700',
  APPROVED: 'bg-emerald-50 text-emerald-700',
  REJECTED: 'bg-rose-50 text-rose-700',
  CONSUMED: 'bg-slate-100 text-slate-600',
};

function fmtTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { hour12: false });
}

/**
 * 特批豁免通道面板（docs/48 §4.4 / §8 P2，配套 TBD-09）。
 *
 * 完整走完三步：**提报申请 → 质量负责人审批 → 核销建单**。
 *
 * 三点必须让现场看得见，否则这套流程等于不存在：
 * 1. 申请人与审批人一律取**登录用户**（服务端强制），前端不提供「代填」入口 —— 否则等于放弃追责；
 * 2. 只有 **APPROVED** 的工单可用于建单，核销后变 CONSUMED，不可复用（一单一核销）；
 * 3. 审批按钮不做前端角色判断 —— 越权由服务端 403 兜底，前端只是体验层。
 */
export function TransferOverridePanel({
  batchNo,
  materialCode,
  inspectionType,
  upstreamOrderNo,
  workOrderNo,
  furnaceHeatNo,
  onUseTicket,
}: TransferOverridePanelProps) {
  const [open, setOpen] = useState(false);
  const [tickets, setTickets] = useState<TransferOverrideTicket[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // 提报表单
  const [reason, setReason] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  // 审批表单（按工单号分别记意见与特批单号）
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [approvalDocNo, setApprovalDocNo] = useState<Record<string, string>>({});
  const [selectedNo, setSelectedNo] = useState<string | null>(null);

  const batch = batchNo.trim();

  const loadTickets = useCallback(async () => {
    if (batch === '') {
      setTickets([]);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const page = await api.get<PaginatedTransferOverrideTickets>(
        '/inspections/transfer-overrides/tickets',
        { batchNo: batch, page: 1, pageSize: 20 }
      );
      setTickets(Array.isArray(page.items) ? page.items : []);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [batch]);

  useEffect(() => {
    if (!open) return;
    void loadTickets();
  }, [open, loadTickets]);

  async function handleCreate() {
    const me = getCurrentUser();
    if (me === null) {
      setError('未登录，无法提报豁免申请');
      return;
    }
    if (reason.trim().length < 5) {
      setError('豁免原因至少 5 个字符 —— 服务端会同样校验');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const created = await api.post<TransferOverrideTicket>('/inspections/transfer-overrides/tickets', {
        batchNo: batch,
        materialCode,
        inspectionType,
        ...(workOrderNo !== undefined && workOrderNo !== '' ? { workOrderNo } : {}),
        ...(furnaceHeatNo !== undefined && furnaceHeatNo !== '' ? { furnaceHeatNo } : {}),
        ...(upstreamOrderNo !== undefined && upstreamOrderNo !== '' ? { upstreamOrderNo } : {}),
        reason: reason.trim(),
        applicantId: me.userId,
      });
      setNotice(`豁免申请 ${created.ticketNo} 已提报，等待质量负责人审批。`);
      setReason('');
      setShowCreate(false);
      await loadTickets();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleReview(ticket: TransferOverrideTicket, action: 'APPROVE' | 'REJECT') {
    const me = getCurrentUser();
    if (me === null) {
      setError('未登录，无法审批');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const docNo = (approvalDocNo[ticket.ticketNo] ?? '').trim();
      await api.post(`/inspections/transfer-overrides/tickets/${encodeURIComponent(ticket.ticketNo)}/review`, {
        action,
        reviewerId: me.userId,
        reviewNotes: (reviewNotes[ticket.ticketNo] ?? '').trim(),
        ...(action === 'APPROVE' && docNo !== '' ? { approvalDocNo: docNo } : {}),
      });
      setNotice(
        action === 'APPROVE'
          ? `豁免工单 ${ticket.ticketNo} 已批准，可用于核销建单。`
          : `豁免工单 ${ticket.ticketNo} 已驳回。`
      );
      await loadTickets();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const approvedTicket = tickets.find((t) => t.ticketNo === selectedNo && t.status === 'APPROVED');

  // 物料编码是豁免工单的必填项（服务端 zod 校验）。为空时提前拦住并说清楚要补什么，
  // 而不是让用户提报一次再吃一个 400 —— 实测中这正是最容易卡住现场的一步。
  const materialMissing = materialCode.trim() === '';

  return (
    <div className="rounded border border-purple-200 bg-purple-50/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-xs font-medium text-purple-800"
      >
        <span className="flex items-center gap-1.5">
          <ShieldAlert className="w-3.5 h-3.5" />
          特批豁免放行通道（质量负责人审批 · 一单一核销）
        </span>
        {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3">
          <p className="text-[11px] text-purple-900/70 leading-relaxed">
            上游未放行时，建单会被服务端以 422 拒绝。确需放行的，由现场提报豁免申请、
            质量负责人审批后核销建单 —— 全程留审计与 Outbox 事件，事后可解释「凭什么放行」。
          </p>

          {batch === '' && (
            <div className="text-[11px] text-amber-700">请先填写批次号：豁免工单按批次定位，且一张工单只能核销给同一批次。</div>
          )}
          {batch !== '' && materialMissing && (
            <div className="text-[11px] text-amber-700">
              请先选择物料编码：豁免工单按「批次 + 物料 + 环节」三元组绑定，工单不能挪用到别的物料。
            </div>
          )}

          {error !== '' && (
            <div className="rounded border border-rose-200 bg-rose-50 px-2 py-1.5 text-[11px] text-rose-700">{error}</div>
          )}
          {notice !== '' && (
            <div className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-[11px] text-emerald-700">{notice}</div>
          )}

          {/* 提报申请 */}
          {batch !== '' && !materialMissing && !showCreate && (
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="px-2.5 py-1.5 rounded bg-purple-600 text-white text-[11px] font-medium hover:bg-purple-700"
            >
              新建豁免申请
            </button>
          )}

          {batch !== '' && materialMissing && tickets.length === 0 && (
            <div className="text-[11px] text-slate-400">补齐物料编码后即可提报豁免申请。</div>
          )}

          {batch !== '' && !materialMissing && showCreate && (
            <div className="space-y-2 rounded border border-purple-200 bg-white p-2.5">
              <div className="text-[11px] text-slate-600">
                目标：批次 <span className="font-mono">{batch}</span> · 物料{' '}
                <span className="font-mono">{materialCode}</span> · 环节{' '}
                <span className="font-mono">{inspectionType}</span>
              </div>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                placeholder="豁免原因（至少 5 个字符）——例如：客户紧急试制批次，已获客户书面同意"
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-xs focus:outline-none focus:border-purple-500"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void handleCreate()}
                  disabled={busy}
                  className="px-2.5 py-1.5 rounded bg-purple-600 text-white text-[11px] font-medium hover:bg-purple-700 disabled:opacity-60"
                >
                  {busy ? '提交中…' : '提报申请'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="px-2.5 py-1.5 rounded border border-slate-300 text-[11px] text-slate-600 hover:bg-slate-50"
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {/* 工单列表 */}
          {batch !== '' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-slate-600">本批次豁免工单（{tickets.length}）</span>
                <button
                  type="button"
                  onClick={() => void loadTickets()}
                  disabled={loading}
                  className="text-[11px] text-purple-700 hover:underline disabled:opacity-50"
                >
                  {loading ? '刷新中…' : '刷新'}
                </button>
              </div>

              {loading && <div className="text-[11px] text-slate-400">加载中…</div>}
              {!loading && tickets.length === 0 && (
                <div className="text-[11px] text-slate-400">本批次暂无豁免工单。</div>
              )}

              {tickets.map((t) => (
                <div key={t.id} className="rounded border border-slate-200 bg-white p-2.5 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-[11px] text-slate-700">{t.ticketNo}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${STATUS_TONE[t.status] ?? 'bg-slate-100 text-slate-600'}`}>
                      {STATUS_LABEL[t.status] ?? t.status}
                    </span>
                    {t.upstreamGateCode !== undefined && (
                      <span className="text-[10px] text-slate-400">原判定码 {t.upstreamGateCode}</span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-600 leading-relaxed">{t.reason}</div>
                  <div className="text-[10px] text-slate-400">
                    申请人 {t.applicantName ?? t.applicantId} · {fmtTime(t.createdAt)}
                    {t.reviewerName !== null && t.reviewerName !== undefined && (
                      <> ｜ 审批人 {t.reviewerName} · {fmtTime(t.reviewedAt)}</>
                    )}
                    {t.approvalDocNo !== null && t.approvalDocNo !== undefined && t.approvalDocNo !== '' && (
                      <> ｜ 特批单号 {t.approvalDocNo}</>
                    )}
                  </div>

                  {t.status === 'PENDING' && (
                    <div className="space-y-2 border-t border-slate-100 pt-2">
                      <input
                        value={reviewNotes[t.ticketNo] ?? ''}
                        onChange={(e) => setReviewNotes((prev) => ({ ...prev, [t.ticketNo]: e.target.value }))}
                        placeholder="审批意见"
                        className="w-full rounded border border-slate-300 px-2 py-1.5 text-[11px] focus:outline-none focus:border-purple-500"
                      />
                      <input
                        value={approvalDocNo[t.ticketNo] ?? ''}
                        onChange={(e) => setApprovalDocNo((prev) => ({ ...prev, [t.ticketNo]: e.target.value }))}
                        placeholder="书面特批单据编号（同意时建议填写，便于事后举证）"
                        className="w-full rounded border border-slate-300 px-2 py-1.5 text-[11px] focus:outline-none focus:border-purple-500"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => void handleReview(t, 'APPROVE')}
                          disabled={busy}
                          className="px-2.5 py-1.5 rounded bg-emerald-600 text-white text-[11px] font-medium hover:bg-emerald-700 disabled:opacity-60"
                        >
                          同意放行
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleReview(t, 'REJECT')}
                          disabled={busy}
                          className="px-2.5 py-1.5 rounded border border-slate-300 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-60"
                        >
                          驳回
                        </button>
                      </div>
                      <p className="text-[10px] text-slate-400">
                        审批权限由服务端校验：非质量负责人会返回 403，界面不做角色判断。
                      </p>
                    </div>
                  )}

                  {t.status === 'APPROVED' && (
                    <div className="border-t border-slate-100 pt-2">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedNo(selectedNo === t.ticketNo ? null : t.ticketNo);
                          onUseTicket(selectedNo === t.ticketNo ? null : t);
                        }}
                        className={`px-2.5 py-1.5 rounded text-[11px] font-medium flex items-center gap-1.5 ${
                          selectedNo === t.ticketNo
                            ? 'bg-purple-600 text-white'
                            : 'border border-purple-300 text-purple-700 hover:bg-purple-50'
                        }`}
                      >
                        <FileCheck2 className="w-3 h-3" />
                        {selectedNo === t.ticketNo ? '已选用（点击取消）' : '用此工单核销建单'}
                      </button>
                    </div>
                  )}

                  {t.status === 'CONSUMED' && (
                    <div className="text-[10px] text-slate-400 border-t border-slate-100 pt-2">
                      已核销建单：<span className="font-mono">{t.consumedOrderNo ?? '—'}</span>（一单一核销，不可复用）
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {approvedTicket !== undefined && !open && (
        <div className="px-3 pb-2 text-[11px] text-purple-800">已选用豁免工单 {approvedTicket.ticketNo}，提交将带上特批放行。</div>
      )}
    </div>
  );
}

export default TransferOverridePanel;