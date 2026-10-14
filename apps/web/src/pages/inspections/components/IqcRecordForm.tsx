import React, { useEffect, useState } from 'react';
import { ArrowLeft, Printer, ShieldCheck, Atom, Gauge, Box } from 'lucide-react';
import { CertificatePrintModal } from '../../../components/certificate/CertificatePrintModal';
import { IndicatorActualField } from '../../../components/common/IndicatorActualField';
import { PlanMatchBanner } from '../../../components/common/PlanMatchBanner';
import { ApprovalButton } from '../../../components/common/ApprovalButton';
import {
  CertTemplateKind,
  ManufacturingCertData,
  QualityCertificateData,
} from '../../../lib/inspectionTypes';
import {
  buildIqcCertificateData,
  buildManufacturingCertData,
  certificateItemsFromRows,
} from '../../../lib/certificateDataService';
import { CertFieldsCard } from '../../../components/certificate/CertFieldsCard';
import { loadCompanyProfile } from '../../../lib/companyProfile';
import { api, errorMessage } from '../../../lib/api';
import { iqcHeatNoRequirementMarker, validateIqcHeatNo } from '../../../lib/iqcHeatNoRequirement';
import { useMatchedPlan } from '../../../hooks/useMatchedPlan';
import {
  DECISION_LABEL,
  judgeIndicatorRow,
  planSectionEmptyText,
  parseMeasuredNumber,
  splitIndicatorRows,
  summarizeJudgements,
  type PlanIndicatorRow,
} from '../../../lib/planMatch';
import type { InspectionItemDecision } from '@letian/contracts';

/** 单项判定徽标：与 OQC 表单同款，只有 PASSED 才显示合格 */
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

interface IqcRecordFormProps {
  initialItem?: any;
  onBack: () => void;
  onSubmit: (result: any) => void;
  readOnly?: boolean;
}


/**
 * 列表行回填到可编辑输入框时的归一化：
 * 列表用 `-` 表示「无值」这一展示占位，不能把它当成真实数据带进表单，
 * 否则录入人会把占位符当成已填内容，甚至原样提交/打印。
 */
function fromList(value?: string | null): string {
  return value !== undefined && value !== null && value !== '-' ? value : '';
}

/** 检验日期默认取「今天」：录入动作真实发生日，不是编造的演示日期 */
function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}
/** 数量文本（形如「5000 件」）-> 数值；解析不出即 null（不猜数量，终判的合格/不合格数下限为 0） */
function parseQuantity(text: string): number | null {
  const matched = String(text).replace(/,/g, '').match(/\d+(\.\d+)?/);
  if (matched === null) return null;
  const value = Number(matched[0]);
  return Number.isFinite(value) ? value : null;
}

