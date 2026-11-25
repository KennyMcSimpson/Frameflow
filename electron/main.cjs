'use strict';
// 镜流 Frameflow 主进程：窗口、ffmedia:// 协议、IPC 模块加载、关闭前保存、日志与崩溃恢复。
// 安全要点（按 Electron 官方安全清单逐项核对）：
// - 窗口：contextIsolation + sandbox，关闭 nodeIntegration / webview；只加载本地页面，开发地址只在未打包时生效；
// - 禁止页面跳转和新开窗口，只有 https 链接交给系统浏览器；默认拒绝权限请求（只放行剪贴板写入和全屏）；
// - IPC 只接受本应用页面（主框架）发来的调用；CSP 见 src/index.html，开发时由 vite.config.mjs 放行 HMR。
const { app, BrowserWindow, ipcMain, protocol, Menu, shell, dialog, session, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { fileURLToPath } = require('node:url');
const { Readable } = require('node:stream');
const log = require('./lib/log.cjs');
const proc = require('./lib/proc.cjs');
const { createPaths } = require('./lib/paths.cjs');
const { createJobs } = require('./lib/jobs.cjs');
const { createSettings } = require('./lib/settings.cjs');

const APP_ID = 'com.frameflow.desktop'; // 与 package.json 的 build.appId 一致（契约 C17）
const RENDERER_DIR = path.join(__dirname, '..', 'dist-renderer');
const RENDERER_INDEX = path.join(RENDERER_DIR, 'index.html');
const CLOSE_FLUSH_MS = 5000;          // 关窗时等界面保存的上限（契约 C14）
const UNRESPONSIVE_GRACE_MS = 10000;  // 界面没响应多久之后才询问用户
const CRASH_WINDOW_MS = 5 * 60 * 1000;
const CRASH_LOOP_COUNT = 3;           // 5 分钟内第 3 次崩溃：不再直接重载，建议关闭硬件加速

/** 开发地址只接受本机回环地址（如 http://localhost:5199），其余一律忽略 */
function safeDevUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return null;
    return u.href;
  } catch { return null; }
}

const isPackaged = !!app.isPackaged;
// FF_DEV_URL 只在未打包时生效：发行版设置了也不会加载外部页面（a-gates R3：曾可借此调用全部 IPC）
const devUrl = isPackaged ? null : safeDevUrl(process.env.FF_DEV_URL);
const devOrigin = devUrl ? new URL(devUrl).origin : null;
const isDev = !!devUrl;
// FF_E2E / FF_USER_DATA 发行版也认：e2e 和打包冒烟测试要用临时用户目录启动
const isE2E = !!process.env.FF_E2E;
const userDataOverride = process.env.FF_USER_DATA;
// 相对路径按当前目录解析，绝不回落到真实用户目录
if (userDataOverride) app.setPath('userData', path.resolve(userDataOverride));
if (isE2E) {
  // 被遮挡/隐藏的窗口也持续绘制，避免 e2e 截图等待帧超时
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'ffmedia', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true } },
]);

// 单实例：第二个进程只把命令行（例如双击的 .ffproj）转交给第一个，然后立刻退出——
// 不做任何初始化，也不碰 running.lock（pkg 报告 #6）。真正的初始化在文件末尾的 bootstrap()。
const gotLock = isE2E || app.requestSingleInstanceLock();
if (!gotLock) app.exit(0);

// ---------------------------------------------------------------------------
// 日志 / 异常 / 启动锁
// ---------------------------------------------------------------------------
function logsDir() {
  const dir = log.logDir() || path.join(app.getPath('userData'), 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

/** 兼容旧接口 ctx.writeLog(level, ...parts)，新代码请直接 require('./lib/log.cjs') */
function writeLog(level, ...parts) {
  const lv = String(level || '');
  const fn = /error|exception|rejection/i.test(lv) ? log.error : lv === 'warn' ? log.warn : log.info;
  fn(...parts);
}

// 网络类错误只记日志、不打扰用户（忽略列表的思路来自 Kap main/utils/errors.ts，MIT）
const QUIET_ERRORS = /net::ERR_(CONNECTION_(TIMED_OUT|CLOSED|RESET|REFUSED|ABORTED)|NETWORK_IO_SUSPENDED|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|TIMED_OUT)|ECONNRESET|ETIMEDOUT|EPIPE|ECONNREFUSED|socket hang up/i;
const fatalShownAt = new Map();
/** 主进程内部错误提示：同一类错误 60 秒内只弹一次 */
function showFatalOnce(err) {
  try {
    if (isE2E || !app.isReady()) return;
    const msg = String((err && err.message) || err || '未知错误');
    if (QUIET_ERRORS.test(msg)) return;
    const key = msg.slice(0, 120);
    const now = Date.now();
    if (now - (fatalShownAt.get(key) || 0) < 60000) return;
    fatalShownAt.set(key, now);
    const opts = {
      type: 'error', title: '镜流 Frameflow', message: '镜流遇到了一个内部错误',
      detail: `${log.redact(msg).slice(0, 300)}\n\n详细信息已写入日志，通常可以继续使用。如果反复出现，请打开日志文件夹，把 main.log 发给我们。`,
      buttons: ['继续使用', '打开日志文件夹'], defaultId: 0, cancelId: 0, noLink: true,
    };
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts))
      .then((r) => { if (r.response === 1) shell.openPath(logsDir()); })
      .catch(() => {});
  } catch {}
}

