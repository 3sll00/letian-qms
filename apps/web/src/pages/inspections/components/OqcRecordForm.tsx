import React, { useState, useEffect, useCallback, useRef } from "react";
import { ArrowLeft, Printer, ShieldCheck, Atom, Gauge, CheckSquare, Layers, Sparkles, AlertTriangle, FileSpreadsheet } from "lucide-react";
import { CertificatePrintModal } from "../../../components/certificate/CertificatePrintModal";
import { PrintTemplateModal } from "../../../components/common/PrintTemplateModal";
import { IndicatorActualField } from "../../../components/common/IndicatorActualField";
import { PlanMatchBanner } from "../../../components/common/PlanMatchBanner";
import { ApprovalButton } from "../../../components/common/ApprovalButton";
import {
  CertTemplateKind,
  ManufacturingCertData,
  QualityCertificateData,
} from "../../../lib/inspectionTypes";
import {
  buildManufacturingCertData,
  buildOqcCertificateData,
  certificateItemsFromRows,
} from "../../../lib/certificateDataService";
import { CertFieldsCard } from "../../../components/certificate/CertFieldsCard";
import { loadCompanyProfile } from "../../../lib/companyProfile";
import { api, errorMessage } from "../../../lib/api";
import { oqcHeatNoRequirementMarker, validateOqcHeatNo } from "../../../lib/oqcHeatNoRequirement";
import { useMatchedPlan } from "../../../hooks/useMatchedPlan";
import {
  DECISION_LABEL,
  judgeIndicatorRow,
  planSectionEmptyText,
  parseMeasuredNumber,
  splitIndicatorRows,
  summarizeJudgements,
  type PlanIndicatorRow,
} from "../../../lib/planMatch";
import type { FurnaceHeatTraceResponse, InspectionItemDecision } from "@letian/contracts";

/** 单项判定徽标：只有 PASSED 才显示合格，待判定不得冒充合格 */
const VerdictBadge: React.FC<{ decision: InspectionItemDecision }> = ({ decision }) => (
  <span
    className={`px-2 py-0.5 rounded text-[11px] font-semibold border ${
      decision === "PASSED"
        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
        : decision === "FAILED"
        ? "bg-rose-50 text-rose-700 border-rose-200"
        : "bg-slate-100 text-slate-500 border-slate-200"
    }`}
  >
    {DECISION_LABEL[decision]}
  </span>
);

/**
 * 列表行回填输入框的归一化：列表用 `-` 表示「无值」这一展示占位，不能把它当真实数据带进表单，
 * 否则录入人会把占位符当成已填内容，甚至原样提交 / 打印。
 */
function fromList(value?: string | null): string {
  return value !== undefined && value !== null && value !== "-" ? value : "";
}

/** 带出指标匹配：编码优先，名称 / 标题只作回落；比较统一去空白并转大写 */
function traceKey(value: string): string {
  return value.replace(/[\s\-_\u3000]/g, "").toUpperCase();
}

function matchesChemicalItem(item: HeatTraceInheritedItem, row: PlanIndicatorRow): boolean {
  const title = traceKey(row.title);
  return (
    item.metricCategory === "CHEMICAL_COMPOSITION" &&
    (traceKey(item.itemCode) === traceKey(row.itemCode) ||
      (title !== "" && (traceKey(item.name) === title || traceKey(item.itemCode).includes(title))))
  );
}

function matchesMechanicalItem(item: HeatTraceInheritedItem, row: PlanIndicatorRow): boolean {
  const mechanicalCategories = ["MECHANICAL_PERFORMANCE", "HARDNESS", "TENSILE_STRENGTH"];
  const title = row.title.trim();
  return (
    mechanicalCategories.includes(item.metricCategory) &&
    (traceKey(item.itemCode) === traceKey(row.itemCode) ||
      (title !== "" &&
        (item.name.includes(title) ||
          title.includes(item.name) ||
          (title.includes("抗拉") && item.name.includes("抗拉")) ||
          (title.includes("屈服") && item.name.includes("屈服")) ||
          (title.includes("伸长率") && item.name.includes("伸长率")) ||
          (title.includes("硬度") && item.name.includes("硬度")) ||
          (title.includes("冲击") && item.name.includes("冲击")))))
  );
}

/** 检验日期默认取「今天」：录入动作真实发生日，不是编造的固定日期 */
function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 数量文本（形如「546 件」）-> 数值；解析不出即 null（不猜数量） */
function parseQuantity(text: string): number | null {
  const matched = String(text).replace(/,/g, "").match(/\d+(\.\d+)?/);
  if (matched === null) return null;
  const value = Number(matched[0]);
  return Number.isFinite(value) ? value : null;
}

interface OqcRecordFormProps {
  initialItem?: any;
  onBack: () => void;
  onSubmit: (result: any) => void;
  /** 只读回看：指标清单与判定取本单方案快照（§7.3「快照即证据」），不允许改动历史结论 */
  readOnly?: boolean;
}

/**
 * 上游异常提示（TBD-01 / docs/47 §3.9）：同一炉批号存在 不合格 / MRB 未结案 / 未终判 记录时，
 * 服务端在响应里附一段可读提示；**只提示、不带值、不阻断**。界面照实展示 message，不自行拼文案
 * （文案单点在服务端 `warningWithMessage()`，避免两处各写一套措辞）。
 */
export type HeatTraceUpstreamWarning = NonNullable<FurnaceHeatTraceResponse["upstreamWarning"]>;
type HeatTraceInheritedItem = FurnaceHeatTraceResponse["inheritedItems"][number];