export const IqcRecordForm: React.FC<IqcRecordFormProps> = ({ initialItem, onBack, onSubmit, readOnly = false }) => {
  // 单据与供货原材料基本属性 (对应质量保证证书基本项)
  //
  // 口径：一律只由**真实数据源**填充 —— 列表行 (initialItem) 或本单 / 方案解析结果
  // (planMatch.order，见下方「按工单真实值回填」的 useEffect)；两者都没有时保持空串由录入人填写。
  // 历史实现给每个字段预置了演示值（如供应商「鞍钢集团钢铁新材料有限公司」、检验单号
  // 「IQC-20260706-0002」），会让界面看起来"已经有真实数据"，新建录入时甚至会被当成本单真实值
  // 提交与打印 —— 与「不用演示值冒充真实台账」的口径冲突，故一律移除。
  const [docNo, setDocNo] = useState(fromList(initialItem?.docNo));
  const [materialName, setMaterialName] = useState(fromList(initialItem?.materialName));
  const [materialGrade, setMaterialGrade] = useState(fromList(initialItem?.steelGrade));
  const [spec, setSpec] = useState(fromList(initialItem?.spec));
  const [supplier, setSupplier] = useState(fromList(initialItem?.supplier));
  const [heatNo, setHeatNo] = useState(fromList(initialItem?.furnaceNo));
  const [batchNo, setBatchNo] = useState(fromList(initialItem?.batchNo));
  const [quantity, setQuantity] = useState(
    initialItem?.qty !== undefined && initialItem?.qty !== null && initialItem?.qty !== ''
      ? `${initialItem.qty}${initialItem.unit ? ` ${initialItem.unit}` : ''}`
      : ''
  );
  const [standard, setStandard] = useState('');

  // 当前录入单的物料编码：来自检验单列表行，缺失时页面明确提示无法自动匹配（绝不猜物料）
  const materialCode: string = initialItem?.materialCode ?? initialItem?.productCode ?? '';

  // 判定依据的唯一来源（口径：docs/17-检验录入界面说明与质检方案匹配口径.md §7）
  //   新建 / 继续录入 → 按「物料 + 检验类型」匹配**当前生效方案**；
  //   只读回看        → 读**本单方案快照**（§7.3「快照即证据」），不按当前方案重算历史判定
  const planMatch = useMatchedPlan(materialCode, 'IQC', {
    orderId: initialItem?.id ?? null,
    readOnly,
  });

  // 1. 化学成分实测与材料标准范围 (光谱分析)
  const [chemElements, setChemElements] = useState<PlanIndicatorRow[]>([]);

  // 2. 原材料机械力学试验与硬度
  const [mechProperties, setMechProperties] = useState<PlanIndicatorRow[]>([]);

  // 3. 外观与几何公差
  const [dimItems, setDimItems] = useState<PlanIndicatorRow[]>([]);

  // 指标行就绪即重建三个分区；未命中 / 加载失败时清空，绝不用演示指标行顶替真实方案或本单快照
  useEffect(() => {
    const grouped = splitIndicatorRows(planMatch.rows);
    setChemElements(grouped.CHEMICAL);
    setMechProperties(grouped.MECHANICAL);
    setDimItems(grouped.DIMENSIONAL);
  }, [planMatch.rows]);

  // 本单全部指标行的实时判标结果与汇总（合格率分母已剔除免检项）
  const judgement = summarizeJudgements(
    [...chemElements, ...mechProperties, ...dimItems].map(judgeIndicatorRow)
  );

  /**
   * 方案版本 ID：新建/录入模式下提交建单时原样回传，服务端据此固化 planSnapshot 快照；
   * 只读回看模式下是本单已绑定的版本，仅用于展示，不再回传建单。
   */
  const planVersionId = planMatch.planVersionId;

  // 只读回看：表头与人员信息按工单真实值回填，不用演示默认值冒充历史单据
  useEffect(() => {
    const order = planMatch.order;
    if (order === null) return;
    setDocNo(order.orderNo);
    setMaterialName(order.materialName);
    const specText = order.specification ?? order.spec;
    if (specText !== undefined && specText !== '') setSpec(specText);
    if (order.supplierName !== undefined && order.supplierName !== '') setSupplier(order.supplierName);
    if (order.furnaceHeatNo !== undefined && order.furnaceHeatNo !== '') setHeatNo(order.furnaceHeatNo);
    setBatchNo(order.batchNo);
    setQuantity(`${order.sampleQty}${order.unit !== undefined ? ` ${order.unit}` : ''}`);
    if (order.inspectorName !== undefined && order.inspectorName !== '') setInspector(order.inspectorName);
    const stamp = order.completedAt ?? order.createdAt;
    if (stamp !== undefined) setInspectDate(stamp.slice(0, 10));
    if (order.inspectionNotes !== undefined) setRemark(order.inspectionNotes);
    // 签核人 / 签核时间：只认本单真实落库值（未签核即空）
    setApprover({
      name: order.approverName !== undefined && order.approverName !== null ? String(order.approverName) : '',
      at: order.approvedAt !== undefined && order.approvedAt !== null ? String(order.approvedAt) : '',
    });
    setDecision(
      order.overallDecision === 'FAILED' ? '退货' : order.overallDecision === 'CONCESSION' ? '让步接收' : '合格'
    );
    // 证书模板与字段袋随单落库（docs/51）：只读回看按本单真实存储值回填；
    // 历史单列为空时不覆盖默认回落
    if (order.certTemplate !== undefined && order.certTemplate !== null) {
      setCertTemplate(order.certTemplate);
    }
    if (order.certFields !== undefined && order.certFields !== null) {
      const bag: Record<string, string> = {};
      for (const [key, value] of Object.entries(order.certFields)) {
        if (typeof value === 'string' && value !== '') bag[key] = value;
      }
      setCertFields(bag);
    }
  }, [planMatch.order]);

  // 判定与人员
  const [decision, setDecision] = useState<'合格' | '让步接收' | '退货'>('合格');
  const [inspector, setInspector] = useState(fromList(initialItem?.inspectorName));
  // 检验日期默认「今天」：录入动作真实发生日；历史默认值是编造的固定日期
  const [inspectDate, setInspectDate] = useState(todayIsoDate());
  // 备注不预置演示结论文案（原默认值是一段"判定合格、准予入库"的文字，
  // 会让尚未检验的空白单据看起来已经判过）
  const [remark, setRemark] = useState('');

  // 打印预览控制
  const [printModalOpen, setPrintModalOpen] = useState(false);
  const [certData, setCertData] = useState<QualityCertificateData | null>(null);
  const [mfgCertData, setMfgCertData] = useState<ManufacturingCertData | null>(null);

  // 证书模板（docs/51）：建单时由操作员选定并随单落库；历史单没有该列时按来料场景回落质保书
  const [certTemplate, setCertTemplate] = useState<CertTemplateKind>(
    initialItem?.certTemplate === 'MANUFACTURING' ? 'MANUFACTURING' : 'QUALITY'
  );
  // 证书专用字段袋（cert_fields）：扫描件版面上有、检验单表头没有物理列的格，
  // 一律随单落库；未填的格在证书上留白
  const [certFields, setCertFields] = useState<Record<string, string>>(() => {
    const raw = initialItem?.certFields;
    if (raw === null || raw === undefined || typeof raw !== 'object') return {};
    const bag: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string' && value !== '') bag[key] = value;
    }
    return bag;
  });

  // 写入路径状态（docs/35 §4 M3）：提交中 / 失败文案 / 成功回执，均为真实请求结果
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitReceipt, setSubmitReceipt] = useState('');
  /** 已成功落库的检验单（点「完成并返回列表」时回调 onSubmit 退出表单） */
  const [submitted, setSubmitted] = useState<{ orderId: string; orderNo: string } | null>(null);

  // 质量负责人签核（docs/35 §5）：取本单真实落库的签核人 / 签核时间，无来源即空（证书留白）
  const [approver, setApprover] = useState<{ name: string; at: string }>({
    name: initialItem?.approverName !== undefined && initialItem?.approverName !== null ? String(initialItem.approverName) : '',
    at: initialItem?.approvedAt !== undefined && initialItem?.approvedAt !== null ? String(initialItem.approvedAt) : '',
  });

  /** 本单全部指标行（与页面顺序一致）：证书组装与提交写路径共用同一份来源 */
  const planRowsForSubmit = [...chemElements, ...mechProperties, ...dimItems];

  /**
   * 组装质量保证证书（docs/35 §9 M8）：
   * 一律经 `certificateDataService.buildIqcCertificateData` 组装 —— 键名口径（issueDate /
   * specification / steelGrade / batchNo / dimensions…）只在服务里定义一次，表单不再手搓对象
   * （历史实现手搓 `date / spec / materialGrade / lotNo / dimensionalInspection`，模板读不到，
   * 证书抬头恒空白）。实测分区由**本单方案指标行**转换而来，未填实测值的行不下发 -> 该分段不打印。
   * 企业档案（抬头 / 印章）取主数据，未维护即留白（不回落模板里的硬编码抬头常量）。
   * 签发日期不取入库日期：不传即由服务取「今天」（生成本证书的动作真实发生在今天，docs/34 §5.1）。
   */
  const handleOpenCert = () => {
    void (async () => {
      const companyProfile = await loadCompanyProfile();
      // 出证模板按本单落库的 certTemplate 走（docs/51）：
      // 两种扫描件的字段集互不重叠 —— 同一表单态，按模板分别交给对应 builder 组装
      if (certTemplate === 'MANUFACTURING') {
        const cert = buildManufacturingCertData({
          orderNo: docNo,
          materialName,
          partSpec: spec,
          dimension: spec,
          steelGrade: materialGrade,
          materialGrade,
          quantity,
          // IQC 场景的「供货厂商」落到制造证书的客户/供应商格，由字段袋区分表头显示名
          subcontractor: supplier,
          vendorName: supplier,
          heatNo,
          batchNo,
          standardsApplied: standard,
          standard,
          inspectorName: inspector,
          remarks: remark,
          certFields,
          items: certificateItemsFromRows(planRowsForSubmit),
          ...(companyProfile !== null ? { companyProfile } : {}),
        });
        setMfgCertData(cert);
      } else {
        const cert = buildIqcCertificateData({
          orderNo: docNo,
          materialName,
          spec,
          steelGrade: materialGrade,
          quantity,
          // IQC 的「供货单位」取供应商主数据（真实来源与 OQC 出厂场景不同，不混用企业档案）
          supplier,
          furnaceNo: heatNo,
          batchNo,
          standard,
          inspector,
          // 质量负责人：有真实签核动作才有值；未签核即空（证书批准人栏留白，docs/35 §5）
          ...(approver.name !== '' ? { approverName: approver.name } : {}),
          // 综合判定：只有检验员真的选了判定才打印结论（合格 -> PASSED、退货 -> FAILED、让步接收 -> CONCESSION）
          // 让步接收不打印结论（尚未经 MRB 会签，证书不能替客户下特采结论）
          ...(decision === '合格' ? { judgment: 'PASSED' } : decision === '退货' ? { judgment: 'FAILED' } : {}),
          inspectionNotes: remark,
          certFields,
          items: certificateItemsFromRows(planRowsForSubmit),
          ...(companyProfile !== null ? { companyProfile } : {}),
        });
        setCertData(cert);
      }
      setPrintModalOpen(true);
    })();
  };

  /**
   * 提交来料检验（docs/35 §4 M3 写路径，口径与委外表单一致，避免第二套）：
   *   ① POST /inspections/{id}/submit-measurements —— 只下发**本单方案快照内、且已填写**的指标项；
   *      存在空项时按草稿落库（isDraft:true）—— 用「未录入」触发领域终判会把整单判成不合格
   *      并汇入不合格待审池，那不是检验员的真实结论；
   *   ② POST /inspections/{id}/status —— 终判：合格 -> PASSED、不合格退货 / 让步接收 -> FAILED，
   *      并带 passQty / failQty / judgment / remark / preliminaryDisposition；
   *      判定不合格时服务端自动创建 MRB 评审单（docs/43），前端无需再调发起接口；
   * 回执：绿字显示服务端返回的检验单号；失败按 ApiError 文案红字就地提示（不再 alert 假成功）。
   */
  const handleSubmitInternal = async () => {
    if (submitting) return;
    const orderId = typeof initialItem?.id === 'string' ? initialItem.id : '';
    if (orderId === '') {
      setSubmitError('本单尚未落库（列表行未带检验单 ID），无法提交实测值与判定');
      return;
    }
    if (inspector.trim() === '') {
      setSubmitError('请先填写检验员（检验单落库的检验人）');
      return;
    }
    // docs/52 §4 方案 B（客户已定稿）：IQC 炉号唯一真实来源是供应商质保书(MTC)，
    // ERP 无炉号字段无法带出，故录入表单必填——判定一律经 iqcHeatNoRequirement 单点，
    // 与出货检 oqcHeatNoRequirement 同款；客户若改口径只动那个模块。
    const heatNoError = validateIqcHeatNo(heatNo);
    if (heatNoError !== null) {
      setSubmitError(heatNoError);
      return;
    }
    if (planRowsForSubmit.length === 0) {
      setSubmitError('本单未匹配到质检方案指标行，无法提交（请先确认该物料的已启用质检方案）');
      return;
    }

    // 不解检（EXEMPT）行随提交下发：服务端按 isExempt 判 EXEMPT 并剔除出合格率分母，
    // 此前整条被过滤导致免检标记静默丢失（v2.6.0 未结模块）
    const measuredRows = planRowsForSubmit.filter((row) => row.isExempt || row.actual.trim() !== '');
    const hasBlankRows = planRowsForSubmit.some((row) => !row.isExempt && row.actual.trim() === '');
    const qty = parseQuantity(quantity);

    setSubmitting(true);
    setSubmitError('');
    setSubmitReceipt('');
    try {
      // 表头业务事实落库（docs/47 §4.6 / §5）：原厂冶炼炉号是炉批号关联链路的 L2 数据源 ——
      // 此前该字段只进证书与回调，不落库，出货检验的「回退关联来料检验」永远查空（D1）。
      // 溯源留痕由服务端重新解析：本单若有同炉上游记录（另一张 IQC / 委外热处理），会一并写入。
      await api.patch(`/inspections/${encodeURIComponent(orderId)}/header`, {
        furnaceHeatNo: heatNo.trim(),
        // 证书模板选择与字段袋随头落库（docs/51）：历史单首次提交即回填当时选定的模板，
        // 字段袋整包覆盖（空值即清空，与证书「未填留白」同口径）
        certTemplate,
        certFields,
        ...(materialGrade.trim() !== '' ? { materialGrade: materialGrade.trim() } : {}),
        ...(standard.trim() !== '' ? { techStandard: standard.trim() } : {}),
        ...(inspectDate.trim() !== '' ? { inspectedDate: inspectDate.trim() } : {}),
      });

      if (measuredRows.length > 0) {
        await api.post(`/inspections/${encodeURIComponent(orderId)}/submit-measurements`, {
          isDraft: hasBlankRows,
          // 填写值只在**正式判定**时下发：草稿只暂存实测值、不做判定，也就没有数量口径（docs/21 §14）
          ...(hasBlankRows
            ? {}
            : {
                passQty: decision === '合格' && qty !== null ? qty : 0,
                failQty: decision === '合格' ? 0 : qty !== null ? qty : 0,
              }),
          items: measuredRows.map((row) => {
            if (row.isExempt) {
              return { itemCode: row.itemCode, isExempt: true };
            }
            const numeric = parseMeasuredNumber(row.actual);
            return {
              itemCode: row.itemCode,
              isExempt: false,
              ...(numeric !== undefined && row.planItem.dataType === 'NUMERIC'
                ? { measuredVal: numeric }
                : {}),
              measuredText: row.actual,
            };
          }),
        });
      }

      // 判定映射：合格 -> PASSED(+judgment PASSED)；不合格退货 -> FAILED(+judgment FAILED)；
      // 「让步接收」-> FAILED 且不落 judgment。理由是让步接收 / 特采属 MRB 会签结论
      // （领域侧 CONCESSION 必带客户签核凭证，见 MRBStateMachine.validateDispositionRules），
      // 检验员在录入表单里无权直接把单据判成特采放行；判定不合格后服务端会**自动创建 MRB
      // 评审单**（docs/43，无人工发起环节），由 MRB 会签决定特采 / 返工 / 退货 / 报废，
      // 这里只把检验员的处置意图（拟定处置）与申请写进备注留痕。
      const targetStatus = decision === '合格' ? 'PASSED' : 'FAILED';
      const note =
        decision === '让步接收'
          ? [remark.trim(), '检验员申请让步接收，转 MRB 评审'].filter((part) => part !== '').join('；')
          : remark.trim();
      // 拟定处置（docs/43 §4.4）：退货 -> RETURN_TO_VENDOR、让步接收 -> CONCESSION，
      // 作为自动创建的 MRB 单「处置方式」列初值（终审时由处置决策覆盖；合格不下发）。
      const preliminaryDisposition =
        decision === '退货' ? 'RETURN_TO_VENDOR' : decision === '让步接收' ? 'CONCESSION' : undefined;
      const finished = await api.post<{ orderNo?: string }>(
        `/inspections/${encodeURIComponent(orderId)}/status`,
        {
          status: targetStatus,
          passQty: decision === '合格' && qty !== null ? qty : 0,
          failQty: decision === '合格' ? 0 : qty !== null ? qty : 0,
          ...(decision === '让步接收' ? {} : { judgment: targetStatus }),
          ...(note !== '' ? { remark: note, inspectionNotes: note } : {}),
          ...(preliminaryDisposition !== undefined ? { preliminaryDisposition } : {}),
        }
      );

      const orderNo = finished.orderNo ?? docNo;
      setSubmitted({ orderId, orderNo });
      setSubmitReceipt(
        decision === '合格'
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
      decision,
      furnaceNo: heatNo,
      inspector,
      inspectDate,
      remark,
      planVersionId,
      planMatchSource: planMatch.matchSource,
      chemElements: chemElements.map((el) => ({
        itemCode: el.itemCode,
        name: el.name,
        standard: el.standard,
        actual: el.actual,
        unit: el.unit,
        result: DECISION_LABEL[judgeIndicatorRow(el)],
      })),
      mechProperties: mechProperties.map((mp) => ({
        itemCode: mp.itemCode,
        name: mp.title,
        standard: mp.standard,
        actual: mp.actual,
        unit: mp.unit,
        result: DECISION_LABEL[judgeIndicatorRow(mp)],
        isExempt: mp.isExempt,
      })),
      dimItems: dimItems.map((di) => ({
        itemCode: di.itemCode,
        name: di.title,
        standard: di.standard,
        actual: di.actual,
        unit: di.unit,
        result: DECISION_LABEL[judgeIndicatorRow(di)],
        isExempt: di.isExempt,
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
          <ApprovalButton
            orderId={typeof initialItem?.id === 'string' ? initialItem.id : ''}
            approverName={approver.name}
            approvedAt={approver.at}
            onApproved={(result) =>
              setApprover({ name: result.approverName ?? approver.name, at: result.approvedAt ?? approver.at })
            }
          />
        </div>
      </div>

      {/* 质检方案匹配状态：命中才渲染指标清单，未命中则引导配置方案 */}
      <PlanMatchBanner state={planMatch} materialCode={materialCode} inspectionType="IQC" />

      {/*
        只读回看（readOnly）把「指标清单 + 标准值 + 实测值 + 判定」整段置为不可编辑：
        fieldset[disabled] 一次性禁用内部全部表单控件，避免"能看历史单据、却能改历史结论"。
        模块五（判定与签核）与打印按钮不在其中，回看时依旧可打印质保书。
      */}
      <fieldset disabled={readOnly} className="border-0 p-0 m-0 min-w-0 space-y-4">
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
              placeholder="按本单供应商主数据填写"
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
              placeholder="按物料主数据填写"
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
            <label className="block text-slate-500 mb-1">原厂冶炼炉号 (Heat No) {iqcHeatNoRequirementMarker()}</label>
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
        <table className="w-full text-xs text-left">
          <thead className="bg-slate-50 text-slate-600 font-medium border-b border-slate-200">
            <tr>
              <th className="py-2.5 px-4 w-40">元素 (Element)</th>
              <th className="py-2.5 px-4 w-20">单位</th>
              <th className="py-2.5 px-4 w-56">标准技术规范 (可修改)</th>
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
              const decision = judgeIndicatorRow(el);
              return (
                <tr key={`${el.itemCode}-${idx}`} className="hover:bg-slate-50/50">
                  <td className="py-2.5 px-4 font-medium text-slate-800" title={`${el.name} (${el.itemCode})`}>
                    {el.title}
                  </td>
                  <td className="py-2.5 px-4 text-slate-500">{el.unit ?? '%'}</td>
                  <td className="py-2.5 px-4">
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
                      className="w-48 bg-white border border-slate-300 rounded px-2 py-1 font-mono text-xs text-slate-600 focus:border-blue-500 focus:outline-none"
                    />
                  </td>
                  <td className="py-2.5 px-4">
                    <IndicatorActualField
                      row={el}
                      readOnly={readOnly}
                      onValueChange={(value) => {
                        const updated = [...chemElements];
                        updated[idx].actual = value;
                        setChemElements(updated);
                      }}
                      className={`w-48 bg-white border rounded px-2 py-1 font-mono font-medium text-xs focus:border-blue-500 focus:outline-none ${
                        decision === 'FAILED' ? 'border-rose-400 text-rose-600' : 'border-slate-200'
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

      
      {/* 过程检验不解检 (EXEMPT) 实测合格率统计面板 */}
      <div className="bg-gradient-to-r from-slate-50 to-blue-50/50 border border-slate-200/80 rounded-lg p-3 flex flex-wrap items-center justify-between gap-3 text-xs shadow-sm">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-1.5">
            <span className="text-slate-500">检验项总数:</span>
            <span className="font-bold text-slate-800">{judgement.total} 项</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-slate-500">不解检/免检 (EXEMPT):</span>
            <span className="font-bold text-sky-700 bg-sky-50 px-2 py-0.5 rounded border border-sky-200">
              {judgement.exempt} 项 (已剔除出合格率分母★)
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-slate-500">有效参检项 (分母):</span>
            <span className="font-bold text-slate-900">{judgement.effective} 项</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-slate-500">待判定:</span>
            <span className="font-bold text-slate-500">{judgement.pending} 项</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-500">指标合格率:</span>
          {judgement.passRate === null ? (
            <span className="text-xs font-bold px-2.5 py-0.5 rounded bg-slate-100 text-slate-500 border border-slate-200">
              暂无有效参检项
            </span>
          ) : (
            <span
              className={`text-sm font-black px-2.5 py-0.5 rounded border ${
                judgement.failed > 0
                  ? 'bg-rose-100 text-rose-800 border-rose-300'
                  : 'bg-emerald-100 text-emerald-800 border-emerald-300'
              }`}
            >
              {(judgement.passRate * 100).toFixed(1)}%
            </span>
          )}
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
            {mechProperties.length === 0 && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-[11px] text-slate-400">
                  {planSectionEmptyText(planMatch.status, '力学与物理性能')}
                </td>
              </tr>
            )}
            {mechProperties.map((item, idx) => {
              const decision = judgeIndicatorRow(item);
              return (
              <tr key={`${item.itemCode}-${idx}`} className="hover:bg-slate-50/50">
                <td className="py-2.5 px-4 font-medium text-slate-800">{item.title}</td>
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
                  <IndicatorActualField
                    row={item}
                    readOnly={readOnly}
                    onValueChange={(value) => {
                      const updated = [...mechProperties];
                      updated[idx].actual = value;
                      setMechProperties(updated);
                    }}
                    className={`w-48 border rounded px-2 py-1 font-mono font-medium focus:outline-none ${
                      item.isExempt
                        ? "bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed italic"
                        : decision === "FAILED"
                        ? "border-rose-400 text-rose-600 bg-white"
                        : "border-slate-200 bg-white focus:border-blue-500"
                    }`}
                  />
                </td>
                <td className="py-2.5 px-3 text-center">
                  <label className="inline-flex items-center gap-1 cursor-pointer text-xs">
                    <input
                      type="checkbox"
                      checked={item.isExempt}
                      onChange={(e) => {
                        const updated = [...mechProperties];
                        updated[idx].isExempt = e.target.checked;
                        setMechProperties(updated);
                      }}
                      className="rounded text-blue-600 focus:ring-blue-500"
                    />
                    <span className={item.isExempt ? "text-sky-700 font-bold" : "text-slate-400"}>
                      不解检
                    </span>
                  </label>
                </td>
                <td className="py-2.5 px-4 text-center">
                  {item.isExempt ? (
                    <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-sky-50 text-sky-700 border border-sky-200">
                      免检 (EXEMPT)
                    </span>
                  ) : (
                    <span
                      className={`px-2 py-0.5 rounded font-medium ${
                        decision === "PASSED"
                          ? "bg-emerald-50 text-emerald-600"
                          : decision === "FAILED"
                          ? "bg-rose-50 text-rose-600"
                          : "bg-slate-100 text-slate-500"
                      }`}
                    >
                      {decision === "PASSED" ? "✓ 合格" : decision === "FAILED" ? "✗ 不合格" : "— 待判定"}
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
            {dimItems.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-[11px] text-slate-400">
                  {planSectionEmptyText(planMatch.status, '尺寸与外观')}
                </td>
              </tr>
            )}
            {dimItems.map((item, idx) => {
              const decision = judgeIndicatorRow(item);
              return (
              <tr key={`${item.itemCode}-${idx}`} className="hover:bg-slate-50/50">
                <td className="py-2.5 px-4 font-medium text-slate-800">{item.title}</td>
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
                  <IndicatorActualField
                    row={item}
                    readOnly={readOnly}
                    onValueChange={(value) => {
                      const updated = [...dimItems];
                      updated[idx].actual = value;
                      setDimItems(updated);
                    }}
                    className={`w-full border rounded px-2 py-1 focus:outline-none ${
                      item.isExempt
                        ? "bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed italic"
                        : decision === "FAILED"
                        ? "border-rose-400 text-rose-600 bg-white"
                        : "border-slate-200 bg-white focus:border-blue-500"
                    }`}
                  />
                </td>
                <td className="py-2.5 px-3 text-center">
                  <label className="inline-flex items-center gap-1 cursor-pointer text-xs">
                    <input
                      type="checkbox"
                      checked={item.isExempt}
                      onChange={(e) => {
                        const updated = [...dimItems];
                        updated[idx].isExempt = e.target.checked;
                        setDimItems(updated);
                      }}
                      className="rounded text-blue-600 focus:ring-blue-500"
                    />
                    <span className={item.isExempt ? "text-sky-700 font-bold" : "text-slate-400"}>
                      不解检
                    </span>
                  </label>
                </td>
                <td className="py-2.5 px-4 text-center">
                  {item.isExempt ? (
                    <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-sky-50 text-sky-700 border border-sky-200">
                      免检 (EXEMPT)
                    </span>
                  ) : (
                    <span
                      className={`px-2 py-0.5 rounded font-medium ${
                        decision === "PASSED"
                          ? "bg-emerald-50 text-emerald-600"
                          : decision === "FAILED"
                          ? "bg-rose-50 text-rose-600"
                          : "bg-slate-100 text-slate-500"
                      }`}
                    >
                      {decision === "PASSED" ? "✓ 合格" : decision === "FAILED" ? "✗ 不合格" : "— 待判定"}
                    </span>
                  )}
                </td>
              </tr>
              );
            })}
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
                  disabled={readOnly}
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
                  disabled={readOnly}
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
                  disabled={readOnly}
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
              readOnly={readOnly}
              value={inspector}
              onChange={(e) => setInspector(e.target.value)}
              className="w-full bg-white border border-slate-200 rounded px-2.5 py-1.5 text-slate-700"
            />
          </div>

          <div>
            <label className="block text-slate-600 mb-1">检验日期 (Inspect Date)</label>
            <input
              type="text"
              readOnly={readOnly}
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
              // 审核人由质检组长在审核环节填写，不在录入表单预置演示人名
              value=""
              placeholder="待质检组长审核"
              className="w-full bg-slate-50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-500"
            />
          </div>

          <div className="md:col-span-4">
            <label className="block text-slate-600 mb-1">判定备注与核验说明</label>
            <textarea
              rows={2}
              readOnly={readOnly}
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              className="w-full border border-slate-200 rounded p-2 text-xs text-slate-700 focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        {(submitReceipt !== '' || submitError !== '') && (
          <div
            className={`mb-2 text-xs ${
              submitError !== '' ? 'text-rose-600' : 'text-emerald-700'
            }`}
            data-testid="iqc-submit-receipt"
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
            取消
          </button>
          <button
            type="button"
            onClick={handleOpenCert}
            className="px-4 py-1.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-medium hover:bg-emerald-100 flex items-center gap-1.5"
          >
            <Printer className="w-3.5 h-3.5" />
            {certTemplate === 'MANUFACTURING' ? '预览与打印制造证书' : '预览与打印质保书'}
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
              {submitting ? '提交中…' : '保存并提交来料判定'}
            </button>
          )}
          {!readOnly && submitted !== null && (
            <button
              type="button"
              onClick={handleFinish}
              className="px-4 py-1.5 rounded bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 shadow-sm"
            >
              完成并返回列表
            </button>
          )}
        </div>
      </div>

      {/* 质保书导出与打印模态框 */}
      <CertificatePrintModal
        isOpen={printModalOpen}
        onClose={() => setPrintModalOpen(false)}
        type={certTemplate === 'MANUFACTURING' ? 'manufacturing' : 'quality'}
        qualityData={certData}
        manufacturingData={mfgCertData}
      />
    </div>
  );
};
