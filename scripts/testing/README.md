# scripts/testing —— 质检台账端到端校验与源码审计（只读）

本目录脚本用于回答两类「不能靠肉眼判断」的问题：

1. **台账页面的字段到底是不是从数据库读出来的？**（`*-verify.cjs`，CDP 驱动无头浏览器）
2. **代码规范口径是否属实？**（`audit_check.js`，源码静态审计）

前置条件：后端 `:3100`、前端 `:5200` 已启动（`pnpm --filter @letian/api run dev` / `pnpm --filter @letian/web run dev`），
本机已安装 Chrome（默认 `C:\Program Files\Google\Chrome\Application\chrome.exe`）。

```bash
node scripts/testing/oqc-verify.cjs           # 出货检验（OQC）台账
node scripts/testing/inspections-verify.cjs  # 来料检验（IQC）+ 委外检验台账
node scripts/testing/ipqc-ledger-verify.cjs  # 过程检验（IPQC）总览看板 + 下料 / 滚丝 / 成品检三页台账
node scripts/testing/mrb-verify.cjs          # MRB 不合格品处置（离线 Mock 模式）
node scripts/testing/mrb-wiring-verify.cjs   # MRB 字段 / 契约 / API 打通验收（真实库 + 真实 HTTP）
node scripts/testing/audit_check.js          # 源码静态审计
node scripts/testing/leftovers2-probe.cjs     # docs/35 遗留项二轮收口（真实库 + 真实页面读写，跑完需 db:seed 复位）
node scripts/testing/leftovers2-mock-probe.cjs # 同一批收口的离线 Mock 冒烟（需 dev:mock 跑在 :5200）
node scripts/testing/eol-check.cjs             # 仓库行尾（EOL）门禁：读 git ls-files --eol，不碰业务代码
node scripts/testing/plan-match-ui-probe.cjs    # 质检方案匹配界面级验收：陈静「录入表单为空」的正例 / 负例（只读）
node scripts/testing/dev-mode-check.cjs         # 真库形态自检：当前前端到底是「真连后端写库」还是「离线 Mock 演示」（只读）
node scripts/testing/erp-readonly-check.cjs     # ERP 只读静态门禁：还有没有旁路能直连 / 回写 ERP（只读）
node scripts/testing/erp-sync-verify.cjs        # ERP -> QMS 只读同步端到端验收（真跑同步 + 对账 + 幂等，跑完自清）
node scripts/testing/inspection-detail-probe.cjs # 检验单检视页方案快照渲染：正例 / 负例（真实库 + 真实页面 + 响应替身，只读）
node scripts/testing/heat-batch-trace-verify.cjs # 出货检验炉批号溯源联动（服务端 41 条：AC-01~12 + TBD-01）
node scripts/testing/oqc-heat-no-ui-verify.cjs    # 同链路的**界面级**验收（Banner / 清空回滚 / 回显，20 条，只读）
```

前三个脚本需要后端 `:3100` 与前端 `:5200` 已启动；`mrb-wiring-verify.cjs` 需要**后端 API 已启动**（默认 `:3101`，
用 `PORT=3101 pnpm --filter @letian/api run dev` 另起一个实例，勿指向常驻 `:3100`）且数据库已迁移到最新并执行过
`pnpm db:seed`（脚本按演示数据断言，跑完会还原数据；自建来源单的验收行亦同批清理）。
根脚本入口：`pnpm run verify:oqc` / `verify:inspections` / `verify:ipqc-ledger` / `verify:mrb` / `verify:mrb-wiring` / `verify:plan-match` / `verify:inspection-detail` / `verify:heat-trace` / `verify:oqc-heat-ui` / `verify:dev-mode` / `verify:outsource-no` / `verify:leftovers2` / `verify:leftovers2:mock` / `verify:erp-readonly` / `verify:erp-sync` / `verify:eol` / `audit:code`（另有 `pnpm db:recent` 速查最近落库行）。

退出码 `0` = 通过，非 `0` = 存在 FAIL / 超预算（明细见输出与 `scripts/logs/`，该目录已 gitignore）。

---

# 一、台账渲染校验（`oqc-verify.cjs` / `inspections-verify.cjs`）

用无头 Chrome 打开 `http://127.0.0.1:5200/`，登录后读取真实渲染的 DOM，
把**页面列值**与 **`GET /api/v1/inspections` 的返回值**逐行对账。
**只做导航 + 读 DOM + 调只读接口，不写库、不改接口。**

| 脚本 | 覆盖范围 | 断言数 |
|:---|:---|:---|
| `oqc-verify.cjs` | 出货检验台账 | 8 |
| `inspections-verify.cjs` | 来料检验 + 委外检验台账 | 18 |
| `ipqc-ledger-verify.cjs` | 过程检验**总览看板 + 三页**台账（下料 / 滚丝 / 成品检；总览汇总条浅色口径与取值对接口 + 11 列列集 + 逐列对账 + 无伪造值守门 + 筛选落 SQL + 建单写路径往返） | 35 |
| `mrb-verify.cjs` | MRB 不合格品处置单页 + 并列菜单「评审流程设置」子页 + 返工处置回吐复检单号（离线 Mock） | 26 |

## 输出

| 文件 | 说明 |
|:---|:---|
| `oqc-list-after-rename.png` | 出货检验台账截图 |
| `iqc-list-after-wiring.png` | 来料检验台账截图 |
| `outsource-list-after-wiring.png` | 委外检验台账截图 |
| `ipqc-blanking-ledger.png` / `ipqc-rolling-ledger.png` / `ipqc-finished-ledger.png` | 过程检验三页台账截图（下料 / 滚丝 / 成品检，各 11 列） |
| `ipqc-overview-board.png` | 过程检验总览看板截图（三工序卡片 + 今日管控总量汇总条，浅色口径） |
| `oqc-verify.log` / `inspections-verify.log` | 逐条 PASS / FAIL 明细 |
| `mrb-list-light.png` / `mrb-list-under-review.png` / `mrb-pool-drawer.png` / `mrb-review-drawer.png` / `mrb-disposition-rework.png` / `mrb-workflow-light.png` | MRB 页面、两个抽屉、**返工处置成功横幅（复检单号）**与「评审流程设置」子页截图 |
| `mrb-mock-verify.log` | MRB 逐条 PASS / FAIL 明细 |

