import React, { useRef, useState } from 'react';
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
  const [exportingPdf, setExportingPdf] = useState(false);

  /**
   * 纸张方向（docs/51）：制造证书为横向表单，质保书为纵向表单。
   * 原生打印与 HTML 备份导出共用同一 @page 口径，两个出口不能分叉。
   */
  const pageSize = type === 'manufacturing' ? 'A4 landscape' : 'A4 portrait';

  if (!isOpen) return null;

  // 打印：调起浏览器原生打印，直接出纸
  const handlePrint = () => {
    window.print();
  };

  // 导出 PDF：客户端直接生成矢量封装的 PDF 文件并触发下载，不经打印窗口
  // （html2canvas 高清渲染证书 DOM → jsPDF 按 @page 同口径 A4 分页封装）
  const handleExportPdf = async () => {
    const el = printAreaRef.current;
    if (!el) return;
    setExportingPdf(true);
    try {
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import('html2canvas'),
        import('jspdf'),
      ]);
      // 等字体全部就绪再渲染，避免 html2canvas 用回退字体度量导致文字越界压线
      try {
        await (document as unknown as { fonts?: { ready: Promise<unknown> } }).fonts?.ready;
      } catch {
        /* 字体就绪等待失败不阻断导出 */
      }
      const canvas = await html2canvas(el, {
        scale: 2, // 2 倍采样，保证打印级清晰度
        useCORS: true,
        backgroundColor: '#ffffff',
      });

      const orientation = type === 'manufacturing' ? 'landscape' : 'portrait';
      const pdf = new jsPDF({ orientation, unit: 'mm', format: 'a4', compress: true });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const imgW = pageW;
      const imgH = (canvas.height * imgW) / canvas.width;

      if (imgH <= pageH) {
        // 单页：整页嵌入
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, imgW, imgH);
      } else {
        // 内容超一页：按页高切片分页，但切点自动对齐到整行空白的「安全位置」，
        // 避免把文字/表格行拦腰切断（导出挡字问题的根因就是硬切）
        const sliceHpx = Math.floor((canvas.width * pageH) / imgW); // 每页对应的源像素高
        const srcCtx = canvas.getContext('2d', { willReadFrequently: true });

        // 判断某一像素行是否整行空白（采样扫描 RGB，非白即视为有内容）。
        // 注意必须检查 RGB 三个通道——alpha 恒为 255，只看 alpha 会把所有行误判为空白，
        // 安全切点就永远不生效（上一版导出仍切在文字行中间的根因）。
        const rowBlank = (y: number): boolean => {
          if (!srcCtx || y < 0 || y >= canvas.height) return false;
          const d = srcCtx.getImageData(0, y, canvas.width, 1).data;
          for (let p = 0; p < canvas.width; p += 6) {
            const i = p * 4;
            if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) return false;
          }
          return true;
        };

        // 在页界上方（最多回退页高的 20%）找最近的空白行作切点；
        // 只向上回退——向下会让切片高于页高导致 PDF 底部被裁。找不到就按原界切
        const findSafeCut = (boundary: number, minCut: number): number => {
          const window = Math.floor(sliceHpx * 0.2);
          for (let off = 0; off <= window; off++) {
            const y = boundary - off;
            if (y > minCut && rowBlank(y)) return y;
          }
          return boundary;
        };

        let rendered = 0;
        let page = 0;
        while (rendered < canvas.height) {
          const boundary = rendered + sliceHpx;
          const isLast = boundary >= canvas.height;
          const cut = isLast ? canvas.height : findSafeCut(boundary, rendered + Math.floor(sliceHpx * 0.5));
          const h = cut - rendered;
          const slice = document.createElement('canvas');
          slice.width = canvas.width;
          slice.height = h;
          const ctx = slice.getContext('2d');
          if (!ctx) break;
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, slice.width, slice.height);
          ctx.drawImage(canvas, 0, rendered, canvas.width, h, 0, 0, canvas.width, h);
          if (page > 0) pdf.addPage();
          pdf.addImage(
            slice.toDataURL('image/jpeg', 0.95),
            'JPEG',
            0,
            0,
            imgW,
            (h * imgW) / canvas.width
          );
          rendered = cut;
          page += 1;
        }
      }

      const certNo = type === 'quality' ? qualityData?.certNo : manufacturingData?.certNo;
      pdf.save(`${certNo || 'certificate'}.pdf`);
    } catch (e) {
      alert('导出 PDF 失败，请重试；如持续失败可使用「导出HTML备份」或系统打印窗口另存为 PDF。');
    } finally {
      setExportingPdf(false);
    }
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
      @page { size: ${pageSize}; margin: 10mm; }
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
      ? `质量保证书预览 (${qualityData?.certNo || ''})`
      : `MANUFACTURING CERTIFICATE 预览 (${manufacturingData?.certNo || ''})`;

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
          /* 关键：质保书模板根节点是内联 width:794px，会盖过 w-full 导致打印时
             在 @page 页边距内溢出、右边被裁。这里用 !important 强制宽度跟随页面，
             留白交由模板内联 padding(14mm) 统一控制，三种导出方式口径一致 */
          #printable-cert-area > div {
            width: 100% !important;
          }
          @page {
            size: ${pageSize};
            margin: 8mm 10mm;
          }
        }
      `}</style>

      {/* 模态框主体：制造证书为A4横向，需更宽预览；质保书保持纵向A4 */}
      <div className={`bg-white rounded-lg shadow-2xl w-full flex flex-col max-h-[92vh] overflow-hidden print:shadow-none print:max-w-none print:max-h-none print:rounded-none ${type === 'manufacturing' ? 'max-w-[min(95vw,1200px)]' : 'max-w-4xl'}`}>
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
              title="调起系统打印机，直接打印证书"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
              </svg>
              打印
            </button>
            <button
              onClick={handleExportPdf}
              disabled={exportingPdf}
              className="px-4 py-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded hover:bg-emerald-100 transition shadow-sm flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
              title="直接生成 PDF 文件并下载到本地"
            >
              <svg className={`w-3.5 h-3.5 ${exportingPdf ? 'animate-pulse' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              {exportingPdf ? '生成 PDF 中...' : '导出 PDF'}
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
        {/* 证书展示区域：屏幕预览按纸张尺寸固定宽度，制造证书横向A4需横向滚动 */}
        <div className="flex-1 overflow-auto p-6 bg-slate-200/70 print:p-0 print:bg-white print:overflow-visible">
          <div
            id="printable-cert-area"
            ref={printAreaRef}
            className={
              `bg-white shadow-lg mx-auto print:shadow-none print:mx-0 ${
                type === 'manufacturing' ? 'w-[297mm]' : 'w-[210mm]'
              } print:w-full`
            }
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
          <span>💡 提示：「打印」调起打印机直接出纸；「导出 PDF」直接生成 PDF 文件并下载，无需打印窗口；「导出HTML备份」下载离线网页存档。</span>
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
