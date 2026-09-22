/**
 * 质量追溯看板展示口径校验（回归守门）
 *
 * 口径唯一真相：docs/24-质量追溯看板界面评审与改造建议.md
 *   §8 验收口径 1（缺值一律 —，不得用空串 / 占位串）
 *   §8 验收口径 5（耗时列只允许时长或 —）
 *   §6 缺陷 D2（概览状态必须由节点状态派生，存在未完结节点就不得声称"全部合格"）
 *   §6 缺陷 D8（耗时列不得混入「委外」「进行中」这类状态值）
 *   §3.4 / §4 R4（图例必须覆盖契约状态枚举的全部取值）
 *
 * 为什么需要它：这三条都属于"数据结构完全合法、只是结论错了"的口径问题，
 * 类型检查与契约校验都拦不住。一旦被改回"看起来也行"的写法，只能靠现场评审发现。
 *
 * 运行：pnpm --filter @letian/web verify:trace-format
 * 通过 Vite SSR 加载器跑**真实前端源码**（与构建完全相同的 @letian/* 别名解析）。
 */
import { createServer } from 'vite';

const server = await createServer({
  configFile: 'vite.config.ts',
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});

let failed = 0;
function check(label, condition, extra) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failed += 1;
  console.log(`  ✗ ${label}${extra === undefined ? '' : ` -> ${extra}`}`);
}

try {
  const {
    display,
    formatDuration,
    formatTime,
    summarizeGraphStatus,
    NODE_STATUS_LABEL,
    STATUS_TONE,
    TRACE_STATUS_LEGEND,
  } = await server.ssrLoadModule('/src/lib/traceNodeFormat.ts');
  const { TraceNodeStatusEnum } = await server.ssrLoadModule('@letian/contracts');

  console.log('§8-1 缺值一律显示 —（不得填空串 / 占位串）');
  check('undefined / null / 空串 一律 → —', display(undefined) === '—' && display(null) === '—' && display('') === '—');
  check("合法值原样输出（'0' 是有效值，不得被当成空）", display('0') === '0' && display('ABC') === 'ABC');

  console.log('\n§8-5 / D8 耗时列只允许时长或 —');
  check('未终检（undefined）→ —', formatDuration(undefined) === '—');
  check('NaN → —', formatDuration(Number.NaN) === '—');
  check('负值 → —（负数时长是数据错误，不得展示）', formatDuration(-5) === '—');
  check('0 → 0m', formatDuration(0) === '0m');
  check('30 → 30m', formatDuration(30) === '30m');
  check('59 → 59m（不足 1 小时不进位）', formatDuration(59) === '59m');
  check('60 → 1h', formatDuration(60) === '1h');
  check('120 → 2h', formatDuration(120) === '2h');
  check('150 → 2h30m', formatDuration(150) === '2h30m');
  check(
    '输出只可能是 数字h/数字m 或 —，绝无状态词',
    [undefined, -1, 0, 30, 60, 150].every((value) => /^(—|\d+h)?(\d+m)?$/.test(formatDuration(value))),
    [undefined, -1, 0, 30, 60, 150].map((value) => formatDuration(value)).join(' | ')
  );

  console.log('\n时间显示：定长 YYYY-MM-DD HH:mm，缺值 —');
  check('undefined / 空串 → —', formatTime(undefined) === '—' && formatTime('') === '—');
  check(
    '本地时间字符串 → YYYY-MM-DD HH:mm（不随机器时区漂移）',
    formatTime('2023-10-12T11:05:00') === '2023-10-12 11:05',
    formatTime('2023-10-12T11:05:00')
  );
  check('无法解析的字符串原样返回（不吞掉后端已格式化文本）', formatTime('2023-10-12 11:05') === '2023-10-12 11:05');

  console.log('\n§6-D2 概览状态由节点状态派生');
  const node = (nodeStatus) => ({ nodeStatus });
  check('空图 → 暂无节点', summarizeGraphStatus([]).label === '暂无节点');
  check(
    '已合格 + 已入库 → 全部合格（已入库是终态，不算未完结）',
    summarizeGraphStatus([node('PASSED'), node('STORED')]).label === '全部合格'
  );
  const withInspecting = summarizeGraphStatus([node('PASSED'), node('INSPECTING')]);
  check(
    '有「检验中」时**绝不**显示全部合格（D2 的原始缺陷）',
    withInspecting.label !== '全部合格' && withInspecting.label === '1 个节点未完结',
    withInspecting.label
  );
  check(
    '检验中 + 待检验 一起计数',
    summarizeGraphStatus([node('INSPECTING'), node('PENDING')]).label === '2 个节点未完结'
  );
  check('有待检验时也不显示全部合格', summarizeGraphStatus([node('PENDING')]).label === '1 个节点未完结');
  check('存在不合格 → 存在不合格节点', summarizeGraphStatus([node('FAILED')]).label === '存在不合格节点');
  check('存在特采 → 存在特采节点', summarizeGraphStatus([node('CONCESSION')]).label === '存在特采节点');
  check(
    '不合格压过特采（红色优先，避免"夹一张特采单就看起来还行"）',
    summarizeGraphStatus([node('CONCESSION'), node('FAILED')]).label === '存在不合格节点'
  );
  check(
    '颜色随结论走：不合格用红、特采用琥珀',
    summarizeGraphStatus([node('FAILED')]).tone === STATUS_TONE.FAILED.badge &&
      summarizeGraphStatus([node('CONCESSION')]).tone === STATUS_TONE.CONCESSION.badge
  );

  console.log('\n§3.4 / §4-R4 状态词表必须覆盖契约枚举全部取值');
  const contractStatuses = [...TraceNodeStatusEnum.options].sort();
  const legendStatuses = TRACE_STATUS_LEGEND.map((item) => item.status).sort();
  check(
    `图例覆盖枚举全部 ${contractStatuses.length} 个取值`,
    legendStatuses.join(',') === contractStatuses.join(','),
    `图例=${legendStatuses.join(',')} 契约=${contractStatuses.join(',')}`
  );
  check(
    '图例不重复（同一状态出现两次说明有人手工追加过）',
    new Set(legendStatuses).size === legendStatuses.length
  );
  check(
    '配色表覆盖枚举全部取值（缺项会让节点回退成灰色兜底）',
    [...TraceNodeStatusEnum.options].every((status) => STATUS_TONE[status] !== undefined)
  );
  check(
    '中文名覆盖枚举全部取值且非空',
    [...TraceNodeStatusEnum.options].every(
      (status) => typeof NODE_STATUS_LABEL[status] === 'string' && NODE_STATUS_LABEL[status] !== ''
    )
  );
  check(
    '「已入库」与「已合格」视觉可区分（两者配色不得相同）',
    STATUS_TONE.STORED.badge !== STATUS_TONE.PASSED.badge && STATUS_TONE.STORED.dot !== STATUS_TONE.PASSED.dot
  );
  check(
    '特采不得被当成合格（配色与中文名都不得等于 PASSED）',
    STATUS_TONE.CONCESSION.badge !== STATUS_TONE.PASSED.badge &&
      NODE_STATUS_LABEL.CONCESSION !== NODE_STATUS_LABEL.PASSED
  );
} finally {
  await server.close();
}

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);