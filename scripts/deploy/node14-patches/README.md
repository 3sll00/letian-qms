# Node 14 语法补丁

这些文件覆盖同名依赖包的官方构建产物，把 ES2021 逻辑赋值（??= / ||= / &&=）
改写为语义等价的 ES2020 写法，使包能在 Node 14.21.3（V8 8.4）上加载。

| 包 | 官方版本 | 原因 |
|---|---|---|
| kysely | 0.27.6 | 产物含 ??=/||= 语法，require 即 SyntaxError |
| openapi3-ts | 4.6.1 | 产物含 ??=/||= 语法，require 即 SyntaxError |
| tedious | 20.0.0 | 产物含 ??=/||= 语法，require 即 SyntaxError |
| mssql | 12.7.2 | 产物含 ??=/||= 语法，require 即 SyntaxError |

重新生成：node scripts/deploy/make-node14-patches.cjs（升级依赖后必须重跑并核对差异）
