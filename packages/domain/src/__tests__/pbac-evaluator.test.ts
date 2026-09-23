import { PBACEvaluator } from '../services/pbac-evaluator';
import { MaterialPermission } from '@letian/contracts';

/**
 * PBAC 三维行级数据权限回归基线。
 * 语义（锁定项）：
 * 1. fail-closed —— permissions 为空（或 nullish）、policy.isActive=false 一律拒绝；
 * 2. 单条 policy 内三维度（物料分类 / 物料编码 / 供应商）为 AND，任一不满足即该 policy 不匹配；
 *    空数组或包含 '*' 的维度视为通配放行；
 * 3. 供应商维度 fail-closed —— policy.supplierCodes 限定具体供应商（非空且无 '*'）时，
 *    目标缺少供应商上下文（undefined 或空白串）该 policy 不匹配（拒绝），
 *    supplierCodes 为空或含 '*' 则通配放行；
 * 4. policy 之间为 OR —— 任一启用 policy 匹配即通过。
 */

function makePermission(overrides: Partial<MaterialPermission> = {}): MaterialPermission {
  return {
    id: 'p1a8e100-0000-0000-0000-000000000001',
    userId: 'u1a8e100-0000-0000-0000-000000000001',
    userName: '张检验',
    roleCode: 'IQC_INSPECTOR',
    materialCategories: [],
    materialCodes: [],
    supplierCodes: [],
    isActive: true,
    ...overrides,
  };
}

interface Target {
  targetCategory: string;
  targetMaterialCode: string;
  targetSupplierCode?: string;
}

const FASTENER_M1_SUPA: Target = {
  targetCategory: 'FASTENER',
  targetMaterialCode: 'M-001',
  targetSupplierCode: 'SUP-A',
};

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

/** 期望抛 PBAC_ACCESS_DENIED；未抛视为失败 */
function assertAccessDenied(fn: () => void, label: string): Error {
  try {
    fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/PBAC_ACCESS_DENIED/.test(msg)) {
      throw new Error(`${label}: 抛出的错误码不符，期望 [PBAC_ACCESS_DENIED]，实际消息: ${msg}`);
    }
    return e as Error;
  }
  throw new Error(`${label}: 期望抛 PBAC_ACCESS_DENIED，但实际未抛出`);
}

