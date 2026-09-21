# scripts/testing —— 台账端到端渲染校验（CDP 驱动，只读）

这些脚本用无头 Chrome（CDP）打开 `http://127.0.0.1:5200/`，登录后读取真实渲染的 DOM，
把**页面列值**与 **`GET /api/v1/inspections` 的返回值**逐行对账，用来回答一个具体问题：
「页面上的字段到底是不是从数据库读出来的」。

**脚本只做导航 + 读 DOM + 调只读接口，不写库、不改接口。**

## 前置条件

1. 后端 `:3100` 与前端 `:5200` 已启动：

   ```bash
   pnpm --filter @letian/api run dev
   pnpm --filter @letian/web run dev
   ```

2. 本机已安装 Chrome（默认路径 `C:\Program Files\Google\Chrome\Application\chrome.exe`）。

## 用法

```bash
# 出货检验（OQC）台账：列名口径 + 首列单号来源 + ERP状态/销售出库单号逐行对账
node scripts/testing/oqc-verify.cjs

# 来料检验（IQC）+ 委外检验台账：列名 / 条数 / 是否使用推导伪造值
node scripts/testing/inspections-verify.cjs
```

脚本退出码 `0` = 全部断言通过，非 `0` = 存在 FAIL（明细见输出与日志文件）。

## 输出

截图与日志写入 `scripts/logs/`（该目录已被 `.gitignore` 忽略）：

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
