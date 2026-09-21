import React, { useState } from 'react';
import { ArrowLeft, Printer, ShieldCheck, Activity, Flame, Layers, CheckCircle2, AlertCircle } from 'lucide-react';
import { CertificatePrintModal } from '../../../components/certificate/CertificatePrintModal';
import { ManufacturingCertData } from '../../../lib/inspectionTypes';

interface OutsourceInspectionFormProps {
  initialItem?: any;
  onBack: () => void;
  onSubmit: (result: any) => void;
}

export const OutsourceInspectionForm: React.FC<OutsourceInspectionFormProps> = ({
  initialItem,
  onBack,
  onSubmit,
}) => {
  // 单据基础字段
  const [vendorName, setVendorName] = useState(initialItem?.vendor || '常州常申表面处理有限公司');
  const [docNo, setDocNo] = useState(initialItem?.docNo || 'WW-20260706-0001');
  const [processType, setProcessType] = useState(initialItem?.process || '达克罗 (Zinc Flake Coating)');
  const [partName, setPartName] = useState(initialItem?.partName || '外六角螺栓 M16×60');
  const [materialGrade, setMaterialGrade] = useState(initialItem?.material || 'ML40Cr / 8.8级');
  const [batchNo, setBatchNo] = useState(initialItem?.batchNo || 'WW-LOT-20260706-01');
  const [quantity, setQuantity] = useState(initialItem?.qty ? `${initialItem.qty} 件` : '3,000 件');
  const [techStandard, setTechStandard] = useState('Q/320281 BZ04-2018 / ISO 10683');
  const [decision, setDecision] = useState<'合格' | '不合格' | '返工'>('合格');
  const [inspector, setInspector] = useState(initialItem?.inspector || '张检验 (QC)');
  const [inspectDate, setInspectDate] = useState('2026-07-06');
  const [conclusion, setConclusion] = useState('表面涂层均匀细腻，无起泡漏镀，膜厚及中性盐雾耐腐试验符合技术规范，去氢回火工艺受控，判定合格。');

  // 1. 表面涂层膜厚实测（5点测试法，μm）
  const [thicknessSpec, setThicknessSpec] = useState('8.0 ~ 12.0');
  const [pt1, setPt1] = useState('9.6');
  const [pt2, setPt2] = useState('10.2');
  const [pt3, setPt3] = useState('9.8');
  const [pt4, setPt4] = useState('10.5');
  const [pt5, setPt5] = useState('9.9');

  // 自动计算平均膜厚
  const avgThickness = (
    (parseFloat(pt1) || 0) +
    (parseFloat(pt2) || 0) +
    (parseFloat(pt3) || 0) +
    (parseFloat(pt4) || 0) +
    (parseFloat(pt5) || 0)
  ) / 5;

  // 2. 耐腐蚀盐雾试验 (NSS)
  const [saltSprayHours, setSaltSprayHours] = useState('720');
  const [saltSprayRequirement, setSaltSprayRequirement] = useState('≥ 720h 无红锈 (No Red Rust)');
  const [saltSprayResult, setSaltSprayResult] = useState('720h 无白锈及红锈，合格');
  const [saltSprayStatus, setSaltSprayStatus] = useState('合格');

  // 3. 划格附着力测试 (Cross-Cut Adhesion)
  const [adhesionSpec, setAdhesionSpec] = useState('≤ 1 级 (ISO 2409 / ASTM D3359)');
  const [adhesionVal, setAdhesionVal] = useState('0 级 (切口边缘完全光滑无剥落)');
  const [adhesionStatus, setAdhesionStatus] = useState('合格');

  // 4. 硬度测试 (Hardness)
  const [coreHardnessSpec, setCoreHardnessSpec] = useState('22 ~ 32 HRC (8.8级要求)');
  const [coreHardnessVal, setCoreHardnessVal] = useState('28.5 HRC');
  const [surfaceHardnessSpec, setSurfaceHardnessSpec] = useState('≤ 320 HV0.3');
  const [surfaceHardnessVal, setSurfaceHardnessVal] = useState('295 HV0.3');
  const [hardnessStatus, setHardnessStatus] = useState('合格');

  // 5. 去氢回火烘烤记录 (Dehydrogenation / Baking)
  const [bakingTemp, setBakingTemp] = useState('200 ~ 220 ℃');
  const [bakingTime, setBakingTime] = useState('≥ 4.0 小时 (4.5h 实测)');
  const [hydrogenEmbrittlement, setHydrogenEmbrittlement] = useState('无氢脆断裂现象，经48h常温预载验证合格');
  const [bakingStatus, setBakingStatus] = useState('合格');

  // 6. 外观与螺纹精度
  const [visualResult, setVisualResult] = useState('银灰色哑光，涂覆均匀，无流挂、附渣、滴瘤');
  const [threadResult, setThreadResult] = useState('6g 通规过，止规止 (螺纹旋合良好)');

  // 打印预览控制
  const [printModalOpen, setPrintModalOpen] = useState(false);
  const [manufacturingCertData, setManufacturingCertData] = useState<ManufacturingCertData | null>(null);

  // 组装最新表单数据为制造业证书格式
  const handleOpenCert = () => {
    const cert: ManufacturingCertData = {
      certificateNo: `MC-${docNo}`,
      date: inspectDate,
      orderNo: docNo,
      vendorName: vendorName,
      processName: processType,
      partName: partName,
      partSpec: initialItem?.spec || 'M16×60-8.8',
      materialGrade: materialGrade,
      batchNo: batchNo,
      quantity: quantity,
      standard: techStandard,
      tests: [
        {
          item: '表面涂层厚度 (Coating Thickness)',
          requirement: `${thicknessSpec} μm`,
          testMethod: 'ISO 2178 / 磁感应法',
          sampleValues: [Number(pt1), Number(pt2), Number(pt3), Number(pt4), Number(pt5)],
          averageValue: `${avgThickness.toFixed(1)} μm`,
          result: 'Pass',
          conclusion: '合格',
        },
        {
          item: '耐中性盐雾腐蚀试验 (Salt Spray Test NSS)',
          requirement: saltSprayRequirement,
          testMethod: 'GB/T 10125 / ASTM B117',
          sampleValues: [],
          averageValue: `${saltSprayHours}h`,
          result: 'Pass',
          conclusion: saltSprayResult,
        },
        {
          item: '涂层附着力 (Adhesion Test)',
          requirement: adhesionSpec,
          testMethod: 'ISO 2409 / 划格胶带法',
          sampleValues: [],
          averageValue: '0 级',
          result: 'Pass',
          conclusion: adhesionVal,
        },
        {
          item: '心部硬度测试 (Core Hardness)',
          requirement: coreHardnessSpec,
          testMethod: 'GB/T 230.1 / 洛氏硬度计',
          sampleValues: [],
          averageValue: coreHardnessVal,
          result: 'Pass',
          conclusion: '合格',
        },
        {
          item: '表面硬度测试 (Surface Hardness)',
          requirement: surfaceHardnessSpec,
          testMethod: 'GB/T 4340.1 / 维氏硬度计',
          sampleValues: [],
          averageValue: surfaceHardnessVal,
          result: 'Pass',
          conclusion: '合格',
        },
        {
          item: '去氢回火烘烤记录 (Dehydrogenation Baking)',
          requirement: `${bakingTemp}, ${bakingTime}`,
          testMethod: '工艺受控曲线监测',
          sampleValues: [],
          averageValue: '210℃ / 4.5h',
          result: 'Pass',
          conclusion: hydrogenEmbrittlement,
        },
        {
          item: '外观质量 (Visual Inspection)',
          requirement: '涂覆均匀，无漏镀、起泡、剥落、钝化不均',
          testMethod: '目测检验 4.0×',
          sampleValues: [],
          averageValue: '良好',
          result: 'Pass',
          conclusion: visualResult,
        },
        {
          item: '外螺纹精度 (Thread Fit)',
          requirement: '螺纹公差 6g',
          testMethod: '螺纹环规 6g 通/止',
          sampleValues: [],
          averageValue: '通进止停',
          result: 'Pass',
          conclusion: threadResult,
        },
      ],
      overallDecision: (decision as string) === '合格' ? 'PASS (合格)' : (decision as string) === '特采' ? 'CONCESSION (特采)' : 'REJECT (不合格)',
      inspectorName: inspector,
      qaManagerName: '王质量 (QA Manager)',
      remarks: conclusion,
    };

    setManufacturingCertData(cert);
    setPrintModalOpen(true);
  };

  const handleSubmitInternal = () => {
    onSubmit({
      vendor: vendorName,
      docNo,
      process: processType,
      decision,
      inspector,
      inspectDate,
      conclusion,
      avgThickness: avgThickness.toFixed(1),
      saltSprayResult,
      adhesionVal,
      coreHardnessVal,
    });
  };

  return (
    <div className="space-y-4">
      {/* 顶部导航与操作栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-blue-600 font-medium"
          >
            <ArrowLeft className="w-4 h-4" /> 返回委外列表
          </button>
          <span className="text-slate-300">|</span>
          <span className="text-sm font-semibold text-slate-800">
            委外检验检视与录入 (MANUFACTURING CERT)
          </span>
          <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-700 text-xs font-mono font-medium border border-amber-200">
            {docNo}
          </span>
          <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-xs font-medium border border-blue-200">
            {processType}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleOpenCert}
            className="px-3.5 py-1.5 rounded bg-indigo-50 border border-indigo-200 text-indigo-700 text-xs font-medium hover:bg-indigo-100 flex items-center gap-1.5 transition-colors shadow-sm"
          >
            <Printer className="w-3.5 h-3.5" /> 预览并导出制造证书 (PDF)
          </button>
        </div>
      </div>

      {/* 模块一：委托外协与物料信息抬头卡片 (对齐 MANUFACTURING CERT Header) */}
      <div className="bg-white border border-slate-200/80 rounded-lg p-4 shadow-sm">
        <div className="flex items-center gap-2 pb-3 mb-3 border-b border-slate-100 text-xs font-semibold text-slate-800">
          <ShieldCheck className="w-4 h-4 text-blue-600" />
          <span>委外受托信息与产品基础属性 (Outsource Order & Material Specs)</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
          <div>
            <label className="block text-slate-500 mb-1">外协加工商 (Processor / Vendor)</label>
            <input
              type="text"
              value={vendorName}
              onChange={(e) => setVendorName(e.target.value)}
              className="w-full bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 font-medium focus:bg-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-slate-500 mb-1">加工工序类别 (Process Category)</label>
            <input
              type="text"
              value={processType}
              onChange={(e) => setProcessType(e.target.value)}
              className="w-full bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 focus:bg-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-slate-500 mb-1">产品名称及规格 (Description & Size)</label>
            <input
              type="text"
              value={partName}
              onChange={(e) => setPartName(e.target.value)}
              className="w-full bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 focus:bg-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-slate-500 mb-1">材质牌号 / 强度等级 (Material Grade)</label>
            <input
              type="text"
              value={materialGrade}
              onChange={(e) => setMaterialGrade(e.target.value)}
              className="w-full bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 focus:bg-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-slate-500 mb-1">委外批次号 (Outsource Batch No)</label>
            <input
              type="text"
              value={batchNo}
              onChange={(e) => setBatchNo(e.target.value)}
              className="w-full bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 focus:bg-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-slate-500 mb-1">委外交付数量 (Processed Qty)</label>
            <input
              type="text"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              className="w-full bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 focus:bg-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-slate-500 mb-1">执行技术标准与工艺规范 (Standard & Specs)</label>
            <input
              type="text"
              value={techStandard}
              onChange={(e) => setTechStandard(e.target.value)}
              className="w-full bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 focus:bg-white focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>
      </div>

      {/* 模块二：表面处理膜厚检测 (5点法实测与平均值自动换算) */}
      <div className="bg-white border border-slate-200/80 rounded-lg p-4 shadow-sm space-y-3">
        <div className="flex items-center justify-between pb-2 border-b border-slate-100 text-xs font-semibold text-slate-800">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-emerald-600" />
            <span>表面处理膜厚 5 点测试 (Coating Thickness Inspection, μm)</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-slate-500 font-normal">标准要求：{thicknessSpec} μm</span>
            <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-bold border border-emerald-200">
              平均实测值：{avgThickness.toFixed(2)} μm
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-6 gap-3 text-xs">
          <div>
            <label className="block text-slate-500 mb-1">测点 1 (μm)</label>
            <input
              type="number"
              step="0.1"
              value={pt1}
              onChange={(e) => setPt1(e.target.value)}
              className="w-full border border-slate-200 rounded px-2 py-1 text-center font-mono font-medium focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-slate-500 mb-1">测点 2 (μm)</label>
            <input
              type="number"
              step="0.1"
              value={pt2}
              onChange={(e) => setPt2(e.target.value)}
              className="w-full border border-slate-200 rounded px-2 py-1 text-center font-mono font-medium focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-slate-500 mb-1">测点 3 (μm)</label>
            <input
              type="number"
              step="0.1"
              value={pt3}
              onChange={(e) => setPt3(e.target.value)}
              className="w-full border border-slate-200 rounded px-2 py-1 text-center font-mono font-medium focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-slate-500 mb-1">测点 4 (μm)</label>
            <input
              type="number"
              step="0.1"
              value={pt4}
              onChange={(e) => setPt4(e.target.value)}
              className="w-full border border-slate-200 rounded px-2 py-1 text-center font-mono font-medium focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-slate-500 mb-1">测点 5 (μm)</label>
            <input
              type="number"
              step="0.1"
              value={pt5}
              onChange={(e) => setPt5(e.target.value)}
              className="w-full border border-slate-200 rounded px-2 py-1 text-center font-mono font-medium focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-slate-500 mb-1">膜厚判定</label>
            <div className="h-7 flex items-center justify-center rounded bg-emerald-50 text-emerald-600 font-medium">
              ✓ 合格
            </div>
          </div>
        </div>
      </div>

      {/* 模块三：理化试验与特种工艺检验 (耐腐盐雾、划格附着力、硬度、去氢回火) */}
      <div className="bg-white border border-slate-200/80 rounded-lg shadow-sm overflow-hidden">
        <div className="px-4 py-3 bg-[#F8FAFC] border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-800">
            <Activity className="w-4 h-4 text-indigo-600" />
            <span>理化试验与工艺验证项 (Physical & Chemical Inspection Items)</span>
          </div>
          <span className="text-[11px] text-slate-500">对照样例二 MANUFACTURING CERT 试验规范</span>
        </div>

        <table className="w-full text-xs text-left">
          <thead className="bg-slate-50 text-slate-600 font-medium border-b border-slate-200">
            <tr>
              <th className="py-2.5 px-4 w-44">检验项目 (Test Item)</th>
              <th className="py-2.5 px-4 w-52">技术规范要求 (Requirement)</th>
              <th className="py-2.5 px-4">实测记录与试验结论 (Test Record / Result)</th>
              <th className="py-2.5 px-4 w-28 text-center">判定</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {/* 盐雾测试 */}
            <tr className="hover:bg-slate-50/50">
              <td className="py-3 px-4 font-medium text-slate-800">
                <div>耐中性盐雾腐蚀 (NSS)</div>
                <div className="text-[10px] text-slate-400">Salt Spray Corrosion Test</div>
              </td>
              <td className="py-3 px-4 text-slate-600">
                <input
                  type="text"
                  value={saltSprayRequirement}
                  onChange={(e) => setSaltSprayRequirement(e.target.value)}
                  className="w-full border border-slate-200 rounded px-2 py-1 text-xs"
                />
              </td>
              <td className="py-3 px-4">
                <input
                  type="text"
                  value={saltSprayResult}
                  onChange={(e) => setSaltSprayResult(e.target.value)}
                  className="w-full border border-slate-200 rounded px-2 py-1 text-xs"
                />
              </td>
              <td className="py-3 px-4 text-center">
                <select
                  value={saltSprayStatus}
                  onChange={(e) => setSaltSprayStatus(e.target.value)}
                  className="border border-slate-200 rounded px-2 py-1 text-xs bg-white text-emerald-600 font-medium"
                >
                  <option value="合格">合格</option>
                  <option value="不合格">不合格</option>
                </select>
              </td>
            </tr>

            {/* 划格附着力 */}
            <tr className="hover:bg-slate-50/50">
              <td className="py-3 px-4 font-medium text-slate-800">
                <div>涂层附着力 (Adhesion)</div>
                <div className="text-[10px] text-slate-400">Cross-Cut Tape Test</div>
              </td>
              <td className="py-3 px-4 text-slate-600">
                <input
                  type="text"
                  value={adhesionSpec}
                  onChange={(e) => setAdhesionSpec(e.target.value)}
                  className="w-full border border-slate-200 rounded px-2 py-1 text-xs"
                />
              </td>
              <td className="py-3 px-4">
                <input
                  type="text"
                  value={adhesionVal}
                  onChange={(e) => setAdhesionVal(e.target.value)}
                  className="w-full border border-slate-200 rounded px-2 py-1 text-xs"
                />
              </td>
              <td className="py-3 px-4 text-center">
                <select
                  value={adhesionStatus}
                  onChange={(e) => setAdhesionStatus(e.target.value)}
                  className="border border-slate-200 rounded px-2 py-1 text-xs bg-white text-emerald-600 font-medium"
                >
                  <option value="合格">合格</option>
                  <option value="不合格">不合格</option>
                </select>
              </td>
            </tr>

            {/* 心部与表面硬度 */}
            <tr className="hover:bg-slate-50/50">
              <td className="py-3 px-4 font-medium text-slate-800">
                <div>热处理硬度 (Hardness)</div>
                <div className="text-[10px] text-slate-400">Core & Surface Hardness</div>
              </td>
              <td className="py-3 px-4 text-slate-600 space-y-1">
                <input
                  type="text"
                  value={coreHardnessSpec}
                  onChange={(e) => setCoreHardnessSpec(e.target.value)}
                  className="w-full border border-slate-200 rounded px-2 py-1 text-xs"
                  placeholder="心部硬度要求"
                />
                <input
                  type="text"
                  value={surfaceHardnessSpec}
                  onChange={(e) => setSurfaceHardnessSpec(e.target.value)}
                  className="w-full border border-slate-200 rounded px-2 py-1 text-xs"
                  placeholder="表面硬度要求"
                />
              </td>
              <td className="py-3 px-4 space-y-1">
                <input
                  type="text"
                  value={coreHardnessVal}
                  onChange={(e) => setCoreHardnessVal(e.target.value)}
                  className="w-full border border-slate-200 rounded px-2 py-1 text-xs"
                  placeholder="心部实测"
                />
                <input
                  type="text"
                  value={surfaceHardnessVal}
                  onChange={(e) => setSurfaceHardnessVal(e.target.value)}
                  className="w-full border border-slate-200 rounded px-2 py-1 text-xs"
                  placeholder="表面实测"
                />
              </td>
              <td className="py-3 px-4 text-center">
                <select
                  value={hardnessStatus}
                  onChange={(e) => setHardnessStatus(e.target.value)}
                  className="border border-slate-200 rounded px-2 py-1 text-xs bg-white text-emerald-600 font-medium"
                >
                  <option value="合格">合格</option>
                  <option value="不合格">不合格</option>
                </select>
              </td>
            </tr>

            {/* 去氢回火记录 */}
            <tr className="hover:bg-slate-50/50">
              <td className="py-3 px-4 font-medium text-slate-800">
                <div className="flex items-center gap-1 text-amber-700">
                  <Flame className="w-3.5 h-3.5" /> 去氢回火烘烤 (Dehydrogenation)
                </div>
                <div className="text-[10px] text-slate-400">Baking Record & Embrittlement</div>
              </td>
              <td className="py-3 px-4 text-slate-600">
                <div className="text-xs text-slate-700">{bakingTemp} / {bakingTime}</div>
                <div className="text-[10px] text-slate-400">电镀后4小时内入炉去氢</div>
              </td>
              <td className="py-3 px-4">
                <input
                  type="text"
                  value={hydrogenEmbrittlement}
                  onChange={(e) => setHydrogenEmbrittlement(e.target.value)}
                  className="w-full border border-slate-200 rounded px-2 py-1 text-xs"
                />
              </td>
              <td className="py-3 px-4 text-center">
                <select
                  value={bakingStatus}
                  onChange={(e) => setBakingStatus(e.target.value)}
                  className="border border-slate-200 rounded px-2 py-1 text-xs bg-white text-emerald-600 font-medium"
                >
                  <option value="合格">合格</option>
                  <option value="不合格">不合格</option>
                </select>
              </td>
            </tr>

            {/* 外观与螺纹精度 */}
            <tr className="hover:bg-slate-50/50">
              <td className="py-3 px-4 font-medium text-slate-800">
                <div>外观与外螺纹精度</div>
                <div className="text-[10px] text-slate-400">Appearance & Thread Fit</div>
              </td>
              <td className="py-3 px-4 text-slate-600">
                <div>目视无漏镀起泡，螺纹通规过、止规止</div>
              </td>
              <td className="py-3 px-4 space-y-1">
                <input
                  type="text"
                  value={visualResult}
                  onChange={(e) => setVisualResult(e.target.value)}
                  className="w-full border border-slate-200 rounded px-2 py-1 text-xs"
                  placeholder="外观结论"
                />
                <input
                  type="text"
                  value={threadResult}
                  onChange={(e) => setThreadResult(e.target.value)}
                  className="w-full border border-slate-200 rounded px-2 py-1 text-xs"
                  placeholder="螺纹环规测试结论"
                />
              </td>
              <td className="py-3 px-4 text-center">
                <span className="px-2 py-1 rounded bg-emerald-50 text-emerald-600 font-medium text-xs">
                  合格
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* 模块四：综合判定与签核签字 */}
      <div className="bg-white border border-slate-200/80 rounded-lg p-4 shadow-sm space-y-3">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
          <span className="text-amber-500">⚖</span>
          <span>委外检验综合判定 (Overall Conclusion & Signatures)</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-xs">
          <div>
            <label className="block text-slate-600 mb-1 font-medium">综合判定结果 <span className="text-red-500">*</span></label>
            <div className="flex items-center gap-2 mt-1.5">
              <label className="inline-flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="outsource_decision"
                  checked={decision === '合格'}
                  onChange={() => setDecision('合格')}
                  className="text-blue-600"
                />
                <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-600 font-medium">
                  ✓ 合格 (Pass)
                </span>
              </label>
              <label className="inline-flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="outsource_decision"
                  checked={decision === '返工'}
                  onChange={() => setDecision('返工')}
                  className="text-blue-600"
                />
                <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-600 font-medium">
                  ↺ 返工
                </span>
              </label>
              <label className="inline-flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="outsource_decision"
                  checked={decision === '不合格'}
                  onChange={() => setDecision('不合格')}
                  className="text-blue-600"
                />
                <span className="px-2 py-0.5 rounded bg-rose-50 text-rose-600 font-medium">
                  ✕ 不合格
                </span>
              </label>
            </div>
          </div>

          <div>
            <label className="block text-slate-600 mb-1">质检检验员 (Inspector)</label>
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
            <label className="block text-slate-600 mb-1">质量负责人 (QA Manager)</label>
            <input
              type="text"
              disabled
              value="王质量 (Arthur Wang)"
              className="w-full bg-slate-50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-500"
            />
          </div>

          <div className="md:col-span-4">
            <label className="block text-slate-600 mb-1">委外检验判定评语 (Remarks / Certificate Notes)</label>
            <textarea
              rows={2}
              value={conclusion}
              onChange={(e) => setConclusion(e.target.value)}
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
            className="px-4 py-1.5 rounded bg-indigo-50 border border-indigo-200 text-indigo-700 text-xs font-medium hover:bg-indigo-100 flex items-center gap-1.5"
          >
            <Printer className="w-3.5 h-3.5" /> 生成制造证书
          </button>
          <button
            type="button"
            onClick={handleSubmitInternal}
            className="px-4 py-1.5 rounded bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 shadow-sm"
          >
            保存并提交委外判定
          </button>
        </div>
      </div>

      {/* 委外制造证书 PDF 打印预览弹窗 */}
      <CertificatePrintModal
        isOpen={printModalOpen}
        onClose={() => setPrintModalOpen(false)}
        type="manufacturing"
        manufacturingData={manufacturingCertData}
      />
    </div>
  );
};
