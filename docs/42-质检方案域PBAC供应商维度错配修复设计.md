# 质检方案域 PBAC 供应商维度错配修复设计

> **版本**：v1.0.1 ｜ **更新日期**：2026-09-23 ｜ **状态**：已实施（§5 为真实库 / 真实 HTTP / 真实界面三档实测回填）
> **触发来源**：用户实测反馈 ——「陈静的检验填写内容为空是怎么回事」：以 IQC 检验员 `陈静` 打开【来料检验】→ `INS-20231013-0001` 录入表单，横幅报「质检方案匹配失败」，三个指标分区全部为空，指标条显示「检验项总数 0 项」
> **关联文档**：[04-API与导入规范.md](./04-API与导入规范.md) §3.7 ｜ [17-检验录入界面说明与质检方案匹配口径.md](./17-检验录入界面说明与质检方案匹配口径.md) §7.2 / §7.4 ｜ [18-物料权限管理数据字段与接口打通设计.md](./18-物料权限管理数据字段与接口打通设计.md) ｜ [20-质检方案设计页数据字段与接口打通设计.md](./20-质检方案设计页数据字段与接口打通设计.md) ｜ [39-不合格判定自动入池与MRB页可见性打通设计.md](./39-不合格判定自动入池与MRB页可见性打通设计.md) §2 D2 / §4.6

---

## 1. 现象与复现

用户路径：以 `陈静`（`IQC_INSPECTOR`）登录 → 【来料检验】台账 → 打开 `INS-20231013-0001`（物料 `MAT-304SS-05`）→ 录入表单三个分区全空、「检验项总数 0 项」、横幅「质检方案匹配失败」。

> **复现的前置条件（本轮补记）**：`INS-20231013-0001` 的**种子状态是 `PENDING`**（界面「待检验」），只有待检验 / 检验中的行才带行内【检验】按钮 —— 即**按当前方案录入**（MATCH）的唯一入口。本轮复现前该行已被早前的写库测试漂移成 `PASSED`（按钮变成【详情】），必须先 `pnpm db:seed` 复位才能重放本现象，见 §7 R6。

真实库（PostgreSQL 17）+ 真实 HTTP（常驻 `127.0.0.1:3100`）复现（2026-09-23）：

| # | 复现动作 | 实测结果 | 结论 |
|:---:|:---|:---|:---|
| 1 | `GET /api/v1/plans/match?materialCode=MAT-304SS-05&inspectionType=IQC`（陈静） | **403** `pbac-permission-denied`：`三维 PBAC 安全拦截: 用户 陈静(...) 无权操作 [匹配质检方案] 物料分类 [CAT-RAW-WIRE] / 物料 [MAT-304SS-05] / 供应商 [*]` | **录入页读方案的唯一入口被拦，指标清单拿不到 ⇒ 表单必然为空** |
| 2 | `GET /api/v1/inspections?type=IQC`（陈静） | 200，`INS-20231013-0001` 可见（`supplier_code = SUP-001`） | 台账可见（读侧行级过滤按 `supplier_code` 列判定，通过） |
| 3 | `GET /api/v1/inspections/{id}`（陈静，只读回看） | 200，`items` 4 项（`DIA-001` / `TEN-001` / `CHE-001` / `RGH-001`） | 详情/回看可用（该路由断言时**传了** `order.supplierCode`） |
| 4 | `POST /api/v1/permissions/check?materialCode=MAT-304SS-05&supplierCode=SUP-001` | `allowed = true`，命中规则 `IQC_INSPECTOR` | 陈静对本物料**确有**权限，且规则三维里分类/编码均命中 |
| 5 | 同上，去掉 `supplierCode` | `allowed = false` | 缺供应商上下文 ⇒ 规则整条不命中（fail-closed） |
| 6 | 方案本体 | `QP-IQC-304SS` v2.4 `ACTIVE`（物料 `MAT-304SS-05` / 分类 `CAT-RAW-WIRE` / `IQC`） | **方案存在且已启用，不是"方案没配"** |

