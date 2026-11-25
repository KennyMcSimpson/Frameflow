'use strict';
// 系统相关 IPC：app:info、文件对话框、shell、media:register、任务栏进度与通知
const { dialog, shell, Notification } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const log = require('../lib/log.cjs');

// shell:openPath 只放行文件夹与白名单内的安全文件类型
const ALLOWED_OPEN_EXT = new Set([
  '.mp4', '.mov', '.mkv', '.webm', '.gif',
  '.mp3', '.wav', '.m4a',
  '.png', '.jpg', '.jpeg', '.webp',
  '.srt', '.vtt', '.txt', '.log',
  '.ffproj', '.json',
]);

// media:register 允许注册的媒体文件扩展名白名单
const ALLOWED_MEDIA_EXT = new Set([
  '.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.ts', '.mts', '.m2ts', '.wmv', '.flv', '.3gp',
  '.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.flac', '.wma', '.aiff', '.aif',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif',
  '.vtt', '.srt', '.ass', '.ssa', '.lrc',
]);

const UNC_RE = /^[\\/]{2}/;

function isUncPath(p) {
  return typeof p === 'string' && (UNC_RE.test(p) || UNC_RE.test(p.trim()));
}

function hasTrailingDotOrSpace(p) {
  if (typeof p !== 'string') return false;
  if (/[.\s]$/.test(p)) return true;
  const stripped = p.replace(/[\\/]+$/, '');
  return /[.\s]$/.test(stripped);
}

