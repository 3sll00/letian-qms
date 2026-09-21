# scripts/testing —— 质检台账端到端校验与源码审计（只读）

本目录脚本用于回答两类「不能靠肉眼判断」的问题：

1. **台账页面的字段到底是不是从数据库读出来的？**（`*-verify.cjs`，CDP 驱动无头浏览器）
2. **代码规范口径是否属实？**（`audit_check.js`，源码静态审计）

前置条件：后端 `:3100`、前端 `:5200` 已启动（`pnpm --filter @letian/api run dev` / `pnpm --filter @letian/web run dev`），
本机已安装 Chrome（默认 `C:\Program Files\Google\Chrome\Application\chrome.exe`）。

```bash
node scripts/testing/oqc-verify.cjs           # 出货检验（OQC）台账
node scripts/testing/inspections-verify.cjs  # 来料检验（IQC）+ 委外检验台账
node scripts/testing/mrb-verify.cjs          # MRB 不合格品处置（离线 Mock 模式）
node scripts/testing/mrb-wiring-verify.cjs   # MRB 字段 / 契约 / API 打通验收（真实库 + 真实 HTTP）
node scripts/testing/audit_check.js          # 源码静态审计
```

前三个脚本需要后端 `:3100` 与前端 `:5200` 已启动；`mrb-wiring-verify.cjs` 需要**后端 API 已启动**（默认 `:3101`）
且数据库已迁移至 `015` 并执行过 `pnpm db:seed`（脚本按演示数据断言，跑完会还原数据）。
根脚本入口：`pnpm run verify:oqc` / `verify:inspections` / `verify:mrb` / `verify:mrb-wiring` / `audit:code`。

退出码 `0` = 通过，非 `0` = 存在 FAIL / 超预算（明细见输出与 `scripts/logs/`，该目录已 gitignore）。

---

# 一、台账渲染校验（`oqc-verify.cjs` / `inspections-verify.cjs`）

用无头 Chrome 打开 `http://127.0.0.1:5200/`，登录后读取真实渲染的 DOM，
把**页面列值**与 **`GET /api/v1/inspections` 的返回值**逐行对账。
**只做导航 + 读 DOM + 调只读接口，不写库、不改接口。**

| 脚本 | 覆盖范围 | 断言数 |
|:---|:---|:---|
| `oqc-verify.cjs` | 出货检验台账 | 8 |
| `inspections-verify.cjs` | 来料检验 + 委外检验台账 | 10 |
| `mrb-verify.cjs` | MRB 不合格品处置单页（离线 Mock） | 15 |

## 输出

| 文件 | 说明 |
|:---|:---|
| `oqc-list-after-rename.png` | 出货检验台账截图 |
| `iqc-list-after-wiring.png` | 来料检验台账截图 |
| `outsource-list-after-wiring.png` | 委外检验台账截图 |
| `oqc-verify.log` / `inspections-verify.log` | 逐条 PASS / FAIL 明细 |
| `mrb-list-light.png` / `mrb-list-under-review.png` / `mrb-pool-drawer.png` / `mrb-review-drawer.png` | MRB 页面与两个抽屉截图 |
| `mrb-mock-verify.log` | MRB 逐条 PASS / FAIL 明细 |

### MRB 走查为什么跑在离线 Mock 模式

`mrb-verify.cjs` 校验的是「页面结构 + 抽屉取数链路」，不依赖数据库，因此跑在 `pnpm --filter @letian/web run dev:mock`
（MSW 离线 Mock）上，且把 `VITE_API_TARGET` 指向未监听端口——否则未被 mock 的接口会打到真实后端并返回 401，
前端的安全登出逻辑会把会话清掉、页面退回登录页，走查结果不可信。断言覆盖：页头标题/副标题、十列表头（第 5 列为
「不合格原因」）、4 个状态页签与默认选中项、5 张 KPI 卡、浅色主题（页面子树无深色容器）、
「发起评审」抽屉的待审核池取数、行内「评审」抽屉的四方会签席位。

## 断言口径（为什么这么测）

- **页面条数必须等于接口 `total`**：若前端自行二次过滤，`total` 与检索范围都会失真；
- **入库单号 / 委外加工单号 / 回厂日期不得是推导值**：历史实现用 `'RK-' + 检验单号` 合成入库单号、
  用 `batch_no` 顶替委外加工单号、用 `created_at` 顶替回厂日期——这些都会让「链路是否真打通」无法判断；
- **ERP状态列必须等于接口 `erpStatus`**：该列只能来自库列 `erp_status`，不得由质检结论反推。

完整设计与验收记录见 `docs/16-出货检验OQC数据字段与接口打通设计.md`（§7.11 / §7.13）。

---

# 二、MRB 字段 / 契约 / API 打通验收（`mrb-wiring-verify.cjs`）

（等价入口：`pnpm run verify:mrb-wiring`）

回答的是「MRB 不合格品处置页的每个字段，是不是真的落到了 PostgreSQL 物理列、由 Fastify 接口读写」——
**真实数据库 + 真实 HTTP**（不使用 Mock），20 条断言覆盖：

1. `GET /mrb/pending-pool` 回吐 015 新增列（供应商 / 客户 / 不合格指标项 / 检验人 / 受检数量 / 不良率）与环节前缀筛选；
2. `GET /mrb/records` 回吐派生 `inspectorName` 与新增 `urgencyLevel` / `reviewFlowId`；
3. `POST /mrb/pending-pool/initiate` 的 `flowId` / `urgencyLevel` / `reviewNotes` / `pendingDefectId` **逐列落库**，池条目转 `INITIATED` 并回填 MRB 单；
4. `POST /mrb/records/{id}/sign` 会签转 `UNDER_REVIEW`；
5. 特采无客户凭证必须 `400 CONCESSION_NOT_SIGNED_OFF`（不得有伪造兜底）；带凭证处置返回**裸 `MRBRecord`** 且 `disposed_at` / `disposed_by` / 附件按提交值落库。

```bash
# 前置：数据库已迁移到 015 且执行过 pnpm db:seed；目标 API 已启动
pnpm run verify:mrb-wiring

# 指定非默认端口的 API（默认 http://127.0.0.1:3101/api/v1）
MRB_WIRING_BASE=http://127.0.0.1:3102/api/v1 node scripts/testing/mrb-wiring-verify.cjs
```

脚本自带清理：跑完把验收产生的 MRB 删除、池条目回 `PENDING_INITIATE`、工单回 `FAILED`，可反复执行。
完整口径见 `docs/21-MRB不合格品处置数据字段与接口打通设计.md` §7。

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
