import React from 'react';
import type { ManufacturingCertData, ManufacturingCertRow } from '../../lib/inspectionTypes';

interface ManufacturingCertTemplateProps {
  data: ManufacturingCertData;
}

/** 14 列主表的列定义：表头为「中文行 + 英文行」两行结构（与扫描件一致） */
const PRODUCT_COLUMNS: readonly {
  key: keyof ManufacturingCertRow;
  cn: string;
  en: string;
  width: string;
}[] = [
  { key: 'customerProcessNo', cn: '客户工序编号', en: 'Cus. Item NO.', width: '7%' },
  { key: 'type', cn: '类型', en: 'Type', width: '7%' },
  { key: 'materialGrade', cn: '材料级别', en: 'Grade', width: '6%' },
  { key: 'specification', cn: '规格尺寸', en: 'Size', width: '9%' },
  { key: 'quantity', cn: '数量Qty.', en: '(pcs)', width: '5.5%' },
  { key: 'coating', cn: '涂层', en: 'Coating', width: '8%' },
  { key: 'colour', cn: '颜色', en: 'Colour', width: '6%' },
  { key: 'appearance', cn: '外观', en: 'Surface', width: '7.5%' },
  { key: 'cureTest', cn: '固化测试', en: 'Cure test', width: '8%' },
  { key: 'zincThickness', cn: '镀锌厚度', en: 'Micron', width: '7%' },
  { key: 'dft', cn: '干膜厚度DFT', en: 'Micron', width: '7%' },
  { key: 'hardness', cn: '硬度检验 Hardness', en: 'Test  D3363 - 05', width: '7%' },
  { key: 'adhesion', cn: '附着力测试 Adhesion', en: 'Test  D3359 - 09', width: '7%' },
  { key: 'saltSpray', cn: '盐雾测试 Salt Spray Test', en: '720 Hours', width: '8%' },
];

/** 页尾补空白行数：扫描件把主表撑满整页，数据行不足时以空行补齐（含原标准副行腾出的高度） */
const FILLER_ROW_COUNT = 24;
const FILLER_ROW_HEIGHT = 15;

/** 客户字段默认值：未录入客户名时兜底显示（业务约定） */
const DEFAULT_CUSTOMER_NAME = '江阴市乐天紧固件有限公司';

/**
 * 模板A：《MANUFACTURING CERTIFICATE》横向制造证书（docs/51）
 *
 * 1:1 复刻扫描件版式：公司抬头 → 带框「MANUFACTURING CERTIFICATE」标题栏 + 三列字段区
 * （客户/交货订单参考DO ref./证书编号/客户PO号/工单编号/日期/交货点，列间无竖线分隔）→
 * 14 列产品检验主表（数据从表头下第一行开始，空行补页）→ Remarks + EN10204 符合性声明 →
 * DIN 50049 脚注 + MANUFACTURING BY / APPROVED BY 签字区 + 页码。
 *
 * 所有内容格一律「有真实值才打印」：未录入的字段渲染空白单元格，绝不放演示值。
 */
