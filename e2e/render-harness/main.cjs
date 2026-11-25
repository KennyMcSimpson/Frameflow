// 渲染调试脚手架（独立 Electron 进程，不启动主应用）。
//
// 用法（在项目根目录）：
//   node_modules\.bin\esbuild.cmd e2e/render-harness/harness.mjs --bundle --format=iife --loader:.js=jsx --outfile=e2e/render-harness/build/harness.js
//   node_modules\.bin\electron.cmd e2e/render-harness/main.cjs [场景名 ...]
// 场景名：previz shots looks transitions text fx video（缺省为全部）。PNG 输出到 e2e/render-harness/out/。

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'out');
const ASSETS = path.join(ROOT, 'assets');
const TIMEOUT_MS = 180000;

const scenes = process.argv.slice(2).filter((a) => /^[a-z-]+$/.test(a));
let failed = false;

app.commandLine.appendSwitch('disable-gpu-vsync');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

ipcMain.handle('harness:config', () => ({
  scenes,
  assets: {
    test: path.join(ASSETS, 'test.png'),
    clock: path.join(ASSETS, 'clock.mp4'),
  },
}));

ipcMain.handle('harness:read-data-url', (_e, file) => {
  const buf = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream';
  return `data:${mime};base64,${buf.toString('base64')}`;
});

ipcMain.handle('harness:save', (_e, name, dataUrl) => {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`非法文件名：${name}`);
  const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error(`${name} 不是 PNG 数据`);
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(m[1], 'base64'));
  console.log(`[harness] 已保存 ${path.relative(process.cwd(), file)}`);
  return file;
});

ipcMain.on('harness:log', (_e, level, msg) => {
  if (level === 'error') failed = true;
  console.log(`[renderer:${level}] ${msg}`);
});

ipcMain.on('harness:done', (_e, ok) => {
  if (!ok) failed = true;
  app.exit(failed ? 1 : 0);
});

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(ROOT, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      // 只在调试脚手架里关闭：允许 file:// 视频画进 canvas 后再读回像素
      webSecurity: false,
    },
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) failed = true;
    console.log(`[console] ${message}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[harness] 渲染进程退出：${details.reason}`);
    app.exit(2);
  });
  win.loadFile(path.join(ROOT, 'index.html'));
  setTimeout(() => {
    console.error('[harness] 超时退出');
    app.exit(3);
  }, TIMEOUT_MS).unref();
});
