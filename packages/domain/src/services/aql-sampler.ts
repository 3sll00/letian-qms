/**
 * GB/T 2828.1 (ISO 2859-1) 抽样标准算法服务 (calculateAQLSampling)
 * 纯内存领域计算算法
 */

export type InspectionLevel = 'S-1' | 'S-2' | 'S-3' | 'S-4' | 'I' | 'II' | 'III';

/**
 * GB/T 2828.1 样本量字码表（正常检验二次/一次抽样，通用检验水平 II 为标准紧固件默认水平）
 */
interface BatchRange {
  min: number;
  max: number;
  codeLetters: Record<InspectionLevel, string>;
}

const BATCH_SIZE_CODE_TABLE: BatchRange[] = [
  { min: 1, max: 8, codeLetters: { 'S-1': 'A', 'S-2': 'A', 'S-3': 'A', 'S-4': 'A', 'I': 'A', 'II': 'A', 'III': 'B' } },
  { min: 9, max: 15, codeLetters: { 'S-1': 'A', 'S-2': 'A', 'S-3': 'A', 'S-4': 'A', 'I': 'A', 'II': 'B', 'III': 'C' } },
  { min: 16, max: 25, codeLetters: { 'S-1': 'A', 'S-2': 'A', 'S-3': 'B', 'S-4': 'B', 'I': 'B', 'II': 'C', 'III': 'D' } },
  { min: 26, max: 50, codeLetters: { 'S-1': 'A', 'S-2': 'B', 'S-3': 'B', 'S-4': 'C', 'I': 'C', 'II': 'D', 'III': 'E' } },
  { min: 51, max: 90, codeLetters: { 'S-1': 'B', 'S-2': 'B', 'S-3': 'C', 'S-4': 'C', 'I': 'C', 'II': 'E', 'III': 'F' } },
  { min: 91, max: 150, codeLetters: { 'S-1': 'B', 'S-2': 'B', 'S-3': 'C', 'S-4': 'D', 'I': 'D', 'II': 'F', 'III': 'G' } },
  { min: 151, max: 280, codeLetters: { 'S-1': 'B', 'S-2': 'C', 'S-3': 'D', 'S-4': 'E', 'I': 'E', 'II': 'G', 'III': 'H' } },
  { min: 281, max: 500, codeLetters: { 'S-1': 'B', 'S-2': 'C', 'S-3': 'D', 'S-4': 'E', 'I': 'F', 'II': 'H', 'III': 'J' } },
  { min: 501, max: 1200, codeLetters: { 'S-1': 'C', 'S-2': 'C', 'S-3': 'E', 'S-4': 'F', 'I': 'G', 'II': 'J', 'III': 'K' } },
  { min: 1201, max: 3200, codeLetters: { 'S-1': 'C', 'S-2': 'D', 'S-3': 'E', 'S-4': 'G', 'I': 'H', 'II': 'K', 'III': 'L' } },
  { min: 3201, max: 10000, codeLetters: { 'S-1': 'C', 'S-2': 'D', 'S-3': 'F', 'S-4': 'H', 'I': 'J', 'II': 'L', 'III': 'M' } },
  { min: 10001, max: 35000, codeLetters: { 'S-1': 'C', 'S-2': 'D', 'S-3': 'F', 'S-4': 'J', 'I': 'K', 'II': 'M', 'III': 'N' } },
  { min: 35001, max: 150000, codeLetters: { 'S-1': 'D', 'S-2': 'E', 'S-3': 'G', 'S-4': 'J', 'I': 'L', 'II': 'N', 'III': 'P' } },
  { min: 150001, max: 500000, codeLetters: { 'S-1': 'D', 'S-2': 'E', 'S-3': 'G', 'S-4': 'K', 'I': 'M', 'II': 'P', 'III': 'Q' } },
  { min: 500001, max: Infinity, codeLetters: { 'S-1': 'D', 'S-2': 'E', 'S-3': 'H', 'S-4': 'K', 'I': 'N', 'II': 'Q', 'III': 'R' } },
];

/**
 * 样本量字码对应的标准抽样数量
 */
const SAMPLE_SIZE_TABLE: Record<string, number> = {
  A: 2,
  B: 3,
  C: 5,
  D: 8,
  E: 13,
  F: 20,
  G: 32,
  H: 50,
  J: 80,
  K: 125,
  L: 200,
  M: 315,
  N: 500,
  P: 800,
  Q: 1250,
  R: 2000,
};