function onUncaughtException(err) {
  log.error('[main] 未捕获的异常', err);
  log.flushSync();
  showFatalOnce(err);
}
function onUnhandledRejection(reason) {
  log.error('[main] 未处理的 Promise 拒绝', reason);
}

function sampleMediaDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'sample-media') : path.join(__dirname, '..', 'build', 'sample-media');
}

// running.lock：启动时写入、正常退出时删除；启动时还在说明上次没有正常退出（P0-8.5）。
// 运行中每分钟刷新一次 lastSeenAt，下次启动就能告诉用户大概是什么时候出的问题。
const lockFile = () => path.join(app.getPath('userData'), 'running.lock');
let lastCrash = null;
let lockOwned = false;
let lockStartedAt = null;
let heartbeatTimer = null;
function writeLockFile(extra = {}) {
  fs.writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, startedAt: lockStartedAt, version: app.getVersion(), ...extra }));
}
function checkStartLock() {
  const f = lockFile();
  try {
    if (fs.existsSync(f)) {
      let info = {};
      try { info = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch {}
      const detectedAt = new Date().toISOString();
      lastCrash = {
        at: info.lastSeenAt || info.startedAt || detectedAt,
        startedAt: info.startedAt || null,
        lastSeenAt: info.lastSeenAt || null,
        pid: info.pid || null,
        version: info.version || null,
        detectedAt,
      };
      log.warn('[main] 检测到上次没有正常退出', lastCrash);
    }
  } catch (e) { log.warn('[main] 读取启动锁失败', e); }
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    lockStartedAt = new Date().toISOString();
    writeLockFile();
    lockOwned = true;
  } catch (e) { log.warn('[main] 写启动锁失败', e); }
  if (lockOwned && !heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      if (!lockOwned) return;
      try { writeLockFile({ lastSeenAt: new Date().toISOString() }); } catch {}
    }, 60000);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
  }
}
function clearStartLock() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (!lockOwned) return;
  lockOwned = false;
  try { fs.unlinkSync(lockFile()); } catch {}
}

/** 从命令行参数里找工程文件：.ffproj（文件关联）或导出的 .json；只认存在的绝对路径 */
const PROJECT_FILE_RE = /\.(ffproj|json)$/i;
function projectFileFromArgv(argv) {
  const list = Array.isArray(argv) ? argv : [];
  for (const a of list.slice(1)) {
    if (typeof a !== 'string' || a.startsWith('-') || !PROJECT_FILE_RE.test(a) || !path.isAbsolute(a)) continue;
    try { if (fs.statSync(a).isFile()) return path.resolve(a); } catch {}
  }
  return null;
}
let pendingOpenFile = null;
function openProjectFile(file) {
  if (!file) return;
  registerMediaPath(file);
  log.info('[main] 打开工程文件', file);
  // 页面还在加载时先记下，did-finish-load 时再发；preload 也会替还没订阅的界面暂存（契约 C13）
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) send('app:openFile', { path: file });
  else pendingOpenFile = file;
}

let mainWindow = null;
let settingsRef = null;
let jobsRef = null;
const allowedMedia = new Set();
const mediaRoots = new Set([sampleMediaDir()]);

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.vtt': 'text/vtt', '.json': 'application/json',
};

function norm(p) { return path.resolve(p).toLowerCase(); }

function send(event, data) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send(event, data); } catch (e) { log.warn('[main] 发送到界面失败', event, e && e.message); }
}

function registerMediaPath(p) {
  if (p) allowedMedia.add(norm(p));
}

function isAllowed(file, paths) {
  const n = norm(file);
  if (allowedMedia.has(n)) return true;
  const roots = [paths.dataRoot, paths.tmp, ...mediaRoots].map(norm);
  return roots.some((r) => n.startsWith(r + path.sep) || n === r);
}

