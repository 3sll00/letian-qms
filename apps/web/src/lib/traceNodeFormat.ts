/**
 * 质量追溯看板的**纯展示口径**（无 React 依赖，可被 verify 脚本直接断言）。
 *
 * 口径唯一真相：`docs/24-质量追溯看板界面评审与改造建议.md`
 *
 * 为什么单独成模块：这三条口径靠肉眼评审很难守住，一旦被改回"看起来也行"的写法，
 * 类型检查与契约校验都发现不了（数据结构完全合法，只是结论错了）。抽成纯函数后由
 * `apps/web/scripts/verify-trace-format.mjs` 钉死：
 *
 * 1. `display` —— 缺值统一显示 `—`，禁止空串 / 占位串（docs/24 §8 验收口径 1）。
 * 2. `formatDuration` —— 耗时列**只允许**时长或 `—`，不许拿「委外」「进行中」这类状态值占位
 *    （docs/24 §6 缺陷 D8 / §8 验收口径 5）。
 * 3. `summarizeGraphStatus` —— 概览状态由节点状态**派生**：只要还有「检验中 / 待检验」节点，
 *    就不得声称「全部合格」（docs/24 §6 缺陷 D2）。
 *
 * 变体说明：`CONCESSION`（特采 / 让步接收）与 MRB 侧 `MRBDisposition` 同名同义，
 * 不得被压成 `PASSED` —— 特采是"带着条件放行"，不是"合格"。
 */

/** 追溯节点业务状态：与契约 `TraceNodeStatusEnum` 保持一致（6 值） */
export type TraceNodeStatus = 'PASSED' | 'FAILED' | 'INSPECTING' | 'PENDING' | 'STORED' | 'CONCESSION';

/** 状态中文名。图例与徽标共用同一份，避免两处口径分叉 */
export const NODE_STATUS_LABEL: Readonly<Record<TraceNodeStatus, string>> = {
  PASSED: '已合格',
  FAILED: '不合格',
  INSPECTING: '检验中',
  PENDING: '待检验',
  STORED: '已入库',
  CONCESSION: '特采',
};

/**
 * 状态配色。`STORED` 用青绿（teal）而不是翠绿（emerald），是为了让「已入库」与「已合格」
 * 在视觉上可区分 —— 图例漏项时用户会把绿点直接读成"合格"（docs/24 §3.4）。
 */
export const STATUS_TONE: Readonly<Record<TraceNodeStatus, { dot: string; badge: string; border: string }>> = {
  PASSED: { dot: 'bg-emerald-500', badge: 'bg-emerald-50 text-emerald-600', border: 'border-emerald-500' },
  STORED: { dot: 'bg-teal-500', badge: 'bg-teal-50 text-teal-700', border: 'border-teal-500' },
  FAILED: { dot: 'bg-rose-500', badge: 'bg-rose-50 text-rose-600', border: 'border-rose-500' },
  INSPECTING: { dot: 'bg-blue-500', badge: 'bg-blue-50 text-blue-600', border: 'border-blue-500' },
  PENDING: { dot: 'bg-slate-400', badge: 'bg-slate-100 text-slate-600', border: 'border-slate-300' },
  CONCESSION: { dot: 'bg-amber-500', badge: 'bg-amber-50 text-amber-700', border: 'border-amber-500' },
};

/** 未知状态的兜底配色：回退到中性灰，而不是静默丢弃节点 */
export const FALLBACK_TONE = STATUS_TONE.PENDING;

/** 缺值统一显示为 —，不使用空串或占位串（docs/24 §8 验收口径 1） */
export function display(value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? '—' : value;
}

/** 时间戳裁剪到「YYYY-MM-DD HH:mm」，兼容 ISO 与已格式化字符串；缺值显示 — */
export function formatTime(value: string | undefined): string {
  if (value === undefined || value === '') return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(
    parsed.getHours()
  )}:${pad(parsed.getMinutes())}`;
}

/**
 * 耗时只允许出现时长或 —。
 *
 * 没有终检时间就没有耗时，绝不用「委外」「进行中」这类状态值填进耗时列（docs/24 §6 D8）。
 * 同时拒绝负值与 NaN：负数时长是数据错误，展示出来只会误导现场。
 */
export function formatDuration(minutes: number | undefined): string {
  if (minutes === undefined || minutes === null || Number.isNaN(minutes) || minutes < 0) return '—';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}

/**
 * 概览状态由节点状态派生：只要存在未完结 / 不合格 / 特采节点，就不得声称「全部合格」
 * （docs/24 §6 D2）。
 *
 * 优先级：不合格 > 特采 > 未完结 > 全部合格 —— 红色必须压过琥珀色，
 * 否则一批不合格里夹一张特采单，概览会给出"看起来还行"的提示。
 */
export function summarizeGraphStatus(
  nodes: readonly { nodeStatus: TraceNodeStatus }[]
): { label: string; tone: string } {
  if (nodes.length === 0) {
    return { label: '暂无节点', tone: STATUS_TONE.PENDING.badge };
  }
  if (nodes.some((node) => node.nodeStatus === 'FAILED')) {
    return { label: '存在不合格节点', tone: STATUS_TONE.FAILED.badge };
  }
  if (nodes.some((node) => node.nodeStatus === 'CONCESSION')) {
    return { label: '存在特采节点', tone: STATUS_TONE.CONCESSION.badge };
  }
  const unfinished = nodes.filter(
    (node) => node.nodeStatus === 'INSPECTING' || node.nodeStatus === 'PENDING'
  ).length;
  if (unfinished > 0) {
    return { label: `${unfinished} 个节点未完结`, tone: STATUS_TONE.INSPECTING.badge };
  }
  return { label: '全部合格', tone: STATUS_TONE.PASSED.badge };
}
/**
 * 图例条目：**必须覆盖契约枚举的全部取值**。
 *
 * 漏项会让用户把「已入库」的绿点直接读成「已合格」（docs/24 §3.4 / §4 R4），
 * 因此这里不写死长度：由 `scripts/verify-trace-format.mjs` 与 `TraceNodeStatusEnum` 逐值比对，
 * 契约新增状态而图例没跟上时脚本直接失败。
 */
export const TRACE_STATUS_LEGEND: ReadonlyArray<{ status: TraceNodeStatus; label: string }> = [
  { status: 'PASSED', label: '已合格' },
  { status: 'STORED', label: '已入库' },
  { status: 'CONCESSION', label: '特采' },
  { status: 'FAILED', label: '不合格' },
  { status: 'INSPECTING', label: '检验中' },
  { status: 'PENDING', label: '待检验' },
];