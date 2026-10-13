import ExcelJS from 'exceljs';
import { extractPdfTextItems } from './pdf-text';
import { groupPdfRows, pdfRowsToTable } from './pdf-table';
import {
  InspectionTypeEnum,
  PLAN_CHECK_CATEGORIES,
  findPlanPreset,
  parsePlanStandardValue,
  planPresetItemCode,
  type InspectionPlanItem,
  type InspectionType,
  type InventoryCategory,
  type Material,
  type PlanCategoryKey,
  type PlanPresetItem,
} from '@letian/contracts';
import { ValidationFailedError } from '@letian/application';

/**
 * 质检方案 Excel 导入：模板生成 + 解析/校验/分组（POST /api/v1/plans/import 的数据层）。
 *
 * 口径与「新建质检方案」弹窗（apps/web/src/pages/plans/CreatePlanModal.tsx）逐字对齐：
 *   - 检验项目不再从 ERP 检验项目字典（00001…）选，而是双方共用的**预置检验项目清单**
 *     （契约包 plan-presets.ts 的 PLAN_CHECK_CATEGORIES：外观 AP-* / 尺寸 DM-* / 性能 PF-*），
 *     弹窗是「勾选清单」，Excel 是「逐行填写清单」，清单本体同源，杜绝两处漂移；
 *   - 标准值双轨：数值口径（36±0.5 / 36+0.2/-0.1 / 36）→ dataType NUMERIC + 公称值/上下公差，
 *     检验录入按公差带自动判定；文字要求（「按产品标准」「通止规通过」）→ 原文落 remark、
 *     standardText 留空、dataType 保持 TEXT/QUALITATIVE，录入挂 PENDING 人工确认。
 *     （判定器会把 standardText 按 , ， / | 拆成可接受值逐字比对，把说明语写进 standardText
 *      会导致录入永远判不合格 —— 导入侧同样不许破这条口径）；
 *   - 同一方案的方案级字段（名称/分类/物料/质检类型/版本/抽样参数）必须在所有行保持一致，
 *     不一致整组判失败（绝不用"某行覆盖某行"的静默语义）；
 *   - 落库一律走 CreatePlanUseCase（首个版本即启用、服务端取号、审计 + Outbox），与 POST /plans 同口径；
 *     方案不再进入草稿，导入即生效，不需要时用户在方案列表「停用」。
 *
 * 重复导入保护：同「方案名称 + 物料编码 + 分类编码 + 主质检类型」的既有方案判为重复并跳过，
 * 否则用户修正某行后整文件重传会造出重复方案。
 */

// ============================================================================
// 1. 模板列定义（表头、必填性、批注、列宽的唯一来源：模板生成与解析共用，保证"模板适配导入"）
// ============================================================================

type PlanImportColumnKey =
  | 'planName'
  | 'categoryCode'
  | 'materialCode'
  | 'inspectionTypes'
  | 'versionNo'
  | 'samplingScheme'
  | 'aqlLevel'
  | 'strictness'
  | 'categoryKey'
  | 'presetCode'
  | 'standardText'
  | 'remark';

interface PlanImportColumn {
  key: PlanImportColumnKey;
  /** 表头显示文本（必填列以 * 结尾；解析时表头按"去掉 * 与空白"归一后匹配） */
  header: string;
  required: boolean;
  width: number;
  /** 生成模板时写入表头单元格的批注 */
  note: string;
}

export const PLAN_IMPORT_SHEET_NAME = '方案导入';

