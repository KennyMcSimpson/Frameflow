// stability：主进程启动逻辑（main.cjs）——单实例锁、FF_DEV_URL 只在开发版生效、FF_USER_DATA/FF_E2E 安装版也认、
// 命令行打开工程文件、IPC 来源校验用的 isAppUrl。用假的 electron 加载 main.cjs，不启动真正的 Electron。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.join(ROOT, 'electron', 'main.cjs');
const ELECTRON_DIR = path.join(ROOT, 'electron') + path.sep;
const ENV_KEYS = ['FF_E2E', 'FF_DEV_URL', 'FF_USER_DATA', 'FF_E2E_SHOW'];

let fake = null;
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === 'electron' && fake ? fake : origLoad.call(this, request, ...rest);
};

const dirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-stab-main-'));
  dirs.push(d);
  return d;
}
after(() => {
  Module._load = origLoad;
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function makeElectron({ packaged, lock, userData }) {
  const calls = { exit: [], setPath: [], lock: 0, whenReady: 0, switches: [], events: [] };
  const paths = {};
  const noop = () => {};
  const app = {
    isPackaged: packaged,
    setPath(k, v) { paths[k] = v; calls.setPath.push([k, v]); },
    getPath(k) { return paths[k] || userData; },
    getVersion: () => '0.0.0-test',
    getLocale: () => 'zh-CN',
    commandLine: { appendSwitch: (...a) => calls.switches.push(a.join('=')) },
    requestSingleInstanceLock() { calls.lock++; return lock; },
    exit(code) { calls.exit.push(code); },
    whenReady() { calls.whenReady++; return new Promise(() => {}); }, // 不进入 onReady
    on(ev) { calls.events.push(ev); return app; },
    setAppUserModelId(id) { calls.appId = id; },
    enableSandbox() { calls.sandbox = true; },
    disableHardwareAcceleration() { calls.noGpu = true; },
    relaunch: noop,
    quit: noop,
  };
  return {
    calls,
    electron: {
      app,
      BrowserWindow: class {},
      ipcMain: { handle: noop, on: noop, removeHandler: noop },
      protocol: { registerSchemesAsPrivileged: () => { calls.schemes = true; }, handle: noop },
      Menu: { setApplicationMenu: noop },
      shell: {}, dialog: {}, session: {}, screen: {}, webUtils: {}, Notification: class {},
      safeStorage: { isEncryptionAvailable: () => false },
    },
  };
}

/** 按给定环境重新加载 main.cjs；bootstrap 注册的进程监听、日志状态加载完立即清掉，不影响后面的测试 */
function loadMain({ packaged = false, lock = true, env = {}, settings = null } = {}) {
  const userData = tmp();
  if (settings) fs.writeFileSync(path.join(env.FF_USER_DATA || userData, 'settings.json'), JSON.stringify(settings));
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const hadResources = Object.prototype.hasOwnProperty.call(process, 'resourcesPath');
  if (packaged && !hadResources) process.resourcesPath = userData;
  const before = Object.fromEntries(['uncaughtException', 'unhandledRejection', 'exit'].map((ev) => [ev, process.listeners(ev)]));
  const { calls, electron } = makeElectron({ packaged, lock, userData });
  fake = electron;
  for (const k of Object.keys(require.cache)) if (k.startsWith(ELECTRON_DIR)) delete require.cache[k];
  try {
    return { mod: require(MAIN), calls, userData };
  } finally {
    for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    if (packaged && !hadResources) delete process.resourcesPath;
    for (const [ev, list] of Object.entries(before)) {
      for (const fn of process.listeners(ev)) if (!list.includes(fn)) process.removeListener(ev, fn);
    }
    const logMod = require.cache[path.join(ELECTRON_DIR, 'lib', 'log.cjs')];
    if (logMod) logMod.exports._reset();
  }
}

test('第二个实例拿不到锁：直接退出，不做任何初始化', () => {
  const { mod, calls } = loadMain({ lock: false });
  assert.equal(calls.lock, 1);
  assert.deepEqual(calls.exit, [0]);
  assert.equal(calls.whenReady, 0);
  assert.equal(calls.events.length, 0);
  assert.equal(mod._state().gotLock, false);
  assert.equal(calls.schemes, true, 'ffmedia 协议要在 ready 前注册');
});

test('安装版忽略 FF_DEV_URL，但认 FF_USER_DATA（打包冒烟测试要用）', () => {
  const ud = tmp();
  const { mod, calls } = loadMain({ packaged: true, lock: false, env: { FF_DEV_URL: 'http://localhost:5199', FF_USER_DATA: ud } });
  assert.equal(mod._state().isDev, false);
  assert.equal(mod._state().devUrl, null);
  assert.deepEqual(calls.setPath, [['userData', path.resolve(ud)]]);
});

test('开发版只接受本机开发地址', () => {
  assert.equal(loadMain({ lock: false, env: { FF_DEV_URL: 'http://localhost:5199' } }).mod._state().isDev, true);
  assert.equal(loadMain({ lock: false, env: { FF_DEV_URL: 'http://evil.example.com:5199' } }).mod._state().isDev, false);
  const { safeDevUrl } = loadMain({ lock: false }).mod;
  assert.equal(safeDevUrl('http://localhost:5199'), 'http://localhost:5199/');
  assert.equal(safeDevUrl('http://127.0.0.1:5199/x'), 'http://127.0.0.1:5199/x');
  assert.equal(safeDevUrl('http://[::1]:5199'), 'http://[::1]:5199/');
  for (const bad of ['https://evil.com', 'http://localhost.evil.com:5199', 'file:///C:/x.html', 'javascript:alert(1)', 'http://192.168.1.2:5199', '', null]) {
    assert.equal(safeDevUrl(bad), null, String(bad));
  }
});

test('e2e（FF_E2E）不抢单实例锁，安装版也照常启动，日志写到 FF_USER_DATA 下', () => {
  const ud = tmp();
  const { mod, calls } = loadMain({ packaged: true, lock: false, env: { FF_E2E: '1', FF_USER_DATA: ud } });
  assert.equal(calls.lock, 0);
  assert.deepEqual(calls.exit, []);
  assert.equal(calls.whenReady, 1);
  assert.equal(mod._state().isE2E, true);
  assert.equal(calls.sandbox, true);
  if (process.platform === 'win32') assert.equal(calls.appId, 'com.frameflow.desktop');
  assert.ok(calls.switches.includes('disable-renderer-backgrounding'));
  assert.ok(!calls.switches.includes('force_high_performance_gpu'), 'e2e 不切换显卡');
  for (const ev of ['second-instance', 'will-quit', 'web-contents-created', 'child-process-gone', 'window-all-closed']) assert.ok(calls.events.includes(ev), ev);
  assert.ok(fs.existsSync(path.join(ud, 'logs')), '日志目录应建在 FF_USER_DATA 下');
});

test('显卡选项：默认用高性能显卡；关掉硬件加速后不再切换显卡', () => {
  const ud = tmp();
  const first = loadMain({ lock: true, env: { FF_USER_DATA: ud } });
  assert.equal(first.calls.lock, 1);
  assert.equal(first.calls.whenReady, 1);
  if (process.platform === 'win32') assert.ok(first.calls.switches.includes('force_high_performance_gpu'));
  assert.ok(!first.calls.noGpu);

  const ud2 = tmp();
  const second = loadMain({ lock: true, env: { FF_USER_DATA: ud2 }, settings: { system: { hardwareAcceleration: false } } });
  assert.equal(second.calls.noGpu, true);
  assert.ok(!second.calls.switches.includes('force_high_performance_gpu'));
});

test('命令行打开工程文件：只认存在的绝对路径 .ffproj / .json', () => {
  const { projectFileFromArgv: f } = loadMain({ lock: false }).mod;
  const d = tmp();
  const proj = path.join(d, '我的 工程.ffproj');
  const json = path.join(d, 'backup.JSON');
  const txt = path.join(d, 'a.txt');
  const folder = path.join(d, 'folder.ffproj');
  fs.writeFileSync(proj, '{}');
  fs.writeFileSync(json, '{}');
  fs.writeFileSync(txt, 'x');
  fs.mkdirSync(folder);
  assert.equal(f(['Frameflow.exe', proj]), proj);
  assert.equal(f(['Frameflow.exe', '--flag', txt, folder, json]), json);
  assert.equal(f(['Frameflow.exe', 'relative.ffproj']), null);
  assert.equal(f(['Frameflow.exe', '--open=' + proj]), null);
  assert.equal(f(['Frameflow.exe', path.join(d, 'missing.ffproj')]), null);
  assert.equal(f([proj]), null, '第一个参数是程序本身');
  assert.equal(f(null), null);
});

test('isAppUrl：发行版只认 dist-renderer 下的本地页面', () => {
  const { isAppUrl } = loadMain({ packaged: true, lock: false }).mod;
  const renderer = path.join(ROOT, 'dist-renderer');
  assert.equal(isAppUrl(pathToFileURL(path.join(renderer, 'index.html')).href), true);
  assert.equal(isAppUrl(pathToFileURL(path.join(renderer, 'index.html')).href + '#/edit'), true);
  assert.equal(isAppUrl(pathToFileURL(path.join(ROOT, 'dist-renderer-evil', 'index.html')).href), false);
  assert.equal(isAppUrl(pathToFileURL(path.join(ROOT, 'src', 'index.html')).href), false);
  assert.equal(isAppUrl(pathToFileURL(path.join(os.tmpdir(), 'x.html')).href), false);
  assert.equal(isAppUrl('https://example.com/'), false);
  assert.equal(isAppUrl('http://localhost:5199/'), false, '安装版不认开发地址');
  assert.equal(isAppUrl('ffmedia://media/x'), false);
  assert.equal(isAppUrl(''), false);
  assert.equal(isAppUrl(null), false);
});

test('isAppUrl：开发版只认开发服务器同源', () => {
  const { isAppUrl } = loadMain({ lock: false, env: { FF_DEV_URL: 'http://localhost:5199' } }).mod;
  assert.equal(isAppUrl('http://localhost:5199/'), true);
  assert.equal(isAppUrl('http://localhost:5199/src/main.jsx?t=1'), true);
  assert.equal(isAppUrl('http://localhost:5200/'), false);
  assert.equal(isAppUrl('http://127.0.0.1:5199/'), false);
  assert.equal(isAppUrl('https://localhost:5199/'), false);
  assert.equal(isAppUrl(pathToFileURL(path.join(ROOT, 'dist-renderer', 'index.html')).href), false);
});
