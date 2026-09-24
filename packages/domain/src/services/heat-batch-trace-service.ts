import { InspectionItem, InspectionOrder } from '@letian/contracts';

/**
 * 炉批号历史数据追溯服务 (HeatBatchTraceService)
 *
 * 口径唯一真相：docs/47-出货检验炉批号数据关联逻辑设计与改造方案.md
 *
 * 客户需求（R1~R3）对应的三级关联优先级，**逐级回退、级别之间不合并**：
 *   L1 委外检验·热处理（`OQC_HEAT`）已终判合格的记录  -> OUTSOURCE_HEAT_TREATMENT
 *   L2 来料检验（`IQC`）已终判合格的记录               -> IQC_RAW_MATERIAL
 *   L3 两处均无                                        -> NONE（界面静默空态，不显示关联数据）
 *
 * 层内取数唯一确定（docs/47 §3.3）：按 `updatedAt` 倒序 -> `createdAt` 倒序 -> `orderNo` 倒序
 * 取第一条，即「最近一次终判的检验记录」；排序落在本服务的纯函数里（不由调用方决定，
 * 也不依赖数据库返回顺序），同一输入多次调用结果一致。
 *
 * 物料维度（docs/47 §3.4）：带 `materialCode` 时**先在同物料内匹配**，同物料无命中才放宽到
 * 跨物料并在响应里标 `matchScope = GLOBAL`（界面据此提示「请确认炉次归属」）。
 */

/** 关联来源枚举（与契约 `FurnaceHeatTraceResponseSchema.sourceType` 同源） */
export const HEAT_TRACE_SOURCE_TYPES = [
  'OUTSOURCE_HEAT_TREATMENT',
  'IQC_RAW_MATERIAL',
  'NONE',
] as const;
export type HeatTraceSourceType = (typeof HEAT_TRACE_SOURCE_TYPES)[number];

/** 命中范围：同物料命中 / 跨物料（或未带物料）命中 */
export type HeatTraceMatchScope = 'MATERIAL' | 'GLOBAL';

/**
 * 上游异常提示的理由码（docs/47 §3.9 / TBD-01，P1）。
 *
 * 口径：**只提示、不带值、不阻断** —— 同一炉批号存在「不合格 / MRB 未结案 / 未终判」记录时，
 * 带出链路本身不变（照常按 L1→L2 回退），只是在响应里多一个可读提示，
 * 让录入人知道「这个炉号上游有问题」，而不是把整条链路变成门禁
 * （跨环节阻断是 `docs/48` 的职责，两者不合并）。
 */
export const HEAT_TRACE_WARNING_CODES = [
  'UPSTREAM_FAILED',
  'UPSTREAM_UNDER_MRB',
  'UPSTREAM_INSPECTING',
] as const;
export type HeatTraceWarningCode = (typeof HEAT_TRACE_WARNING_CODES)[number];

export interface HeatTraceUpstreamWarning {
  code: HeatTraceWarningCode;
  /** 命中的单据号（最多 10 条，按单号升序；超出部分不再展开） */
  orderNos: string[];
  /** 中文可读提示，界面直接展示（不二次组装文案） */
  message: string;
}

export interface HeatTraceInheritedItem {
  itemCode: string;
  name: string;
  metricCategory: string;
  measuredVal?: number | undefined;
  measuredText?: string | undefined;
  unit?: string | undefined;
}

export interface HeatBatchTraceRecord {
  /** 被查询的炉批号（回显原值，非归一值） */
  heatBatchNo: string;
  sourceType: HeatTraceSourceType;
  matchScope: HeatTraceMatchScope;
  sourceOrderNo?: string | undefined;
  sourceOrderId?: string | undefined;
  /** 源单物料编码：跨物料命中时供界面提示确认炉次归属 */
  sourceMaterialCode?: string | undefined;
  inspectedAt?: string | undefined;
  inheritedItems: HeatTraceInheritedItem[];
  /** 上游异常提示（无异常时缺省；带出成功也可能同时带提示） */
  upstreamWarning?: HeatTraceUpstreamWarning | undefined;
}

