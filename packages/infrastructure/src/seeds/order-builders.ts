/**
 * 演示 / 测试检验单的构造工具：**方案指标项 → 快照指标**、**快照指标 → 工单实测项**。
 *
 * 为什么单独成文件（而不是留在调用方里）：
 * 同一套「快照即证据」的落库形状必须只有**一份**实现，当前有两个调用方共用它：
 *   1) `seeds/runner.ts`             —— `pnpm db:seed`：重建整库演示数据；
 *   2) `scripts/demo-inspections.ts` —— `pnpm db:demo:repair`：为**已落库**的检验单补齐快照 / 指标行。
 * 两处各写一份映射，迟早出现"种子库合规、补齐库不合规"的口径漂移。
 *
 * 口径依据：
 *   - docs/17-检验录入界面说明与质检方案匹配口径.md §7.3「快照即证据」
 *   - docs/46-演示检验单方案快照与指标行补齐设计.md
 */
import type {
  DataType,
  InspectionItem,
  InspectionOrder,
  InspectionPlanItem,
  MetricCategory,
  OverallDecision,
  PlanSnapshot,
} from '@letian/contracts';
import { SAMPLING, type ItemResultKind } from './data.js';

/**
 * 定性指标"不合格"时的实测文本。
 * 方案的可接受值清单通常只列"合格"，故取清单外的文本，保证领域判标落到 FAILED。
 */
const QUALITATIVE_FAILED_TEXT = '不符合';

/** 保留 3 位小数，让演示实测值整洁可读 */
export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * 指标来源的结构化最小集合。
 *
 * 演示数据集里的 `SeedMetric` 与**库中方案版本行的指标项**（契约 `InspectionPlanItem`）都能满足它，
 * 因此两个调用方共用同一套映射实现，不会出现"两套快照字段口径"。
 */
export interface MetricSource {
  itemCode: string;
  name: string;
  dataType: DataType;
  metricCategory: MetricCategory;
  standardText?: string | undefined;
  acceptableValues?: readonly string[] | undefined;
  nominalValue?: number | undefined;
  upperTolerance?: number | undefined;
  lowerTolerance?: number | undefined;
  sampleSize?: number | undefined;
  unit?: string | undefined;
  measurementTool?: string | undefined;
  /** 必检标记；缺省按"必检"处理（与契约 InspectionPlanItemSchema.isMandatory 的默认值同口径） */
  isMandatory?: boolean | undefined;
}

/** 快照来源的版本行最小集合：演示数据集的 `SeedPlanVersion` 与库中方案版本 DTO 均可满足 */
export interface SnapshotVersionSource {
  /** 版本行 UUID：本库"一行 = 一个版本"，故它同时充当契约里的 planId 与 versionId */
  id: string | undefined;
  versionNo: string;
  items: readonly MetricSource[];
  samplingScheme?: string | undefined;
  aqlLevel?: string | undefined;
  strictness?: string | undefined;
}

/**
 * 数值判定基准。演示工单的实测值只对数值型指标生成（`toOrderItem` 已先按 dataType 分流），
 * 故这里的 `?? 0` 只是为可选字段收窄类型，正常路径不会命中默认值。
 */
function numericBasis(metric: MetricSource): {
  nominalValue: number;
  upperTolerance: number;
} {
  return {
    nominalValue: metric.nominalValue ?? 0,
    upperTolerance: metric.upperTolerance ?? 0,
  };
}

/** 公差内的实测值（取上公差的 35% 作为偏移量） */
function withinTolerance(metric: MetricSource): number {
  const basis = numericBasis(metric);
  return round3(basis.nominalValue + basis.upperTolerance * 0.35);
}

/** 公差外的实测值（超出上公差 50%） */
function outOfTolerance(metric: MetricSource): number {
  const basis = numericBasis(metric);
  const overshoot = basis.upperTolerance > 0 ? basis.upperTolerance * 0.5 : 0.01;
  return round3(basis.nominalValue + basis.upperTolerance + overshoot);
}

