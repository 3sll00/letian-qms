# ==============================================================================
# 乐天 QMS 后端镜像（Fastify API + 已编译迁移/种子 runner）
#
# 构建上下文必须是 monorepo 根目录：
#   docker build -f apps/api/Dockerfile -t letian-qms-api .
#
# 产物布局（pnpm deploy 展开的独立部署目录，workspace 依赖已内联为真实目录）：
#   /app/dist/server.js                                        API 入口
#   /app/node_modules/@letian/infrastructure/dist/migrations/runner.js   迁移 runner
#   /app/node_modules/@letian/infrastructure/dist/seeds/runner.js        种子 runner（演示数据，生产慎用）
# ==============================================================================

# ------------------------------------------------------------------------------
# 构建阶段：安装全部依赖 -> 编译 @letian/api 及其 workspace 依赖 -> pnpm deploy
# ------------------------------------------------------------------------------
FROM node:20-alpine AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

WORKDIR /app

# 先只复制清单文件，最大化利用 pnpm install 的层缓存
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/domain/package.json packages/domain/
COPY packages/application/package.json packages/application/
COPY packages/infrastructure/package.json packages/infrastructure/
COPY apps/api/package.json apps/api/

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api

# 按依赖拓扑顺序编译 contracts -> domain -> application -> infrastructure -> api
RUN pnpm -r --filter '@letian/api...' run build

# 导出仅含生产依赖的独立目录（workspace:* 被展开为真实文件，可直接 node 运行）
RUN pnpm deploy --filter @letian/api --prod /prod/api

# ------------------------------------------------------------------------------
# 运行阶段：非 root 用户，只携带部署目录
# ------------------------------------------------------------------------------
FROM node:20-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

# PDFKit 内建 Helvetica 不含 CJK 字形；正式检验报告必须能渲染中文
RUN apk add --no-cache font-noto-cjk \
  && addgroup -S letian && adduser -S letian -G letian
COPY --from=build --chown=letian:letian /prod/api ./

USER letian

# 监听端口由 PORT 环境变量决定（server.ts 默认 3100），compose 中显式注入
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3100}/health" >/dev/null 2>&1 || exit 1

CMD ["node", "dist/server.js"]
