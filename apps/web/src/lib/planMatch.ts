/**
 * 检验录入页 · 质检方案匹配数据层与客户端实时判标
 *
 * 口径唯一真相：docs/17-检验录入界面说明与质检方案匹配口径.md §7
 *   第一步（读）：GET /api/v1/plans/match?materialCode=&inspectionType=
 *                → 命中方案的 planVersionId + 待检指标清单
 *   第二步（写）：建单时把 planVersionId 原样回传，服务端据此固化 planSnapshot 快照
 *   回看（读）：已建工单一律读 GET /api/v1/inspections/{id} 的【本单方案快照】（§7.3「快照即证据」），
 *              指标项与判定以工单落库结果为准；只有新建/继续录入才按物料匹配"当前生效方案"
 *
 * 判标口径唯一真相：@letian/domain 的 evaluateInspectionItem
 *   → 闭区间判定 + 1e-9 浮点容差；缺标准值 / 缺实测值一律 PENDING，绝不静默放行
 *   → 客户端只做"给人看"的实时预判，提交后由服务端复判落库为准（两侧同一份算法）
 */
import { z } from 'zod';
import {
  InspectionOrderSchema,
  InspectionPlanItemSchema,
  MatchedInspectionPlanSchema,
} from '@letian/contracts';
import type { InspectionItem, InspectionItemDecision, InspectionType } from '@letian/contracts';
import { evaluateInspectionItem } from '@letian/domain';
import { ApiError, api } from './api';

export type PlanItem = z.infer<typeof InspectionPlanItemSchema>;
export type MatchedPlan = z.infer<typeof MatchedInspectionPlanSchema>;
export type InspectionOrder = z.infer<typeof InspectionOrderSchema>;

/**
 * 方案匹配 / 快照加载状态（唯一真相，`useMatchedPlan` 与各表单分区空态共用）：
 *   idle      尚未发起匹配（缺物料编码 / 检验类型）
 *   loading   匹配中
 *   ready     方案已命中 / 本单快照已加载，指标行可渲染
 *   not-found 两级匹配均未命中（404 inspection-plan-not-found）
 *   error     其它失败（含 403 数据权限拦截、结构校验失败、网络错误）
 */
export type PlanMatchStatus = 'idle' | 'loading' | 'ready' | 'not-found' | 'error';

/**
 * 指标行的「判定基准」：数值基准与判定规则的唯一读取处。
 *
 * 方案指标项（`PlanItem`）与工单实测项（`InspectionItem`）字段高度重叠，
 * 这里只取两者共有的最小集合，使「按当前方案录入」与「按本单快照回看」
 * 共用同一套判标入口（`evaluatePlanItem`），不会出现两套判标规则。
 */
export interface PlanBasis {
  itemCode: string;
  name: string;
  seq: number;
  dataType: PlanItem['dataType'];
  metricCategory: PlanItem['metricCategory'];
  standardText?: string | undefined;
  /** 定性/文本型指标的可接受值清单（TBD-06）：非空时判定只认清单成员 */
  acceptableValues?: string[] | undefined;
  nominalValue?: number | undefined;
  upperTolerance?: number | undefined;
  lowerTolerance?: number | undefined;
  unit?: string | undefined;
  // —— ERP 检验方案明细口径字段（T_Inf_PtypeCheckingSchemeDly）——
  /** 检验项目字典回链（ERP TITypeId） */
  testItemCode?: string | undefined;
  /** 公差/偏差原文（ERP Dif，如 '±0.1'）：展示时拼在标准值之后 */
  dif?: string | undefined;
  /** 检验方式（ERP CheckWay） */
  checkWay?: string | undefined;
  /** 检验设备（ERP CheckDevice） */
  measurementTool?: string | undefined;
}

/**
 * 指标行来源（docs/17 §7.5.3 / §7.8 定稿）：
 *   MATCH    = 按「物料 + 检验类型」匹配到的**当前生效方案**（新建 / 继续录入）；
 *   SNAPSHOT = 工单建单时固化的**本单方案快照**（只读回看，方案改版不影响历史工单）。
 */