### MRB 走查为什么跑在离线 Mock 模式

`mrb-verify.cjs` 校验的是「页面结构 + 抽屉取数链路」，不依赖数据库，因此跑在 `pnpm --filter @letian/web run dev:mock`
（MSW 离线 Mock）上，且把 `VITE_API_TARGET` 指向未监听端口——否则未被 mock 的接口会打到真实后端并返回 401，
前端的安全登出逻辑会把会话清掉、页面退回登录页，走查结果不可信。断言覆盖：**运行目标自检（必须是离线 Mock，
否则以退出码 3 拒绝、绝不拿真实库数据满足 Mock 断言）**、页头标题/副标题、十列表头（第 5 列为「不合格原因」）、
**3 个状态页签**（待评审 / 评审中 / 已评审；2026-09-23 起「已处置」并入「已评审」）与筛选栏「评审状态」下拉同源、
默认选中项、5 张 KPI 卡、浅色主题（页面子树无深色容器）、页头无【+ 发起评审】入口（`docs/43`）、
行内「评审」抽屉的四方会签席位与返工处置回吐复检单号。

**前端实例地址自动探测**：按 `WEB_BASE` 环境变量，或 `5201 -> 5200 -> 5202` 顺序探测（多会话下 vite dev 端口
会自增，`dev:mock` 常年跑在 `5201`）。候选地址全部不可达时脚本**直接 FATAL 退出**，不再指向死端口静默挂起。

**第九组断言**走查「返工处置必须回吐复检单号」（`docs/21` §11 两处断链闭环）：在评审抽屉内用原生 setter 触发
`change` 事件选择处置方式 `REWORK`、填写处置理由并点「提交处置结论」，随后断言页面出现绿色横幅
「返工处置已生效，系统已生成下一轮复检单：{单号}」且单号符合 `{原检验单号}-R{轮次}`（`-R\d+$`），
证据图 `mrb-disposition-rework.png`。离线 Mock 侧由 `handlers.ts` 的 `buildReinspectionOrder()` 复刻真实后端的
复检单生成与源单 `RE_INSPECTING` 翻转，保证「离线演示」与「真实环境」单数一致。

第八组断言走查并列菜单**「评审流程设置」子页**（`docs/21` §10 三处断链闭环）：流程卡片「流程说明」非空且无
「无详细描述」占位（E1）、节点配置清单五列齐备且「顺序 / 授权签署角色 / 是否必签 / 特采审批权」四列真实回吐
（E2）、子页浅色主题，以及点「停用此流程」后按钮文案真实翻转为「启用此流程」（E3，走 Mock 的
`POST /api/v1/review-flows/:id/toggle-active` 并被重载读回）。脚本会**自动放行原生 `alert`**（`Page.javascriptDialogOpening`），
否则启停成功提示会阻塞渲染进程、导致后续断言全部超时。

## 断言口径（为什么这么测）

- **页面条数必须等于接口 `total`**：若前端自行二次过滤，`total` 与检索范围都会失真；
- **入库单号 / 委外加工单号 / 回厂日期不得是推导值**：历史实现用 `'RK-' + 检验单号` 合成入库单号、
  用 `batch_no` 顶替委外加工单号、用 `created_at` 顶替回厂日期——这些都会让「链路是否真打通」无法判断；
- **来料检验「检验单号 / 入库单号」两列必须与接口 `orderNo` / `inboundNo` 逐行一致**：
  表头列名口径为「入库单号」（`docs/25`，迁移 021 取代旧的「采购入库单号」），
  页面列值与接口字段逐行对账，任何一侧改名或漏读都会立刻失败；
- **ERP状态列必须等于接口 `erpStatus`**：该列只能来自库列 `erp_status`，不得由质检结论反推。

完整设计与验收记录见 `docs/16-出货检验OQC数据字段与接口打通设计.md`（§7.11 / §7.13）。

---

# 二、MRB 字段 / 契约 / API 打通验收（`mrb-wiring-verify.cjs`）

（等价入口：`pnpm run verify:mrb-wiring`）

回答的是「MRB 不合格品处置页的每个字段，是不是真的落到了 PostgreSQL 物理列、由 Fastify 接口读写」——
**真实数据库 + 真实 HTTP**（不使用 Mock），38 条断言覆盖：

1. `GET /mrb/pending-pool` 回吐 015 新增列（供应商 / 客户 / 不合格指标项 / 检验人 / 受检数量 / 不良率）与环节前缀筛选；
2. `GET /mrb/records` 回吐派生 `inspectorName` 与新增 `urgencyLevel` / `reviewFlowId`；
3. `POST /mrb/pending-pool/initiate` 的 `flowId` / `urgencyLevel` / `reviewNotes` / `pendingDefectId` **逐列落库**，池条目转 `INITIATED` 并回填 MRB 单；
4. `POST /mrb/records/{id}/sign` 会签转 `UNDER_REVIEW`；
5. 特采无客户凭证必须 `400 CONCESSION_NOT_SIGNED_OFF`（不得有伪造兜底）；带凭证处置返回**裸 `MRBRecord`**
   （契约 `DisposeMRBResponse`；`REWORK` 时追加 `reinspectionOrderId` / `reinspectionOrderNo`，见 `docs/21` §11）
   且 `disposed_at` / `disposed_by` / 附件按提交值落库。
6. **池 PBAC 行级权限随查询下推 SQL**（`docs/21` §9 遗留 1 闭环）：按 `userId` 换登录身份断言
   全通配用户看到全量、分类白名单用户只看到白名单分类的条目、限定供应商或无生效规则的用户 fail-closed 看到 0 条，
   且 `total` 与过滤后命中数同口径（翻页不影响 `total`）；期望条数由库内 `materials.category_code` 分组统计推导，不写死种子条数。
7. **池状态口径收敛**（`docs/21` §9 遗留 3 闭环）：`?status=PENDING_REVIEW` 等 004 历史词表必须 `400`，不得静默映射。
8. **评审流程设置子页字段打通**（`docs/21` §10 闭环，4 条断言）：`GET /review-flows` 回吐 `description` 与节点
   `roleName` / `isRequired` / `allowConcession`（且节点顺序唯一取 `nodeLevel`、仅终审层级 `allowConcession=true`）、
   接口 `description` 与 `review_flows.description` 逐条一致、`POST /review-flows/:id/toggle-active` 真实落库
   `is_active`（**往返切回原值**）。启停调用**必须带 JSON 体**（`{}`）：Fastify 对 `content-type: application/json`
   的空体直接拒绝，前端 `api.post(path, {})` 即此形态。
