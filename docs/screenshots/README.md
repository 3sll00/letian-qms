# 乐天质量管理系统 (Letian QMS) - 自动化巡检与界面验收截图

本目录保存通过基于 Chrome/Edge DevTools Protocol (CDP) 的无头浏览器自动化巡检测试脚本（`scripts/testing/cdp-runner.js`）实时捕获的高清验收截图。所有截图均在生产构建后的纯净前端容器与后端 API 真实联动环境下录制，真实反映系统运行状态与验收通过结果。

---

## 截图清单与验收项说明

| 截图文件名 | 验证测试项 | 验证的核心模块与功能要素 | 验证结果 |
| :--- | :--- | :--- | :---: |
| `screenshot_01_dashboard.png` | 测试 1: 系统导航与主骨架 | 验证全局侧边栏导航加载、Header 仪表盘统计卡片、趋势图与系统框架无白屏。 | **PASSED** |
| `screenshot_02_inspections.png` | 测试 3: 检验工单管理模块 | 验证来料/过程/出货工单列表渲染、状态标签着色、质检项动态展开与录入抽屉。 | **PASSED** |
| `screenshot_03_mrb.png` | 测试 4: MRB 不合格品评审模块 | 验证待审核池统一汇聚、MRB 评审卡片、处置类型下拉与流程节点状态机交互。 | **PASSED** |
| `screenshot_04_traceability.png` | 测试 5: 批次双向追溯与血缘模块 | 验证批次号/炉批号搜索交互框、全流程拓扑追溯链渲染与关键节点状态显示。 | **PASSED** |
| `screenshot_05_plans.png` | 测试 6: 检验方案与抽样标准模块 | 验证存货分类绑定、AQL 规则配置、检验项目六维指标库与版本切换操作。 | **PASSED** |
| `screenshot_06_integration.png` | 测试 7: 系统集成与 Outbox 模块 | 验证管家婆 ERP / 委外系统集成适配器状态、Transactional Outbox 事件池列表。 | **PASSED** |

---

## 自动化重新捕获机制

若后续对 UI 或后端逻辑进行了迭代，可进入 `scripts/testing/` 运行自动化巡检测试重新生成本目录下的所有截图：

```bash
# 确保前后端服务已在对应端口运行
node scripts/testing/cdp-runner.js
```
脚本将连接 Chrome/Edge 调试端口，自动依次执行 7 组端到端交互测试并刷新覆盖本目录下的 PNG 资产。
