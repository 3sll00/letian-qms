/**
 * 质量负责人签核按钮（docs/35 §5）。
 *
 * 口径：
 *   - 签核人 = **当前登录用户**，由服务端从会话取（请求体不接受「自称的签核人」）；
 *   - 服务端落 `inspection_orders.approver_id / approver_name / approved_at`，并写一条
 *     `QUALITY_APPROVAL` 审计日志（append-only）；
 *   - 重复签核幂等覆盖（第二次签核即换人 / 换时间，历史动作留在审计日志里）；
 *   - 界面只回执服务端真实返回值：绿字「已由 X 签核」，失败按 ApiError 文案红字就地提示，
 *     绝不 alert 假成功（与 docs/34 §6.2 写路径回执同一口径）。
 *
 * 权限：角色门禁在后端（assertQualityApprover：QA_MANAGER / ADMIN / SYSTEM）。
 * 前端不做角色猜测，无权限时按服务端 403 文案提示；`disabled` 只用于「本单尚未落库」等
 * 前置条件不具备的场景。
 */
import React, { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';

export interface ApprovalResult {
  orderId: string;
  approverName?: string;
  approvedAt?: string;
}

interface ApprovalButtonProps {
  /** 工单 ID（列表行 id / 建单返回的 id）；缺失即禁用并说明原因 */
  orderId?: string | null;
  /** 本单已签核人姓名（inspection_orders.approver_name），空 = 未签核 */
  approverName?: string | null;
  /** 本单签核时间（inspection_orders.approved_at，ISO 串） */
  approvedAt?: string | null;
  /** 只读回看等场景禁用点击（权限仍由服务端判定） */
  disabled?: boolean;
  onApproved?: (result: ApprovalResult) => void;
}

/** ISO 时间 -> 本地可读串；解析不出来即丢弃时间，绝不显示 Invalid Date */
function formatStamp(value?: string): string {
  if (value === undefined || value === '') return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString('zh-CN');
}

export const ApprovalButton: React.FC<ApprovalButtonProps> = ({
  orderId,
  approverName,
  approvedAt,
  disabled = false,
  onApproved,
}) => {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState('');
  const [approved, setApproved] = useState<{ name: string; at: string } | null>(
    approverName !== undefined && approverName !== null && approverName !== ''
      ? { name: approverName, at: formatStamp(approvedAt ?? undefined) }
      : null
  );

  const hasOrderId = typeof orderId === 'string' && orderId.trim() !== '';

  const handleApprove = async () => {
    if (submitting || disabled || !hasOrderId) return;
    setSubmitting(true);
    setError('');
    setReceipt('');
    try {
      const updated = await api.post<{ orderNo?: string; approverName?: string; approvedAt?: string }>(
        `/inspections/${encodeURIComponent(String(orderId))}/approve`,
        {}
      );
      const name = (updated?.approverName ?? '').trim();
      const at = formatStamp(updated?.approvedAt);
      setApproved({ name, at });
      setReceipt(
        `已由${name !== '' ? name : '当前登录用户'}签核${at !== '' ? `（${at}）` : ''}${
          updated?.orderNo !== undefined && updated.orderNo !== '' ? ` · ${updated.orderNo}` : ''
        }`
      );
      onApproved?.({
        orderId: String(orderId),
        ...(name !== '' ? { approverName: name } : {}),
        ...(updated?.approvedAt !== undefined ? { approvedAt: updated.approvedAt } : {}),
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {approved !== null && (
          <span className="text-[11px] text-emerald-700" data-testid="approval-state">
            已由 {approved.name !== '' ? approved.name : '当前登录用户'} 签核
            {approved.at !== '' ? ` · ${approved.at}` : ''}
          </span>
        )}
        <button
          type="button"
          onClick={() => void handleApprove()}
          disabled={submitting || disabled || !hasOrderId}
          title={hasOrderId ? '以当前登录用户身份签核本单' : '本单尚未落库（无检验单 ID），无法签核'}
          className="px-3.5 py-1.5 rounded bg-amber-50 border border-amber-200 text-amber-800 text-xs font-medium hover:bg-amber-100 flex items-center gap-1.5 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <ShieldCheck className="w-3.5 h-3.5" />
          {submitting ? '签核中…' : approved !== null ? '重新签核' : '质量负责人签核'}
        </button>
      </div>
      {receipt !== '' && <span className="text-[11px] text-emerald-700">{receipt}</span>}
      {error !== '' && <span className="text-[11px] text-rose-600">{error}</span>}
    </div>
  );
};