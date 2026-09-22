import type {
  QualityCertificateData,
  ManufacturingCertData,
  CertificateCompanyProfile,
  ChemicalElementValue,
  MechanicalPropertyItem,
  DimensionItem,
} from './inspectionTypes';
import { judgeIndicatorRow, type PlanIndicatorRow } from './planMatch';

/**
 * 证书组装口径（docs/34 §5.1、docs/33 §2.4）：**只映射真实值**。
 *
 * 历史实现用 getHash/getVariation 按种子「生成」化学成分、力学性能与尺寸实测值 —— 那是最危险
 * 的一类编造：生成的数字看起来像真实检验结果，会被打印进对外质量证书。该假值发生器已整体删除，
 * 改为只读工单 `items` 里真实录入的实测项；没有真实数据就空数组，模板对应分区不渲染。
 */

/**
 * 证书组装输入行：来源有检验单 / 委外单 / 台账列表行三族，字段集不固定。
 *
 * 历史实现一律用 `any` 表述（本轮按审计口径收敛为索引签名 + 读取侧显式收窄）：
 * 这里只承诺「按字段名读」，字段取值仍需调用方判定类型后再用，避免把「未知」当成「任意可运算」。
 */
type CertSourceRow = Record<string, unknown>;

/** 取第一个非空值并转成字符串；全为空即返回空串（证书字段一律不编造默认值） */
function firstCertText(...values: unknown[]): string {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text !== '' && text !== '-') return text;
  }
  return '';
}

/** 工单实测项是否真的录入了实测值（只有标准、没有实测值的行不是检验结果，不能打印） */
function hasMeasuredValue(item: CertSourceRow): boolean {
  const numeric = item.measuredVal;
  if (numeric !== undefined && numeric !== null && numeric !== '') return true;
  const text = item.measuredText;
  if (text !== undefined && text !== null && String(text).trim() !== '') return true;
  // 兼容「已映射的展示行」（name / standard / measured）
  const mapped = item.measured;
  return mapped !== undefined && mapped !== null && String(mapped).trim() !== '';
}

/** 从工单实测项里挑出某类指标（按 metricCategory 或 itemCode 前缀），且必须已录入实测值 */
function pickMeasuredItems(
  items: unknown,
  categories: readonly string[],
  codePrefixes: readonly string[]
): CertSourceRow[] {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => {
    if (item === null || typeof item !== 'object') return false;
    const row = item as CertSourceRow;
    const category = String(row.metricCategory ?? '');
    const code = String(row.itemCode ?? '');
    const matched =
      categories.includes(category) || codePrefixes.some((prefix) => code.indexOf(prefix) === 0);
    return matched && hasMeasuredValue(row);
  });
}

/** 标准要求文案：方案 standardText 优先，其次由 nominalValue ± 公差回拼；都没有即空 */
function standardTextOf(item: CertSourceRow): string {
  const text = firstCertText(item.standardText, item.standard);
  if (text !== '') return text;
  // 取出后再收窄：`CertSourceRow` 的取值是 unknown，先用局部变量判定，后续拼接才是 number 运算
  const nominal = item.nominalValue;
  if (typeof nominal !== 'number') return '';
  const unit = firstCertText(item.unit);
  const suffix = unit === '' ? '' : ' ' + unit;
  const upper = Number(item.upperTolerance ?? 0);
  const lower = Number(item.lowerTolerance ?? 0);
  if (upper === 0 && lower === 0) return String(nominal) + suffix;
  if (upper === lower) return nominal + ' ± ' + upper + suffix;
  return nominal + ' (+' + upper + ' / -' + lower + ')' + suffix;
}

/** 实测值文案：数值优先（带单位），其次实测文本；都没有即空 */
function actualTextOf(item: CertSourceRow): string {
  const unit = firstCertText(item.unit);
  const suffix = unit === '' ? '' : ' ' + unit;
  if (typeof item.measuredVal === 'number') return String(item.measuredVal) + suffix;
  const text = firstCertText(item.measuredText);
  if (text !== '') return unit !== '' && text.indexOf(unit) < 0 ? text + suffix : text;
  return firstCertText(item.measured);
}

/** 单项判定 -> 中文字样：未录入 / 未判定（PENDING）一律留空，绝不冒充合格 */
function decisionToCn(result: unknown): string {
  const value = String(result ?? '').toUpperCase();
  if (value === 'FAILED' || value === 'FAIL' || value === 'NG') return '不合格';
  if (value === 'PASSED' || value === 'PASS' || value === 'OK') return '合格';
  return '';
}