export const PLAN_IMPORT_COLUMNS: readonly PlanImportColumn[] = [
  {
    key: 'planName',
    header: '方案名称*',
    required: true,
    width: 24,
    note: '必填。同一方案的各行填写完全相同的方案名称（+分类编码+物料编码），导入时合并为一个方案。',
  },
  {
    key: 'categoryCode',
    header: '产品分类编码*',
    required: true,
    width: 16,
    note: '必填。存货分类编码，取值见「填写说明」页的分类清单。',
  },
  {
    key: 'materialCode',
    header: '物料编码',
    required: false,
    width: 18,
    note: '选填。留空 = 该分类的通用方案（分类级兜底匹配）；填写时必须是该分类下真实存在的物料编码，取值见「物料参照」页。',
  },
  {
    key: 'inspectionTypes',
    header: '质检类型*',
    required: true,
    width: 20,
    note: '必填。填编码（IQC / IPQC_CT / OQC_SH …）或中文名（来料检验 / 下料检验 …）；多类型用 , 、 / ; 分隔，第一个为主类型。取值表见「填写说明」。',
  },
  {
    key: 'versionNo',
    header: '版本号',
    required: false,
    width: 10,
    note: '选填，缺省 V1.0。导入即启用，不合适的方案可在方案列表「停用」。',
  },
  {
    key: 'samplingScheme',
    header: '抽样方案',
    required: false,
    width: 14,
    note: '选填，缺省 GB_T_2828。',
  },
  {
    key: 'aqlLevel',
    header: 'AQL水平',
    required: false,
    width: 10,
    note: '选填，缺省 II。',
  },
  {
    key: 'strictness',
    header: '检验严格度',
    required: false,
    width: 12,
    note: '选填，缺省 NORMAL。',
  },
  {
    key: 'categoryKey',
    header: '检验类别',
    required: false,
    width: 14,
    note: '选填。外观检验 / 尺寸检验 / 性能检验（也可填 APPEARANCE / DIMENSION / PERFORMANCE）。留空时按检验项目编码自动归类；填写时必须与该项目所属类别一致，否则该组判失败。',
  },
  {
    key: 'presetCode',
    header: '检验项目编码*',
    required: true,
    width: 16,
    note: '必填。填预置项目编码（AP-01 / DM-06 / PF-01，大小写与 ITEM- 前缀均可省略）或项目中文名（如「牙距 P」）；完整清单（编码 + 名称 + 默认要求）见「填写说明」页。',
  },
  {
    key: 'standardText',
    header: '标准值',
    required: false,
    width: 26,
    note: '选填。数值口径（36±0.5 / 36+0.2/-0.1 / 36）保存后按公差自动判定；文字要求（如「按产品标准」「通止规通过」）由检验员人工确认。',
  },
  {
    key: 'remark',
    header: '备注',
    required: false,
    width: 22,
    note: '选填。标准值为文字要求时，备注会与标准值一并作为检验员参考说明。',
  },
];

// ============================================================================
// 2. 质检类型 / 检验类别 别名解析（编码 / 中文名两种写法都接受）
// ============================================================================

/** 契约枚举 → 展示标签，与 apps/web/src/lib/inspectionTypes.ts 的 INSPECTION_TYPES.label 逐字一致 */
const INSPECTION_TYPE_LABELS: Record<InspectionType, string> = {
  IQC: 'IQC 来料检验',
  IPQC_CT: 'IPQC 下料检验',
  IPQC_RL: 'IPQC 滚丝检验',
  IPQC_FN: 'FQC 成品入库终检',
  OQC_SF: 'OQC 委外加工检验',
  OQC_SH: 'OQC 出货检验',
  OQC_HEAT: 'OQC 委外热处理',
  OQC_BLACK: 'OQC 委外发黑',
  OQC_ZINC: 'OQC 委外镀锌',
  OQC_NICKEL: 'OQC 委外镀镍',
  OQC_PHOSPH: 'OQC 委外磷化',
  OQC_DACRO: 'OQC 委外达克罗',
  OQC_MACH: 'OQC 委外机加工',
};

const TYPE_ALIAS = (() => {
  const map = new Map<string, InspectionType>();
  for (const type of InspectionTypeEnum.options) {
    map.set(type.toUpperCase(), type);
    const label = INSPECTION_TYPE_LABELS[type];
    map.set(label.toUpperCase(), type);
    map.set(label.replace(/\s+/g, '').toUpperCase(), type);
    const short = label.includes(' ') ? label.slice(label.indexOf(' ') + 1) : label;
    map.set(short.toUpperCase(), type);
  }
  return map;
})();

/** 解析质检类型单元格：多类型用 , ， 、 ; ； / | 分隔；返回去重后的枚举数组（首个为主类型），无法识别返回 null */
function parseInspectionTypes(text: string): InspectionType[] | null {
  const tokens = text
    .split(/[,，、;；/|]+/)
    .map((token) => token.trim())
    .filter((token) => token !== '');
  if (tokens.length === 0) return null;
  const resolved: InspectionType[] = [];
  for (const token of tokens) {
    const type = TYPE_ALIAS.get(token.toUpperCase());
    if (type === undefined) return null;
    if (!resolved.includes(type)) resolved.push(type);
  }
  return resolved.length > 0 ? resolved : null;
}

