import type { MRBDisposition, MRBStatus } from '@letian/contracts';
import type { BadgeTone } from '../../components/StatusBadge';

/**
 * MRB 不合格品处置页的口径单点定义（页签 / 状态 / 处置方式 / 会签席位）。
 *
 * 口径依据：docs/19-MRB不合格品处置页整合设计.md §4。
 * 「已评审」= 已有评审结论（DISPOSED + REJECTED），是「已处置」的父集，
 * 与后端 KPI `totalReviewedCount` 口径一致（packages/infrastructure/src/repositories/mrb-review-repository.ts）。
 */

export type MrbTabKey = 'ALL' | 'PENDING_REVIEW' | 'UNDER_REVIEW' | 'REVIEWED' | 'DISPOSED';

export interface MrbTab {
  key: MrbTabKey;
  label: string;
  /** 该页签对应的服务端状态谓词；空数组表示不过滤（全部） */
  statuses: readonly MRBStatus[];
}

export const MRB_TABS: readonly MrbTab[] = [
  { key: 'ALL', label: '全部', statuses: [] },
  { key: 'PENDING_REVIEW', label: '待评审', statuses: ['PENDING_REVIEW'] },
  { key: 'UNDER_REVIEW', label: '评审中', statuses: ['UNDER_REVIEW'] },
  { key: 'REVIEWED', label: '已评审', statuses: ['DISPOSED', 'REJECTED'] },
  { key: 'DISPOSED', label: '已处置', statuses: ['DISPOSED'] },
];

export const MRB_STATUS_LABEL: Record<MRBStatus, string> = {
  PENDING_REVIEW: '待评审',
  UNDER_REVIEW: '评审中',
  DISPOSED: '已处置',
  REJECTED: '已驳回',
};

/** 状态胶囊配色：待评审 amber、评审中 blue、已处置 emerald、已驳回 rose（对齐 WPS图片(13) 语义） */
export const MRB_STATUS_TONE: Record<MRBStatus, BadgeTone> = {
  PENDING_REVIEW: 'amber',
  UNDER_REVIEW: 'blue',
  DISPOSED: 'green',
  REJECTED: 'red',
};

export const MRB_DISPOSITION_LABEL: Record<MRBDisposition, string> = {
  RETURN_TO_VENDOR: '退货',
  REWORK: '返工 / 返修',
  CONCESSION: '特采（让步接收）',
  SCRAP: '报废',
};

export const MRB_DISPOSITION_OPTIONS: readonly { value: MRBDisposition; label: string }[] = [
  { value: 'RETURN_TO_VENDOR', label: '退货' },
  { value: 'REWORK', label: '返工 / 返修' },
  { value: 'CONCESSION', label: '特采（让步接收）' },
  { value: 'SCRAP', label: '报废' },
];

/** 会签席位 → 后端审批角色编码（与 packages/contracts 的 MRBApproverAction.roleCode 对齐） */
export const MRB_ROLE_CODE_MAP = {
  QUALITY: 'QA_MGR',
  ENGINEERING: 'TECH_DIR',
  PRODUCTION: 'PROD_SUP',
  MANAGEMENT: 'MGMT_DIR',
} as const;

export type MrbSeatKey = keyof typeof MRB_ROLE_CODE_MAP;

export interface MrbSeat {
  key: MrbSeatKey;
  label: string;
  desc: string;
}

export const MRB_SEATS: readonly MrbSeat[] = [
  { key: 'QUALITY', label: '质量部负责人 (QC Leader)', desc: '尺寸规格与放行风控评估' },
  { key: 'ENGINEERING', label: '工程技术部 (PE/ME)', desc: '机械强度与装配公差校核' },
  { key: 'PRODUCTION', label: '生产车间主管 (Workshop)', desc: '机台停机隔离与返修可行性' },
  { key: 'MANAGEMENT', label: '质量总监 (Director/MRB)', desc: '特采最终批准与放行指令' },
];

/** 状态枚举白名单（渲染前兜底，避免后端新增枚举值时整页崩溃） */
export function statusLabel(status: string): string {
  return MRB_STATUS_LABEL[status as MRBStatus] ?? status;
}

export function statusTone(status: string): BadgeTone {
  return MRB_STATUS_TONE[status as MRBStatus] ?? 'slate';
}

export function dispositionLabel(disposition: string | undefined): string {
  if (disposition === undefined) return '—';
  return MRB_DISPOSITION_LABEL[disposition as MRBDisposition] ?? disposition;
}