function setupProtocol(paths) {
  protocol.handle('ffmedia', async (request) => {
    try {
      const url = new URL(request.url);
      const file = decodeURIComponent(url.pathname.replace(/^\//, ''));
      if (!file || !isAllowed(file, paths)) return new Response('forbidden', { status: 403 });
      const stat = await fs.promises.stat(file);
      const size = stat.size;
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const headers = {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      };
      const range = request.headers.get('range');
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let start = m && m[1] ? parseInt(m[1], 10) : 0;
        let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
        if (!m || !m[1]) { // 后缀范围 bytes=-N
          if (m && m[2]) { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1; }
        }
        if (start >= size || end >= size || start > end) {
          return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
        }
        const stream = fs.createReadStream(file, { start, end });
        return new Response(Readable.toWeb(stream), {
          status: 206,
          headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
        });
      }
      return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
    } catch (e) {
      return new Response('not found', { status: 404 });
    }
  });
}

// ---------------------------------------------------------------------------
// IPC：只接受本应用页面发来的调用（Electron 安全清单第 17 条：校验 sender）
// ---------------------------------------------------------------------------
/** 是不是本应用自己的页面：开发时是开发服务器同源，发行版是 dist-renderer 下的本地文件 */
function isAppUrl(raw) {
  if (!raw || typeof raw !== 'string') return false;
  try {
    const u = new URL(raw);
    if (devOrigin) return u.origin === devOrigin;
    if (u.protocol !== 'file:') return false;
    const file = path.resolve(fileURLToPath(u)).toLowerCase();
    const root = path.resolve(RENDERER_DIR).toLowerCase();
    return file === root || file.startsWith(root + path.sep);
  } catch { return false; }
}

/** IPC 调用方必须是主窗口里本应用页面的主框架（iframe、外部页面一律拒绝） */
function isTrustedSender(event) {
  try {
    const frame = event && event.senderFrame;
    if (!frame) return false;
    if (frame.parent) return false;
    return isAppUrl(frame.url);
  } catch { return false; }
}

// 这些错误码是正常业务分支（未连接 AI、用户取消、需要先同意须知），只记 info，不当错误
const QUIET_CODES = new Set(['NO_AI', 'CANCELLED', 'NEED_CONSENT', 'CONSENT_DECLINED']);

// 正在处理中的 IPC 调用数：关窗保存超时后，再等它们（例如写工程文件）收尾
let ipcInflight = 0;
const idleWaiters = new Set();
function waitIpcIdle(ms) {
  if (!ipcInflight) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (v) => { clearTimeout(timer); idleWaiters.delete(done); resolve(v); };
    const timer = setTimeout(() => done(false), ms);
    idleWaiters.add(done);
  });
}

function createHandle() {
  const registered = new Set();
  return function handle(channel, fn) {
    if (registered.has(channel)) throw new Error(`IPC channel 重复注册: ${channel}`);
    registered.add(channel);
    ipcMain.handle(channel, async (event, payload) => {
      if (!isTrustedSender(event)) {
        log.warn(`[ipc ${channel}] 拒绝来自未知页面的请求`, event && event.senderFrame ? event.senderFrame.url : '(无来源)');
        return { ok: false, error: '拒绝来自未知页面的请求', code: 'FORBIDDEN' };
      }
      ipcInflight++;
      try {
        const data = await fn(payload || {}, event);
        return { ok: true, data };
      } catch (err) {
        const code = (err && err.code) || null;
        if (code && QUIET_CODES.has(code)) log.info(`[ipc ${channel}]`, code, (err && err.message) || '');
        else log.error(`[ipc ${channel}]`, err);
        return { ok: false, error: (err && err.message) || String(err), code };
      } finally {
        ipcInflight--;
        if (!ipcInflight) for (const w of [...idleWaiters]) w(true);
      }
    });
  };
}

const MODULES = ['system', 'store', 'media', 'web', 'analysis', 'ai', 'export', 'videogen', 'asr'];
const OPTIONAL_MODULES = new Set(['videogen', 'asr']);

/** 逐个加载 IPC 模块；单个模块失败不影响其它模块，失败的模块记在 ctx.failedModules（关于页可显示） */
function loadModules(ctx, handle) {
  for (const name of MODULES) {
    const file = path.join(__dirname, 'ipc', `${name}.cjs`);
    if (!fs.existsSync(file)) {
      if (!OPTIONAL_MODULES.has(name)) { log.error(`[main] 缺少模块 ipc/${name}.cjs`); ctx.failedModules.push(name); }
      continue;
    }
    try {
      const register = require(file);
      register({ handle, ctx });
    } catch (e) {
      log.error(`[main] 加载 ipc/${name}.cjs 失败`, e);
      ctx.failedModules.push(name);
    }
  }
}

// ---------------------------------------------------------------------------
// 权限、导航、新窗口（Electron 安全清单第 5、13、14 条）
// ---------------------------------------------------------------------------
// 界面实际用到的权限只有：复制分析报告（剪贴板写入）、预览全屏。其余一律拒绝。
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);

function isMainContents(wc) {
  return !!(wc && mainWindow && !mainWindow.isDestroyed() && wc.id === mainWindow.webContents.id);
}

function permissionAllowed(wc, permission, details) {
  if (!ALLOWED_PERMISSIONS.has(permission) || !isMainContents(wc)) return false;
  if (details && details.isMainFrame === false) return false;
  return isAppUrl(wc.getURL());
}

function setupPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const ok = permissionAllowed(wc, permission, details);
    if (!ok) log.warn('[main] 已拒绝权限请求', permission, (details && details.requestingUrl) || '');
    callback(ok);
  });
  ses.setPermissionCheckHandler((wc, permission, _origin, details) => permissionAllowed(wc, permission, details));
  // USB / HID / 串口等设备一律不给
  if (typeof ses.setDevicePermissionHandler === 'function') ses.setDevicePermissionHandler(() => false);
}

/** 只把 https 链接交给系统浏览器 */
function openExternalSafe(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    shell.openExternal(u.href).catch((e) => log.warn('[main] 打开外部链接失败', e && e.message));
    return true;
  } catch { return false; }
}

