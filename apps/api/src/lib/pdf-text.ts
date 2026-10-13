import zlib from 'node:zlib';

/**
 * PDF 文本层抽取（零依赖实现，供「导入方案」支持表格型 PDF）。
 *
 * 为什么自己写：本机（离线环境）装不了 pdf-parse / pdfjs 之类的库，而需求只需要
 * 「把表格型 PDF（Excel 模板另存 / 打印出来的）里的文字连同坐标读出来」，
 * 用 Node 内置 zlib 解 FlateDecode + 解析内容流的文本操作符即可覆盖。
 *
 * 覆盖面与边界：
 *   - 支持：未加密 PDF、FlateDecode 内容流、对象流（ObjStm）里的页面/字体对象、
 *     Identity-H（CID 双字节）+ ToUnicode CMap 的中文嵌入字体、WinAnsi 单字节字体；
 *   - 不支持：扫描件 / 图片页（没有文字层）、加密 PDF、LZW / ASCII85 之外的怪异滤镜 —— 一律
 *     返回空结果，由上层给出「请用模板导出的表格 PDF」之类的明确提示；
 *   - 坐标为 PDF 用户空间（原点左下、y 向上），不做 CTM 变换（表格类 PDF 的 CTM 基本是单位矩阵）。
 */

/** 文本片段：一页里的一段文字及其起点坐标 */
export interface PdfTextItem {
  page: number;
  /** 文本矩阵的平移分量（用户空间 x） */
  x: number;
  /** 文本矩阵的平移分量（用户空间 y） */
  y: number;
  text: string;
}

/** 字体编码映射：字符码 → Unicode；codeByteLength = 1（简单字体）或 2（Identity-H） */
interface FontEncoding {
  map: Map<number, string>;
  codeByteLength: 1 | 2;
}

// ============================================================================
// 1. 对象扫描（不依赖 xref：直接按 "N G obj … endobj" 扫描，容错优先）
// ============================================================================

interface PdfObject {
  number: number;
  dict: string;
  stream: Buffer | null;
}

function scanObjects(buffer: Buffer): Map<number, PdfObject> {
  const latin = buffer.toString('latin1');
  const objects = new Map<number, PdfObject>();
  const objectStreams: PdfObject[] = [];
  const pattern = /(\d+)\s+(\d+)\s+obj\b/g;
  const starts: { number: number; dictStart: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(latin)) !== null) {
    starts.push({ number: Number(match[1]), dictStart: match.index + match[0].length });
  }
  for (const start of starts) {
    const endObj = latin.indexOf('endobj', start.dictStart);
    const limit = endObj === -1 ? latin.length : endObj;
    const streamKeyword = latin.indexOf('stream', start.dictStart);
    const hasStream = streamKeyword !== -1 && streamKeyword < limit;
    const dictEnd = hasStream ? streamKeyword : limit;
    const dict = latin.slice(start.dictStart, dictEnd);
    let stream: Buffer | null = null;
    if (hasStream) {
      let dataStart = streamKeyword + 'stream'.length;
      if (latin[dataStart] === '\r') dataStart += 1;
      if (latin[dataStart] === '\n') dataStart += 1;
      const endStream = latin.indexOf('endstream', dataStart);
      const dataEnd = endStream === -1 ? limit : endStream;
      stream = buffer.subarray(dataStart, dataEnd);
      // 去掉 endstream 前的换行
      while (
        stream.length > 0 &&
        (stream[stream.length - 1] === 0x0a || stream[stream.length - 1] === 0x0d)
      ) {
        stream = stream.subarray(0, stream.length - 1);
      }
    }
    const object: PdfObject = { number: start.number, dict, stream };
    objects.set(start.number, object);
    if (/\/Type\s*\/ObjStm\b/.test(dict)) objectStreams.push(object);
  }

  // 对象流（ObjStm）：页面 / 字体对象常被压在里面，解开后递归登记
  for (const container of objectStreams) {
    const decoded = decodeStream(container);
    if (decoded === null) continue;
    const count = Number(/\/N\s+(\d+)/.exec(container.dict)?.[1] ?? '0');
    const first = Number(/\/First\s+(\d+)/.exec(container.dict)?.[1] ?? '0');
    const head = decoded.subarray(0, first).toString('latin1');
    const numbers = head.trim().split(/\s+/).map((value) => Number(value));
    for (let index = 0; index < count; index += 1) {
      const objectNumber = numbers[index * 2];
      const offset = numbers[index * 2 + 1];
      if (objectNumber === undefined || offset === undefined) continue;
      const nextOffset = numbers[index * 2 + 3];
      const start = first + offset;
      const end = nextOffset === undefined ? decoded.length : first + nextOffset;
      const dict = decoded.subarray(start, end).toString('latin1').trim();
      if (!objects.has(objectNumber)) {
        objects.set(objectNumber, { number: objectNumber, dict, stream: null });
      }
    }
  }

  return objects;
}