export const OqcRecordForm: React.FC<OqcRecordFormProps> = ({
  initialItem,
  onBack,
  onSubmit,
  readOnly = false,
}) => {
  // 基础合同与出货交付信息 (质量保证证书 Header)
  //
  // 口径（docs/27 §6.1 / docs/33 §2.1，同款缺陷）：抬头字段一律只由**真实数据源**填充 ——
  // 出货台账列表行 (initialItem) 或本单方案快照 (planMatch.order，见下方回填 useEffect)；
  // 两者都没有来源即保持空串，由录入人按占位提示填写。
  // 历史实现在这里预置了一整套演示值（单号「QC-2026-07-0062」、客户「江阴开益特种压缩机有限公司」、
  // 材质「ML40Cr」、炉号「HN-20260518-03」、批号「LOT-20260706-002」、数量「546 件」、
  // 检验人「张检验 (QC)」、检验日期「2026-07-06」、结论长文…）：界面看起来"已经有真实数据"，
  // 提交与打印时会被当成本单真实值写库、印进对外质量证书 —— 属编造值，故一律移除。
  const [certNo, setCertNo] = useState(fromList(initialItem?.no));
  const [orderNo, setOrderNo] = useState(fromList(initialItem?.doc ?? initialItem?.orderNo));
  const [deliveryNo, setDeliveryNo] = useState(fromList(initialItem?.deliveryNo ?? initialItem?.salesOrderNo));
  const [customer, setCustomer] = useState(fromList(initialItem?.client ?? initialItem?.customerName));
  const [productName, setProductName] = useState(fromList(initialItem?.name ?? initialItem?.materialName));
  const [spec, setSpec] = useState(fromList(initialItem?.spec ?? initialItem?.specification));
  // 执行标准 / 材质牌号：列表行与本单合同都没有该字段的稳定来源，留空由录入人按图纸填写
  const [standard, setStandard] = useState("");
  const [materialGrade] = useState(fromList(initialItem?.steelGrade ?? initialItem?.materialGrade));
  const [heatNo, setHeatNo] = useState(fromList(initialItem?.heatNo ?? initialItem?.furnaceHeatNo));
  const [lotNo, setLotNo] = useState(fromList(initialItem?.lotNo ?? initialItem?.batchNo));
  const [quantity, setQuantity] = useState(
    initialItem?.qty !== undefined && initialItem?.qty !== null && initialItem?.qty !== ""
      ? `${initialItem.qty}`
      : ""
  );

  // 炉批号追溯联动状态与修改追踪
  const [heatTraceLoading, setHeatTraceLoading] = useState(false);
  const [heatTraceSource, setHeatTraceSource] = useState<{
    sourceType: FurnaceHeatTraceResponse["sourceType"];
    sourceOrderNo?: string;
    batchNo: string;
    /** 命中范围：MATERIAL = 同物料命中；GLOBAL = 跨物料命中（界面须提示确认炉次归属，docs/47 §3.4） */
    matchScope?: "MATERIAL" | "GLOBAL";
    /** 上游异常提示（缺省 = 无异常，不渲染提示条） */
    upstreamWarning?: HeatTraceUpstreamWarning;
  } | null>(null);
  const [inheritedValues, setInheritedValues] = useState<Record<string, string>>({});
  const [modifiedItems, setModifiedItems] = useState<Set<string>>(new Set());
  const [heatTraceError, setHeatTraceError] = useState("");
  /** 炉批号请求序号：旧响应晚到时不得覆盖新炉号的结果 / 空态（竞态护栏） */
  const heatTraceSeqRef = useRef(0);

  // MES 外部追溯（生产任务 / 过程检验）：只读参考展示，来源 MES 库，绝不回填 QMS 指标值
  // （与上方 heat-batch-trace 不同：heat-batch-trace 是 QMS 内部前道工序带出，本面板只展示 MES 原始记录）
  const [mesSearch, setMesSearch] = useState<string>(
    () => fromList(initialItem?.heatNo ?? initialItem?.furnaceHeatNo) || fromList(lotNo) || ""
  );
  const [mesTasks, setMesTasks] = useState<Record<string, any>[]>([]);
  const [mesReports, setMesReports] = useState<Record<string, any>[]>([]);
  const [mesLoading, setMesLoading] = useState(false);
  const [mesError, setMesError] = useState("");
  const [mesOpen, setMesOpen] = useState(false);

  /** 当前已带出指标的键集合（`chem_*` / `mech_*`）：清空炉批号时按它**精确**回滚（docs/47 AC-09） */
  const inheritedKeysRef = useRef<readonly string[]>([]);
  /** 最近一次带出对应的炉号：重复响应只刷新未改值，不覆盖人工修改 */
  const inheritedBatchKeyRef = useRef<string | null>(null);
  /** 同步给稳定 callback 用，避免状态闭包读到旧 Set */
  const modifiedItemsRef = useRef<Set<string>>(new Set());

  // 当前出货单的物料编码：来自出货检验列表行，缺失时页面明确提示无法自动匹配
  const materialCode: string = initialItem?.materialCode ?? initialItem?.productCode ?? "";

  // 判定依据的唯一来源（口径：docs/17-检验录入界面说明与质检方案匹配口径.md §7）
  //   新建 / 继续录入 → 按「物料 + 检验类型」匹配**当前生效方案**；
  //   只读回看        → 读**本单方案快照**（§7.3「快照即证据」），不按当前方案重算历史判定
  const planMatch = useMatchedPlan(materialCode, "OQC_SH", {
    orderId: initialItem?.id ?? null,
    readOnly,
  });

  // 1. 化学成分全项 (Chemical Composition, %)
  const [chemElements, setChemElements] = useState<PlanIndicatorRow[]>([]);

  // 2. 机械物理性能全项 (Mechanical & Physical Properties)
  const [mechProperties, setMechProperties] = useState<PlanIndicatorRow[]>([]);

  // 3. 尺寸公差与外观全项 (Dimensions & Visual)
  const [dimItems, setDimItems] = useState<PlanIndicatorRow[]>([]);

  /**
   * 带出应用与行编辑是两个独立 effect：用 ref 保存「当前真实行」，
   * 避免追溯响应在 React 尚未提交新行时读到空数组（方案加载与炉号查询是并发的）。
   */
  const chemRowsRef = useRef<PlanIndicatorRow[]>([]);
  const mechRowsRef = useRef<PlanIndicatorRow[]>([]);

  // 指标行就绪即重建三个分区；未命中 / 加载失败时清空，绝不用演示指标行顶替真实方案或本单快照
  useEffect(() => {
    const grouped = splitIndicatorRows(planMatch.rows);
    chemRowsRef.current = grouped.CHEMICAL;
    mechRowsRef.current = grouped.MECHANICAL;
    setChemElements(grouped.CHEMICAL);
    setMechProperties(grouped.MECHANICAL);
    setDimItems(grouped.DIMENSIONAL);
  }, [planMatch.rows]);

  // 本单全部指标行的实时判标汇总（合格率分母已剔除免检项）
  const judgement = summarizeJudgements(
    [...chemElements, ...mechProperties, ...dimItems].map(judgeIndicatorRow)
  );

  /**
   * 方案版本 ID：新建/录入模式下提交建单时原样回传，服务端据此固化 planSnapshot 快照；
   * 只读回看模式下是本单已绑定的版本，仅用于展示，不再回传建单。
   */
  const planVersionId = planMatch.planVersionId;

  // 综合判定与签发
  const [decision, setDecision] = useState<"合格" | "不合格" | "特采">("合格");
  const [inspector, setInspector] = useState(fromList(initialItem?.inspector ?? initialItem?.inspectorName));
  // 检验日期默认「今天」：录入动作真实发生日；历史默认值是编造的固定日期
  const [inspectDate, setInspectDate] = useState(todayIsoDate());
  // 结论不预置演示长文（原文案会让尚未检验的空白单据看起来已经判过合格）
  const [conclusion, setConclusion] = useState("");

  // 只读回看：合同/交付/证书表头按工单真实值回填，避免"回看历史单据却打印出演示值"
  useEffect(() => {
    const order = planMatch.order;
    if (order === null) return;
    setCertNo(order.orderNo);
    if (order.salesOrderPoNo !== undefined && order.salesOrderPoNo !== "") setOrderNo(order.salesOrderPoNo);
    if (order.salesOrderNo !== undefined && order.salesOrderNo !== "") setDeliveryNo(order.salesOrderNo);
    if (order.customerName !== undefined && order.customerName !== "") setCustomer(order.customerName);
    setProductName(order.materialName);
    const specText = order.specification ?? order.spec;
    if (specText !== undefined && specText !== "") setSpec(specText);
    if (order.furnaceHeatNo !== undefined && order.furnaceHeatNo !== "") setHeatNo(order.furnaceHeatNo);
    setLotNo(order.batchNo);
    setQuantity(`${order.sampleQty}${order.unit !== undefined ? ` ${order.unit}` : ""}`);
    if (order.inspectorName !== undefined && order.inspectorName !== "") setInspector(order.inspectorName);
    const stamp = order.completedAt ?? order.createdAt;
    if (stamp !== undefined) setInspectDate(stamp.slice(0, 10));
    if (order.inspectionNotes !== undefined && order.inspectionNotes !== "") setConclusion(order.inspectionNotes);
    // 签核人 / 签核时间：只认本单真实落库值（未签核即空）
    setApprover({
      name: order.approverName !== undefined && order.approverName !== null ? String(order.approverName) : "",
      at: order.approvedAt !== undefined && order.approvedAt !== null ? String(order.approvedAt) : "",
    });
    setDecision(
      order.overallDecision === "FAILED" ? "不合格" : order.overallDecision === "CONCESSION" ? "特采" : "合格"
    );
    // 证书模板与字段袋随单落库（docs/51）：只读回看按本单真实存储值回填
    if (order.certTemplate !== undefined && order.certTemplate !== null) {
      setCertTemplate(order.certTemplate);
    }
    if (order.certFields !== undefined && order.certFields !== null) {
      const bag: Record<string, string> = {};
      for (const [key, value] of Object.entries(order.certFields)) {
        if (typeof value === "string" && value !== "") bag[key] = value;
      }
      setCertFields(bag);
    }
  }, [planMatch.order]);

  // 打印预览控制
  const [certModalOpen, setCertModalOpen] = useState(false);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [certData, setCertData] = useState<QualityCertificateData | null>(null);
  const [mfgCertData, setMfgCertData] = useState<ManufacturingCertData | null>(null);

  // 证书模板（docs/51）：建单时由操作员选定并随单落库；历史单没有该列时按出货场景回落质保书
  const [certTemplate, setCertTemplate] = useState<CertTemplateKind>(
    initialItem?.certTemplate === "MANUFACTURING" ? "MANUFACTURING" : "QUALITY"
  );
  // 证书专用字段袋（cert_fields）：扫描件版面上有、检验单表头没有物理列的格；未填留白
  const [certFields, setCertFields] = useState<Record<string, string>>(() => {
    const raw = initialItem?.certFields;
    if (raw === null || raw === undefined || typeof raw !== "object") return {};
    const bag: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string" && value !== "") bag[key] = value;
    }
    return bag;
  });

  // 写入路径状态（docs/35 §4 M3）：提交中 / 失败文案 / 成功回执，均为真实请求结果
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [submitReceipt, setSubmitReceipt] = useState("");
  /** 已成功落库的检验单（点「完成并返回列表」时回调 onSubmit 退出表单） */
  const [submitted, setSubmitted] = useState<{ orderId: string; orderNo: string } | null>(null);

  // 质量负责人签核（docs/35 §5）：只认本单真实落库的签核人 / 签核时间，无来源即空（证书留白）
  const [approver, setApprover] = useState<{ name: string; at: string }>({
    name: initialItem?.approverName !== undefined && initialItem?.approverName !== null ? String(initialItem.approverName) : "",
    at: initialItem?.approvedAt !== undefined && initialItem?.approvedAt !== null ? String(initialItem.approvedAt) : "",
  });

  /** 本单全部指标行（与页面顺序一致）：证书组装与提交写路径共用同一份来源 */
  const planRowsForSubmit = [...chemElements, ...mechProperties, ...dimItems];
  const inheritedSourceLabel =
    heatTraceSource?.sourceType === "IQC_RAW_MATERIAL" ? "来料检验" : "委外热处理";

  /**
   * 应用上游带出值（docs/47 §3.5 / R4）。
   *
   * 必须以「当前真实指标行」为输入并一次性计算全部新行：不能在两个 setState updater
   * 里顺手收集 inheritedValues——React 的 updater 不在调用当下执行，收集到的 Map 可能仍为空。
   * 同一轮结果会先把上一炉的残留带出值清空，再按新源单白名单重新带出。
   */
  const applyInheritedItems = useCallback(
    (items: readonly HeatTraceInheritedItem[], heatBatchNo: string) => {
      const previousKeys = new Set(inheritedKeysRef.current);
      const sameBatch = inheritedBatchKeyRef.current === traceKey(heatBatchNo);
      const newInherited: Record<string, string> = {};

      const nextChem = chemRowsRef.current.map((row) => {
        const key = `chem_${row.itemCode}`;
        const matched = items.find((item) => matchesChemicalItem(item, row));
        if (matched !== undefined) {
          const value =
            matched.measuredVal !== undefined ? String(matched.measuredVal) : matched.measuredText ?? "";
          if (value !== "") {
            newInherited[key] = value;
            // 同一炉号重复响应：人工改过的字段保留现值，只更新 inheritedFrom 的原值快照
            if (sameBatch && modifiedItemsRef.current.has(key)) return row;
            return { ...row, actual: value };
          }
        }
        if (previousKeys.has(key)) {
          // 同一源单刷新后该项消失：保留人工编辑结果，但取消它的「继承」标记
          return sameBatch && modifiedItemsRef.current.has(key) ? row : { ...row, actual: "" };
        }
        return row;
      });

      const nextMech = mechRowsRef.current.map((row) => {
        const key = `mech_${row.itemCode}`;
        const matched = items.find((item) => matchesMechanicalItem(item, row));
        if (matched !== undefined) {
          const value =
            matched.measuredVal !== undefined ? String(matched.measuredVal) : matched.measuredText ?? "";
          if (value !== "") {
            newInherited[key] = value;
            if (sameBatch && modifiedItemsRef.current.has(key)) return row;
            return { ...row, actual: value };
          }
        }
        if (previousKeys.has(key)) {
          return sameBatch && modifiedItemsRef.current.has(key) ? row : { ...row, actual: "" };
        }
        return row;
      });

      chemRowsRef.current = nextChem;
      mechRowsRef.current = nextMech;
      setChemElements(nextChem);
      setMechProperties(nextMech);
      inheritedKeysRef.current = Object.keys(newInherited);
      inheritedBatchKeyRef.current = traceKey(heatBatchNo);
      setInheritedValues(newInherited);
      if (!sameBatch) {
        const empty = new Set<string>();
        modifiedItemsRef.current = empty;
        setModifiedItems(empty);
      } else {
        // 同一批刷新后，已从上游清单消失的项不再算「人工修改继承值」
        const stillModified = new Set(
          [...modifiedItemsRef.current].filter((key) => newInherited[key] !== undefined)
        );
        modifiedItemsRef.current = stillModified;
        setModifiedItems(stillModified);
      }
    },
    []
  );

  /**
   * 回滚已带出值（docs/47 AC-09 / D11）。
   *
   * 带出值只是**初值**：炉批号被清空、或新炉号在上游查无记录时，必须把上一炉带出的值一并归零 ——
   * 否则界面会留着别的炉次的力学 / 化学成分值，录入人稍不注意就把它当本炉数据提交。
   * 只清「上一次确实带出的行」（`inheritedKeysRef`），录入人自己填写的值一律不动。
   */
  const rollbackInherited = useCallback(() => {
    const keys = new Set(inheritedKeysRef.current);
    if (keys.size > 0) {
      const nextChem = chemRowsRef.current.map((row) =>
        keys.has(`chem_${row.itemCode}`) ? { ...row, actual: "" } : row
      );
      const nextMech = mechRowsRef.current.map((row) =>
        keys.has(`mech_${row.itemCode}`) ? { ...row, actual: "" } : row
      );
      chemRowsRef.current = nextChem;
      mechRowsRef.current = nextMech;
      setChemElements(nextChem);
      setMechProperties(nextMech);
    }
    inheritedKeysRef.current = [];
    inheritedBatchKeyRef.current = null;
    setInheritedValues({});
    const emptyModified = new Set<string>();
    modifiedItemsRef.current = emptyModified;
    setModifiedItems(emptyModified);
    setHeatTraceSource(null);
    setHeatTraceError("");
  }, []);

  /**
   * 自动防抖调用 /api/v1/inspections/heat-batch-trace 追溯原材料与热处理历史数据。
   *
   * 服务端口径（docs/47 §3.2 / §3.4）：按「委外热处理(OQC_HEAT) -> 来料检验(IQC) -> 无」三级
   * **逐级回退、级别之间不合并**；`materialCode` 参与匹配（先同物料，无命中才跨物料并回
   * `matchScope = GLOBAL`）。前端只做两件事：把白名单实测值填成初值，以及如实展示来源与范围。
   */
  useEffect(() => {
    // 任何依赖变化都先让在途旧请求失效；回看 / 方案未就绪时再直接返回
    heatTraceSeqRef.current += 1;
    if (readOnly || planMatch.status !== "ready") {
      setHeatTraceLoading(false);
      setHeatTraceError("");
      return;
    }

    const raw = heatNo.trim();
    if (raw === "") {
      // 清空炉批号：已带出值回滚为空、计数清零、Banner 消失（AC-09）
      rollbackInherited();
      return;
    }

    const requestId = heatTraceSeqRef.current;
    const timer = setTimeout(async () => {
      try {
        setHeatTraceLoading(true);
        setHeatTraceError("");
        const trace = await api.get<FurnaceHeatTraceResponse>(
          `/inspections/heat-batch-trace?heatBatchNo=${encodeURIComponent(raw)}${
            materialCode !== "" ? `&materialCode=${encodeURIComponent(materialCode)}` : ""
          }${
            // 排除本单自己：本单本身处于「检验中」，不排除就会被当成「上游未终判」给出假提示（TBD-01）
            typeof initialItem?.id === "string" && initialItem.id !== ""
              ? `&excludeOrderId=${encodeURIComponent(initialItem.id)}`
              : ""
          }`
        );
        if (requestId !== heatTraceSeqRef.current) return;

        const inheritedItems = trace.inheritedItems;
        const emptyState = trace.sourceType === "NONE" || inheritedItems.length === 0;
        if (emptyState) {
          rollbackInherited();
          // 空态也可能是「只提示、不带值」：同炉不合格 / MRB 未结案 / 未终判时服务端给提示但不带出任何值，
          // 此时仍要挂上 heatTraceSource（只渲染琥珀色提示条；蓝色 Banner 由 sourceType !== NONE 把关）。
          if (trace.sourceType !== "NONE" || trace.upstreamWarning !== undefined) {
            setHeatTraceSource({
              sourceType: trace.sourceType,
              ...(trace.sourceOrderNo !== undefined ? { sourceOrderNo: trace.sourceOrderNo } : {}),
              batchNo: trace.heatBatchNo,
              ...(trace.matchScope !== undefined ? { matchScope: trace.matchScope } : {}),
              ...(trace.upstreamWarning !== undefined ? { upstreamWarning: trace.upstreamWarning } : {}),
            });
          }
          return;
        }

        setHeatTraceSource({
          sourceType: trace.sourceType,
          ...(trace.sourceOrderNo !== undefined ? { sourceOrderNo: trace.sourceOrderNo } : {}),
          batchNo: trace.heatBatchNo,
          ...(trace.matchScope !== undefined ? { matchScope: trace.matchScope } : {}),
          ...(trace.upstreamWarning !== undefined ? { upstreamWarning: trace.upstreamWarning } : {}),
        });
        applyInheritedItems(inheritedItems, trace.heatBatchNo);
      } catch (e) {
        if (requestId !== heatTraceSeqRef.current) return;
        // 查询失败也要先回滚上一炉带出值：失败提示可以重试，但旧炉次数据绝不能挂到新炉号下
        rollbackInherited();
        setHeatTraceError(errorMessage(e));
        console.warn("未能匹配到该炉号的前序溯源单据", e);
      } finally {
        if (requestId === heatTraceSeqRef.current) setHeatTraceLoading(false);
      }
    }, 450);

    return () => clearTimeout(timer);
  }, [
    heatNo,
    materialCode,
    planMatch.status,
    readOnly,
    rollbackInherited,
    applyInheritedItems,
    initialItem?.id,
  ]);

  /**
   * 查询 MES 外部追溯（生产任务单 + 过程检验报告），只读参考，不带回填。
   * 两个接口并行拉取，任一失败不影响另一个（catch 在各自 Promise.all 外层统一处理）。
   */
  const fetchMes = useCallback(async (keyword: string) => {
    const seed = keyword.trim();
    if (seed === "") {
      setMesTasks([]);
      setMesReports([]);
      setMesError("");
      return;
    }
    setMesLoading(true);
    setMesError("");
    try {
      const [tasksRes, reportsRes] = await Promise.all([
        api.get<{ page: number; pageSize: number; items: Record<string, any>[] }>(
          "/integration/mes/tasks",
          { search: seed, page: 1, pageSize: 20 }
        ),
        api.get<{ page: number; pageSize: number; items: Record<string, any>[] }>(
          "/integration/mes/check-reports",
          { search: seed, page: 1, pageSize: 20 }
        ),
      ]);
      setMesTasks(tasksRes?.items ?? []);
      setMesReports(reportsRes?.items ?? []);
    } catch (e) {
      setMesError(errorMessage(e));
      setMesTasks([]);
      setMesReports([]);
    } finally {
      setMesLoading(false);
    }
  }, []);

  /**
   * MES 外部追溯联动：炉号 / 批号 / 物料编码任一变化即自动按种子查询（只读参考，不带回填）。
   * 与 heat-batch-trace 的防抖同源（450ms），避免用户连续输入时频繁打 MES 库。
   */
  useEffect(() => {
    const seed = heatNo.trim() || lotNo.trim() || materialCode.trim();
    setMesSearch(seed);
    if (seed !== "") setMesOpen(true);
    const timer = setTimeout(() => {
      void fetchMes(seed);
    }, 450);
    return () => clearTimeout(timer);
  }, [heatNo, lotNo, materialCode, fetchMes]);

  const handleChemChange = (idx: number, itemCode: string, val: string) => {
    const updated = [...chemElements];
    updated[idx].actual = val;
    chemRowsRef.current = updated;
    setChemElements(updated);

    const key = `chem_${itemCode}`;
    const orig = inheritedValues[key];
    const newModified = new Set(modifiedItems);
    if (orig !== undefined && val !== orig) {
      newModified.add(key);
    } else {
      newModified.delete(key);
    }
    modifiedItemsRef.current = newModified;
    setModifiedItems(newModified);
  };

  const handleMechChange = (idx: number, itemCode: string, val: string) => {
    const updated = [...mechProperties];
    updated[idx].actual = val;
    mechRowsRef.current = updated;
    setMechProperties(updated);

    const key = `mech_${itemCode}`;
    const orig = inheritedValues[key];
    const newModified = new Set(modifiedItems);
    if (orig !== undefined && val !== orig) {
      newModified.add(key);
    } else {
      newModified.delete(key);
    }
    modifiedItemsRef.current = newModified;
    setModifiedItems(newModified);
  };

  /**
   * 组装质量保证证书（docs/35 §9 M8）：
   * 一律经 `certificateDataService.buildOqcCertificateData` 组装 —— 键名口径（issueDate /
   * specification / steelGrade / batchNo / dimensions…）只在服务里定义一次，表单不再手搓对象
   * （历史实现手搓 `date / spec / materialGrade / lotNo / deliveryStatus / dimensionalAndVisual`，
   * 模板读不到 -> 抬头恒空白；`approver: "陈总工程师"` 更是直接编造一个签核人名）。
   * 实测分区由**本单方案指标行**转换而来，未填实测值的行不下发 -> 该分段不打印。
   * 企业档案（抬头 / 印章 / 供货单位·产地）取主数据，未维护即留白（不回落硬编码抬头常量）。
   * 签发日期不取入库日期：不传即由服务取「今天」（生成本证书的动作真实发生在今天）。
   */
  const handleOpenCert = () => {
    void (async () => {
      const companyProfile = await loadCompanyProfile();
      // 出证模板按本单落库的 certTemplate 走（docs/51）：
      // 出货单被选成横向制造证书时，同一表单态交给制造证书 builder 组装
      if (certTemplate === "MANUFACTURING") {
        const cert = buildManufacturingCertData({
          orderNo: certNo,
          customerName: customer,
          purchaseOrderNo: orderNo,
          deliveryNoteNo: deliveryNo,
          materialName: productName,
          partSpec: spec,
          dimension: spec,
          steelGrade: materialGrade,
          materialGrade,
          quantity,
          heatNo,
          batchNo: lotNo,
          standardsApplied: standard,
          standard,
          inspectorName: inspector,
          remarks: conclusion,
          certFields,
          items: certificateItemsFromRows(planRowsForSubmit),
          ...(companyProfile !== null ? { companyProfile } : {}),
        });
        setMfgCertData(cert);
      } else {
        const cert = buildOqcCertificateData({
          orderNo: certNo,
          customer,
          customerAddress: "",
          contractNo: orderNo,
          deliveryNo,
          productName,
          spec,
          steelGrade: materialGrade,
          heatNo,
          batchNo: lotNo,
          quantity,
          standard,
          inspector,
          // 质量负责人：有真实签核动作才有值；未签核即空（证书批准人栏留白，docs/35 §5）
          ...(approver.name !== "" ? { approverName: approver.name } : {}),
          // 综合判定：只有检验员真的选了判定才打印结论；「特采」是 MRB 会签结论，录入表单无权直接落 CONCESSION
          ...(decision === "合格" ? { judgment: "PASSED" } : decision === "不合格" ? { judgment: "FAILED" } : {}),
          inspectionNotes: conclusion,
          certFields,
          items: certificateItemsFromRows(planRowsForSubmit),
          ...(companyProfile !== null ? { companyProfile } : {}),
        });
        setCertData(cert);
      }
      setCertModalOpen(true);
    })();
  };

  /**
   * 提交出货检验（docs/35 §4 M3 写路径，与委外 / IQC 同一套口径）：
   *   ① POST /inspections/{id}/submit-measurements —— 只下发本单方案快照内、且已填写的指标项；
   *      存在空项时按草稿落库（isDraft:true），避免「未录入」被领域终判成不合格并汇入待审池；
   *   ② POST /inspections/{id}/status —— 终判：合格 -> PASSED(+judgment PASSED)、
   *      不合格 -> FAILED(+judgment FAILED)、特采 -> FAILED（**不落 CONCESSION**，
   *      仅以 preliminaryDisposition 表达处置意图）。
   *      「特采放行」是 MRB 会签结论且领域要求客户签核凭证（CONCESSION 必带凭证），
   *      检验员在录入表单里无权直接把单据判成特采放行；判定不合格后服务端会**自动创建
   *      MRB 评审单**（docs/43，无人工发起环节），由 MRB 会签决定特采 / 返工 / 退货 / 报废，
   *      这里只把检验员的处置意图（拟定处置）与申请写进备注留痕。
   * 回执：绿字显示服务端返回的检验单号；失败按 ApiError 文案红字就地提示（不再 alert 假成功）。
   */
  const handleSubmitInternal = async () => {
    if (submitting) return;
    const orderId = typeof initialItem?.id === "string" ? initialItem.id : "";
    if (orderId === "") {
      setSubmitError("本单尚未落库（列表行未带检验单 ID），无法提交实测值与判定");
      return;
    }
    if (inspector.trim() === "") {
      setSubmitError("请先填写检验员（检验单落库的检验人）");
      return;
    }
    // TBD-03（出货检验炉批号是否必填）：默认必填，但判定一律经 oqcHeatNoRequirement 单点实现 ——
    // 客户若确认「不必填」，改那一处默认值即可收回，不必动本文件的提交链路。
    const heatNoError = validateOqcHeatNo(heatNo);
    if (heatNoError !== null) {
      setSubmitError(heatNoError);
      return;
    }
    if (planRowsForSubmit.length === 0) {
      setSubmitError("本单未匹配到质检方案指标行，无法提交（请先确认该物料的已启用质检方案）");
      return;
    }

    // 不解检（EXEMPT）行随提交下发：服务端按 isExempt 判 EXEMPT 并剔除出合格率分母（v2.6.0 未结模块）
    const measuredRows = planRowsForSubmit.filter((row) => row.isExempt || String(row.actual).trim() !== "");
    const hasBlankRows = planRowsForSubmit.some((row) => !row.isExempt && String(row.actual).trim() === "");
    const qty = parseQuantity(quantity);

    setSubmitting(true);
    setSubmitError("");
    setSubmitReceipt("");
    try {
      // 表头业务事实先落库（docs/47 §4.6 / D1）：炉批号 / 材质牌号 / 执行技术标准 / 检验日期。
      // 此前出货检验表头**没有任何写路径** —— 界面上填了炉号，提交后库里仍是空，
      // 下游单据与质保书炉号栏自然也就没有来源。空串 = 清空（契约语义）。
      // 溯源留痕（heat_source_type / heat_source_order_no）由服务端按三级优先级重新解析，前端不自称来源。
      await api.patch(`/inspections/${encodeURIComponent(orderId)}/header`, {
        furnaceHeatNo: heatNo.trim(),
        // 证书模板选择与字段袋随头落库（docs/51）：字段袋整包覆盖（空值即清空）
        certTemplate,
        certFields,
        ...(materialGrade.trim() !== "" ? { materialGrade: materialGrade.trim() } : {}),
        ...(standard.trim() !== "" ? { techStandard: standard.trim() } : {}),
        ...(inspectDate.trim() !== "" ? { inspectedDate: inspectDate.trim() } : {}),
      });

      if (measuredRows.length > 0) {
        await api.post(`/inspections/${encodeURIComponent(orderId)}/submit-measurements`, {
          isDraft: hasBlankRows,
          // 填写值只在**正式判定**时下发：草稿只暂存实测值、不做判定，也就没有数量口径（docs/21 §14）
          ...(hasBlankRows
            ? {}
            : {
                passQty: decision === "合格" && qty !== null ? qty : 0,
                failQty: decision === "合格" ? 0 : qty !== null ? qty : 0,
              }),
          items: measuredRows.map((row) => {
            if (row.isExempt) {
              return { itemCode: row.itemCode, isExempt: true };
            }
            const numeric = parseMeasuredNumber(row.actual);
            // 继承留痕（docs/47 §3.6 / AC-08 / R5）：带出项标记来源类型 + 带出原值 + 是否被人工改过；
            // 非带出项标 MANUAL_ENTRY —— 落库后证书与审计能区分「上游继承值」与「本单人工录入值」。
            const inheritKey =
              inheritedValues[`chem_${row.itemCode}`] !== undefined
                ? `chem_${row.itemCode}`
                : `mech_${row.itemCode}`;
            const inheritedVal = inheritedValues[inheritKey];
            const inheritedSource =
              heatTraceSource?.sourceType === "IQC_RAW_MATERIAL"
                ? "IQC_RAW_MATERIAL"
                : "OUTSOURCE_HEAT_TREATMENT";
            return {
              itemCode: row.itemCode,
              isExempt: false,
              ...(numeric !== undefined && row.planItem.dataType === "NUMERIC" ? { measuredVal: numeric } : {}),
              measuredText: row.actual,
              inheritedFrom: (inheritedVal !== undefined ? inheritedSource : "MANUAL_ENTRY") as
                | "OUTSOURCE_HEAT_TREATMENT"
                | "IQC_RAW_MATERIAL"
                | "MANUAL_ENTRY",
              ...(inheritedVal !== undefined
                ? {
                    originalInheritedValue: inheritedVal,
                    isManuallyModified: modifiedItems.has(inheritKey),
                  }
                : {}),
            };
          }),
        });
      }

      const targetStatus = decision === "合格" ? "PASSED" : "FAILED";
      const note =
        decision === "特采"
          ? [conclusion.trim(), "检验员申请特采（让步放行），转 MRB 评审"].filter((part) => part !== "").join("；")
          : conclusion.trim();
      // 拟定处置（docs/43 §4.4）：特采 / 让步接收 -> CONCESSION，作为自动创建的 MRB 单
      // 「处置方式」列初值（终审时由处置决策覆盖；合格不下发）。
      const preliminaryDisposition = decision === "特采" ? "CONCESSION" : undefined;
      const finished = await api.post<{ orderNo?: string }>(
        `/inspections/${encodeURIComponent(orderId)}/status`,
        {
          status: targetStatus,
          passQty: decision === "合格" && qty !== null ? qty : 0,
          failQty: decision === "合格" ? 0 : qty !== null ? qty : 0,
          ...(decision === "特采" ? {} : { judgment: targetStatus }),
          ...(note !== "" ? { remark: note, inspectionNotes: note } : {}),
          ...(preliminaryDisposition !== undefined ? { preliminaryDisposition } : {}),
        }
      );

      const orderNo = finished.orderNo ?? certNo;
      setSubmitted({ orderId, orderNo });
      setSubmitReceipt(
        decision === "合格"
          ? `已保存并终判：${orderNo}（判定：合格）`
          : `已保存并终判：${orderNo}（判定：${decision}）· 已自动发起 MRB 评审，请到【MRB不合格品处置】查看`
      );
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  /** 完成并返回列表：写路径与回执已在上一步给过，这里只做状态复位回调（父页不再 alert 假成功） */
  const handleFinish = () => {
    onSubmit({
      certNo,
      orderNo,
      decision,
      modifiedItems: Array.from(modifiedItems),
      inspector,
      planVersionId,
      planMatchSource: planMatch.matchSource,
      items: planRowsForSubmit.map((row) => ({
        itemCode: row.itemCode,
        name: row.title,
        standard: row.standard,
        measuredText: row.actual,
        unit: row.unit,
        result: DECISION_LABEL[judgeIndicatorRow(row)],
      })),
    });
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
          <ApprovalButton
            orderId={typeof initialItem?.id === "string" ? initialItem.id : ""}
            approverName={approver.name}
            approvedAt={approver.at}
            onApproved={(result) =>
              setApprover({ name: result.approverName ?? approver.name, at: result.approvedAt ?? approver.at })
            }
          />
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

      {/* 质检方案匹配状态：命中才渲染指标清单，未命中则引导配置方案 */}
      <PlanMatchBanner state={planMatch} materialCode={materialCode} inspectionType="OQC_SH" />

      {/*
        只读回看（readOnly）把「指标清单 + 标准值 + 实测值 + 判定」整段置为不可编辑：
        fieldset[disabled] 一次性禁用内部全部表单控件，避免"能看历史单据、却能改历史结论"。
        底部判定与打印按钮不在其中，回看时依旧可出质保书。
      */}
      <fieldset disabled={readOnly} className="border-0 p-0 m-0 min-w-0 space-y-4">
      {/*
        同炉异常提示（TBD-01 / docs/47 §3.9）：**只提示、不带值、不阻断** —— 上游同一炉批号存在
        不合格 / MRB 未结案 / 未终判 记录时给出，与蓝色 Banner 相互独立：
        空态（sourceType = NONE，例如同炉只有一张不合格单）也必须出现这一条。
        文案由服务端组装（warningWithMessage），界面只选标题，不二次拼接。
      */}
      {heatTraceSource?.upstreamWarning && (
        <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 flex items-start gap-2.5 text-xs text-amber-900 shadow-sm">
          <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
          <div>
            <span className="font-bold mr-1">
              {heatTraceSource.upstreamWarning.code === "UPSTREAM_FAILED"
                ? "同炉不合格提示"
                : heatTraceSource.upstreamWarning.code === "UPSTREAM_UNDER_MRB"
                  ? "同炉 MRB 未结案提示"
                  : "同炉检验未终判提示"}
            </span>
            <span>{heatTraceSource.upstreamWarning.message}</span>
          </div>
        </div>
      )}

      {/* 炉批号溯源联动提示 Banner（只在真的带出数据时出现；空态提示见上一条） */}
      {heatTraceSource && heatTraceSource.sourceType !== "NONE" && (
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-3 flex items-center justify-between text-xs text-blue-900 shadow-sm">
          <div className="flex items-center gap-2.5">
            <span className="font-bold bg-blue-600 text-white px-2 py-0.5 rounded text-[11px] flex items-center gap-1">
              <Sparkles className="w-3 h-3" />
              {/* 来源枚举与契约 HeatTraceSourceTypeEnum 同源：OUTSOURCE_HEAT_TREATMENT / IQC_RAW_MATERIAL
                  （此前这里比的是 OUTSOURCE_HEAT_ORDER，永远匹配不上 -> Banner 恒显示「来料检验」，docs/47 D8） */}
              {heatTraceSource.sourceType === "OUTSOURCE_HEAT_TREATMENT"
                ? "委外热处理"
                : "来料检验 (IQC)"}{" "}
              炉批号溯源联动
            </span>
            <span>
              {Object.keys(inheritedValues).length === 0 ? (
                // docs/47 §9.6.4（体验项）：上游有记录但本单方案没有可带出的白名单指标行时，
                // 不说「自动带入」—— 实际没有任何值落地，那样写会让录入人误以为已经带出。
                <>
                  已按炉号 <strong>{heatTraceSource.batchNo}</strong> 关联到前道工序检验记录
                  {heatTraceSource.sourceOrderNo && ` (源单据: ${heatTraceSource.sourceOrderNo})`}
                  ，但本单方案指标行中没有可带出的项（白名单：化学成分 / 力学性能），请按实测手工录入
                </>
              ) : (
                <>
                  已依据炉号 <strong>{heatTraceSource.batchNo}</strong> 自动带入前道工序真实检验数据
                  {heatTraceSource.sourceOrderNo && ` (源单据: ${heatTraceSource.sourceOrderNo})`}
                </>
              )}
              {heatTraceSource.matchScope === "GLOBAL" && materialCode !== "" && (
                <span className="ml-1 text-amber-700 font-medium">（跨物料命中，请确认炉次归属）</span>
              )}
            </span>
          </div>
          {modifiedItems.size > 0 ? (
            <span className="bg-amber-100 border border-amber-300 text-amber-900 px-2.5 py-1 rounded text-[11px] font-bold flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
              已手动修改 {modifiedItems.size} 项指标 (将自动保留快照并留痕审计)
            </span>
          ) : Object.keys(inheritedValues).length === 0 ? (
            <span className="text-[11px] text-slate-500 font-medium">带出 0 项</span>
          ) : (
            <span className="text-[11px] text-blue-600 font-medium">
              ✓ 数据与上游档案完全一致
            </span>
          )}
        </div>
      )}

      {/* MES 外部追溯（生产任务 / 过程检验）：只读参考，来源 MES 库，不参与 QMS 判定与回填 */}
      <div className="bg-white border border-slate-200/80 rounded-lg p-4 shadow-sm space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-800">
            <Layers className="w-4 h-4 text-indigo-600" />
            <span>MES 外部追溯（生产任务 / 过程检验）</span>
            {mesLoading && <span className="text-[10px] text-blue-500 animate-pulse">查询中…</span>}
          </div>
          <button
            type="button"
            onClick={() => setMesOpen((v) => !v)}
            className="text-[11px] text-slate-500 hover:text-slate-700"
          >
            {mesOpen ? "收起" : "展开"}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={mesSearch}
            onChange={(e) => setMesSearch(e.target.value)}
            placeholder="按炉号 / 批号 / 物料编码查询 MES 追溯"
            className="w-72 bg-slate-50/50 border border-slate-200 rounded px-2.5 py-1.5 text-xs text-slate-800 focus:bg-white focus:outline-none focus:border-blue-500 font-mono"
          />
          <button
            type="button"
            onClick={() => void fetchMes(mesSearch)}
            className="px-3 py-1.5 rounded bg-indigo-50 border border-indigo-200 text-indigo-700 text-xs font-medium hover:bg-indigo-100"
          >
            查询 MES 追溯
          </button>
        </div>
        {mesError !== "" && <div className="text-xs text-rose-600">{mesError}</div>}
        {mesOpen && (
          <div className="space-y-3">
            {/* 生产任务单 */}
            <div>
              <div className="text-[11px] font-semibold text-slate-600 mb-1">
                生产任务单 (t_production_task) · {mesTasks.length} 条
              </div>
              {mesTasks.length === 0 ? (
                <div className="text-[11px] text-slate-400 py-2">无匹配生产任务</div>
              ) : (
                <div className="overflow-x-auto border border-slate-100 rounded">
                  <table className="w-full text-[11px] text-left">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>
                        <th className="py-1.5 px-2">生产单号</th>
                        <th className="py-1.5 px-2">炉号</th>
                        <th className="py-1.5 px-2">钢厂</th>
                        <th className="py-1.5 px-2">物料编码</th>
                        <th className="py-1.5 px-2">物料名称</th>
                        <th className="py-1.5 px-2 text-right">生产数</th>
                        <th className="py-1.5 px-2">日期</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {mesTasks.map((t, i) => (
                        <tr key={t.id ?? i} className="hover:bg-slate-50/50">
                          <td className="py-1.5 px-2 font-mono">{t.bill_no}</td>
                          <td className="py-1.5 px-2 font-mono">{t.heat_number}</td>
                          <td className="py-1.5 px-2">{t.steel_mill}</td>
                          <td className="py-1.5 px-2 font-mono">{t.materiel_code}</td>
                          <td className="py-1.5 px-2">{t.materiel_name}</td>
                          <td className="py-1.5 px-2 text-right">{t.production_num}</td>
                          <td className="py-1.5 px-2">{String(t.bill_date ?? '').slice(0, 10)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            {/* 过程检验报告 */}
            <div>
              <div className="text-[11px] font-semibold text-slate-600 mb-1">
                过程检验报告 (t_check_report) · {mesReports.length} 条
              </div>
              {mesReports.length === 0 ? (
                <div className="text-[11px] text-slate-400 py-2">无匹配过程检验记录</div>
              ) : (
                <div className="overflow-x-auto border border-slate-100 rounded">
                  <table className="w-full text-[11px] text-left">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>
                        <th className="py-1.5 px-2">检验单号</th>
                        <th className="py-1.5 px-2">关联生产单</th>
                        <th className="py-1.5 px-2">工序</th>
                        <th className="py-1.5 px-2">炉号</th>
                        <th className="py-1.5 px-2 text-right">验货数</th>
                        <th className="py-1.5 px-2 text-right">合格数</th>
                        <th className="py-1.5 px-2 text-right">不合格</th>
                        <th className="py-1.5 px-2">判定</th>
                        <th className="py-1.5 px-2">检验人</th>
                        <th className="py-1.5 px-2">日期</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {mesReports.map((r, i) => (
                        <tr key={r.id ?? i} className="hover:bg-slate-50/50">
                          <td className="py-1.5 px-2 font-mono">{r.bill_no}</td>
                          <td className="py-1.5 px-2 font-mono">{r.task_bill_no}</td>
                          <td className="py-1.5 px-2">{r.procedure_name}</td>
                          <td className="py-1.5 px-2 font-mono">{r.heat_number}</td>
                          <td className="py-1.5 px-2 text-right">{r.check_qty}</td>
                          <td className="py-1.5 px-2 text-right">{r.qualified_qty}</td>
                          <td className="py-1.5 px-2 text-right">{r.unqualified_qty}</td>
                          <td className="py-1.5 px-2">
                            {r.is_qualified === 1 || r.is_qualified === true
                              ? "合格"
                              : r.is_qualified === 0 || r.is_qualified === false
                                ? "不合格"
                                : String(r.is_qualified ?? "")}
                          </td>
                          <td className="py-1.5 px-2">{r.inspector_name}</td>
                          <td className="py-1.5 px-2">{String(r.bill_date ?? '').slice(0, 10)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

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
              <span>
                原材料炉批号 (Heat No) {oqcHeatNoRequirementMarker()}
              </span>
              {heatTraceLoading && <span className="text-[10px] text-blue-500 animate-pulse">正在溯源数据...</span>}
            </label>
            <input
              type="text"
              value={heatNo}
              onChange={(e) => setHeatNo(e.target.value)}
              placeholder="输入炉号自动带出化学与力学性能"
              className="w-full bg-slate-50/50 border border-blue-300 rounded px-2.5 py-1.5 text-slate-900 font-mono font-bold focus:bg-white focus:outline-none focus:border-blue-600"
            />
            {heatTraceError !== "" && (
              <div className="mt-1 text-[11px] text-rose-600">{heatTraceError}</div>
            )}
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
        <table className="w-full text-xs text-left">
          <thead className="bg-slate-50 text-slate-600 font-medium border-b border-slate-200">
            <tr>
              <th className="py-2.5 px-4 w-40">元素 (Element)</th>
              <th className="py-2.5 px-4 w-20">单位</th>
              <th className="py-2.5 px-4 w-52">标准技术规范 (Standard Requirement)</th>
              <th className="py-2.5 px-4">实际测试值 (Actual Value)</th>
              <th className="py-2.5 px-4 w-32 text-center">单项判定</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {chemElements.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-[11px] text-slate-400">
                  {planSectionEmptyText(planMatch.status, '化学成分')}
                </td>
              </tr>
            )}
            {chemElements.map((el, idx) => {
              const key = `chem_${el.itemCode}`;
              const isMod = modifiedItems.has(key);
              const decision = judgeIndicatorRow(el);
              return (
                <tr key={`${el.itemCode}-${idx}`} className={`hover:bg-slate-50/50 ${isMod ? "bg-amber-50/20" : ""}`}>
                  <td className="py-2.5 px-4 font-medium text-slate-800">
                    <div className="flex items-center gap-1.5">
                      <span>{el.title}</span>
                      {isMod && (
                        <span className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.2 rounded font-medium border border-amber-300">
                          ✎ 已手动修改 (inheritedFrom: {inheritedSourceLabel}, 原值: {inheritedValues[key]})
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-2.5 px-4 text-slate-500">{el.unit ?? '%'}</td>
                  <td className="py-2.5 px-4 text-slate-600 font-mono">{el.standard}</td>
                  <td className="py-2.5 px-4">
                    <IndicatorActualField
                      row={el}
                      readOnly={readOnly}
                      onValueChange={(value) => handleChemChange(idx, el.itemCode, value)}
                      className={`w-48 bg-white border rounded px-2 py-1 font-mono font-medium text-xs focus:outline-none ${
                        isMod
                          ? "border-amber-400 text-amber-900 bg-amber-50/30 ring-1 ring-amber-300"
                          : decision === "FAILED"
                          ? "border-rose-400 text-rose-600"
                          : "border-slate-200 focus:border-blue-500"
                      }`}
                    />
                  </td>
                  <td className="py-2.5 px-4 text-center">
                    <VerdictBadge decision={decision} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
            {mechProperties.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-[11px] text-slate-400">
                  {planSectionEmptyText(planMatch.status, '力学与物理性能')}
                </td>
              </tr>
            )}
            {mechProperties.map((item, idx) => {
              const key = `mech_${item.itemCode}`;
              const isMod = modifiedItems.has(key);
              const decision = judgeIndicatorRow(item);
              return (
                <tr key={`${item.itemCode}-${idx}`} className={`hover:bg-slate-50/50 ${isMod ? "bg-amber-50/20" : ""}`}>
                  <td className="py-2.5 px-4 font-medium text-slate-800">
                    <div className="flex items-center gap-1.5">
                      <span>{item.title}</span>
                      {isMod && (
                        <span className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.2 rounded font-medium border border-amber-300">
                          ✎ 已手动修改 (inheritedFrom: {inheritedSourceLabel}, 原值: {inheritedValues[key]})
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-2.5 px-4 text-slate-500">{item.unit}</td>
                  <td className="py-2.5 px-4 text-slate-600 font-mono">{item.standard}</td>
                  <td className="py-2.5 px-4">
                    <IndicatorActualField
                      row={item}
                      readOnly={readOnly}
                      onValueChange={(value) => handleMechChange(idx, item.itemCode, value)}
                      className={`w-48 bg-white border rounded px-2 py-1 font-mono font-medium text-xs focus:outline-none ${
                        isMod
                          ? "border-amber-400 text-amber-900 bg-amber-50/30 ring-1 ring-amber-300"
                          : decision === "FAILED"
                          ? "border-rose-400 text-rose-600"
                          : "border-slate-200 focus:border-blue-500"
                      }`}
                    />
                  </td>
                  <td className="py-2.5 px-4 text-center">
                    <VerdictBadge decision={decision} />
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
            {dimItems.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-[11px] text-slate-400">
                  {planSectionEmptyText(planMatch.status, '尺寸与外观')}
                </td>
              </tr>
            )}
            {dimItems.map((item, idx) => (
              <tr key={`${item.itemCode}-${idx}`} className="hover:bg-slate-50/50">
                <td className="py-2.5 px-4 font-medium text-slate-800">{item.title}</td>
                <td className="py-2.5 px-4 text-slate-500">{item.unit}</td>
                <td className="py-2.5 px-4 text-slate-600 font-mono">{item.standard}</td>
                <td className="py-2.5 px-4">
                  <IndicatorActualField
                    row={item}
                    readOnly={readOnly}
                    onValueChange={(value) => {
                      const updated = [...dimItems];
                      updated[idx].actual = value;
                      setDimItems(updated);
                    }}
                    className={`w-48 bg-white border rounded px-2 py-1 font-mono font-medium focus:outline-none ${
                      judgeIndicatorRow(item) === "FAILED"
                        ? "border-rose-400 text-rose-600"
                        : "border-slate-200 focus:border-blue-500"
                    }`}
                  />
                </td>
                <td className="py-2.5 px-4 text-center">
                  <VerdictBadge decision={judgeIndicatorRow(item)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      </fieldset>

      {/* 证书补充字段（docs/51）：按建单时选定的模板展示专属输入项，写入 cert_fields 随单落库 */}
      <CertFieldsCard
        kind={certTemplate}
        value={certFields}
        readOnly={readOnly}
        onChange={(key, value) => setCertFields((prev) => ({ ...prev, [key]: value }))}
      />

      {/* 备注（随单填写、随单落库）：质保书「备注 IN REMARK」只打印这里的真实内容，不预置任何文案 */}
      <div className="bg-white border border-slate-200/80 rounded-lg p-4 shadow-sm">
        <label className="block text-slate-600 mb-1 text-xs font-semibold">备注</label>
        <textarea
          rows={2}
          readOnly={readOnly}
          value={conclusion}
          onChange={(e) => setConclusion(e.target.value)}
          placeholder="填写将打印在质保书「备注 IN REMARK」栏的内容；留空则该栏留白"
          className="w-full border border-slate-200 rounded p-2 text-xs text-slate-700 focus:outline-none focus:border-blue-500"
        />
      </div>

      {/* 底部综合判定与操作区 */}
      <div className="bg-white border border-slate-200/80 rounded-lg p-4 shadow-sm flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex flex-wrap items-center gap-4 text-xs">
            <div className="flex items-center gap-1.5">
              <span className="text-slate-500">检验项:</span>
              <span className="font-bold text-slate-800">{judgement.total} 项</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-slate-500">免检:</span>
              <span className="font-bold text-sky-700">{judgement.exempt} 项</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-slate-500">待判定:</span>
              <span className="font-bold text-slate-500">{judgement.pending} 项</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-slate-500">指标合格率:</span>
              {judgement.passRate === null ? (
                <span className="font-bold text-slate-500">暂无有效参检项</span>
              ) : (
                <span
                  className={`font-black px-2 py-0.5 rounded border ${
                    judgement.failed > 0
                      ? "bg-rose-100 text-rose-800 border-rose-300"
                      : "bg-emerald-100 text-emerald-800 border-emerald-300"
                  }`}
                >
                  {(judgement.passRate * 100).toFixed(1)}%
                </span>
              )}
            </div>
          </div>
          <span className="text-slate-200">|</span>
          <span className="text-xs font-bold text-slate-700">综合判定结论:</span>
          <div className="flex gap-2">
            {(["合格", "不合格", "特采"] as const).map((dec) => (
              <button
                key={dec}
                type="button"
                onClick={() => setDecision(dec)}
                disabled={readOnly}
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

        {(submitReceipt !== "" || submitError !== "") && (
          <div
            className={`mb-2 text-xs ${submitError !== "" ? "text-rose-600" : "text-emerald-700"}`}
            data-testid="oqc-submit-receipt"
          >
            {submitError !== "" ? submitError : submitReceipt}
          </div>
        )}

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
            <FileSpreadsheet className="w-3.5 h-3.5" /> 质检报告 (打印/导出)
          </button>
          <button
            type="button"
            onClick={handleOpenCert}
            className="px-4 py-1.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-medium hover:bg-emerald-100 flex items-center gap-1.5"
          >
            <Printer className="w-3.5 h-3.5" />
            {certTemplate === "MANUFACTURING" ? "预览与打印制造证书" : "预览与打印质保书"}
          </button>
          {/* 只读回看：不出提交按钮，避免"回看历史单据"被误当成"重新提交判定" */}
          {!readOnly && submitted === null && (
          <button
            type="button"
            onClick={() => {
              void handleSubmitInternal();
            }}
            disabled={submitting}
            className="px-5 py-1.5 rounded bg-blue-600 text-white text-xs font-medium hover:bg-blue-500 shadow-sm disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {submitting ? "提交中…" : "保存并提交出货判定"}
          </button>
          )}
          {!readOnly && submitted !== null && (
          <button
            type="button"
            onClick={handleFinish}
            className="px-5 py-1.5 rounded bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-500 shadow-sm"
          >
            完成并返回列表
          </button>
          )}
        </div>
      </div>

      {/* 弹窗一：出货证书（docs/51：按本单落库的模板渲染质保书或制造证书） */}
      <CertificatePrintModal
        isOpen={certModalOpen}
        onClose={() => setCertModalOpen(false)}
        type={certTemplate === "MANUFACTURING" ? "manufacturing" : "quality"}
        qualityData={certData}
        manufacturingData={mfgCertData}
      />

      {/* 弹窗二：多模板四段式打印选择弹窗 (PrintTemplateModal) */}
      <PrintTemplateModal
        open={templateModalOpen}
        onClose={() => setTemplateModalOpen(false)}
        orderId={typeof initialItem?.id === "string" ? initialItem.id : undefined}
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