function onWebContentsCreated(_e, contents) {
  // 不允许 <webview>
  contents.on('will-attach-webview', (e) => { e.preventDefault(); log.warn('[main] 已阻止 webview'); });
  // 不开新窗口：https 链接用系统浏览器打开，其余直接拒绝
  contents.setWindowOpenHandler(({ url }) => {
    if (!openExternalSafe(url)) log.warn('[main] 已阻止打开新窗口', url);
    return { action: 'deny' };
  });
  // 页面不许跳走：只放行本应用页面之间的跳转；点到 https 链接改用系统浏览器打开
  contents.on('will-navigate', (e, legacyUrl) => {
    const url = (e && e.url) || legacyUrl;
    if (isAppUrl(url)) return;
    e.preventDefault();
    if (!openExternalSafe(url)) log.warn('[main] 已阻止页面跳转', url);
  });
  contents.on('will-redirect', (e, legacyUrl) => {
    const url = (e && e.url) || legacyUrl;
    if (isAppUrl(url)) return;
    e.preventDefault();
    log.warn('[main] 已阻止页面重定向', url);
  });
}

// ---------------------------------------------------------------------------
// 关窗前保存（契约 C14）
// ---------------------------------------------------------------------------
let flushSeq = 0;
const pendingFlush = new Map();
let flushSubscribed = false; // 界面是否已订阅 app:flush（preload 通过 app:flushReady 告知）
let sessionEnding = false;   // Windows 正在关机/注销

function settleFlush(id, result) {
  const entry = pendingFlush.get(id);
  if (!entry) return;
  pendingFlush.delete(id);
  clearTimeout(entry.timer);
  entry.resolve(result);
}
function settleAllFlush(result) {
  for (const id of [...pendingFlush.keys()]) settleFlush(id, result);
}

/** 让界面立即把工程存盘。结果：{ok:true} / {ok:false,error} / {ok:false,timeout:true}（超时按没保存成功处理）/ {ok:false,crashed:true} */
function requestFlush(reason, ms = CLOSE_FLUSH_MS) {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isCrashed()) { resolve({ ok: false, crashed: true }); return; }
    const id = ++flushSeq;
    const timer = setTimeout(() => settleFlush(id, { ok: false, timeout: true }), ms);
    pendingFlush.set(id, { resolve, timer });
    send('app:flush', { id, reason });
  });
}

function onFlushed(event, payload) {
  if (!isTrustedSender(event)) return;
  const p = payload && typeof payload === 'object' ? payload : {};
  const result = { ok: p.ok !== false, error: typeof p.error === 'string' ? p.error.slice(0, 300) : '' };
  const id = Number(p.id);
  if (id && pendingFlush.has(id)) settleFlush(id, result);
  else if (!p.id) settleAllFlush(result); // 不带 id 的旧写法：当作对所有等待中的请求的回复
}

function onFlushReady(event, on) {
  if (isTrustedSender(event)) flushSubscribed = on !== false;
}

const JOB_LABELS = {
  export: '导出视频', videogen: 'AI 视频生成', analysis: '拆解分析', 'web-download': '下载素材', import: '导入素材',
  asr: '语音识别', 'asr-install': '安装语音识别模型', 'ytdlp-install': '安装下载组件', ai: 'AI 处理', 'ai-image': 'AI 出图',
};
const SILENT_JOBS = new Set(['proxy']); // 后台自动生成的预览文件，中断了下次会重做，不用问

/** 正在进行、需要提醒用户的任务：{ total, labels:['导出视频','下载素材（2 个）'] } */
function runningJobs() {
  const out = { total: 0, labels: [] };
  try {
    const list = jobsRef && typeof jobsRef.list === 'function' ? jobsRef.list() : [];
    const counts = new Map();
    for (const j of list) {
      if (!j || SILENT_JOBS.has(j.kind)) continue;
      const label = JOB_LABELS[j.kind] || '后台任务';
      counts.set(label, (counts.get(label) || 0) + 1);
      out.total++;
    }
    out.labels = [...counts].map(([label, n]) => (n > 1 ? `${label}（${n} 个）` : label));
  } catch {}
  return out;
}

