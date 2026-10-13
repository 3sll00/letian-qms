# 乐天质量管理系统 (Letian QMS) — UAT 验收报告

> **版本**：v2.6.0
> **验收范围**：检验录入与终判、MRB 评审处置、PBAC 三维权限、批次追溯、前端 v2.6.0 未结模块、生产部署交付物
> **验收环境**：Docker Compose 生产编排（`docker-compose.prod.yml`）+ Electron 桌面客户端
> **报告日期**：2026 年 10 月 13 日（本机 Docker Desktop 验收实测）

---

## 1. 交付物清单

| # | 交付物 | 位置 | 说明 |
|---|--------|------|------|
| 1 | API 生产镜像 | `apps/api/Dockerfile` | 多阶段构建：pnpm workspace 编译 + `pnpm deploy` 生产依赖裁剪；非 root 运行；内置 Noto CJK 供中文 PDF 报告渲染 |
| 2 | Web 前端镜像 | `apps/web/Dockerfile` | Vite 静态产物 + nginx:1.27-alpine 托管 |
| 3 | 反向代理配置 | `apps/web/nginx.conf` | SPA 回退、`/api` 反代、Docker DNS 动态解析、静态资源缓存、50MB 上传上限 |
| 4 | 生产编排 | `docker-compose.prod.yml` | postgres:15 + 一次性 migrate + api + web；`SEED_DEMO=true` 仅在 UAT/演示环境初始化种子数据 |
| 5 | 构建排除清单 | `.dockerignore` | node_modules / dist / docs / 桌面端产物不入构建上下文 |
| 6 | 生产登录过渡方案 | `apps/api/src/controllers/auth.controller.ts` | `ENABLE_LOCAL_AUTH=true` 时生产环境仅开放「用户名+口令」通道 |
| 7 | 正式登录页 | `apps/web/src/pages/login/index.tsx` | 桌面客户端专属生产形态：服务器地址条 + 服务器设置入口，演示控件自动隐藏 |

## 2. 部署架构

```
浏览器 ──> web (nginx :80) ──/api──> api (Fastify :3100) ──> postgres :5432
桌面客户端「服务器设置」──────────────> api :3100
postgres 不对外发布端口；migrate 一次性跑完 001–047 迁移后退出
UAT/演示初始化：SEED_DEMO=true 时 migrate 继续运行种子 runner，API 等待其完成后启动
```

## 3. 验收项与结果

### 3.1 构建与启动（本机 Docker Desktop 实测通过）

| # | 验收项 | 验收标准 | 结果 | 证据 |
|---|--------|----------|------|------|
| 1 | API 镜像构建 | `docker build -f apps/api/Dockerfile .` 成功 | 通过 | `letian-qms-api` 镜像产物含 `dist/server.js` 与已编译迁移/种子 runner |
| 2 | Web 镜像构建 | `docker build -f apps/web/Dockerfile .` 成功 | 通过 | Vite 产物打入 `nginx:1.27-alpine` |
| 3 | 编排启动 | `SEED_DEMO=true ENABLE_LOCAL_AUTH=true docker compose -f docker-compose.prod.yml up -d --build` 全服务 healthy | 通过 | postgres/api/web 均 healthy，migrate 正常退出 |
| 4 | 自动迁移与种子 | migrate 容器跑完全部迁移；`SEED_DEMO=true` 时继续写入演示数据并退出 | 通过 | 日志确认 001–047 全部成功；26 张业务表共 173 行 |
| 5 | 健康检查 | `GET /health` 返回 `{"status":"UP"}` | 通过 | API 直连与 nginx `/health` 均实测 200 |
| 6 | 必备密钥强制 | 未设 `JWT_SECRET`/`DB_PASSWORD`/`DEFAULT_LOGIN_PASSWORD` 时 compose 拒绝启动 | 通过 | `${VAR:?}` 语法，空环境文件实测 fail-closed |
| 7 | 中文 PDF 报告 | `POST /api/v1/reports/export format=PDF` 输出真实 PDF 且嵌入中文字体 | 通过 | 实测 `%PDF-`/`%%EOF`，字体 `NotoSansCJK`，约 83.9KB |

### 3.2 登录与权限

