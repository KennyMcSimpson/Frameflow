// 开发启动：Vite 开发服务器 + Electron。Electron 退出时关闭服务器。
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let server = null;
let child = null;
let stopping = false;

function killChildTree(proc) {
  if (!proc || proc.exitCode !== null || proc.killed || !proc.pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return;
    } catch { /* 回退到普通 kill */ }
  }
  try { proc.kill(); } catch { /* 进程可能已退出 */ }
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  killChildTree(child);
  if (server) {
    // 有残留连接时 close 可能迟迟不返回，最多等 3 秒
    const timeout = new Promise((resolve) => { setTimeout(resolve, 3000).unref(); });
    try { await Promise.race([server.close(), timeout]); } catch (e) { console.error('[dev] 关闭 Vite 失败：', e.message); }
  }
  process.exit(code);
}

async function main() {
  server = await createServer({
    configFile: path.join(root, 'vite.config.mjs'),
  });
  await server.listen();
  const devUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '')
    || `http://localhost:${server.config.server.port || 5199}`;
  console.log(`[dev] Vite 已启动：${devUrl}`);

  const electronPath = require('electron');
  if (typeof electronPath !== 'string') throw new Error('找不到 Electron 可执行文件，请先运行 npm install');

  const env = { ...process.env, FF_DEV_URL: devUrl };
  delete env.ELECTRON_RUN_AS_NODE; // 否则 Electron 会以纯 Node 模式运行

  child = spawn(electronPath, ['.'], { cwd: root, env, stdio: 'inherit', windowsHide: false });
  child.on('error', (e) => {
    console.error('[dev] 启动 Electron 失败：', e.message);
    shutdown(1);
  });
  child.on('exit', (code, signal) => {
    const detail = code == null ? `信号 ${signal || '未知'}` : `代码 ${code}`;
    console.log(`[dev] Electron 已退出（${detail}）`);
    shutdown(code ?? 1);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

main().catch((e) => {
  console.error('[dev] 启动失败：', e.message);
  shutdown(1);
});