/** 关窗确认：有任务在跑先问；再让界面存盘；存盘失败或超时，问用户要不要直接关 */
async function confirmClose(win, state) {
  if (sessionEnding || win.isDestroyed()) return true;
  if (win.webContents.isCrashed() || !state.pageLoaded) return true; // 界面没在运行，没有可保存的
  const running = runningJobs();
  if (running.total && !isE2E) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', title: '镜流 Frameflow',
      message: `还有 ${running.total} 个任务正在进行`,
      detail: `${running.labels.join('、')}\n\n现在关闭会中断这些任务，下次需要重新开始。`,
      buttons: ['返回', '仍然关闭'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (response !== 1 || win.isDestroyed()) return false;
  }
  if (!flushSubscribed) return true; // 界面还没准备好（例如刚启动），没有要保存的内容
  const res = await requestFlush('close', CLOSE_FLUSH_MS);
  if (res.ok || res.crashed) return true;
  await waitIpcIdle(2000);
  log.warn('[main] 关窗前保存没有成功', res.timeout ? '界面没有及时回应' : res.error);
  if (isE2E || win.isDestroyed()) return true;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning', title: '镜流 Frameflow', message: '项目还没保存成功',
    detail: res.timeout
      ? '界面暂时没有回应，没能确认项目已经保存。现在关闭，最近的修改可能会丢失。\n\n可以先返回，等界面恢复后再关闭。'
      : `${res.error ? `原因：${res.error}\n\n` : ''}现在关闭，最近的修改会丢失。可以先返回，检查磁盘空间、文件是否被占用后再保存。`,
    buttons: ['返回', '不保存，直接关闭'], defaultId: 0, cancelId: 0, noLink: true,
  });
  return response === 1;
}

// ---------------------------------------------------------------------------
// 崩溃、无响应、载入失败
// ---------------------------------------------------------------------------
const REASON_TEXT = {
  crashed: '程序崩溃', oom: '内存不足', killed: '被系统结束', 'launch-failed': '启动失败',
  'integrity-failure': '程序文件校验失败', 'abnormal-exit': '异常退出', 'memory-eviction': '内存不足，被系统回收',
};
let appCrashNotified = false;

function hardwareAccelerationOn() {
  try {
    const sys = settingsRef && settingsRef.get().system;
    return !(sys && sys.hardwareAcceleration === false);
  } catch { return true; }
}

/** 显卡驱动不稳时的退路：记下设置，重启后不再用硬件加速 */
function relaunchWithoutGpu() {
  try { if (settingsRef) settingsRef.set({ system: { hardwareAcceleration: false } }); }
  catch (e) { log.error('[main] 保存“关闭硬件加速”设置失败', e); }
  log.warn('[main] 用户选择关闭硬件加速并重启');
  app.relaunch();
  app.quit();
}

function loadApp(win) {
  if (!win || win.isDestroyed()) return;
  const p = devUrl ? win.loadURL(devUrl) : win.loadFile(RENDERER_INDEX);
  p.catch((e) => log.warn('[main] 界面载入没有完成', e && e.message));
}

function reloadPage() {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  try {
    if (isAppUrl(win.webContents.getURL())) win.webContents.reload();
    else loadApp(win);
  } catch (e) { log.error('[main] 重新载入界面失败', e); }
}