/** 解析检验类别单元格：编码（APPEARANCE）/ 中文名（外观检验 / 外观）都可；空白返回 undefined */
function parsePlanCategoryKey(text: string): PlanCategoryKey | undefined | null {
  const raw = text.trim().toUpperCase();
  if (raw === '') return undefined;
  for (const category of PLAN_CHECK_CATEGORIES) {
    if (raw === category.key) return category.key;
    if (raw === category.name.toUpperCase() || raw === category.name.replace('检验', '').toUpperCase()) {
      return category.key;
    }
  }
  return null; // 填了但认不出
}

// ============================================================================
// 3. 指标项构建（预置清单 + 标准值双轨，与 CreatePlanModal 的提交口径逐字一致）
// ============================================================================

/**
 * 行 → 方案指标项。
 *   - 项目本体取自预置清单（metricCategory / dataType / ERP 回链编码都由清单决定，不推导、不捏造）；
 *   - 标准值数值口径 → NUMERIC + 公称值/上下公差 + dif 原文（自动判定）；
 *     文字/空白 → 清单默认 dataType，标准值原文与备注合并落 remark（人工确认）。
 */
function buildPlanItem(
  seq: number,
  preset: PlanPresetItem,
  standardText: string,
  remark: string
): InspectionPlanItem {
  const parsed = parsePlanStandardValue(standardText);
  const base: InspectionPlanItem = {
    seq,
    itemCode: planPresetItemCode(preset.code),
    name: preset.name,
    metricCategory: preset.metricCategory,
    // 清单默认类型（文字/定性）；下方数值口径解析成功时覆盖为 NUMERIC
    dataType: preset.dataType,
    ...(preset.testItemCode !== undefined ? { testItemCode: preset.testItemCode } : {}),
    isMandatory: true,
  };
  if (parsed !== null) {
    return {
      ...base,
      dataType: 'NUMERIC',
      nominalValue: parsed.nominal,
      upperTolerance: parsed.upper,
      lowerTolerance: parsed.lower,
      ...(parsed.dif !== undefined ? { dif: parsed.dif } : {}),
      ...(remark !== '' ? { remark } : {}),
    };
  }
  // 文字要求 / 留空：落 remark 供检验员参考，standardText 留空 ——
  // 判定器对无基准的文本项返回 PENDING 挂起人工确认，
  // 绝不把「按产品标准」这类说明语当可接受值逐字比对。
  const notes = [standardText.trim(), remark.trim()].filter((part) => part !== '');
  return {
    ...base,
    dataType: preset.dataType,
    ...(notes.length > 0 ? { remark: notes.join('；') } : {}),
  };
}

// ============================================================================
// 4. 单元格取值与字段归一化
// ============================================================================

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 单元格 → 文本。覆盖 exceljs 的全部值形态：普通文本 / 数字 / Date / 富文本 / 超链接 / 公式结果。
 * Date 直接按本地年月日格式化（用户在 Excel 里以日期格式录入的真实日期）。
 */
function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
  }
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') {
    const record = value as unknown as Record<string, unknown>;
    if (Array.isArray(record['richText'])) {
      return (record['richText'] as { text?: string }[])
        .map((run) => run.text ?? '')
        .join('')
        .trim();
    }
    if (typeof record['text'] === 'string') return record['text'].trim();
    if (record['result'] !== undefined && record['result'] !== null) {
      const result = record['result'];
      if (result instanceof Date) {
        return `${result.getFullYear()}-${pad2(result.getMonth() + 1)}-${pad2(result.getDate())}`;
      }
      return String(result).trim();
    }
  }
  return String(value).trim();
}

/** 版本号归一化：空 → V1.0；纯数字（含小数）→ 补 V 前缀（容忍用户在 Excel 里只填 1 / 2.0） */
function normalizeVersionNo(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return 'V1.0';
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return `V${trimmed}`;
  return trimmed;
}

// ============================================================================
// 5. 解析入口：工作簿 → 行 → 方案组（组内一致性校验 + 指标项构建）
// ============================================================================

/** 导入所需主数据（控制器一次性拉取传入，避免按行查询） */
export interface PlanImportMasterData {
  categories: InventoryCategory[];
  materials: Material[];
}