/** 整单判定 -> 证书结论文案：特采单独成词；未判定不打印结论 */
function overallDecisionText(record: any): string {
  if (record.judgment === 'CONCESSION') return '特采放行';
  const cn = decisionToCn(record.judgment);
  if (cn !== '') return cn;
  return firstCertText(record.overallDecision);
}

/**
 * 企业档案主数据归一化：只保留有值的字段，全空即返回 undefined（模板按空白渲染）。
 * 主数据行本身缺失（null）与「字段没填」在证书上表现一致 —— 都是留白，不回落硬编码抬头。
 */
function normalizeCompanyProfile(raw: unknown): CertificateCompanyProfile | undefined {
  if (raw === null || raw === undefined || typeof raw !== 'object') return undefined;
  const row = raw as Record<string, unknown>;
  const profile: CertificateCompanyProfile = {
    legalName: firstCertText(row.legalName),
    legalNameEn: firstCertText(row.legalNameEn),
    shortName: firstCertText(row.shortName),
    address: firstCertText(row.address),
    originPlace: firstCertText(row.originPlace),
    phone: firstCertText(row.phone),
    email: firstCertText(row.email),
    qualityStamp: firstCertText(row.qualityStamp),
  };
  return Object.values(profile).some((value) => value !== '') ? profile : undefined;
}

/**
 * 证书「供货单位/产地」：调用方给出真实来源（供应商 / 厂商快照）就用调用方的；
 * 否则用企业档案（法人名称 + 产地）拼；都没有即空串（不编造）。
 */
function certSupplierText(record: any, profile: CertificateCompanyProfile | undefined): string {
  const explicit = firstCertText(record.supplier, record.supplierName, record.manufacturer);
  if (explicit !== '') return explicit;
  if (profile === undefined) return '';
  return [profile.legalName, profile.originPlace]
    .filter((text) => text !== undefined && text !== '')
    .join(' / ');
}

/** 证书分段展示名（与 planMatch 的 PLAN_SECTION_LABEL 同口径，避免 lib 层反向依赖表单层） */
const CERT_SECTION_LABEL = {
  CHEMICAL: '化学成分',
  MECHANICAL: '力学性能',
  DIMENSIONAL: '尺寸与外观',
} as const;

/**
 * 「本单方案含该分段指标、但一条实测值都没录入」的分段名（docs/35 §7）。
 *
 * 依据是本单方案快照的指标项（`record.items`）：某分段有指标项却没有任何已录实测值，
 * 证书就不渲染该分段 —— 这里把「为什么不渲染」显式说出来，避免被读成接口坏了。
 * 完全没有 items（没有方案快照来源）时按三段全缺处理，同样是留白 + 说明。
 */
function missingMeasuredSections(
  record: any,
  measured: { chemical: number; mechanical: number; dimension: number }
): string[] {
  const rows: any[] = Array.isArray(record.items) ? record.items : [];
  const expected = {
    CHEMICAL: rows.length === 0,
    MECHANICAL: rows.length === 0,
    DIMENSIONAL: rows.length === 0,
  };
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const category = String((row as any).metricCategory ?? '');
    const code = String((row as any).itemCode ?? '');
    if (category === 'CHEMICAL_COMPOSITION' || code.indexOf('CHEM_') === 0) {
      expected.CHEMICAL = true;
    } else if (
      category === 'MECHANICAL_PERFORMANCE' ||
      category === 'TENSILE_STRENGTH' ||
      category === 'HARDNESS' ||
      code.indexOf('MECH_') === 0 ||
      code.indexOf('HARDNESS_') === 0
    ) {
      expected.MECHANICAL = true;
    } else if (
      category === 'DIMENSION' ||
      code.indexOf('DIM_') === 0 ||
      code.indexOf('GEO_') === 0
    ) {
      expected.DIMENSIONAL = true;
    }
  }
  const missing: string[] = [];
  if (expected.CHEMICAL && measured.chemical === 0) missing.push(CERT_SECTION_LABEL.CHEMICAL);
  if (expected.MECHANICAL && measured.mechanical === 0) missing.push(CERT_SECTION_LABEL.MECHANICAL);
  if (expected.DIMENSIONAL && measured.dimension === 0) missing.push(CERT_SECTION_LABEL.DIMENSIONAL);
  return missing;
}