function createWindow() {
  // 窗口不超过屏幕可用区域（小屏笔记本上 1600×960 会超出屏幕）
  let work = { width: 1600, height: 960 };
  try { work = screen.getPrimaryDisplay().workAreaSize; } catch {}
  const iconFile = path.join(__dirname, '..', 'build', 'icon.ico');
  const win = new BrowserWindow({
    width: Math.min(1600, work.width),
    height: Math.min(960, work.height),
    minWidth: Math.min(1180, work.width),
    minHeight: Math.min(720, work.height),
    backgroundColor: '#0f1012',
    title: '镜流 Frameflow',
    autoHideMenuBar: true,
    show: false,
    icon: fs.existsSync(iconFile) ? iconFile : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      // 安全清单：隔离上下文 + 沙箱，页面拿不到 Node；不允许 webview；拖文件进来不会跳转页面
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      spellcheck: false,
      backgroundThrottling: false,
      paintWhenInitiallyHidden: true,
    },
  });
  mainWindow = win;
  const wc = win.webContents;
  const state = { pageLoaded: false }; // 页面完整载入过（还没载入完时关窗不用等保存）
  let allowClose = false;
  let closeInFlight = false;
  let dialogOpen = false;
  let crashTimes = [];
  let selfKilledAt = 0;    // 我们主动结束卡死的界面时，不再弹崩溃提示
  let recoverInfo = null;  // 重新载入后要告诉界面的恢复信息（契约 C13 app:crashRecovered）
  let unresponsiveTimer = null;
  let unresponsiveAbort = null;

  const showIfHidden = () => { if (!isE2E && !win.isDestroyed() && !win.isVisible()) win.show(); };
  win.once('ready-to-show', () => {
    if (!isE2E) win.show();
    else if (process.env.FF_E2E_SHOW) win.showInactive(); // e2e：显示但不抢焦点，保证截图有帧
  });
  // 兜底：页面迟迟画不出来时也先把窗口显示出来，免得“程序在跑却看不到窗口”
  const showTimer = setTimeout(() => {
    if (!isE2E && !win.isDestroyed() && !win.isVisible()) { log.warn('[main] 页面迟迟没有画出来，先显示窗口'); win.show(); }
  }, 15000);

  // 界面的警告和错误写进日志：每分钟最多 100 条，单条最长 4KB
  let consoleWindowAt = 0;
  let consoleCount = 0;
  let consoleDropped = 0;
  wc.on('console-message', (event, legacyLevel, legacyMessage, legacyLine, legacySource) => {
    const lv = event && event.level != null ? event.level : legacyLevel;
    const level = typeof lv === 'string' ? lv : (['verbose', 'info', 'warning', 'error'][lv] || 'info');
    if (level !== 'warning' && level !== 'error') return;
    let msg = String(event && event.message != null ? event.message : (legacyMessage || ''));
    if (/ResizeObserver loop/i.test(msg)) return;
    const now = Date.now();
    if (now - consoleWindowAt > 60000) {
      if (consoleDropped) log.warn(`[renderer] 上一分钟另有 ${consoleDropped} 条界面日志没有记录`);
      consoleWindowAt = now;
      consoleCount = 0;
      consoleDropped = 0;
    }
    if (++consoleCount > 100) { consoleDropped++; return; }
    if (msg.length > 4096) msg = msg.slice(0, 4096) + '…';
    const src = event && event.sourceId != null ? event.sourceId : legacySource;
    const lineNo = event && event.lineNumber != null ? event.lineNumber : legacyLine;
    const where = src ? ` (${String(src).split(/[\\/]/).pop()}:${lineNo || 0})` : '';
    (level === 'error' ? log.error : log.warn)(`[renderer] ${msg}${where}`);
  });

  // 关窗：先确认任务，再让界面存盘，失败时询问（契约 C14）
  win.on('close', (e) => {
    if (allowClose || sessionEnding) return;
    e.preventDefault();
    if (closeInFlight) return;
    closeInFlight = true;
    confirmClose(win, state).then((go) => {
      closeInFlight = false;
      if (go && !win.isDestroyed()) { allowClose = true; win.destroy(); }
    }, (err) => {
      closeInFlight = false;
      log.error('[main] 关窗流程出错，直接关闭', err);
      if (!win.isDestroyed()) { allowClose = true; win.destroy(); }
    });
  });
  win.on('closed', () => {
    clearTimeout(showTimer);
    if (unresponsiveTimer) clearTimeout(unresponsiveTimer);
    if (mainWindow === win) mainWindow = null;
  });
  // Windows 关机/注销：抓紧保存；真正结束时不再拦截关窗，并清掉启动锁（这不算异常退出）
  win.on('query-session-end', () => { log.info('[main] 系统即将关机或注销，先保存工程'); requestFlush('session-end', 3000); });
  win.on('session-end', () => { sessionEnding = true; log.info('[main] 系统关机或注销'); clearStartLock(); log.flushSync(); });

  async function showCrashDialog(reason, looping) {
    if (dialogOpen || win.isDestroyed()) return;
    dialogOpen = true;
    try {
      showIfHidden();
      const why = REASON_TEXT[reason] || '未知原因';
      if (looping && hardwareAccelerationOn()) {
        const { response } = await dialog.showMessageBox(win, {
          type: 'error', title: '镜流 Frameflow', message: '界面反复意外退出',
          detail: `5 分钟内已经退出了 ${crashTimes.length} 次（${why}），通常和显卡驱动有关。\n\n关闭硬件加速后，界面改用软件绘制，可能稍慢一些，但一般更稳定。工程会保留最近一次自动保存的内容。`,
          buttons: ['关闭硬件加速并重启', '仍然重新载入', '退出镜流'], defaultId: 0, cancelId: 1, noLink: true,
        });
        if (response === 0) relaunchWithoutGpu();
        else if (response === 2) app.quit();
        else reloadPage();
        return;
      }
      const { response } = await dialog.showMessageBox(win, {
        type: 'error', title: '镜流 Frameflow', message: looping ? '界面反复意外退出' : '界面意外退出了',
        detail: `原因：${why}。\n工程会保留最近一次自动保存的内容，重新载入后可以接着工作。`,
        buttons: ['重新载入', '打开日志文件夹', '退出镜流'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (response === 2) { app.quit(); return; }
      if (response === 1) shell.openPath(logsDir());
      reloadPage();
    } catch (e) {
      log.error('[main] 崩溃提示出错', e);
      reloadPage();
    } finally { dialogOpen = false; }
  }

  wc.on('render-process-gone', (_e, details) => {
    const reason = (details && details.reason) || 'unknown';
    state.pageLoaded = false;
    flushSubscribed = false;
    settleAllFlush({ ok: false, crashed: true });
    if (unresponsiveTimer) { clearTimeout(unresponsiveTimer); unresponsiveTimer = null; }
    if (reason === 'clean-exit' || allowClose || closeInFlight || win.isDestroyed()) { log.info('[main] 界面进程已结束', details); return; }
    if (Date.now() - selfKilledAt < 10000) { selfKilledAt = 0; log.warn('[main] 已结束没有响应的界面，正在重新载入'); return; }
    log.error('[main] 界面进程意外退出', details);
    const now = Date.now();
    crashTimes = crashTimes.filter((t) => now - t < CRASH_WINDOW_MS);
    crashTimes.push(now);
    recoverInfo = { at: new Date(now).toISOString(), kind: 'renderer', reason };
    const looping = crashTimes.length >= CRASH_LOOP_COUNT;
    if (isE2E) { if (!looping) reloadPage(); return; }
    showCrashDialog(reason, looping);
  });

  // 无响应：处理大素材时可能短暂卡住，先等 10 秒；仍未恢复才询问。恢复了就自动收起询问框。
  function forceReload() {
    recoverInfo = { at: new Date().toISOString(), kind: 'renderer', reason: 'unresponsive' };
    selfKilledAt = Date.now();
    try { wc.forcefullyCrashRenderer(); } catch {}
    try { wc.reload(); } catch (e) { log.error('[main] 重新载入界面失败', e); }
  }
  win.on('unresponsive', () => {
    log.warn('[main] 界面没有响应');
    if (isE2E || unresponsiveTimer || dialogOpen) return;
    unresponsiveTimer = setTimeout(async () => {
      unresponsiveTimer = null;
      if (win.isDestroyed() || dialogOpen || closeInFlight) return;
      dialogOpen = true;
      unresponsiveAbort = new AbortController();
      try {
        const { response } = await dialog.showMessageBox(win, {
          type: 'warning', title: '镜流 Frameflow', message: '界面暂时没有响应',
          detail: '可能正在处理较大的素材，可以再等一会儿。\n如果一直没有恢复，可以重新载入界面，工程会恢复到最近一次自动保存的内容。',
          buttons: ['继续等待', '重新载入'], defaultId: 0, cancelId: 0, noLink: true,
          signal: unresponsiveAbort.signal,
        });
        if (response === 1 && !win.isDestroyed()) forceReload();
      } catch {} finally { dialogOpen = false; unresponsiveAbort = null; }
    }, UNRESPONSIVE_GRACE_MS);
  });
  win.on('responsive', () => {
    if (unresponsiveTimer) { clearTimeout(unresponsiveTimer); unresponsiveTimer = null; }
    if (unresponsiveAbort) unresponsiveAbort.abort();
    log.info('[main] 界面恢复响应');
  });

  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3：跳转被取消（例如被我们拦下），不算失败
    log.error('[main] 界面载入失败', code, desc, url);
    if (isE2E || dialogOpen || win.isDestroyed()) return;
    dialogOpen = true;
    showIfHidden();
    dialog.showMessageBox(win, {
      type: 'error', title: '镜流 Frameflow', message: '界面没能载入',
      detail: `${desc || '未知错误'}（错误码 ${code}）\n\n${isDev ? '请确认开发服务器已经启动。' : '安装文件可能不完整，可以重新安装镜流后再试。'}`,
      buttons: ['重试', '打开日志文件夹', '退出镜流'], defaultId: 0, cancelId: 0, noLink: true,
    }).then(({ response }) => {
      dialogOpen = false;
      if (response === 2) { app.quit(); return; }
      if (response === 1) shell.openPath(logsDir());
      loadApp(win);
    }, () => { dialogOpen = false; });
  });
  wc.on('did-navigate', () => { flushSubscribed = false; });
  wc.on('did-finish-load', () => {
    state.pageLoaded = true;
    // 上次没有正常退出：只在本次启动第一次载入时告诉界面（契约 C13，载荷 { at, kind:'app', ... }）
    if (lastCrash && !appCrashNotified) { appCrashNotified = true; send('app:crashRecovered', { ...lastCrash, kind: 'app' }); }
    if (recoverInfo) { const info = recoverInfo; recoverInfo = null; send('app:crashRecovered', info); }
    if (pendingOpenFile) { const f = pendingOpenFile; pendingOpenFile = null; send('app:openFile', { path: f }); }
  });
  wc.on('preload-error', (_e, p, err) => log.error('[main] preload 出错', p, err));

  loadApp(win);
}

