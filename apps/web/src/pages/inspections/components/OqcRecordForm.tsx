import React, { useState, useEffect } from "react";
import { ArrowLeft, Printer, ShieldCheck, Atom, Gauge, CheckSquare, Layers, Sparkles, AlertTriangle, FileSpreadsheet } from "lucide-react";
import { CertificatePrintModal } from "../../../components/certificate/CertificatePrintModal";
import { PrintTemplateModal } from "../../../components/common/PrintTemplateModal";
import { IndicatorActualField } from "../../../components/common/IndicatorActualField";
import { PlanMatchBanner } from "../../../components/common/PlanMatchBanner";
import { ApprovalButton } from "../../../components/common/ApprovalButton";
import { QualityCertificateData } from "../../../lib/inspectionTypes";
import { buildOqcCertificateData, certificateItemsFromRows } from "../../../lib/certificateDataService";
import { loadCompanyProfile } from "../../../lib/companyProfile";
import { api, errorMessage } from "../../../lib/api";
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
import type { InspectionItemDecision } from "@letian/contracts";

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
    sourceType: string;
    sourceOrderNo?: string;
    batchNo: string;
  } | null>(null);
  const [inheritedValues, setInheritedValues] = useState<Record<string, string>>({});
  const [modifiedItems, setModifiedItems] = useState<Set<string>>(new Set());

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

  // 指标行就绪即重建三个分区；未命中 / 加载失败时清空，绝不用演示指标行顶替真实方案或本单快照
  useEffect(() => {
    const grouped = splitIndicatorRows(planMatch.rows);
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
  const [, setInspectDate] = useState(todayIsoDate());
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
  }, [planMatch.order]);

  // 打印预览控制
  const [certModalOpen, setCertModalOpen] = useState(false);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [certData, setCertData] = useState<QualityCertificateData | null>(null);

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
                  item.name.toUpperCase() === el.title.toUpperCase() ||
                  item.itemCode.toUpperCase().includes(el.title.toUpperCase())
              );
              if (matched) {
                const val =
                  matched.measuredVal !== undefined
                    ? String(matched.measuredVal)
                    : matched.measuredText ?? el.actual;
                newInherited[`chem_${el.title}`] = val;
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
                  item.name.includes(mp.title) ||
                  mp.title.includes(item.name) ||
                  (mp.title.includes("抗拉") && item.name.includes("抗拉")) ||
                  (mp.title.includes("屈服") && item.name.includes("屈服")) ||
                  (mp.title.includes("伸长率") && item.name.includes("伸长率")) ||
                  (mp.title.includes("硬度") && item.name.includes("硬度")) ||
                  (mp.title.includes("冲击") && item.name.includes("冲击"))
              );
              if (matched) {
                const val =
                  matched.measuredVal !== undefined
                    ? String(matched.measuredVal)
                    : matched.measuredText ?? mp.actual;
                newInherited[`mech_${mp.title}`] = val;
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
        items: certificateItemsFromRows(planRowsForSubmit),
        ...(companyProfile !== null ? { companyProfile } : {}),
      });
      setCertData(cert);
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
    if (planRowsForSubmit.length === 0) {
      setSubmitError("本单未匹配到质检方案指标行，无法提交（请先确认该物料的已启用质检方案）");
      return;
    }

    const measuredRows = planRowsForSubmit.filter((row) => !row.isExempt && String(row.actual).trim() !== "");
    const hasBlankRows = planRowsForSubmit.some((row) => !row.isExempt && String(row.actual).trim() === "");
    const qty = parseQuantity(quantity);

    setSubmitting(true);
    setSubmitError("");
    setSubmitReceipt("");
    try {
      if (measuredRows.length > 0) {
        await api.post(`/inspections/${encodeURIComponent(orderId)}/submit-measurements`, {
          isDraft: hasBlankRows,
          items: measuredRows.map((row) => {
            const numeric = parseMeasuredNumber(row.actual);
            return {
              itemCode: row.itemCode,
              ...(numeric !== undefined && row.planItem.dataType === "NUMERIC" ? { measuredVal: numeric } : {}),
              measuredText: row.actual,
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
          {chemElements.length === 0 && (
            <div className="col-span-full text-center text-[11px] text-slate-400 py-3">
              {planSectionEmptyText(planMatch.status, '化学成分')}
            </div>
          )}
          {chemElements.map((el, idx) => {
            const key = `chem_${el.title}`;
            const isMod = modifiedItems.has(key);
            const decision = judgeIndicatorRow(el);
            return (
              <div
                key={`${el.itemCode}-${idx}`}
                className={`border rounded-lg p-2.5 text-center space-y-1 transition-all ${
                  isMod
                    ? "border-amber-400 bg-amber-50/40 shadow-sm ring-1 ring-amber-300"
                    : "border-slate-200 bg-slate-50/30"
                }`}
              >
                <div className="font-bold text-slate-800 text-sm flex items-center justify-center gap-1">
                  <span>{el.title}</span>
                  {isMod && (
                    <span className="text-[9px] bg-amber-200 text-amber-800 px-1 rounded font-normal" title={`原溯源值: ${inheritedValues[key]}`}>
                      改
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-slate-400">标准: {el.standard}</div>
                <IndicatorActualField
                  row={el}
                  readOnly={readOnly}
                  onValueChange={(value) => handleChemChange(idx, el.title, value)}
                  className={`w-full bg-white border rounded px-1.5 py-0.5 text-center font-mono font-medium text-xs focus:outline-none ${
                    isMod
                      ? "border-amber-400 text-amber-900 font-bold"
                      : decision === "FAILED"
                      ? "border-rose-400 text-rose-600"
                      : "border-slate-300 focus:border-blue-500"
                  }`}
                />
                {decision === "PASSED" && (
                  <div className="text-[10px] text-emerald-600 font-medium">✓ 符合要求</div>
                )}
                {decision === "FAILED" && (
                  <div className="text-[10px] text-rose-600 font-semibold">× 不符合要求</div>
                )}
                {decision === "PENDING" && (
                  <div className="text-[10px] text-slate-400 font-medium">— 待判定</div>
                )}
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
            {mechProperties.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-[11px] text-slate-400">
                  {planSectionEmptyText(planMatch.status, '力学与物理性能')}
                </td>
              </tr>
            )}
            {mechProperties.map((item, idx) => {
              const key = `mech_${item.title}`;
              const isMod = modifiedItems.has(key);
              const decision = judgeIndicatorRow(item);
              return (
                <tr key={`${item.itemCode}-${idx}`} className={`hover:bg-slate-50/50 ${isMod ? "bg-amber-50/20" : ""}`}>
                  <td className="py-2.5 px-4 font-medium text-slate-800">
                    <div className="flex items-center gap-1.5">
                      <span>{item.title}</span>
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
                    <IndicatorActualField
                      row={item}
                      readOnly={readOnly}
                      onValueChange={(value) => handleMechChange(idx, item.title, value)}
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
            <FileSpreadsheet className="w-3.5 h-3.5" /> 打印质检报告 (多模板)
          </button>
          <button
            type="button"
            onClick={handleOpenCert}
            className="px-4 py-1.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-medium hover:bg-emerald-100 flex items-center gap-1.5"
          >
            <Printer className="w-3.5 h-3.5" /> 预览与打印质保书
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