/**
 * 录入表单「方案指标行」-> 证书服务输入项（唯一键名口径，docs/35 §9 M8）。
 *
 * 历史缺陷：IQC / OQC 两个表单各自手搓证书对象，用的是 `date` / `spec` / `materialGrade` /
 * `lotNo` / `deliveryStatus` / `dimensionalInspection`，而模板读 `issueDate` / `specification` /
 * `steelGrade` / `batchNo` / `dimensions` —— 键对不上，抬头恒空白。现在两个表单只把指标行交给
 * 本函数，键名在服务这一处定义；未填实测值的行直接丢弃（没有实测值就不是检验结果）。
 */
export function certificateItemsFromRows(rows: readonly PlanIndicatorRow[]): any[] {
  return rows
    .filter((row) => String(row.actual ?? '').trim() !== '')
    .map((row) => {
      const decision = judgeIndicatorRow(row);
      return {
        itemCode: row.itemCode,
        name: row.title,
        metricCategory: row.planItem?.metricCategory ?? '',
        standardText: row.standard,
        unit: row.unit,
        measuredText: row.actual,
        ...(decision === 'PASSED' ? { result: 'PASSED' } : {}),
        ...(decision === 'FAILED' ? { result: 'FAILED' } : {}),
      };
    });
}
/** 证书签发日期：有真实日期即用；没有则取「今天」（生成本证书的动作真实发生在今天） */
function certIssueDate(record: any): string {
  const text = firstCertText(record.issueDate, record.inspectDate, record.date).slice(0, 10);
  return text === '' ? new Date().toISOString().slice(0, 10) : text;
}

export function detectSteelGrade(name = '', spec = ''): string {
  const s = (name + ' ' + spec).toUpperCase();
  if (s.indexOf('42CRMO') >= 0 || s.indexOf('10.9') >= 0 || s.indexOf('B7') >= 0) return '42CrMo';
  if (s.indexOf('35CRMO') >= 0 || s.indexOf('002M') >= 0) return '35CrMo';
  if (s.indexOf('304') >= 0 || s.indexOf('A2') >= 0) return '304SS';
  if (s.indexOf('10B21') >= 0) return '10B21';
  if (s.indexOf('35K') >= 0 || s.indexOf('6170') >= 0) return '35K';
  if (s.indexOf('65MN') >= 0 || s.indexOf('862') >= 0) return '65Mn';
  return '';
}

export function getChemicalComposition(items?: unknown): { elements: ChemicalElementValue[] } {
  const chem = pickMeasuredItems(items, ['CHEMICAL_COMPOSITION'], ['CHEM_']);
  return {
    elements: chem.map((item) => ({
      element: String(item.name ?? '')
        .replace(/含量.*|\(.*\)/g, '')
        .trim(),
      standard: standardTextOf(item),
      actual: actualTextOf(item),
    })),
  };
}

export function getMechanicalProperties(items?: unknown): { items: MechanicalPropertyItem[] } {
  const mechanical = pickMeasuredItems(
    items,
    ['MECHANICAL_PERFORMANCE', 'TENSILE_STRENGTH', 'HARDNESS'],
    ['MECH_', 'HARDNESS_']
  );
  return {
    items: mechanical.map((item) => ({
      name: String(item.name ?? ''),
      standard: standardTextOf(item),
      actual: actualTextOf(item),
      result: decisionToCn(item.result),
    })),
  };
}

export function getDimensions(items?: unknown): DimensionItem[] {
  const dimensions = pickMeasuredItems(items, ['DIMENSION'], ['DIM_', 'GEO_']);
  return dimensions.map((item) => ({
    name: String(item.name ?? ''),
    standard: standardTextOf(item),
    actual: actualTextOf(item),
    result: decisionToCn(item.result) as DimensionItem['result'],
  }));
}