9. **返工处置响应回吐复检单标识**（`docs/21` §11 闭环，5 条断言）：**不依赖演示池的存量状态**，自建来源单走完整
   链路 —— `POST /inspections` 建单（带 `inboundNo` / `specification` / `unit` 快照）-> 越界录入判定 `FAILED` ->
   自动入待审核池 -> `POST /mrb/pending-pool/initiate` -> 处置 `REWORK`；断言响应体 `reinspectionOrderNo` 等于
   `{原单号}-R{轮次}`（轮次由库内同批次检验单数推导，不写死）且 `reinspectionOrderId` 为 UUID、库内复检行的
   `id` / `order_no` 与响应**逐一对齐**且状态 `PENDING`、`inbound_no` / `specification` / `unit` 逐字段等于原单
   （沿承快照而非回查主数据）、源单翻转为 `RE_INSPECTING`。清理动作挂在成功与异常两条路径上（见脚本内
   `reworkCleanup`），中途失败也不会把验收行留在库里。
10. **四环节来源分类与评审流程绑定**（`docs/44` §1 闭环，3 条断言）：过程（`IPQC_CT`）/ 出货（`OQC_SH`）/ 委外（`OQC_SF`）
    自建单走真实 HTTP 终判 `FAILED`，断言 `mrb_reviews.source_type` 分别为 `PROCESS_FAIL` / `SHIPMENT_FAIL` / `SUBCONTRACT_FAIL`，
    且 `review_flow_id` 指向该分类的**生效**流程（`FLOW-PROCESS-FAIL` / `FLOW-SHIPMENT-FAIL` / `FLOW-SUBCONTRACT-FAIL`，
    `applicable_type` 同口径）、检验单转 `IN_MRB_REVIEW`、拟定处置缺省 `REWORK`。改造前只认精确值
    `IQC/IPQC/OQC/FQC/OUTSOURCE`，委外八类与出货全部错绑过程流程（会签角色与节点层级全错）。清理同样挂在
    成功与异常两条路径上（见脚本内 `stageCleanup`）。

```bash
# 前置：数据库已迁移到最新且执行过 pnpm db:seed；目标 API 已启动
pnpm run verify:mrb-wiring

# 指定非默认端口的 API（默认 http://127.0.0.1:3101/api/v1）
MRB_WIRING_BASE=http://127.0.0.1:3102/api/v1 node scripts/testing/mrb-wiring-verify.cjs
```

脚本自带清理：跑完把验收产生的 MRB 删除、池条目回 `PENDING_INITIATE`、工单回 `FAILED`，可反复执行。
完整口径见 `docs/21-MRB不合格品处置数据字段与接口打通设计.md` §7（主页面字段链路）与 §10（评审流程设置子页）。

---

# 三、源码静态审计（`audit_check.js`）

（等价入口：`pnpm run audit:code`）

```bash
# 默认：与基线比较，「不得新增」；超预算以退出码 1 失败
node scripts/testing/audit_check.js

# 强制归零（当前会失败：存量 any 未清）
node scripts/testing/audit_check.js --strict

# 显式上限（优先于基线）
node scripts/testing/audit_check.js --max-any=100

# 评审通过后落基线
node scripts/testing/audit_check.js --update-baseline

# 机器可读输出（CI 用）
node scripts/testing/audit_check.js --json
```

## 为什么改过一版

旧版脚本只统计并打印，**无论结果如何都以 0 退出**——于是「完全符合无 `any`、无 `@ts-ignore` 规范」
这类结论根本无法被证伪（`docs/实施进度.md` 曾据此写下与事实不符的口径）。
现版是「跑得出结论」的审计器：

| 退出码 | 含义 |
|:---|:---|
| `0` | 通过（违规项未超出预算） |
| `1` | 超出预算（默认按基线，`--strict` 按 0） |
| `2` | 用法 / IO 错误（如基线文件损坏） |

## 扫描口径

- 只扫仓库内 `.ts` / `.tsx`，跳过 `node_modules` / `.git` / `dist` 等构建产物，以及 `scripts/`
  （工具脚本本身合法包含这些字面量）；
- 先剔除行注释与块注释再匹配，避免注释文字被误判；
- 匹配 `as any` / `: any` / `<any>` / `, any>` / `| any` / `any[]` / `z.any(`；
- `interface` 声明只做信息展示，不参与判定。

## 基线

### 与 `pnpm lint` 的分工（同一条口径只留一个执行点）

`any` 的**执行点只有本脚本**（预算 138 + 基线文件 + 「不得新增」语义）；`.eslintrc.json` 里
`@typescript-eslint/no-explicit-any` 相应设为 `warn`，只做可视化提示。
此前两侧都判 `any` 且阈值不同（eslint = 0），结果是「audit 说在预算内、lint 说 234 个 error」，
`pnpm lint` 因而长期不可用（详见 `docs/35` §12）。

`pnpm lint` 现在以 **0 error** 通过：`no-unused-vars` 的死代码逐条清掉（不是关规则）、
`no-irregular-whitespace` 的 BOM 字符清除、`scripts/logs/`（产物目录）移出扫描范围；
剩余 warning 为 `any` 175 + `no-console` 122（`docs/35` §13 R8）。

`scripts/testing/audit-baseline.json` 记录「允许存在的存量违规上限」。
默认模式的语义是**不得新增**，而不是「假装没有」；只有评审后才可用 `--update-baseline` 上调。
明细报告输出到 `scripts/logs/audit-report.txt`（已 gitignore）。

---

# 四、七大业务流程走查（`cdp-runner.js`）

（等价入口：`pnpm run verify:smoke`）

真实前后端联动下用 CDP 无头浏览器依次走查 7 条业务流，并覆盖 `docs/screenshots/` 下的验收截图。

