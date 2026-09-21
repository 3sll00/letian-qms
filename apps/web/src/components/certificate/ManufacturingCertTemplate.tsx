import React from 'react';
import type { ManufacturingCertData } from '../../lib/inspectionTypes';

interface ManufacturingCertTemplateProps {
  data: ManufacturingCertData;
}

/**
 * 模板二：《MANUFACTURING CERT》
 * 1:1 还原中英文对照版委外加工制造证明书 (Inspection Certificate according to EN 10204 3.1)
 * 适用场景：委外检验 (Outsource)
 */
export const ManufacturingCertTemplate: React.FC<ManufacturingCertTemplateProps> = ({ data }) => {
  const testResults = data.testResults || {};


  return (
    <div className="bg-white text-black p-8 font-sans w-full max-w-[800px] mx-auto text-xs leading-tight print:p-0 print:max-w-none print:w-full print:text-[11px] select-text">
      {/* 头部企业与证书名称 */}
      <div className="border-b-2 border-black pb-3 mb-3 text-center relative">
        <div className="text-[10px] tracking-widest text-gray-500 uppercase font-mono">
          LETIAN QUALITY MANAGEMENT SYSTEM &bull; SUBCONTRACTING DIVISION
        </div>
        <h1 className="text-xl font-bold tracking-wider mt-1">NINGBO LETIAN FASTENERS CO., LTD.</h1>
        <h2 className="text-sm font-semibold text-gray-800">宁波乐天紧固件制造有限公司</h2>
        <div className="mt-2 inline-block border border-black px-4 py-1 font-bold text-sm bg-gray-100 tracking-wider">
          MANUFACTURING &amp; OUTSOURCE INSPECTION CERTIFICATE (EN 10204 3.1)
        </div>
        <div className="absolute right-0 top-0 text-right text-[11px] text-gray-600 space-y-0.5">
          <div><span className="font-semibold text-black">Cert. No:</span> <span className="font-mono">{data.certNo}</span></div>
          <div><span className="font-semibold text-black">Issue Date:</span> <span className="font-mono">{data.dateOfIssue}</span></div>
        </div>
      </div>

      {/* 第一部分：订单与外协信息 */}
      <div className="border border-black mb-3">
        <div className="bg-gray-800 text-white font-bold px-2 py-1 text-[11px] tracking-wide">
          1. GENERAL ORDER &amp; SUBCONTRACT INFORMATION (订单与委外信息)
        </div>
        <table className="w-full border-collapse text-[11px]">
          <tbody>
            <tr className="border-b border-black">
              <td className="w-36 bg-gray-50 p-1.5 font-semibold border-r border-black">Customer (客户名称)</td>
              <td className="p-1.5 border-r border-black">{data.customerName}</td>
              <td className="w-36 bg-gray-50 p-1.5 font-semibold border-r border-black">Purchase Order (采购单号)</td>
              <td className="p-1.5 font-mono">{data.purchaseOrderNo}</td>
            </tr>
            <tr className="border-b border-black">
              <td className="bg-gray-50 p-1.5 font-semibold border-r border-black">Subcontractor (委外加工商)</td>
              <td className="p-1.5 border-r border-black font-medium text-blue-900">{data.subcontractor}</td>
              <td className="bg-gray-50 p-1.5 font-semibold border-r border-black">Subcontract No. (外协单号)</td>
              <td className="p-1.5 font-mono">{data.subcontractNo}</td>
            </tr>
            <tr className="border-b border-black">
              <td className="bg-gray-50 p-1.5 font-semibold border-r border-black">Process Name (委外工序)</td>
              <td className="p-1.5 border-r border-black font-semibold">{data.processName}</td>
              <td className="bg-gray-50 p-1.5 font-semibold border-r border-black">Specification (执行规范)</td>
              <td className="p-1.5 font-mono">{data.standardsApplied}</td>
            </tr>
            <tr className="border-b border-black">
              <td className="bg-gray-50 p-1.5 font-semibold border-r border-black">Item Description (物料描述)</td>
              <td className="p-1.5 border-r border-black font-semibold">{data.productDescription}</td>
              <td className="bg-gray-50 p-1.5 font-semibold border-r border-black">Size / Dimension (规格尺寸)</td>
              <td className="p-1.5 font-mono font-bold">{data.dimension}</td>
            </tr>
            <tr>
              <td className="bg-gray-50 p-1.5 font-semibold border-r border-black">Heat / Batch No. (炉号/批号)</td>
              <td className="p-1.5 border-r border-black font-mono">{data.heatNo} / {data.batchNo}</td>
              <td className="bg-gray-50 p-1.5 font-semibold border-r border-black">Quantity &amp; Weight (数量与重量)</td>
              <td className="p-1.5 font-mono">{data.quantityPcs} PCS / {data.weightKg} KG</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* 第二部分：委外关键理化与工艺特性检验 (表面处理 / 热处理 / 机械特性) */}
      <div className="border border-black mb-3">
        <div className="bg-gray-800 text-white font-bold px-2 py-1 text-[11px] flex justify-between items-center">
          <span>2. OUTSOURCE TECHNICAL INSPECTION &amp; TEST RESULTS (委外技术检验结果)</span>
          <span className="text-[10px] font-normal text-gray-300">Coating &bull; Heat Treatment &bull; Mechanical</span>
        </div>
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr className="bg-gray-100 text-center border-b border-black">
              <th className="border-r border-black p-1.5 w-1/4">Inspection Item (检验项目)</th>
              <th className="border-r border-black p-1.5 w-1/3">Specified Requirement (规范标准要求)</th>
              <th className="border-r border-black p-1.5 w-1/4">Actual Test Result (实测检验结果)</th>
              <th className="p-1.5 w-16">Decision</th>
            </tr>
          </thead>
          <tbody>
            {testResults.coatingThickness && (
              <tr className="border-b border-black">
                <td className="border-r border-black p-1.5 font-medium bg-gray-50">
                  Coating Thickness (镀层/涂层厚度)
                </td>
                <td className="border-r border-black p-1.5 font-mono">{testResults.coatingThickness.standard}</td>
                <td className="border-r border-black p-1.5 font-mono font-bold text-blue-900">
                  {testResults.coatingThickness.actual}
                  {testResults.coatingThickness.points && (
                    <div className="text-[10px] text-gray-500 font-normal mt-0.5">
                      Points: {testResults.coatingThickness.points.join(', ')} μm
                    </div>
                  )}
                </td>
                <td className="p-1.5 text-center font-bold text-green-700">PASS</td>
              </tr>
            )}

            {testResults.saltSprayHours && (
              <tr className="border-b border-black">
                <td className="border-r border-black p-1.5 font-medium bg-gray-50">
                  Salt Spray Test (中性盐雾 NSS)
                </td>
                <td className="border-r border-black p-1.5 font-mono">{testResults.saltSprayHours.standard}</td>
                <td className="border-r border-black p-1.5 font-mono font-bold text-blue-900">
                  {testResults.saltSprayHours.actual}
                </td>
                <td className="p-1.5 text-center font-bold text-green-700">PASS</td>
              </tr>
            )}

            {testResults.adhesion && (
              <tr className="border-b border-black">
                <td className="border-r border-black p-1.5 font-medium bg-gray-50">
                  Coating Adhesion (涂层附着力)
                </td>
                <td className="border-r border-black p-1.5 font-mono">{testResults.adhesion.standard}</td>
                <td className="border-r border-black p-1.5 font-mono font-bold text-blue-900">
                  {testResults.adhesion.actual}
                </td>
                <td className="p-1.5 text-center font-bold text-green-700">PASS</td>
              </tr>
            )}

            {testResults.deEmbrittlement && (
              <tr className="border-b border-black">
                <td className="border-r border-black p-1.5 font-medium bg-gray-50">
                  De-embrittlement (去氢脆烘烤处理)
                </td>
                <td className="border-r border-black p-1.5 font-mono">{testResults.deEmbrittlement.standard}</td>
                <td className="border-r border-black p-1.5 font-mono font-bold text-blue-900">
                  {testResults.deEmbrittlement.actual}
                </td>
                <td className="p-1.5 text-center font-bold text-green-700">PASS</td>
              </tr>
            )}

            {testResults.surfaceHardness && (
              <tr className="border-b border-black">
                <td className="border-r border-black p-1.5 font-medium bg-gray-50">
                  Surface Hardness (表面硬度)
                </td>
                <td className="border-r border-black p-1.5 font-mono">{testResults.surfaceHardness.standard}</td>
                <td className="border-r border-black p-1.5 font-mono font-bold text-blue-900">
                  {testResults.surfaceHardness.actual}
                </td>
                <td className="p-1.5 text-center font-bold text-green-700">PASS</td>
              </tr>
            )}

            {testResults.coreHardness && (
              <tr className="border-b border-black">
                <td className="border-r border-black p-1.5 font-medium bg-gray-50">
                  Core Hardness (心部硬度)
                </td>
                <td className="border-r border-black p-1.5 font-mono">{testResults.coreHardness.standard}</td>
                <td className="border-r border-black p-1.5 font-mono font-bold text-blue-900">
                  {testResults.coreHardness.actual}
                </td>
                <td className="p-1.5 text-center font-bold text-green-700">PASS</td>
              </tr>
            )}

            {testResults.caseDepth && (
              <tr className="border-b border-black">
                <td className="border-r border-black p-1.5 font-medium bg-gray-50">
                  Effective Case Depth (有效硬化层深度)
                </td>
                <td className="border-r border-black p-1.5 font-mono">{testResults.caseDepth.standard}</td>
                <td className="border-r border-black p-1.5 font-mono font-bold text-blue-900">
                  {testResults.caseDepth.actual}
                </td>
                <td className="p-1.5 text-center font-bold text-green-700">PASS</td>
              </tr>
            )}

            {testResults.torqueStrength && (
              <tr className="border-b border-black">
                <td className="border-r border-black p-1.5 font-medium bg-gray-50">
                  Torque Strength (破坏扭矩试验)
                </td>
                <td className="border-r border-black p-1.5 font-mono">{testResults.torqueStrength.standard}</td>
                <td className="border-r border-black p-1.5 font-mono font-bold text-blue-900">
                  {testResults.torqueStrength.actual}
                </td>
                <td className="p-1.5 text-center font-bold text-green-700">PASS</td>
              </tr>
            )}

            <tr>
              <td className="border-r border-black p-1.5 font-medium bg-gray-50">
                Visual &amp; Workmanship (外观与做工)
              </td>
              <td className="border-r border-black p-1.5 font-mono">No blister, uniform color, clean thread</td>
              <td className="border-r border-black p-1.5 font-mono font-bold text-blue-900">Conformed (良好无缺陷)</td>
              <td className="p-1.5 text-center font-bold text-green-700">{data.visualInspection}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* 第三部分：合规性声明与印章 */}
      <div className="border border-black p-3 bg-gray-50 mb-3 relative">
        <div className="w-2/3 space-y-1.5">
          <div className="font-bold text-xs uppercase tracking-wider text-gray-900">
            3. CERTIFICATION &amp; COMPLIANCE STATEMENT (合格声明)
          </div>
          <p className="text-[10px] text-gray-700 leading-normal text-justify">
            {data.complianceStatement}
          </p>
          {data.remarks && (
            <div className="text-[10px] text-gray-600 mt-1">
              <span className="font-semibold">Remarks (外协备注):</span> {data.remarks}
            </div>
          )}
        </div>

        {/* 委外检验印章 */}
        <div className="border-2 border-blue-800 rounded-full w-24 h-24 flex flex-col items-center justify-center text-blue-800 font-bold text-[8.5px] leading-tight rotate-[-8deg] opacity-80 select-none pointer-events-none absolute right-6 -top-2">
          <div className="text-[9px] border-b border-blue-700 pb-0.5 uppercase tracking-wide">LETIAN QA</div>
          <div>SUBCONTRACT</div>
          <div className="text-[8px] font-mono mt-0.5">{data.dateOfIssue}</div>
          <div className="text-[8px] font-bold text-green-700">PASSED 3.1</div>
        </div>
      </div>

      {/* 第四部分：签发与签字人 */}
      <div className="grid grid-cols-2 gap-4 border border-black p-3 text-[11px]">
        <div>
          <span className="text-gray-500 block text-[10px]">Inspected by Subcontract Inspector (委外检验员):</span>
          <div className="font-semibold text-black mt-2 font-mono">{data.inspectorName}</div>
          <div className="text-[9px] text-gray-400 mt-0.5">Signature &amp; Date: ____________________</div>
        </div>
        <div>
          <span className="text-gray-500 block text-[10px]">Verified by QA Manager (质量经理审批):</span>
          <div className="font-semibold text-black mt-2 font-mono">{data.qaManagerName}</div>
          <div className="text-[9px] text-gray-400 mt-0.5">Signature &amp; Date: ____________________</div>
        </div>
      </div>

      <div className="text-center text-[9px] text-gray-400 mt-2">
        Ningbo Letian Fasteners Co., Ltd. &bull; Quality Department &bull; EN 10204 Type 3.1 Certified Document
      </div>
    </div>
  );
};
