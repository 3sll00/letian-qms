import React, { useState } from 'react';
import { ArrowLeft, Printer, ShieldCheck, Atom, Gauge, Box } from 'lucide-react';
import { CertificatePrintModal } from '../../../components/certificate/CertificatePrintModal';
import { PrintTemplateModal } from '../../../components/common/PrintTemplateModal';
import { QualityCertificateData } from '../../../lib/inspectionTypes';

interface IqcRecordFormProps {
  initialItem?: any;
  onBack: () => void;
  onSubmit: (result: any) => void;
  readOnly?: boolean;
}

// 标准区间解析: 支持 "0.50 ~ 0.80" / "≤ 0.030" / "≥ 590" / "22.0 ± 0.20 mm" 等形式,
// 无法解析的定性标准 (如 "无裂纹") 返回 null, 交由人工判定
function specRange(standard: string): { min: number | null; max: number | null } | null {
  const s = standard.replace(/\s+/g, '');
  let m = s.match(/(\d+(?:\.\d+)?)[~～](\d+(?:\.\d+)?)/);
  if (m) return { min: parseFloat(m[1]), max: parseFloat(m[2]) };
  m = s.match(/(\d+(?:\.\d+)?)±(\d+(?:\.\d+)?)/);
  if (m) {
    const nominal = parseFloat(m[1]);
    const tol = parseFloat(m[2]);
    return { min: nominal - tol, max: nominal + tol };
  }
  m = s.match(/[≤<]=?(\d+(?:\.\d+)?)/);
  if (m) return { min: null, max: parseFloat(m[1]) };
  m = s.match(/[≥>]=?(\d+(?:\.\d+)?)/);
  if (m) return { min: parseFloat(m[1]), max: null };
  return null;
}

