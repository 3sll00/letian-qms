import React from 'react';
import { cn } from '../lib/utils';

export type BadgeTone = 'green' | 'red' | 'amber' | 'blue' | 'purple' | 'slate';

interface StatusBadgeProps {
  status: string;
  tone?: BadgeTone;
  children?: React.ReactNode;
  className?: string;
  dot?: boolean;
}

export function getToneByStatus(status: string): BadgeTone {
  const s = status.toUpperCase();
  if (['PASS', 'PASSED', 'COMPLETED', 'QUALIFIED', 'RESOLVED', 'CLOSED', 'ACTIVE', 'DELIVERED', 'NORMAL', 'DISPOSED', 'ONLINE', '已合格', '合格', '正常', '已启用'].includes(s)) {
    return 'green';
  }
  if (['FAIL', 'FAILED', 'REJECT', 'REJECTED', 'DEFECTIVE', 'CRITICAL', 'SUSPENDED', 'BLOCKED', 'INTERCEPTED', '不合格', '异常', '失败', '阻断'].includes(s)) {
    return 'red';
  }
  if (['CONCESSION', 'PENDING', 'PENDING_REVIEW', 'UNDER_REVIEW', 'REVIEWING', 'REVIEW', 'WARNING', 'ON_LEAVE', 'HIGH', 'RE_INSPECTING', '特采', '待评审', '待检', '待检验'].includes(s)) {
    return 'amber';
  }
  if (['IN_PROGRESS', 'RUNNING', 'PROCESSING', 'MEDIUM', 'INSPECTING', 'STORED', 'IN_MRB_REVIEW', '检验中', '评审中', '已审核'].includes(s)) {
    return 'blue';
  }
  return 'slate';
}

export function StatusBadge({ status, tone, children, className, dot = false }: StatusBadgeProps) {
  const currentTone = tone || getToneByStatus(status);

  const toneClasses: Record<BadgeTone, { bg: string; text: string; border: string; dotColor: string }> = {
    green: {
      bg: 'bg-emerald-50',
      text: 'text-emerald-600',
      border: 'border-emerald-200',
      dotColor: 'bg-emerald-500',
    },
    red: {
      bg: 'bg-rose-50',
      text: 'text-rose-600',
      border: 'border-rose-200',
      dotColor: 'bg-rose-500',
    },
    amber: {
      bg: 'bg-amber-50',
      text: 'text-amber-600',
      border: 'border-amber-200',
      dotColor: 'bg-amber-500',
    },
    blue: {
      bg: 'bg-blue-50',
      text: 'text-blue-600',
      border: 'border-blue-200',
      dotColor: 'bg-blue-500',
    },
    purple: {
      bg: 'bg-purple-50',
      text: 'text-purple-600',
      border: 'border-purple-200',
      dotColor: 'bg-purple-500',
    },
    slate: {
      bg: 'bg-slate-100',
      text: 'text-slate-600',
      border: 'border-slate-200',
      dotColor: 'bg-slate-400',
    },
  };

  const style = toneClasses[currentTone];

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-normal border',
        style.bg,
        style.text,
        style.border,
        className
      )}
    >
      {dot && <span className={cn('w-1.5 h-1.5 rounded-full inline-block mr-0.5', style.dotColor)} />}
      <span>{children || status}</span>
    </span>
  );
}
