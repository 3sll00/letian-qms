/**
 * 只读回看口径校验（TBD-04 / TBD-05 / TBD-06 回归守门）
 *
 * 口径唯一真相：docs/17-检验录入界面说明与质检方案匹配口径.md §7.3「快照即证据」/ §7.8
 *
 * 为什么需要它：只读回看（历史工单）必须用**本单方案快照**的判定基准与**工单落库的**单项判定；
 * 一旦有人把回看改回"按物料匹配当前生效方案"或"前端按当前标准重算判定"，类型检查与契约校验
 * 都发现不了（数据结构完全合法，只是结论错了）。这里用 mock 工单把这条口径钉死。
 *
 * 关键样本（真实存在的坑）：mock 工单 INS-20231012-0001 的 DIA-001 标准语是 `Φ5.00±0.02mm`，
 * 但快照里 lowerTolerance 写成了 **-0.02**（负数）。若回看按公差重算，实测 5.01 会落到
 * [5.02, 5.02] 被判 FAILED；而工单落库判定是 PASSED。回看必须显示 PASSED。
 *
 * 运行：pnpm --filter @letian/web verify:snapshot
 * 通过 Vite SSR 加载器跑**真实前端源码**（走与构建完全相同的 @letian/* 别名解析）。
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
    judgeIndicatorRow,
    orderItemsToIndicatorRows,
    qualitativeOptionsOf,
    splitIndicatorRows,
    summarizeJudgements,
    toPlanIndicatorRow,
    DECISION_LABEL,
    isPeriodEffective,
    planPeriodHint,
    planPeriodLabel,
    todayLocalDate,
  } = await server.ssrLoadModule('/src/lib/planMatch.ts');
  const { mockInspectionOrders } = await server.ssrLoadModule('/src/mocks/data.ts');
  const { evaluateInspectionItem } = await server.ssrLoadModule('@letian/domain');

  console.log('TBD-04 只读回看：工单快照 → 指标行');
  for (const order of mockInspectionOrders) {
    const items = order.items ?? [];
    const rows = orderItemsToIndicatorRows(order);
    check(`[${order.orderNo}] 行数 = 工单实测项数 (${rows.length}/${items.length})`, rows.length === items.length);

    const decisions = rows.map(judgeIndicatorRow);
    check(
      `[${order.orderNo}] 每行判定 = 工单落库判定 [${decisions.map((d) => DECISION_LABEL[d]).join(',')}]`,
      decisions.every((decision, index) => decision === items[index].result)
    );

    const grouped = splitIndicatorRows(rows);
    const groupedTotal = grouped.CHEMICAL.length + grouped.MECHANICAL.length + grouped.DIMENSIONAL.length;
    check(`[${order.orderNo}] 三个分区不丢行 (${groupedTotal} = ${rows.length})`, groupedTotal === rows.length);

    const expectedPrefilled = items.filter(
      (item) => item.measuredVal !== undefined || (item.measuredText ?? '') !== ''
    ).length;
    const prefilled = rows.filter((row) => row.actual !== '').length;
    check(`[${order.orderNo}] 回看实测值按工单落库值预填 ${prefilled}/${rows.length}`, prefilled === expectedPrefilled);

    const summary = summarizeJudgements(decisions);
    console.log(
      `        汇总：总 ${summary.total} / 合格 ${summary.passed} / 不合格 ${summary.failed} / 待判定 ${summary.pending} / 免检 ${summary.exempt}`
    );
  }

  console.log('\nTBD-04 回归点：负公差样本不得被前端按当前标准重算');
  const probe = mockInspectionOrders.find((order) => order.orderNo === 'INS-20231012-0001');
  check('找到样本工单 INS-20231012-0001', probe !== undefined);
  if (probe !== undefined) {
    const dia = orderItemsToIndicatorRows(probe).find((row) => row.itemCode === 'DIA-001');
    check('找到 DIA-001 行', dia !== undefined);
    if (dia !== undefined) {
      console.log(
        `        行内容：standard=${dia.standard} actual=${dia.actual} -> ${DECISION_LABEL[judgeIndicatorRow(dia)]}`
      );
      check('DIA-001 回看判定 = PASSED（采用工单落库判定，未按 -0.02 公差重算）', judgeIndicatorRow(dia) === 'PASSED');
    }
  }

  console.log('\nTBD-05 定性项候选值（分隔符必须与领域层一致）');
  const standardText = '无裂纹,OK，无肉眼可见裂纹/合格';
  const options = qualitativeOptionsOf(standardText);
  check('半角逗号 / 全角逗号 / 斜杠都能拆出候选值', options.length === 4, JSON.stringify(options));
  check('候选值去空白且保序', options[0] === '无裂纹' && options[3] === '合格', JSON.stringify(options));
  check('单一标准语 -> 只有一个候选值（页面据此提示"自由描述会被判不合格"）', qualitativeOptionsOf('无裂纹').length === 1);
  check('空标准语 -> 无候选值', qualitativeOptionsOf('   ').length === 0);
  check(
    '界面给出的候选值确实能被领域层判为 PASSED（候选值不是假的）',
    options.every(
      (value) =>
        evaluateInspectionItem({
          dataType: 'QUALITATIVE',
          measuredText: value,
          standardText,
          isExempt: false,
        }) === 'PASSED'
    )
  );
  check(
    '自由描述仍判 FAILED（TBD-05 只改善录入体验，不放宽判定口径）',
    evaluateInspectionItem({
      dataType: 'QUALITATIVE',
      measuredText: '表面无肉眼可见裂纹',
      standardText: '无裂纹',
      isExempt: false,
    }) === 'FAILED'
  );

  console.log('\nTBD-06 可接受值清单：结构化清单优先于标准语文本约定');
  // 标准语只写一个值，清单多给一个 —— 判定与候选值都必须只认清单
  const qualifiedItem = {
    seq: 1,
    itemCode: 'TBD06-APP-001',
    name: '表面裂纹',
    dataType: 'QUALITATIVE',
    metricCategory: 'APPEARANCE',
    standardText: '无裂纹',
    acceptableValues: ['无裂纹', '无肉眼可见裂纹'],
    unit: '外观',
    isMandatory: true,
  };
  const listOnlyRow = { ...toPlanIndicatorRow(qualifiedItem), actual: '无肉眼可见裂纹' };
  const offListRow = { ...toPlanIndicatorRow(qualifiedItem), actual: '表面无肉眼可见裂纹' };

  check('清单里明写的取值（标准语里没有它）判 PASSED', judgeIndicatorRow(listOnlyRow) === 'PASSED');
  check('清单之外的自由描述仍判 FAILED（清单不是放行后门）', judgeIndicatorRow(offListRow) === 'FAILED');
  check(
    '有清单时候选值全部来自清单',
    qualitativeOptionsOf('无裂纹', ['无裂纹', '无肉眼可见裂纹']).join('|') === '无裂纹|无肉眼可见裂纹'
  );
  check('清单为空 -> 回落标准语拆分（历史方案行为不变）', qualitativeOptionsOf('合格,OK', []).join('|') === '合格|OK');
  check(
    '清单只有空白项 -> 同样回落标准语',
    qualitativeOptionsOf('合格,OK', ['', '   ']).join('|') === '合格|OK'
  );
  check(
    '界面给出的候选值恰好等于领域层认可的值（前后端同口径）',
    qualitativeOptionsOf('无裂纹', qualifiedItem.acceptableValues).every(
      (value) =>
        evaluateInspectionItem({
          dataType: 'QUALITATIVE',
          measuredText: value,
          standardText: qualifiedItem.standardText,
          acceptableValues: qualifiedItem.acceptableValues,
          isExempt: false,
        }) === 'PASSED'
    )
  );

  console.log('TBD-08 方案版本生效周期：未生效 / 已过期提示与后端过滤同口径');
  const today = todayLocalDate();
  check('todayLocalDate 输出定长 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(today), today);
  check(
    '未配置周期 = 即刻生效、长期有效（不提示）',
    isPeriodEffective(undefined) && planPeriodHint(undefined) === ''
  );
  check('起始日在未来 -> 未生效', planPeriodHint({ effectiveStartDate: '2099-01-01' }) === '未生效');
  check('截止日已过 -> 已过期', planPeriodHint({ effectiveEndDate: '2000-01-01' }) === '已过期');
  check(
    '周期覆盖今天 -> 不提示',
    planPeriodHint({ effectiveStartDate: '2000-01-01', effectiveEndDate: '2099-12-31' }) === ''
  );
  check('只填截止日且未过 -> 不提示', planPeriodHint({ effectiveEndDate: '2099-12-31' }) === '');
  check(
    '起止都填反时优先提示未生效（该版本永远不会参与匹配）',
    planPeriodHint({ effectiveStartDate: '2099-01-01', effectiveEndDate: '2000-01-01' }) === '未生效'
  );
  check(
    '周期文案：两侧都填',
    planPeriodLabel({ effectiveStartDate: '2026-09-21', effectiveEndDate: '2099-12-31' }) ===
      '2026-09-21 ~ 2099-12-31'
  );
  check(
    '周期文案：只填起始日 -> 长期有效',
    planPeriodLabel({ effectiveStartDate: '2026-09-21' }) === '2026-09-21 ~ 长期有效'
  );
  check(
    '周期文案：只填截止日 -> 起始不限',
    planPeriodLabel({ effectiveEndDate: '2099-12-31' }) === '不限 ~ 2099-12-31'
  );
  check('周期文案：两侧都空 -> -', planPeriodLabel({}) === '-');
} finally {
  await server.close();
}

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
