/**
 * 检验指标「实测值」录入框（四个录入表单共用）
 *
 * 口径唯一真相：docs/17-检验录入界面说明与质检方案匹配口径.md §7 / TBD-05
 *
 * 为什么需要它：领域层 `evaluateInspectionItem` 对定性项（TEXT / QUALITATIVE）要求
 * **实测文本与标准语一致**（标准语按 `, ， / |` 分隔多个可接受值），不一致直接判不合格。
 * 质检员自由描述（如标准语「无裂纹」却填「表面无肉眼可见裂纹」）就会被判不合格，且看不出原因。
 * 所以这里做两件事：
 *   1) 把标准语里的可选值拆成候选值（datalist），让质检员**选**而不是**猜**；
 *   2) 标准语只给了一个可接受值时，直接在输入框下方说清"自由描述会被判不合格"。
 *
 * 数值型（NUMERIC）指标保持普通输入框，不做任何额外干预。
 */
import React, { useId } from 'react';
import { isQualitativeRow, qualitativeOptionsOf } from '../../lib/planMatch';
import type { PlanIndicatorRow } from '../../lib/planMatch';

interface IndicatorActualFieldProps {
  row: PlanIndicatorRow;
  onValueChange: (value: string) => void;
  /** 只读回看：不提示录入技巧（回看时不改历史值） */
  readOnly?: boolean;
  /** 各表原有的输入框样式（宽度 / 边框 / 字号由调用方决定，保持界面一致） */
  className?: string;
  /** 自定义占位文案；缺省时按"免检 / 定性 / 数值"给默认文案 */
  placeholder?: string;
}

export const IndicatorActualField: React.FC<IndicatorActualFieldProps> = ({
  row,
  onValueChange,
  readOnly = false,
  className = '',
  placeholder,
}) => {
  const listId = useId();
  const qualitative = isQualitativeRow(row);
  const options = qualitative
    ? qualitativeOptionsOf(row.standard, row.planItem.acceptableValues)
    : [];
  const exempt = row.isExempt;

  const hint =
    placeholder ??
    (exempt ? '已标记不解检(免检)' : qualitative ? `须与标准语一致，如 ${options[0] ?? ''}` : '实测值');

  const input = (
    <input
      type="text"
      readOnly={readOnly}
      disabled={exempt}
      list={options.length > 0 ? listId : undefined}
      placeholder={hint}
      value={exempt ? '' : row.actual}
      onChange={(e) => onValueChange(e.target.value)}
      className={className}
    />
  );

  if (!qualitative) return input;

  return (
    <>
      {input}
      {options.length > 0 && (
        <datalist id={listId}>
          {options.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      )}
      {!readOnly && (
        <div className="mt-1 text-[10px] leading-snug text-amber-700">
          {options.length <= 1 ? (
            <>
              定性项：标准语只给出一个可接受值「{options[0] ?? '—'}」，
              <strong>自由描述会被判不合格</strong>，请照标准语原文填写。
            </>
          ) : (
            <>定性项可选值：{options.join(' / ')}（必须与其中之一一致）</>
          )}
        </div>
      )}
    </>
  );
};