function firstNumber(text: string): number | null {
  const m = text.match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

// 闭区间比较, EPS 防护浮点精度 (如 0.030 对 "≤0.030" 判合格)
const NUM_EPS = 1e-9;
function judgeStandard(standard: string, actual: string): 'pass' | 'fail' | null {
  const range = specRange(standard);
  const value = actual.trim() === '' ? null : firstNumber(actual);
  if (!range || value === null) return null;
  const within =
    (range.min === null || value >= range.min - NUM_EPS) &&
    (range.max === null || value <= range.max + NUM_EPS);
  return within ? 'pass' : 'fail';
}

function verdictResult(standard: string, actual: string, fallback: string): string {
  const v = judgeStandard(standard, actual);
  return v === null ? fallback : v === 'pass' ? '合格' : '不合格';
}

export const IqcRecordForm: React.FC<IqcRecordFormProps> = ({ initialItem, onBack, onSubmit, readOnly = false }) => {
  // 单据与供货原材料基本属性 (对应质量保证证书基本项)
  const [docNo, setDocNo] = useState(initialItem?.no || initialItem?.docNo || 'IQC-20260706-0002');
  const [materialName, setMaterialName] = useState(initialItem?.name || '碳钢圆钢 (热轧棒料)');
  const [materialGrade, setMaterialGrade] = useState(initialItem?.steelGrade || 'ML40Cr');
  const [spec, setSpec] = useState(initialItem?.spec || 'Φ22.0 mm');
  const [supplier, setSupplier] = useState(initialItem?.supplier || '鞍钢集团钢铁新材料有限公司');
  const [heatNo, setHeatNo] = useState(initialItem?.furnaceNo || 'AG-20260515-B2');
  const [batchNo, setBatchNo] = useState(initialItem?.lotNo || 'LOT-20260706-01');
  const [quantity, setQuantity] = useState(initialItem?.qty ? `${initialItem.qty} 吨` : '15.5 吨');
  const [standard, setStandard] = useState('GB/T 6478 / GB/T 699');

  // 1. 化学成分实测与材料标准范围 (光谱分析)
  const [chemElements, setChemElements] = useState([
    { element: 'C', standard: '0.37 ~ 0.44', actual: '0.41', unit: '%', result: '合格' },
    { element: 'Si', standard: '0.17 ~ 0.37', actual: '0.26', unit: '%', result: '合格' },
    { element: 'Mn', standard: '0.50 ~ 0.80', actual: '0.68', unit: '%', result: '合格' },
    { element: 'Cr', standard: '0.80 ~ 1.10', actual: '0.96', unit: '%', result: '合格' },
    { element: 'P', standard: '≤ 0.030', actual: '0.015', unit: '%', result: '合格' },
    { element: 'S', standard: '≤ 0.030', actual: '0.008', unit: '%', result: '合格' },
    { element: 'Ni', standard: '≤ 0.30', actual: '0.03', unit: '%', result: '合格' },
  ]);

  // 2. 原材料机械力学试验与硬度
  const [mechProperties, setMechProperties] = useState([
    { item: '抗拉强度 Rm', standard: '≥ 590', actual: '685', unit: 'MPa', result: '合格', isExempt: false },
    { item: '过程硬度测试 (过程检验项)', standard: '240 ~ 280 HBW', actual: '255', unit: 'HBW', result: '合格', isExempt: true },
    { item: '屈服强度 ReL', standard: '≥ 355', actual: '430', unit: 'MPa', result: '合格' },
    { item: '断后伸长率 A', standard: '≥ 15.0', actual: '21.0', unit: '%', result: '合格' },
    { item: '布氏硬度 HBW', standard: '≤ 207 (退火/热轧态)', actual: '187', unit: 'HBW', result: '合格' },
    { item: '冷顶锻试验', standard: '1/2 锻压无裂纹 (GB/T 233)', actual: '无裂纹裂缝，合格', unit: '目测', result: '合格' },
  ]);

  // 3. 外观与几何公差
  const [dimItems, setDimItems] = useState([
    { item: '棒料外径公差', standard: '22.0 ± 0.20 mm', actual: '22.08 mm', result: '合格', isExempt: false },
    { item: '圆钢椭圆度 (不圆度)', standard: '≤ 0.15 mm', actual: '0.06 mm', result: '合格' },
    { item: '表面质量', standard: '表面光洁，无裂纹、结疤、重皮及机械折叠', actual: '良好合格', result: '合格' },
    { item: '材质证明单 (MTC)', standard: '原厂质保书随货同行，炉批号与标签一致', actual: '核验一致', result: '合格' },
  ]);

  // 判定与人员
  const [decision, setDecision] = useState<'合格' | '让步接收' | '退货'>('合格');
  const [inspector, setInspector] = useState(initialItem?.inspector || '张检验 (QC)');
  const [inspectDate, setInspectDate] = useState('2026-07-06');
  const [remark, setRemark] = useState('原材料光谱复验化学成分符合 ML40Cr 标准，拉伸与冷顶锻试验合格，炉批一致，准予入库。');

  // 打印预览控制
  const [printModalOpen, setPrintModalOpen] = useState(false);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [certData, setCertData] = useState<QualityCertificateData | null>(null);

  // 组装质量保证证书格式
  const handleOpenCert = () => {
    const cert: QualityCertificateData = {
      certNo: docNo,
      date: inspectDate,
      customer: '乐天智能制造 (入库检验联)',
      contractNo: 'PO-RAW-202607-01',
      deliveryNo: initialItem?.deliveryNo || 'DO-RAW-001',
      productName: materialName,
      standard: standard,
      spec: spec,
      materialGrade: materialGrade,
      heatNo: heatNo,
      lotNo: batchNo,
      deliveryStatus: '热轧退火态 (Annealed)',
      quantity: quantity,
      chemicalComposition: {
        elements: chemElements.map((el) => {
          const range = specRange(el.standard);
          return {
            element: el.element,
            standard: el.standard,
            standardMin: range?.min ?? undefined,
            standardMax: range?.max ?? undefined,
            actual: el.actual,
            actualValue: el.actual,
            unit: el.unit,
          };
        }),
      },
      mechanicalProperties: {
        items: mechProperties.map((mp) => ({
          name: mp.item,
          unit: mp.unit,
          standard: mp.standard,
          actual: mp.actual,
          result: verdictResult(mp.standard, mp.actual, mp.result) === '合格' ? 'OK' : 'NG',
        })),
      },
      dimensionalInspection: dimItems.map((d) => ({
        item: d.item,
        standard: d.standard,
        measured: d.actual,
        result: verdictResult(d.standard, d.actual, d.result),
      })),
      metallographic: '铁素体+珠光体 (F+P) 正常热轧退火组织，脱碳层完全受控',
      visualAndSurface: '原厂随货质保书核验齐全，钢卷外表面防锈防刮擦保护完好',
      overallConclusion: decision === '合格' ? '合格入库 (ACCEPTED)' : decision === '让步接收' ? '特采让步 (CONCESSION)' : '不合格退货 (REJECTED)',
      inspector: inspector,
      approver: '李审核 (QA Lead)',
      director: '陈主任 (Quality Director)',
      remarks: remark,
    };

    setCertData(cert);
    setPrintModalOpen(true);
  };

  const handleInternalSubmit = () => {
    onSubmit({
      decision,
      furnaceNo: heatNo,
      inspector,
      inspectDate,
      remark,
      chemElements: chemElements.map((el) => ({
        ...el,
        result: verdictResult(el.standard, el.actual, el.result),
      })),
      mechProperties: mechProperties.map((mp) => ({
        ...mp,
        result: verdictResult(mp.standard, mp.actual, mp.result),
      })),
    });
  };

  return (
    <div className="space-y-4">
      {/* 顶部操作与标题 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-blue-600 font-medium"
          >
            <ArrowLeft className="w-4 h-4" /> 返回来料检验列表
          </button>
          <span className="text-slate-300">|</span>
          <span className="text-sm font-semibold text-slate-800">
            来料检验检视与评定 (质量保证证书 EN 10204 3.1)
          </span>
          <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-xs font-mono font-medium border border-blue-200">
            {docNo}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setTemplateModalOpen(true)}
            className="px-3.5 py-1.5 rounded bg-blue-50 border border-blue-200 text-blue-700 text-xs font-medium hover:bg-blue-100 flex items-center gap-1.5 transition-colors shadow-sm"
          >
            <Printer className="w-3.5 h-3.5" /> 预览与打印质量保证证书 (PDF)
          </button>
        </div>
      </div>

      {/* 模块一：供货商与原材料规格炉号基本信息 */}
      <div className="bg-white border border-slate-200/80 rounded-lg p-4 shadow-sm">
        <div className="flex items-center gap-2 pb-3 mb-3 border-b border-slate-100 text-xs font-semibold text-slate-800">
          <ShieldCheck className="w-4 h-4 text-blue-600" />
          <span>原材料到货与供应商溯源信息 (Material Inward & Supplier Specs)</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
          <div>
            <label className="block text-slate-500 mb-1">供货厂商 (Supplier)</label>
            <input
              type="text"
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
              className="w-full bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 font-medium focus:bg-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-slate-500 mb-1">材料名称 (Material Name)</label>
            <input
              type="text"
              value={materialName}
              onChange={(e) => setMaterialName(e.target.value)}
              className="w-full bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 focus:bg-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-slate-500 mb-1">材质牌号 (Steel Grade)</label>
            <input
              type="text"
              value={materialGrade}
              onChange={(e) => setMaterialGrade(e.target.value)}
              className="w-full bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 focus:bg-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-slate-500 mb-1">原材料规格 (Diameter / Spec)</label>
            <input
              type="text"
              value={spec}
              onChange={(e) => setSpec(e.target.value)}
              className="w-full bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 focus:bg-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-slate-500 mb-1">原厂冶炼炉号 (Heat No)</label>
            <input
              type="text"
              value={heatNo}
              onChange={(e) => setHeatNo(e.target.value)}
              className="w-full bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 font-mono font-medium focus:bg-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-slate-500 mb-1">进厂批次号 (Lot / Batch No)</label>
            <input
              type="text"
              value={batchNo}
              onChange={(e) => setBatchNo(e.target.value)}
              className="w-full bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 focus:bg-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-slate-500 mb-1">到货重量/数量 (Qty)</label>
            <input
              type="text"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              className="w-full bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 focus:bg-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-slate-500 mb-1">材料标准 (Technical Standard)</label>
            <input
              type="text"
              value={standard}
              onChange={(e) => setStandard(e.target.value)}
              className="w-full bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 focus:bg-white focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>
      </div>

      {/* 模块二：化学成分光谱分析卡片 (Chemical Composition) */}
      <div className="bg-white border border-slate-200/80 rounded-lg shadow-sm overflow-hidden">
        <div className="px-4 py-3 bg-[#F8FAFC] border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-800">
            <Atom className="w-4 h-4 text-purple-600" />
            <span>化学成分复验光谱分析 (Chemical Composition, %)</span>
          </div>
          <span className="text-[11px] text-slate-500">直读光谱仪定量分析报告</span>
        </div>
        <div className="p-4 grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-3 text-xs">
          {chemElements.map((el, idx) => {
            const verdict = judgeStandard(el.standard, el.actual);
            return (
              <div key={el.element} className="border border-slate-200 rounded-lg p-2.5 bg-slate-50/30 space-y-1 text-center">
                <div className="font-bold text-slate-800 text-sm">{el.element}</div>
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-slate-400 shrink-0">标准:</span>
                  <input
                    type="text"
                    value={el.standard}
                    onChange={(e) => {
                      const updated = [...chemElements];
                      updated[idx].standard = e.target.value;
                      setChemElements(updated);
                    }}
                    placeholder="0.50 ~ 0.80"
                    title="可修改标准值, 支持区间(0.50 ~ 0.80)、上限(≤ 0.030)、下限(≥ 590)写法"
                    className="w-full min-w-0 bg-white border border-slate-300 rounded px-1 py-0.5 text-center font-mono text-[10px] text-slate-600 focus:border-blue-500"
                  />
                </div>
                <input
                  type="text"
                  value={el.actual}
                  onChange={(e) => {
                    const updated = [...chemElements];
                    updated[idx].actual = e.target.value;
                    setChemElements(updated);
                  }}
                  className={`w-full bg-white border rounded px-1.5 py-0.5 text-center font-mono font-medium focus:border-blue-500 text-xs ${
                    verdict === 'fail' ? 'border-rose-400 text-rose-600' : 'border-slate-300'
                  }`}
                />
                {verdict === 'pass' && (
                  <div className="text-[10px] text-emerald-600 font-medium">✓ 符合技术要求</div>
                )}
                {verdict === 'fail' && (
                  <div className="text-[10px] text-rose-600 font-semibold">× 不符合技术要求</div>
                )}
                {verdict === null && (
                  <div className="text-[10px] text-slate-400 font-medium">— 待判定</div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      
      {/* 过程检验不解检 (EXEMPT) 实测合格率统计面板 */}
      <div className="bg-gradient-to-r from-slate-50 to-blue-50/50 border border-slate-200/80 rounded-lg p-3 flex flex-wrap items-center justify-between gap-3 text-xs shadow-sm">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-1.5">
            <span className="text-slate-500">检验项总数:</span>
            <span className="font-bold text-slate-800">{[...mechProperties, ...dimItems].length} 项</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-slate-500">不解检/免检 (EXEMPT):</span>
            <span className="font-bold text-sky-700 bg-sky-50 px-2 py-0.5 rounded border border-sky-200">
              {[...mechProperties, ...dimItems].filter((i) => (i as any).isExempt).length} 项 (已剔除出合格率分母★)
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-slate-500">有效参检项 (分母):</span>
            <span className="font-bold text-slate-900">
              {[...mechProperties, ...dimItems].filter((i) => !(i as any).isExempt).length} 项
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-500">过程实测合格率:</span>
          {(() => {
            const valids = [...mechProperties, ...dimItems].filter((i) => !(i as any).isExempt);
            const passed = valids.filter((i) => {
              const v = judgeStandard(i.standard, i.actual);
              return v === null ? i.result === "合格" : v === "pass";
            }).length;
            const rate = valids.length > 0 ? ((passed / valids.length) * 100).toFixed(1) + "%" : "100%";
            return (
              <span className="text-sm font-black px-2.5 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-300">
                {rate}
              </span>
            );
          })()}
        </div>
      </div>

      {/* 模块三：原材料机械力学性能与顶锻试验 */}
      <div className="bg-white border border-slate-200/80 rounded-lg shadow-sm overflow-hidden">
        <div className="px-4 py-3 bg-[#F8FAFC] border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-800">
            <Gauge className="w-4 h-4 text-blue-600" />
            <span>原材料力学性能与硬度试验 (Mechanical Properties & Upsetting Test)</span>
          </div>
        </div>
        <table className="w-full text-xs text-left">
          <thead className="bg-slate-50 text-slate-600 font-medium border-b border-slate-200">
            <tr>
              <th className="py-2.5 px-4 w-48">试验项目</th>
              <th className="py-2.5 px-4 w-28">单位</th>
              <th className="py-2.5 px-4 w-56">标准规范要求</th>
              <th className="py-2.5 px-4">实际测试值</th>
              <th className="py-2.5 px-3 w-28 text-center">不解检 (EXEMPT)</th>
              <th className="py-2.5 px-4 w-28 text-center">单项判定</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {mechProperties.map((item, idx) => {
              const verdict = judgeStandard(item.standard, item.actual);
              const isPass = verdict === null ? item.result === '合格' : verdict === 'pass';
              return (
              <tr key={item.item} className="hover:bg-slate-50/50">
                <td className="py-2.5 px-4 font-medium text-slate-800">{item.item}</td>
                <td className="py-2.5 px-4 text-slate-500">{item.unit}</td>
                <td className="py-2.5 px-4">
                  <input
                    type="text"
                    value={item.standard}
                    onChange={(e) => {
                      const updated = [...mechProperties];
                      updated[idx].standard = e.target.value;
                      setMechProperties(updated);
                    }}
                    title="可修改标准值, 支持区间、上下限(≤ / ≥)、公差(±)写法"
                    className="w-52 bg-white border border-slate-200 rounded px-2 py-1 font-mono text-slate-600 focus:border-blue-500"
                  />
                </td>
                <td className="py-2.5 px-4">
                  <input
                    type="text"
                    disabled={Boolean((item as any).isExempt)}
                    placeholder={(item as any).isExempt ? "已标记不解检(免检)" : "测试值"}
                    value={(item as any).isExempt ? "" : item.actual}
                    onChange={(e) => {
                      const updated = [...mechProperties];
                      updated[idx].actual = e.target.value;
                      setMechProperties(updated);
                    }}
                    className={`w-48 border rounded px-2 py-1 font-mono font-medium focus:outline-none ${
                      (item as any).isExempt
                        ? "bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed italic"
                        : verdict === "fail"
                        ? "border-rose-400 text-rose-600 bg-white"
                        : "border-slate-200 bg-white focus:border-blue-500"
                    }`}
                  />
                </td>
                <td className="py-2.5 px-3 text-center">
                  <label className="inline-flex items-center gap-1 cursor-pointer text-xs">
                    <input
                      type="checkbox"
                      checked={Boolean((item as any).isExempt)}
                      onChange={(e) => {
                        const updated = [...mechProperties];
                        (updated[idx] as any).isExempt = e.target.checked;
                        setMechProperties(updated);
                      }}
                      className="rounded text-blue-600 focus:ring-blue-500"
                    />
                    <span className={(item as any).isExempt ? "text-sky-700 font-bold" : "text-slate-400"}>
                      不解检
                    </span>
                  </label>
                </td>
                <td className="py-2.5 px-4 text-center">
                  {(item as any).isExempt ? (
                    <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-sky-50 text-sky-700 border border-sky-200">
                      免检 (EXEMPT)
                    </span>
                  ) : (
                    <span
                      className={`px-2 py-0.5 rounded font-medium ${
                        isPass ? "bg-emerald-50 text-emerald-600" : "bg-rose-50 text-rose-600"
                      }`}
                    >
                      {isPass ? "✓ 合格" : "✗ 不合格"}
                    </span>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 模块四：尺寸与外观质量抽检 */}
      <div className="bg-white border border-slate-200/80 rounded-lg shadow-sm overflow-hidden">
        <div className="px-4 py-3 bg-[#F8FAFC] border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-800">
            <Box className="w-4 h-4 text-emerald-600" />
            <span>尺寸公差与外观质量 (Dimensions & Visual Appearance)</span>
          </div>
        </div>
        <table className="w-full text-xs text-left">
          <thead className="bg-slate-50 text-slate-600 font-medium border-b border-slate-200">
            <tr>
              <th className="py-2.5 px-4 w-48">检验项目</th>
              <th className="py-2.5 px-4 w-56">标准要求</th>
              <th className="py-2.5 px-4">抽查实测结果</th>
              <th className="py-2.5 px-3 w-28 text-center">不解检 (EXEMPT)</th>
              <th className="py-2.5 px-4 w-28 text-center">判定</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {dimItems.map((item, idx) => {
              const verdict = judgeStandard(item.standard, item.actual);
              const isPass = verdict === null ? item.result === '合格' : verdict === 'pass';
              return (
              <tr key={item.item} className="hover:bg-slate-50/50">
                <td className="py-2.5 px-4 font-medium text-slate-800">{item.item}</td>
                <td className="py-2.5 px-4">
                  <input
                    type="text"
                    value={item.standard}
                    onChange={(e) => {
                      const updated = [...dimItems];
                      updated[idx].standard = e.target.value;
                      setDimItems(updated);
                    }}
                    title="可修改标准要求, 数值型标准将自动比对实测值判定"
                    className="w-full bg-white border border-slate-200 rounded px-2 py-1 font-mono text-slate-600 focus:border-blue-500"
                  />
                </td>
                <td className="py-2.5 px-4">
                  <input
                    type="text"
                    disabled={Boolean((item as any).isExempt)}
                    placeholder={(item as any).isExempt ? "已标记不解检(免检)" : "实测结果"}
                    value={(item as any).isExempt ? "" : item.actual}
                    onChange={(e) => {
                      const updated = [...dimItems];
                      updated[idx].actual = e.target.value;
                      setDimItems(updated);
                    }}
                    className={`w-full border rounded px-2 py-1 focus:outline-none ${
                      (item as any).isExempt
                        ? "bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed italic"
                        : verdict === "fail"
                        ? "border-rose-400 text-rose-600 bg-white"
                        : "border-slate-200 bg-white focus:border-blue-500"
                    }`}
                  />
                </td>
                <td className="py-2.5 px-3 text-center">
                  <label className="inline-flex items-center gap-1 cursor-pointer text-xs">
                    <input
                      type="checkbox"
                      checked={Boolean((item as any).isExempt)}
                      onChange={(e) => {
                        const updated = [...dimItems];
                        (updated[idx] as any).isExempt = e.target.checked;
                        setDimItems(updated);
                      }}
                      className="rounded text-blue-600 focus:ring-blue-500"
                    />
                    <span className={(item as any).isExempt ? "text-sky-700 font-bold" : "text-slate-400"}>
                      不解检
                    </span>
                  </label>
                </td>
                <td className="py-2.5 px-4 text-center">
                  {(item as any).isExempt ? (
                    <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-sky-50 text-sky-700 border border-sky-200">
                      免检 (EXEMPT)
                    </span>
                  ) : (
                    <span
                      className={`px-2 py-0.5 rounded font-medium ${
                        isPass ? "bg-emerald-50 text-emerald-600" : "bg-rose-50 text-rose-600"
                      }`}
                    >
                      {isPass ? "✓ 合格" : "✗ 不合格"}
                    </span>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 模块五：入库判定与签核 */}
      <div className="bg-white border border-slate-200/80 rounded-lg p-4 shadow-sm space-y-3">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
          <span className="text-blue-600">⚖</span>
          <span>来料检验综合判定与入库审核 (Overall Inspection Conclusion)</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-xs">
          <div>
            <label className="block text-slate-600 mb-1 font-medium">判定结果 <span className="text-red-500">*</span></label>
            <div className="flex items-center gap-2 mt-1.5">
              <label className="inline-flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="iqc_decision"
                  checked={decision === '合格'}
                  onChange={() => setDecision('合格')}
                  className="text-blue-600"
                />
                <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-600 font-medium">
                  ✓ 准予入库 (合格)
                </span>
              </label>
              <label className="inline-flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="iqc_decision"
                  checked={decision === '让步接收'}
                  onChange={() => setDecision('让步接收')}
                  className="text-blue-600"
                />
                <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-600 font-medium">
                  让步接收
                </span>
              </label>
              <label className="inline-flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="iqc_decision"
                  checked={decision === '退货'}
                  onChange={() => setDecision('退货')}
                  className="text-blue-600"
                />
                <span className="px-2 py-0.5 rounded bg-rose-50 text-rose-600 font-medium">
                  ✕ 不合格退货
                </span>
              </label>
            </div>
          </div>

          <div>
            <label className="block text-slate-600 mb-1">检验员 (Inspector)</label>
            <input
              type="text"
              value={inspector}
              onChange={(e) => setInspector(e.target.value)}
              className="w-full bg-white border border-slate-200 rounded px-2.5 py-1.5 text-slate-700"
            />
          </div>

          <div>
            <label className="block text-slate-600 mb-1">检验日期 (Inspect Date)</label>
            <input
              type="text"
              value={inspectDate}
              onChange={(e) => setInspectDate(e.target.value)}
              className="w-full bg-white border border-slate-200 rounded px-2.5 py-1.5 text-slate-700"
            />
          </div>

          <div>
            <label className="block text-slate-600 mb-1">质检组长审核</label>
            <input
              type="text"
              disabled
              value="李审核 (QA Lead)"
              className="w-full bg-slate-50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-500"
            />
          </div>

          <div className="md:col-span-4">
            <label className="block text-slate-600 mb-1">判定备注与核验说明</label>
            <textarea
              rows={2}
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              className="w-full border border-slate-200 rounded p-2 text-xs text-slate-700 focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
          <button
            type="button"
            onClick={onBack}
            className="px-4 py-1.5 rounded border border-slate-200 text-xs text-slate-600 hover:bg-slate-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleOpenCert}
            className="px-4 py-1.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-medium hover:bg-emerald-100 flex items-center gap-1.5"
          >
            <Printer className="w-3.5 h-3.5" /> 预览与打印质保书
          </button>
          {!readOnly && (
            <button
              type="button"
              onClick={handleInternalSubmit}
              className="px-4 py-1.5 rounded bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 shadow-sm"
            >
              提交来料判定结果
            </button>
          )}
        </div>
      </div>

      {/* 质保书导出与打印模态框 */}
      <CertificatePrintModal
        isOpen={printModalOpen}
        onClose={() => setPrintModalOpen(false)}
        type="quality"
        qualityData={certData}
      />
    </div>
  );
};
