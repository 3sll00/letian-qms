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
  if (['PASS', 'PASSED', 'COMPLETED', 'QUALIFIED', 'RESOLVED', 'CLOSED', 'ACTIVE', 'DELIVERED', 'NORMAL', 'DISPOSED', 'ONLINE'].includes(s)) {
    return 'green';
  }
  if (['FAIL', 'FAILED', 'REJECT', 'REJECTED', 'DEFECTIVE', 'CRITICAL', 'SUSPENDED', 'BLOCKED', 'INTERCEPTED'].includes(s)) {
    return 'red';
  }
  if (['CONCESSION', 'PENDING', 'PENDING_REVIEW', 'UNDER_REVIEW', 'REVIEWING', 'REVIEW', 'WARNING', 'ON_LEAVE', 'HIGH', 'RE_INSPECTING'].includes(s)) {
    return 'amber';
  }
  if (['IN_PROGRESS', 'RUNNING', 'PROCESSING', 'MEDIUM', 'INSPECTING', 'STORED', 'IN_MRB_REVIEW'].includes(s)) {
    return 'blue';
  }
  return 'slate';
}

export function StatusBadge({ status, tone, children, className, dot = true }: StatusBadgeProps) {
  const currentTone = tone || getToneByStatus(status);

  const toneClasses: Record<BadgeTone, { bg: string; text: string; border: string; dotColor: string }> = {
    green: {
      bg: 'bg-emerald-950/60',
      text: 'text-emerald-400',
      border: 'border-emerald-500/30',
      dotColor: 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]',
    },
    red: {
      bg: 'bg-rose-950/60',
      text: 'text-rose-400',
      border: 'border-rose-500/30',
      dotColor: 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.8)] animate-pulse',
    },
    amber: {
      bg: 'bg-amber-950/60',
      text: 'text-amber-400',
      border: 'border-amber-500/30',
      dotColor: 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.8)]',
    },
    blue: {
      bg: 'bg-sky-950/60',
      text: 'text-sky-400',
      border: 'border-sky-500/30',
      dotColor: 'bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.8)]',
    },
    purple: {
      bg: 'bg-purple-950/60',
      text: 'text-purple-400',
      border: 'border-purple-500/30',
      dotColor: 'bg-purple-400 shadow-[0_0_8px_rgba(192,132,252,0.8)]',
    },
    slate: {
      bg: 'bg-slate-800/80',
      text: 'text-slate-300',
      border: 'border-slate-700',
      dotColor: 'bg-slate-400',
    },
  };

  const style = toneClasses[currentTone];

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border font-mono tracking-wide',
        style.bg,
        style.text,
        style.border,
        className
      )}
    >
      {dot && <span className={cn('w-1.5 h-1.5 rounded-full inline-block', style.dotColor)} />}
      <span>{children || status}</span>
    </span>
  );
}
