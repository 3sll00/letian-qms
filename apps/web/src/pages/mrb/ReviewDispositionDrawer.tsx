import React, { useEffect, useState } from 'react';
import {
  AlertOctagon,
  Building,
  CheckCircle2,
  FileSignature,
  Send,
  ShieldAlert,
  Users,
  Wrench,
  X,
} from 'lucide-react';
import type { DisposeMRBResponse, MRBDisposition, MrbReviewRecord } from '@letian/contracts';
import { api, errorMessage, getCurrentUser } from '../../lib/api';
import { StatusBadge } from '../../components/StatusBadge';
import {
  MRB_DISPOSITION_OPTIONS,
  MRB_ROLE_CODE_MAP,
  MRB_SEATS,
  type MrbSeatKey,
  dispositionLabel,
  statusLabel,
  statusTone,
} from './mrbMeta';

/**
 * 评审与处置抽屉（阶段 2，对应 docs/19-MRB不合格品处置页整合设计.md §7.2）
 *
 * 三块内容：
 * 1. 单据概览 + 不合格缺陷描述；
 * 2. 四方签核进展（读 `approvers` 真实签署记录，不做任何本地推断）；
 * 3. 电子签核提交（`POST /mrb/records/{id}/sign`，携带席位 roleCode 与签署人）+
 *    最终处置结论提交（`POST /mrb/records/{id}/disposition`）。
 *
 * 接口口径：`/reviews` 是契约对齐路径但其请求体不含 `roleCode` / `approverName`，
 * 会签席位会被服务端忽略（属静默降级），因此本页使用 `/sign`（旧标准路径，含席位字段）。
 */

const SEAT_ICONS: Record<MrbSeatKey, React.ComponentType<{ className?: string }>> = {
  QUALITY: ShieldAlert,
  ENGINEERING: Wrench,
  PRODUCTION: Building,
  MANAGEMENT: Users,
};

export interface ReviewDispositionDrawerProps {
  record: MrbReviewRecord | null;
  onClose: () => void;
  /** 会签 / 处置成功后回调（主列表刷新） */
  onChanged: (updated: MrbReviewRecord) => void;
}

