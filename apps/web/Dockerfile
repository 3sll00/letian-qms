# ==============================================================================
# 乐天 QMS 前端镜像（Vite 静态产物 + nginx 反代 /api）
#
# 构建上下文必须是 monorepo 根目录：
#   docker build -f apps/web/Dockerfile -t letian-qms-web .
#
# 浏览器端使用相对路径 /api/v1（resolveApiBase 第 4 级回退），由 nginx
# 反代到 api 容器；如需把 API 地址固化进产物，可用构建参数 VITE_API_BASE。
# ==============================================================================

# ------------------------------------------------------------------------------
# 构建阶段：安装依赖 -> vite build
# ------------------------------------------------------------------------------
FROM node:20-alpine AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/domain/package.json packages/domain/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
# vite.config / tsconfig 的 paths 直接引用 packages 源码，编译期必须带上
COPY packages/contracts ./packages/contracts
COPY packages/domain ./packages/domain
COPY apps/web ./apps/web

# 可选：构建期固化 API 基址（内网浏览器部署直连后端域名时用；
# 缺省走相对路径 /api/v1 + nginx 反代，桌面客户端不受此影响）
ARG VITE_API_BASE=""
ENV VITE_API_BASE=$VITE_API_BASE

RUN pnpm --filter @letian/web run build

# ------------------------------------------------------------------------------
# 运行阶段：nginx 托管静态产物并反代 /api
# ------------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