export function buildIqcCertificateData(record: any): QualityCertificateData {
  const docNo = firstCertText(record.orderNo, record.docNo);
  const companyProfile = normalizeCompanyProfile(record.companyProfile);
  const chemicalComposition = getChemicalComposition(record.items);
  const mechanicalProperties = getMechanicalProperties(record.items);
  const dimensions = getDimensions(record.items);
  return {
    // 证书编号：有真实检验单号即 `QC-{单号}`；没有单号就留空（不再从数字里抠一段冒充编号）
    certNo: docNo === '' ? '' : 'QC-' + docNo,
    issueDate: certIssueDate(record),
    inspectionType: 'IQC',
    inspectionTypeLabel: '原材料/来料质量合格保证书 (3.1)',
    customer: firstCertText(record.customer, record.customerName),
    customerAddress: firstCertText(record.customerAddress, record.address),
    projectNo: firstCertText(record.projectNo, record.projectId),
    shortProjectNo: firstCertText(record.shortProjectNo),
    manufactureDate: firstCertText(record.manufactureDate, record.inspectionDate, record.date),
    // IQC 的「供货单位」是**供应商主数据**（真实来源与 OQC 出厂场景不同，不混用企业档案，docs/35 §6）
    supplier: firstCertText(record.supplier, record.supplierName),
    contractNo: firstCertText(record.contractNo),
    productName: firstCertText(record.material, record.materialName, record.productName),
    specification: firstCertText(record.spec, record.specModel, record.specification),
    heatNo: firstCertText(record.furnaceNo, record.furnaceHeatNo, record.heatNo),
    batchNo: firstCertText(record.batchNo),
    quantity: firstCertText(record.quantity),
    // 材质牌号：调用方显式给了就用，否则由物料名称 / 规格型号识别；识别不出即空（不回落 ML40Cr）
    steelGrade:
      firstCertText(record.steelGrade) ||
      detectSteelGrade(record.material ?? record.materialName, record.spec ?? record.specModel),
    surfaceFinish: firstCertText(record.surfaceFinish),
    standard: firstCertText(record.standard),
    performanceGrade: firstCertText(record.performanceGrade),
    chemicalComposition,
    mechanicalProperties,
    dimensions,
    overallDecision: overallDecisionText(record),
    inspector: firstCertText(record.inspector, record.inspectorName),
    // 复核 / 批准：系统内只有一道真实签核动作（质量负责人），故 reviewer 留白、approver 取签核人；
    // 未签核即空 —— 证书不打印一个没有发生过的签核（docs/35 §5）
    reviewer: firstCertText(record.reviewer),
    approver: firstCertText(record.approverName, record.approver),
    notes: firstCertText(record.inspectionNotes, record.notes),
    ...(companyProfile !== undefined ? { companyProfile } : {}),
    missingSections: missingMeasuredSections(record, {
      chemical: chemicalComposition.elements.length,
      mechanical: mechanicalProperties.items.length,
      dimension: dimensions.length,
    }),
  };
}

export function buildOqcCertificateData(record: any): QualityCertificateData {
  const docNo = firstCertText(record.orderNo, record.docNo);
  const companyProfile = normalizeCompanyProfile(record.companyProfile);
  const chemicalComposition = getChemicalComposition(record.items);
  const mechanicalProperties = getMechanicalProperties(record.items);
  const dimensions = getDimensions(record.items);
  return {
    certNo: docNo === '' ? '' : 'QC-' + docNo,
    issueDate: certIssueDate(record),
    inspectionType: 'OQC',
    inspectionTypeLabel: '产品出厂检验证明书 (EN 10204 3.1 质量保证书)',
    customer: firstCertText(record.customer, record.customerName, record.client),
    customerAddress: firstCertText(record.customerAddress, record.address),
    projectNo: firstCertText(record.projectNo, record.projectId),
    shortProjectNo: firstCertText(record.shortProjectNo),
    manufactureDate: firstCertText(record.manufactureDate, record.inspectionDate, record.date),
    // 出厂场景的「供货单位/产地」= 本企业（企业档案 legalName + originPlace，docs/35 §6）；
    // 调用方给出真实供应商快照时优先用调用方的（委外转出货等场景），两者都无即留空
    supplier: certSupplierText(record, companyProfile),
    contractNo: firstCertText(record.contractNo),
    productName: firstCertText(record.productName, record.name, record.materialName),
    specification: firstCertText(record.specification, record.spec, record.specModel),
    heatNo: firstCertText(record.heatNo, record.furnaceHeatNo, record.furnaceNo),
    batchNo: firstCertText(record.batchNo),
    quantity: firstCertText(record.quantity),
    steelGrade:
      firstCertText(record.steelGrade) ||
      detectSteelGrade(
        record.productName ?? record.name ?? record.materialName,
        record.specification ?? record.spec ?? record.specModel
      ),
    surfaceFinish: firstCertText(record.surfaceFinish),
    standard: firstCertText(record.standard),
    performanceGrade: firstCertText(record.performanceGrade),
    chemicalComposition,
    mechanicalProperties,
    dimensions,
    overallDecision: overallDecisionText(record),
    inspector: firstCertText(record.inspector, record.inspectorName),
    reviewer: firstCertText(record.reviewer),
    approver: firstCertText(record.approverName, record.approver),
    notes: firstCertText(record.inspectionNotes, record.notes),
    ...(companyProfile !== undefined ? { companyProfile } : {}),
    missingSections: missingMeasuredSections(record, {
      chemical: chemicalComposition.elements.length,
      mechanical: mechanicalProperties.items.length,
      dimension: dimensions.length,
    }),
  };
}

