import React, { useRef } from 'react';
import { QualityCertificateTemplate } from './QualityCertificateTemplate';
import { ManufacturingCertTemplate } from './ManufacturingCertTemplate';
import type { QualityCertificateData, ManufacturingCertData } from '../../lib/inspectionTypes';

interface CertificatePrintModalProps {
  isOpen: boolean;
  onClose: () => void;
  type: 'quality' | 'manufacturing';
  qualityData?: QualityCertificateData | null;
  manufacturingData?: ManufacturingCertData | null;
}

export const CertificatePrintModal: React.FC<CertificatePrintModalProps> = ({
  isOpen,
  onClose,
  type,
  qualityData,
  manufacturingData,
}) => {
  const printAreaRef = useRef<HTMLDivElement>(null);

  if (!isOpen) return null;

  // 触发浏览器原生矢量打印 (保存为 PDF)
  const handlePrint = () => {
    window.print();
  };

  // 导出单文件 HTML 格式质保书备份
  const handleDownloadHtml = () => {
    if (!printAreaRef.current) return;
    const certHtml = printAreaRef.current.innerHTML;
    const fullDoc = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${type === 'quality' ? qualityData?.certNo : manufacturingData?.certNo} 质保书</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    @media print {
      @page { size: A4 portrait; margin: 10mm; }
      body { margin: 0; background: white; }
    }
  </style>
</head>
<body class="bg-white p-4">
  ${certHtml}
</body>
</html>`;

    const blob = new Blob([fullDoc], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${type === 'quality' ? qualityData?.certNo : manufacturingData?.certNo}.html`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  /**
   * 非打印提示条内容（docs/35 §6 / §7）：
   *   1) 本单「含该分段指标、但一条实测值都没录入」的分段 —— 证书按口径不打印该分段，
   *      这里显式说出来，避免「什么都没有」被读成接口坏了；
   *   2) 企业档案未维护 —— 抬头 / 印章留白，而不是回落模板里的硬编码抬头常量。
   * 两条都只出现在**非打印区**，打印区口径不变（绝不为了好看打印未发生的检验结果）。
   */
  const missingSections =
    (type === 'quality' ? qualityData?.missingSections : manufacturingData?.missingSections) ?? [];
  const activeProfile = type === 'quality' ? qualityData?.companyProfile : manufacturingData?.companyProfile;
  const hints: string[] = [];
  if (missingSections.length > 0) {
    hints.push(`本单未录入实测值：${missingSections.join('、')} —— 证书不打印该分段`);
  }
  if (activeProfile === undefined || (activeProfile.legalName ?? '').trim() === '') {
    hints.push('企业档案未维护：证书抬头 / 印章留白（可在「主数据 · 企业档案」维护后重新生成）');
  }
  const title =
    type === 'quality'
      ? `质量保证证书预览 (${qualityData?.certNo || ''})`
      : `委外加工制造证书预览 (${manufacturingData?.certNo || ''})`;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 flex items-center justify-center p-4 print:p-0 print:bg-white print:static">
      {/* 打印专用独立样式 */}
      <style>{`
        @media print {
          body * {
            visibility: hidden;
          }
          #printable-cert-area, #printable-cert-area * {
            visibility: visible;
          }
          #printable-cert-area {
            position: absolute;
            left: 0;
            top: 0;
            width: 100% !important;
            margin: 0 !important;
            padding: 0 !important;
          }
          @page {
            size: A4 portrait;
            margin: 8mm 10mm;
          }
        }
      `}</style>

      {/* 模态框主体 */}
      <div className="bg-white rounded-lg shadow-2xl max-w-4xl w-full flex flex-col max-h-[92vh] overflow-hidden print:shadow-none print:max-w-none print:max-h-none print:rounded-none">
        {/* 工具栏 (打印时自动隐藏) */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-gray-200 bg-slate-50 print:hidden">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-blue-600 animate-pulse"></span>
            <h3 className="text-sm font-bold text-slate-800">{title}</h3>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDownloadHtml}
              className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-100 transition shadow-sm flex items-center gap-1.5"
              title="下载离线网页存档"
            >
              <svg className="w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              导出HTML备份
            </button>
            <button
              onClick={handlePrint}
              className="px-4 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded hover:bg-blue-700 transition shadow-sm flex items-center gap-1.5"
              title="在打印窗口中选择'另存为PDF'即可生成矢量PDF文件"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
              </svg>
              打印 / 导出 PDF
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-slate-600 rounded-md hover:bg-slate-200 transition"
              title="关闭"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* 非打印提示条：说清「为什么证书上有空白」，打印时自动隐藏 */}
        {hints.length > 0 && (
          <div className="px-6 py-2 bg-amber-50 border-b border-amber-200 text-[11px] text-amber-800 space-y-0.5 print:hidden">
            {hints.map((hint) => (
              <div key={hint}>提示：{hint}</div>
            ))}
          </div>
        )}
        {/* 证书展示区域 (带滚动条与A4纸底色模拟) */}
        <div className="flex-1 overflow-y-auto p-6 bg-slate-200/70 print:p-0 print:bg-white print:overflow-visible">
          <div
            id="printable-cert-area"
            ref={printAreaRef}
            className="bg-white shadow-lg mx-auto print:shadow-none print:mx-0"
          >
            {type === 'quality' && qualityData && (
              <QualityCertificateTemplate data={qualityData} />
            )}
            {type === 'manufacturing' && manufacturingData && (
              <ManufacturingCertTemplate data={manufacturingData} />
            )}
          </div>
        </div>

        {/* 底部提示 */}
        <div className="px-6 py-2.5 bg-slate-50 border-t border-slate-200 text-[11px] text-slate-500 flex justify-between items-center print:hidden">
          <span>💡 提示：点击「打印 / 导出 PDF」后，在打印机列表中选择「另存为 PDF (Save as PDF)」即可下载高清矢量 PDF 文件。</span>
          <button
            onClick={onClose}
            className="px-3 py-1 text-xs text-slate-600 hover:bg-slate-200 rounded"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
};