```bash
# 前置：Web dev server 与 API 均已启动（自动探测 5200 / 5201 / 5202）
node scripts/testing/cdp-runner.js

# 指定前端地址与调试端口（默认 9222）
WEB_BASE=http://127.0.0.1:5201/ CDP_PORT=9222 node scripts/testing/cdp-runner.js
```

若 `9222` 上没有已打开的 Chrome，脚本会自行以无头模式拉起一个，跑完自动关闭。

| 退出码 | 含义 |
|:---|:---|
| `0` | 7 项全部通过，且无未捕获运行时异常 |
| `1` | 存在失败项或未捕获异常 |
| `2` | 环境不可用（前端未监听 / Chrome 无法连接） |

## 走查项

系统导航与主骨架、检验进度总览 KPI 与 ECharts、来料检验台账、出货检验台账、
MRB 不合格品处置、质量追溯看板、质检方案设计。

## 为什么改过一版

旧版 `cdp-runner.js`（仓库外）在用例失败时**仍以 0 退出**，因此「7 大业务流全部 PASSED」不可证伪；
其历史 6 张截图中有 5 张只有 2163 字节（空白/未渲染页）却标注 `PASSED`。
现版把判定与退出码绑定、把控制台未捕获异常纳入判定，并把导航关键词同步到当前 UI 标签
（如 `MRB评审工单` → `MRB不合格品处置`）。
---

# 五、遗留项二轮收口探针（`leftovers2-probe.cjs` / `leftovers2-mock-probe.cjs`）

（等价入口：`pnpm run verify:leftovers2` / `pnpm run verify:leftovers2:mock`）

对应 `docs/35-遗留项二轮收口设计（ERP号段校验 + 三表单写路径 + 企业档案主数据 + 证书入口统一）.md`：
把该文档 §12 的每一条「实测」固化成可重跑的断言，避免结论只活在一次性日志里。

| 脚本 | 环境 | 覆盖 | 断言数 | 是否写库 |
|:---|:---|:---|:---|:---|
| `leftovers2-probe.cjs` | 真实库 + API `:3100` + 前端 `:5200/:5201` | 企业档案接口口径（GET 已维护行 + 非法邮箱 400；**维护界面已于 2026-09-23 下线**，改为断言侧边栏无该菜单）、签核 403/200 与落库与审计 append-only、IQC 提交回执、四处台账「证书」入口 + 缺失提示条、委外新建 + 物料编码回填 | 20 | **是** |
| `leftovers2-mock-probe.cjs` | 离线 Mock（MSW）`dev:mock` `:5200`，不需要 API / 数据库 | `GET /master-data/company-profile`、`POST /inspections/:id/approve` 两条 Mock 路由在真实浏览器可用 + 侧边栏无「企业档案 / ERP基础档案」入口 | 3 | 否（只改浏览器内存） |

**为什么两个都要跑**：真实库探针证明「接口 + 物理列」打通，离线 Mock 探针证明「无后端时演示链路仍然可用」——
`docs/35` §11「同步面」要求 Mock 与真实实现同时存在的两条路由（企业档案 GET、签核 POST）缺任何一侧，
离线演示或真实环境就会单边失真。

**启动方式（Mock 侧）**：必须让没有 mock 的接口打不到真实后端，否则真实 API 的 `401` 会触发前端安全登出，
页面退回登录页、断言全灭（这与 `mrb-verify.cjs` 的隔离要求同源）：

```powershell
$env:VITE_API_TARGET="http://127.0.0.1:5999"; pnpm --filter @letian/web run dev:mock   # 5999 = 未监听端口
```

探针在点击「进入系统」后会先确认已经进入应用（`<header>` 存在），否则以退出码 `3` 打印上述命令后退出，
不接受「停在登录页但断言继续跑」的假结果。

**复位纪律**：`leftovers2-probe.cjs` 会写库（签核三列、提交回执、委外新建单），**跑完必须 `pnpm db:seed`**，
否则下一次探针或演示会读到被改过的种子值；`leftovers2-mock-probe.cjs` 不写库，无需复位。

**前置不可达时的行为**：两者都在启动浏览器前先探测前端端口，不可达时以退出码 `3` 直接 FATAL 退出并打印补救命令，
不再让 Chrome 空等到超时（旧的「跑完即删」一次性脚本正是因为静默等待而难以判断失败原因）。

---

# 六、仓库行尾（EOL）门禁（`eol-check.cjs`）

```powershell
pnpm verify:eol            # 等价 node scripts/testing/eol-check.cjs
```

判定口径（权威来源 = git 自己，读 `git ls-files --eol`）：

1. 根 `.gitattributes` 必须存在且声明 `* text=auto eol=lf`；
2. 所有已跟踪**文本**文件的**索引 blob** 必须是 `i/lf`（索引 = 仓库的存档形态）；
3. 所有已跟踪**文本**文件的**工作区**不得出现 `w/crlf` 或 `w/mixed`。

二进制（git 判 `-text`）不参与判定：它字节里的 `0D 0A` 是数据，不是行尾。

**为什么需要它**：本仓库长期没有 `.gitattributes`，而本机 `core.autocrlf=true` 会在比对时把 CR 归一，
于是 `git status` 完全看不见行尾脏。但脚本按字节读文件时 CR 会进字符串，`includes` / `replace` 这类
精确匹配就会**静默不命中**（`docs/35` §13 R6 记录过一次真实踩坑：一次归一脚本把 74 个已跟踪文本文件的行尾误抹平，
最后靠 `git cat-file blob :<file>` 按索引逐个重建才恢复）。

**修法**：确认 `.gitattributes` 在位后，把这些文件**整文件写回 LF**（读字节 → 只把 CRLF 还原成 LF → 写回，
二进制与含 NUL 的文件跳过），再重跑本门禁。不要改本机 `core.autocrlf` —— `.gitattributes` 的 `eol=lf` 优先级更高，
改本机配置对已跟踪文本文件不起作用。

退出码：`0` = 收敛；`1` = 存在违规（明细见输出与 `scripts/logs/eol-check.log`）；`2` = 非 git 仓库 / git 不可用。

---

# 七、质检方案匹配界面级验收（`plan-match-ui-probe.cjs`）

（等价入口：`pnpm run verify:plan-match`）

