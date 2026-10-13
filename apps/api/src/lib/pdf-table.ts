import type { PdfTextItem } from './pdf-text';

/**
 * PDF 文本片段 → 表格行 → 模板列（供「导入方案」的表格型 PDF 走与 xlsx 相同的校验/落库链路）。
 *
 * 思路：表格型 PDF（Excel 模板另存 / 打印）的每个单元格文字是独立文本片段，
 * 因此先用 y 坐标聚行、再借**表头行的列名位置**划定列区间，把数据行的片段归列。
 * 列定义（表头文本）由调用方传入，本模块不认识业务字段，保持通用。
 *
 * 局限（由上层给提示）：扫描件 / 图片 PDF 没有文字片段 → 行数为 0；表头被拆散或旋转打印时
 * 可能识别不到列 → headerFound=false。
 */

/** 行：同一基线上的文本片段（按 x 升序） */
export interface PdfRow {
  page: number;
  y: number;
  items: { x: number; text: string }[];
}

/** 列定义（调用方提供：keys 与 headers 一一对应；表头按「去空白去星号」归一后匹配） */
export interface PdfColumnSpec {
  keys: string[];
  headers: string[];
  /**
   * 记录起始列（默认第一列）：该列有内容的物理行视为一条新记录，
   * 该列为空的后续物理行并进上一条记录 —— 表格单元格文字换行时，
   * 同一行数据会摊到多个 y 上，靠这一列判定记录边界。
   */
  recordKey?: string;
}

export interface PdfTableParseResult {
  /** 每行一个「列 key → 文本」映射；表头行与空行已跳过 */
  rows: Record<string, string>[];
  /** 是否在 PDF 里找到可识别的表头行（false 时调用方应给出「请用模板导出的表格 PDF」提示） */
  headerFound: boolean;
  /** 解析到的文本片段总数（0 通常意味着扫描件/图片 PDF） */
  textItemCount: number;
}

function normalize(text: string): string {
  return text.replace(/[\s*＊]/g, '');
}

/** 文本片段 → 行（按页分组、页内按 y 降序；同一行容差内合并） */
export function groupPdfRows(items: PdfTextItem[], yTolerance = 3): PdfRow[] {
  const byPage = new Map<number, PdfTextItem[]>();
  for (const item of items) {
    const bucket = byPage.get(item.page);
    if (bucket === undefined) byPage.set(item.page, [item]);
    else bucket.push(item);
  }

  const rows: PdfRow[] = [];
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    const pageItems = byPage.get(page)!;
    // y 大的在上（PDF 原点左下）
    pageItems.sort((a, b) => (b.y === a.y ? a.x - b.x : b.y - a.y));
    let current: PdfRow | null = null;
    for (const item of pageItems) {
      if (current === null || Math.abs(current.y - item.y) > yTolerance) {
        current = { page, y: item.y, items: [] };
        rows.push(current);
      }
      current.items.push({ x: item.x, text: item.text });
    }
  }
  for (const row of rows) row.items.sort((a, b) => a.x - b.x);
  return rows;
}

/** 行内文本（按 x 拼接） */
function rowText(row: PdfRow): string {
  return row.items.map((item) => item.text).join('');
}

/**
 * 在行内按「归一化后的字符序列」定位某个列名，返回该列名首字符的 x 坐标。
 * 列名可能被拆成多个文本片段（如「标准」+「值」），拼接后再找即可。
 */
function findColumnX(row: PdfRow, headerNormalized: string): number | null {
  let normalized = '';
  const xOfChar: number[] = [];
  for (const item of row.items) {
    for (const char of item.text) {
      if (/[\s*＊]/.test(char)) continue;
      normalized += char;
      xOfChar.push(item.x);
    }
  }
  const position = normalized.indexOf(headerNormalized);
  if (position === -1) return null;
  return xOfChar[position] ?? null;
}

interface ColumnBoundary {
  key: string;
  header: string;
  x: number;
}

