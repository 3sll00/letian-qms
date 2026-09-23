import React, { useEffect, useState } from 'react';
import { ArrowLeft, Printer, ShieldCheck, Activity, Flame, Layers, ClipboardList } from 'lucide-react';
import { CertificatePrintModal } from '../../../components/certificate/CertificatePrintModal';
import { PlanMatchBanner } from '../../../components/common/PlanMatchBanner';
import { ApprovalButton } from '../../../components/common/ApprovalButton';
import { ManufacturingCertData, OutsourceTestResult } from '../../../lib/inspectionTypes';
import { useMatchedPlan } from '../../../hooks/useMatchedPlan';
import {
  DECISION_LABEL,
  judgeIndicatorRow,
  parseMeasuredNumber,
  summarizeJudgements,
  type PlanIndicatorRow,
} from '../../../lib/planMatch';
import type { InspectionType } from '@letian/contracts';
import { api, errorMessage } from '../../../lib/api';
import { loadCompanyProfile, type CompanyProfile } from '../../../lib/companyProfile';

interface OutsourceInspectionFormProps {
  initialItem?: any;
  /** 只读回看（TBD-07）：已判定的委外单按本单方案快照回看，不按当前生效方案重算 */
  readOnly?: boolean;
  onBack: () => void;
  onSubmit: (result: any) => void;
}

/**
 * 列表行回填到可编辑输入框时的归一化：
 * 列表用 `-` 表示「无值」这一展示占位，不能把它当成真实数据带进表单，
 * 否则录入人会把占位符当成已填内容，甚至原样提交 / 打印。
 */
function fromList(value?: string | null): string {
  return value !== undefined && value !== null && value !== '-' ? value : '';
}

/** 检验日期默认取「今天」：录入动作真实发生日，不是编造的演示日期 */
function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 从本单命中的方案指标行里按关键词取**第一条**命中行。
 *
 * 口径（docs/34 §4）：表单上的「技术规范要求」就是方案指标的标准要求在录入页的呈现，
 * 必须由方案驱动（录入时 = 当前生效方案；只读回看 = 本单方案快照）；方案里没有该指标
 * 即留空，绝不再回落到原型常量（`8.0 ~ 12.0` / `≥ 720h 无红锈` / `22 ~ 32 HRC` / `200 ~ 220 ℃` …）。
 */
function matchPlanRow(rows: PlanIndicatorRow[], keywords: readonly string[]): PlanIndicatorRow | undefined {
  return rows.find((row) => {
    const haystack = `${row.title} ${row.name} ${row.itemCode}`.toUpperCase();
    return keywords.some((keyword) => haystack.includes(keyword.toUpperCase()));
  });
}

/** 交付数量文本（如 `500 PCS`）里取数值部分；取不到返回 null（不假设任何默认批量） */
function parseQuantity(text: string): number | null {
  const matched = text.replace(/,/g, '').match(/\d+(\.\d+)?/);
  return matched === null ? null : Number(matched[0]);
}

/** 综合判定 -> 检验单状态（状态机口径见 @letian/domain 的 InspectionStateMachine） */
const DECISION_TO_STATUS: Readonly<Record<'合格' | '不合格' | '返工', string>> = {
  合格: 'PASSED',
  不合格: 'FAILED',
  返工: 'RE_INSPECTING',
};

/**
 * 规范文本 + 单位（docs/34 §4「命中指标行的 standard + 单位」）：
 * 方案文本里已经写了单位（如「局部≥8μm」）就不再重复追加，避免打印成「局部≥8μm μm」。
 */
function withUnit(standardText: string, unit: string, fallbackUnit: string): string {
  const text = standardText.trim();
  if (text === '') return '';
  const resolved = unit.trim() !== '' ? unit.trim() : fallbackUnit;
  if (resolved === '' || text.includes(resolved)) return text;
  return text + ' ' + resolved;
}

/**
 * 单项判定 -> 证书 Decision 文案（docs/34 §5.2）。
 *
 * 取值优先级：方案指标行的判标结果（真实实测值 + 方案标准的判定）→ 该分项录入人显式选择的下拉结论；
 * 两者都没有结论即返回空串 —— 证书该格留白，绝不打印未经检验的「PASS」。
 */
function decisionText(planRow: PlanIndicatorRow | undefined, explicit: string): '' | 'Pass' | 'Fail' {
  if (planRow !== undefined) {
    const judged = judgeIndicatorRow(planRow);
    if (judged === 'PASSED') return 'Pass';
    if (judged === 'FAILED') return 'Fail';
  }
  if (explicit === '合格') return 'Pass';
  if (explicit === '不合格') return 'Fail';
  return '';
}

/** 判定徽标样式 / 文案：未判定一律浅灰「未判定」，不显示绿色「✓ 合格」 */
function decisionBadgeClass(decision: '' | 'Pass' | 'Fail'): string {
  if (decision === 'Pass') return 'bg-emerald-50 text-emerald-600 border-emerald-200';
  if (decision === 'Fail') return 'bg-rose-50 text-rose-600 border-rose-200';
  return 'bg-slate-100 text-slate-500 border-slate-200';
}

function decisionBadgeText(decision: '' | 'Pass' | 'Fail'): string {
  if (decision === 'Pass') return '✓ 合格';
  if (decision === 'Fail') return '✕ 不合格';
  return '未判定';
}

