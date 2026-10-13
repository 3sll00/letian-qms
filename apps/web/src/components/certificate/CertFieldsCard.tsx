import React from 'react';
import { FileText } from 'lucide-react';
import type { CertTemplateKind } from '../../lib/inspectionTypes';

interface CertFieldsCardProps {
  kind: CertTemplateKind;
  value: Record<string, string>;
  onChange: (key: string, value: string) => void;
  readOnly?: boolean;
}

/** 质保书（纵向）补充字段：对应扫描件三列字段网格中检验单表头没有真实列的格 */
const QUALITY_FIELDS: readonly { key: string; label: string }[] = [
  { key: 'orderNo', label: '订单号码 PO#NO' },
  { key: 'customerAddress', label: '客户地址 ADDRESS' },
  { key: 'projectNo', label: '项目号 CUST P/N' },
  { key: 'shortProjectNo', label: '短项目号 ITEM NO' },
  { key: 'productNo', label: '产品(项目)号' },
  { key: 'shippedQty', label: '实发数量 SHIP QTY' },
  { key: 'samplingDate', label: '抽样日期' },
  { key: 'marking', label: '印记 MARKING' },
  { key: 'manufacturer', label: '制造商 MFR' },
  { key: 'samplingPlan', label: '抽样计划 Sample Plan' },
  { key: 'surfaceFinish', label: '表面处理 Surface' },
];

/** 制造证书（横向）补充字段：扫描件表头七格 + 14 列主表的产品行与验收标准副行 */
const MANUFACTURING_FIELDS: readonly { key: string; label: string; group: string }[] = [
  { key: 'customerName', label: '客户 Customer', group: '表头' },
  { key: 'purchaseOrderNo', label: '客户采购订单编号 Your PO No.', group: '表头' },
  { key: 'deliveryNoteNo', label: '交货订单参考 DO ref.', group: '表头' },
  { key: 'jobcardNo', label: '工单编号 Jobcard No.', group: '表头' },
  { key: 'deliveryPoint', label: '交货点 DELIVERY POINT', group: '表头' },
  { key: 'customerProcessNo', label: '客户工序编号 Cus. Item NO.', group: '产品行' },
  { key: 'type', label: '类型 Type', group: '产品行' },
  { key: 'coating', label: '涂层 Coating', group: '产品行' },
  { key: 'colour', label: '颜色 Colour', group: '产品行' },
  { key: 'appearance', label: '外观 Surface', group: '产品行' },
  { key: 'cureTest', label: '固化测试 Cure test', group: '产品行' },
  { key: 'zincThickness', label: '镀锌厚度 Micron', group: '产品行' },
  { key: 'dft', label: '干膜厚度 DFT Micron', group: '产品行' },
  { key: 'hardness', label: '硬度检验 Hardness', group: '产品行' },
  { key: 'adhesion', label: '附着力测试 Adhesion', group: '产品行' },
  { key: 'saltSpray', label: '盐雾测试 Salt Spray', group: '产品行' },
  { key: 'stdCureTest', label: '固化测试标准', group: '验收标准副行' },
  { key: 'stdZincThickness', label: '镀锌厚度标准', group: '验收标准副行' },
  { key: 'stdDft', label: '干膜厚度标准', group: '验收标准副行' },
  { key: 'stdHardness', label: '硬度标准(如 2H-4H)', group: '验收标准副行' },
  { key: 'stdAdhesion', label: '附着力标准(如 4B-5B)', group: '验收标准副行' },
  { key: 'stdSaltSpray', label: '盐雾标准(如 ASTM B117)', group: '验收标准副行' },
  { key: 'remarks', label: '备注 Remarks', group: '页脚' },
];

const INPUT_CLS =
  'w-full px-2 py-1 text-xs border border-slate-200 rounded focus:outline-none focus:border-blue-500 bg-white disabled:bg-slate-50 disabled:text-slate-400';

/**
 * 证书补充字段卡片（docs/51）：按建单时选定的证书模板展示专属输入项。
 *
 * 字段一律写入 `cert_fields` 字段袋随单落库 —— 这些列只存在于扫描件的证书版面上，
 * 检验单表头没有对应物理列；不填即留白（证书为对外交付物，绝不用演示值充数）。
 */
export const CertFieldsCard: React.FC<CertFieldsCardProps> = ({
  kind,
  value,
  onChange,
  readOnly = false,
}) => {
  if (kind === 'QUALITY') {
    return (
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
        <div className="flex items-center gap-2 mb-3">
          <FileText className="w-4 h-4 text-blue-600" />
          <h3 className="text-sm font-bold text-slate-800">证书字段（质量保证书 · 纵向）</h3>
          <span className="text-[11px] text-slate-400">未填写的格在证书上留白</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {QUALITY_FIELDS.map(({ key, label }) => (
            <label key={key} className="block">
              <span className="block text-[11px] text-slate-500 mb-0.5">{label}</span>
              <input
                type="text"
                value={value[key] ?? ''}
                disabled={readOnly}
                onChange={(e) => onChange(key, e.target.value)}
                className={INPUT_CLS}
              />
            </label>
          ))}
        </div>
      </div>
    );
  }

  const groups = ['表头', '产品行', '验收标准副行', '页脚'];
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
      <div className="flex items-center gap-2 mb-3">
        <FileText className="w-4 h-4 text-blue-600" />
        <h3 className="text-sm font-bold text-slate-800">
          证书字段（MANUFACTURING CERTIFICATE · 横向）
        </h3>
        <span className="text-[11px] text-slate-400">未填写的格在证书上留白</span>
      </div>
      <div className="space-y-3">
        {groups.map((group) => (
          <div key={group}>
            <div className="text-[11px] font-semibold text-slate-400 mb-1.5">{group}</div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {MANUFACTURING_FIELDS.filter((f) => f.group === group).map(({ key, label }) => (
                <label key={key} className="block">
                  <span className="block text-[11px] text-slate-500 mb-0.5">{label}</span>
                  <input
                    type="text"
                    value={value[key] ?? ''}
                    disabled={readOnly}
                    onChange={(e) => onChange(key, e.target.value)}
                    className={INPUT_CLS}
                  />
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