export type PlanRowSource = 'MATCH' | 'SNAPSHOT';

/** 提示条展示用的方案元数据（方案命中结果与本单快照都能满足，不再伪造 matchSource） */
export interface PlanDisplayMeta {
  planVersionId: string;
  planCode: string;
  planName: string;
  versionNo: string;
  samplingScheme: string;
  aqlLevel: string;
  strictness: string;
  /** 命中来源：只有 MATCH 模式才有"物料专属 / 分类兜底"的概念 */
  matchSource?: MatchedPlan['matchSource'] | undefined;
  /** 快照生成时间：只有 SNAPSHOT 模式有值 */
  snapshotAt?: string | undefined;
}

/** 录入页三大分区：与 IQC / OQC 录入表单既有视觉分区一一对应 */
export type PlanSection = 'CHEMICAL' | 'MECHANICAL' | 'DIMENSIONAL';

export const PLAN_SECTION_LABEL: Record<PlanSection, string> = {
  CHEMICAL: '化学成分',
  MECHANICAL: '力学与物理性能',
  DIMENSIONAL: '尺寸与外观',
};

/** 指标类别 → 录入页分区（未列出的类别统一并入尺寸外观区，避免指标被静默丢弃） */
export function planSectionOf(metricCategory: string): PlanSection {
  switch (metricCategory) {
    case 'CHEMICAL_COMPOSITION':
    case 'TEXT_INTERVAL':
      return 'CHEMICAL';
    case 'TENSILE_STRENGTH':
    case 'MECHANICAL_PERFORMANCE':
    case 'HARDNESS':
    case 'COATING_THICKNESS':
      return 'MECHANICAL';
    default:
      return 'DIMENSIONAL';
  }
}

/**
 * 按分区拆分**指标行**（已带实测值与落库判定的行），分区内按 seq 排序。
 *
 * 只保留这一个分区入口：方案命中的指标项与工单快照的实测项都先统一成 `PlanIndicatorRow`，
 * 再走这里分区，避免"按方案渲染一套、按快照渲染另一套"的口径漂移。
 */
export function splitIndicatorRows(
  rows: readonly PlanIndicatorRow[]
): Record<PlanSection, PlanIndicatorRow[]> {
  const grouped: Record<PlanSection, PlanIndicatorRow[]> = {
    CHEMICAL: [],
    MECHANICAL: [],
    DIMENSIONAL: [],
  };
  for (const row of [...rows].sort((left, right) => left.seq - right.seq)) {
    grouped[planSectionOf(row.planItem.metricCategory)].push(row);
  }
  return grouped;
}

/**
 * 单侧公差（"≤0.030" / "≥650MPa" 这类只有一侧边界的标准语）
 * 在"中心值 ± 公差"闭区间模型中的无界侧取值：取值足够大，使该侧退化为不限制。
 * QC 量程远小于该值，不损失有效精度。
 */
const UNBOUNDED_TOLERANCE = Number.MAX_SAFE_INTEGER;

/**
 * 解析标准语里的数值区间。支持：
 *   区间 "0.37 ~ 0.44" / "0.05%~0.11%" / "32~38HRC"（数值与 `~` 之间允许夹一个百分号）
 *   公差 "Φ5.00±0.02" / "22.0 ± 0.20 mm"
 *   单侧上限 "≤0.030" / "Ra≤0.8μm"；单侧下限 "≥650MPa"
 * 解析不出来（如 "目视：无裂纹"）返回 null，判定落到 PENDING，交人工/文本比对。
 */
export function parseStandardBounds(
  standardText: string
): { min: number | null; max: number | null } | null {
  const text = standardText.replace(/\s+/g, '');
  let match = text.match(/(-?\d+(?:\.\d+)?)[%％]?[~～–—](-?\d+(?:\.\d+)?)/);
  if (match) return { min: Number(match[1]), max: Number(match[2]) };
  match = text.match(/(-?\d+(?:\.\d+)?)±(\d+(?:\.\d+)?)/);
  if (match) {
    const nominal = Number(match[1]);
    const tolerance = Number(match[2]);
    return { min: nominal - tolerance, max: nominal + tolerance };
  }
  match = text.match(/[≤<]=?(-?\d+(?:\.\d+)?)/);
  if (match) return { min: null, max: Number(match[1]) };
  match = text.match(/[≥>]=?(-?\d+(?:\.\d+)?)/);
  if (match) return { min: Number(match[1]), max: null };
  return null;
}