> 关键旁证：错误文案里的 `供应商 [*]` 是服务端 `SecurityContext` 在**未收到供应商上下文**时的占位输出（`packages/application/src/security/security-context.ts`），即「本请求从未提供供应商维度」。

---

## 2. 根因

### 2.1 D1（后端·主因）：方案域权限判定套用了单据域的供应商维度

| 项 | 内容 |
|:---|:---|
| 数据 | `material_permissions` 中 `陈静` 的规则（`id = 70000000-0000-4000-8000-000000000002`）为**三维限定**：`materialCategories = ['CAT-RAW','CAT-RAW-WIRE']`、`materialCodes = ['MAT-304SS-05']`、`supplierCodes = ['SUP-001','SUP-002']` |
| 判定 | `PBACEvaluator`（`packages/domain/src/services/pbac-evaluator.ts`）规定：规则**限定了具体供应商**而目标**无供应商上下文**时，该规则不匹配（fail-closed，防 fail-open） |
| 事实 | `GET /plans/match` 的控制器（`apps/api/src/controllers/plans.controller.ts`）调 `assertAccess` 时只传 `targetCategory / targetMaterialCode / operationName`，**从不传供应商** ⇒ 对陈静恒 403 |
| 矛盾 | 同仓其它链路都传了供应商：`inspections.controller.ts`（详情）、`create-inspection-order.ts`、`record-measurements-and-judge.ts`、`save-inspection-draft.ts`。**只有方案匹配这条链路漏了**，于是形成「台账看得见、详情打得开、唯独录入页空白」的割裂 |

**本质是维度错配**：`inspection_plans`（方案）表**没有** `supplier_code` 列，方案对象自身也不具备供应商属性 —— 一份检验标准不属于任何供应商。把规则的供应商维度硬套到"读一份方案"上，必然 fail-closed。

**同类面**：方案域还有两处同样口径 —— `inspection-plan-repository.ts` 的 `listPlans` / `getPlanStats` 传 `hasSupplierColumn: false`，翻译器对"限定供应商"的规则整条 `continue` 跳过 ⇒ 陈静在【质检方案设计】页看到的是 **0 条方案**（同一根因的第二个表现）。

### 2.2 D2（前端·次因）：403 被渲染成"方案没配"，空态被渲染成"无需录入"

| 位置 | 现状 | 问题 |
|:---|:---|:---|
| `PlanMatchBanner.tsx` | 非 404 一律落到 `status = 'error'`，标题固定「质检方案匹配失败」，副文案引导「请先由质量工程师在【质检方案设计】中为该物料建立并启用方案」 | 真实原因是**数据权限**，引导方向完全错（用户会去找质量工程师配方案，而方案本来就有） |
| `IqcRecordForm.tsx` / `OqcRecordForm.tsx` 三处分区空态 | 只要分区数组为空就显示「本单质检方案未包含××类指标项，无需录入」 | 该文案只在"方案已就绪但本分区确实无指标项"时成立；权限拦截 / 加载失败时显示它 = 把"取不到"说成"不需要" |

---

## 3. 口径决策（本轮定稿）

> **方案域对象不具备供应商属性，供应商维度不参与方案域判定；供应商维度只在单据域（检验单 / 不合格待审核池 / MRB 处置单）参与。**

| 域 | 对象 | 是否有供应商属性 | 三维判定口径 |
|:---|:---|:---|:---|
| **方案域** | `inspection_plans`（方案 / 方案版本 / 指标项） | **无**（表无 `supplier_code`，业务上标准不分供应商） | 只判 **物料分类 + 物料编码**；供应商维度**不适用**（不参与判定，也不因"限定供应商"而整条作废） |
| **单据域** | `inspection_orders` / `pending_mrb_items` / `mrb_reviews` | **有**（单据属于某次具体来料 / 某供应商） | 三维全判；表无 `supplier_code` 列时经**源检验单**换算（docs/39 §4.6） |