export interface ParsedPlanRow {
  rowNo: number;
  planName: string;
  categoryCode: string;
  /** '' = 分类通用方案（与落库 material_code 空串口径一致） */
  materialCode: string;
  inspectionTypesText: string;
  versionNo: string;
  samplingScheme: string;
  aqlLevel: string;
  strictness: string;
  /** 检验类别原文（可空：按项目编码自动归类） */
  categoryKeyText: string;
  presetCode: string;
  standardText: string;
  remark: string;
}

/** 通过全部校验、可直接调用 CreatePlanUseCase 的方案组 */
export interface ParsedPlanGroup {
  rows: number[];
  planName: string;
  categoryCode: string;
  materialCode: string;
  /** 创建入参 materialCategory：绑定物料的真实分类；无物料时与 POST /plans 一致回落 STANDARD_PARTS */
  materialCategory: string;
  inspectionTypes: InspectionType[];
  versionNo: string;
  samplingScheme: string;
  aqlLevel: string;
  strictness: string;
  items: InspectionPlanItem[];
}

export interface PlanImportFailure {
  planName: string;
  rows: number[];
  reason: string;
}

export interface PlanImportParseResult {
  totalRows: number;
  groups: ParsedPlanGroup[];
  failures: PlanImportFailure[];
}

/** 表头文本归一：去空白、去必填星号、去全角星号 */
function normalizeHeader(text: string): string {
  return text.replace(/[\s*＊]/g, '');
}

/**
 * 字段级空值归一（Excel 单元格读取与 PDF 表格列还原共用），不做语义校验。
 * rowNo 只用于失败原因里点名行号：Excel 用真实行号，PDF 用数据行序号。
 */
function parsedRowFrom(get: (key: PlanImportColumnKey) => string, rowNo: number): ParsedPlanRow {
  return {
    rowNo,
    planName: get('planName'),
    categoryCode: get('categoryCode').toUpperCase(),
    materialCode: get('materialCode').toUpperCase(),
    inspectionTypesText: get('inspectionTypes'),
    versionNo: normalizeVersionNo(get('versionNo')),
    samplingScheme: get('samplingScheme'),
    aqlLevel: get('aqlLevel'),
    strictness: get('strictness'),
    categoryKeyText: get('categoryKey'),
    presetCode: get('presetCode'),
    standardText: get('standardText'),
    remark: get('remark'),
  };
}

/** 读取 Excel 一行 → 原始字段（行号取 Excel 真实行号，失败提示才对得上用户看的表） */
function readRow(row: ExcelJS.Row, colIndex: Map<PlanImportColumnKey, number>): ParsedPlanRow {
  return parsedRowFrom((key) => {
    const index = colIndex.get(key);
    return index === undefined ? '' : cellText(row.getCell(index));
  }, row.number);
}

/** 行是否为空白行（所有映射列都为空；残留格式的行不占用行数统计） */
function rowIsBlank(row: ParsedPlanRow): boolean {
  return (
    row.planName === '' &&
    row.categoryCode === '' &&
    row.materialCode === '' &&
    row.inspectionTypesText === '' &&
    row.categoryKeyText === '' &&
    row.presetCode === '' &&
    row.standardText === '' &&
    row.remark === ''
  );
}

/**
 * 解析导入工作簿。
 *
 * 结构性错误（找不到工作表 / 缺必填表头 / 无数据行）抛 ValidationFailedError（400）；
 * 行级与组级问题收敛到 failures 返回，由控制器拼装三态结果。
 */
export async function parsePlanImportWorkbook(
  buffer: Buffer,
  masterData: PlanImportMasterData
): Promise<PlanImportParseResult> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(new Uint8Array(buffer).buffer);
  } catch {
    throw new ValidationFailedError('文件不是有效的 .xlsx 工作簿，请使用「下载导入模板」生成的模板填写后上传');
  }

  const worksheet =
    workbook.getWorksheet(PLAN_IMPORT_SHEET_NAME) ?? workbook.worksheets[0];
  if (worksheet === undefined) {
    throw new ValidationFailedError('工作簿中没有工作表，请使用导入模板填写数据');
  }

  // 表头映射：归一化表头文本 → 列号；模板列顺序可变，按名字识别
  const headerRow = worksheet.getRow(1);
  const headerByText = new Map<string, number>();
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const text = normalizeHeader(cellText(cell));
    if (text !== '' && !headerByText.has(text)) headerByText.set(text, colNumber);
  });

  const colIndex = new Map<PlanImportColumnKey, number>();
  const missing: string[] = [];
  for (const col of PLAN_IMPORT_COLUMNS) {
    const found = headerByText.get(normalizeHeader(col.header));
    if (found === undefined) missing.push(col.header);
    else colIndex.set(col.key, found);
  }
  if (missing.length > 0) {
    throw new ValidationFailedError(
      `导入文件表头缺少列：${missing.join('、')}。请下载最新导入模板，不要自行改动表头`
    );
  }

  // 逐行读取（表头行除外）；完全空白的行跳过
  const rows: ParsedPlanRow[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const parsed = readRow(row, colIndex);
    if (!rowIsBlank(parsed)) rows.push(parsed);
  });

  if (rows.length === 0) {
    throw new ValidationFailedError('导入文件没有数据行，请按模板填写至少一行检验项目');
  }

  return buildPlanImportResult(rows, masterData);
}

