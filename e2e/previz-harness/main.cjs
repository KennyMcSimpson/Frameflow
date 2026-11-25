// AI 预演渲染调试脚手架（独立 Electron 进程，隐藏窗口，不启动主应用）。
//
// 用法（在项目根目录）：
//   node_modules\.bin\esbuild.cmd e2e/previz-harness/harness.mjs --bundle --format=iife --outfile=e2e/previz-harness/build/harness.js
//   node_modules\.bin\electron.cmd e2e/previz-harness/main.cjs [输出前缀]
// PNG 默认输出到 e2e/previz-harness/out/；设环境变量 PH_OUT 可改目录，PH_MODE=sample 只渲染典型镜头样张。

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = __dirname;
const OUT = process.env.PH_OUT ? path.resolve(process.env.PH_OUT) : path.join(ROOT, 'out');
const mode = process.env.PH_MODE || 'full';
const prefix = (process.argv.slice(2).find((a) => /^[\w-]+$/.test(a)) || 'after');
let failed = false;

ipcMain.handle('ph:config', () => ({ prefix, mode }));
ipcMain.handle('ph:save', (_e, name, dataUrl) => {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`bad name ${name}`);
  const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error('not png');
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(m[1], 'base64'));
  console.log(`[ph] saved ${file}`);
});
ipcMain.on('ph:log', (_e, level, msg) => {
  if (level === 'error') failed = true;
  console.log(`[${level}] ${msg}`);
});
ipcMain.on('ph:done', (_e, ok) => app.exit(ok && !failed ? 0 : 1));

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (details, legacyLevel, legacyMessage) => {
    const isObj = details && typeof details === 'object' && typeof details.message === 'string';
    const message = isObj ? details.message : legacyMessage;
    const isErr = isObj
      ? (details.level === 'error' || (typeof details.level === 'number' && details.level >= 3))
      : (typeof legacyLevel === 'number' && legacyLevel >= 3);
    if (isErr) failed = true;
    console.log(`[console] ${message}`);
  });
  win.loadURL(pathToFileURL(path.join(ROOT, 'index.html')).href);
  setTimeout(() => { console.error('timeout'); app.exit(3); }, 240000).unref();
});