export function runPBACEvaluatorTests(): { total: number; passed: number } {
  let passed = 0;
  let total = 0;

  function test(name: string, fn: () => void): void {
    total++;
    try {
      fn();
      passed++;
    } catch (e) {
      console.error(`❌ [PBAC Test Failed]: ${name}`, e);
      throw e;
    }
  }

  // ===================== 1. fail-closed 基线 =====================

  test('permissions 为空数组一律拒绝（fail-closed）', () => {
    assert(!PBACEvaluator.hasPermission({ permissions: [], ...FASTENER_M1_SUPA }), '空权限必须拒绝');
  });

  test('permissions 为 nullish 一律拒绝（fail-closed）', () => {
    assert(
      !PBACEvaluator.hasPermission({
        permissions: undefined as unknown as readonly MaterialPermission[],
        ...FASTENER_M1_SUPA,
      }),
      'undefined 权限必须拒绝'
    );
  });

  test('isActive=false 的策略一律拒绝，即使三维完全匹配', () => {
    const inactive = makePermission({
      isActive: false,
      materialCategories: ['FASTENER'],
      materialCodes: ['M-001'],
      supplierCodes: ['SUP-A'],
    });
    assert(!PBACEvaluator.hasPermission({ permissions: [inactive], ...FASTENER_M1_SUPA }), '停用策略必须拒绝');
  });

  // ===================== 2. 单 policy 三维度 AND 语义 =====================

  const FULL_MATCH_POLICY = makePermission({
    materialCategories: ['FASTENER', 'RAW_MATERIAL'],
    materialCodes: ['M-001', 'M-002'],
    supplierCodes: ['SUP-A', 'SUP-B'],
  });

  test('三维度均匹配时放行', () => {
    assert(PBACEvaluator.hasPermission({ permissions: [FULL_MATCH_POLICY], ...FASTENER_M1_SUPA }), '三维匹配应放行');
  });

  test('物料分类维度不匹配即拒绝（AND 语义）', () => {
    assert(
      !PBACEvaluator.hasPermission({
        permissions: [FULL_MATCH_POLICY],
        targetCategory: 'CHEMICAL', // 不在 ['FASTENER','RAW_MATERIAL']
        targetMaterialCode: 'M-001',
        targetSupplierCode: 'SUP-A',
      }),
      '分类不匹配必须拒绝'
    );
  });

  test('物料编码维度不匹配即拒绝（AND 语义）', () => {
    assert(
      !PBACEvaluator.hasPermission({
        permissions: [FULL_MATCH_POLICY],
        targetCategory: 'FASTENER',
        targetMaterialCode: 'M-999', // 不在白名单
        targetSupplierCode: 'SUP-A',
      }),
      '编码不匹配必须拒绝'
    );
  });

  test('供应商维度不匹配即拒绝（AND 语义）', () => {
    assert(
      !PBACEvaluator.hasPermission({
        permissions: [FULL_MATCH_POLICY],
        targetCategory: 'FASTENER',
        targetMaterialCode: 'M-001',
        targetSupplierCode: 'SUP-FORBIDDEN',
      }),
      '供应商不匹配必须拒绝'
    );
  });

  // ===================== 3. 维度通配（空数组或含 '*'） =====================

  test('三维度均空数组 = 全通配放行', () => {
    const wildcard = makePermission({}); // 三个维度均为 []
    assert(PBACEvaluator.hasPermission({ permissions: [wildcard], ...FASTENER_M1_SUPA }), '空维度应通配放行');
  });

  test("维度含 '*' 即该维度通配放行", () => {
    const star = makePermission({ materialCategories: ['*'], materialCodes: ['*'], supplierCodes: ['*'] });
    assert(
      PBACEvaluator.hasPermission({
        permissions: [star],
        targetCategory: 'ANYTHING',
        targetMaterialCode: 'X-999',
        targetSupplierCode: 'SUP-UNKNOWN',
      }),
      '* 通配应放行任意目标'
    );
  });

  test("混合通配: supplierCodes 含 '*' 时其余维度仍须匹配（'*' 与其他值并列同样通配）", () => {
    const mixed = makePermission({
      materialCategories: ['FASTENER'],
      materialCodes: ['M-001'],
      supplierCodes: ['SUP-A', '*'],
    });
    assert(
      PBACEvaluator.hasPermission({
        permissions: [mixed],
        targetCategory: 'FASTENER',
        targetMaterialCode: 'M-001',
        targetSupplierCode: 'SUP-WHATEVER',
      }),
      "供应商维度含 '*' 应通配"
    );
    assert(
      !PBACEvaluator.hasPermission({
        permissions: [mixed],
        targetCategory: 'FASTENER',
        targetMaterialCode: 'M-WRONG', // 编码维度仍严格执行 AND
        targetSupplierCode: 'SUP-WHATEVER',
      }),
      "其余维度不匹配仍须拒绝"
    );
  });

  // ===================== 4. 供应商维度 fail-closed（本次语义变更核心） =====================

  const SUPPLIER_SCOPED_POLICY = makePermission({
    materialCategories: ['FASTENER'],
    materialCodes: ['M-001'],
    supplierCodes: ['SUP-A'], // 限定具体供应商，非通配
  });

  test('policy 限定具体供应商而目标无供应商上下文（undefined）—— 该 policy 不匹配（拒绝）', () => {
    // 不传 targetSupplierCode（运行时即 undefined，与显式 undefined 等价）；
    // 注：当前源码签名 targetSupplierCode?: string 在 exactOptionalPropertyTypes 下
    // 不接受显式 undefined 赋值，显式传 undefined 的用例见下方“JS 调用方契约”测试
    assert(
      !PBACEvaluator.hasPermission({
        permissions: [SUPPLIER_SCOPED_POLICY],
        targetCategory: 'FASTENER',
        targetMaterialCode: 'M-001',
      }),
      '目标无供应商上下文时，限定供应商的 policy 必须拒绝（fail-closed）'
    );
  });

  test('JS 调用方契约: 显式传入 targetSupplierCode=undefined 与缺省等价（fail-closed）', () => {
    const params = {
      permissions: [SUPPLIER_SCOPED_POLICY],
      targetCategory: 'FASTENER',
      targetMaterialCode: 'M-001',
      targetSupplierCode: undefined,
    } as unknown as Parameters<typeof PBACEvaluator.hasPermission>[0];
    assert(!PBACEvaluator.hasPermission(params), '显式 undefined 必须同缺省一样拒绝');
  });

  test('policy 限定具体供应商而目标供应商上下文为空串或纯空白 —— 同样拒绝', () => {
    assert(
      !PBACEvaluator.hasPermission({
        permissions: [SUPPLIER_SCOPED_POLICY],
        targetCategory: 'FASTENER',
        targetMaterialCode: 'M-001',
        targetSupplierCode: '',
      }),
      '空串供应商上下文必须拒绝'
    );
    assert(
      !PBACEvaluator.hasPermission({
        permissions: [SUPPLIER_SCOPED_POLICY],
        targetCategory: 'FASTENER',
        targetMaterialCode: 'M-001',
        targetSupplierCode: '   ',
      }),
      '纯空白供应商上下文必须拒绝'
    );
  });

  test('policy 限定具体供应商且目标供应商匹配 —— 放行', () => {
    assert(
      PBACEvaluator.hasPermission({
        permissions: [SUPPLIER_SCOPED_POLICY],
        targetCategory: 'FASTENER',
        targetMaterialCode: 'M-001',
        targetSupplierCode: 'SUP-A',
      }),
      '供应商白名单内应放行'
    );
  });

  test('供应商维度为空数组（未限定）—— 目标无供应商上下文也放行（通配语义）', () => {
    const noSupplierScope = makePermission({
      materialCategories: ['FASTENER'],
      materialCodes: ['M-001'],
      supplierCodes: [],
    });
    assert(
      PBACEvaluator.hasPermission({
        permissions: [noSupplierScope],
        targetCategory: 'FASTENER',
        targetMaterialCode: 'M-001',
      }),
      '未限定供应商的 policy 对无上下文目标应放行'
    );
  });

  // ===================== 4b. 方案域：供应商维度不适用（NOT_APPLICABLE） =====================
  //  口径：被判定对象**自身无供应商属性**（质检方案 / 检验标准）时，供应商维度不参与判定 ——
  //  只核对物料分类 + 物料编码（docs/42-质检方案域PBAC供应商维度错配修复设计.md §3）。
  //  真实起因：三维限定账号（IQC 检验员陈静：分类 CAT-RAW-WIRE + 编码 MAT-304SS-05 +
  //  供应商 SUP-001/002）在 GET /plans/match 上恒 403，录入页指标清单恒空。

  test('NOT_APPLICABLE：三维限定 policy + 无供应商上下文 —— 分类与编码命中即放行', () => {
    assert(
      PBACEvaluator.hasPermission({
        permissions: [SUPPLIER_SCOPED_POLICY],
        targetCategory: 'FASTENER',
        targetMaterialCode: 'M-001',
        supplierDimension: 'NOT_APPLICABLE',
      }),
      '方案域必须跳过供应商维度'
    );
  });

  test('NOT_APPLICABLE：无供应商上下文 + 明确域外供应商 —— 均放行（该维度整体不适用）', () => {
    assert(
      PBACEvaluator.hasPermission({
        permissions: [SUPPLIER_SCOPED_POLICY],
        targetCategory: 'FASTENER',
        targetMaterialCode: 'M-001',
        targetSupplierCode: 'SUP-FORBIDDEN',
        supplierDimension: 'NOT_APPLICABLE',
      }),
      '方案域不因供应商不在白名单而拒绝'
    );
  });

  test('NOT_APPLICABLE：物料分类维度不放宽 —— 不匹配仍拒绝', () => {
    assert(
      !PBACEvaluator.hasPermission({
        permissions: [SUPPLIER_SCOPED_POLICY],
        targetCategory: 'CHEMICAL',
        targetMaterialCode: 'M-001',
        supplierDimension: 'NOT_APPLICABLE',
      }),
      '分类不匹配必须拒绝'
    );
  });

  test('NOT_APPLICABLE：物料编码维度不放宽 —— 不匹配仍拒绝', () => {
    assert(
      !PBACEvaluator.hasPermission({
        permissions: [SUPPLIER_SCOPED_POLICY],
        targetCategory: 'FASTENER',
        targetMaterialCode: 'M-999',
        supplierDimension: 'NOT_APPLICABLE',
      }),
      '编码不匹配必须拒绝'
    );
  });

  test('NOT_APPLICABLE：仅限定供应商的 policy 在方案域等价于物料维度全通配', () => {
    const supplierOnly = makePermission({
      materialCategories: [],
      materialCodes: [],
      supplierCodes: ['SUP-A'],
    });
    assert(
      PBACEvaluator.hasPermission({
        permissions: [supplierOnly],
        targetCategory: 'ANY_CATEGORY',
        targetMaterialCode: 'ANY-CODE',
        supplierDimension: 'NOT_APPLICABLE',
      }),
      '仅供应商限定的规则不表达物料范围，在方案域按物料维度放行'
    );
  });

  test('NOT_APPLICABLE：无生效规则仍然 fail-closed', () => {
    assert(
      !PBACEvaluator.hasPermission({
        permissions: [],
        targetCategory: 'FASTENER',
        targetMaterialCode: 'M-001',
        supplierDimension: 'NOT_APPLICABLE',
      }),
      '空权限在方案域同样必须拒绝'
    );
    const inactive = makePermission({
      isActive: false,
      materialCategories: ['FASTENER'],
      materialCodes: ['M-001'],
      supplierCodes: ['SUP-A'],
    });
    assert(
      !PBACEvaluator.hasPermission({
        permissions: [inactive],
        targetCategory: 'FASTENER',
        targetMaterialCode: 'M-001',
        supplierDimension: 'NOT_APPLICABLE',
      }),
      '停用策略在方案域同样必须拒绝'
    );
  });

  test('缺省 supplierDimension 等价于 ENFORCE（单据域行为不变）', () => {
    const target = { targetCategory: 'FASTENER', targetMaterialCode: 'M-001' };
    const enforced = PBACEvaluator.hasPermission({
      permissions: [SUPPLIER_SCOPED_POLICY],
      ...target,
      supplierDimension: 'ENFORCE',
    });
    const omitted = PBACEvaluator.hasPermission({ permissions: [SUPPLIER_SCOPED_POLICY], ...target });
    assert(!enforced && !omitted, '显式 ENFORCE 与缺省都必须拒绝（无供应商上下文）');
  });


  // ===================== 5. policy 之间 OR 语义 =====================

  test('多 policy OR: 任一启用 policy 匹配即通过', () => {
    const failing = makePermission({
      id: 'p-fail',
      materialCategories: ['CHEMICAL'], // 维度不满足
      supplierCodes: ['SUP-A'],
    });
    const passing = makePermission({
      id: 'p-pass',
      materialCategories: ['FASTENER'],
      materialCodes: ['M-001'],
      supplierCodes: ['SUP-A'],
    });
    assert(
      PBACEvaluator.hasPermission({ permissions: [failing, passing], ...FASTENER_M1_SUPA }),
      '存在匹配 policy 时应放行（OR）'
    );
  });

  test('多 policy OR: 停用的匹配 policy 不影响其他启用 policy 的放行', () => {
    const inactiveMatch = makePermission({
      id: 'p-inactive',
      isActive: false,
      materialCategories: ['CHEMICAL'],
    });
    const activeMatch = makePermission({
      id: 'p-active',
      materialCategories: ['FASTENER'],
      materialCodes: ['M-001'],
      supplierCodes: ['SUP-A'],
    });
    assert(
      PBACEvaluator.hasPermission({ permissions: [inactiveMatch, activeMatch], ...FASTENER_M1_SUPA }),
      '启用 policy 匹配即应放行'
    );
  });

  test('多 policy OR: 全部 policy 均不匹配时拒绝', () => {
    const p1 = makePermission({ id: 'p-1', materialCategories: ['CHEMICAL'] });
    const p2 = makePermission({ id: 'p-2', materialCodes: ['M-999'] });
    assert(!PBACEvaluator.hasPermission({ permissions: [p1, p2], ...FASTENER_M1_SUPA }), '全部不匹配必须拒绝');
  });

  test('多 policy OR: 全部 policy 均停用（即使维度匹配）时拒绝', () => {
    const inactive1 = makePermission({ id: 'p-1', isActive: false, materialCategories: ['FASTENER'] });
    const inactive2 = makePermission({ id: 'p-2', isActive: false, materialCategories: ['*'] });
    assert(!PBACEvaluator.hasPermission({ permissions: [inactive1, inactive2], ...FASTENER_M1_SUPA }), '全停用必须拒绝');
  });

  // ===================== 6. assertPermission 严格断言 =====================

  test('assertPermission: 无权时抛 PBAC_ACCESS_DENIED，消息含目标上下文', () => {
    const err = assertAccessDenied(
      () => PBACEvaluator.assertPermission({ permissions: [], ...FASTENER_M1_SUPA }),
      '空权限断言'
    );
    assert(err.message.includes('FASTENER'), '错误消息应包含目标分类');
    assert(err.message.includes('M-001'), '错误消息应包含目标物料编码');
    assert(err.message.includes('SUP-A'), '错误消息应包含目标供应商');
  });

  test('assertPermission: 目标无供应商上下文时消息回显 ALL', () => {
    const err = assertAccessDenied(
      () =>
        PBACEvaluator.assertPermission({
          permissions: [SUPPLIER_SCOPED_POLICY],
          targetCategory: 'FASTENER',
          targetMaterialCode: 'M-001',
        }),
      '无供应商上下文断言'
    );
    assert(err.message.includes('ALL'), "未提供供应商上下文时消息应显示 [ALL]");
  });

  test('assertPermission: 有权限时不抛错', () => {
    PBACEvaluator.assertPermission({ permissions: [FULL_MATCH_POLICY], ...FASTENER_M1_SUPA }); // 严禁抛错
  });

  return { total, passed };
}

// 自动自执行能力：任一用例失败即抛错，进程以非零退出码失败
const res = runPBACEvaluatorTests();
console.log(`[PASS] PBAC Evaluator Tests: ${res.passed}/${res.total}`);