// ---------------------------------------------------------------------------
// 应用级事件
// ---------------------------------------------------------------------------
let gpuCrashTimes = [];
let gpuPrompted = false;
/** 子进程（显卡、网络等）异常退出：记日志；显卡进程 5 分钟内反复退出时，建议关闭硬件加速（每次运行只问一次） */
function onChildProcessGone(_e, details) {
  const d = details || {};
  if (d.reason === 'clean-exit') return;
  log.error('[main] 子进程异常退出', d);
  if (d.type !== 'GPU') return;
  const now = Date.now();
  gpuCrashTimes = gpuCrashTimes.filter((t) => now - t < CRASH_WINDOW_MS);
  gpuCrashTimes.push(now);
  if (gpuCrashTimes.length < CRASH_LOOP_COUNT || gpuPrompted || isE2E || !hardwareAccelerationOn()) return;
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  gpuPrompted = true;
  dialog.showMessageBox(win, {
    type: 'warning', title: '镜流 Frameflow', message: '画面显示反复出错',
    detail: '画面可能会闪烁、变黑或卡住，通常和显卡驱动有关。\n\n关闭硬件加速后，界面改用软件绘制，可能稍慢一些，但一般更稳定。',
    buttons: ['关闭硬件加速并重启', '暂不处理'], defaultId: 0, cancelId: 1, noLink: true,
  }).then(({ response }) => { if (response === 0) relaunchWithoutGpu(); }).catch(() => {});
}

/** 再次双击图标或 .ffproj：激活已有窗口，并打开那个工程 */
function onSecondInstance(_e, argv) {
  const win = mainWindow;
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  }
  const f = projectFileFromArgv(argv);
  if (f) openProjectFile(f);
}

