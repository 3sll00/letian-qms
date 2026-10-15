#!/usr/bin/env node
// node14-prefix-shim.cjs — 让 Node 14.17.x 也能加载 require('node:xxx') 写法的依赖
//
// 为什么需要它（2026-10-14 服务器实测踩坑后定稿）：
//   客户服务器是 Windows Server 2008 R2，其 WS2_32.dll 没有导出函数 GetHostNameW
//   （该函数 Windows 8 / Server 2012+ 才有）。Node 官方 win-x64 构建从 v14.18.0
//   起静态导入了这个函数，所以在 2008 R2 上双击/运行 node.exe 会直接弹窗：
//     「无法定位程序输入点 GetHostNameW 于动态链接库 WS2_32.dll 上。」
//   实测导入表干净、能启动的最高版本是 v14.17.6（14.18.0/14.18.1/14.19.3/
//   14.21.x 均带该导入；12.22.12 与 16.20.2 干净，但 16 官方不支持 2008 R2）。
//
//   而 `node:` 模块前缀恰好是 v14.18.0 才引入的 —— fastify / pino / kysely /
//   mssql / tedious / @letian/* 的官方产物大量使用 require('node:http') 等
//   写法，在 14.17.6 上会抛 Cannot find module 'node:http'。
//
//   本垫片通过 CJS 预加载（node -r）改写 CommonJS 模块解析，把 node: 前缀剥掉。
//   在 ≥14.18 的 Node 上同样无害（node:http 与 http 解析到同一内置模块）。
//
// 用法：node.exe -r ./node14-prefix-shim.cjs dist\server.js
// （注意 -r 的文件必须带 ./ 前缀，否则会被当作模块名去 node_modules 查找；
//   start.bat / migrate.bat 已内置此参数；本文件是部署包必需组件，勿删。）

'use strict';

const Module = require('module');
const origResolveFilename = Module._resolveFilename;

Module._resolveFilename = function (request, ...rest) {
  if (typeof request === 'string' && request.length > 5 && request.startsWith('node:')) {
    request = request.slice(5);
  }
  return origResolveFilename.call(this, request, ...rest);
};