/**
 * 炉批号归一化（唯一实现，与迁移 034 的生成列表达式同式）：
 *   去空白（含全角空格）-> 去 `-` / `_` -> 转大写。
 * 比较一律用归一值，**落库与展示一律用原值**（见 docs/47 §3.1）。
 */
export function normalizeHeatBatchNo(raw: string | undefined | null): string {
  if (raw === undefined || raw === null) return '';
  return raw.replace(/[\s\-_\u3000]/g, '').toUpperCase();
}

/** 只有「已终判」且**未判不合格**的源单才参与带出（docs/47 §3.2） */
const ELIGIBLE_SOURCE_STATUSES: ReadonlySet<string> = new Set(['PASSED', 'COMPLETED']);

/** 优先级分层：数组顺序即优先级顺序（L1 -> L2） */
const SOURCE_TIERS: ReadonlyArray<{
  inspectionType: InspectionOrder['inspectionType'];
  sourceType: Exclude<HeatTraceSourceType, 'NONE'>;
}> = [
  { inspectionType: 'OQC_HEAT', sourceType: 'OUTSOURCE_HEAT_TREATMENT' },
  { inspectionType: 'IQC', sourceType: 'IQC_RAW_MATERIAL' },
];

/**
 * 可继承指标白名单（docs/47 §3.5，客户需求 R4 的「机械性能等」）：
 * 力学性能 / 硬度 / 抗拉强度统一带出到目标单的「机械物理性能」分区，化学成分带出到「化学成分」分区。
 * 尺寸 / 外观与炉次无因果关系，默认不带出。
 */
const INHERITABLE_METRIC_CATEGORIES: ReadonlySet<string> = new Set([
  'MECHANICAL_PERFORMANCE',
  'HARDNESS',
  'TENSILE_STRENGTH',
  'CHEMICAL_COMPOSITION',
]);

export class HeatBatchTraceService {
  public static resolveHeatBatchData(params: {
    heatBatchNo: string;
    materialCode?: string | undefined;
    historicalOrders: readonly InspectionOrder[];
  }): HeatBatchTraceRecord {
    const raw = (params.heatBatchNo ?? '').trim();
    const normalized = normalizeHeatBatchNo(raw);
    const requestedMaterial = params.materialCode?.trim() ?? '';

    if (normalized === '') {
      return emptyRecord(raw, 'GLOBAL');
    }

    // 1. 先按「炉批号」筛出同炉单据（**不限物料**）—— 物料维度在下面分层处理：
    //    带 materialCode 时先同物料，同物料无命中才放宽到跨物料并标 GLOBAL（§3.4）。
    //    这里不能顺手把跨物料行过滤掉，否则「跨物料命中」这条口径永远不可达，
    //    AC-10 的界面提示会静默消失（物料过滤是调用方 SQL 与领域层都容易犯的同一个错）。
    const sameHeatAll = params.historicalOrders.filter(
      (order) => normalizeHeatBatchNo(order.furnaceHeatNo) === normalized
    );

    // 1.1 TBD-01（docs/47 §3.9）：上游异常**只提示、不带值、不阻断** —— 带出链路照常往下走。
    //     提示的物料维度与「本次要看的数据」一致：带 materialCode 时只看同物料异常，
    //     跨物料同炉的异常不参与本提示（避免给出与本次带出无关的噪声；跨物料信号由 matchScope = GLOBAL 承担）。
    const sameHeat =
      requestedMaterial === ''
        ? sameHeatAll
        : sameHeatAll.filter((order) => order.materialCode === requestedMaterial);
    const warning = pickUpstreamWarning(sameHeat);

    // 1.2 参与带出的候选：已终判合格且未判不合格（物料分层在 2.1 做）
    const candidates = sameHeatAll.filter(
      (order) => ELIGIBLE_SOURCE_STATUSES.has(order.status) && order.overallDecision !== 'FAILED'
    );

    // 2. 逐级回退：L1 命中即返回，不混合带出
    for (const tier of SOURCE_TIERS) {
      const inTier = candidates.filter((order) => order.inspectionType === tier.inspectionType);
      if (inTier.length === 0) continue;

      // 2.1 物料维度：先同物料，再放宽到跨物料（放宽时在响应里标注 GLOBAL）
      const sameMaterial =
        requestedMaterial === ''
          ? []
          : inTier.filter((order) => order.materialCode === requestedMaterial);
      const pool = sameMaterial.length > 0 ? sameMaterial : inTier;

      const best = pickLatest(pool);
      if (best === undefined) continue;

      return {
        heatBatchNo: raw,
        sourceType: tier.sourceType,
        matchScope:
          requestedMaterial !== '' && best.materialCode === requestedMaterial
            ? 'MATERIAL'
            : 'GLOBAL',
        sourceOrderNo: best.orderNo,
        ...(best.id !== undefined ? { sourceOrderId: best.id } : {}),
        ...(best.materialCode !== undefined && best.materialCode !== ''
          ? { sourceMaterialCode: best.materialCode }
          : {}),
        ...(pickInspectedAt(best) !== undefined ? { inspectedAt: pickInspectedAt(best) } : {}),
        inheritedItems: extractInheritableItems(best.items ?? []),
        ...(warning !== undefined
          ? { upstreamWarning: warningWithMessage(warning, true) }
          : {}),
      };
    }

    // 3. 两处均无记录：静默空态（客户需求 R3）
    return emptyRecord(raw, 'GLOBAL', warning);
  }
}