对应 `docs/42-质检方案域PBAC供应商维度错配修复设计.md`：把用户实测现象「**陈静的检验填写内容为空**」固化成
**界面级**可重跑断言。接口级断言在同篇文档登记的 `apps/api/test/integration/plan-match-pbac-link.test.ts` 里，
两侧缺一不可 —— 接口全绿但界面仍空，正是这次用户踩到的那种割裂。

| 项 | 内容 |
|:---|:---|
| 环境 | 前端 `:5200` + 后端 `:3100` **都必须已启动**；任一不可达直接以退出码 `3` FATAL 退出，不让 Chrome 空等到超时 |
| 前置数据 | 演示基线（`pnpm db:seed`）：`INS-20231013-0001` 必须是 `PENDING`（界面「待检验」）—— 只有待检验 / 检验中的行才带行内【检验】按钮，也就是**按当前方案录入**（MATCH）的入口 |
| 断言数 | 20 |
| 是否写库 | **否**（只导航 + 读 DOM + 调只读接口 + 浏览器内请求替身） |

## 两条用例

| 用例 | 做法 | 判定 |
|:---|:---|:---|
| P1 正例 | 以 `陈静`（`IQC_INSPECTOR`，三维限定规则）身份打开 `INS-20231013-0001` 的录入表单 | 横幅 `data-status=ready`、命中 `QP-IQC-304SS`、指标条「检验项总数 **4** 项」、三分区渲染 直径 / 抗拉强度 / 碳含量 / 表面粗糙度，且**不出现**「无需录入」「清单未就绪」空态 |
| P2 负例 | `Fetch.enable` 拦截 `/api/v1/plans/match*`，回放服务端**真实 403 响应体**（`pbac-permission-denied`） | 横幅 `data-status=error`、`data-permission-denied=true`、标题「无该物料的数据权限」、副文案指向「系统管理 - 物料权限」而**不再**引导去找质量工程师配方案、分区空态改说「未就绪」 |

**P2 为什么用请求替身，而不是"找一单真正越权的"**：陈静的台账被行级过滤约束在管辖范围内，界面上不存在能自然
点出 403 的行；强行造库又会写数据。替身只替换**响应字节**，不伪造字段、不碰库，验证的正是「403 该渲染成哪一支
分支、文案指向哪里」这一件事（这正是 D2 修的 Bug：把权限拦截说成"方案没配"，把人引去找质量工程师）。

## 输出

| 文件 | 说明 |
|:---|:---|
| `plan-match-chenjing-fixed.png` | 修复后录入页（横幅「已匹配质检方案」+ 4 项待检指标） |
| `plan-match-chenjing-403.png` | 403 分支（标题「无该物料的数据权限」+ 三分区「未就绪」空态） |
| `plan-match-ui-probe.log` | 逐条 PASS / FAIL 明细 |

截图同时落在 `docs/screenshots/`（入库，作验收证据）与 `scripts/logs/`（已 gitignore）。

退出码：`0` = 20 条断言全通过；`1` = 存在失败项或探针异常；`3` = 环境不可用。

## 两个已踩的坑（都写进脚本了）

1. **`Chrome CDP not reachable` 不是"Chrome 起不来"**：探针最初复用固定 `user-data-dir`，而该 profile 正被别的
   Chrome 占用时，新进程会把命令行**转交给旧实例后自己退出**，调试端口永远不监听。现在每次都用带 `pid + 时间戳`
   的全新 profile（跑完连同 profile 一起删除，免得 `scripts/logs/` 攒一堆浏览器用户目录），并把 Chrome 的
   stderr 落到 `scripts/logs/plan-match-ui-probe.chrome.err.log` 便于定位。
2. **固定 `sleep` 赌加载时间会偶发假失败**：页面加载 / 点击 / 请求返回都是异步的，改成轮询「目标行出现 / 提示条
   出现 / `data-status` 变成期望值」后，探针从 51s 压到 5s，且连续多次运行结果一致。

---

# 八、真库形态自检与 ERP 只读门禁（`dev-mode-check.cjs` / `erp-readonly-check.cjs` / `erp-sync-verify.cjs`）

## 8.1 `dev-mode-check.cjs`（`pnpm verify:dev-mode`）

回答「我起的前端是真连数据库，还是离线 Mock 演示」。**端口不能作为判据**（`.env.mock` 里 `VITE_PORT` 也是 5200）：
脚本直接取 dev server 下发的 `/src/mocks/browser.ts`，解析被注入的 `import.meta.env` 字面量 —— `MODE=mock`
或 `VITE_USE_MOCK=true` 即演示模式；再断言「经前端同源请求 `/api/v1` 得到真后端 401 + problem+json」与
「接口返回的单号全部存在于 PostgreSQL」。同时列出 `:5200/:5201/:5202` 上**所有**在跑实例的形态。

前置：前端与 API 已启动（`pnpm dev:all`）。实测（2026-09-23）：`:5200` 为真库形态 **4/4 PASS**；把它指向
`dev:mock` 实例（`:5202`，`MODE=mock`）则 **2/4 FAIL、退出码 1** —— 即负例可控。

## 8.2 `erp-readonly-check.cjs`（`pnpm verify:erp-readonly`）

静态门禁，回答「除了唯一入口，还有没有别的地方能直连 ERP」：① 引用 `getErpConnectionPool` 的文件必须全在白名单内
（豁免清单**冻结**，新增即 FAIL）；② CLI 层不得出现 `.request()`；③ `erp-source.ts` 必须调用 `queryErpReadOnly`；
④ `erp-source.ts` 的 `.request()` 收敛为唯一 1 处；⑤ 守门本体必须保留首关断言与写关键字清单。实测：扫描 155 个
`.ts`、违规 0、遗留豁免 2 项（`sync-master-data.ts` / `external-adapters.ts`，见 docs/45 §7）打 WARN。

## 8.3 `erp-sync-verify.cjs`（`pnpm verify:erp-sync`）

端到端验收 `Ptype -> materials` 最小闭环：真跑 `pnpm erp:sync:ptype`（本地样例源，无需 ERP 连接）→ 逐字段对账 →
幂等复跑 → 改源触发更新 → 校验 CLI 的只读审计行 → 清理测试行。实测 **8/8 PASS**（首轮 `inserted=3`；二次
`unchanged=3` 且总行数不变；改源 `updated=1`；清理后残留 0）。**只碰 `material_code LIKE 'ERP-FIX-%'` 的测试行。**