/**
 * 标准要求展示文本：方案给了 standardText 就照用；缺失时由 nominalValue ± 公差回拼。
 * ERP 方案明细的「公差」独立列 `dif` 非空时拼在标准值之后（如 `800 ±10`），
 * 保证录入页展示与判标入参的文本同一份（parseStandardBounds 能一并解析出公差带）。
 */
export function standardDisplayOf(
  item: Pick<
    PlanBasis,
    'standardText' | 'nominalValue' | 'upperTolerance' | 'lowerTolerance' | 'unit' | 'dif'
  >
): string {
  const dif = item.dif?.trim();
  const suffix = dif !== undefined && dif !== '' ? ` ${dif}` : '';
  const text = item.standardText?.trim();
  if (text !== undefined && text !== '') return `${text}${suffix}`;
  if (item.nominalValue === undefined) return suffix !== '' ? dif! : '—（方案未给出数值基准）';
  const unit = item.unit !== undefined && item.unit !== '' ? ` ${item.unit}` : '';
  const upper = item.upperTolerance ?? 0;
  const lower = item.lowerTolerance ?? 0;
  if (upper === 0 && lower === 0) return `${item.nominalValue}${unit}${suffix}`;
  if (upper === lower) return `${item.nominalValue} ± ${upper}${unit}${suffix}`;
  return `${item.nominalValue} (+${upper} / -${lower})${unit}${suffix}`;
}

/** 从实测录入文本里抽数值："22.08" / "22.08 mm" 均可；纯文字返回 undefined */
export function parseMeasuredNumber(measuredText: string): number | undefined {
  const match = measuredText.trim().match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : undefined;
}

/** evaluateInspectionItem 的入参形状（与领域服务签名保持一致） */
type EvaluatorInput = Pick<
  InspectionItem,
  | 'dataType'
  | 'measuredVal'
  | 'measuredText'
  | 'nominalValue'
  | 'upperTolerance'
  | 'lowerTolerance'
  | 'standardText'
  | 'acceptableValues'
  | 'isExempt'
>;

/**
 * 组装领域判标服务的入参。
 *
 * 数值基准优先级：方案显式给出的 nominalValue/upperTolerance/lowerTolerance
 *   → 缺失时从标准语推断（录入页允许现场修订标准语，此时以修订后的文本为准）
 *   → 都推不出来就保持缺省，让判定落在 PENDING（绝不放行）
 */
export function buildEvaluatorInput(
  item: Pick<
    PlanBasis,
    | 'dataType'
    | 'standardText'
    | 'acceptableValues'
    | 'nominalValue'
    | 'upperTolerance'
    | 'lowerTolerance'
    | 'unit'
  >,
  measuredText: string,
  options: { standardText?: string; isExempt?: boolean } = {}
): EvaluatorInput {
  const displayedStandard = standardDisplayOf(item);
  const standardText = options.standardText ?? displayedStandard;
  const standardEdited = standardText.trim() !== displayedStandard.trim();

  let nominalValue = standardEdited ? undefined : item.nominalValue;
  let upperTolerance = standardEdited ? undefined : item.upperTolerance;
  let lowerTolerance = standardEdited ? undefined : item.lowerTolerance;

  if (item.dataType === 'NUMERIC' && nominalValue === undefined) {
    const bounds = parseStandardBounds(standardText);
    if (bounds !== null && bounds.min !== null && bounds.max !== null) {
      nominalValue = (bounds.min + bounds.max) / 2;
      upperTolerance = bounds.max - nominalValue;
      lowerTolerance = nominalValue - bounds.min;
    } else if (bounds !== null && bounds.max !== null) {
      nominalValue = bounds.max;
      upperTolerance = 0;
      lowerTolerance = UNBOUNDED_TOLERANCE;
    } else if (bounds !== null && bounds.min !== null) {
      nominalValue = bounds.min;
      upperTolerance = UNBOUNDED_TOLERANCE;
      lowerTolerance = 0;
    }
  }

  const trimmed = measuredText.trim();
  const isTextType = item.dataType !== 'NUMERIC';

  return {
    dataType: item.dataType,
    measuredVal: isTextType ? undefined : parseMeasuredNumber(trimmed),
    measuredText: trimmed === '' ? undefined : trimmed,
    nominalValue,
    upperTolerance,
    lowerTolerance,
    standardText,
    acceptableValues: item.acceptableValues,
    isExempt: options.isExempt ?? false,
  };
}