function normPath(p) {
  const abs = path.resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/** 解析真实路径：拒绝 UNC、符号链接取目标、悬空符号链接与非 ENOENT 错误返回 null */
function resolveRealPathSafe(p) {
  if (typeof p !== 'string' || !p || isUncPath(p)) return null;
  const abs = path.resolve(p);
  if (isUncPath(abs)) return null;
  try {
    const real = fs.realpathSync(abs);
    return isUncPath(real) ? null : real;
  } catch (e) {
    if (!e || e.code !== 'ENOENT') return null;
  }
  try {
    if (fs.lstatSync(abs).isSymbolicLink()) return null;
  } catch {}
  const parts = [];
  let cur = abs;
  while (true) {
    const parent = path.dirname(cur);
    if (parent === cur) return isUncPath(abs) ? null : abs;
    parts.unshift(path.basename(cur));
    cur = parent;
    if (isUncPath(cur)) return null;
    try {
      const realParent = fs.realpathSync(cur);
      if (isUncPath(realParent)) return null;
      const joined = path.join(realParent, ...parts);
      return isUncPath(joined) ? null : joined;
    } catch (e) {
      if (!e || e.code !== 'ENOENT') return null;
    }
  }
}

function isInsideDir(dir, target) {
  if (!dir || !target) return false;
  const d = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return target === dir || target.startsWith(d);
}

function isBlockedUserDataMedia(p, ctxPaths) {
  if (typeof p !== 'string' || !p || isUncPath(p)) return true;
  const abs = path.resolve(p);
  if (isUncPath(abs)) return true;
  const real = resolveRealPathSafe(abs);
  if (!real) return true;

  const blockedDirs = [];
  try { const ld = log.logDir && log.logDir(); if (ld) blockedDirs.push(ld); } catch {}
  let ud = '';
  try { ud = (ctxPaths && ctxPaths.userData) || require('electron').app.getPath('userData') || ''; } catch {}
  if (ud) blockedDirs.push(path.join(ud, 'logs'));
  let dr = '';
  try {
    if (ctxPaths) {
      if (ctxPaths.dataRootRaw !== undefined) dr = ctxPaths.dataRootRaw || '';
      else if (typeof ctxPaths.tryDataRoot === 'function') dr = ctxPaths.tryDataRoot() || '';
      else if (typeof ctxPaths.dataRoot === 'string') dr = ctxPaths.dataRoot;
    }
  } catch {}

  const targets = new Set([normPath(abs), normPath(real)]);
  for (const bd of blockedDirs) {
    const bdSet = new Set([normPath(bd)]);
    const rbd = resolveRealPathSafe(bd);
    if (rbd) bdSet.add(normPath(rbd));
    for (const d of bdSet) {
      for (const t of targets) if (isInsideDir(d, t)) return true;
    }
  }
  if (!ud) return false;
  const udNorms = new Set([normPath(ud)]);
  const rud = resolveRealPathSafe(ud);
  if (rud) udNorms.add(normPath(rud));
  const drNorms = new Set();
  if (dr) {
    drNorms.add(normPath(dr));
    const rdr = resolveRealPathSafe(dr);
    if (rdr) drNorms.add(normPath(rdr));
  }
  for (const udDir of udNorms) {
    for (const t of targets) {
      if (!isInsideDir(udDir, t)) continue;
      let insideDataRoot = false;
      for (const drDir of drNorms) {
        if (drDir !== udDir && isInsideDir(drDir, t)) { insideDataRoot = true; break; }
      }
      if (!insideDataRoot) return true;
      const rel = t.slice(udDir.length).replace(/^[\\/]+/, '');
      const base = path.basename(t);
      if (
        /^(secrets|settings)(\.|$)/i.test(base)
        || base === 'running.lock'
        || base === 'encoders.json'
        || /\.log$/i.test(base)
        || /^logs([\\/]|$)/i.test(rel)
      ) {
        return true;
      }
    }
  }
  return false;
}

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

const CLI_PROVIDERS = new Set(['cli', 'claude', 'codex', 'gemini']);

function hasConfiguredApi(store, sv, aiPresets) {
  const ai = (sv && sv.ai && typeof sv.ai === 'object') ? sv.ai : {};
  const preset = aiPresets && typeof aiPresets.getPreset === 'function' ? aiPresets.getPreset(ai.apiPreset) : null;
  const protocol = String(ai.apiProtocol || (preset && preset.protocol) || 'openai').trim().toLowerCase();
  const baseUrl = String(ai.openaiBaseUrl || (preset && preset.baseUrl) || '').trim();
  const keylessLocal = !!(aiPresets && typeof aiPresets.isLocalKeylessUrl === 'function' && aiPresets.isLocalKeylessUrl(baseUrl));
  const hasSecret = (name) => {
    try {
      if (store && typeof store.hasSecret === 'function') return !!store.hasSecret(name);
      if (store && typeof store.getSecret === 'function') return !!String(store.getSecret(name) || '').trim();
    } catch {}
    return false;
  };
  const presetKeyless = !!(preset && preset.requiresKey === false);
  const hasKey = protocol === 'anthropic'
    ? (!presetKeyless && (hasSecret('anthropicKey') || hasSecret('openaiKey') || hasSecret('openai')))
    : (!presetKeyless && (hasSecret('openaiKey') || hasSecret('openai')));
  const hasAuth = hasKey || keylessLocal;
  const model = String(ai.openaiModel || '').trim() || (preset && preset.model && hasAuth ? String(preset.model).trim() : '');
  if (!baseUrl || !model) return false;
  return hasAuth;
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
    if (ok) { try { if (typeof ctx.addMediaRoot === 'function') ctx.addMediaRoot(sampleMedia); } catch {} }
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
    const aiPresetsLib = optionalLib('aiPresets');
    const agentCliLib = optionalLib('agentCli');

    const ytdlpFallback = { installed: false, path: (() => { try { return paths.ytdlp; } catch { return null; } })(), version: null };
    const ytdlpP = ytdlpLib && typeof ytdlpLib.ytdlpStatus === 'function'
      ? withTimeout(ytdlpLib.ytdlpStatus(paths), 8000, ytdlpFallback)
      : Promise.resolve(ytdlpFallback);

    const cliFallback = { ok: false, path: null, version: null, loggedIn: false };
    const sv = settingsView(ctx.settings);
    const aiProvider = String((sv && sv.ai && sv.ai.provider) || 'auto').trim().toLowerCase() || 'auto';
    const shouldProbeCli = CLI_PROVIDERS.has(aiProvider)
      || (aiProvider === 'auto' && !hasConfiguredApi(ctx.settings, sv, aiPresetsLib));

    let cliProbeP = Promise.resolve({ codex: cliFallback, clis: null });
    if (shouldProbeCli) {
      if (aiProvider === 'codex') {
        const p = codexLib && typeof codexLib.detectCodex === 'function'
          ? withTimeout(codexLib.detectCodex(sv), 10000, cliFallback)
          : Promise.resolve(cliFallback);
        cliProbeP = p.then((cx) => ({ codex: cx, clis: { codex: { id: 'codex', ...cx } } }));
      } else if (aiProvider === 'claude' || aiProvider === 'gemini') {
        const p = agentCliLib && typeof agentCliLib.detectAgentCli === 'function'
          ? withTimeout(agentCliLib.detectAgentCli(aiProvider, sv), 10000, { id: aiProvider, ...cliFallback })
          : Promise.resolve({ id: aiProvider, ...cliFallback });
        cliProbeP = p.then((info) => ({ codex: cliFallback, clis: { [aiProvider]: info } }));
      } else if (aiProvider === 'cli') {
        const target = String((sv && sv.ai && sv.ai.cliAgent) || 'claude').trim().toLowerCase();
        const kind = (target === 'claude' || target === 'codex' || target === 'gemini') ? target : 'claude';
        const p = agentCliLib && typeof agentCliLib.detectAgentCli === 'function'
          ? withTimeout(agentCliLib.detectAgentCli(kind, sv), 10000, { id: kind, ...cliFallback })
          : (kind === 'codex' && codexLib && typeof codexLib.detectCodex === 'function'
            ? withTimeout(codexLib.detectCodex(sv), 10000, cliFallback).then((cx) => ({ id: 'codex', ...cx }))
            : Promise.resolve({ id: kind, ...cliFallback }));
        cliProbeP = p.then((info) => ({
          codex: kind === 'codex' ? info : cliFallback,
          clis: { [kind]: info },
        }));
      } else if (agentCliLib && typeof agentCliLib.detectAllAgentClis === 'function') {
        cliProbeP = withTimeout(agentCliLib.detectAllAgentClis(sv), 10000, null)
          .then((all) => ({
            codex: (all && all.codex) || cliFallback,
            clis: all || null,
          }));
      } else if (codexLib && typeof codexLib.detectCodex === 'function') {
        cliProbeP = withTimeout(codexLib.detectCodex(sv), 10000, cliFallback)
          .then((cx) => ({ codex: cx, clis: { codex: { id: 'codex', ...cx } } }));
      }
    }

    const [yt, cliProbe] = await Promise.all([ytdlpP, cliProbeP]);
    const cx = cliProbe && cliProbe.codex ? cliProbe.codex : cliFallback;
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
    // 关于页用：许可清单、隐私说明（由 paths 提供，可能为 null）
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
      agentClis: (cliProbe && cliProbe.clis) || null,
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
    if (u.protocol !== 'https:') throw new Error('出于安全考虑，只能打开 https 网页链接');
    await shell.openExternal(u.toString());
    return true;
  });

  handle('shell:showItem', async ({ path: p } = {}) => {
    if (!p || typeof p !== 'string') throw new Error('未提供文件路径');
    if (isUncPath(p)) throw new Error('出于安全考虑，不允许访问网络路径（UNC）');
    const abs = requirePath(p, '文件路径');
    if (isUncPath(abs)) throw new Error('出于安全考虑，不允许访问网络路径（UNC）');
    if (!fs.existsSync(abs)) {
      const dir = path.dirname(abs);
      if (isUncPath(dir)) throw new Error('出于安全考虑，不允许访问网络路径（UNC）');
      let dirSt;
      try { dirSt = fs.statSync(dir); } catch { dirSt = null; }
      if (!dirSt || !dirSt.isDirectory()) {
        throw new Error(`文件不存在或已被移动：${abs}`);
      }
      let realDir;
      try { realDir = fs.realpathSync(dir); } catch {
        throw new Error(`无法解析文件夹真实路径：${dir}`);
      }
      if (isUncPath(realDir)) throw new Error('出于安全考虑，不允许访问网络路径（UNC）');
      let realDirSt;
      try { realDirSt = fs.statSync(realDir); } catch {
        throw new Error(`无法读取文件夹：${realDir}`);
      }
      if (!realDirSt.isDirectory()) {
        throw new Error(`文件不存在或已被移动：${abs}`);
      }
      const err = await shell.openPath(realDir);
      if (err) throw new Error(`无法打开文件夹：${err}`);
      return true;
    }
    let realAbs;
    try { realAbs = fs.realpathSync(abs); } catch {
      throw new Error(`无法解析文件真实路径：${abs}`);
    }
    if (isUncPath(realAbs)) throw new Error('出于安全考虑，不允许访问网络路径（UNC）');
    shell.showItemInFolder(realAbs);
    return true;
  });

  handle('shell:openPath', async ({ path: p } = {}) => {
    if (!p || typeof p !== 'string') throw new Error('未提供路径');
    if (isUncPath(p)) throw new Error('出于安全考虑，不允许打开网络路径（UNC）');
    if (hasTrailingDotOrSpace(p)) throw new Error('路径格式不合法');
    const abs = requirePath(p, '路径');
    if (isUncPath(abs)) throw new Error('出于安全考虑，不允许打开网络路径（UNC）');
    if (!fs.existsSync(abs)) throw new Error(`文件或文件夹不存在：${abs}`);
    let real;
    try { real = fs.realpathSync(abs); } catch {
      throw new Error(`无法解析路径真实位置：${abs}`);
    }
    if (isUncPath(real)) throw new Error('出于安全考虑，不允许打开网络路径（UNC）');
    if (hasTrailingDotOrSpace(real)) throw new Error('路径格式不合法');
    let st;
    try { st = fs.statSync(real); } catch { throw new Error(`无法读取路径：${real}`); }
    if (!st.isDirectory()) {
      if (!st.isFile()) throw new Error('出于安全考虑，不能打开该类型的路径');
      const ext = path.extname(abs).toLowerCase();
      const realExt = path.extname(real).toLowerCase();
      if (!ALLOWED_OPEN_EXT.has(ext) || !ALLOWED_OPEN_EXT.has(realExt)) {
        throw new Error('出于安全考虑，不能直接打开该类型的文件');
      }
    }
    const err = await shell.openPath(real);
    if (err) throw new Error(`无法打开：${err}`);
    return true;
  });

  handle('media:register', async ({ paths: list } = {}) => {
    if (!Array.isArray(list)) throw new Error('paths 必须是路径数组');
    for (const p of list) {
      if (typeof p !== 'string' || !p) continue;
      if (isUncPath(p) || !path.isAbsolute(p)) continue;
      const abs = path.resolve(p);
      if (isUncPath(abs)) continue;
      if (typeof ctx.isSafeMediaPath === 'function') {
        if (!ctx.isSafeMediaPath(p)) continue;
        ctx.registerMediaPath(p);
        continue;
      }
      if (!ALLOWED_MEDIA_EXT.has(path.extname(p).toLowerCase()) || !ALLOWED_MEDIA_EXT.has(path.extname(abs).toLowerCase())) continue;
      const real = resolveRealPathSafe(abs);
      if (!real || isUncPath(real) || !ALLOWED_MEDIA_EXT.has(path.extname(real).toLowerCase())) continue;
      if (isBlockedUserDataMedia(abs, ctx.paths) || isBlockedUserDataMedia(real, ctx.paths)) continue;
      try {
        if (!fs.statSync(real).isFile()) continue;
      } catch (e) {
        if (!e || e.code !== 'ENOENT') continue;
        try { if (fs.lstatSync(abs).isSymbolicLink()) continue; } catch {}
      }
      ctx.registerMediaPath(p);
    }
    return true;
  });

  // ---- 任务栏进度 / 闪烁 / 系统通知（导出等长任务用） ----
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