/**
 * AQL (接收质量限) 与字码对应的 [Ac (接收数), Re (拒收数)] 表
 * 紧固件行业常用基准：AQL 1.0, AQL 1.5, AQL 2.5, AQL 4.0
 *
 * 注意：当前仅收录字码 A~M。字码 N/P/Q/R（大批量，检验水平 II 下批量 >35000）
 * 及表外 AQL 值的判定数暂未收录 —— 依据 GB/T 2828.1-2012 表 2-A 补录前，
 * calculateAQLSampling 对这类组合显式抛错（见下方 AQL_COMBINATION_UNSUPPORTED），
 * 严禁静默回退为零缺陷放行，避免大批量批被错误接收。
 */
const AQL_DECISION_TABLE: Record<string, Record<number, [number, number]>> = {
  A: { 1.0: [0, 1], 1.5: [0, 1], 2.5: [0, 1], 4.0: [0, 1] },
  B: { 1.0: [0, 1], 1.5: [0, 1], 2.5: [0, 1], 4.0: [0, 1] },
  C: { 1.0: [0, 1], 1.5: [0, 1], 2.5: [0, 1], 4.0: [0, 1] },
  D: { 1.0: [0, 1], 1.5: [0, 1], 2.5: [0, 1], 4.0: [1, 2] },
  E: { 1.0: [0, 1], 1.5: [0, 1], 2.5: [1, 2], 4.0: [1, 2] },
  F: { 1.0: [0, 1], 1.5: [1, 2], 2.5: [1, 2], 4.0: [2, 3] },
  G: { 1.0: [1, 2], 1.5: [1, 2], 2.5: [2, 3], 4.0: [3, 4] },
  H: { 1.0: [1, 2], 1.5: [2, 3], 2.5: [3, 4], 4.0: [5, 6] },
  J: { 1.0: [2, 3], 1.5: [3, 4], 2.5: [5, 6], 4.0: [7, 8] },
  K: { 1.0: [3, 4], 1.5: [5, 6], 2.5: [7, 8], 4.0: [10, 11] },
  L: { 1.0: [5, 6], 1.5: [7, 8], 2.5: [10, 11], 4.0: [14, 15] },
  M: { 1.0: [7, 8], 1.5: [10, 11], 2.5: [14, 15], 4.0: [21, 22] },
};

export interface SamplingResult {
  codeLetter: string;
  sampleSize: number;
  ac: number; // 接收数 (Acceptance Number)
  re: number; // 拒收数 (Rejection Number)
}

/**
 * 计算 AQL 抽样方案
 */
export function calculateAQLSampling(params: {
  batchQty: number;
  inspectionLevel?: InspectionLevel;
  aql?: number;
}): SamplingResult {
  const { batchQty, inspectionLevel = 'II', aql = 1.5 } = params;

  if (batchQty <= 0) {
    throw new Error(`AQL_INVALID_BATCH_QTY: 批量数必须大于 0，当前为 [${batchQty}]`);
  }

  // 1. 查找样本量字码
  const range = BATCH_SIZE_CODE_TABLE.find(r => batchQty >= r.min && batchQty <= r.max);
  if (!range) {
    throw new Error(`AQL_BATCH_RANGE_UNSUPPORTED: 批量 [${batchQty}] 超出样本量字码表覆盖范围`);
  }
  const codeLetter = range.codeLetters[inspectionLevel];

  // 2. 查找样本数量（若批量极小则不超过总批量）
  const nominalSample = SAMPLE_SIZE_TABLE[codeLetter];
  if (nominalSample === undefined) {
    throw new Error(`AQL_CODE_LETTER_UNSUPPORTED: 检验水平 [${inspectionLevel}] 下的样本量字码 [${codeLetter}] 未收录样本量表`);
  }
  const sampleSize = Math.min(batchQty, nominalSample);

  // 3. 查找判定数
  const aqlRow = AQL_DECISION_TABLE[codeLetter];
  const pair = aqlRow?.[aql];

  if (!pair) {
    throw new Error(
      `AQL_COMBINATION_UNSUPPORTED: 当前判定表未收录 样本量字码 [${codeLetter}] 与 AQL [${aql}] 的抽样判定数，请依据 GB/T 2828.1-2012 表 2-A 补录后再行判定`
    );
  }

  const [ac, re] = pair;

  return {
    codeLetter,
    sampleSize,
    ac,
    re,
  };
}
