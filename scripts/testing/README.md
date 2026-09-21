# scripts/testing —— 质检台账端到端校验与源码审计（只读）

本目录脚本用于回答两类「不能靠肉眼判断」的问题：

1. **台账页面的字段到底是不是从数据库读出来的？**（`*-verify.cjs`，CDP 驱动无头浏览器）
2. **代码规范口径是否属实？**（`audit_check.js`，源码静态审计）

前置条件：后端 `:3100`、前端 `:5200` 已启动（`pnpm --filter @letian/api run dev` / `pnpm --filter @letian/web run dev`），
本机已安装 Chrome（默认 `C:\Program Files\Google\Chrome\Application\chrome.exe`）。

```bash
node scripts/testing/oqc-verify.cjs           # 出货检验（OQC）台账
node scripts/testing/inspections-verify.cjs  # 来料检验（IQC）+ 委外检验台账
node scripts/testing/audit_check.js          # 源码静态审计
```

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

## 输出

| 文件 | 说明 |
|:---|:---|
| `oqc-list-after-rename.png` | 出货检验台账截图 |
| `iqc-list-after-wiring.png` | 来料检验台账截图 |
| `outsource-list-after-wiring.png` | 委外检验台账截图 |
| `oqc-verify.log` / `inspections-verify.log` | 逐条 PASS / FAIL 明细 |

## 断言口径（为什么这么测）

- **页面条数必须等于接口 `total`**：若前端自行二次过滤，`total` 与检索范围都会失真；
- **入库单号 / 委外加工单号 / 回厂日期不得是推导值**：历史实现用 `'RK-' + 检验单号` 合成入库单号、
  用 `batch_no` 顶替委外加工单号、用 `created_at` 顶替回厂日期——这些都会让「链路是否真打通」无法判断；
- **ERP状态列必须等于接口 `erpStatus`**：该列只能来自库列 `erp_status`，不得由质检结论反推。

完整设计与验收记录见 `docs/16-出货检验OQC数据字段与接口打通设计.md`（§7.11 / §7.13）。

---

# 二、源码静态审计（`audit_check.js`）

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