/** 单项实时判标（唯一入口：四个录入表单都必须经此调用领域服务，不得各自另写判标规则） */
export function evaluatePlanItem(
  item: Pick<
    PlanBasis,
    | 'dataType'
    | 'standardText'
    | 'acceptableValues'
    | 'nominalValue'
    | 'upperTolerance'
    | 'lowerTolerance'
    | 'unit'
  >,
  measuredText: string,
  options: { standardText?: string; isExempt?: boolean } = {}
): InspectionItemDecision {
  return evaluateInspectionItem(buildEvaluatorInput(item, measuredText, options));
}

/**
 * 录入页指标行：四个录入表单共用的"展示 + 录入"载体。
 * 标准值与数值基准一律来自方案指标项，判定规则不再散落在各表单里。
 */
export interface PlanIndicatorRow {
  /** 指标在方案 / 快照中的顺序（分区内按此排序） */
  seq: number;
  /** 方案指标编码（建单回传、炉批号溯源匹配用） */
  itemCode: string;
  /** 界面主标题：化学元素显示元素名，其余显示指标名 */
  title: string;
  /** 指标名称 */
  name: string;
  /** 标准要求展示文本（可在录入页现场修订，修订后按修订文本判标） */
  standard: string;
  /** 实测值（质检员录入） */
  actual: string;
  unit: string;
  /** 不解检/免检标记，默认 false，由质检员勾选 */
  isExempt: boolean;
  /** 判定基准：数值基准与判定规则都从这里读，保证与后端落库复判同口径 */
  planItem: PlanBasis;
  /**
   * 只读回看专用：工单落库的单项判定结论（快照即证据）。
   * 有值时直接采用，不在前端用"当前标准"重算——否则方案改版后回看结论会与当时不一致。
   */
  storedDecision?: InspectionItemDecision | undefined;
  /** 只读回看专用：工单落库的缺陷原因 / 备注 */
  storedRemark?: string | undefined;
}

/** 由方案指标项生成待检行：实测值留空，等待录入 */
export function toPlanIndicatorRow(item: PlanItem): PlanIndicatorRow {
  return {
    seq: item.seq,
    itemCode: item.itemCode,
    title: item.name !== '' ? item.name : item.itemCode,
    name: item.name,
    standard: standardDisplayOf(item),
    actual: '',
    unit: item.unit ?? '',
    isExempt: false,
    planItem: item,
  };
}

/**
 * 由**工单实测项**（`GET /api/v1/inspections/{id}` 返回的 `items`）生成回看行。
 *
 * 工单项在建单时由方案快照派生并随录入更新，因此同时带着"当时的判定基准"与"当时的实测值 / 结论"。
 * 回看一律读它，不按「物料 + 检验类型」重新匹配当前生效方案 —— 口径见 docs/17 §7.3「快照即证据」。
 */
export function toPlanIndicatorRowFromOrderItem(item: InspectionItem): PlanIndicatorRow {
  const measured =
    item.measuredVal !== undefined && item.measuredVal !== null
      ? String(item.measuredVal)
      : (item.measuredText ?? '');
  return {
    seq: item.seq,
    itemCode: item.itemCode,
    title: item.name !== '' ? item.name : item.itemCode,
    name: item.name,
    standard: standardDisplayOf(item),
    actual: measured,
    unit: item.unit ?? '',
    isExempt: item.isExempt,
    planItem: item,
    storedDecision: item.result,
    storedRemark: item.defectReason ?? item.remark,
  };
}

