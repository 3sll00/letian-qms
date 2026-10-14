import React from 'react';
import type { QualityCertificateData } from '../../lib/inspectionTypes';
import letianWordmark from '../../assets/certificate/letian-wordmark.png';
import letianTriangle from '../../assets/certificate/letian-triangle.png';

interface QualityCertificateTemplateProps {
  data: QualityCertificateData;
}

/** 信息网格单元格：CN 标签 + 值 一行，EN 标签下一行（扫描件三列字段区版式） */
const GridCell: React.FC<{ cn: string; en: string; value?: string }> = ({ cn, en, value }) => (
  <div className="min-h-[26px] break-words">
    <div className="break-words">
      <span className="font-semibold">{cn}：</span>
      <span className="break-words">{value ?? ''}</span>
    </div>
    <div className="font-semibold break-words">{en}</div>
  </div>
);

/** 判定字样 → 扫描件双语写法：合格 → 合格(Qualified)；未判定即空串留白 */
function qualifiedText(result: string | undefined): string {
  if (result === '合格') return '合格(Qualified)';
  if (result === '不合格') return '不合格(Unqualified)';
  return '';
}

/** 尺寸 / 机械性能分段（扫描件同构：分段标题行 + 四列子表头 + 数据行） */
const SectionTable: React.FC<{
  title: string;
  standard: string;
  rows: readonly { name: string; standard: string; actual: string; result?: string }[];
  /** 与上一段内容的间距（让表尾双线与下一段分开，不重叠） */
  topGap?: number;
}> = ({ title, standard, rows, topGap = 0 }) => (
  <div className="break-words" style={{ marginTop: topGap }}>
    <div className="flex flex-wrap justify-between items-baseline gap-x-4 gap-y-1 pb-0.5">
      <span className="font-bold break-words">{title}</span>
      <span className="font-semibold break-words">
        测试方法(SAMPLE STANDARD)：{standard}
      </span>
    </div>
    <table className="w-full border-collapse mt-0.5 break-words">
      <thead>
        <tr className="font-semibold text-center">
          <td className="text-left pl-2 break-words">测试项目</td>
          <td className="break-words">标准值</td>
          <td className="break-words">实测值</td>
          <td className="break-words">测试判定</td>
        </tr>
        <tr className="font-semibold text-center border-b-2 border-gray-300">
          <td className="text-left pl-2 break-words">(CHARACTERISTICS)</td>
          <td className="break-words">(SPECIFICATION)</td>
          <td className="break-words">(ACTUAL RESULT)</td>
          <td className="break-words">(SAMPLE DETERMINANT)</td>
        </tr>
      </thead>
      <tbody>
        {/* 末行底线加在 td 上（tr 边框在 html2canvas/打印路径下不可靠） */}
        {rows.map((row, idx) => {
          const isLast = idx === rows.length - 1;
          const lastCls = isLast ? 'border-b border-black' : '';
          return (
            <tr key={idx}>
              <td className={`pl-2 py-0.5 break-words ${lastCls}`}>{row.name}</td>
              <td className={`text-center py-0.5 break-words ${lastCls}`}>{row.standard}</td>
              <td className={`text-center py-0.5 break-words ${lastCls}`}>{row.actual}</td>
              <td className={`text-center py-0.5 break-words ${lastCls}`}>{qualifiedText(row.result)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
    {/* 表尾第二条横线：与表格底线（td border-b）留出间距，形成清晰双线 */}
    <div style={{ borderTop: '1px solid black', marginTop: '3px' }} />
  </div>
);

/**
 * 模板B：《质量保证书 CERTIFICATE OF INSPECTION》纵向检验证书（docs/51）
 *
 * 1:1 复刻扫描件版式（浙江东明检测实验室式样）：
 *   居中实验室抬头 → 双语标题 → 三列无边框字段网格（客户/订单/报告/地址/项目号/实发数量/
 *   产品号/标准/材质/制造日期/品名/批号/抽样日期/印记/炉号/检测日期/规格/表面处理/制造商/
 *   抽样计划）→ 尺寸检验 / 机械性能 / 化学成分 三段落表 → 授权/验证/盖章/日期签字行 →
 *   EN10204 声明与备注 → Tel/Fax/Web/E-mail/ADD 联系页脚。
 *
 * 企业抬头 / 联系方式取自企业档案主数据；所有内容格未录入即留白，绝不放演示值。
 */
export const QualityCertificateTemplate: React.FC<QualityCertificateTemplateProps> = ({ data }) => {
  const profile = data.companyProfile;
  const elements = data.chemicalComposition?.elements || [];
  const mechanicalItems = data.mechanicalProperties?.items || [];
  const dimensions = data.dimensions || [];

  return (
    <div
      className="bg-white text-black mx-auto font-sans select-text print:w-full"
      style={{ width: '794px', maxWidth: '100%', fontSize: '10px', lineHeight: 1.75, padding: '10mm', position: 'relative' }}
    >
      {/* 左上角：三角图标 + 字标（按用户标注图定位：图形居红圈位、字标居红框位，纵向堆叠） */}
      <img
        src={letianTriangle}
        alt="LETIAN FASTENERS logo"
        style={{ position: 'absolute', top: '23px', left: '84px', width: '48px', height: '48px', objectFit: 'contain' }}
      />
      <img
        src={letianWordmark}
        alt="LETIAN FASTENERS"
        style={{ position: 'absolute', top: '75px', left: '42px', height: '16px', width: 'auto' }}
      />
      {/* 实验室抬头（企业档案；未维护即留白） */}
      <div className="text-center">
        <div className="font-bold" style={{ fontSize: '13px' }}>
          {profile?.legalName !== undefined && profile.legalName !== ''
            ? `${profile.legalName}检测实验室`
            : ''}
        </div>
        <div
          className="font-bold inline-block border-b border-black px-4"
          style={{ fontSize: '11.5px' }}
        >
          {profile?.legalNameEn !== undefined && profile.legalNameEn !== ''
            ? `${profile.legalNameEn} TEST LABORATORY`
            : ''}
        </div>
        <div className="font-bold mt-0.5" style={{ fontSize: '12.5px' }}>
          质量保证书
        </div>
        <div className="font-semibold" style={{ fontSize: '10.5px' }}>
          (CERTIFICATE OF INSPECTION)
        </div>
      </div>

      {/* 三列字段网格（无边框，CN 标签 + 值 / EN 标签） */}
      <div className="grid grid-cols-3 gap-x-6 mt-2 px-2 break-words">
        <div className="space-y-0.5 min-w-0">
          <GridCell cn="客户名称" en="PURCHASER" value={data.customer} />
          <GridCell cn="客户地址" en="ADDRESS" value={data.customerAddress} />
          <GridCell cn="项目号" en="CUST P/N" value={data.projectNo} />
          <GridCell cn="制造日期" en="MFR. DATE" value={data.manufactureDate} />
          <GridCell cn="抽样日期" en="Sampling Date" value={data.samplingDate} />
          <GridCell cn="检测日期" en="Test Date" value={data.inspectionDate} />
          <GridCell cn="制造商" en="MFR" value={data.manufacturer ?? profile?.legalName ?? ''} />
        </div>
        <div className="space-y-0.5 min-w-0">
          <GridCell cn="订单号码" en="PO#NO" value={data.orderNo ?? data.contractNo} />
          <GridCell cn="短项目号" en="ITEM NO" value={data.shortProjectNo} />
          <GridCell cn="标准" en="COMMODITY" value={data.standard} />
          <GridCell cn="品名" en="Product Name" value={data.productName} />
          <GridCell cn="印记" en="MARKING" value={data.marking} />
          <GridCell cn="规格" en="SIZE" value={data.specification ?? data.spec} />
          <GridCell cn="抽样计划" en="Sample Plan spec" value={data.samplingPlan} />
        </div>
        <div className="space-y-0.5 min-w-0">
          <GridCell cn="报告编号" en="Report Code" value={data.certNo} />
          <GridCell cn="实发数量" en="SHIP QTY" value={data.shippedQty ?? data.quantity} />
          <GridCell cn="材质" en="MATERIAL TYPE" value={data.steelGrade ?? data.materialGrade} />
          <GridCell cn="批号" en="LOT NO" value={data.batchNo} />
          <GridCell cn="炉号" en="HEAT NO" value={data.heatNo} />
          <GridCell cn="表面处理" en="Surface" value={data.surfaceFinish} />
        </div>
      </div>

      {/* 双横线分隔（两条线留出间距，不重叠） */}
      <div className="mt-2" style={{ height: '4px', borderTop: '1px solid black', borderBottom: '1px solid black' }} />

      {/* 尺寸检验（无数据则不显示整段） */}
      {dimensions.length > 0 && (
        <SectionTable
          title="尺寸检验 DIMENSIONAL INSPECTIONS 单位(mm)"
          standard={data.standard ?? ''}
          rows={dimensions.map((d) => ({ name: d.name, standard: d.standard, actual: d.actual, result: d.result }))}
        />
      )}

      {/* 机械性能（无数据则不显示整段） */}
      {mechanicalItems.length > 0 && (
        <SectionTable
          title="机械性能 MECHANICAL PROPERTIES"
          standard={data.standard ?? ''}
          rows={mechanicalItems}
          topGap={6}
        />
      )}

      {/* 化学成分（无元素数据则不显示整段） */}
      {elements.length > 0 && (
        <div className="break-words" style={{ marginTop: 6 }}>
          <div className="flex flex-wrap justify-between items-baseline gap-x-4 border-b border-gray-400 py-0.5">
            <span className="font-bold break-words">
              化学成分 CHEMICAL COMPOSITION%{' '}
              <span className="font-normal">(除标明范围外，其余均为最大值. Maximum Value Or Range.)</span>
            </span>
          </div>
          <table className="w-full border-collapse mt-0.5 break-words">
            <thead>
              {/* 单行表头：炉号HeatNumber | C Si Mn P S Ni Cr... | 测试判定/(SAMPLE DETERMINANT) 两行 */}
              <tr className="font-semibold text-center">
                <td className="text-left pl-2 break-words">炉号HeatNumber</td>
                {elements.map((e) => (
                  <td key={e.element} className="break-words">{e.element}</td>
                ))}
                <td className="break-words">
                  测试判定
                  <br />
                  (SAMPLE DETERMINANT)
                </td>
              </tr>
            </thead>
            <tbody>
              {/* 第二行：标准值Specification + 各元素标准值；第三行：炉号 + 各元素实测值；判定列纵向合并 */}
              <tr>
                <td className="pl-2 py-0.5 break-words">标准值Specification</td>
                {elements.map((e) => (
                  <td key={e.element} className="text-center py-0.5 break-words">
                    {e.standard}
                  </td>
                ))}
                <td rowSpan={2} className="text-center py-0.5 border-b border-black align-middle break-words">
                  合格(Qualified)
                </td>
              </tr>
              <tr>
                <td className="pl-2 py-0.5 border-b border-black break-words">{data.heatNo}</td>
                {elements.map((e) => (
                  <td key={e.element} className="text-center py-0.5 border-b border-black break-words">
                    {e.actual}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
          {/* 表尾第二条横线：与表格底线（td border-b）留出间距，形成清晰双线 */}
          <div style={{ borderTop: '1px solid black', marginTop: '3px' }} />
        </div>
      )}

      {/* 签字行：Authorization / Verification / Sample Stamp / Date */}
      <div className="grid grid-cols-4 gap-4 mt-8 px-6 text-center">
        <div>
          <div className="border-b border-black h-9 pb-1 font-semibold flex items-end justify-center">
            {data.approver ?? ''}
          </div>
          <div className="mt-1">Authorization</div>
        </div>
        <div>
          <div className="border-b border-black h-9 pb-1 font-semibold flex items-end justify-center">
            {data.reviewer ?? data.inspector ?? ''}
          </div>
          <div className="mt-1">Verification</div>
        </div>
        <div>
          <div className="border-b border-black h-9 pb-1 font-semibold flex items-end justify-center">
            {profile?.qualityStamp ?? ''}
          </div>
          <div className="mt-1">Sample Stamp</div>
        </div>
        <div>
          <div className="border-b border-black h-9 pb-1 font-semibold flex items-end justify-center">
            {data.issueDate ?? ''}
          </div>
          <div className="mt-1">Date</div>
        </div>
      </div>

      {/* 声明与备注（扫描件固定条款原文保留） */}
      <div className="mt-2 px-2 break-words" style={{ fontSize: '9.5px' }}>
        <div>This Lot fit the demands of EN10204 3.1</div>
        <div>声明：该报告除非获得实验室书面同意，证书或报告不得摘录、复制，但全部复制除外</div>
        <div>
          INSPECTION RESULT: SAMPLES TESTED CONFORM TO ALL OF SPECIFICATION AS ABOVE THIS REPORT
          MUST NOT BE REPRODUCED EXCEPT IN FULL. WHENEVER TESTING DISCREPANCIES ARE DETECTED OR
          DEPARTURES FROM DOCUMENTED POLICIES AND PROCEDURES OCCUR, THEY WILL BE SHOWN IN REMARK.
        </div>
        <div className="mt-1">
          <span className="font-semibold">备注 IN REMARK.</span>
          {/* 备注内容 = 检验单填写的备注（inspectionNotes / cert_fields.remarks），不预置任何固定文案 */}
          {data.remarks ?? data.notes ?? ''}
        </div>
      </div>

      {/* 联系页脚（企业档案主数据；无值即留白） */}
      <div className="border-t border-black mt-2 pt-1 px-2 break-words" style={{ fontSize: '9.5px' }}>
        <div>
          <span className="font-semibold">Tel: </span>
          {profile?.phone ?? ''}
          <span className="font-semibold ml-6">E-mail: </span>
          {profile?.email ?? ''}
        </div>
        <div>
          <span className="font-semibold">ADD: </span>
          {profile?.address ?? ''}
        </div>
      </div>
    </div>
  );
};
