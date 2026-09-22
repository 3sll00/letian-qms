# 乐天质量管理系统 (Letian QMS) —— 自动化走查与界面验收截图

本目录的截图由 `scripts/testing/cdp-runner.js`（基于 Chrome DevTools Protocol 的无头浏览器走查脚本）
在**真实前后端联动**环境下自动捕获：前端 `vite dev`（`:5200`，`/api` 反向代理到 `:3100`）+ 真实 Fastify API + 真实 PostgreSQL。

```bash
# 前置：Web dev server 与 API 均已启动（脚本会自动探测 5200 / 5201 / 5202）
node scripts/testing/cdp-runner.js

# 指定前端地址与调试端口
WEB_BASE=http://127.0.0.1:5201/ CDP_PORT=9222 node scripts/testing/cdp-runner.js
```

脚本会依次执行 7 项走查并覆盖本目录下对应的 PNG 资产，**退出码 0 = 7 项全部通过且无未捕获运行时异常**，
非 0 表示存在失败项（旧版脚本无论成败都以 0 退出，故当时的「全部 PASSED」不可证伪）。

---

## 截图清单与走查项说明

| 截图文件名 | 走查项 | 验证的核心要素 | 2026-09-22 实测 |
| :--- | :--- | :--- | :---: |
| `screenshot_01_dashboard.png` | 1. 系统导航与主骨架 | 全局侧边栏导航加载、页面标题、无白屏 | **PASS** |
| （无独立截图） | 2. 检验进度总览 KPI 与 ECharts | 总检验单数 / 待检验 / 合格率等 KPI 文案 + ECharts canvas 渲染 | **PASS** |
| `screenshot_02_iqc.png` | 3. 来料检验台账 | 十列表头（含「检验单号」「入库单号」）、数据行非空 | **PASS** |
| `screenshot_03_oqc.png` | 4. 出货检验台账 | 首列表头为「检验单号」、数据行非空 | **PASS** |
| `screenshot_04_mrb.png` | 5. MRB 不合格品处置 | 页面渲染出评审/不合格等业务要素 | **PASS** |
| `screenshot_05_traceability.png` | 6. 质量追溯看板 | 批次检索输入框就绪 | **PASS** |
| `screenshot_06_plans.png` | 7. 质检方案设计 | 方案/抽样/版本等特征文案 | **PASS** |

实测结果：**7/7 PASS，未捕获运行时异常 0 条**（2026-09-22 在 `:5200` 真实前后端联动环境整体重跑后重新捕获，
明细见 `scripts/logs/cdp-runner.log`）。

---

## 关于历史截图

2026-09-17 生成的 `screenshot_02_inspections.png`、`screenshot_03_mrb.png`、`screenshot_04_traceability.png`、
`screenshot_05_plans.png`、`screenshot_06_integration.png` 已删除：这 5 张文件大小均为 2163 字节
（基本是空白/未渲染页），却在此前的说明里被标注为 `PASSED`，属不可信产物。当前清单中的截图均为十余万字节的真实渲染结果。
脚本侧也同步修正了三个可信度问题：**失败即非 0 退出**、**未捕获异常纳入判定**、**导航关键词随 UI 更名同步**。