/** 指标模板 -> 方案快照指标（契约 InspectionPlanItem） */
export function toPlanItem(metric: MetricSource, seq: number): InspectionPlanItem {
  return {
    seq,
    itemCode: metric.itemCode,
    name: metric.name,
    dataType: metric.dataType,
    metricCategory: metric.metricCategory,
    isMandatory: metric.isMandatory ?? true,
    // 定性指标的判标清单（TBD-06 唯一权威）：此前种子路径漏传，播种后清单会丢失
    ...(metric.standardText !== undefined ? { standardText: metric.standardText } : {}),
    ...(metric.acceptableValues !== undefined
      ? { acceptableValues: [...metric.acceptableValues] }
      : {}),
    ...(metric.nominalValue !== undefined ? { nominalValue: metric.nominalValue } : {}),
    ...(metric.upperTolerance !== undefined ? { upperTolerance: metric.upperTolerance } : {}),
    ...(metric.lowerTolerance !== undefined ? { lowerTolerance: metric.lowerTolerance } : {}),
    ...(metric.sampleSize !== undefined ? { sampleSize: metric.sampleSize } : {}),
    ...(metric.unit !== undefined ? { unit: metric.unit } : {}),
    ...(metric.measurementTool !== undefined ? { measurementTool: metric.measurementTool } : {}),
  };
}

/** 指标模板 -> 工单实测项（契约 InspectionItem），按形态填充 result / measuredVal */
export function toOrderItem(
  metric: MetricSource,
  seq: number,
  kind: ItemResultKind
): InspectionItem {
  const base: InspectionItem = {
    seq,
    itemCode: metric.itemCode,
    name: metric.name,
    dataType: metric.dataType,
    metricCategory: metric.metricCategory,
    result: 'PENDING',
    isExempt: false,
    isManuallyModified: false,
    ...(metric.standardText !== undefined ? { standardText: metric.standardText } : {}),
    ...(metric.nominalValue !== undefined ? { nominalValue: metric.nominalValue } : {}),
    ...(metric.upperTolerance !== undefined ? { upperTolerance: metric.upperTolerance } : {}),
    ...(metric.lowerTolerance !== undefined ? { lowerTolerance: metric.lowerTolerance } : {}),
    ...(metric.sampleSize !== undefined ? { sampleSize: metric.sampleSize } : {}),
    ...(metric.unit !== undefined ? { unit: metric.unit } : {}),
  };

  if (kind === 'PENDING') {
    // 未检验：保留 PENDING 且不写实测值
    return base;
  }

  // 定性 / 文本型指标没有可数值化的实测值：只有方案给出可接受值清单时才取清单首项；
  // 清单缺失（只写了标准语）时**不编造**，保持 PENDING 交人工判定（docs/46 §3 D4）。
  if (metric.dataType !== 'NUMERIC') {
    const accepted = metric.acceptableValues?.[0];
    if (accepted === undefined) {
      return base;
    }
    const failed = kind !== 'ALL_PASSED' && seq === 1;
    const measuredText = failed ? QUALITATIVE_FAILED_TEXT : accepted;
    return {
      ...base,
      measuredText,
      result: failed ? 'FAILED' : 'PASSED',
      ...(failed
        ? { defectReason: `${metric.name} 实测「${measuredText}」不在可接受值清单内` }
        : {}),
    };
  }

  // 只让第 1 项偏离公差，其余项合格，保证 "FAILED -> 至少 1 项 FAILED"
  const failed = kind !== 'ALL_PASSED' && seq === 1;
  const measuredVal = failed ? outOfTolerance(metric) : withinTolerance(metric);

  return {
    ...base,
    measuredVal,
    result: failed ? 'FAILED' : 'PASSED',
    ...(failed
      ? { defectReason: `${metric.name} 实测 ${measuredVal}${metric.unit ?? ''} 超出公差上限` }
      : {}),
  };
}

