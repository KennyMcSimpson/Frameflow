'use strict';
// 系统相关 IPC：app:info、文件对话框、shell、media:register、任务栏进度与通知（SPEC §2.2 system.cjs，契约 C19/C20）
const { dialog, shell, Notification } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const log = require('../lib/log.cjs');

// shell:openPath 拒绝直接运行的可执行/脚本类文件
const BLOCKED_OPEN_EXT = new Set([
  '.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.psd1', '.ps1xml', '.psc1', '.vb', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.wsc',
  '.msi', '.msp', '.msix', '.msixbundle', '.appx', '.appxbundle', '.scr', '.scf', '.pif', '.lnk', '.reg', '.hta', '.cpl', '.jar', '.dll',
  '.sys', '.url', '.appref-ms', '.application', '.gadget', '.inf', '.settingcontent-ms', '.chm', '.diagcab', '.xll',
]);

const TASKBAR_MODES = new Set(['normal', 'indeterminate', 'error', 'paused']);

function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function fileOk(p) {
  try { return !!p && fs.statSync(p).isFile(); } catch { return false; }
}

function optionalLib(name) {
  try { return require(`../lib/${name}.cjs`); } catch { return null; }
}

/** 同时兼容「设置仓库对象」和「普通设置数据」两种读法的 settings 视图 */
function settingsView(store) {
  try {
    return { ...store, ...(store && typeof store.get === 'function' ? store.get() : {}) };
  } catch {
    return store || {};
  }
}

function cleanFilters(filters) {
  if (!Array.isArray(filters)) return undefined;
  const out = filters
    .filter((f) => f && typeof f === 'object')
    .map((f) => ({
      name: String(f.name || '文件'),
      extensions: (Array.isArray(f.extensions) ? f.extensions : ['*']).map((e) => String(e).replace(/^\./, '')).filter(Boolean),
    }))
    .filter((f) => f.extensions.length);
  return out.length ? out : undefined;
}

function requirePath(p, label = '路径') {
  if (!p || typeof p !== 'string') throw new Error(`未提供${label}`);
  if (!path.isAbsolute(p)) throw new Error(`${label}必须是完整的绝对路径`);
  return path.resolve(p);
}