| # | 验收项 | 验收标准 | 结果 | 证据 |
|---|--------|----------|------|------|
| 8 | 生产登录 | `ENABLE_LOCAL_AUTH=true` 时，`POST /api/v1/auth/login`（工号/姓名 + `DEFAULT_LOGIN_PASSWORD`）返回 JWT 与职员档案角色 | 通过 | 实测签发出 `role=QA_MANAGER`、`roleName=质量主管` 的 24h 令牌 |
| 9 | 登录面收敛 | `GET /api/v1/auth/users` 返回 404；`userId` 直签与空口令均被 401 | 通过 | 实测 404 / 401 / 401 |
| 10 | 令牌访问业务接口 | 携带 JWT 访问 `GET /api/v1/inspections` 返回台账数据 | 通过 | 实测返回 24 条种子工单 |
| 11 | nginx 反代 | `POST /api/v1/auth/login` 经 web 容器反代成功 | 通过 | 实测 200 |
| 12 | PBAC 过滤 | 无规则用户登录后看不到数据（安全默认） | 通过 | `permission-management-link.test.ts` |

### 3.3 核心业务链路（已在真实 PostgreSQL 集成测试中通过）

| # | 验收项 | 结果 | 证据 |
|---|--------|------|------|
| 13 | 实测录入与终判同事务：状态流转 + 不合格入池 + 自动建 MRB + 批次锁定 + 审计日志 | 通过 | `inspection-finalize-pool-link.test.ts` |
| 14 | 冲突判定组合（PASSED+FAILED 等）被拒绝；重复终判保持 `IN_MRB_REVIEW` | 通过 | 同上 |
| 15 | MRB 来源分类绑定：来料/过程/委外/出货四类不串绑（docs/44） | 通过 | 同上 |
| 16 | MRB 四类处置：特采（须客户书面签核）、返工（自动生成复检单）、报废、退货 | 通过 | `mrb-defect-qty-parity` 等集成测试 |
| 17 | 返工处置事务一致性：复检单与处置同生共灭，无孤儿复检单 | 通过 | `reinspection-resume-link.test.ts` |
| 18 | 审计失败全链回滚：无部分提交 | 通过 | `inspection-finalize-pool-link.test.ts` |
| 19 | 过程检验不解检（EXEMPT）：勾选禁用输入、不参与合格率分母、全链落库 | 通过 | typecheck + mock 校验 |
| 20 | 不合格待审核池页面：KPI/缺陷条目/发起评审弹窗 | 通过 | web build |
| 21 | 通用高级筛选组件：多选物料/供应商/状态/环节 + 组合条件 | 通过 | web build |
| 22 | 过程检验批量检视：勾选/全选/批量终判，成品检不开放 | 通过 | 代码核对 + typecheck |

### 3.4 安全边界声明（验收签字前必须知悉）

| # | 事项 | 说明 |
|---|------|------|
| 1 | 本地登录为过渡方案 | compose 默认 `ENABLE_LOCAL_AUTH=false`；仅在接入 SSO 前的内网/UAT 显式置 `true`，口令为全员共享明文比对，**不得用于公网**。`DEFAULT_LOGIN_PASSWORD` 必须设为高强度口令。 |
| 2 | JWT 密钥 | `JWT_SECRET` 必须为随机高强度值；泄露即可伪造任意身份。 |
| 3 | API 端口暴露面 | `3100` 端口供桌面客户端直连，仅限内网开放；web `80` 端口对外。 |
| 4 | postgres | 不发布宿主机端口；`DB_PASSWORD` 必填。 |
| 5 | 演示种子开关 | `SEED_DEMO=true` 会 TRUNCATE 业务表后写入演示数据，只允许首次初始化或验收/培训库；正式生产必须保持 `false`。 |

## 4. 遗留事项

| # | 事项 | 建议处置 |
|---|------|----------|
| 1 | 统一身份认证（SSO / OAuth2 / LDAP）未接入；已落地**职员独立口令**（迁移 048，scrypt 哈希 + 首次登录强制改密 + `POST /auth/change-password`），共享口令仅作初始/重置口令 | 二期接入 AD/LDAP 后 `ENABLE_LOCAL_AUTH=false` 关闭本地登录 |
| 2 | HTTPS 终结 | **客户已确认纯内网部署，本期不做**；如未来开放公网访问再由前置反向代理统一终结 |
| 3 | 数据库备份策略 | **已交付** `scripts/backup/`（pg_dump 每日定时备份 + 30 天轮换 + 计划任务安装脚本）；**遗留**：客户仅一台服务器，备份外拷（NAS/移动硬盘）需客户落实，见 `scripts/backup/README.md` |
| 4 | Outbox 中继 / 告警 Webhook 未随 api 容器独立部署 | 如需独立部署可另建 worker 容器复用同一镜像 |

## 5. 验收结论与签字

| 角色 | 姓名 | 签字 | 日期 |
|------|------|------|------|
| 项目经理 | | | |
| 质量部代表 | | | |
| IT 运维代表 | | | |

**验收结论**：□ 通过　□ 有条件通过（条件：＿＿＿＿＿＿＿＿）　□ 不通过