---

# 九、检验单检视页（只读回看）方案快照渲染探针（`inspection-detail-probe.cjs`）

回答「打开一张检验单的【检视与评定】，页面到底渲染的是**本单建单时固化的方案快照**，还是拿当前生效方案顶替 / 干脆空白」。
根因、口径与修复工具见 `docs/46-演示检验单方案快照与指标行补齐设计.md`（数据级体检是 `pnpm db:demo:check`，本脚本是它的**界面级**对应物）。

| 项 | 说明 |
|:---|:---|
| 入口 | `pnpm verify:inspection-detail`（或 `node scripts/testing/inspection-detail-probe.cjs`） |
| 前置 | 后端 `:3100` + 前端 `:5200` 已启动；目标单 `INS-20260921-0001`（可用 `ORDER_NO=` 覆盖）在库且快照完整 |
| 被测入口 | `陈静`（IQC 检验员）→【来料检验(IQC)】台账 → 目标行内【详情】（即"检视与评定"页 `IqcRecordForm.tsx`） |
| 断言数 | 19 |
| 是否写库 | **否**（只导航 + 读 DOM + 调只读接口 + 浏览器内响应替身） |

## 两条用例

| 用例 | 做法 | 判定 |
|:---|:---|:---|
| P1 正例 | 以 `陈静` 打开 `INS-20260921-0001` 的检视页 | 横幅 `data-status=ready`、`data-source=SNAPSHOT`、展示快照方案 `QP-IQC-304SS` v2.4、指标条「检验项总数 **4** 项」、三分区渲染 直径 / 抗拉强度 / 碳含量 / 表面粗糙度，且**不出现**「检验单方案快照加载失败」「清单未就绪」「无需录入」 |
| P2 负例 | `Fetch.enable` + `Fetch.fulfillRequest` 把 `GET /inspections/{id}` 的响应体换成**空快照**形态（`planSnapshot: {}` + `items: []`，即裸 SQL 造数落下的形状）后重开检视页 | 横幅必走「检验单方案快照加载失败」、`data-status=error`、**不渲染任何指标行**（不拿当前方案顶替）、分区空态为「未就绪」3 处，且**不得**谎称「无需录入」 |

**P2 为什么用响应替身**：修复后库里已不存在空快照的行，而「读侧遇到空快照会渲染成哪一支分支」这条**回归护栏**必须长期可重跑。
替身只替换**响应字节**，不写库、不改接口 —— 验证的正是契约 fail-closed 分支：宁可显式报错，也不按结构不明的数据回看判定依据。

## 输出

| 文件 | 说明 |
|:---|:---|
| `inspection-detail-snapshot-fixed.png` | 修复后检视页（横幅「本单方案快照」+ 4 项待检指标） |
| `inspection-detail-snapshot-missing.png` | 空快照分支（标题「检验单方案快照加载失败」+ 三分区「未就绪」空态） |
| `inspection-detail-probe.log` | 逐条 PASS / FAIL 明细 |

截图同时落在 `docs/screenshots/`（入库，作验收证据）与 `scripts/logs/`（已 gitignore）。

退出码：`0` = 19 条断言全通过；`1` = 存在失败项或探针异常；`3` = 环境不可用（前后端未监听 / 浏览器起不来）。

---

# 十、炉批号关联链路验收（`heat-batch-trace-verify.cjs` / `oqc-heat-no-ui-verify.cjs`）

出货检验「填炉批号 → 带出上游委外热处理 / 来料检验实测值」这条链路（口径与断链清单见 `docs/47`，**P0 + P1/P2 验收 = AC-01 ~ AC-13 全量**）。
两个脚本一个验服务端、一个验界面：服务端能证明「数据对了」，但 AC-09（清空回滚）与 AC-11（回显 / 台账 / 留痕）的一半是**界面事实**，只能在实际渲染出来的 DOM 上验。
另有集成测试 `apps/api/test/integration/heat-batch-trace-link.test.ts`（真实 PostgreSQL，8 场景：L1/L2/L3 三级链路、多命中取最近终判、跨物料 `GLOBAL`、FAILED 源单排除、`PATCH /header` 留痕、`inheritedFrom` 落库回读、契约逐字段校验），随 `pnpm --filter @letian/api test` 运行。

```bash
node scripts/testing/heat-batch-trace-verify.cjs   # 服务端：41 条
node scripts/testing/oqc-heat-no-ui-verify.cjs     # 界面：20 条（无头 Chrome，CDP_PORT 可覆盖调试端口）
```

## 前置与演示数据

| 项 | 内容 |
|:---|:---|
| 环境 | 后端 `:3100` + 前端 `:5200` 已启动；数据库已迁移到最新（含 `034`） |
| 演示单 | `pnpm db:demo:heat-trace`（幂等）播种五组共 11 张 `TEST2609-` 演示单：组① `TEST-HT-2609-001`（`OQC_HEAT` ×3 + `IQC` ×1 + 出货目标单 + **MRB 未结案的 `OQC_HEAT`**）、组② `TEST-HT-2609-002`（仅 `IQC`）、组③ `TEST-HT-2609-003`（两处均无）、组④ `TEST-HT-2609-004`（**同炉不合格 `OQC_HEAT` + 出货目标单**，供 TBD-01 空态提示用）、组⑤ `OQC-SH-20260923-9005`（AC-08 `inheritedFrom` 留痕验收目标单，验收脚本写入带出标记、终判不落） |
| 清理 | `pnpm db:test:purge`（默认 dry-run；`-- --yes` 先 `pg_dump` 备份再删，删后复查残留与真实行数）；收窄用 `-- --prefix=TEST2609-HT-` |
| 是否写库 | `heat-batch-trace-verify` **是**（会 `PATCH` 一次表头并复位，不落终判）；`oqc-heat-no-ui-verify` **否**（只开录入页、填/清/回填炉号，从不点「提交」） |

## 服务端断言（41 条）

