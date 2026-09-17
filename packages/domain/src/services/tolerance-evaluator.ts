import { InspectionItem, InspectionItemDecision } from '@letian/contracts';

/**
 * 检验项实测值公差判定服务 (evaluateInspectionItem)
 * 纯内存无状态领域算法服务
 * 
 * 核心安全规则：
 * 1. 结果必为三态：'PASSED' | 'FAILED' | 'PENDING'；
 * 2. 数值型指标：必须同时具备 nominalValue、measuredVal 以及公差带（upperTolerance/lowerTolerance）；
 *    超出 [nominalValue - lowerTolerance, nominalValue + upperTolerance] 范围判为 FAILED，在区间内判为 PASSED；
 * 3. 文本/定性型指标：必须录入 measuredText 并与 standardText 比对，缺失或不匹配严禁默认放行；
 * 4. 无法匹配或实测数据未录入时，必须明确返回 'PENDING'，严禁静默返回 'PASSED'。
 */
export function evaluateInspectionItem(item: Pick<InspectionItem, 
  'dataType' | 'measuredVal' | 'measuredText' | 'nominalValue' | 'upperTolerance' | 'lowerTolerance' | 'standardText'
>): InspectionItemDecision {
  const { dataType, measuredVal, measuredText, nominalValue, upperTolerance, lowerTolerance, standardText } = item;

  // 1. 数值型判定
  if (dataType === 'NUMERIC') {
    if (measuredVal === undefined || measuredVal === null || isNaN(measuredVal)) {
      return 'PENDING';
    }

    if (nominalValue === undefined || nominalValue === null || isNaN(nominalValue)) {
      return 'PENDING'; // 缺少标准基准，无法评定
    }

    const upper = upperTolerance ?? 0;
    const lower = lowerTolerance ?? 0;

    const maxLimit = nominalValue + upper;
    const minLimit = nominalValue - lower;

    // 浮点数精度微调防护 (Epsilon: 1e-9)
    const EPS = 1e-9;
    if (measuredVal > maxLimit + EPS || measuredVal < minLimit - EPS) {
      return 'FAILED';
    }

    return 'PASSED';
  }

  // 2. 文本与定性判定
  if (dataType === 'TEXT' || dataType === 'QUALITATIVE') {
    if (!measuredText || measuredText.trim() === '') {
      return 'PENDING';
    }

    if (!standardText || standardText.trim() === '') {
      return 'PENDING'; // 缺少标准判定语，挂起待确认
    }

    // 标准化文本匹配（去除首尾空白并忽略大小写对比）
    const normalizedMeasured = measuredText.trim().toLowerCase();
    const normalizedStandard = standardText.trim().toLowerCase();

    // 支持多选标准值匹配（如标准语中允许逗号分隔 "合格,OK,Pass"）
    const standardOptions = normalizedStandard.split(/[,，/|]/).map(s => s.trim());

    if (standardOptions.includes(normalizedMeasured)) {
      return 'PASSED';
    }

    return 'FAILED';
  }

  return 'PENDING';
}