module.exports = function register({ handle, ctx }) {
  // 日志目录以 log.cjs 为准（userData/logs），它还没初始化时按原来的位置推算
  const logsDir = () => {
    let dir = null;
    try { dir = log.logDir(); } catch {}
    if (!dir) {
      let base = '';
      try { base = ctx.paths.userData || require('electron').app.getPath('userData'); } catch { base = process.cwd(); }
      dir = path.join(base, 'logs');
    }
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    return dir;
  };
  const resourcesInfo = () => {
    let packaged = false;
    try { packaged = require('electron').app.isPackaged; } catch {}
    const root = packaged && process.resourcesPath ? process.resourcesPath : path.join(__dirname, '..', '..', 'build');
    const sampleMedia = path.join(root, 'sample-media');
    let ok = false;
    try { ok = fs.statSync(sampleMedia).isDirectory(); } catch {}
    if (ok) { try { ctx.registerMediaPath(sampleMedia); } catch {} }
    return { root, sampleMedia, sampleMediaOk: ok, packaged };
  };
  const parentWindow = () => {
    try {
      const w = ctx.getWindow && ctx.getWindow();
      return w && !w.isDestroyed() ? w : null;
    } catch { return null; }
  };

  handle('app:info', async () => {
    const paths = ctx.paths;
    let dataRoot = null;
    try { dataRoot = paths.dataRoot; } catch (e) { dataRoot = null; }
    const ffmpegPath = paths.ffmpeg;
    const ffprobePath = paths.ffprobe;

    const ytdlpLib = optionalLib('ytdlp');
    const codexLib = optionalLib('codex');

    const ytdlpFallback = { installed: false, path: (() => { try { return paths.ytdlp; } catch { return null; } })(), version: null };
    const ytdlpP = ytdlpLib && typeof ytdlpLib.ytdlpStatus === 'function'
      ? withTimeout(ytdlpLib.ytdlpStatus(paths), 8000, ytdlpFallback)
      : Promise.resolve(ytdlpFallback);
    const codexFallback = { ok: false, path: null, version: null, loggedIn: false };
    const codexP = codexLib && typeof codexLib.detectCodex === 'function'
      ? withTimeout(codexLib.detectCodex(settingsView(ctx.settings)), 10000, codexFallback)
      : Promise.resolve(codexFallback);

    const [yt, cx] = await Promise.all([ytdlpP, codexP]);
    const ytdlp = {
      ok: !!(yt && (yt.installed || yt.ok)),
      path: (yt && yt.path) || null,
      version: (yt && yt.version) || null,
    };
    const codex = {
      ok: !!(cx && cx.ok),
      path: (cx && cx.path) || null,
      version: (cx && cx.version) || null,
      loggedIn: !!(cx && cx.loggedIn),
    };
    // 关于页用：许可清单、隐私说明（契约 C20，由 release 在 paths 里提供，可能为 null）
    let licensesPath = null;
    let privacyPath = null;
    try { licensesPath = paths.licensesFile || null; } catch {}
    try { privacyPath = paths.privacyFile || null; } catch {}
    let logFile = null;
    try { logFile = log.logFile() || null; } catch {}
    return {
      version: ctx.appVersion || '0.0.0',
      dataRoot,
      ffmpeg: { ok: fileOk(ffmpegPath), path: ffmpegPath || null },
      ffprobe: { ok: fileOk(ffprobePath), path: ffprobePath || null },
      ytdlp,
      codex,
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron || null,
      chrome: process.versions.chrome || null,
      node: process.versions.node || null,
      resources: resourcesInfo(),
      logsDir: logsDir(),
      logFile,
      lastCrash: ctx.lastCrash || null,
      licensesPath,
      privacyPath,
      isPackaged: !!ctx.isPackaged,
      failedModules: Array.isArray(ctx.failedModules) ? [...ctx.failedModules] : [],
    };
  });

  handle('app:openLogs', async () => {
    const dir = logsDir();
    const err = await shell.openPath(dir);
    if (err) throw new Error(`无法打开日志目录：${err}`);
    return dir;
  });

  handle('dialog:openFiles', async ({ title, filters, multi } = {}) => {
    const opts = {
      title: title || '选择文件',
      filters: cleanFilters(filters),
      properties: ['openFile', ...(multi === false ? [] : ['multiSelections'])],
    };
    const win = parentWindow();
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (!r || r.canceled || !Array.isArray(r.filePaths)) return [];
    return r.filePaths;
  });

  handle('dialog:saveFile', async ({ title, defaultPath, filters } = {}) => {
    const opts = { title: title || '保存文件', filters: cleanFilters(filters) };
    if (defaultPath && typeof defaultPath === 'string') opts.defaultPath = defaultPath;
    const win = parentWindow();
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (!r || r.canceled || !r.filePath) return null;
    return r.filePath;
  });

  handle('dialog:openFolder', async ({ title, defaultPath } = {}) => {
    const opts = { title: title || '选择文件夹', properties: ['openDirectory', 'createDirectory'] };
    if (defaultPath && typeof defaultPath === 'string') opts.defaultPath = defaultPath;
    const win = parentWindow();
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (!r || r.canceled || !r.filePaths || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  handle('shell:openExternal', async ({ url } = {}) => {
    let u;
    try { u = new URL(String(url || '')); } catch { throw new Error('链接格式不正确'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('出于安全考虑，只能打开 http/https 网页链接');
    await shell.openExternal(u.toString());
    return true;
  });

  handle('shell:showItem', async ({ path: p } = {}) => {
    const abs = requirePath(p, '文件路径');
    if (!fs.existsSync(abs)) {
      const dir = path.dirname(abs);
      if (fs.existsSync(dir)) { const err = await shell.openPath(dir); if (err) throw new Error(`无法打开文件夹：${err}`); return true; }
      throw new Error(`文件不存在或已被移动：${abs}`);
    }
    shell.showItemInFolder(abs);
    return true;
  });

  handle('shell:openPath', async ({ path: p } = {}) => {
    const abs = requirePath(p, '路径');
    if (!fs.existsSync(abs)) throw new Error(`文件或文件夹不存在：${abs}`);
    let isDir = false;
    try { isDir = fs.statSync(abs).isDirectory(); } catch {}
    if (!isDir && BLOCKED_OPEN_EXT.has(path.extname(abs).toLowerCase())) throw new Error('出于安全考虑，不能直接打开程序或脚本文件');
    const err = await shell.openPath(abs);
    if (err) throw new Error(`无法打开：${err}`);
    return true;
  });

  handle('media:register', async ({ paths: list } = {}) => {
    if (!Array.isArray(list)) throw new Error('paths 必须是路径数组');
    for (const p of list) {
      if (typeof p === 'string' && p && path.isAbsolute(p)) ctx.registerMediaPath(p);
    }
    return true;
  });

  // ---- 任务栏进度 / 闪烁 / 系统通知（契约 C19；导出等长任务用） ----
  let lastProgress = -1;
  let flashing = false;
  let lastNotification = null; // 保留引用：通知对象被回收后点击就不会再把窗口叫回来
  handle('app:taskbar', async ({ progress, mode, flash, notify } = {}) => {
    const win = parentWindow();
    if (!win) return false;
    if (progress !== undefined || mode !== undefined) {
      const n = progress == null ? NaN : Number(progress);
      if (Number.isFinite(n) && n < 0) {
        win.setProgressBar(-1);
        lastProgress = -1;
      } else {
        const m = TASKBAR_MODES.has(mode) ? mode : 'normal';
        if (m === 'indeterminate') {
          win.setProgressBar(2, { mode: m }); // 大于 1 表示不确定进度
        } else {
          let p = Number.isFinite(n) ? Math.min(1, n) : lastProgress;
          if (p < 0) p = m === 'normal' ? 0 : 1; // 只给了 error/paused：整条显示红色/黄色
          lastProgress = p;
          win.setProgressBar(p, { mode: m });
        }
      }
    }
    if (flash !== undefined) {
      if (!flash) { flashing = false; win.flashFrame(false); }
      else if (!win.isFocused() && !flashing) {
        flashing = true;
        win.flashFrame(true);
        win.once('focus', () => { flashing = false; try { win.flashFrame(false); } catch {} });
      }
    }
    if (notify && typeof notify === 'object' && !win.isFocused()) {
      let supported = false;
      try { supported = Notification.isSupported(); } catch {}
      if (supported) {
        const n = new Notification({
          title: String(notify.title || '镜流 Frameflow').slice(0, 64),
          body: String(notify.body || '').slice(0, 240),
          silent: !!notify.silent,
        });
        n.on('click', () => {
          try {
            if (win.isDestroyed()) return;
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
          } catch {}
        });
        n.on('close', () => { if (lastNotification === n) lastNotification = null; });
        lastNotification = n;
        n.show();
      }
    }
    return true;
  });
};