/**
 * 制造证书（MANUFACTURING CERT）组装。
 *
 * 口径（docs/33-委外检验录入表单演示值清理与编码族收敛设计.md §2.4）：本函数**只做字段映射**，
 * 不提供任何编造默认值。历史实现给厂名 / 外协单号 / 数量 / 批号 / 适用标准 / 实测行 / 检验员 /
 * 签发人 / 备注预置了演示常量（「常州市常澄热处理有限公司」「WWJG-2024-1001」「12,000 PCS」
 * 以及 getVariation() 生成的假实测值），调用方少传一个键就会把演示值打印成真实检验结果。
 * 现在调用方没给真实值即留空，由模板渲染成空白单元格；实测分区没有数据源时整体不渲染。
 *
 * 键名必须与 `ManufacturingCertTemplate` 的读取口径一致：模板读 `certNo` / `dateOfIssue` /
 * `testResults`。历史实现写的 `issueDate` / `tests` 模板从不读取，导致签发日期恒空白、
 * 实测分区恒为空——属「构造方与模板字段名错位」，本轮一并纠正。
 *
 * 签发日期：有真实日期即用；没有则取「今天」（本证书的生成动作真实发生日，不是编造的历史日期）。
 */
export function buildManufacturingCertData(record: any): ManufacturingCertData {
  const docNo = firstCertText(record.docNo);
  const dateText = firstCertText(record.dateOfIssue, record.issueDate, record.date).slice(0, 10);
  const companyProfile = normalizeCompanyProfile(record.companyProfile);
  return {
    certNo: docNo === '' ? '' : `MC-${docNo}`,
    dateOfIssue: dateText === '' ? new Date().toISOString().slice(0, 10) : dateText,
    subcontractor: firstCertText(record.subcontractor, record.vendorName, record.vendor, record.supplier),
    subcontractNo: firstCertText(record.subcontractNo, record.outsourceNo, record.orderNo, record.dispatchNo),
    productDescription: firstCertText(record.productName, record.materialName),
    processName: firstCertText(record.process, record.processType, record.processRequirements),
    dimension: firstCertText(record.specification, record.spec, record.partSpec),
    standardsApplied: firstCertText(record.standard, record.standardsApplied, record.inspectionCriteria),
    batchNo: firstCertText(record.batchNo),
    heatNo: firstCertText(record.heatNo, record.furnaceHeatNo),
    quantityPcs: firstCertText(record.quantityPcs, record.quantity),
    // 实测分区：模板读 testResults，只由调用方按真实数据源透传；无来源即不传，分区整体不渲染
    testResults: record.testResults,
    visualInspection: firstCertText(record.visualInspection),
    // 外观行规范要求 / 实测结果：调用方给真实值才打印（docs/34 §5.2）
    visualStandard: firstCertText(record.visualStandard),
    visualActual: firstCertText(record.visualActual),
    // 印章结论：取真实整单判定，无来源不打印
    overallDecision: firstCertText(record.overallDecision, record.judgment),
    inspectorName: firstCertText(record.inspector, record.inspectorName),
    // 质量负责人 = **真实签核动作**的产物（`inspection_orders.approver_name`，docs/35 §5）；
    // 未签核即留空，绝不打印一个没有发生过的签核人名
    qaManagerName: firstCertText(record.approverName, record.qaManagerName),
    remarks: firstCertText(record.remarks),
    ...(companyProfile !== undefined ? { companyProfile } : {}),
  };
}

export function convertOqcToQualityCert(oqc: any): QualityCertificateData { return buildOqcCertificateData(oqc); }
export function convertOutsourceToManufacturingCert(outsource: any): ManufacturingCertData { return buildManufacturingCertData(outsource); }
export function convertIqcToQualityCert(iqc: any): QualityCertificateData { return buildIqcCertificateData(iqc); }
export function convertIpqcToQualityCert(ipqc: any): QualityCertificateData { return buildIqcCertificateData(ipqc); }

export function buildIpqcCertificateData(record: any): QualityCertificateData { return buildIqcCertificateData(record); }