export const OutsourceInspectionForm: React.FC<OutsourceInspectionFormProps> = ({
  initialItem,
  readOnly = false,
  onBack,
  onSubmit,
}) => {
  // 单据基础字段
  //
  // 口径（docs/33-委外检验录入表单演示值清理与编码族收敛设计.md §2.1）：抬头字段**一律只由
  // 真实数据源填充** —— 台账列表行 (initialItem) 或只读回看的本单方案快照 (planMatch.order，
  // 见下方「按本单真实值回填」的 useEffect)；两者都没有来源即保持空串，由录入人在界面上按
  // 占位提示填写。历史实现给每个字段预置了演示值（加工商「常州常申表面处理有限公司」、单号
  // 「WW-20260706-0001」、批号「WW-LOT-20260706-01」、数量「3,000 件」等），会让界面看起来
  // "已经有真实数据"，新建录入时甚至会被当成本单真实值提交与打印 —— 与「不用演示值冒充
  // 真实台账」的口径冲突，故一律移除。
  const [vendorName, setVendorName] = useState(fromList(initialItem?.vendor));
  const [docNo, setDocNo] = useState(fromList(initialItem?.docNo));
  const [outsourceNo, setOutsourceNo] = useState(fromList(initialItem?.outsourceNo));
  const [processType, setProcessType] = useState(fromList(initialItem?.process ?? initialItem?.processType));
  const [partName, setPartName] = useState(fromList(initialItem?.materialName ?? initialItem?.partName));
  const [spec, setSpec] = useState(fromList(initialItem?.specification ?? initialItem?.spec));
  const [materialGrade, setMaterialGrade] = useState(fromList(initialItem?.materialGrade ?? initialItem?.material));
  const [batchNo, setBatchNo] = useState(fromList(initialItem?.batchNo));
  const [quantity, setQuantity] = useState(
    initialItem?.qty !== undefined && initialItem?.qty !== null && initialItem?.qty !== ''
      ? `${initialItem.qty}${initialItem.unit ? ` ${initialItem.unit}` : ''}`
      : ''
  );
  // 执行技术标准在检验单与列表行上都没有真实字段，留空由录入人按本单方案填写（不编造标准号）
  const [techStandard, setTechStandard] = useState('');
  // 综合判定**不预置结论**（docs/34 §6.2）：未选择前保持空串，三选一无人勾选，提交时强制显式选择。
  // 历史实现默认 `合格`，会把尚未检验的单据判成合格并写进制造证书与检验单状态。
  const [decision, setDecision] = useState<'' | '合格' | '不合格' | '返工'>('');
  const [inspector, setInspector] = useState(fromList(initialItem?.inspector));
  // 检验日期默认「今天」：录入动作真实发生日；历史默认值 `2026-07-06` 是编造的固定日期
  const [inspectDate, setInspectDate] = useState(todayIsoDate());
  // 判定评语不预置演示结论文案（原默认值是一段"判定合格"的文字，会让尚未检验的空白单据
  // 看起来已经判过并被打印进制造证书）
  const [conclusion, setConclusion] = useState('');

  // 1. 表面涂层膜厚实测（5点测试法，μm）
  //
  // 「技术规范要求」属录入规范项（与方案指标行「标准要求」同性质）保留；
  // 实测测点一律留空 —— 历史实现预置的 9.6 / 10.2 / 9.8 / 10.5 / 9.9 会被制造证书
  // 打印成"已测出结果"，属用演示值冒充真实检验数据。
  // 「技术规范要求」一律由方案指标驱动（见下方 matchPlanRow 的同步 useEffect），初值空
  const [thicknessSpec, setThicknessSpec] = useState('');
  const [pt1, setPt1] = useState('');
  const [pt2, setPt2] = useState('');
  const [pt3, setPt3] = useState('');
  const [pt4, setPt4] = useState('');
  const [pt5, setPt5] = useState('');

  // 平均膜厚：只按**已填写**的测点求平均；一个测点都没有时不给数值（不再显示 0.00 μm ——
  // 那是「没测过」被算成「实测 0」的编造值）
  const thicknessPoints = [pt1, pt2, pt3, pt4, pt5]
    .map((value) => parseFloat(value))
    .filter((value) => !Number.isNaN(value));
  const avgThickness =
    thicknessPoints.length > 0
      ? thicknessPoints.reduce((sum, value) => sum + value, 0) / thicknessPoints.length
      : null;

  // 2. 耐腐蚀盐雾试验 (NSS)
  const [saltSprayRequirement, setSaltSprayRequirement] = useState('');
  const [saltSprayResult, setSaltSprayResult] = useState('');
  const [saltSprayStatus, setSaltSprayStatus] = useState('');

  // 3. 划格附着力测试 (Cross-Cut Adhesion)
  const [adhesionSpec, setAdhesionSpec] = useState('');
  const [adhesionVal, setAdhesionVal] = useState('');
  const [adhesionStatus, setAdhesionStatus] = useState('');

  // 4. 硬度测试 (Hardness)
  const [coreHardnessSpec, setCoreHardnessSpec] = useState('');
  const [coreHardnessVal, setCoreHardnessVal] = useState('');
  const [surfaceHardnessSpec, setSurfaceHardnessSpec] = useState('');
  const [surfaceHardnessVal, setSurfaceHardnessVal] = useState('');
  const [hardnessStatus, setHardnessStatus] = useState('');

  // 5. 去氢回火烘烤记录 (Dehydrogenation / Baking)
  //    规范原文（温度 + 时间）合并为一栏「去氢回火规范」，整栏由方案指标驱动（docs/34 §4）
  const [bakingSpec, setBakingSpec] = useState('');
  const [hydrogenEmbrittlement, setHydrogenEmbrittlement] = useState('');
  const [bakingStatus, setBakingStatus] = useState('');

  // 6. 外观与螺纹精度
  //    外观规范同样只由方案指标驱动（docs/34 §4）：命中「外观 / 做工」指标即取其 standard，未命中留空
  const [visualSpec, setVisualSpec] = useState('');
  const [visualResult, setVisualResult] = useState('');
  const [threadResult, setThreadResult] = useState('');
  const [visualStatus, setVisualStatus] = useState('');

  // 写入路径状态（docs/34 §6.2）：提交中 / 失败文案 / 成功回执，均为真实请求结果
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitReceipt, setSubmitReceipt] = useState('');
  /** 已成功落库的检验单（点「完成并返回列表」时回调 onSubmit 退出表单） */
  const [submitted, setSubmitted] = useState<{ orderId: string; orderNo: string } | null>(null);

  // 打印预览控制
  const [printModalOpen, setPrintModalOpen] = useState(false);
  const [manufacturingCertData, setManufacturingCertData] = useState<ManufacturingCertData | null>(null);

  // 委外检验类型：优先取检验单上的类型，其次按列表 Tab 推导（表面处理 / 热处理 / 机加工）
  const inspectionType: InspectionType =
    initialItem?.inspectionType === 'OQC_MACH' || initialItem?.tabType === 'machining'
      ? 'OQC_MACH'
      : initialItem?.inspectionType === 'OQC_HEAT' || initialItem?.tabType === 'heat'
      ? 'OQC_HEAT'
      : 'OQC_SF';

  // 物料编码（docs/35 §8 M7）：新建时必须先选物料 —— 它同时决定「匹配哪份质检方案」与「落库到哪个物料」。
  // 历史实现是 `initialItem?.materialCode ?? ''` 的只读派生值，新建链路因此永远匹配不到方案、
  // 且由 `materialCode === ''` 静默拦下（界面上看不出为什么提交不了）。
  // 存量单（带 id）一律只读展示：历史单据的物料编码不允许被改写。
  const [materialCode, setMaterialCode] = useState(fromList(initialItem?.materialCode));
  const materialCodeLocked = typeof initialItem?.id === 'string' && initialItem.id !== '';
  /** 存货主数据（GET /master-data/inventory）：物料编码选择器的选项来源（不编造物料） */
  const [materialOptions, setMaterialOptions] = useState<
    { materialCode: string; materialName?: string; specModel?: string }[]
  >([]);

  // 质量负责人签核（docs/35 §5）：只认本单真实落库的签核人 / 签核时间，无来源即空（证书留白）
  const [approver, setApprover] = useState<{ name: string; at: string }>({
    name: initialItem?.approverName !== undefined && initialItem?.approverName !== null ? String(initialItem.approverName) : '',
    at: initialItem?.approvedAt !== undefined && initialItem?.approvedAt !== null ? String(initialItem.approvedAt) : '',
  });

  // 判定依据来源（口径：docs/17-检验录入界面说明与质检方案匹配口径.md §7 / §7.8）：
  //   录入（默认）：按「物料 + 检验类型」匹配**当前生效方案**；
  //   只读回看（readOnly + 工单 ID）：读 `GET /inspections/{id}` 的**本单方案快照**，
  //   实测值与单项判定取工单落库值，方案改版不改写历史结论。
  const planMatch = useMatchedPlan(materialCode, inspectionType, {
    orderId: initialItem?.id ?? null,
    readOnly,
  });

  // 存货主数据：选择器的选项来源。主数据不可用时保持空列表（界面提示未维护），绝不回落硬编码物料。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await api.get<
          { materialCode?: string; materialName?: string; specModel?: string }[]
        >('/master-data/inventory');
        if (!cancelled && Array.isArray(rows)) {
          setMaterialOptions(
            rows
              .filter((row) => row !== null && typeof row === 'object' && String(row.materialCode ?? '') !== '')
              .map((row) => ({
                materialCode: String(row.materialCode),
                ...(row.materialName !== undefined ? { materialName: String(row.materialName) } : {}),
                ...(row.specModel !== undefined ? { specModel: String(row.specModel) } : {}),
              }))
          );
        }
      } catch {
        if (!cancelled) setMaterialOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 选择物料编码（docs/35 §8 M7）：回填物料名称 / 规格型号 —— **只在该字段为空时**回填，
   * 不覆盖录入人已经手改的值；物料编码本身变化会驱动 useMatchedPlan 重新匹配方案。
   */
  const handleMaterialCodeChange = (code: string) => {
    setMaterialCode(code);
    const option = materialOptions.find((row) => row.materialCode === code);
    if (option === undefined) return;
    if (partName.trim() === '' && option.materialName !== undefined && option.materialName !== '') {
      setPartName(option.materialName);
    }
    if (spec.trim() === '' && option.specModel !== undefined && option.specModel !== '') {
      setSpec(option.specModel);
    }
  };

  /** 方案驱动的待检指标行；未命中/匹配失败时为空，绝不用演示指标顶替真实方案 */
  const [planRows, setPlanRows] = useState<PlanIndicatorRow[]>([]);

  useEffect(() => {
    setPlanRows(planMatch.rows);
  }, [planMatch.rows]);

  // 「技术规范要求」的唯一来源：本单命中的方案指标行（docs/34 §4）。
  // 命中 -> 取该行标准要求文本；未命中 -> 空串（界面渲染成「方案未定义」占位，不显示原型常量）。
  const thicknessRow = matchPlanRow(planRows, ['膜厚', '镀层厚度', '涂层厚度', 'COATING', 'THICKNESS']);
  const saltSprayRow = matchPlanRow(planRows, ['盐雾', 'NSS', 'NASS', '耐腐蚀', 'SALT SPRAY']);
  const adhesionRow = matchPlanRow(planRows, ['附着力', '划格', 'ADHESION']);
  const hardnessRows = planRows.filter((row) => /硬度|HRC|HV/i.test(`${row.title} ${row.name}`));
  const coreHardnessRow =
    hardnessRows.find((row) => /心部|芯部|CORE/i.test(`${row.title} ${row.name}`)) ??
    (hardnessRows.length === 1 ? hardnessRows[0] : undefined);
  const surfaceHardnessRow =
    hardnessRows.find((row) => /表面|SURFACE/i.test(`${row.title} ${row.name}`)) ??
    (coreHardnessRow !== undefined && hardnessRows.length === 2
      ? hardnessRows.find((row) => row !== coreHardnessRow)
      : undefined);
  const bakingRow = matchPlanRow(planRows, ['去氢', '氢脆', '烘烤', '回火', 'DE-EMBRITTLEMENT', 'BAKING']);
  const visualRow = matchPlanRow(planRows, ['外观', '做工', 'VISUAL', 'WORKMANSHIP']);

  // 方案命中变化时同步规范文本（用户现场手改后不会被打回：依赖项是方案文本本身）
  useEffect(() => {
    setThicknessSpec(thicknessRow?.standard ?? '');
  }, [thicknessRow?.standard]);
  useEffect(() => {
    setSaltSprayRequirement(saltSprayRow?.standard ?? '');
  }, [saltSprayRow?.standard]);
  useEffect(() => {
    setAdhesionSpec(adhesionRow?.standard ?? '');
  }, [adhesionRow?.standard]);
  useEffect(() => {
    setCoreHardnessSpec(coreHardnessRow?.standard ?? '');
  }, [coreHardnessRow?.standard]);
  useEffect(() => {
    setSurfaceHardnessSpec(surfaceHardnessRow?.standard ?? '');
  }, [surfaceHardnessRow?.standard]);
  useEffect(() => {
    setBakingSpec(bakingRow?.standard ?? '');
  }, [bakingRow?.standard]);
  useEffect(() => {
    setVisualSpec(visualRow?.standard ?? '');
  }, [visualRow?.standard]);

  // 膜厚「5 点测试法」与方案指标清单里的「镀层厚度」是同一指标的两种录入形态（docs/34 §6.3）：
  // 只填了测点、没填指标行实测值时，用 5 点平均值充当该指标行的实测值参与判标 ——
  // 判标徽标 / 指标清单汇总 / 制造证书 / 落库四处口径必须一致，
  // 不能出现「库里判成 PASSED、界面与证书却还是空白」。
  const thicknessPointActual = avgThickness === null ? '' : avgThickness.toFixed(1);
  const planRowsForJudge = planRows.map((row) =>
    // 只在指标行实测值留空时回填 5 点均值：检验员显式录入的值优先，绝不被派生值覆盖
    thicknessPointActual !== '' &&
    thicknessRow !== undefined &&
    row.itemCode === thicknessRow.itemCode &&
    row.actual.trim() === ''
      ? { ...row, actual: thicknessPointActual }
      : row
  );
  const thicknessRowForJudge =
    thicknessRow === undefined
      ? undefined
      : planRowsForJudge.find((row) => row.itemCode === thicknessRow.itemCode) ?? thicknessRow;

  const judgement = summarizeJudgements(planRowsForJudge.map(judgeIndicatorRow));
  const planVersionId = planMatch.planVersionId;

  // 界面与证书共用的单项判定（docs/34 §5.2）：只认方案指标行的判标结果，未判定即留白
  const thicknessDecision = decisionText(thicknessRowForJudge, '');
  const visualDecision = decisionText(visualRow, visualStatus);

  // 只读回看：抬头按本单真实值回填，不用演示默认值冒充历史单据
  useEffect(() => {
    const order = planMatch.order;
    if (order === null) return;
    setDocNo(order.orderNo);
    setOutsourceNo(order.outsourceNo ?? '');
    setPartName(order.materialName);
    const specText = order.specification ?? order.spec;
    if (specText !== undefined && specText !== '') setSpec(specText);
    const vendor = order.vendorName ?? order.supplierName;
    if (vendor !== undefined && vendor !== '') setVendorName(vendor);
    if (order.processType !== undefined && order.processType !== '') setProcessType(order.processType);
    setBatchNo(order.batchNo);
    setQuantity(`${order.sampleQty}${order.unit !== undefined ? ` ${order.unit}` : ''}`);
    if (order.inspectorName !== undefined && order.inspectorName !== '') setInspector(order.inspectorName);
    const stamp = order.completedAt ?? order.createdAt;
    if (stamp !== undefined) setInspectDate(stamp.slice(0, 10));
    if (order.inspectionNotes !== undefined) setConclusion(order.inspectionNotes);
    // 物料编码与签核人：只认本单真实落库值（物料编码仅回读展示，不参与改写历史单据）
    if (order.materialCode !== undefined && order.materialCode !== '') setMaterialCode(order.materialCode);
    setApprover({
      name: order.approverName !== undefined && order.approverName !== null ? String(order.approverName) : '',
      at: order.approvedAt !== undefined && order.approvedAt !== null ? String(order.approvedAt) : '',
    });
    // 终判：只认本单真实落库判定 —— PASSED -> 合格、FAILED -> 不合格，未判定 / 特采一律留空
    // （旧实现把这两类都渲染成「合格」，等于替历史单据补一个它从未有过的结论）
    setDecision(
      order.overallDecision === 'FAILED' ? '不合格' : order.overallDecision === 'PASSED' ? '合格' : ''
    );
  }, [planMatch.order]);

  // 组装最新表单数据为制造业证书格式
  //
  // 口径（docs/33 §2.4）：只映射**真实值** —— 抬头取表单当前值，实测分区取当前表单已填写的
  // 实测项；未填写的分项一律不传（模板对应行整体不渲染），绝不用演示值顶替成"已测出结果"。
  /**
   * 制造证书数据组装（docs/33 §2.4 口径不变：只映射真实值，不提供任何编造默认值）。
   * 质量负责人 = 真实签核动作的产物（docs/35 §5）；企业档案（抬头）取主数据（docs/35 §6）；
   * 两者都没有来源即留白 —— 证书绝不打印没发生过的签核或硬编码抬头。
   */
  const buildCertData = (companyProfile: CompanyProfile | null): ManufacturingCertData => {
    const pointValues = [pt1, pt2, pt3, pt4, pt5]
      .map((value) => value.trim())
      .filter((value) => value !== '');
    const testResults: OutsourceTestResult = {};
    if (pointValues.length > 0) {
      testResults.coatingThickness = {
        standard: withUnit(thicknessSpec, thicknessRow?.unit ?? '', 'μm'),
        actual: avgThickness === null ? '' : `${avgThickness.toFixed(1)} μm`,
        points: pointValues,
        decision: thicknessDecision,
      };
    }
    if (saltSprayResult.trim() !== '') {
      testResults.saltSprayHours = {
        standard: saltSprayRequirement,
        actual: saltSprayResult,
        decision: decisionText(saltSprayRow, saltSprayStatus),
      };
    }
    if (adhesionVal.trim() !== '') {
      testResults.adhesion = {
        standard: adhesionSpec,
        actual: adhesionVal,
        decision: decisionText(adhesionRow, adhesionStatus),
      };
    }
    if (coreHardnessVal.trim() !== '') {
      testResults.coreHardness = {
        standard: coreHardnessSpec,
        actual: coreHardnessVal,
        decision: decisionText(coreHardnessRow, hardnessStatus),
      };
    }
    if (surfaceHardnessVal.trim() !== '') {
      testResults.surfaceHardness = {
        standard: surfaceHardnessSpec,
        actual: surfaceHardnessVal,
        decision: decisionText(surfaceHardnessRow, hardnessStatus),
      };
    }
    if (hydrogenEmbrittlement.trim() !== '') {
      testResults.deEmbrittlement = {
        standard: bakingSpec,
        actual: hydrogenEmbrittlement,
        decision: decisionText(bakingRow, bakingStatus),
      };
    }

    // 印章结论（overallDecision）：只读回看以本单落库判定为准；录入时取本次显式选择的综合判定，
    // 未选择即空 —— 证书不打印一个检验员没做过的结论（docs/34 §5.2）
    const certOverallDecision =
      readOnly && planMatch.order !== null
        ? planMatch.order.overallDecision ?? ''
        : decision === ''
        ? ''
        : decision === '合格'
        ? 'PASSED'
        : decision === '不合格'
        ? 'FAILED'
        : 'RE_INSPECTING';

    const cert: ManufacturingCertData = {
      // 键名与 `ManufacturingCertTemplate` 的读取口径一致（certNo / dateOfIssue / testResults）：
      // 历史实现写的是 certificateNo / date / tests，模板从不读取，导致证书编号与签发日期恒空白
      certNo: docNo.trim() === '' ? '' : `MC-${docNo}`,
      dateOfIssue: inspectDate,
      subcontractNo: outsourceNo,
      subcontractor: vendorName,
      processName: processType,
      productDescription: partName,
      dimension: spec,
      standardsApplied: techStandard,
      batchNo: batchNo,
      quantityPcs: quantity,
      inspectorName: inspector,
      // 质量负责人 = 真实签核动作的产物（inspection_orders.approver_name）；未签核即留空
      qaManagerName: approver.name,
      visualInspection: visualDecision,
      overallDecision: certOverallDecision,
      visualStandard: withUnit(visualSpec, visualRow?.unit ?? '', ''),
      visualActual: [visualResult.trim(), threadResult.trim()].filter((value) => value !== '').join(' / '),
      remarks: conclusion,
      testResults,
      ...(companyProfile !== null ? { companyProfile } : {}),
    };

    return cert;
  };

  /** 打开制造证书预览：先取企业档案主数据（模块级缓存），再按真实值组装 */
  const handleOpenCert = () => {
    void (async () => {
      const companyProfile = await loadCompanyProfile();
      setManufacturingCertData(buildCertData(companyProfile));
      setPrintModalOpen(true);
    })();
  };

  /**
   * 提交委外检验（docs/34 §6.2 写路径）：
   *   存量单 -> POST /inspections/{id}/submit-measurements + POST /inspections/{id}/status；
   *   无 id（新建）-> 先 POST /inspections 建单取号，再走同一条实测 + 终判链路。
   * 服务端返回什么就回执什么：失败按 ApiError 文案就地红字提示，不再 alert 假成功。
   */
  const handleSubmitInternal = async () => {
    if (submitting) return;
    if (decision === '') {
      setSubmitError('请先选择综合判定结果（合格 / 不合格 / 返工）');
      return;
    }
    if (inspector.trim() === '') {
      setSubmitError('请先填写质检检验员（检验单落库的检验人）');
      return;
    }
    if (materialCode.trim() === '') {
      setSubmitError('请先选择物料编码：它是匹配质检方案与落库物料的主键（docs/35 §8 M7）');
      return;
    }
    if (batchNo.trim() === '') {
      setSubmitError('请先填写委外批次号（检验单落库的批次号）');
      return;
    }
    const qty = parseQuantity(quantity);
    if (qty === null) {
      setSubmitError('交付数量里没有可解析的数值（形如「500 PCS」），请先补全');
      return;
    }

    setSubmitting(true);
    setSubmitError('');
    setSubmitReceipt('');
    try {
      let orderId: string = typeof initialItem?.id === 'string' ? initialItem.id : '';
      if (orderId === '') {
        // 新建：检验单号由服务端按 {类型前缀}-{YYYYMMDD}-{NNNN} 规则取号
        const created = await api.post<{ id?: string }>('/inspections', {
          inspectionType,
          materialCode,
          batchNo,
          sampleQty: qty,
          totalQty: qty,
          ...(partName.trim() !== '' ? { materialName: partName } : {}),
          ...(spec.trim() !== '' ? { specification: spec } : {}),
          ...(outsourceNo.trim() !== '' ? { outsourceNo } : {}),
          ...(processType.trim() !== '' ? { processType } : {}),
          ...(vendorName.trim() !== '' ? { vendorName } : {}),
          ...(inspector.trim() !== '' ? { inspectorName: inspector } : {}),
          // 命中的方案版本 ID 原样回传，服务端按该版本固化 planSnapshot 快照
          ...(planVersionId !== null ? { planVersionId } : {}),
        });
        if (created.id === undefined || created.id === '') {
          throw new Error('服务端未返回检验单主键，无法继续录入实测值');
        }
        orderId = created.id;
      }

      // 只填了 5 点膜厚时，5 点平均值已由 planRowsForJudge 回填到对应方案指标行（见上方口径说明），
      // 避免「界面量了 5 个点、库里一个数都没落」的静默丢数。
      const rowsForSubmit = planRowsForJudge;

      // 实测值：只下发方案命中行里已填写的项。缺项时按草稿落库 —— 用「未录入」触发领域终判会把
      // 整单判成不合格并汇入不合格待审池（collectPendingDefect），那不是检验员的真实结论。
      const measuredRows = rowsForSubmit.filter((row) => !row.isExempt && row.actual.trim() !== '');
      const hasBlankRows = rowsForSubmit.some((row) => !row.isExempt && row.actual.trim() === '');
      if (measuredRows.length > 0) {
        await api.post(`/inspections/${encodeURIComponent(orderId)}/submit-measurements`, {
          isDraft: hasBlankRows,
          items: measuredRows.map((row) => {
            const numeric =
              row.planItem.dataType === 'NUMERIC' ? parseMeasuredNumber(row.actual) : undefined;
            return {
              itemCode: row.itemCode,
              ...(numeric !== undefined ? { measuredVal: numeric } : {}),
              measuredText: row.actual,
            };
          }),
        });
      }

      // 终判（状态机口径见 @letian/domain 的 InspectionStateMachine：返工 = RE_INSPECTING）
      const targetStatus = DECISION_TO_STATUS[decision];
      const finished = await api.post<{ orderNo?: string }>(
        `/inspections/${encodeURIComponent(orderId)}/status`,
        {
          status: targetStatus,
          passQty: decision === '合格' ? qty : 0,
          failQty: decision === '不合格' ? qty : 0,
          ...(decision === '返工' ? {} : { judgment: targetStatus }),
          ...(conclusion.trim() !== '' ? { remark: conclusion, inspectionNotes: conclusion } : {}),
        }
      );

      const orderNo = finished.orderNo ?? docNo.trim();
      setSubmitted({ orderId, orderNo });
      setSubmitReceipt(`已保存并终判：${orderNo}（判定：${decision}）`);
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
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
          <ApprovalButton
            orderId={typeof initialItem?.id === 'string' ? initialItem.id : ''}
            approverName={approver.name}
            approvedAt={approver.at}
            onApproved={(result) =>
              setApprover({ name: result.approverName ?? approver.name, at: result.approvedAt ?? approver.at })
            }
          />
          <button
            type="button"
            onClick={handleOpenCert}
            className="px-3.5 py-1.5 rounded bg-indigo-50 border border-indigo-200 text-indigo-700 text-xs font-medium hover:bg-indigo-100 flex items-center gap-1.5 transition-colors shadow-sm"
          >
            <Printer className="w-3.5 h-3.5" /> 预览并导出制造证书 (PDF)
          </button>
        </div>
      </div>

      {/* 质检方案匹配状态：命中才渲染指标清单，未命中则引导配置方案 */}
      <PlanMatchBanner state={planMatch} materialCode={materialCode} inspectionType={inspectionType} />

      {/*
        只读回看（readOnly）把「指标清单 + 标准值 + 实测值 + 判定」整段置为不可编辑：
        fieldset[disabled] 一次性禁用内部全部表单控件，避免"能看历史单据、却能改历史结论"。
        制造证书导出按钮在表单之外，回看时依旧可导出。
      */}
      <fieldset disabled={readOnly} className="border-0 p-0 m-0 min-w-0 space-y-4">
      {/* 模块零：方案驱动的待检指标清单（需求"显示需要检验的指标清单"的落点） */}
      <div className="bg-white border border-slate-200/80 rounded-lg shadow-sm overflow-hidden">
        <div className="px-4 py-3 bg-[#F8FAFC] border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-800">
            <ClipboardList className="w-4 h-4 text-indigo-600" />
            <span>质检方案待检指标清单 (Plan-driven Inspection Items)</span>
          </div>
          <span className="text-[11px] text-slate-500">
            共 {judgement.total} 项 · 免检 {judgement.exempt} 项 · 待判定 {judgement.pending} 项
            {judgement.passRate !== null && ` · 合格率 ${(judgement.passRate * 100).toFixed(1)}%`}
          </span>
        </div>
        <table className="w-full text-xs text-left">
          <thead className="bg-slate-50 text-slate-600 font-medium border-b border-slate-200">
            <tr>
              <th className="py-2.5 px-4 w-56">检验指标</th>
              <th className="py-2.5 px-4 w-24">单位</th>
              <th className="py-2.5 px-4 w-56">标准要求</th>
              <th className="py-2.5 px-4">实测值</th>
              <th className="py-2.5 px-3 w-24 text-center">不解检</th>
              <th className="py-2.5 px-4 w-28 text-center">单项判定</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {planRows.length === 0 && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-[11px] text-slate-400">
                  暂无可录入的指标项：未匹配到该物料的已启用质检方案，请先由质量工程师配置方案。
                </td>
              </tr>
            )}
            {planRows.map((row, idx) => {
              // 判标口径取「已回填 5 点均值」的行（与膜厚判定徽标 / 证书 / 落库一致）；
              // 输入框仍绑定原始行，保证录入不被派生值覆盖
              const decision = judgeIndicatorRow(planRowsForJudge[idx] ?? row);
              return (
                <tr key={`${row.itemCode}-${idx}`} className="hover:bg-slate-50/50">
                  <td className="py-2.5 px-4 font-medium text-slate-800">{row.title}</td>
                  <td className="py-2.5 px-4 text-slate-500">{row.unit}</td>
                  <td className="py-2.5 px-4 text-slate-600 font-mono">{row.standard}</td>
                  <td className="py-2.5 px-4">
                    <input
                      type="text"
                      value={row.actual}
                      disabled={row.isExempt}
                      placeholder={row.isExempt ? '已标记不解检(免检)' : '实测值'}
                      onChange={(e) => {
                        setPlanRows((prev) =>
                          prev.map((candidate, position) =>
                            position === idx ? { ...candidate, actual: e.target.value } : candidate
                          )
                        );
                      }}
                      className={`w-44 border rounded px-2 py-1 font-mono font-medium focus:outline-none ${
                        row.isExempt
                          ? 'bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed italic'
                          : decision === 'FAILED'
                          ? 'border-rose-400 text-rose-600 bg-white'
                          : 'border-slate-200 bg-white focus:border-blue-500'
                      }`}
                    />
                  </td>
                  <td className="py-2.5 px-3 text-center">
                    <input
                      type="checkbox"
                      checked={row.isExempt}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setPlanRows((prev) =>
                          prev.map((candidate, position) =>
                            position === idx ? { ...candidate, isExempt: checked } : candidate
                          )
                        );
                      }}
                      className="rounded text-blue-600 focus:ring-blue-500"
                    />
                  </td>
                  <td className="py-2.5 px-4 text-center">
                    <span
                      className={`px-2 py-0.5 rounded text-[11px] font-semibold border ${
                        decision === 'PASSED'
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                          : decision === 'FAILED'
                          ? 'bg-rose-50 text-rose-700 border-rose-200'
                          : decision === 'EXEMPT'
                          ? 'bg-sky-50 text-sky-700 border-sky-200'
                          : 'bg-slate-100 text-slate-500 border-slate-200'
                      }`}
                    >
                      {DECISION_LABEL[decision]}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 模块一：委托外协与物料信息抬头卡片 (对齐 MANUFACTURING CERT Header) */}
      <div className="bg-white border border-slate-200/80 rounded-lg p-4 shadow-sm">
        <div className="flex items-center gap-2 pb-3 mb-3 border-b border-slate-100 text-xs font-semibold text-slate-800">
          <ShieldCheck className="w-4 h-4 text-blue-600" />
          <span>委外受托信息与产品基础属性 (Outsource Order & Material Specs)</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
          <div>
            <label className="block text-slate-500 mb-1">物料编码 (Material Code) ★</label>
            {materialCodeLocked ? (
              // 存量单：物料编码是历史事实，只读展示，不允许被改写
              <input
                type="text"
                readOnly
                value={materialCode}
                title="历史单据的物料编码只读，不允许改写"
                className="w-full bg-slate-100 border border-slate-200 rounded px-2.5 py-1.5 text-slate-600 font-mono"
              />
            ) : (
              <select
                value={materialOptions.some((option) => option.materialCode === materialCode) ? materialCode : ''}
                onChange={(e) => handleMaterialCodeChange(e.target.value)}
                className="w-full bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 font-mono focus:bg-white focus:outline-none focus:border-blue-500"
              >
                <option value="">
                  {materialOptions.length === 0 ? '存货主数据不可用（无法选择）' : '请选择物料编码'}
                </option>
                {materialOptions.map((option) => (
                  <option key={option.materialCode} value={option.materialCode}>
                    {option.materialCode}
                    {option.materialName !== undefined && option.materialName !== ''
                      ? ` · ${option.materialName}`
                      : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className="block text-slate-500 mb-1">检验单号 (Inspection Order No)</label>
            <input
              type="text"
              value={docNo}
              onChange={(e) => setDocNo(e.target.value)}
              placeholder="取本单检验单号"
              className="w-full bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 font-medium focus:bg-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-slate-500 mb-1">委外加工单号 (Subcontract No)</label>
            <input
              type="text"
              value={outsourceNo}
              onChange={(e) => setOutsourceNo(e.target.value)}
              placeholder="取本单委外加工单号（历史单可能为空）"
              className="w-full bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 font-mono focus:bg-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-slate-500 mb-1">外协加工商 (Processor / Vendor)</label>
            <input
              type="text"
              value={vendorName}
              onChange={(e) => setVendorName(e.target.value)}
              placeholder="取本单加工商"
              className="w-full bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 font-medium focus:bg-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-slate-500 mb-1">加工工序类别 (Process Category)</label>
            <input
              type="text"
              value={processType}
              onChange={(e) => setProcessType(e.target.value)}
              placeholder="取本单加工类型"
              className="w-full bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 focus:bg-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-slate-500 mb-1">产品名称及规格 (Description & Size)</label>
            <input
              type="text"
              value={partName}
              onChange={(e) => setPartName(e.target.value)}
              placeholder="取本单物料名称"
              className="w-full bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 focus:bg-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-slate-500 mb-1">规格型号 (Size / Dimension)</label>
            <input
              type="text"
              value={spec}
              onChange={(e) => setSpec(e.target.value)}
              placeholder="取本单规格型号快照"
              className="w-full bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 focus:bg-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-slate-500 mb-1">材质牌号 / 强度等级 (Material Grade)</label>
            <input
              type="text"
              value={materialGrade}
              onChange={(e) => setMaterialGrade(e.target.value)}
              placeholder="按物料主数据 / 本单方案填写"
              className="w-full bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 focus:bg-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-slate-500 mb-1">委外批次号 (Outsource Batch No)</label>
            <input
              type="text"
              value={batchNo}
              onChange={(e) => setBatchNo(e.target.value)}
              placeholder="取本单批次号"
              className="w-full bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 focus:bg-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-slate-500 mb-1">委外交付数量 (Processed Qty)</label>
            <input
              type="text"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="取本单交付数量"
              className="w-full bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 focus:bg-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-slate-500 mb-1">执行技术标准与工艺规范 (Standard & Specs)</label>
            <input
              type="text"
              value={techStandard}
              onChange={(e) => setTechStandard(e.target.value)}
              placeholder="按本单方案的标准要求填写"
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
            <span className="text-slate-500 font-normal">
              标准要求：
              {thicknessSpec === ''
                ? '方案未定义膜厚规范'
                : withUnit(thicknessSpec, thicknessRow?.unit ?? '', 'μm')}
            </span>
            <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-bold border border-emerald-200">
              平均实测值：{avgThickness === null ? '-' : `${avgThickness.toFixed(2)} μm`}
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
              placeholder="实测值"
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
              placeholder="实测值"
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
              placeholder="实测值"
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
              placeholder="实测值"
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
              placeholder="实测值"
              className="w-full border border-slate-200 rounded px-2 py-1 text-center font-mono font-medium focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-slate-500 mb-1">膜厚判定</label>
            <div
              className={`h-7 flex items-center justify-center rounded border font-medium ${decisionBadgeClass(thicknessDecision)}`}
            >
              {decisionBadgeText(thicknessDecision)}
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
                  placeholder="方案未定义耐盐雾规范（可手工填写）"
                />
              </td>
              <td className="py-3 px-4">
                <input
                  type="text"
                  value={saltSprayResult}
                  onChange={(e) => setSaltSprayResult(e.target.value)}
                  className="w-full border border-slate-200 rounded px-2 py-1 text-xs"
                  placeholder="试验记录与结论"
                />
              </td>
              <td className="py-3 px-4 text-center">
                <select
                  value={saltSprayStatus}
                  onChange={(e) => setSaltSprayStatus(e.target.value)}
                  className="border border-slate-200 rounded px-2 py-1 text-xs bg-white text-emerald-600 font-medium"
                >
                  <option value="">未判定</option>
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
                  placeholder="方案未定义附着力规范（可手工填写）"
                />
              </td>
              <td className="py-3 px-4">
                <input
                  type="text"
                  value={adhesionVal}
                  onChange={(e) => setAdhesionVal(e.target.value)}
                  className="w-full border border-slate-200 rounded px-2 py-1 text-xs"
                  placeholder="实测记录"
                />
              </td>
              <td className="py-3 px-4 text-center">
                <select
                  value={adhesionStatus}
                  onChange={(e) => setAdhesionStatus(e.target.value)}
                  className="border border-slate-200 rounded px-2 py-1 text-xs bg-white text-emerald-600 font-medium"
                >
                  <option value="">未判定</option>
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
                  placeholder="方案未定义心部硬度规范（可手工填写）"
                />
                <input
                  type="text"
                  value={surfaceHardnessSpec}
                  onChange={(e) => setSurfaceHardnessSpec(e.target.value)}
                  className="w-full border border-slate-200 rounded px-2 py-1 text-xs"
                  placeholder="方案未定义表面硬度规范（可手工填写）"
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
                  <option value="">未判定</option>
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
                <input
                  type="text"
                  value={bakingSpec}
                  onChange={(e) => setBakingSpec(e.target.value)}
                  className="w-full border border-slate-200 rounded px-2 py-1 text-xs"
                  placeholder="方案未定义去氢回火规范（可手工填写）"
                />
              </td>
              <td className="py-3 px-4">
                <input
                  type="text"
                  value={hydrogenEmbrittlement}
                  onChange={(e) => setHydrogenEmbrittlement(e.target.value)}
                  className="w-full border border-slate-200 rounded px-2 py-1 text-xs"
                  placeholder="烘烤记录与氢脆验证结论"
                />
              </td>
              <td className="py-3 px-4 text-center">
                <select
                  value={bakingStatus}
                  onChange={(e) => setBakingStatus(e.target.value)}
                  className="border border-slate-200 rounded px-2 py-1 text-xs bg-white text-emerald-600 font-medium"
                >
                  <option value="">未判定</option>
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
                <input
                  type="text"
                  value={visualSpec}
                  onChange={(e) => setVisualSpec(e.target.value)}
                  className="w-full border border-slate-200 rounded px-2 py-1 text-xs"
                  placeholder="方案未定义外观规范（可手工填写）"
                />
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
                <select
                  value={visualStatus}
                  onChange={(e) => setVisualStatus(e.target.value)}
                  className="border border-slate-200 rounded px-2 py-1 text-xs bg-white text-emerald-600 font-medium"
                >
                  <option value="">未判定</option>
                  <option value="合格">合格</option>
                  <option value="不合格">不合格</option>
                </select>
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
              value=""
              placeholder="待质量负责人签核"
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

        {/* 写路径回执：红字 = 服务端错误原因；绿字 = 服务端返回的检验单号（不假成功） */}
        {(submitError !== '' || submitReceipt !== '') && (
          <div
            className={`rounded border px-3 py-2 text-xs ${
              submitError !== ''
                ? 'border-rose-200 bg-rose-50 text-rose-700'
                : 'border-emerald-200 bg-emerald-50 text-emerald-700'
            }`}
          >
            {submitError !== '' ? submitError : submitReceipt}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
          <button
            type="button"
            onClick={onBack}
            className="px-4 py-1.5 rounded border border-slate-200 text-xs text-slate-600 hover:bg-slate-50"
          >
            {submitted === null ? '取消' : '返回列表'}
          </button>
          <button
            type="button"
            onClick={handleOpenCert}
            className="px-4 py-1.5 rounded bg-indigo-50 border border-indigo-200 text-indigo-700 text-xs font-medium hover:bg-indigo-100 flex items-center gap-1.5"
          >
            <Printer className="w-3.5 h-3.5" /> 生成制造证书
          </button>
          {!readOnly && submitted === null && (
          <button
            type="button"
            onClick={() => {
              void handleSubmitInternal();
            }}
            disabled={submitting}
            className="px-4 py-1.5 rounded bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 shadow-sm disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {submitting ? '提交中…' : '保存并提交委外判定'}
          </button>
          )}
          {!readOnly && submitted !== null && (
          <button
            type="button"
            onClick={() =>
              onSubmit({
                id: submitted.orderId,
                docNo: submitted.orderNo,
                decision,
                inspector,
                inspectDate,
                conclusion,
                materialCode,
                inspectionType,
              })
            }
            className="px-4 py-1.5 rounded bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 shadow-sm"
          >
            完成并返回列表
          </button>
          )}
        </div>
      </div>
      </fieldset>

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