/** 录入页实时判标唯一入口（表单内不得另写判标规则） */
export function judgeIndicatorRow(row: PlanIndicatorRow): InspectionItemDecision {
  // 只读回看：直接采用工单落库判定（快照即证据），不在前端按当前标准重算
  if (row.storedDecision !== undefined) return row.storedDecision;
  return evaluatePlanItem(row.planItem, row.actual, {
    standardText: row.standard,
    isExempt: row.isExempt,
  });
}

/**
 * 定性 / 文本型指标的候选值，按与领域层**完全相同的优先级**取：
 *   1) 方案结构化配置的 `acceptableValues`（TBD-06，唯一权威，有清单就不看标准语）；
 *   2) 回落标准语按**与领域层完全相同的分隔符**拆出的可接受值。
 *
 * 分隔符必须与 `packages/domain/src/services/tolerance-evaluator.ts` 的
 * `split(/[,，/|]/)` 保持一致——这里多拆一个符号，界面就会给出一个领域层根本不认的"候选值"，
 * 质检员点了反而被判不合格（TBD-05 要修的就是这类误判）。
 */
export function qualitativeOptionsOf(
  standardText: string,
  acceptableValues?: readonly string[] | undefined
): string[] {
  const seen = new Set<string>();
  const options: string[] = [];
  const push = (raw: string): void => {
    const value = raw.trim();
    if (value === '' || seen.has(value)) return;
    seen.add(value);
    options.push(value);
  };

  for (const configured of acceptableValues ?? []) push(configured);
  if (options.length > 0) return options;

  for (const raw of standardText.split(/[,，/|]/)) push(raw);
  return options;
}

/** 该行是否为定性 / 文本型（按"实测文本与标准语一致"比对，不参与数值区间判定） */
export function isQualitativeRow(row: PlanIndicatorRow): boolean {
  return row.planItem.dataType === 'TEXT' || row.planItem.dataType === 'QUALITATIVE';
}

/** 提交/证书用：只有 PASSED 才算合格，待判定不得冒充合格 */
export function decisionIsPassed(decision: InspectionItemDecision): boolean {
  return decision === 'PASSED';
}

/** 判定结果中文标签 */
export const DECISION_LABEL: Record<InspectionItemDecision, string> = {
  PASSED: '合格',
  FAILED: '不合格',
  PENDING: '待判定',
  EXEMPT: '免检',
};

/** 判定结果语义色：合格=绿 / 不合格=红 / 待判定=灰 / 免检=蓝 */
export function decisionTone(decision: InspectionItemDecision): 'pass' | 'fail' | 'pending' | 'exempt' {
  switch (decision) {
    case 'PASSED':
      return 'pass';
    case 'FAILED':
      return 'fail';
    case 'EXEMPT':
      return 'exempt';
    default:
      return 'pending';
  }
}

export interface PlanJudgementSummary {
  /** 方案给出的指标项总数 */
  total: number;
  /** 免检/不解检项数（已剔除出合格率分母★） */
  exempt: number;
  /** 有效参检项数（合格率分母） */
  effective: number;
  passed: number;
  failed: number;
  pending: number;
  /** 有效参检项的合格率，分母为 0 时返回 null（不做 100% 的假象） */
  passRate: number | null;
}

/** 汇总录入页当前判标结果；分母为 0 时合格率返回 null（由调用方展示"暂无有效参检项"） */
export function summarizeJudgements(decisions: readonly InspectionItemDecision[]): PlanJudgementSummary {
  const summary: PlanJudgementSummary = {
    total: decisions.length,
    exempt: 0,
    effective: 0,
    passed: 0,
    failed: 0,
    pending: 0,
    passRate: null,
  };
  for (const decision of decisions) {
    if (decision === 'EXEMPT') {
      summary.exempt += 1;
      continue;
    }
    summary.effective += 1;
    if (decision === 'PASSED') summary.passed += 1;
    else if (decision === 'FAILED') summary.failed += 1;
    else summary.pending += 1;
  }
  summary.passRate = summary.effective === 0 ? null : summary.passed / summary.effective;
  return summary;
}