/**
 * 表格型 PDF → 结果（与 xlsx 走完全相同的校验 / 分组 / 落库链路）。
 *
 * 表格型 PDF 的文字层被抽成「文本片段 + 坐标」，再借表头行的列名位置划列还原成行；
 * 抽不到文字（扫描件 / 图片型）或找不到表头时，抛 400 并给出明确指引，绝不静默失败。
 */
export function parsePlanImportPdf(
  buffer: Buffer,
  masterData: PlanImportMasterData
): PlanImportParseResult {
  let items;
  try {
    items = extractPdfTextItems(buffer);
  } catch (error) {
    throw new ValidationFailedError(
      `PDF 解析失败：${error instanceof Error ? error.message : String(error)}。请改用 Excel 模板填写后导入`
    );
  }
  if (items.length === 0) {
    throw new ValidationFailedError(
      '这个 PDF 里读不到文字（可能是扫描件或纯图片 PDF）。请上传由导入模板另存 / 打印出来的表格型 PDF'
    );
  }

  const table = pdfRowsToTable(groupPdfRows(items), {
    keys: PLAN_IMPORT_COLUMNS.map((column) => column.key),
    headers: PLAN_IMPORT_COLUMNS.map((column) => column.header),
    // 方案名称列有值 = 一条新记录；其后的续行（单元格内换行）并进同一条
    recordKey: 'planName',
  });
  if (!table.headerFound) {
    throw new ValidationFailedError(
      'PDF 里没有找到导入模板的表头（方案名称 / 产品分类编码 / 检验项目编码 …）。请用「下载模板」的 Excel 另存为 PDF 后上传'
    );
  }

  const rows = table.rows
    .map((record, index) => parsedRowFrom((key) => record[key] ?? '', index + 1))
    .filter((row) => !rowIsBlank(row));
  if (rows.length === 0) {
    throw new ValidationFailedError('PDF 表格里没有可导入的数据行，请确认表格内容已填写');
  }

  return buildPlanImportResult(rows, masterData);
}

/**
 * 行 → 组 → 结果（xlsx 与表格型 PDF 共用的校验 / 分组 / 指标项构建层）。
 *
 * 只看归一化后的 ParsedPlanRow，不关心来源格式：来源差异（单元格读取 / PDF 表格还原）
 * 在进这一层之前就已经抹平，保证两种格式的校验口径、失败原因、落库结果完全一致。
 */