补充规则与边界：

1. **不放宽单据域**：本轮只动方案域。台账、详情、录入提交、终判、放行、MRB 池 / 处置单的三维判定**一字不改** —— 陈静仍只能看到 `SUP-001 / SUP-002` 的 `MAT-304SS-05` 单据。
2. **不放宽物料维度**：方案域仍要求**分类或编码**命中；一条规则只要其物料维度（分类 / 编码）命中即放行该方案。三维全通配规则本就是全量放行，语义不变。
3. **"仅供应商限定"的规则在方案域等价于物料维度全通配**：这种规则不表达任何物料范围（分类与编码都是通配），在方案域按其物料维度放行。取舍：方案库属于"标准/工艺文件"类信息，可见范围放大到全部方案**不涉及单据、客户、供应商业务数据**；反之若维持 fail-closed，此类账号会重演"录入页空白"（见 §7 R1）。
4. **无生效规则仍然 fail-closed**：方案域同样 `1 = 0` / 拒绝，绝不因"去掉一个维度"而把"没有规则"变成"放行"。
5. **口径单点**：模式常量 `SupplierDimensionMode = 'ENFORCE' | 'NOT_APPLICABLE'`，默认 `ENFORCE`（保持全仓既有默认行为），**只有方案域**显式传 `NOT_APPLICABLE`。

---

## 4. 改造清单

| 层 | 文件 | 改造内容 |
|:---|:---|:---|
| 领域 | `packages/domain/src/services/pbac-evaluator.ts` | 新增 `SupplierDimensionMode`（`'ENFORCE'` 默认 / `'NOT_APPLICABLE'`）；`hasPermission` / `findMatchingRule` / `assertPermission` 增加 `supplierDimension` 参数：`NOT_APPLICABLE` 时分类 + 编码命中即返回该规则，不判供应商 |
| 应用 | `packages/application/src/security/security-context.ts` | `ISecurityContext.hasPermission` / `assertPermission` / `assertAccess` 透传 `supplierDimension`（写侧上下文与领域层同一开关） |
| 基础设施 | `packages/infrastructure/src/repositories/pbac-sql-translator.ts` | `PbacWhereOptions` 增加 `supplierDimension`：`NOT_APPLICABLE` 时"限定供应商"的规则**不再整条跳过**，只按分类 / 编码生成条件（读侧行级过滤与领域层评估器口径一致） |
| 基础设施 | `packages/infrastructure/src/repositories/inspection-plan-repository.ts` | `listPlans` / `getPlanStats` 的 PBAC 过滤显式传 `supplierDimension: 'NOT_APPLICABLE'`（方案域） |
| API | `apps/api/src/controllers/plans.controller.ts` | `GET /match` 的 `assertAccess` 显式传 `supplierDimension: 'NOT_APPLICABLE'`，并注明"方案对象无供应商属性" |
| 前端 | `apps/web/src/lib/planMatch.ts` | 新增 `isPermissionDeniedError()`（403 / `pbac-permission-denied`）；`PlanMatchStatus` 类型与分区空态文案助手 `planSectionEmptyText()` 归口到本模块（"只有 `ready` 才能说无需录入"）。`planMatchErrorText()` **保留服务端拦截详情原文**（含三维上下文，便于排查），"不引导去配方案"由提示条分支承担 |
| 前端 | `apps/web/src/hooks/useMatchedPlan.ts` | 复用 `lib/planMatch.ts` 的 `PlanMatchStatus`（单一真相，避免两处状态枚举手写漂移） |
| 前端 | `apps/web/src/components/common/PlanMatchBanner.tsx` | 新增 `permission` 分支：标题「无该物料的数据权限」，文案指向 PBAC 策略配置，**不再**引导去建方案 |
| 前端 | `apps/web/src/pages/inspections/components/IqcRecordForm.tsx` / `OqcRecordForm.tsx` | 三处分区空态改为按方案状态取值：`ready` 才说「未包含××类指标项，无需录入」，否则说「待检指标清单尚未就绪…」（加载中 / 未命中 / 权限拦截 / 加载失败分别给文案） |
| 文档 | `docs/04-API与导入规范.md` §3.7 ｜ `docs/17-...md` §7.4 ｜ `docs/18-...md` ｜ `docs/README.md` | 同步本节口径与新错误分支文案 |

