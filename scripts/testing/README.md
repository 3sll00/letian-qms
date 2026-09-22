# scripts/testing —— 质检台账端到端校验与源码审计（只读）

本目录脚本用于回答两类「不能靠肉眼判断」的问题：

1. **台账页面的字段到底是不是从数据库读出来的？**（`*-verify.cjs`，CDP 驱动无头浏览器）
2. **代码规范口径是否属实？**（`audit_check.js`，源码静态审计）

前置条件：后端 `:3100`、前端 `:5200` 已启动（`pnpm --filter @letian/api run dev` / `pnpm --filter @letian/web run dev`），
本机已安装 Chrome（默认 `C:\Program Files\Google\Chrome\Application\chrome.exe`）。

```bash
node scripts/testing/oqc-verify.cjs           # 出货检验（OQC）台账
node scripts/testing/inspections-verify.cjs  # 来料检验（IQC）+ 委外检验台账
node scripts/testing/ipqc-ledger-verify.cjs  # 过程检验（IPQC）下料 / 滚丝 / 成品检三页台账
node scripts/testing/mrb-verify.cjs          # MRB 不合格品处置（离线 Mock 模式）
node scripts/testing/mrb-wiring-verify.cjs   # MRB 字段 / 契约 / API 打通验收（真实库 + 真实 HTTP）
node scripts/testing/audit_check.js          # 源码静态审计
```

前三个脚本需要后端 `:3100` 与前端 `:5200` 已启动；`mrb-wiring-verify.cjs` 需要**后端 API 已启动**（默认 `:3101`，
用 `PORT=3101 pnpm --filter @letian/api run dev` 另起一个实例，勿指向常驻 `:3100`）且数据库已迁移到最新并执行过
`pnpm db:seed`（脚本按演示数据断言，跑完会还原数据；自建来源单的验收行亦同批清理）。
根脚本入口：`pnpm run verify:oqc` / `verify:inspections` / `verify:ipqc-ledger` / `verify:mrb` / `verify:mrb-wiring` / `audit:code`。

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
| `ipqc-ledger-verify.cjs` | 过程检验**三页**台账（下料 / 滚丝 / 成品检；11 列列集 + 逐列对账 + 无伪造值守门 + 筛选落 SQL + 建单写路径往返） | 29 |
| `mrb-verify.cjs` | MRB 不合格品处置单页 + 并列菜单「评审流程设置」子页 + 返工处置回吐复检单号（离线 Mock） | 23 |

## 输出

| 文件 | 说明 |
|:---|:---|
| `oqc-list-after-rename.png` | 出货检验台账截图 |
| `iqc-list-after-wiring.png` | 来料检验台账截图 |
| `outsource-list-after-wiring.png` | 委外检验台账截图 |
| `ipqc-blanking-ledger.png` / `ipqc-rolling-ledger.png` / `ipqc-finished-ledger.png` | 过程检验三页台账截图（下料 / 滚丝 / 成品检，各 11 列） |
| `oqc-verify.log` / `inspections-verify.log` | 逐条 PASS / FAIL 明细 |
| `mrb-list-light.png` / `mrb-list-under-review.png` / `mrb-pool-drawer.png` / `mrb-review-drawer.png` / `mrb-disposition-rework.png` / `mrb-workflow-light.png` | MRB 页面、两个抽屉、**返工处置成功横幅（复检单号）**与「评审流程设置」子页截图 |
| `mrb-mock-verify.log` | MRB 逐条 PASS / FAIL 明细 |

### MRB 走查为什么跑在离线 Mock 模式

`mrb-verify.cjs` 校验的是「页面结构 + 抽屉取数链路」，不依赖数据库，因此跑在 `pnpm --filter @letian/web run dev:mock`
（MSW 离线 Mock）上，且把 `VITE_API_TARGET` 指向未监听端口——否则未被 mock 的接口会打到真实后端并返回 401，
前端的安全登出逻辑会把会话清掉、页面退回登录页，走查结果不可信。断言覆盖：页头标题/副标题、十列表头（第 5 列为
「不合格原因」）、4 个状态页签与默认选中项、5 张 KPI 卡、浅色主题（页面子树无深色容器）、
「发起评审」抽屉的待审核池取数、行内「评审」抽屉的四方会签席位。

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
**真实数据库 + 真实 HTTP**（不使用 Mock），35 条断言覆盖：

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