/** 匹配命中来源中文标签（MATERIAL = 物料专属方案 / MATERIAL_CATEGORY = 存货分类通用方案兜底） */
export function matchSourceLabel(matchSource: MatchedPlan['matchSource']): string {
  return matchSource === 'MATERIAL' ? '物料专属方案' : '存货分类通用方案（兜底命中）';
}

/**
 * 把已建工单的**方案快照**适配成提示条可用的方案元数据。
 *
 * 注意：这里刻意不给出 `matchSource` —— 历史工单快照里没有"当时怎么命中的"这件事，
 * 凭空填 `MATERIAL` 会让界面谎称"已匹配当前方案"（正是 TBD-04 要修的口径）。
 */
export function snapshotToDisplayMeta(order: InspectionOrder): PlanDisplayMeta {
  const snapshot = order.planSnapshot;
  return {
    planVersionId: order.planVersionId,
    planCode: snapshot.planCode,
    planName: snapshot.planName,
    versionNo: snapshot.versionNo,
    samplingScheme: snapshot.samplingScheme,
    aqlLevel: snapshot.aqlLevel,
    strictness: snapshot.strictness,
    snapshotAt: snapshot.snapshotAt,
  };
}

/**
 * 本机时区的当天日期（YYYY-MM-DD）。
 *
 * 生效周期（TBD-08）在服务端按日期过滤，前端要用「同一天」给出未生效 / 已过期提示，
 * 因此统一一个实现：不能用 `toISOString().slice(0, 10)` —— 那是 UTC 日期，
 * 东八区上午会取到「昨天」，界面提示会与匹配结果对不上。
 */
export function todayLocalDate(): string {
  const now = new Date();
  const pad = (num: number) => String(num).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 版本生效周期（落 inspection_plans.sampling_config JSONB）：任一侧缺省 = 该侧不设边界 */
export interface PlanEffectivePeriod {
  effectiveStartDate?: string | undefined;
  effectiveEndDate?: string | undefined;
}

/**
 * 生效周期是否覆盖指定日期（默认今天）。
 *
 * 与后端 `findActivePlan` 的 SQL 过滤逐字同口径：
 * `effectiveStartDate IS NULL OR effectiveStartDate <= 当天`，截止日同理 —— 两侧都可为空。
 */
export function isPeriodEffective(
  period: PlanEffectivePeriod | undefined,
  onDate = todayLocalDate()
): boolean {
  if (!period) return true;
  if (period.effectiveStartDate && period.effectiveStartDate > onDate) return false;
  if (period.effectiveEndDate && period.effectiveEndDate < onDate) return false;
  return true;
}

/**
 * 生效周期提示（方案列表「状态」列用）：`未生效` / `已过期` / 空串（周期覆盖今天，正常参与匹配）。
 * 日期为定长 YYYY-MM-DD 文本，字典序即时间序。
 */
export function planPeriodHint(period: PlanEffectivePeriod | undefined): '' | '未生效' | '已过期' {
  if (isPeriodEffective(period)) return '';
  const today = todayLocalDate();
  return period?.effectiveStartDate && period.effectiveStartDate > today ? '未生效' : '已过期';
}

/** 生效周期展示文案：`2026-09-21 ~ 长期有效`（两侧都未配置 = 即刻生效、长期有效，返回 `-`） */
export function planPeriodLabel(period: PlanEffectivePeriod | undefined): string {
  const start = period?.effectiveStartDate ?? '';
  const end = period?.effectiveEndDate ?? '';
  if (start === '' && end === '') return '-';
  return `${start === '' ? '不限' : start} ~ ${end === '' ? '长期有效' : end}`;
}

/**
 * 按「物料编码 + 检验类型」匹配已启用质检方案（第一步 · 读）。
 * 未命中时服务端返回 404 `inspection-plan-not-found`，此处原样抛出由页面提示。
 */
export async function fetchMatchedPlan(
  materialCode: string,
  inspectionType: InspectionType
): Promise<MatchedPlan> {
  const payload = await api.get<unknown>('/plans/match', { materialCode, inspectionType });
  const parsed = MatchedInspectionPlanSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError(502, '服务端返回的质检方案数据结构不符合契约，已阻止按错误数据判标', 'invalid-plan-payload');
  }
  return parsed.data;
}

