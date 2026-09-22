import React from 'react';
import type { QualityCertificateData } from '../../lib/inspectionTypes';

interface QualityCertificateTemplateProps {
  data: QualityCertificateData;
}

/**
 * 模板一：《质量保证证书》
 * 1:1 精确复刻标准工业质量证明书排版
 * 适用场景：来料检验 (IQC)、过程检验 (IPQC)、出货检验 (OQC)
 */
export const QualityCertificateTemplate: React.FC<QualityCertificateTemplateProps> = ({ data }) => {
  const elements = data.chemicalComposition?.elements || [];
  const mechanicalItems = data.mechanicalProperties?.items || [];
  const dimensions = data.dimensions || [];

  return (
    <div className="bg-white text-black p-8 font-sans w-full max-w-[800px] mx-auto text-xs leading-tight print:p-0 print:max-w-none print:w-full print:text-[11px] select-text">
      {/* 头部公司信息与标题 */}
      <div className="border-b-2 border-black pb-3 mb-3 text-center relative">
        <h1 className="text-xl font-bold tracking-wider mb-1">{data.companyProfile?.legalName ?? ''}</h1>
        <h2 className="text-sm font-semibold tracking-wide text-gray-700 uppercase mb-2">
          {data.companyProfile?.legalNameEn ?? ''}
        </h2>
        <div className="inline-block bg-slate-900 text-white px-4 py-1 rounded text-sm font-bold tracking-widest uppercase">
          {data.inspectionTypeLabel || '质量保证证书 QUALITY CERTIFICATE'}
        </div>
        <div className="absolute right-0 top-0 text-right text-[11px] text-gray-600 space-y-0.5">
          <div><span className="font-semibold text-black">编号/No:</span> {data.certNo}</div>
          <div><span className="font-semibold text-black">日期/Date:</span> {data.issueDate}</div>
        </div>
      </div>

      {/* 第一部分：基本信息表格 */}
      <table className="w-full border-collapse border border-black mb-3">
        <tbody>
          <tr>
            <td className="border border-black bg-gray-100 p-1.5 font-bold w-24">订货单位/客户</td>
            <td className="border border-black p-1.5">{data.customer}</td>
            <td className="border border-black bg-gray-100 p-1.5 font-bold w-24">供货单位/产地</td>
            <td className="border border-black p-1.5">{data.supplier}</td>
          </tr>
          <tr>
            <td className="border border-black bg-gray-100 p-1.5 font-bold">合同/订单号</td>
            <td className="border border-black p-1.5">{data.contractNo}</td>
            <td className="border border-black bg-gray-100 p-1.5 font-bold">执行标准</td>
            <td className="border border-black p-1.5">{data.standard}</td>
          </tr>
          <tr>
            <td className="border border-black bg-gray-100 p-1.5 font-bold">产品名称</td>
            <td className="border border-black p-1.5 font-semibold">{data.productName}</td>
            <td className="border border-black bg-gray-100 p-1.5 font-bold">规格型号</td>
            <td className="border border-black p-1.5 font-mono font-semibold">{data.specification}</td>
          </tr>
          <tr>
            <td className="border border-black bg-gray-100 p-1.5 font-bold">材质/钢号</td>
            <td className="border border-black p-1.5 font-mono">{data.steelGrade}</td>
            <td className="border border-black bg-gray-100 p-1.5 font-bold">性能等级</td>
            <td className="border border-black p-1.5">{data.performanceGrade}</td>
          </tr>
          <tr>
            <td className="border border-black bg-gray-100 p-1.5 font-bold">炉号 / 批号</td>
            <td className="border border-black p-1.5 font-mono">
              {[data.heatNo, data.batchNo].filter((text) => text !== undefined && text !== '').join(' / ')}
            </td>
            <td className="border border-black bg-gray-100 p-1.5 font-bold">数量 / 重量</td>
            <td className="border border-black p-1.5">{data.quantity}</td>
          </tr>
          <tr>
            <td className="border border-black bg-gray-100 p-1.5 font-bold">表面处理</td>
            <td className="border border-black p-1.5">{data.surfaceFinish}</td>
            <td className="border border-black bg-gray-100 p-1.5 font-bold">检验类别</td>
            <td className="border border-black p-1.5">
              <span className="inline-block px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-semibold border border-blue-200">
                {data.inspectionType}
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      {/* 第二部分：化学成分分析表格（无真实实测项即整段不渲染，docs/34 §5.1） */}
      {elements.length > 0 && (
      <div className="mb-3">
        <div className="font-bold text-xs bg-gray-800 text-white px-2 py-1 flex justify-between items-center">
          <span>一、化学成分分析 (Chemical Composition %)</span>
          <span className="text-[10px] font-normal text-gray-300">光谱直读仪分析检测</span>
        </div>
        <table className="w-full border-collapse border border-black text-center text-[11px]">
          <thead>
            <tr className="bg-gray-100">
              <th className="border border-black p-1 w-20">元素 Element</th>
              {elements.map((e) => (
                <th key={e.element} className="border border-black p-1 font-bold font-mono">
                  {e.element}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border border-black p-1 font-bold bg-gray-50">标准值 Standard</td>
              {elements.map((e) => (
                <td key={e.element} className="border border-black p-1 font-mono text-[10px]">
                  {e.standard}
                </td>
              ))}
            </tr>
            <tr className="font-semibold bg-white">
              <td className="border border-black p-1 font-bold bg-gray-50">实测值 Actual</td>
              {elements.map((e) => (
                <td key={e.element} className="border border-black p-1 font-mono text-blue-900">
                  {e.actual}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      )}

      {/* 第三部分：机械物理性能（无真实实测项即整段不渲染） */}
      {mechanicalItems.length > 0 && (
      <div className="mb-3">
        <div className="font-bold text-xs bg-gray-800 text-white px-2 py-1 flex justify-between items-center">
          <span>二、机械及物理力学性能 (Mechanical & Physical Properties)</span>
          <span className="text-[10px] font-normal text-gray-300">万能材料试验机 / 洛氏硬度计</span>
        </div>
        <table className="w-full border-collapse border border-black text-[11px]">
          <thead>
            <tr className="bg-gray-100 text-center">
              <th className="border border-black p-1.5 w-1/3">检验项目 (Test Item)</th>
              <th className="border border-black p-1.5 w-1/4">标准要求 (Standard)</th>
              <th className="border border-black p-1.5 w-1/4">实测结果 (Actual Result)</th>
              <th className="border border-black p-1.5 w-16">判定 (Decision)</th>
            </tr>
          </thead>
          <tbody>
            {mechanicalItems.map((item, idx) => (
              <tr key={idx} className="text-center hover:bg-gray-50">
                <td className="border border-black p-1.5 text-left font-medium">{item.name}</td>
                <td className="border border-black p-1.5 font-mono">{item.standard}</td>
                <td className="border border-black p-1.5 font-mono font-semibold text-blue-900">{item.actual}</td>
                <td className="border border-black p-1.5">
                  <span className="text-green-700 font-bold">{item.result}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}

      {/* 第四部分：尺寸公差与几何特征检验（无真实实测项即整段不渲染） */}
      {dimensions.length > 0 && (
      <div className="mb-3">
        <div className="font-bold text-xs bg-gray-800 text-white px-2 py-1 flex justify-between items-center">
          <span>三、尺寸公差与几何特征检验 (Dimensional & Visual Inspection)</span>
          <span className="text-[10px] font-normal text-gray-300">游标卡尺 / 螺纹量规 / 影像仪</span>
        </div>
        <table className="w-full border-collapse border border-black text-[11px]">
          <thead>
            <tr className="bg-gray-100 text-center">
              <th className="border border-black p-1.5 w-1/3">测量项目 (Dimension)</th>
              <th className="border border-black p-1.5 w-1/4">技术规范 (Tolerance)</th>
              <th className="border border-black p-1.5 w-1/4">实测数据 (Measured)</th>
              <th className="border border-black p-1.5 w-16">判定 (Decision)</th>
            </tr>
          </thead>
          <tbody>
            {dimensions.map((dim, idx) => (
              <tr key={idx} className="text-center hover:bg-gray-50">
                <td className="border border-black p-1.5 text-left font-medium">{dim.name}</td>
                <td className="border border-black p-1.5 font-mono">{dim.standard}</td>
                <td className="border border-black p-1.5 font-mono font-semibold text-blue-900">{dim.actual}</td>
                <td className="border border-black p-1.5">
                  <span className="text-green-700 font-bold">{dim.result}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}

      {/* 第五部分：综合判定与签发签署 */}
      <div className="border border-black p-2.5 bg-gray-50 mb-3 relative">
        <div className="flex justify-between items-start">
          <div className="space-y-1 w-2/3">
            <div className="font-bold text-xs flex items-center gap-2">
              <span>综合检验判定结论 / Conclusion:</span>
              <span className="px-3 py-0.5 bg-green-600 text-white font-bold rounded text-xs tracking-wider">
                {data.overallDecision}
              </span>
            </div>
            <div className="text-[10px] text-gray-700 leading-normal">
              {data.notes}
            </div>
          </div>

          {/* 检验印章模拟 */}
          <div className="border-2 border-red-600 rounded-full w-24 h-24 flex flex-col items-center justify-center text-red-600 font-bold text-[9px] leading-tight rotate-[-12deg] opacity-85 select-none pointer-events-none absolute right-6 -top-2">
            <div className="text-[10px] border-b border-red-500 pb-0.5">{data.companyProfile?.qualityStamp ?? ''}</div>
            <div>{data.overallDecision}</div>
            <div className="text-[8px] font-mono mt-0.5">{data.issueDate}</div>
          </div>
        </div>
      </div>

      {/* 签字栏 */}
      <div className="grid grid-cols-4 gap-2 pt-2 border-t border-black text-center text-[11px]">
        <div>
          <span className="text-gray-600 block">检验员 / Inspector:</span>
          <span className="font-semibold text-black mt-1 block">{data.inspector}</span>
        </div>
        <div>
          <span className="text-gray-600 block">校对复核 / Reviewer:</span>
          <span className="font-semibold text-black mt-1 block">{data.reviewer}</span>
        </div>
        <div>
          <span className="text-gray-600 block">批准人 / Approver:</span>
          <span className="font-semibold text-black mt-1 block">{data.approver}</span>
        </div>
        <div>
          <span className="text-gray-600 block">签发盖章 / Seal:</span>
          <span className="text-gray-400 mt-1 block">【检验专用章】</span>
        </div>
      </div>

      <div className="text-center text-[9px] text-gray-500 mt-3 print:mt-2">
        * 本证书为工厂质量保证凭证，复印件未经本公司书面盖章确认无效。 (Page 1 of 1)
      </div>
    </div>
  );
};
