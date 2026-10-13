import React, { useEffect, useState } from 'react';
import { FileText, CheckCircle2 } from 'lucide-react';
import type { CertTemplateKind } from '../../lib/inspectionTypes';

interface CertTemplatePickerModalProps {
  isOpen: boolean;
  /** 推荐模板（按环节惯例预选中，操作员仍可改选；绝不替他静默决定） */
  recommended?: CertTemplateKind;
  onConfirm: (template: CertTemplateKind) => void;
  onCancel: () => void;
}

/**
 * 模板缩略示意：用 CSS 骨架重现「纵向三列字段网格 + 三段表」与「横向 14 列主表」的版面轮廓，
 * 让操作员在选模板时看到的是版式本身，不是抽象名称。
 */
const QualityThumbnail: React.FC = () => (
  <div className="w-24 h-32 bg-white border border-slate-300 rounded-sm shadow-sm p-1.5 flex flex-col gap-1">
    <div className="h-1.5 w-4/5 mx-auto bg-slate-300 rounded" />
    <div className="h-1 w-3/5 mx-auto bg-slate-200 rounded" />
    <div className="grid grid-cols-3 gap-0.5 mt-0.5">
      {Array.from({ length: 12 }).map((_, i) => (
        <div key={i} className="h-1 bg-slate-200 rounded" />
      ))}
    </div>
    {[0, 1, 2].map((section) => (
      <div key={section} className="border border-slate-200 mt-0.5">
        <div className="h-1 w-1/2 bg-slate-300 m-0.5 rounded" />
        <div className="h-1 bg-slate-100 mx-0.5 mb-0.5 rounded" />
        <div className="h-1 bg-slate-100 mx-0.5 mb-0.5 rounded" />
      </div>
    ))}
  </div>
);

const ManufacturingThumbnail: React.FC = () => (
  <div className="w-40 h-28 bg-white border border-slate-300 rounded-sm shadow-sm p-1.5 flex flex-col gap-1">
    <div className="h-1.5 w-2/3 bg-slate-300 rounded" />
    <div className="h-1 w-1/2 bg-slate-200 rounded" />
    <div className="border border-slate-300 mt-0.5">
      <div className="h-2.5 bg-slate-200 flex items-center justify-center">
        <div className="h-1 w-1/3 bg-slate-400 rounded" />
      </div>
      <div className="grid grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-4 border-r last:border-r-0 border-slate-200 p-0.5 space-y-0.5">
            <div className="h-0.5 bg-slate-200 rounded" />
            <div className="h-0.5 bg-slate-200 rounded" />
          </div>
        ))}
      </div>
    </div>
    <div className="flex-1 border border-slate-300 grid grid-cols-7 divide-x divide-slate-200">
      {Array.from({ length: 7 }).map((_, i) => (
        <div key={i} className="flex flex-col divide-y divide-slate-100">
          <div className="h-1.5 bg-slate-300" />
          {Array.from({ length: 6 }).map((_, j) => (
            <div key={j} className="h-1.5" />
          ))}
        </div>
      ))}
    </div>
  </div>
);

const TEMPLATES: readonly {
  kind: CertTemplateKind;
  title: string;
  subtitle: string;
  desc: string;
  orientation: string;
  Thumbnail: React.FC;
}[] = [
  {
    kind: 'QUALITY',
    title: '质量保证书',
    subtitle: 'CERTIFICATE OF INSPECTION（A4 纵向）',
    desc: '三列字段网格 + 尺寸检验 / 机械性能 / 化学成分 三段落表，含授权签名与 EN10204 声明。',
    orientation: '纵向打印',
    Thumbnail: QualityThumbnail,
  },
  {
    kind: 'MANUFACTURING',
    title: 'MANUFACTURING CERTIFICATE',
    subtitle: '制造证书（A4 横向）',
    desc: '交货单参考 / 工单号 / 交货点表头 + 14 列产品检验主表（涂层 / 固化 / 镀锌 / DFT / 硬度 / 附着力 / 盐雾）。',
    orientation: '横向打印',
    Thumbnail: ManufacturingThumbnail,
  },
];

/**
 * 证书模板选择弹窗（docs/51）：填写检验内容**之前**由操作员选定打印版式，
 * 选择随检验单落 `cert_template`，历史单始终按建单时选定的版式出证。
 */
export const CertTemplatePickerModal: React.FC<CertTemplatePickerModalProps> = ({
  isOpen,
  recommended,
  onConfirm,
  onCancel,
}) => {
  const [selected, setSelected] = useState<CertTemplateKind | null>(null);

  useEffect(() => {
    if (isOpen) setSelected(recommended ?? null);
  }, [isOpen, recommended]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-[min(96vw,1180px)] max-h-[92vh] flex flex-col overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-3.5 border-b border-slate-100 bg-slate-50/70 shrink-0">
          <FileText className="w-4 h-4 text-blue-600" />
          <h3 className="text-sm font-bold text-slate-800">选择证书模板</h3>
          <span className="text-[11px] text-slate-400">
            模板随本单保存，检验完成后按所选版式出证
          </span>
        </div>

        <div className="p-5 grid grid-cols-1 xl:grid-cols-2 gap-4 overflow-y-auto">
          {TEMPLATES.map(({ kind, title, subtitle, desc, orientation, Thumbnail }) => {
            const active = selected === kind;
            return (
              <button
                key={kind}
                type="button"
                onClick={() => setSelected(kind)}
                className={`relative text-left rounded-xl border-2 p-4 transition-all ${
                  active
                    ? 'border-blue-500 bg-blue-50/40 shadow-sm'
                    : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                }`}
              >
                {active && (
                  <CheckCircle2 className="absolute top-3 right-3 w-4 h-4 text-blue-600" />
                )}
                <div className="flex items-start gap-5">
                  <div className="shrink-0 w-40 flex items-center justify-center">
                    <Thumbnail />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold text-slate-800 leading-snug break-words pr-5">{title}</div>
                    <div className="text-xs text-slate-500 mt-1 break-words">{subtitle}</div>
                    <div className="text-xs text-slate-600 mt-2 leading-relaxed break-words">{desc}</div>
                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
                        {orientation}
                      </span>
                      {recommended === kind && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-600 font-medium">
                          本环节推荐
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/50 flex justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-slate-100"
          >
            取消
          </button>
          <button
            type="button"
            disabled={selected === null}
            onClick={() => selected !== null && onConfirm(selected)}
            className="px-4 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed"
          >
            确认模板，开始录入
          </button>
        </div>
      </div>
    </div>
  );
};