/**
 * 读取检验单详情（含**本单方案快照**与实测项），只读回看的唯一数据来源。
 *
 * 返回体按 `InspectionOrderSchema` 严格校验：快照里带着`standardText / 公差`与`实测值 / 落库判定`，
 * 校验失败宁可显式报错，也不按"结构不明的数据"渲染判定依据。
 */
export async function fetchInspectionOrder(orderId: string): Promise<InspectionOrder> {
  const payload = await api.get<unknown>(`/inspections/${encodeURIComponent(orderId)}`);
  const parsed = InspectionOrderSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError(
      502,
      '服务端返回的检验单详情不符合契约，已阻止按错误数据回看判定依据',
      'invalid-inspection-order-payload'
    );
  }
  return parsed.data;
}

/** 只读回看：工单详情里 `items` → 待检行（实测值 / 免检标记 / 落库判定全部取工单值） */
export function orderItemsToIndicatorRows(order: InspectionOrder): PlanIndicatorRow[] {
  return (order.items ?? []).map(toPlanIndicatorRowFromOrderItem);
}

/** 是否为"未匹配到已启用方案"（页面据此走引导配置文案，而非报错文案） */
export function isPlanNotFoundError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.code === 'inspection-plan-not-found')
  );
}

/**
 * 是否为 **PBAC 数据权限拦截**（403 `pbac-permission-denied`）。
 *
 * 与 404「方案未配置」是两种完全不同的失败：权限拦截时方案**可能就在那里**，
 * 此时引导用户"去找质量工程师配方案"是答非所问（docs/42 §2.2）。
 * 拦截详情原文（含用户 / 物料分类 / 物料 / 供应商三维）由服务端给出，保留在 `error.message` 中以便排查。
 */
export function isPermissionDeniedError(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.code === 'pbac-permission-denied' || error.status === 403)
  );
}

/**
 * 指标分区空态文案（IQC / OQC 表单的三个分区共用）。
 *
 * 口径：**只有 `ready`（方案已命中 / 本单快照已加载）** 才能说"本单质检方案未包含××类指标项，无需录入"；
 * 未就绪时说这句话，等于把"取不到"说成"不需要" —— 权限拦截 / 加载失败 / 未命中时用户会误以为
 * 本单确实无需录入（docs/42 §2.2）。
 */
export function planSectionEmptyText(status: PlanMatchStatus, sectionLabel: string): string {
  if (status === 'ready') {
    return `本单质检方案未包含${sectionLabel}类指标项，无需录入。`;
  }
  if (status === 'loading') {
    return '正在按质检方案加载待检指标清单…';
  }
  return '待检指标清单未就绪（方案未命中 / 加载失败 / 当前账号无数据权限），本分区不渲染任何待检项，请先按上方提示处理。';
}

/**
 * 失败文案。MATCH（按物料匹配）与 SNAPSHOT（读本单快照）失败原因不同，文案必须分开：
 * 回看历史工单失败时提示"去配置方案"是答非所问。
 */
export function planMatchErrorText(error: unknown, source: PlanRowSource = 'MATCH'): string {
  if (error instanceof ApiError) {
    if (source === 'SNAPSHOT') {
      if (error.status === 404) {
        return '未找到该检验单，可能已被删除或当前账号无查看权限，请刷新列表后重试';
      }
      return error.message;
    }
    if (isPlanNotFoundError(error)) {
      return '未匹配到该物料的已启用质检方案，请联系质量工程师配置并启用方案后再录入';
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return source === 'SNAPSHOT' ? '检验单方案快照加载失败，请稍后重试' : '质检方案匹配失败，请稍后重试';
}