/** 组装工单实测项列表 */
export function buildOrderItems(metrics: readonly MetricSource[], kind: ItemResultKind): InspectionItem[] {
  return metrics.map((metric, index) => toOrderItem(metric, index + 1, kind));
}

/** 组装完整的方案版本快照（planId / versionId 均指向该版本行 UUID） */
export function buildSnapshot(
  plan: { planCode: string; planName: string },
  version: SnapshotVersionSource,
  snapshotAt: string
): PlanSnapshot {
  if (version.id === undefined || version.id === '') {
    throw new Error(
      'SNAPSHOT_REQUIRES_VERSION_ID: 方案版本行缺少 UUID，无法固化快照（契约要求 planId / versionId 为 UUID）'
    );
  }
  return {
    planId: version.id,
    planCode: plan.planCode,
    planName: plan.planName,
    versionId: version.id,
    versionNo: version.versionNo,
    samplingScheme: version.samplingScheme ?? SAMPLING.samplingScheme,
    aqlLevel: version.aqlLevel ?? SAMPLING.aqlLevel,
    strictness: version.strictness ?? SAMPLING.strictness,
    items: version.items.map((metric, index) => toPlanItem(metric, index + 1)),
    snapshotAt,
  };
}

/** 检验单由方案/版本/判定形态派生的字段；所有演示工单统一经此入口生成 */
export interface DemoOrderFieldBuildInput {
  sampleQty: number;
  itemKind: ItemResultKind;
  plan: { planCode: string; planName: string };
  version: SnapshotVersionSource;
  snapshotAt: string;
}

/**
 * 组装检验单的关键派生字段：方案版本绑定、完整快照、逐指标实测行、合格/不合格数量。
 *
 * 业务描述字段（批次、物料、供应商、工序、委外单号等）仍由调用方按各自场景提供；
 * 但凡是演示/测试检验单，`planVersionId`、`planSnapshot`、`items` 与数量四件套只允许走这里，
 * 避免 `db:seed` 与 `db:demo:*` 各自拼出不同形状的“能保存、但不能检视”的检验单。
 */
export function buildInspectionOrderFields(
  input: DemoOrderFieldBuildInput
): Pick<InspectionOrder, 'passQty' | 'failQty' | 'planVersionId' | 'planSnapshot' | 'items'> {
  if (input.version.id === undefined || input.version.id === '') {
    throw new Error(
      'SEED_ORDER_REQUIRES_VERSION_ID: 检验单必须绑定真实方案版本行 UUID，不能裸 SQL 写入空快照'
    );
  }
  const { passQty, failQty } = deriveQty(input.sampleQty, input.itemKind);
  return {
    passQty,
    failQty,
    planVersionId: input.version.id,
    planSnapshot: buildSnapshot(input.plan, input.version, input.snapshotAt),
    items: buildOrderItems(input.version.items, input.itemKind),
  };
}

/** 依据工单判定形态推导合格 / 不合格数量 */
export function deriveQty(
  sampleQty: number,
  kind: ItemResultKind
): { passQty: number; failQty: number } {
  if (kind === 'PENDING') {
    return { passQty: 0, failQty: 0 };
  }
  if (kind === 'ALL_PASSED') {
    return { passQty: sampleQty, failQty: 0 };
  }
  const failQty = Math.max(1, Math.round(sampleQty * 0.125));
  return { passQty: sampleQty - failQty, failQty };
}

/**
 * 工单综合判定 -> 演示实测项形态。
 * 未终判一律 PENDING（不伪造实测值）；让步接收沿用"有不合格项"的形态（与种子库口径一致）。
 */
export function itemResultKindOf(decision: OverallDecision | null | undefined): ItemResultKind {
  if (decision === 'PASSED') return 'ALL_PASSED';
  if (decision === 'FAILED') return 'HAS_FAILED';
  if (decision === 'CONCESSION') return 'CONCESSION';
  return 'PENDING';
}