export const ManufacturingCertTemplate: React.FC<ManufacturingCertTemplateProps> = ({ data }) => {
  const profile = data.companyProfile;
  const rows: ManufacturingCertRow[] = data.rows ?? [];
  const fillerCount = Math.max(0, FILLER_ROW_COUNT - rows.length);

  const cellCls = 'border border-black px-0.5 text-center align-middle leading-tight';
  const labelCell = 'text-left pl-1 break-words';

  return (
    <div
      className="bg-white text-black mx-auto font-sans select-text w-full"
      style={{ fontSize: '10.5px', lineHeight: 1.35 }}
    >
      {/* 公司抬头（企业档案主数据；未维护即留白，docs/35 §6） */}
      <div className="font-bold" style={{ fontSize: '12.5px' }}>
        <span>{profile?.legalName ?? ''} </span>
        <span>{profile?.legalNameEn ?? ''}</span>
      </div>
      {profile?.address !== undefined && profile.address !== '' && (
        <div className="font-bold" style={{ fontSize: '12px' }}>
          地址：{profile.address}
        </div>
      )}
      {(profile as { addressEn?: string } | undefined)?.addressEn && (
        <div className="font-bold" style={{ fontSize: '12px' }}>
          {(profile as { addressEn?: string }).addressEn}
        </div>
      )}

      {/* 标题框 + 三列字段区（外框包裹，内部横线分隔） */}
      <div className="border border-black mt-2">
        <div
          className="text-center font-bold border-b border-black py-1 tracking-wide"
          style={{ fontSize: '15px' }}
        >
          MANUFACTURING CERTIFICATE
        </div>
        <div className="grid" style={{ gridTemplateColumns: '42% 26% 32%' }}>
          {/* 左列：客户 / 客户PO号 / 交货点 */}
          <div className="p-1">
            <div className={labelCell}>
              <span className="font-semibold">客户Customer :</span>{' '}
              {data.customerName && data.customerName.trim() !== ''
                ? data.customerName
                : DEFAULT_CUSTOMER_NAME}
            </div>
            <div className={labelCell}>
              <span className="font-semibold">客户采购订单编号Your PO No. :</span>{' '}
              {data.purchaseOrderNo ?? ''}
            </div>
            <div className={labelCell}>
              <span className="font-semibold">交货点DELIVERY POINT :</span> {data.deliveryPoint ?? ''}
            </div>
          </div>
          {/* 中列：交货订单参考 / 工单编号 */}
          <div className="p-1">
            <div className={labelCell}>
              <span className="font-semibold">交货订单参考DO ref. :</span> {data.deliveryNoteNo ?? ''}
            </div>
            <div className={labelCell}>
              <span className="font-semibold">工单编号Jobcard No. :</span> {data.jobcardNo ?? ''}
            </div>
          </div>
          {/* 右列：证书编号 / 日期 */}
          <div className="p-1">
            <div className={labelCell}>
              <span className="font-semibold">证书编号Certificate No.</span> {data.certNo ?? ''}
            </div>
            <div className={labelCell}>
              <span className="font-semibold">日期Date:</span> {data.dateOfIssue ?? ''}
            </div>
          </div>
        </div>
      </div>

      {/* 14 列产品检验主表 */}
      <table className="w-full border-collapse mt-0" style={{ tableLayout: 'fixed' }}>
        <thead>
          <tr>
            {PRODUCT_COLUMNS.map((col) => (
              <th
                key={col.key}
                className="border border-black font-bold text-center align-middle px-0.5"
                style={{ width: col.width, fontSize: '10.5px', lineHeight: 1.25 }}
              >
                <div>{col.cn}</div>
                <div>{col.en}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {/* 数据行：紧跟表头从第一行开始，不留空行 */}
          {rows.map((row, idx) => (
            <tr key={idx} style={{ height: '20px' }}>
              {PRODUCT_COLUMNS.map((col) => (
                <td key={col.key} className={cellCls} style={{ fontSize: '10.5px' }}>
                  {row[col.key] ?? ''}
                </td>
              ))}
            </tr>
          ))}
          {/* 空白补齐行（扫描件主表撑满整页） */}
          {Array.from({ length: fillerCount }).map((_, idx) => (
            <tr key={`filler-${idx}`} style={{ height: `${FILLER_ROW_HEIGHT}px` }}>
              {PRODUCT_COLUMNS.map((col) => (
                <td key={col.key} className={cellCls} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {/* Remarks + 符合性声明 */}
      <div className="mt-2 px-2">
        <div>
          <span className="font-semibold">Remarks :</span> {data.remarks ?? ''}
        </div>
        <div className="font-bold text-center mt-0.5" style={{ fontSize: '10px' }}>
          THE PRODUCT SUPPLIED ARE IN COMPLIANCE WITH THE REQUIREMENTS OF ASTM AND THE ORDER USING
          ELECTRIC ARC FURNACE AND VACUUM CONTROL DEGASSING PROCESS.
        </div>
      </div>

      {/* 页脚：DIN 引用 + 制造方 / 批准签字 */}
      <div className="border-t border-black mt-2 pt-1 flex justify-between items-start">
        <div>
          <div>DIN 50049 / BS EN 10204 : 1991 3.1B (EN 10204 : 2004 3.1)</div>
          <div className="mt-6 font-semibold" style={{ fontSize: '10px' }}>
            Default hardness in HB unit
          </div>
        </div>
        <div className="text-left">
          <div className="font-bold">MANUFACTURING BY :</div>
          <div>{profile?.legalNameEn ?? profile?.legalName ?? ''}</div>
          <div className="border-b border-black mt-6" style={{ width: '230px', height: '18px' }}>
            <span className="font-semibold">{data.qaManagerName ?? ''}</span>
          </div>
          <div className="font-bold">APPROVED BY : QA / QC</div>
        </div>
      </div>

      <div className="text-center mt-3" style={{ fontSize: '10.5px' }}>
        第 1 页，共 1 页
      </div>
    </div>
  );
};
