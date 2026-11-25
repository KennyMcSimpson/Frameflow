// 开发启动：Vite 开发服务器（5199）+ Electron。Electron 退出时关闭服务器。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5199;
const DEV_URL = `http://localhost:${PORT}`;

let server = null;
let child = null;
let stopping = false;

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  if (child && child.exitCode === null && !child.killed) {
    try { child.kill(); } catch { /* 进程可能已退出 */ }
  }
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
    root: path.join(root, 'src'),
    server: { port: PORT, strictPort: true },
  });
  await server.listen();
  console.log(`[dev] Vite 已启动：${DEV_URL}`);

  const electronPath = require('electron');
  if (typeof electronPath !== 'string') throw new Error('找不到 Electron 可执行文件，请先运行 npm install');

  const env = { ...process.env, FF_DEV_URL: DEV_URL };
  delete env.ELECTRON_RUN_AS_NODE; // 否则 Electron 会以纯 Node 模式运行

  child = spawn(electronPath, ['.'], { cwd: root, env, stdio: 'inherit', windowsHide: false });
  child.on('error', (e) => {
    console.error('[dev] 启动 Electron 失败：', e.message);
    shutdown(1);
  });
  child.on('exit', (code) => {
    console.log(`[dev] Electron 已退出（代码 ${code == null ? '无' : code}）`);
    shutdown(code || 0);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

main().catch((e) => {
  console.error('[dev] 启动失败：', e.message);
  shutdown(1);
});
