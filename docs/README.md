# 乐天质量管理系统 (Letian QMS) - 文档中枢索引

本项目严格遵循 **“文档先行、口径统一、最高权威”** 原则。所有业务定义、数据模型与技术架构变更均以此文档库为准。

---

## 核心技术与业务规范文档

1. **[01-PRD.md](./01-PRD.md)**: 产品需求规格说明书（业务背景、9 大领域模型、21 项核心功能完整定义、关键质检放行阻断规则）
2. **[02-技术架构.md](./02-技术架构.md)**: 系统技术架构设计（六边形架构 Ports & Adapters、DDD 领域分层、Fastify + Kysely + PostgreSQL 规范、Outbox 模式）
3. **[03-数据模型.md](./03-数据模型.md)**: 数据库模型与实体设计（20+ 张核心数据表、Kysely 类型安全定义、Migrations 001~004 演进设计）
4. **[04-API与导入规范.md](./04-API与导入规范.md)**: 统一 RESTful API 契约设计、RFC 7807 统一错误响应、Excel/CSV 批量导入与事务回滚规范
5. **[05-验收用例.md](./05-验收用例.md)**: 全流程自动化验收用例设计、CDP 浏览器端到端巡检通过记录、6 大核心模块全屏截图证据链
6. **[06-AI开发任务.md](./06-AI开发任务.md)**: AI 协同开发规程、Prompt 模板工程、代码质量与强类型审计规程（无 any、无 @ts-ignore）
7. **[07-数据库准备与接口配置.md](./07-数据库准备与接口配置.md)**: 数据库连接池参数配置、管家婆 ERP (SQL Server) 只读下推直连配置、现场测试库实测对账报告
8. **[08-Windows-Linux部署与迁云.md](./08-Windows-Linux部署与迁云.md)**: 车间 Windows NSSM 服务自启、Linux Docker Compose 生产部署、桌面客户端打包与混合云迁云方案
9. **[09-界面与开源组件.md](./09-界面与开源组件.md)**: Ant Design 5 / TailwindCSS / ECharts 5 组件规范、21 张 WPS 原型图 1:1 业务功能对照表
10. **[10-前端性能优化设计.md](./10-前端性能优化设计.md)**: 质量总览大屏 Canvas 局部刷新调优、超大明细表格虚拟滚动（Virtual List）、Vite Manual Chunks 切片
11. **[11-服务端会话缓存设计.md](./11-服务端会话缓存设计.md)**: Fastify 无状态 JWT 双令牌机制、PBAC 物料三维数据权限本地高速 LRU 缓存与失效机制
12. **[12-库存计算优化与反范式设计.md](./12-库存计算优化与反范式设计.md)**: 本地库存中间态快照镜像、批次追溯 DAG 传递闭包物化表、强制放行状态预物化计算
13. **[13-网络传输压缩与筛选项缓存设计.md](./13-网络传输压缩与筛选项缓存设计.md)**: Gzip / Brotli 传输压缩配置、Fast-Json-Stringify 极速序列化、ERP 主数据下拉筛选项二级缓存

---

## 实施追踪与澄清纪要

- **[实施进度.md](./实施进度.md)**: 项目里程碑推进跟踪表、21 项核心功能交付状态（100% 全部交付）
- **[需求澄清记录.md](./需求澄清记录.md)**: 2026-09-18 需求评审会议纪要、炉批号继承规则、免检放行逻辑、MRB 评审流决策

---

## 资源目录与原型资产

- **[api/](./api/letian-qms-openapi.yaml)**: OpenAPI 3.0 全量接口契约定义
- **[prototypes/](./prototypes/README.md)**: 21 张高保真 UI 原型设计资产（WPS图片 1~21）
- **[screenshots/](./screenshots/README.md)**: 6 大业务模块端到端自动化巡检验证截图
- **[requirements/](./requirements/README.md)**: 原始需求 Word 方案表、确认文档及数据字典
- **[architecture/](./architecture/letian-qms-architecture.html)**: 系统架构图谱 HTML 交互式可视化页面