**未改（有意）**：方案域的写路径（`create-plan` / `upgrade-plan-version` / `toggle-plan-version`）保持原判定 —— 其入口由角色门禁主导（`assertPlanApprover`：仅 `QA_MANAGER` / `ADMIN` / `SYSTEM`），且传的是 `'*'` 占位而非真实物料，与"读一份方案"不是同一类动作，见 §7 R2。

---

## 5. 验证

| 手段 | 结果 |
|:---|:---|
| `pnpm -r run typecheck` | ✅ **7/7 包通过**（2026-09-23 实测） |
| `pnpm -r run test` | ✅ 全仓测试全绿：`packages/domain` 30/30（PBAC 评估器 **29/29**，本轮新增 7 条：NOT_APPLICABLE 放行 / 明确域外供应商仍放行 / 分类不放宽 / 编码不放宽 / 仅供应商限定等价全通配 / 无规则仍 fail-closed / 缺省等价 ENFORCE）；`packages/infrastructure`（PBAC 翻译器新增 4c~4f 四条 SQL 断言，**编译结果实证**：方案域 SQL 只含 `EXISTS(分类)` + `material_code IN`、**无任何供应商条件**；仅供应商限定的规则编译为 `1 = 1`；无规则仍 `1 = 0`；缺省 ENFORCE 行为不变）；`apps/api` 全绿；`apps/web` 全绿 |
| `pnpm --filter @letian/web run build` | ✅ 通过（`tsc && vite build`，27.7s） |
| **真实库回归**（新增 `apps/api/test/integration/plan-match-pbac-link.test.ts`，5 组断言，真实 PostgreSQL，已登记进 `apps/api/package.json` 的 `test` 脚本） | ✅ ① 陈静 `GET /plans/match`（`MAT-304SS-05` + `IQC`）**200** · `QP-IQC-304SS v2.4` · **4 项待检指标**（修复前恒 403 ⇒ 录入页恒空）；② 方案列表 / KPI 同口径 `total = 1`（修复前 0）；③ 管辖范围外物料（`MAT-BLT-109-M10`）仍 **403 `pbac-permission-denied`**（物料维度未放宽）；④ 王建国（规则已停用）仍 **403**（无规则 fail-closed）；⑤ 单据域未放宽：探针单 `INS-20260923-0063`（`SUP-003`，不在陈静白名单）详情对陈静仍 **403**，而同一物料的方案匹配仍 **200**；探针单已清理 |
| 修复前真实复现（常驻 `:3100` + 真实库，用户现象定位） | ✅ `GET /plans/match` 恒 403（文案自证 `供应商 [*]`）；`GET /inspections/{id}` **200**（该路由传了 `order.supplierCode`）；台账列表 **200** 且可见该单；`POST /permissions/check` 带 / 不带 `supplierCode` 分别为 `allowed = true / false`；方案本体 `QP-IQC-304SS v2.4` 为 `ACTIVE` |
| **界面级验收**（新增 `scripts/testing/plan-match-ui-probe.cjs`，CDP 驱动无头 Chrome，20 条断言；已登记进 `scripts/testing/README.md` §七 与根 `package.json` 的 `verify:plan-match`） | ✅ **20/20 通过，退出码 0**（2026-09-23 实测，5s）：**P1 正例** 以陈静身份点开 `INS-20231013-0001` 的录入表单 → 横幅 `data-status=ready` · 命中 `QP-IQC-304SS v2.4` · 指标条「检验项总数 **4** 项」（修复前 0）· 三分区渲染 直径 / 抗拉强度 / 碳含量 / 表面粗糙度 · 无「无需录入」/「清单未就绪」空态 ⇒ `docs/screenshots/plan-match-chenjing-fixed.png`；**P2 负例** 拦截 `/plans/match` 回放服务端真实 403 → 横幅标题「无该物料的数据权限」· `data-permission-denied=true` · 副文案指向「系统管理 - 物料权限」（**不再**引导去配方案）· 三分区空态改说「未就绪」⇒ `docs/screenshots/plan-match-chenjing-403.png` |