export function buildPlanImportResult(
  rows: ParsedPlanRow[],
  masterData: PlanImportMasterData
): PlanImportParseResult {
  // 按「方案名称 + 分类编码 + 物料编码」聚组（行顺序保留 = 指标项 seq 顺序）
  const groupsByKey = new Map<string, ParsedPlanRow[]>();
  for (const row of rows) {
    const key = `${row.planName}|${row.categoryCode}|${row.materialCode}`;
    const group = groupsByKey.get(key);
    if (group === undefined) groupsByKey.set(key, [row]);
    else group.push(row);
  }

  const categoryByCode = new Map(masterData.categories.map((item) => [item.categoryCode, item]));
  const materialByCode = new Map(masterData.materials.map((item) => [item.materialCode, item]));

  const groups: ParsedPlanGroup[] = [];
  const failures: PlanImportFailure[] = [];

  for (const groupRows of groupsByKey.values()) {
    const rowNos = groupRows.map((row) => row.rowNo);
    const issues: string[] = [];
    const first = groupRows[0]!;
    const planName = first.planName;
    const label = planName === '' ? '（未填写方案名称）' : planName;
    const fail = (reason: string): void => {
      failures.push({ planName: label, rows: rowNos, reason });
    };

    // —— 方案级字段校验（组内每行按 key 保证同名同类同物料，其余字段需逐一比对一致性）——
    if (planName === '') issues.push('方案名称不能为空');
    if (first.categoryCode === '') {
      issues.push('产品分类编码不能为空');
    } else if (!categoryByCode.has(first.categoryCode)) {
      issues.push(`产品分类编码 [${first.categoryCode}] 不存在于存货分类档案`);
    }

    let material: Material | undefined;
    if (first.materialCode !== '') {
      material = materialByCode.get(first.materialCode);
      if (material === undefined) {
        issues.push(`物料编码 [${first.materialCode}] 不存在于物料档案`);
      } else if (first.categoryCode !== '' && material.categoryCode !== first.categoryCode) {
        issues.push(
          `物料 [${first.materialCode}] 属于分类 [${material.categoryCode}]，与产品分类编码 [${first.categoryCode}] 不一致`
        );
      }
    }

    // 质检类型：逐行解析（失败行记入问题），再比对组内一致性
    const typesPerRow = groupRows.map((row) => parseInspectionTypes(row.inspectionTypesText));
    groupRows.forEach((row, index) => {
      if (row.inspectionTypesText.trim() === '') issues.push(`第 ${row.rowNo} 行：质检类型不能为空`);
      else if (typesPerRow[index] === null) {
        issues.push(`第 ${row.rowNo} 行：质检类型 [${row.inspectionTypesText}] 无法识别（取值见模板「填写说明」页）`);
      }
    });
    const resolvedTypes = typesPerRow[0] ?? null;
    if (resolvedTypes !== null) {
      const signature = resolvedTypes.join('+');
      groupRows.forEach((row, index) => {
        const current = typesPerRow[index];
        if (current !== null && current !== undefined && current.join('+') !== signature) {
          issues.push(
            `第 ${row.rowNo} 行：质检类型 [${row.inspectionTypesText}] 与首行不一致（同一方案的质检类型必须完全相同）`
          );
        }
      });
    }

    // 版本级字段组内一致性（版本号 / 抽样参数）
    const versionFields: { label: string; pick: (row: ParsedPlanRow) => string }[] = [
      { label: '版本号', pick: (row) => row.versionNo },
      { label: '抽样方案', pick: (row) => row.samplingScheme },
      { label: 'AQL水平', pick: (row) => row.aqlLevel },
      { label: '检验严格度', pick: (row) => row.strictness },
    ];
    for (const field of versionFields) {
      const expected = field.pick(first);
      for (const row of groupRows.slice(1)) {
        if (field.pick(row) !== expected) {
          issues.push(`第 ${row.rowNo} 行：${field.label} 与首行不一致（同一方案的版本级字段必须完全相同）`);
          break;
        }
      }
    }

    // —— 行级指标项校验（预置清单命中 + 类别一致性 + 组内去重）——
    const items: InspectionPlanItem[] = [];
    const seenCodes = new Set<string>();
    for (const row of groupRows) {
      if (row.presetCode === '') {
        issues.push(`第 ${row.rowNo} 行：检验项目编码不能为空`);
        continue;
      }
      const hit = findPlanPreset(row.presetCode);
      if (hit === undefined) {
        issues.push(
          `第 ${row.rowNo} 行：检验项目编码 [${row.presetCode}] 不在预置检验项目清单中（取值见模板「填写说明」页，可填编码 AP-01 / DM-06 / PF-01 或项目中文名）`
        );
        continue;
      }
      const declared = parsePlanCategoryKey(row.categoryKeyText);
      if (declared === null) {
        issues.push(`第 ${row.rowNo} 行：检验类别 [${row.categoryKeyText}] 无法识别（应为 外观检验 / 尺寸检验 / 性能检验）`);
        continue;
      }
      if (declared !== undefined && declared !== hit.category.key) {
        issues.push(
          `第 ${row.rowNo} 行：检验类别 [${row.categoryKeyText}] 与检验项目 [${hit.item.name}] 所属类别（${hit.category.name}）不一致`
        );
        continue;
      }
      if (seenCodes.has(hit.item.code)) {
        issues.push(`第 ${row.rowNo} 行：检验项目 [${hit.item.name}] 在本方案中重复出现`);
        continue;
      }
      seenCodes.add(hit.item.code);
      items.push(buildPlanItem(items.length + 1, hit.item, row.standardText, row.remark));
    }

    if (issues.length > 0) {
      fail(issues.join('；'));
      continue;
    }
    if (items.length === 0) {
      fail('没有可导入的检验指标项');
      continue;
    }
    if (resolvedTypes === null || resolvedTypes.length === 0) {
      fail('质检类型无法识别');
      continue;
    }

    groups.push({
      rows: rowNos,
      planName,
      categoryCode: first.categoryCode,
      materialCode: first.materialCode,
      materialCategory: material?.categoryCode ?? 'STANDARD_PARTS',
      inspectionTypes: resolvedTypes,
      versionNo: first.versionNo,
      samplingScheme: first.samplingScheme === '' ? 'GB_T_2828' : first.samplingScheme,
      aqlLevel: first.aqlLevel === '' ? 'II' : first.aqlLevel,
      strictness: first.strictness === '' ? 'NORMAL' : first.strictness,
      items,
    });
  }

  return { totalRows: rows.length, groups, failures };
}

