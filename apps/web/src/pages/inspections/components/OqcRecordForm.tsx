import React, { useState, useEffect } from "react";
import { ArrowLeft, Printer, ShieldCheck, Atom, Gauge, CheckSquare, Layers, Sparkles, AlertTriangle, FileSpreadsheet } from "lucide-react";
import { CertificatePrintModal } from "../../../components/certificate/CertificatePrintModal";
import { PrintTemplateModal } from "../../../components/common/PrintTemplateModal";
import { QualityCertificateData } from "../../../lib/inspectionTypes";
import { api } from "../../../lib/api";

interface OqcRecordFormProps {
  initialItem?: any;
  onBack: () => void;
  onSubmit: (result: any) => void;
}

export const OqcRecordForm: React.FC<OqcRecordFormProps> = ({ initialItem, onBack, onSubmit }) => {
  // 基础合同与出货交付信息 (质量保证证书 Header)
  const [certNo, setCertNo] = useState(initialItem?.no || "QC-2026-07-0062");
  const [orderNo, setOrderNo] = useState(initialItem?.doc || "PO-202606-889");
  const [deliveryNo, setDeliveryNo] = useState(initialItem?.deliveryNo || "DO-20260706-003");
  const [customer, setCustomer] = useState(initialItem?.client || "江阴开益特种压缩机有限公司");
  const [productName, setProductName] = useState(initialItem?.name || "双头螺柱 (粗杆)");
  const [spec, setSpec] = useState(initialItem?.spec || "M20×55-8.8");
  const [standard, setStandard] = useState("GB/T 899-1988 / GB/T 3098.1");
  const [materialGrade, setMaterialGrade] = useState("ML40Cr");
  const [heatNo, setHeatNo] = useState(initialItem?.heatNo || "HN-20260518-03");
  const [lotNo, setLotNo] = useState(initialItem?.lotNo || "LOT-20260706-002");
  const [quantity, setQuantity] = useState(initialItem?.qty || "546 件");
  const [deliveryStatus, setDeliveryStatus] = useState("调质淬回火 (QT)");

  // 炉批号追溯联动状态与修改追踪
  const [heatTraceLoading, setHeatTraceLoading] = useState(false);
  const [heatTraceSource, setHeatTraceSource] = useState<{
    sourceType: string;
    sourceOrderNo?: string;
    batchNo: string;
  } | null>(null);
  const [inheritedValues, setInheritedValues] = useState<Record<string, string>>({});
  const [modifiedItems, setModifiedItems] = useState<Set<string>>(new Set());

  // 1. 化学成分全项 (Chemical Composition, %)
  const [chemElements, setChemElements] = useState([
    { element: "C", standard: "0.37 ~ 0.44", actual: "0.40", unit: "%", result: "合格" },
    { element: "Si", standard: "0.17 ~ 0.37", actual: "0.24", unit: "%", result: "合格" },
    { element: "Mn", standard: "0.50 ~ 0.80", actual: "0.66", unit: "%", result: "合格" },
    { element: "Cr", standard: "0.80 ~ 1.10", actual: "0.98", unit: "%", result: "合格" },
    { element: "P", standard: "≤ 0.030", actual: "0.013", unit: "%", result: "合格" },
    { element: "S", standard: "≤ 0.030", actual: "0.007", unit: "%", result: "合格" },
    { element: "Ni", standard: "≤ 0.30", actual: "0.04", unit: "%", result: "合格" },
    { element: "Mo", standard: "≤ 0.15", actual: "0.02", unit: "%", result: "合格" },
  ]);

  // 2. 机械物理性能全项 (Mechanical & Physical Properties)
  const [mechProperties, setMechProperties] = useState([
    { item: "抗拉强度 Rm", standard: "800 ~ 1000", actual: "895", unit: "MPa", result: "合格" },
    { item: "屈服强度 Rp0.2", standard: "≥ 640", actual: "730", unit: "MPa", result: "合格" },
    { item: "断后伸长率 A", standard: "≥ 12.0", actual: "15.5", unit: "%", result: "合格" },
    { item: "断面收缩率 Z", standard: "≥ 52.0", actual: "58.0", unit: "%", result: "合格" },
    { item: "冲击吸收能量 KV2", standard: "≥ 27 (-20℃)", actual: "46", unit: "J", result: "合格" },
    { item: "洛氏硬度 HRC", standard: "22 ~ 32", actual: "28.5", unit: "HRC", result: "合格" },
    { item: "脱碳层深度 G", standard: "≤ 0.015", actual: "0.008", unit: "mm", result: "合格" },
  ]);

  // 3. 尺寸公差与外观全项 (Dimensions & Visual)
  const [dimItems, setDimItems] = useState([
    { item: "旋入端螺纹中径", standard: "6g (18.163~18.334)", actual: "18.250", unit: "mm", result: "合格" },
    { item: "螺母端螺纹中径", standard: "6g (18.163~18.334)", actual: "18.245", unit: "mm", result: "合格" },
    { item: "螺柱总公称长度 L", standard: "55.0 ± 0.60", actual: "55.15", unit: "mm", result: "合格" },
    { item: "光杆直径 ds", standard: "20.0 ± 0.25", actual: "19.92", unit: "mm", result: "合格" },
    { item: "表面处理与防锈", standard: "无锈斑划伤，发黑油封均匀", actual: "符合规范", unit: "目测", result: "合格" },
  ]);

  // 综合判定与签发
  const [decision, setDecision] = useState<"合格" | "不合格" | "特采">("合格");
  const [inspector, setInspector] = useState("张检验 (QC)");
  const [inspectDate, setInspectDate] = useState("2026-07-06");
  const [conclusion, setConclusion] = useState(
    "经对本批次产品进行化学成分复验、全项机械力学试验、高倍金相组织、几何尺寸公差及表面外观检验，全部符合 GB/T 899 及客户图纸订货技术条件，综合判定为合格，准予出厂。"
  );

  // 打印预览控制
  const [certModalOpen, setCertModalOpen] = useState(false);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [certData, setCertData] = useState<QualityCertificateData | null>(null);

  // 自动防抖调用 /api/v1/inspections/heat-batch-trace 追溯原材料与热处理历史数据
  useEffect(() => {
    if (!heatNo || !heatNo.trim()) {
      setHeatTraceSource(null);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        setHeatTraceLoading(true);
        const res = await api.get<{
          heatBatchNo: string;
          sourceType: "OUTSOURCE_HEAT_ORDER" | "IQC_ORDER" | "NONE";
          sourceOrderNo?: string;
          inheritedItems: Array<{
            itemCode: string;
            name: string;
            metricCategory: string;
            measuredVal?: number;
            measuredText?: string;
            unit?: string;
          }>;
        }>(`/inspections/heat-batch-trace?heatBatchNo=${encodeURIComponent(heatNo.trim())}`);

        if (res && res.inheritedItems && res.inheritedItems.length > 0) {
          setHeatTraceSource({
            sourceType: res.sourceType,
            sourceOrderNo: res.sourceOrderNo,
            batchNo: res.heatBatchNo,
          });

          const newInherited: Record<string, string> = {};

          // 带出化学成分
          setChemElements((prev) =>
            prev.map((el) => {
              const matched = res.inheritedItems.find(
                (item) =>
                  item.name.toUpperCase() === el.element.toUpperCase() ||
                  item.itemCode.toUpperCase().includes(el.element.toUpperCase())
              );
              if (matched) {
                const val =
                  matched.measuredVal !== undefined
                    ? String(matched.measuredVal)
                    : matched.measuredText ?? el.actual;
                newInherited[`chem_${el.element}`] = val;
                return { ...el, actual: val };
              }
              return el;
            })
          );

          // 带出力学性能
          setMechProperties((prev) =>
            prev.map((mp) => {
              const matched = res.inheritedItems.find(
                (item) =>
                  item.name.includes(mp.item) ||
                  mp.item.includes(item.name) ||
                  (mp.item.includes("抗拉") && item.name.includes("抗拉")) ||
                  (mp.item.includes("屈服") && item.name.includes("屈服")) ||
                  (mp.item.includes("伸长率") && item.name.includes("伸长率")) ||
                  (mp.item.includes("硬度") && item.name.includes("硬度")) ||
                  (mp.item.includes("冲击") && item.name.includes("冲击"))
              );
              if (matched) {
                const val =
                  matched.measuredVal !== undefined
                    ? String(matched.measuredVal)
                    : matched.measuredText ?? mp.actual;
                newInherited[`mech_${mp.item}`] = val;
                return { ...mp, actual: val };
              }
              return mp;
            })
          );

          setInheritedValues(newInherited);
          setModifiedItems(new Set());
        }
      } catch (e) {
        console.warn("未能匹配到该炉号的前序溯源单据", e);
      } finally {
        setHeatTraceLoading(false);
      }
    }, 450);

    return () => clearTimeout(timer);
  }, [heatNo]);

  const handleChemChange = (idx: number, element: string, val: string) => {
    const updated = [...chemElements];
    updated[idx].actual = val;
    setChemElements(updated);

    const key = `chem_${element}`;
    const orig = inheritedValues[key];
    const newModified = new Set(modifiedItems);
    if (orig !== undefined && val !== orig) {
      newModified.add(key);
    } else {
      newModified.delete(key);
    }
    setModifiedItems(newModified);
  };

  const handleMechChange = (idx: number, item: string, val: string) => {
    const updated = [...mechProperties];
    updated[idx].actual = val;
    setMechProperties(updated);

    const key = `mech_${item}`;
    const orig = inheritedValues[key];
    const newModified = new Set(modifiedItems);
    if (orig !== undefined && val !== orig) {
      newModified.add(key);
    } else {
      newModified.delete(key);
    }
    setModifiedItems(newModified);
  };

  // 组装质量保证证书数据 (EN 10204 3.1)
  const handleOpenCert = () => {
    const cert: QualityCertificateData = {
      certNo: certNo,
      date: inspectDate,
      customer: customer,
      contractNo: orderNo,
      deliveryNo: deliveryNo,
      productName: productName,
      standard: standard,
      spec: spec,
      materialGrade: materialGrade,
      heatNo: heatNo,
      lotNo: lotNo,
      deliveryStatus: deliveryStatus,
      quantity: quantity,
      chemicalComposition: {
        elements: chemElements.map((el) => ({
          element: el.element,
          standard: el.standard,
          actual: el.actual,
          unit: el.unit,
        })),
      },
      mechanicalProperties: {
        items: mechProperties.map((mp) => ({
          name: mp.item,
          standard: mp.standard,
          actual: mp.actual,
          unit: mp.unit,
          result: mp.result,
        })),
      },
      dimensionalAndVisual: {
        items: dimItems.map((di) => ({
          name: di.item,
          standard: di.standard,
          actual: di.actual,
          unit: di.unit,
          result: di.result,
        })),
      },
      generalConclusion: conclusion,
      inspector: inspector,
      approver: "陈总工程师",
    };
    setCertData(cert);
    setCertModalOpen(true);
  };

  return (
    <div className="space-y-4 max-w-7xl mx-auto pb-12">
      {/* 顶部工具栏 */}
      <div className="flex items-center justify-between bg-white border border-slate-200/80 rounded-lg px-5 py-3.5 shadow-sm">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="p-1.5 rounded hover:bg-slate-100 text-slate-500 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-slate-900">
                出货成品质量检验与合格证书编制 (OQC 综合评定)
              </h2>
              <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-blue-50 text-blue-700 border border-blue-200">
                EN 10204 3.1 质保证书就绪
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              单号: {certNo} | 关联合同: {orderNo} | 交付编号: {deliveryNo}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setTemplateModalOpen(true)}
            className="px-3.5 py-1.5 rounded bg-blue-50 border border-blue-200 text-blue-700 text-xs font-medium hover:bg-blue-100 flex items-center gap-1.5 transition-colors shadow-sm"
          >
            <Printer className="w-3.5 h-3.5" /> 多模板打印与分段导出
          </button>
          <button
            type="button"
            onClick={handleOpenCert}
            className="px-3.5 py-1.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-medium hover:bg-emerald-100 flex items-center gap-1.5 transition-colors shadow-sm"
          >
            <ShieldCheck className="w-3.5 h-3.5" /> 预览标准质保书 (PDF)
          </button>
        </div>
      </div>

      {/* 炉批号溯源联动提示 Banner */}
      {heatTraceSource && (
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-3 flex items-center justify-between text-xs text-blue-900 shadow-sm">
          <div className="flex items-center gap-2.5">
            <span className="font-bold bg-blue-600 text-white px-2 py-0.5 rounded text-[11px] flex items-center gap-1">
              <Sparkles className="w-3 h-3" />
              {heatTraceSource.sourceType === "OUTSOURCE_HEAT_ORDER"
                ? "委外热处理"
                : "来料检验 (IQC)"}{" "}
              炉批号溯源联动
            </span>
            <span>
              已依据炉号 <strong>{heatTraceSource.batchNo}</strong> 自动带入前道工序真实检验数据
              {heatTraceSource.sourceOrderNo && ` (源单据: ${heatTraceSource.sourceOrderNo})`}
            </span>
          </div>
          {modifiedItems.size > 0 ? (
            <span className="bg-amber-100 border border-amber-300 text-amber-900 px-2.5 py-1 rounded text-[11px] font-bold flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
              已手动修改 {modifiedItems.size} 项指标 (将自动保留快照并留痕审计)
            </span>
          ) : (
            <span className="text-[11px] text-blue-600 font-medium">
              ✓ 数据与上游档案完全一致
            </span>
          )}
        </div>
      )}

      {/* 模块一：合同发货基础信息 */}
      <div className="bg-white border border-slate-200/80 rounded-lg p-4 shadow-sm space-y-4">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-800 border-b border-slate-100 pb-2">
          <CheckSquare className="w-4 h-4 text-blue-600" />
          <span>订单与出货交付标的</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-xs">
          <div>
            <label className="block text-slate-500 mb-1">采购合同/订单号 (Order No)</label>
            <input
              type="text"
              value={orderNo}
              onChange={(e) => setOrderNo(e.target.value)}
              className="w-full bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 focus:bg-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-slate-500 mb-1 flex items-center justify-between">
              <span>原材料炉批号 (Heat No) ★</span>
              {heatTraceLoading && <span className="text-[10px] text-blue-500 animate-pulse">正在溯源数据...</span>}
            </label>
            <input
              type="text"
              value={heatNo}
              onChange={(e) => setHeatNo(e.target.value)}
              placeholder="输入炉号自动带出化学与力学性能"
              className="w-full bg-slate-50/50 border border-blue-300 rounded px-2.5 py-1.5 text-slate-900 font-mono font-bold focus:bg-white focus:outline-none focus:border-blue-600"
            />
          </div>
          <div>
            <label className="block text-slate-500 mb-1">出厂发货数量 (Delivery Qty)</label>
            <input
              type="text"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              className="w-full bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 focus:bg-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-slate-500 mb-1">执行产品技术标准</label>
            <input
              type="text"
              value={standard}
              onChange={(e) => setStandard(e.target.value)}
              className="w-full bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 focus:bg-white focus:outline-none focus:border-blue-500 font-mono"
            />
          </div>
        </div>
      </div>

      {/* 模块二：化学成分全项检验表 (Chemical Composition) */}
      <div className="bg-white border border-slate-200/80 rounded-lg shadow-sm overflow-hidden">
        <div className="px-4 py-3 bg-[#F8FAFC] border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-800">
            <Atom className="w-4 h-4 text-purple-600" />
            <span>化学成分检验分析 (Chemical Composition, %)</span>
            {modifiedItems.size > 0 && Array.from(modifiedItems).some(k => k.startsWith("chem_")) && (
              <span className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.2 rounded border border-amber-300">
                含手动调整指标
              </span>
            )}
          </div>
          <span className="text-[11px] text-slate-500">依据材料标准全元素光谱复验</span>
        </div>
        <div className="p-4 grid grid-cols-2 sm:grid-cols-4 md:grid-cols-8 gap-3 text-xs">
          {chemElements.map((el, idx) => {
            const key = `chem_${el.element}`;
            const isMod = modifiedItems.has(key);
            return (
              <div
                key={el.element}
                className={`border rounded-lg p-2.5 text-center space-y-1 transition-all ${
                  isMod
                    ? "border-amber-400 bg-amber-50/40 shadow-sm ring-1 ring-amber-300"
                    : "border-slate-200 bg-slate-50/30"
                }`}
              >
                <div className="font-bold text-slate-800 text-sm flex items-center justify-center gap-1">
                  <span>{el.element}</span>
                  {isMod && (
                    <span className="text-[9px] bg-amber-200 text-amber-800 px-1 rounded font-normal" title={`原溯源值: ${inheritedValues[key]}`}>
                      改
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-slate-400">标准: {el.standard}</div>
                <input
                  type="text"
                  value={el.actual}
                  onChange={(e) => handleChemChange(idx, el.element, e.target.value)}
                  className={`w-full bg-white border rounded px-1.5 py-0.5 text-center font-mono font-medium text-xs focus:outline-none ${
                    isMod ? "border-amber-400 text-amber-900 font-bold" : "border-slate-300 focus:border-blue-500"
                  }`}
                />
                <div className="text-[10px] text-emerald-600 font-medium">✓ 符合要求</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 模块三：机械力学与物理性能试验 (Mechanical & Physical Properties) */}
      <div className="bg-white border border-slate-200/80 rounded-lg shadow-sm overflow-hidden">
        <div className="px-4 py-3 bg-[#F8FAFC] border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-800">
            <Gauge className="w-4 h-4 text-blue-600" />
            <span>力学物理性能检验试验 (Mechanical & Physical Properties)</span>
            {modifiedItems.size > 0 && Array.from(modifiedItems).some(k => k.startsWith("mech_")) && (
              <span className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.2 rounded border border-amber-300">
                含手动调整指标
              </span>
            )}
          </div>
          <span className="text-[11px] text-slate-500">拉伸机、冲击试验机、硬度计实测试验</span>
        </div>
        <table className="w-full text-xs text-left">
          <thead className="bg-slate-50 text-slate-600 font-medium border-b border-slate-200">
            <tr>
              <th className="py-2.5 px-4 w-48">试验项目 (Test Item)</th>
              <th className="py-2.5 px-4 w-28">单位</th>
              <th className="py-2.5 px-4 w-52">标准技术规范 (Standard Requirement)</th>
              <th className="py-2.5 px-4">实际测试值 (Actual Value)</th>
              <th className="py-2.5 px-4 w-32 text-center">单项判定</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {mechProperties.map((item, idx) => {
              const key = `mech_${item.item}`;
              const isMod = modifiedItems.has(key);
              return (
                <tr key={item.item} className={`hover:bg-slate-50/50 ${isMod ? "bg-amber-50/20" : ""}`}>
                  <td className="py-2.5 px-4 font-medium text-slate-800">
                    <div className="flex items-center gap-1.5">
                      <span>{item.item}</span>
                      {isMod && (
                        <span className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.2 rounded font-medium border border-amber-300">
                          ✎ 已手动修改 (原值: {inheritedValues[key]})
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-2.5 px-4 text-slate-500">{item.unit}</td>
                  <td className="py-2.5 px-4 text-slate-600 font-mono">{item.standard}</td>
                  <td className="py-2.5 px-4">
                    <input
                      type="text"
                      value={item.actual}
                      onChange={(e) => handleMechChange(idx, item.item, e.target.value)}
                      className={`w-48 bg-white border rounded px-2 py-1 font-mono font-medium text-xs focus:outline-none ${
                        isMod ? "border-amber-400 text-amber-900 bg-amber-50/30 ring-1 ring-amber-300" : "border-slate-200 focus:border-blue-500"
                      }`}
                    />
                  </td>
                  <td className="py-2.5 px-4 text-center">
                    <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                      {item.result}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 模块四：几何尺寸与外观检验 */}
      <div className="bg-white border border-slate-200/80 rounded-lg shadow-sm overflow-hidden">
        <div className="px-4 py-3 bg-[#F8FAFC] border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-800">
            <Layers className="w-4 h-4 text-teal-600" />
            <span>几何尺寸公差及表面外观复验</span>
          </div>
          <span className="text-[11px] text-slate-500">外径千分尺、螺纹通止规、投影仪检验</span>
        </div>
        <table className="w-full text-xs text-left">
          <thead className="bg-slate-50 text-slate-600 font-medium border-b border-slate-200">
            <tr>
              <th className="py-2.5 px-4 w-48">检验项目</th>
              <th className="py-2.5 px-4 w-28">单位</th>
              <th className="py-2.5 px-4 w-52">设计公差规范</th>
              <th className="py-2.5 px-4">实际复验测量值</th>
              <th className="py-2.5 px-4 w-32 text-center">单项判定</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {dimItems.map((item, idx) => (
              <tr key={item.item} className="hover:bg-slate-50/50">
                <td className="py-2.5 px-4 font-medium text-slate-800">{item.item}</td>
                <td className="py-2.5 px-4 text-slate-500">{item.unit}</td>
                <td className="py-2.5 px-4 text-slate-600 font-mono">{item.standard}</td>
                <td className="py-2.5 px-4">
                  <input
                    type="text"
                    value={item.actual}
                    onChange={(e) => {
                      const updated = [...dimItems];
                      updated[idx].actual = e.target.value;
                      setDimItems(updated);
                    }}
                    className="w-48 bg-white border border-slate-200 rounded px-2 py-1 font-mono font-medium focus:border-blue-500"
                  />
                </td>
                <td className="py-2.5 px-4 text-center">
                  <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                    {item.result}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 底部综合判定与操作区 */}
      <div className="bg-white border border-slate-200/80 rounded-lg p-4 shadow-sm flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold text-slate-700">综合判定结论:</span>
          <div className="flex gap-2">
            {(["合格", "不合格", "特采"] as const).map((dec) => (
              <button
                key={dec}
                type="button"
                onClick={() => setDecision(dec)}
                className={`px-3 py-1 rounded text-xs font-bold transition-all ${
                  decision === dec
                    ? dec === "合格"
                      ? "bg-emerald-600 text-white shadow-sm"
                      : "bg-red-600 text-white shadow-sm"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {dec}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="px-4 py-1.5 rounded border border-slate-300 text-slate-600 text-xs font-medium hover:bg-slate-50"
          >
            返回
          </button>
          <button
            type="button"
            onClick={() => setTemplateModalOpen(true)}
            className="px-4 py-1.5 rounded bg-blue-50 border border-blue-200 text-blue-700 text-xs font-medium hover:bg-blue-100 flex items-center gap-1.5"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" /> 打印质检报告 (多模板)
          </button>
          <button
            type="button"
            onClick={handleOpenCert}
            className="px-4 py-1.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-medium hover:bg-emerald-100 flex items-center gap-1.5"
          >
            <Printer className="w-3.5 h-3.5" /> 预览与打印质保书
          </button>
          <button
            type="button"
            onClick={() =>
              onSubmit({
                certNo,
                orderNo,
                decision,
                modifiedItems: Array.from(modifiedItems),
                inspector,
              })
            }
            className="px-5 py-1.5 rounded bg-blue-600 text-white text-xs font-medium hover:bg-blue-500 shadow-sm"
          >
            提交出货检验单
          </button>
        </div>
      </div>

      {/* 弹窗一：质量保证证书 (EN 10204 3.1) */}
      <CertificatePrintModal
        isOpen={certModalOpen}
        onClose={() => setCertModalOpen(false)}
        type="quality"
        qualityData={certData}
      />

      {/* 弹窗二：多模板四段式打印选择弹窗 (PrintTemplateModal) */}
      <PrintTemplateModal
        open={templateModalOpen}
        onClose={() => setTemplateModalOpen(false)}
        orderNo={certNo}
        inspectionType="OQC"
        initialData={{
          productName,
          heatNo,
          materialName: productName,
          batchNo: heatNo,
          orderNo: certNo,
          chemElements,
          mechProperties,
          dimItems,
        }}
      />
    </div>
  );
};