> ⚠️ **部署提示**：`apps/api` 的 `dev` 脚本是 `tsx src/server.ts`（**非 watch 模式**），且 `packages/*` 的改动需先由 `tsc -b` 重建 `dist`。
> 本轮实测时常驻 `:3100` 进程仍运行修复前代码（`GET /plans/match` 仍 403），**重启 API 进程后生效**。

---

## 6. 变更记录

| 日期 | 版本 | 说明 |
|:---|:---|:---|
| 2026-09-23 | v1.0.0 | 首次定稿：定位「方案域套用单据域供应商维度」的错配（D1），并同步修复方案列表 / KPI 的同源表现与前端 403 文案误导（D2） |
| 2026-09-23 | v1.0.1 | 补**界面级**证据：新增 `scripts/testing/plan-match-ui-probe.cjs`（P1 正例 4 项指标 / P2 负例 403 文案，20/20）；§1 补记复现路径的前置条件与 `pnpm db:seed` 复位纪律；登记进 `scripts/testing/README.md` 与根 `package.json` |

---

## 7. 遗留与后续

| # | 项 | 说明 |
|:---:|:---|:---|
| **R1** | 「仅供应商限定」规则在方案域的可见范围 | 本轮按 §3.3 放行（方案库非业务数据）。若客户认为"方案库也应只对管辖范围内的物料可见"，需产品口径确认后收紧 |
| **R2** | 方案域写路径未随改 | `create-plan` / `upgrade-plan-version` / `toggle-plan-version` 仍按原三维判定（实参为 `'*'` 占位）。三个入口的角色门禁在前，实际影响面为 0；如后续要对齐，属同一开关的一行改动 |
| **R3** | 前端分区空态文案未抽公共组件 | IQC / OQC 两个表单各 3 处，本轮抽了文案助手但仍各写一次条件；委外表单无固定分区表头，未涉及 |
| **R4** | 分类通用方案（`material_code = ''`）对分类白名单账号不可见 | 方案列表 / KPI 的行级过滤按代码维度生成 `inspection_plans.material_code IN (...)`，而分类通用方案的 `material_code` 是空串 ⇒ 分类白名单账号（且未限定编码）在【质检方案设计】里看不到这类方案，但录入页仍能经分类兜底命中它（界面自相矛盾）。本轮未动（涉及"分类通用方案该如何判定归属"的口径），见 `docs/37` 族级方案的既有设计 |
| **R5** | 原「无供应商列即整条跳过」的分支保留 | `buildMaterialPermissionWhere` 在缺省 `ENFORCE` 下对无供应商列 + 限定供应商的规则仍整条跳过（`1 = 0`）。这是 docs/39 §4.6 的既定口径，本轮只新增第 3 种模式，未改动该分支 |
| **R6** | 演示单 `INS-20231013-0001` 的状态漂移会「吃掉」界面复现入口 | 该单种子状态是 `PENDING`，是界面上**唯一**能点出 IQC「按当前方案录入」【检验】按钮的行；任何提交 / 终判它的写库动作（探针测试或手工录入）跑完都会让按钮变成【详情】，`plan-match-ui-probe.cjs` 随即失败。**复位纪律：写库测试跑完必须 `pnpm db:seed`**（本次复现前该行已漂移成 `PASSED`，已复位后重跑探针 20/20 通过） |
