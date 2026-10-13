#!/usr/bin/env node
/**
 * API 守护进程（Letian QMS）
 *
 * 作用：把 apps/api 的 Fastify 服务当子进程托管，
 *   1) 进程崩溃/被杀 -> 自动重启（带退避，防止疯狂重启）
 *   2) 进程假死（端口还在但 HTTP 不响应）-> 健康巡检失败后强杀重启
 *   3) 所有子进程输出按时间戳落盘，崩溃原因可追溯
 *
 * 用法：
 *   node scripts/api-guard.cjs            # 前台运行（Ctrl-C 停止，会带走子进程）
 *   双击 scripts/api-guard.bat            # Windows 双击启动
 *
 * 环境变量：
 *   API_PORT        监听端口，默认 3100（也会读仓库根 .env）
 *   GUARD_INTERVAL  健康巡检间隔毫秒，默认 15000
 *   GUARD_MAX_RETRY 连续失败多少次后放弃重启，默认 10
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const os = require('node:os');

// ---------------------------------------------------------------------------
// 基础配置
// ---------------------------------------------------------------------------
const repoRoot = path.resolve(__dirname, '..');
const logsDir = path.join(repoRoot, 'logs');
const guardLogPath = path.join(logsDir, 'api-guard.log');
const childLogPath = path.join(logsDir, 'api.out.log');

fs.mkdirSync(logsDir, { recursive: true });

// 读 .env（只为了拿 API_PORT，不依赖 dotenv）
function readEnvFile(file) {
  const out = {};
  try {
    if (!fs.existsSync(file)) return out;
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const i = line.indexOf('=');
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* ignore */ }
  return out;
}
const dotEnv = readEnvFile(path.join(repoRoot, '.env'));

const PORT = Number(process.env.API_PORT || dotEnv.API_PORT || 3100);
const CHECK_INTERVAL = Number(process.env.GUARD_INTERVAL || 15000);
const MAX_CONSECUTIVE_FAIL = Number(process.env.GUARD_MAX_RETRY || 10);
const HEALTH_PATHS = ['/health', '/api/v1/health', '/'];
// 连续快速崩溃（存活 < 该毫秒）才累加退避；正常跑很久后挂了直接秒起
const FAST_CRASH_MS = 15000;

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------
const logStream = fs.createWriteStream(guardLogPath, { flags: 'a' });
const childStream = fs.createWriteStream(childLogPath, { flags: 'a' });

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function log(msg) {
  const line = `[${ts()}] [guard] ${msg}`;
  console.log(line);
  logStream.write(line + os.EOL);
}
log(`===== 守护启动 pid=${process.pid} port=${PORT} node=${process.execPath} =====`);

// ---------------------------------------------------------------------------
// 子进程管理
// ---------------------------------------------------------------------------
let child = null;
let stopping = false;
let consecutiveFail = 0;
let lastStartAt = 0;
let restartTimer = null;
let checkTimer = null;

const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const serverEntry = path.join(repoRoot, 'apps', 'api', 'src', 'server.ts');

/** Windows 下必须杀进程树，否则残留的 node 子进程继续占着 3100 端口 */
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch { /* ignore */ }
  } else {
    try { process.kill(-pid, 'SIGTERM'); } catch { /* ignore */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
  }
}

function startChild() {
  if (stopping) return;
  lastStartAt = Date.now();

  if (!fs.existsSync(tsxCli)) {
    log(`[FATAL] 找不到 tsx 入口: ${tsxCli}`);
    process.exit(1);
  }

  const env = { ...process.env, ...dotEnv, PORT: String(PORT) };
  child = spawn(process.execPath, [tsxCli, serverEntry], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const tag = `[api pid=${child.pid}]`;
  const pump = (stream) => {
    stream.setEncoding('utf8');
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const l of lines) {
        const line = `[${ts()}] ${tag} ${l}`;
        console.log(line);
        childStream.write(line + os.EOL);
      }
    });
  };
  pump(child.stdout);
  pump(child.stderr);

  log(`已启动 API 子进程 pid=${child.pid}`);

  child.on('error', (err) => {
    log(`[ERROR] 子进程 spawn 失败: ${err.message}`);
  });

  child.on('exit', (code, signal) => {
    if (child && child.pid) log(`API 子进程退出 pid=${child.pid} code=${code} signal=${signal || '-'}`);
    child = null;
    if (stopping) return;
    scheduleRestart(`进程退出(code=${code}, signal=${signal || 'none'})`);
  });
}

