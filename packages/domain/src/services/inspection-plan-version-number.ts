/**
 * 质检方案版本号 (version_no) 升位规则 —— 领域内唯一口径
 *
 * 规则：取现有版本号中**数值最大**的一条为基线，**递增其最后一段**，保留原前缀写法与段数。
 *   - `['v2.4', 'v2.5']` → `v2.6`
 *   - `['V1.0']`          → `V1.1`
 *   - `['v1.0.0']`        → `v1.0.1`
 *   - `['v9']`            → `v10`
 *   - 无法解析的版本号（如人工写的 `草稿A`）不参与比较；一个都解析不出来时从 `V1.0` 起
 *   - 数值相等时取**段数更多**的那条为基线（`v1.0.0` 优先于 `v1.0`），保证结果与输入顺序无关
 *   - 结果与现有版本号**撞号**（忽略大小写与首尾空白）时继续递增，直到不撞号
 *
 * 为什么"递增最后一段"而不是固定递增 minor：库中既有形态是两段（`v2.4` / `V1.0`），
 * 递增最后一段与业务上"升一个小版本"的直觉一致（`v2.4` 之后就是 `v2.5`，与种子数据同形）；
 * 三段形态（`v1.0.0`）则自然落到 patch 位，不需要额外分支。
 *
 * 口径来源：版本号与方案编码 (plan_code) 采取**同一条**"服务端取号"策略 ——
 * 调用方省略即由服务端升位，显式传入按原值使用（见 `inspection-plan-number.ts` 与
 * `docs/17-检验录入界面说明与质检方案匹配口径.md` §7.5.7 / §7.5.8）。
 */

/** 可解析的版本号形态：可选 `v/V` 前缀 + 1~3 段数字（段间以 `.` 分隔） */
const VERSION_NO_PATTERN = /^\s*([vV]?)(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/;

/** 撞号递增的防御上限：正常业务不可能连续占用 1000 个版本号，超出即视为脏数据并显式报错 */
const MAX_BUMP_ATTEMPTS = 1000;

interface ParsedVersionNo {
  /** 前缀写法（`v` / `V` / 空串）原样保留，避免把 `V1.0` 改写成 `v1.1` */
  prefix: string;
  /** 数值化后的各段（长度 1~3） */
  segments: number[];
}

function parseVersionNo(value: string): ParsedVersionNo | undefined {
  const matched = VERSION_NO_PATTERN.exec(value);
  if (!matched) {
    return undefined;
  }
  const segments = [matched[2], matched[3], matched[4]]
    .filter((segment): segment is string => segment !== undefined)
    .map((segment) => Number(segment));
  return { prefix: matched[1] ?? '', segments };
}

/** 段数不同时短的一方按 0 补位比较（`v2` < `v2.4`） */
function compareSegments(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function formatVersionNo(prefix: string, segments: number[]): string {
  return `${prefix}${segments.join('.')}`;
}

/** 递增最后一段（返回新数组，不修改入参） */
function bumpLastSegment(segments: number[]): number[] {
  const next = [...segments];
  next[next.length - 1] = (next[next.length - 1] ?? 0) + 1;
  return next;
}

/**
 * 计算下一个版本号：`existing` 为该方案**全部**版本号（顺序无关）。
 *
 * 注意：本函数只负责编号规则，不校验"是否允许升版"——
 * 「同一方案已有草稿时禁止再造草稿」（`PLAN_DRAFT_ALREADY_EXISTS`）由聚合根 `InspectionPlan` 守门。
 */
export function nextInspectionPlanVersionNo(existing: readonly string[]): string {
  if (!Array.isArray(existing)) {
    throw new Error('PLAN_VERSION_NO_INPUT_INVALID: 现有版本号必须是数组');
  }

  const taken = new Set<string>();
  const parsed: ParsedVersionNo[] = [];
  for (const value of existing) {
    if (typeof value !== 'string') {
      continue;
    }
    const key = value.trim().toLowerCase();
    if (key !== '') {
      taken.add(key);
    }
    const candidate = parseVersionNo(value);
    if (candidate) {
      parsed.push(candidate);
    }
  }

  // 无任何可解析版本号时以 V1.0 为起点（仍参与下面的撞号递增）
  let base: ParsedVersionNo =
    parsed.length > 0
      ? parsed.reduce((best, current) => {
          const diff = compareSegments(current.segments, best.segments);
          // 数值相等时取段数更多者：否则基线取决于输入顺序，同一批版本号会算出不同结果
          if (diff !== 0) {
            return diff > 0 ? current : best;
          }
          return current.segments.length > best.segments.length ? current : best;
        })
      : { prefix: 'V', segments: [1, 0] };

  let candidate = formatVersionNo(base.prefix, base.segments);
  for (let attempt = 0; attempt < MAX_BUMP_ATTEMPTS && taken.has(candidate.toLowerCase()); attempt += 1) {
    base = { prefix: base.prefix, segments: bumpLastSegment(base.segments) };
    candidate = formatVersionNo(base.prefix, base.segments);
  }

  if (taken.has(candidate.toLowerCase())) {
    throw new Error(
      `PLAN_VERSION_NO_EXHAUSTED: 现有版本号已占用过多连续编号，无法自动升位 [${candidate}]`
    );
  }
  return candidate;
}