export function ReviewDispositionDrawer({
  record,
  onClose,
  onChanged,
}: ReviewDispositionDrawerProps) {
  const currentUser = getCurrentUser();

  const [seat, setSeat] = useState<MrbSeatKey>('QUALITY');
  const [approverName, setApproverName] = useState(currentUser?.userName ?? '');
  const [signComment, setSignComment] = useState('');
  const [signError, setSignError] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);

  const [disposition, setDisposition] = useState<MRBDisposition>('RETURN_TO_VENDOR');
  const [dispositionReason, setDispositionReason] = useState('');
  const [concessionAttachmentUrl, setConcessionAttachmentUrl] = useState('');
  const [dispositionError, setDispositionError] = useState<string | null>(null);
  const [disposing, setDisposing] = useState(false);
  /** 返工处置连带生成的复检单号（取自处置响应 DisposeMRBResponse，仅本次处置回吐） */
  const [reinspectionOrderNo, setReinspectionOrderNo] = useState<string | null>(null);

  // 切换单据时重置表单，避免把上一单的签署意见/处置理由带到下一单
  useEffect(() => {
    setSignComment('');
    setSignError(null);
    setDispositionReason('');
    setDispositionError(null);
    setConcessionAttachmentUrl('');
    setDisposition(record?.disposition ?? 'RETURN_TO_VENDOR');
  }, [record?.id, record?.disposition]);

  // 复检单号只在「切换单据」时清空：处置成功后父组件会回填最新单据状态（status -> DISPOSED），
  // 若跟着 record.disposition 一起重置，刚拿到的复检单号会被立刻擦掉。
  useEffect(() => {
    setReinspectionOrderNo(null);
  }, [record?.id]);

  if (record === null) return null;

  const signedSeatRoles = record.approvers.map((approver) => approver.roleCode);
  const canSign = record.status === 'PENDING_REVIEW' || record.status === 'UNDER_REVIEW';
  const canDispose = record.status === 'PENDING_REVIEW' || record.status === 'UNDER_REVIEW';

  const handleSign = async (action: 'APPROVED' | 'REJECTED') => {
    try {
      setSigning(true);
      setSignError(null);
      const updated = await api.post<MrbReviewRecord>(`/mrb/records/${record.id}/sign`, {
        roleCode: MRB_ROLE_CODE_MAP[seat],
        approverName: approverName.trim(),
        action,
        comment: signComment.trim(),
      });
      setSignComment('');
      onChanged(updated);
    } catch (err) {
      setSignError(errorMessage(err));
    } finally {
      setSigning(false);
    }
  };

  const handleDispose = async () => {
    if (dispositionReason.trim() === '') {
      setDispositionError('请填写处置决议理由与防范措施。');
      return;
    }
    if (disposition === 'CONCESSION' && concessionAttachmentUrl.trim() === '') {
      setDispositionError('特采（让步接收）必须填写客户书面签核凭证路径。');
      return;
    }
    try {
      setDisposing(true);
      setDispositionError(null);
      const updated = await api.post<DisposeMRBResponse>(`/mrb/records/${record.id}/disposition`, {
        disposition,
        dispositionReason: dispositionReason.trim(),
        ...(disposition === 'CONCESSION'
          ? { concessionAttachmentUrl: concessionAttachmentUrl.trim() }
          : {}),
      });
      setDispositionReason('');
      // 返工（REWORK）处置会在同一事务内生成下一轮复检单，接口把复检单标识一并回吐，
      // 这里直接展示，不再按批次号反查（反查会在复检单尚未落库时给出空值）
      setReinspectionOrderNo(updated.reinspectionOrderNo ?? null);
      onChanged(updated);
    } catch (err) {
      setDispositionError(errorMessage(err));
    } finally {
      setDisposing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose} role="presentation" />

      <div className="relative h-full w-full max-w-[760px] bg-[#F5F7FA] shadow-2xl flex flex-col">
        {/* 抽屉头部 */}
        <div className="bg-white border-b border-slate-200 px-6 py-4 flex items-start justify-between shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <span className="p-2 bg-amber-50 text-amber-600 border border-amber-200 rounded-xl shrink-0">
              <FileSignature className="w-5 h-5" />
            </span>
            <div className="min-w-0">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                MRB 评审与处置
                <span className="font-mono text-sm text-blue-600">{record.mrbNo}</span>
              </h3>
              <p className="text-xs text-slate-500 mt-0.5 truncate">
                来源检验单 {record.sourceOrderNo} · 批次 {record.batchNo} · {record.materialName}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <StatusBadge status={statusLabel(record.status)} tone={statusTone(record.status)} />
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* 单据概览 */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <div>
              <div className="text-slate-500">关联批次</div>
              <div className="font-mono font-bold text-slate-900 mt-1">{record.batchNo}</div>
            </div>
            <div>
              <div className="text-slate-500">不合格数量</div>
              <div className="font-mono font-bold text-rose-600 mt-1">{record.defectQty} 件</div>
            </div>
            <div>
              <div className="text-slate-500">处置决策</div>
              <div className="font-semibold text-slate-900 mt-1">
                {dispositionLabel(record.disposition)}
              </div>
            </div>
            <div>
              <div className="text-slate-500">发现 / 发起时间</div>
              <div className="font-mono text-slate-700 mt-1">
                {new Date(record.createdAt).toLocaleDateString('zh-CN')}
              </div>
            </div>
          </div>

          {/* 不合格缺陷描述 */}
          <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 text-xs space-y-1.5">
            <div className="font-semibold text-rose-700 flex items-center gap-1.5">
              <AlertOctagon className="w-4 h-4" />
              不合格缺陷描述与工程影响评估
            </div>
            <div className="text-slate-800">{record.defectDescription}</div>
            {record.dispositionNotes !== undefined && (
              <div className="text-slate-500 pt-1 border-t border-rose-100">
                处置说明: {record.dispositionNotes}
              </div>
            )}
          </div>

          {/* 四方签核进展 */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <h4 className="text-xs font-bold text-slate-700 mb-3">四方联合签核进展（可配置节点）</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {MRB_SEATS.map((seatItem) => {
                const roleCode = MRB_ROLE_CODE_MAP[seatItem.key];
                const signature = record.approvers.find((approver) => approver.roleCode === roleCode);
                const Icon = SEAT_ICONS[seatItem.key];
                const approved = signature?.action === 'APPROVED';
                const rejected = signature?.action === 'REJECTED';
                return (
                  <div
                    key={seatItem.key}
                    className={`p-3 rounded-xl border text-xs space-y-1.5 ${
                      approved
                        ? 'bg-emerald-50 border-emerald-200'
                        : rejected
                          ? 'bg-rose-50 border-rose-200'
                          : 'bg-slate-50 border-slate-200'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-800 flex items-center gap-1.5">
                        <Icon className="w-3.5 h-3.5 text-blue-600" />
                        {seatItem.label}
                      </span>
                      {approved ? (
                        <span className="text-[10px] font-mono bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded border border-emerald-200">
                          已签署通过
                        </span>
                      ) : rejected ? (
                        <span className="text-[10px] font-mono bg-rose-100 text-rose-700 px-1.5 py-0.5 rounded border border-rose-200">
                          已驳回
                        </span>
                      ) : (
                        <span className="text-[10px] font-mono bg-white text-slate-500 px-1.5 py-0.5 rounded border border-slate-200">
                          待签核
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500">{seatItem.desc}</div>
                    {signature && (
                      <div className="pt-1.5 border-t border-slate-200/70 text-[10px] text-slate-600 space-y-0.5">
                        <div>签核人: {signature.userName}</div>
                        {signature.comment !== '' && (
                          <div className="text-slate-500 italic">“{signature.comment}”</div>
                        )}
                        <div className="text-slate-400">
                          {new Date(signature.signedAt).toLocaleString('zh-CN')}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {signedSeatRoles.length === 0 && (
              <p className="text-[11px] text-slate-400 mt-3">该评审单尚无任何会签记录。</p>
            )}
          </div>

          {/* 电子签核 */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm space-y-3">
            <h4 className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
              <FileSignature className="w-4 h-4 text-blue-600" />
              节点会签（电子签核）
            </h4>
            {!canSign && (
              <div className="text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
                当前状态为「{statusLabel(record.status)}」，已收口，不能再提交会签意见。
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
              <label className="block">
                <span className="block text-slate-600 mb-1.5">会签席位</span>
                <select
                  value={seat}
                  onChange={(e) => setSeat(e.target.value as MrbSeatKey)}
                  disabled={!canSign}
                  className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-slate-700 focus:outline-none focus:border-blue-500 disabled:bg-slate-50"
                >
                  {MRB_SEATS.map((seatItem) => (
                    <option key={seatItem.key} value={seatItem.key}>
                      {seatItem.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block sm:col-span-2">
                <span className="block text-slate-600 mb-1.5">签署人姓名</span>
                <input
                  type="text"
                  value={approverName}
                  onChange={(e) => setApproverName(e.target.value)}
                  disabled={!canSign}
                  className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-slate-700 focus:outline-none focus:border-blue-500 disabled:bg-slate-50"
                />
              </label>
            </div>
            <label className="block text-xs">
              <span className="block text-slate-600 mb-1.5">签署意见</span>
              <input
                type="text"
                value={signComment}
                onChange={(e) => setSignComment(e.target.value)}
                disabled={!canSign}
                placeholder="例如: 经扭矩破坏与金相组织复核，不影响装配使用，同意本批让步特采放行"
                className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-slate-700 placeholder-slate-400 focus:outline-none focus:border-blue-500 disabled:bg-slate-50"
              />
            </label>
            {signError !== null && (
              <div className="bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl px-3 py-2">
                会签提交失败：{signError}
              </div>
            )}
            <div className="flex justify-end gap-2.5">
              <button
                type="button"
                onClick={() => void handleSign('REJECTED')}
                disabled={!canSign || signing}
                className="px-4 py-2 text-xs font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded-xl hover:bg-rose-100 transition-colors disabled:opacity-50"
              >
                驳回否决
              </button>
              <button
                type="button"
                onClick={() => void handleSign('APPROVED')}
                disabled={!canSign || signing}
                className="px-4 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl shadow-sm flex items-center gap-1.5 transition-colors disabled:opacity-50"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>{signing ? '提交中…' : '同意放行'}</span>
              </button>
            </div>
          </div>

          {/* 处置结论提交 */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm space-y-3">
            <h4 className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
              <Send className="w-4 h-4 text-blue-600" />
              最终处置结论（退货 / 返工 / 特采 / 报废）
            </h4>
            {!canDispose && (
              <div className="text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
                该单据已收口（{statusLabel(record.status)}），处置结论不可重复提交。
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
              <label className="block">
                <span className="block text-slate-600 mb-1.5">处置方式</span>
                <select
                  value={disposition}
                  onChange={(e) => setDisposition(e.target.value as MRBDisposition)}
                  disabled={!canDispose}
                  className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-slate-700 focus:outline-none focus:border-blue-500 disabled:bg-slate-50"
                >
                  {MRB_DISPOSITION_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block sm:col-span-2">
                <span className="block text-slate-600 mb-1.5">
                  客户签核凭证路径{disposition === 'CONCESSION' ? '（特采必填）' : '（选填）'}
                </span>
                <input
                  type="text"
                  value={concessionAttachmentUrl}
                  onChange={(e) => setConcessionAttachmentUrl(e.target.value)}
                  disabled={!canDispose || disposition !== 'CONCESSION'}
                  placeholder="/attachments/concession_signed.pdf"
                  className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-slate-700 placeholder-slate-400 focus:outline-none focus:border-blue-500 disabled:bg-slate-50"
                />
              </label>
            </div>
            <label className="block text-xs">
              <span className="block text-slate-600 mb-1.5">处置决议理由与防范措施（必填）</span>
              <textarea
                rows={3}
                value={dispositionReason}
                onChange={(e) => setDispositionReason(e.target.value)}
                disabled={!canDispose}
                placeholder="例如: 经工程评审，硬度尚可满足降级使用；后续加严来料化学成分抽检比例"
                className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-slate-700 placeholder-slate-400 focus:outline-none focus:border-blue-500 disabled:bg-slate-50"
              />
            </label>
            {dispositionError !== null && (
              <div className="bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl px-3 py-2">
                处置提交失败：{dispositionError}
              </div>
            )}
            {reinspectionOrderNo !== null && (
              <div className="bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs rounded-xl px-3 py-2 flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                <span>
                  返工处置已生效，系统已生成下一轮复检单：
                  <span className="font-mono font-bold ml-1">{reinspectionOrderNo}</span>
                </span>
              </div>
            )}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void handleDispose()}
                disabled={!canDispose || disposing}
                className="px-5 py-2 text-xs font-bold text-white bg-[#2563EB] hover:bg-blue-700 rounded-xl shadow-sm flex items-center gap-1.5 transition-colors disabled:opacity-50"
              >
                <Send className="w-3.5 h-3.5" />
                <span>{disposing ? '提交中…' : '提交处置结论'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