- AC-01：命中 `OQC_HEAT` → `sourceType = OUTSOURCE_HEAT_TREATMENT` + 源单号 + `matchScope = MATERIAL`；
- AC-02：L1 命中时**不混入** L2（IQC）的指标项（`inheritedCodes = []` / `leaked = []`）；
- AC-03：只有 `IQC` 时回退 L2，带出值**与源单逐项一致**（`CHE-002=1.035` / `TEN-002=1022` / `HAR-002=36.05`）；
- AC-04：两处均无 → `NONE` 空态（HTTP 200、无值、不报错）；
- AC-05：同炉批号 3 张 `OQC_HEAT` → 取**最近一次终判**那张（另两张必须排除）；
- AC-06：4 种写法变体（大小写 / 前后空格 / 全角空格 / 纯空格）归一后命中**同一源单**；
- AC-07：FAILED 源单不参与带出（`sourceOrderNo` 缺省，不得被引用为带出源）；
- AC-08：`inheritedFrom` 真写入（组⑤目标单 PATCH 炉号 → 草稿暂存逐项带 `inheritedFrom` / `originalInheritedValue` / `isManuallyModified` → 重开回读断言落库，终判不落可复跑）；
- AC-09：清空炉号 → 200、炉号与留痕一并归零、复位成功；
- AC-10：跨物料命中 → `matchScope = GLOBAL` + `sourceMaterialCode` 回吐；对照项（同物料）仍为 `MATERIAL`；
- AC-11：`PATCH /inspections/{id}/header` 落库 → 重开回显四字段 → 留痕 `heatSourceType` / `heatSourceOrderNo` 落库 → 台账行「炉号」列取真实字段（不回落 `batchNo`）；
- AC-12：`GET /traceability/batches?batchNo={炉批号}` 命中演示批次（`furnace_heat_batch_no` 已入检索面）；
- **TBD-01（同炉异常提示，6 条）**：组①（同炉有 MRB 未结案单）→ 带出照常 + `upstreamWarning.code = UPSTREAM_UNDER_MRB`，文案必须说明「数据来自最近终判合格的记录」；组④（同炉有不合格单）→ 空态 `NONE` + `UPSTREAM_FAILED` 提示且**不带任何值**；对照项证明「不带 `excludeOrderId` 会把本单自己判成上游未终判」——界面因此必须带本单 ID，排除后 AC-04 的静默空态不被污染。

## 界面断言（20 条）

- AC-11：目标单可从台账打开录入页、炉批号回显**库值**（与接口 `furnaceHeatNo` 逐字段相等）、Banner 显示「委外热处理」+ 源单号（修 D8「恒显示来料检验」；`srcLine` 正则同时认「已依据炉号…自动带入」与零带出分支「已按炉号…关联到前道工序检验记录」，两分支都回吐源单据号）、无「加载失败 / 不符合契约」横幅；
- AC-09：清空炉号 → 输入框为空、Banner 消失、带出值与「已手动修改」计数清零；回填后 Banner 恢复；
- AC-04：填上游无记录的炉号 → 界面静默空态（无 Banner、不报错）；
- TBD-03：炉批号标签默认显示 ★（可配置开关 `VITE_OQC_HEAT_NO_REQUIRED` 的默认态，见 `docs/47` §9.2）；
- **TBD-01（同炉异常提示，5 条）**：琥珀色提示条与蓝色带出 Banner **并存**（只提示、不阻断）；空态（组④）只出提示条、不出蓝色 Banner（提示 ≠ 带值）；两条文案分别带上真实命中单号 `OQC-HT-20260923-9104` / `OQC-HT-20260923-9105`；
- 收尾自检：本次界面走查**未改动库中单据**（炉号与状态保持原值）。

## 输出

| 文件 | 说明 |
|:---|:---|
| `heat-batch-trace-verify.log` / `oqc-heat-no-ui-verify.log` | 逐条 PASS / FAIL 明细 |
| `oqc-heat-ui-01-open.png` | 打开录入页：Banner「委外热处理 + 源单号」+ 回显炉号 + ★ |
| `oqc-heat-ui-02-cleared.png` | 清空炉号后：Banner 消失、计数清零 |
| `oqc-heat-ui-03-restored.png` | 回填炉号后：Banner 与联动恢复 |

退出码：`0` = 全通过；`1` = 存在 FAIL；`2` = 探针异常 / 环境不可用。
---

# 十一、MRB「不合格数量」白盒断言（`mrb-defect-qty-verify.cjs`）

`pnpm verify:mrb-defect-qty`（= `node scripts/testing/mrb-defect-qty-verify.cjs`，**只读，不写库**）。

口径唯一真相见 `docs/21` §13.2 / §14.3 / §14.7：MRB 单与不合格台账的「不合格数量」**恒取源检验单的 `fail_qty`**，
台账分母取**抽样数** `sample_qty`（不是报检总数，`docs/03` §2.3），比率随之重算。

为什么单独一个脚本：这条不变式跨三张表（`mrb_reviews` / `pending_mrb_items` / `inspection_orders`），
界面与接口各只看得到自己那一列；写路径一旦再次漂移（§14.2 的缺陷就是时序问题），页面上看不出来。

| 断言 | 内容 |
|:---|:---|
| 基线 | 样本量 > 0（避免空库「假通过」） |
| A | MRB 单 `defect_qty` = 源单 `fail_qty`（来源单已终判不合格且 `fail_qty > 0`），并给出覆盖率 |
| B | 不合格台账 `defect_qty` = 源单 `fail_qty` 且 `total_qty` = 源单 `sample_qty`（分母口径） |
| C | 无孤儿：每条 MRB / 台账都能按 `order_no` / `source_order_id` 命中源单 |
| D | 比率自洽：`defect_rate ≈ round(fail_qty / sample_qty × 100, 4)` |
| E | 可比性清单：来源单「未终判 / 未判不合格」的行无口径可派生，**必须显式列出**（默认提示；`--strict` 下失败） |
| F | `--self-check` **变异自检**：事务内注入 5 处「口径被破坏」的假数据，A~D 必须变红，结束 `ROLLBACK`，库内零改动 |

```bash
pnpm verify:mrb-defect-qty              # 默认：A~D 必须全过，E 仅提示
pnpm verify:mrb-defect-qty -- --strict   # E 非空即失败（用于客户验收 / 上线前）
pnpm verify:mrb-defect-qty -- --self-check
```

退出码：`0` = 断言 A~D 全过；`1` = 存在违规（或 `--strict` 下 E 非空）；`2` = 用法 / IO / 连库失败。