function onWillQuit() {
  // 结束还在跑的任务和子进程（ffmpeg 等），避免关掉镜流后它们还在后台占 CPU、写文件
  try { if (jobsRef && typeof jobsRef.cancelAll === 'function') jobsRef.cancelAll(); } catch {}
  try { if (typeof proc.killAll === 'function') proc.killAll(); } catch {}
  clearStartLock();
  log.info('[main] 正常退出');
  log.flushSync();
}

/** 设置里的显卡选项（需重启生效）：关闭硬件加速 / 双显卡优先用独立显卡 */
function applyGpuPrefs() {
  try {
    const sys = (settingsRef && settingsRef.get().system) || {};
    if (sys.hardwareAcceleration === false) {
      app.disableHardwareAcceleration();
      log.info('[main] 已按设置关闭硬件加速');
    } else if (sys.highPerformanceGpu !== false && process.platform === 'win32' && !isE2E) {
      app.commandLine.appendSwitch('force_high_performance_gpu');
    }
  } catch (e) { log.warn('[main] 读取显卡设置失败', e); }
}

/** 启动时记一行环境信息，方便看用户发来的日志 */
function logStartup(paths) {
  try {
    let gpu = null;
    try {
      const s = app.getGPUFeatureStatus();
      gpu = { compositing: s.gpu_compositing, decode: s.video_decode, webgl: s.webgl, raster: s.rasterization };
    } catch {}
    let ffmpeg = null;
    try { ffmpeg = paths.ffmpegInfo || null; } catch {}
    log.info('[main] 启动', {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      os: `${os.type()} ${os.release()} ${os.arch()}`,
      packaged: isPackaged,
      dev: isDev,
      e2e: isE2E,
      locale: app.getLocale(),
      memoryGB: Math.round(os.totalmem() / 1073741824),
      cpus: (os.cpus() || []).length,
      hardwareAcceleration: hardwareAccelerationOn(),
      gpu,
      ffmpeg,
      openFile: pendingOpenFile ? path.extname(pendingOpenFile) : null,
    });
  } catch (e) { log.warn('[main] 记录启动信息失败', e); }
}

function onReady() {
  Menu.setApplicationMenu(null);
  checkStartLock();
  if (!settingsRef) settingsRef = createSettings();
  const settings = settingsRef;
  const paths = createPaths(settings);
  const jobs = createJobs(send);
  jobsRef = jobs;
  const ctx = {
    paths,
    jobs,
    settings,
    send,
    getWindow: () => mainWindow,
    registerMediaPath,
    isAllowedMedia: (p) => isAllowed(p, paths),
    appVersion: app.getVersion(),
    addMediaRoot: (p) => { if (p) mediaRoots.add(p); },
    writeLog,
    log,
    isPackaged,
    failedModules: [],
    get lastCrash() { return lastCrash; },
  };
  logStartup(paths);
  if (pendingOpenFile) registerMediaPath(pendingOpenFile);
  setupPermissions();
  setupProtocol(paths);
  ipcMain.on('app:flushed', onFlushed);
  ipcMain.on('app:flushReady', onFlushReady);
  const handle = createHandle();
  handle('job:cancel', async ({ jobId }) => jobs.cancel(jobId));
  loadModules(ctx, handle);
  createWindow();
}

/** 启动失败：告诉用户并退出，而不是留一个看不见窗口的进程 */
function onStartupFailed(e) {
  log.error('[main] 启动失败', e);
  log.flushSync();
  if (!isE2E) {
    try {
      dialog.showErrorBox('镜流启动失败', `${(e && e.message) || e}\n\n可以重新打开试试。如果还是打不开，请把这个文件夹里的 main.log 发给我们：\n${logsDir()}`);
    } catch {}
  }
  app.exit(1);
}

/** 拿到单实例锁之后才执行的初始化（第二个进程不会走到这里） */
function bootstrap() {
  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);
  log.init({ dir: path.join(app.getPath('userData'), 'logs'), echo: isDev ? 'info' : 'warn' });
  log.takeOverConsole();
  if (process.env.FF_DEV_URL && !devUrl) log.warn('[main] 已忽略 FF_DEV_URL', isPackaged ? '（安装版不加载开发地址）' : '（只允许本机地址）');
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID); // 任务栏分组、系统通知归属（契约 C17）
  app.enableSandbox();
  try { settingsRef = createSettings(); } catch (e) { log.error('[main] 读取设置失败', e); }
  applyGpuPrefs();
  pendingOpenFile = projectFileFromArgv(process.argv);
  app.on('web-contents-created', onWebContentsCreated);
  app.on('child-process-gone', onChildProcessGone);
  app.on('second-instance', onSecondInstance);
  app.on('will-quit', onWillQuit);
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(onReady).catch(onStartupFailed);
}

if (gotLock) bootstrap();

// 单测用：只导出纯函数，不影响运行
module.exports = { safeDevUrl, projectFileFromArgv, isAppUrl, _state: () => ({ isDev, devUrl, isE2E, gotLock }) };
