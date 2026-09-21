import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export interface MultiSelectOption {
  value: string;
  label: string;
}

interface MultiSelectProps {
  /** 字段名，用于未选择时展示占位与已选计数 */
  fieldName: string;
  options: readonly MultiSelectOption[];
  value: readonly string[];
  onChange: (next: readonly string[]) => void;
  placeholder?: string;
  widthClass?: string;
}

/**
 * 下拉多选筛选组件（原生实现，无额外依赖）。
 *
 * 语义：同一字段内选中的多个值之间是 OR 关系，由后端 SQL 的 `IN (...)` 承接；
 * 不同字段之间仍为 AND（与筛选表单的其它条件叠加）。
 */
export function MultiSelect({
  fieldName,
  options,
  value,
  onChange,
  placeholder = '全部',
  widthClass = 'w-44',
}: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点击组件外部时收起下拉
  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const toggle = (optionValue: string) => {
    onChange(
      value.includes(optionValue)
        ? value.filter((v) => v !== optionValue)
        : [...value, optionValue]
    );
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={`${widthClass} flex items-center justify-between gap-1 border border-slate-200 rounded px-2.5 py-1 text-left bg-white focus:outline-none focus:border-blue-500 ${
          open ? 'border-blue-500' : ''
        }`}
      >
        <span className={value.length > 0 ? 'text-blue-600 font-medium truncate' : 'text-slate-400 truncate'}>
          {value.length > 0 ? `${fieldName}: ${value.length} 项` : placeholder}
        </span>
        <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
      </button>

      {open && (
        <div className="absolute z-20 mt-1 bg-white border border-slate-200 rounded-md shadow-lg py-1 w-max min-w-full max-h-60 overflow-auto">
          <div className="px-3 py-1.5 text-[11px] text-slate-400 border-b border-slate-100 flex items-center justify-between gap-4">
            <span>多选（同字段内为「或」关系）</span>
            {value.length > 0 && (
              <button
                type="button"
                className="text-blue-600 hover:underline"
                onClick={() => onChange([])}
              >
                清空
              </button>
            )}
          </div>
          {options.length === 0 ? (
            <div className="px-3 py-2 text-slate-400">暂无可选值</div>
          ) : (
            options.map((option) => {
              const checked = value.includes(option.value);
              return (
                <label
                  key={option.value}
                  className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                >
                  <input
                    type="checkbox"
                    className="rounded text-blue-600 border-slate-300"
                    checked={checked}
                    onChange={() => toggle(option.value)}
                  />
                  <span className="text-slate-700">{option.label}</span>
                </label>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