// ============================================================================
// 6. 导入模板生成（列定义 + 主数据即"适配口径"：预置清单 / 分类 / 物料参照实时取自库中）
// ============================================================================

const HEADER_FILL: ExcelJS.FillPattern = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2B5AED' } };
const HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };

function styleTableHeader(row: ExcelJS.Row, cellCount: number): void {
  for (let col = 1; col <= cellCount; col += 1) {
    const cell = row.getCell(col);
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
    };
  }
  row.height = 22;
}

/** 生成导入模板工作簿（「方案导入」数据页 + 「填写说明」规则页 + 「物料参照」编码页） */
export async function buildPlanImportTemplate(masterData: PlanImportMasterData): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Letian QMS';
  workbook.created = new Date();

  // ---- Sheet 1：方案导入（数据页，只有表头，示例放在说明页防止误导入） ----
  const sheet = workbook.addWorksheet(PLAN_IMPORT_SHEET_NAME, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = PLAN_IMPORT_COLUMNS.map((col) => ({ key: col.key, width: col.width }));
  const headerRow = sheet.getRow(1);
  PLAN_IMPORT_COLUMNS.forEach((col, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = col.header;
    cell.note = col.note;
  });
  styleTableHeader(headerRow, PLAN_IMPORT_COLUMNS.length);

  // ---- Sheet 2：填写说明（规则 + 预置项目清单 + 取值表 + 填写示例） ----
  const guide = workbook.addWorksheet('填写说明');
  guide.columns = [{ width: 18 }, { width: 24 }, { width: 26 }, { width: 26 }];
  const writeLine = (text: string, bold = false): void => {
    const row = guide.addRow([text]);
    if (bold) row.getCell(1).font = { bold: true, size: 12 };
  };

  writeLine('质检方案 Excel 导入模板 · 填写说明', true);
  writeLine('');
  [
    '1. 「方案导入」页每一行 = 一个检验指标项；同一方案的方案级字段（方案名称/产品分类编码/物料编码/质检类型/版本号/抽样参数）必须在所有行完全一致。',
    '2. 方案名称 + 产品分类编码 + 物料编码 相同的行会合并为一个方案；检验项目按行顺序成为指标项，同一方案里同一项目只能填一次。',
    '3. 物料编码留空表示「该分类通用方案」（物料无专属方案时兜底命中）；填写时必须是该分类下真实存在的物料编码。',
    '4. 质检类型填编码（推荐）或中文名；多类型用 , 、 / ; 分隔，第一个为主类型。',
    '5. 检验项目编码来自下方「预置检验项目清单」，可填编码（AP-01 / DM-06 / PF-01）或项目中文名；清单与系统里「新建质检方案」的勾选清单完全一致。',
    '6. 标准值填数值口径（36±0.5、36+0.2/-0.1、36）时，保存后检验录入按公差自动判定；填文字要求（如「按产品标准」「通止规通过」）或留空时，由检验员在录入后人工确认。',
    '7. 检验类别可留空（按项目编码自动归类）；填写时必须与项目所属类别一致，不一致该组不导入。',
    '8. 方案库中已存在「同名 + 同物料 + 同分类 + 同主类型」的方案时，该组判为重复并跳过，不会重复创建。',
    '9. 导入的方案保存即启用（默认 V1.0），直接可参与检验录入的自动匹配；不合适的方案可在方案列表「停用」。',
    '10. 方案级字段组内不一致 / 行级校验失败的组整组不导入，其余组不受影响；导入结果逐组回显。',
  ].forEach((line) => writeLine(line));

  writeLine('');
  writeLine('预置检验项目清单（与「新建质检方案」勾选清单同源）', true);
  const presetHeader = guide.addRow(['检验类别', '项目编码', '项目名称', '默认要求（标准值示例）']);
  styleTableHeader(presetHeader, 4);
  for (const category of PLAN_CHECK_CATEGORIES) {
    for (const item of category.items) {
      guide.addRow([category.name, item.code, item.name, item.hint]);
    }
  }

  writeLine('');
  writeLine('质检类型取值表（编码 ↔ 名称）', true);
  const typeHeader = guide.addRow(['类型编码', '类型名称']);
  styleTableHeader(typeHeader, 2);
  for (const type of InspectionTypeEnum.options) {
    guide.addRow([type, INSPECTION_TYPE_LABELS[type]]);
  }

  writeLine('');
  writeLine('存货分类取值表', true);
  const catHeader = guide.addRow(['分类编码', '分类名称']);
  styleTableHeader(catHeader, 2);
  for (const category of masterData.categories) {
    guide.addRow([category.categoryCode, category.categoryName]);
  }

  writeLine('');
  writeLine('填写示例（请勿复制到数据页，仅供格式参照）', true);
  const exampleHeader = guide.addRow(PLAN_IMPORT_COLUMNS.map((col) => col.header));
  styleTableHeader(exampleHeader, PLAN_IMPORT_COLUMNS.length);
  const exampleMaterial = masterData.materials[0];
  const exampleCategory =
    masterData.categories.find((item) => item.categoryCode === exampleMaterial?.categoryCode) ??
    masterData.categories[0];
  // 三行示例覆盖三种口径：外观（文字要求）、尺寸（数值公差）、性能（按产品标准）
  const examples: { row: Record<PlanImportColumnKey, string> }[] = [
    {
      row: {
        planName: '示例方案-来料检验',
        categoryCode: exampleCategory?.categoryCode ?? '',
        materialCode: exampleMaterial?.materialCode ?? '',
        inspectionTypes: 'IQC',
        versionNo: 'V1.0',
        samplingScheme: 'GB_T_2828',
        aqlLevel: 'II',
        strictness: 'NORMAL',
        categoryKey: '外观检验',
        presetCode: 'AP-01',
        standardText: '清理干净，美观光滑平整无毛刺',
        remark: '',
      },
    },
    {
      row: {
        planName: '示例方案-来料检验',
        categoryCode: exampleCategory?.categoryCode ?? '',
        materialCode: exampleMaterial?.materialCode ?? '',
        inspectionTypes: 'IQC',
        versionNo: 'V1.0',
        samplingScheme: 'GB_T_2828',
        aqlLevel: 'II',
        strictness: 'NORMAL',
        categoryKey: '尺寸检验',
        presetCode: 'DM-06',
        standardText: '100±0.5',
        remark: '',
      },
    },
    {
      row: {
        planName: '示例方案-来料检验',
        categoryCode: exampleCategory?.categoryCode ?? '',
        materialCode: exampleMaterial?.materialCode ?? '',
        inspectionTypes: 'IQC',
        versionNo: 'V1.0',
        samplingScheme: 'GB_T_2828',
        aqlLevel: 'II',
        strictness: 'NORMAL',
        categoryKey: '性能检验',
        presetCode: 'PF-01',
        standardText: '按产品标准',
        remark: '',
      },
    },
  ];
  for (const example of examples) {
    guide.addRow(PLAN_IMPORT_COLUMNS.map((col) => example.row[col.key]));
  }

  // ---- Sheet 3：物料参照（编码 / 名称 / 所属分类 / 规格型号） ----
  const materialsSheet = workbook.addWorksheet('物料参照', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  materialsSheet.columns = [
    { width: 18 },
    { width: 30 },
    { width: 16 },
    { width: 24 },
  ];
  const matHeader = materialsSheet.addRow(['物料编码', '物料名称', '产品分类编码', '规格型号']);
  styleTableHeader(matHeader, 4);
  for (const material of masterData.materials) {
    materialsSheet.addRow([
      material.materialCode,
      material.materialName,
      material.categoryCode,
      material.specModel ?? '',
    ]);
  }

  const output = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(output) ? output : Buffer.from(output as ArrayBuffer);
}