/** 解压对象流：支持 FlateDecode（含预测器直读）；无滤镜时原样返回 */
function decodeStream(object: PdfObject): Buffer | null {
  if (object.stream === null) return null;
  if (/FlateDecode/.test(object.dict)) {
    try {
      return zlib.inflateSync(object.stream);
    } catch {
      try {
        return zlib.inflateRawSync(object.stream);
      } catch {
        return null;
      }
    }
  }
  if (/\/Filter/.test(object.dict)) return null; // 其它滤镜（LZW 等）不支持
  return object.stream;
}

/** 解析字典里的引用值：`/Key 12 0 R` → 12；内联字典/无值返回 null */
function referenceOf(dict: string, key: string): number | null {
  const match = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R\\b`).exec(dict);
  return match === null ? null : Number(match[1]);
}

function isType(object: PdfObject, type: string): boolean {
  return new RegExp(`/Type\\s*/${type}\\b`).test(object.dict);
}

/**
 * 取内联字典内容：`/Key << ... >>`，按 `<<`/`>>` 配对扫描。
 * 不能用非贪婪正则 —— 内联字典里还有嵌套字典（如 /Resources << /Font << ... >> >>），
 * 非贪婪会在第一个 `>>` 就截断，导致字体表读不到、中文全部退化成乱码。
 */
function extractInlineDict(text: string, key: string): string | null {
  const startMatch = new RegExp(`/${key}\\s*<<`).exec(text);
  if (startMatch === null) return null;
  let index = startMatch.index + startMatch[0].length;
  const start = index;
  let depth = 1;
  while (index < text.length) {
    if (text.startsWith('<<', index)) {
      depth += 1;
      index += 2;
      continue;
    }
    if (text.startsWith('>>', index)) {
      depth -= 1;
      index += 2;
      if (depth === 0) return text.slice(start, index - 2);
      continue;
    }
    index += 1;
  }
  return null;
}

// ============================================================================
// 2. ToUnicode CMap 解析（字符码 → Unicode）
// ============================================================================

function hexToUnicode(hex: string): string {
  let out = '';
  for (let index = 0; index + 4 <= hex.length; index += 4) {
    out += String.fromCharCode(parseInt(hex.slice(index, index + 4), 16));
  }
  if (hex.length % 4 !== 0) {
    out += String.fromCharCode(parseInt(hex.slice(0, hex.length % 4) + '0', 16));
  }
  return out;
}

function parseCMap(text: string): FontEncoding {
  const map = new Map<number, string>();
  let codeByteLength: 1 | 2 = 2;

  const bfcharPattern = /beginbfchar([\s\S]*?)endbfchar/g;
  let block: RegExpExecArray | null;
  while ((block = bfcharPattern.exec(text)) !== null) {
    const pairPattern = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let pair: RegExpExecArray | null;
    while ((pair = pairPattern.exec(block[1]!)) !== null) {
      const src = pair[1]!;
      map.set(parseInt(src, 16), hexToUnicode(pair[2]!));
      if (src.length <= 2) codeByteLength = 1;
    }
  }

  const bfrangePattern = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((block = bfrangePattern.exec(text)) !== null) {
    const body = block[1]!;
    const rangePattern = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g;
    let range: RegExpExecArray | null;
    while ((range = rangePattern.exec(body)) !== null) {
      const low = parseInt(range[1]!, 16);
      const high = parseInt(range[2]!, 16);
      if (range[3] !== undefined) {
        const base = parseInt(range[3], 16);
        for (let code = low; code <= high && code - low < 65535; code += 1) {
          map.set(code, String.fromCharCode(base + (code - low)));
        }
      } else if (range[4] !== undefined) {
        const items = range[4].match(/<([0-9A-Fa-f]+)>/g) ?? [];
        items.forEach((hex, index) => {
          const code = low + index;
          if (code <= high) map.set(code, hexToUnicode(hex.slice(1, -1)));
        });
      }
      if (range[1]!.length <= 2) codeByteLength = 1;
    }
  }

  return { map, codeByteLength };
}

// ============================================================================
// 3. 内容流解析（文本操作符 + 坐标）
// ============================================================================

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: Buffer }
  | { kind: 'name'; value: string }
  | { kind: 'array'; items: Token[] }
  | { kind: 'operator'; value: string };

function tokenize(content: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const length = content.length;

  const skipWhitespace = (): void => {
    while (index < length) {
      const char = content[index]!;
      if (char === '%') {
        while (index < length && content[index] !== '\n') index += 1;
        continue;
      }
      if (/\s/.test(char)) {
        index += 1;
        continue;
      }
      break;
    }
  };

  const readLiteralString = (): Buffer => {
    index += 1; // 跳过 (
    const bytes: number[] = [];
    let depth = 1;
    while (index < length) {
      const char = content[index]!;
      if (char === '\\') {
        const next = content[index + 1]!;
        const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
        if (next in escapes) {
          bytes.push(escapes[next]!.charCodeAt(0));
          index += 2;
        } else if (next >= '0' && next <= '7') {
          const octal = content.slice(index + 1, index + 4).match(/^[0-7]{1,3}/)![0];
          bytes.push(parseInt(octal, 8));
          index += 1 + octal.length;
        } else {
          bytes.push(next.charCodeAt(0) & 0xff);
          index += 2;
        }
        continue;
      }
      if (char === '(') depth += 1;
      if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          index += 1;
          break;
        }
      }
      bytes.push(char.charCodeAt(0) & 0xff);
      index += 1;
    }
    return Buffer.from(bytes);
  };

  const readHexString = (): Buffer => {
    index += 1;
    let hex = '';
    while (index < length && content[index] !== '>') {
      const char = content[index]!;
      if (/[0-9A-Fa-f]/.test(char)) hex += char;
      index += 1;
    }
    index += 1;
    if (hex.length % 2 !== 0) hex += '0';
    return Buffer.from(hex, 'hex');
  };

  while (index < length) {
    skipWhitespace();
    if (index >= length) break;
    const char = content[index]!;

    if (char === '(') {
      tokens.push({ kind: 'string', value: readLiteralString() });
      continue;
    }
    if (char === '<') {
      if (content[index + 1] === '<') {
        // 内联字典：整体跳过（文本抽取不需要字典内容）
        let depth = 0;
        while (index < length) {
          if (content[index] === '<' && content[index + 1] === '<') {
            depth += 1;
            index += 2;
            continue;
          }
          if (content[index] === '>' && content[index + 1] === '>') {
            depth -= 1;
            index += 2;
            if (depth === 0) break;
            continue;
          }
          index += 1;
        }
        continue;
      }
      tokens.push({ kind: 'string', value: readHexString() });
      continue;
    }
    if (char === '/') {
      index += 1;
      let name = '';
      while (index < length && !/[\s()[\]<>/]/.test(content[index]!)) {
        name += content[index];
        index += 1;
      }
      tokens.push({ kind: 'name', value: name });
      continue;
    }
    if (/[+\-.0-9]/.test(char)) {
      let numberText = '';
      while (index < length && /[+\-.0-9eE]/.test(content[index]!)) {
        numberText += content[index];
        index += 1;
      }
      const value = Number(numberText);
      if (!Number.isNaN(value)) {
        tokens.push({ kind: 'number', value });
        continue;
      }
      // 数字解析失败（畸形内容）时按操作符吞掉
      continue;
    }
    if (char === '[') {
      index += 1;
      const items: Token[] = [];
      let depth = 1;
      while (index < length && depth > 0) {
        const inner = content[index]!;
        if (inner === '[') {
          depth += 1;
          index += 1;
          continue;
        }
        if (inner === ']') {
          depth -= 1;
          index += 1;
          continue;
        }
        const before = index;
        tokens.push({ kind: 'operator', value: '' }); // 占位，随后替换
        tokens.pop();
        if (inner === '(') {
          const value = readLiteralString();
          items.push({ kind: 'string', value });
          continue;
        }
        if (inner === '<') {
          const value = readHexString();
          items.push({ kind: 'string', value });
          continue;
        }
        if (/[+\-.0-9]/.test(inner)) {
          let numberText = '';
          while (index < length && /[+\-.0-9]/.test(content[index]!)) {
            numberText += content[index];
            index += 1;
          }
          const value = Number(numberText);
          if (!Number.isNaN(value)) items.push({ kind: 'number', value });
          continue;
        }
        index += 1;
        if (index === before) break;
      }
      tokens.push({ kind: 'array', items });
      continue;
    }
    // 操作符
    let operator = '';
    while (index < length && !/[\s()[\]<>/]/.test(content[index]!)) {
      operator += content[index];
      index += 1;
    }
    if (operator !== '') tokens.push({ kind: 'operator', value: operator });
  }

  return tokens;
}

/** 按字体编码把 PDF 字符串解码成文本 */
function decodeText(bytes: Buffer, encoding: FontEncoding | undefined): string {
  if (encoding === undefined) {
    // 无 ToUnicode：按单字节 Latin-1 近似（英文表格可用；中文会乱码，由上层判空兜底）
    return bytes.toString('latin1');
  }
  let out = '';
  if (encoding.codeByteLength === 2) {
    for (let index = 0; index + 1 < bytes.length; index += 2) {
      const code = (bytes[index]! << 8) | bytes[index + 1]!;
      out += encoding.map.get(code) ?? '';
    }
  } else {
    for (const byte of bytes) {
      out += encoding.map.get(byte) ?? '';
    }
  }
  return out;
}

/** 解析单个内容流 → 文本片段（带坐标） */
function parseContent(content: string, fontEncodings: Map<string, FontEncoding>, page: number): PdfTextItem[] {
  const tokens = tokenize(content);
  const items: PdfTextItem[] = [];
  const operands: Token[] = [];
  // 文本矩阵语义（PDF 规范 §9.4.2）：Tlm 是行矩阵（Td/TD/T* 相对它移动），Tm 是当前文本矩阵。
  // 关键：Td 的位移是相对**行起点**的绝对量，绝不能累加到当前位置 —— 否则逐字定位的
  // PDF（Chrome / Excel 打印常见）坐标会一路漂移，行内文字错序、单元格串行。
  let lineX = 0;
  let lineY = 0;
  let textX = 0;
  let textY = 0;
  let leading = 0;
  let currentEncoding: FontEncoding | undefined;

  const emit = (text: string): void => {
    if (text.trim() === '') return;
    items.push({ page, x: textX, y: textY, text });
  };

  for (const token of tokens) {
    if (token.kind !== 'operator') {
      operands.push(token);
      continue;
    }
    const op = token.value;
    const num = (offset: number): number => {
      const target = operands[operands.length - offset];
      return target !== undefined && target.kind === 'number' ? target.value : 0;
    };
    switch (op) {
      case 'BT':
        lineX = 0;
        lineY = 0;
        textX = 0;
        textY = 0;
        break;
      case 'ET':
        break;
      case 'Tf': {
        const nameToken = operands[operands.length - 2];
        if (nameToken !== undefined && nameToken.kind === 'name') {
          currentEncoding = fontEncodings.get(nameToken.value);
        }
        break;
      }
      case 'Td':
        // 相对行起点偏移（不是相对当前位置）
        lineX += num(2);
        lineY += num(1);
        textX = lineX;
        textY = lineY;
        break;
      case 'TD':
        lineX += num(2);
        lineY += num(1);
        textX = lineX;
        textY = lineY;
        leading = -num(1);
        break;
      case 'Tm':
        lineX = num(2);
        lineY = num(1);
        textX = lineX;
        textY = lineY;
        break;
      case 'TL':
        leading = num(1);
        break;
      case 'T*':
        lineY -= leading; // T* 等价于 Td(0, -TL)
        textX = lineX;
        textY = lineY;
        break;
      case 'Tj': {
        const value = operands[operands.length - 1];
        if (value !== undefined && value.kind === 'string') emit(decodeText(value.value, currentEncoding));
        break;
      }
      case 'TJ': {
        const value = operands[operands.length - 1];
        if (value !== undefined && value.kind === 'array') {
          let text = '';
          for (const part of value.items) {
            if (part.kind === 'string') text += decodeText(part.value, currentEncoding);
          }
          emit(text);
        }
        break;
      }
      case "'":
      case '"': {
        lineY -= leading; // ' 等价于 T* + Tj
        textX = lineX;
        textY = lineY;
        const value = operands[operands.length - 1];
        if (value !== undefined && value.kind === 'string') emit(decodeText(value.value, currentEncoding));
        break;
      }
      default:
        break;
    }
    operands.length = 0;
  }

  return items;
}

// ============================================================================
// 4. 对外入口：PDF → 文本片段
// ============================================================================

export function extractPdfTextItems(buffer: Buffer): PdfTextItem[] {
  const objects = scanObjects(buffer);

  // 页面顺序：按 /Type /Pages 的 /Kids；找不到就按对象号收集 /Type /Page
  const pages: number[] = [];
  for (const object of objects.values()) {
    if (!isType(object, 'Pages')) continue;
    const kidsMatch = /\/Kids\s*\[([^\]]*)\]/.exec(object.dict);
    if (kidsMatch === null) continue;
    for (const reference of kidsMatch[1]!.matchAll(/(\d+)\s+\d+\s+R/g)) {
      const number = Number(reference[1]);
      if (!pages.includes(number)) pages.push(number);
    }
  }
  if (pages.length === 0) {
    for (const object of objects.values()) {
      if (isType(object, 'Page')) pages.push(object.number);
    }
    pages.sort((a, b) => a - b);
  }

  const items: PdfTextItem[] = [];
  pages.forEach((pageNumber, pageIndex) => {
    const page = objects.get(pageNumber);
    if (page === undefined) return;

    // 字体表：page 的 /Resources 优先，其次父 /Pages 的 /Resources
    const fontEncodings = new Map<string, FontEncoding>();
    const resourceOwners: PdfObject[] = [page];
    for (const object of objects.values()) {
      if (isType(object, 'Pages') && /\/Resources\b/.test(object.dict)) resourceOwners.push(object);
    }
    for (const owner of resourceOwners) {
      let resourceDict: string | null = extractInlineDict(owner.dict, 'Resources');
      if (resourceDict === null) {
        const reference = referenceOf(owner.dict, 'Resources');
        if (reference !== null) resourceDict = objects.get(reference)?.dict ?? null;
      }
      if (resourceDict === null) continue;
      let fontDict = extractInlineDict(resourceDict, 'Font');
      if (fontDict === null) {
        const fontRef = referenceOf(resourceDict, 'Font');
        if (fontRef !== null) fontDict = objects.get(fontRef)?.dict ?? null;
      }
      if (fontDict === null) continue;
      for (const entry of fontDict.matchAll(/\/([^\s/]+)\s+(\d+)\s+\d+\s+R/g)) {
        const fontName = entry[1]!;
        const fontObject = objects.get(Number(entry[2]));
        if (fontObject === undefined || fontEncodings.has(fontName)) continue;
        const toUnicodeRef = referenceOf(fontObject.dict, 'ToUnicode');
        if (toUnicodeRef === null) continue;
        const cmapObject = objects.get(toUnicodeRef);
        const cmapStream = cmapObject === undefined ? null : decodeStream(cmapObject);
        if (cmapStream === null) continue;
        fontEncodings.set(fontName, parseCMap(cmapStream.toString('latin1')));
      }
    }

    // 内容流
    const contents: string[] = [];
    const inlineContents = /\/Contents\s*\[([^\]]*)\]/.exec(page.dict);
    const contentRefs: number[] = [];
    if (inlineContents !== null) {
      for (const reference of inlineContents[1]!.matchAll(/(\d+)\s+\d+\s+R/g)) {
        contentRefs.push(Number(reference[1]));
      }
    } else {
      const single = referenceOf(page.dict, 'Contents');
      if (single !== null) contentRefs.push(single);
    }
    for (const contentRef of contentRefs) {
      const contentObject = objects.get(contentRef);
      const decoded = contentObject === undefined ? null : decodeStream(contentObject);
      if (decoded !== null) contents.push(decoded.toString('latin1'));
    }
    if (contents.length === 0) return;

    items.push(...parseContent(contents.join('\n'), fontEncodings, pageIndex));
  });

  return items;
}