---

# 十二、「合格后传递」链路门禁验收（`transfer-gate-verify.cjs`）

`pnpm verify:transfer-gate`（需要后端 `:3100` + 真实库；**会写库，但只写 `GATE2609-` 前缀夹具**）。

覆盖 `docs/48` §6 的验收用例 **AC-01 ~ AC-13、AC-16 ~ AC-19**（用户点名的这一批），
判据只来自**真实 HTTP 响应 + 真实落库回读**：夹具用 SQL 直插构造上游状态，被测行为的**动作与判据全部走 API**，不绕过门禁。

| 项 | 内容 |
|:---|:---|
| 夹具前缀 | `GATE2609-`（与演示批次 `TEST2609-` 完全隔离：互不覆盖、互不清理） |
| 写库范围 | `inspection_orders` / `mrb_reviews` / `pending_mrb_items` / `batch_trace_nodes` / `audit_logs` / `outbox_events`，**全部带 `GATE2609-` 前缀**，收尾自动清理 |
| 不触碰 | 不进/不改任何无前缀的真实行（`INS-*` / `IQC-*` / `OQC-*` 等） |

关键断言（节选）：

- **AC-01/02/05**：上游合格 / 不合格 / 检验中 / 上游缺失（TBD-01 放行 + `UPSTREAM_MISSING` 显式标记）；
- **AC-06**：台账行同步下发 `canTransfer` / `transferCode` / `chainKey` / `blockedBy`（界面徽标据此渲染）；
- **AC-07/08**：MRB 未结案阻断 → 让步接收**受限放行**（`permitEvidence.kind = MRB_CONCESSION` + `attachmentRequired = true`；授权件被清空后仍 422）；追溯节点由 `FAILED` 升 `CONCESSION`；
- **AC-09/10/11/18**：返工 → 复检单不自锁（`-R{n}` 轮次）→ 复检未终判仍阻断 → 复检合格放行（`predecessorOrderNo` 指向**复检单**）→ 再判不合格一律不放行；源单随闭环归档 `COMPLETED`；
- **AC-12/13**：退货 / 报废 → `422 CHAIN_TERMINATED` + `terminateChain = true`，下游已建未终判单**冻结不删除**（审计留痕 + Outbox `CHAIN_TERMINATED` 带 `frozenOrderNos`）；
- **AC-16**：同批次同环节多张单取**最近一次终判**（与 `created_at` 升序无关），反转后结论随之反转；
- **AC-17**：`GET /release-gates/{batchNo}` 与门禁**同源**：阻断 409 problem+json（`gate-failed` + `gateCode`）、放行 200（`releaseScope = STANDARD` / 特采 `CONCESSION`），且阻断审计不再随异常回滚；
- **AC-19**：并发建单结论一致（同一理由码 + 同一上游单）、无部分写入、放行场景不撞号。

退出码：`0` = 全通过；`1` = 存在 FAIL；`2` = 探针异常 / 环境不可用。
日志：`scripts/logs/transfer-gate-verify.log`（如重定向保存）。
---

# 十三、看板「传递链状态」接口验收（`chain-status-verify.cjs`）

`pnpm verify:chain-status`（需要后端 `:3100` + 演示集 `pnpm db:demo:heat-trace`；**只读，不写库**）。

覆盖 `GET /api/v1/traceability/chain-status`（`docs/48` §4.6 P1 新增）的**契约形状 + 排序 + 口径一致性**：

| 组 | 断言要点 |
|:---|:---|
| 契约 | 必填字段到位（`batchNo` / `anchor` / `stages` / `summary` / `generatedAt`）；`anchor.kind = BATCH`（批次入口） |
| 排序 | `stages` 按工艺序位升序，且**逐环节独立复算**与 `stage-sequence.ts` 同源 |
| **口径同源（核心）** | 同一张单，`chain-status.stages[].decision` 与台账行 `GET /inspections?orderNo=` 的 `canTransfer` / `transferCode` **逐字段一致** —— 两者漂移即「看板说能传、现场建单被拒」 |
| 语义分离 | `state=BLOCKED` 必须对应环节**自身**判定码（`stateCode`，如 `UPSTREAM_FAILED`），`summary.blockedBy` 取同一码；**不得**下发「进入该环节的闸门码」（历史缺陷：`state=BLOCKED` 却给 `UPSTREAM_MISSING`） |
| 状态 vs 闸门 | 出货单自身检验中 → `state=PENDING`，同时其闸门 `decision.allowed=true`（两个问题分别回答） |
| 空态 / 校验 | 未知批次 → 200 + `stages=[]` + `summary.state=MISSING`；缺 `batchNo` → 400；无 token → 401 |

退出码：`0` = 全通过；`1` = 存在 FAIL；`2` = 探针异常 / 环境不可用。

# 十四、质量追溯看板「传递链闸门」界面级验收（oard-transfer-gate-ui-verify.cjs）

`pnpm verify:board-transfer-gate`（需要前端 :5200 + 后端 :3100 + 本地 Chrome；**纯只读 DOM，不写库**）。

基于 Chrome DevTools Protocol（CDP）对 http://127.0.0.1:5200 质量追溯看板进行无头走查，覆盖 4 类典型业务链路的**端到端渲染事实**：

| 场景 | 批次 | 验证断言 |
|:---|:---|:---|
| **A. 放行态** | TEST2609-001 | 成功开图；顶栏呈现「传递链闸门（合格后传递）」区块；状态徽标「已放行」；展示 BATCH 锚点 |
| **B. 阻断态** | TEST2609-020 | 顶栏呈现「传递链闸门」区块；状态徽标「已阻断」；汇总统计「阻断 1」 |
| **C. 终止态** | TEST2609-018 | 呈现「整链已终止（MRB 退货 / 报废），下游禁止建单、已建单需冻结」红色告警；状态徽标「链路终止」 |
| **D. 检验中态** | TEST2609-002 | 顶栏呈现「传递链闸门」区块；状态徽标「检验中」；汇总统计「检验中 1」 |

退出码：  = 16/16 全通过；1 = 存在 FAIL；2 = CDP 异常 / 环境不可用。
日志：scripts/logs/board-transfer-gate-ui-verify.log。