function scheduleRestart(reason) {
  const aliveMs = Date.now() - lastStartAt;
  // 跑得够久才崩 -> 视为偶发，立即重启；反复秒崩 -> 退避
  if (aliveMs > FAST_CRASH_MS) consecutiveFail = 0;
  consecutiveFail += 1;

  if (consecutiveFail > MAX_CONSECUTIVE_FAIL) {
    log(`[FATAL] 连续 ${consecutiveFail} 次启动失败，停止自动重启。原因: ${reason}`);
    log(`[FATAL] 请查看日志: ${childLogPath}`);
    return;
  }

  const delay = Math.min(30000, 2000 * consecutiveFail);
  log(`将在 ${(delay / 1000).toFixed(1)}s 后重启（第 ${consecutiveFail} 次，存活 ${(aliveMs / 1000).toFixed(1)}s）。原因: ${reason}`);
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    // 重启前清一遍可能残留的占端口进程
    if (isPortBusySync()) {
      log('端口仍被占用，尝试等待释放...');
      setTimeout(startChild, 1500);
    } else {
      startChild();
    }
  }, delay);
}

// ---------------------------------------------------------------------------
// 健康检查
// ---------------------------------------------------------------------------
function isPortBusySync() {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port: PORT });
    const done = (busy) => { sock.destroy(); resolve(busy); };
    sock.setTimeout(1500);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

function httpProbe(healthPath) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: healthPath, timeout: 3000 },
      (res) => {
        res.resume();
        // 拿到任何 HTTP 响应都说明服务活着（含 404）
        resolve(true);
      }
    );
    req.once('timeout', () => { req.destroy(); resolve(false); });
    req.once('error', () => resolve(false));
  });
}

let unhealthyStreak = 0;

async function healthCheck() {
  if (stopping || !child) return;
  const busy = await isPortBusySync();
  if (!busy) {
    unhealthyStreak += 1;
    log(`健康检查: 端口 ${PORT} 无响应（${unhealthyStreak}/3）`);
  } else {
    let ok = false;
    for (const p of HEALTH_PATHS) {
      ok = await httpProbe(p);
      if (ok) break;
    }
    if (ok) {
      if (unhealthyStreak > 0) log('健康检查: 已恢复');
      unhealthyStreak = 0;
      consecutiveFail = 0; // 稳定运行时清零，避免历史计数影响后续重启
      return;
    }
    unhealthyStreak += 1;
    log(`健康检查: HTTP 无响应（${unhealthyStreak}/3）`);
  }

  if (unhealthyStreak >= 3) {
    unhealthyStreak = 0;
    log('连续 3 次健康检查失败，判定为假死，强制重启子进程');
    const pid = child && child.pid;
    killTree(pid);
    // 若 3 秒后 exit 事件没触发，兜底再杀一次并调度重启
    setTimeout(() => {
      if (child) {
        log('子进程未响应终止信号，二次强杀');
        killTree(child.pid);
      } else {
        scheduleRestart('假死强杀');
      }
    }, 3000);
  }
}

// ---------------------------------------------------------------------------
// 启动前端口占用检查（单实例）
// ---------------------------------------------------------------------------
(async () => {
  const busy = await isPortBusySync();
  if (busy) {
    log(`[WARN] 端口 ${PORT} 已被占用。若已有 API 在跑，请先停掉它再启动守护，否则端口冲突。`);
    log('[WARN] 守护仍会启动，但子进程大概率因 EADDRINUSE 退出。3 秒后自行判断...');
  }

  startChild();
  checkTimer = setInterval(() => { healthCheck().catch(() => {}); }, CHECK_INTERVAL);

  const shutdown = (sig) => {
    if (stopping) return;
    stopping = true;
    log(`收到 ${sig}，正在停止守护与子进程...`);
    clearTimeout(restartTimer);
    clearInterval(checkTimer);
    if (child) {
      const pid = child.pid;
      killTree(pid);
    }
    setTimeout(() => {
      log('守护已退出');
      process.exit(0);
    }, 1200);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    log(`[ERROR] 守护自身异常: ${err && err.stack ? err.stack : err}`);
  });
})();