/**
 * 层内排序取「最近一次终判」的一条。
 * 排序键：updatedAt 倒序 -> createdAt 倒序 -> orderNo 倒序（三级键保证结果唯一确定）。
 */
function pickLatest(pool: readonly InspectionOrder[]): InspectionOrder | undefined {
  const sorted = [...pool].sort((a, b) => {
    const byUpdated = timeOf(b.updatedAt) - timeOf(a.updatedAt);
    if (byUpdated !== 0) return byUpdated;
    const byCreated = timeOf(b.createdAt) - timeOf(a.createdAt);
    if (byCreated !== 0) return byCreated;
    return b.orderNo.localeCompare(a.orderNo);
  });
  return sorted[0];
}

function timeOf(iso: string | undefined): number {
  if (iso === undefined || iso === '') return 0;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** 溯源展示用的时间：优先业务「检验日期」，退回终判 / 建单时间 */
function pickInspectedAt(order: InspectionOrder): string | undefined {
  return order.inspectedDate ?? order.updatedAt ?? order.createdAt;
}

/**
 * 带出项：只取白名单内的**有实测值**的指标项（空值项不带，不猜、不补 0）；
 * 同 `itemCode` 重复时保留首项（源单内重复指标的确定性收敛）。
 */
function extractInheritableItems(items: readonly InspectionItem[]): HeatTraceInheritedItem[] {
  const seen = new Set<string>();
  const result: HeatTraceInheritedItem[] = [];

  for (const item of items) {
    if (!INHERITABLE_METRIC_CATEGORIES.has(item.metricCategory)) continue;
    if (item.measuredVal === undefined && (item.measuredText ?? '') === '') continue;
    if (item.itemCode !== '' && seen.has(item.itemCode)) continue;
    if (item.itemCode !== '') seen.add(item.itemCode);

    result.push({
      itemCode: item.itemCode,
      name: item.name,
      metricCategory: item.metricCategory,
      ...(item.measuredVal !== undefined ? { measuredVal: item.measuredVal } : {}),
      ...(item.measuredText !== undefined && item.measuredText !== ''
        ? { measuredText: item.measuredText }
        : {}),
      ...(item.unit !== undefined && item.unit !== '' ? { unit: item.unit } : {}),
    });
  }

  return result;
}

/**
 * 上游异常取「最严重的一类」（docs/47 §3.9）：
 *   已终判不合格 > 已进 MRB 未结案 > 未终判。
 * 只报一类，避免界面同时堆三行提示；同类命中单号一并给出（升序、最多 10 条）。
 *
 * 归类优先级与报告优先级**不是一回事**（容易写错的地方）：
 *   - 归类：`IN_MRB_REVIEW` 先判 —— 进 MRB 的单据本身就带着 `overallDecision = FAILED`
 *     （不合格才自动发起评审），若先按不合格归类，`UPSTREAM_UNDER_MRB` 永远报不出来；
 *   - 报告：两类同时存在时报告「不合格」这一类 —— 未结案的不合格（无出口）比
 *     已在评审中的更严重，界面只给一行时不至于看着像「已在处理」而放松警惕。
 */
function pickUpstreamWarning(
  orders: readonly InspectionOrder[]
): { code: HeatTraceWarningCode; orderNos: string[] } | undefined {
  const failed: string[] = [];
  const underMrb: string[] = [];
  const inspecting: string[] = [];

  for (const order of orders) {
    if (order.status === 'IN_MRB_REVIEW') underMrb.push(order.orderNo);
    else if (order.overallDecision === 'FAILED' || order.status === 'FAILED') failed.push(order.orderNo);
    else if (!ELIGIBLE_SOURCE_STATUSES.has(order.status)) inspecting.push(order.orderNo);
  }

  const groups: ReadonlyArray<{ code: HeatTraceWarningCode; orderNos: string[] }> = [
    { code: 'UPSTREAM_FAILED', orderNos: failed },
    { code: 'UPSTREAM_UNDER_MRB', orderNos: underMrb },
    { code: 'UPSTREAM_INSPECTING', orderNos: inspecting },
  ];

  const hit = groups.find((group) => group.orderNos.length > 0);
  if (hit === undefined) return undefined;
  return { code: hit.code, orderNos: [...hit.orderNos].sort((a, b) => a.localeCompare(b)).slice(0, 10) };
}

/** 提示文案单点组装（界面直接展示，不二次拼文案） */
function warningWithMessage(
  warning: { code: HeatTraceWarningCode; orderNos: string[] },
  carried: boolean
): HeatTraceUpstreamWarning {
  const list = warning.orderNos.join('、');
  const base =
    warning.code === 'UPSTREAM_FAILED'
      ? `该炉批号上游存在不合格记录（${list}）`
      : warning.code === 'UPSTREAM_UNDER_MRB'
        ? `该炉批号上游存在 MRB 评审未结案的记录（${list}）`
        : `该炉批号上游存在尚未终判的检验记录（${list}）`;
  const tail = carried
    ? '；本次带出的数据来自最近终判合格的记录（请核对炉次归属）'
    : warning.code === 'UPSTREAM_FAILED'
      ? '，未带出该炉数据，请按 MRB 处置结论核对'
      : warning.code === 'UPSTREAM_UNDER_MRB'
        ? '，未带出该炉数据，待 MRB 结论'
        : '，未带出该炉数据，待上游终判';
  return { code: warning.code, orderNos: warning.orderNos, message: `${base}${tail}` };
}

function emptyRecord(
  heatBatchNo: string,
  matchScope: HeatTraceMatchScope,
  warning?: { code: HeatTraceWarningCode; orderNos: string[] } | undefined
): HeatBatchTraceRecord {
  return {
    heatBatchNo,
    sourceType: 'NONE',
    matchScope,
    inheritedItems: [],
    ...(warning !== undefined ? { upstreamWarning: warningWithMessage(warning, false) } : {}),
  };
}