/** 由表头行的列中心坐标算列区间（相邻中点即边界；首尾开放） */
function boundariesOf(columns: ColumnBoundary[]): { key: string; min: number; max: number }[] {
  const sorted = [...columns].sort((a, b) => a.x - b.x);
  return sorted.map((column, index) => {
    const previous = sorted[index - 1];
    const next = sorted[index + 1];
    return {
      key: column.key,
      min: previous === undefined ? Number.NEGATIVE_INFINITY : (previous.x + column.x) / 2,
      max: next === undefined ? Number.POSITIVE_INFINITY : (column.x + next.x) / 2,
    };
  });
}

/** 表头行是否成立：命中的列名数量 */
function matchColumns(row: PdfRow, spec: PdfColumnSpec): ColumnBoundary[] {
  const found: ColumnBoundary[] = [];
  spec.keys.forEach((key, index) => {
    const header = spec.headers[index];
    if (header === undefined) return;
    const x = findColumnX(row, normalize(header));
    if (x !== null) found.push({ key, header, x });
  });
  return found;
}

/** 行是否像表头（命中列名 >= 3 个即认为表头，防止数据行里偶然出现列名误判） */
function looksLikeHeader(row: PdfRow, spec: PdfColumnSpec): boolean {
  return matchColumns(row, spec).length >= 3;
}

/**
 * 行 → 列映射。逐页处理：每页找表头行划定列区间，其后的行按 x 归列。
 * 某页没有表头时沿用上一页的列区间（Excel 打印常只在首页带表头）。
 */
export function pdfRowsToTable(rows: PdfRow[], spec: PdfColumnSpec): PdfTableParseResult {
  const result: Record<string, string>[] = [];
  const textItemCount = rows.reduce((total, row) => total + row.items.length, 0);
  let headerFound = false;
  // 列区间：遇到表头行就（重新）划定；跨页无表头时沿用上一页的（Excel 打印常只在首页带表头）
  let boundaries: { key: string; min: number; max: number }[] | null = null;
  const recordKey = spec.recordKey ?? spec.keys[0];

  // 坐标方向判定：部分 PDF 用翻转 CTM（y 越大越靠下），此时按 y 降序排出来的
  // 文档顺序是反的 —— 用表头行出现的位置把顺序摆正，保证「记录起始列」的合并方向正确。
  const headerIndex = rows.findIndex((row) => matchColumns(row, spec).length >= 3);
  const ordered = headerIndex > rows.length / 2 ? [...rows].reverse() : rows;

  for (const row of ordered) {
    const columns = matchColumns(row, spec);
    if (columns.length >= 3) {
      headerFound = true;
      boundaries = boundariesOf(columns);
      continue; // 表头行本身不入数据
    }
    if (boundaries === null) continue; // 表头尚未出现，无法定位列

    const cells = new Map<string, string[]>();
    for (const item of row.items) {
      const boundary = boundaries.find((entry) => item.x >= entry.min && item.x < entry.max);
      const key = boundary?.key;
      if (key === undefined) continue;
      const bucket = cells.get(key);
      if (bucket === undefined) cells.set(key, [item.text]);
      else bucket.push(item.text);
    }
    if (cells.size === 0) continue;

    const record: Record<string, string> = {};
    let hasContent = false;
    for (const [key, parts] of cells) {
      const text = parts.join('').trim();
      if (text !== '') {
        record[key] = text;
        hasContent = true;
      }
    }
    if (!hasContent) continue;

    // 记录合并：记录起始列为空 = 上一行数据的续行（单元格内换行），并进上一条记录
    const startsRecord = recordKey === undefined || (record[recordKey] ?? '') !== '';
    const previous = result[result.length - 1];
    if (!startsRecord && previous !== undefined) {
      for (const [key, value] of Object.entries(record)) {
        previous[key] = previous[key] === undefined ? value : `${previous[key]}${value}`;
      }
      continue;
    }
    result.push(record);
  }

  return { rows: result, headerFound, textItemCount };
}
