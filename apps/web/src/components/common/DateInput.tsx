import React from 'react';

export interface DateInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'placeholder'> {
  /**
   * 空值时的中文占位文案。
   *
   * Chromium 原生日期控件在空值时会自绘 `yyyy-mm-dd` 灰字（`placeholder` 属性对
   * `input[type=date]` 无效），与全站中文界面口径不一致。本组件改为自绘中文占位，
   * 并由 `apps/web/src/index.css` 隐藏原生占位；**仅在没有取值时**绘占位，
   * 聚焦（原生日历开始编辑）时立即让位给浏览器自绘画布。
   */
  placeholder?: string;
  /** 占位文案的字体尺寸类，默认 `text-xs`（与多数筛选栏控件一致） */
  placeholderClassName?: string;
  /** 尺寸类（宽度 / 栅格 / 弹性）：作用于外层包裹，控件本体恒为 `w-full` */
  wrapClassName?: string;
}

/**
 * 中文占位日期选择器：`<input type="date">` 的薄包装。
 *
 * 口径（`docs/09-界面与开源组件.md` §3）：
 * - 取值格式恒为 `YYYY-MM-DD`（原生控件与后端 `DATE_PATTERN` 同一口径），**不改写值**；
 * - 空值占位改为中文（默认「请选择日期」），全站筛选栏/表单的日期字段一律走本组件，
 *   不得再直接写 `<input type="date">`（否则又会露出 `yyyy-mm-dd`）。
 */
export function DateInput({
  placeholder = '请选择日期',
  placeholderClassName = 'text-xs',
  wrapClassName = '',
  className = '',
  value,
  ...rest
}: DateInputProps) {
  // 受控值口径与筛选表单一致：'' / undefined / null 都算「空」
  const isEmpty = value === undefined || value === null || value === '';

  return (
    <span className={`relative flex min-w-0 ${wrapClassName}`}>
      <input
        {...rest}
        type="date"
        value={value}
        className={`peer w-full min-w-0 ${className}${isEmpty ? ' lt-date-input--empty' : ''}`}
      />
      {isEmpty && (
        <span
          className={`pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-400 peer-focus:hidden ${placeholderClassName}`}
        >
          {placeholder}
        </span>
      )}
    </span>
  );
}
