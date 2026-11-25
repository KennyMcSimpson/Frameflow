'use strict';
// 路径与二进制定位。被所有主进程模块共享。
let app = null;
if (process.versions && process.versions.electron) {
  try { ({ app } = require('electron')); } catch { app = null; }
}
const path = require('node:path');
const fs = require('node:fs');

function resolveApp() {
  if (app) return app;
  try {
    const e = require('electron');
    if (e && typeof e === 'object' && e.app) { app = e.app; return app; }
  } catch {}
  return null;
}

function unpacked(p) {
  return p ? p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1') : p;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

const EXE = process.platform === 'win32' ? '.exe' : '';
// 开发模式下 vendor/、build/ 的基准目录；打包后不使用。
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function isFile(p) {
  try { return !!p && fs.statSync(p).isFile(); } catch { return false; }
}

function firstFile(list) {
  return list.find((p) => isFile(p)) || null;
}

function devStatic(name) {
  try {
    const hit = name === 'ffmpeg' ? require('ffmpeg-static') : require('ffprobe-static').path;
    return unpacked(hit);
  } catch { return null; }
}

// 目录里读 ffmpeg-build.json（scripts/fetch-ffmpeg.mjs 写入）拿许可。
function buildLicense(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'ffmpeg-build.json'), 'utf8'));
    return j.license === 'LGPL' || j.license === 'GPL' ? j.license : 'unknown';
  } catch { return 'unknown'; }
}

// 定位 ffmpeg / ffprobe。查找顺序依次为：
//   1. 环境变量 FF_FFMPEG / FF_FFPROBE（仅开发模式，文件存在才采用）
//   2. <resources>/ffmpeg/（安装版随包的 LGPL 构建）
//   3. <项目>/vendor/ffmpeg/bin/（开发，scripts/fetch-ffmpeg.mjs 的产物）
//   4. ffmpeg-static / ffprobe-static（开发回退；不进安装包）
// 目录项要求 ffmpeg 与 ffprobe 同时存在，保证两者来自同一构建。
// ctx 可注入，便于测试。返回 { path, source, license } 或 null。
function locateBinary(name, ctx = {}) {
  const isPackaged = ctx.isPackaged !== undefined ? ctx.isPackaged : !!(app && app.isPackaged);
  const resources = ctx.resourcesPath !== undefined ? ctx.resourcesPath : process.resourcesPath;
  const root = ctx.projectRoot || PROJECT_ROOT;
  const env = ctx.env || process.env;
  const staticBin = ctx.staticBin || devStatic;

  if (!isPackaged) {
    const fromEnv = env[name === 'ffmpeg' ? 'FF_FFMPEG' : 'FF_FFPROBE'];
    if (isFile(fromEnv)) return { path: fromEnv, source: 'env', license: 'unknown' };
  }

  const dirs = [];
  if (resources) dirs.push({ dir: path.join(resources, 'ffmpeg'), source: 'bundled' });
  if (!isPackaged) dirs.push({ dir: path.join(root, 'vendor', 'ffmpeg', 'bin'), source: 'vendor' });
  for (const { dir, source } of dirs) {
    const self = path.join(dir, `${name}${EXE}`);
    const peer = path.join(dir, `${name === 'ffmpeg' ? 'ffprobe' : 'ffmpeg'}${EXE}`);
    if (isFile(self) && isFile(peer)) return { path: self, source, license: buildLicense(dir) };
  }

  if (!isPackaged) {
    const hit = staticBin(name);
    if (hit && isFile(hit)) return { path: hit, source: 'static', license: 'GPL' };
  }
  return null;
}

// 只记一次日志，避免每次调用都刷屏。防御式按需加载 ./log.cjs，避免循环依赖或模块缺失时报错。
const warned = new Set();
function warnMissing(name) {
  if (warned.has(name)) return;
  warned.add(name);
  try { require('./log.cjs').warn?.(`找不到 ${name}，相关功能不可用`); } catch {}
}

function createPaths(settingsStore) {
  const electronApp = resolveApp();
  const userData = electronApp.getPath('userData');
  const defaultRoot = path.join(electronApp.getPath('documents'), 'Frameflow');

  // 随包资源目录列表（打包时只看 resources；开发时再看项目 build/）
  const resourceCandidates = (rel, devRel) => {
    const list = [];
    if (process.resourcesPath) list.push(path.join(process.resourcesPath, rel));
    if (!electronApp.isPackaged) list.push(path.join(PROJECT_ROOT, 'build', devRel));
    return list;
  };

  const locateOrWarn = (name) => {
    const hit = locateBinary(name);
    if (!hit) warnMissing(name);
    return hit;
  };

  const paths = {
    userData,
    get dataRootRaw() {
      let custom = '';
      try { custom = (settingsStore && settingsStore.get().dataRoot) || ''; } catch {}
      return custom || defaultRoot;
    },
    tryDataRoot() {
      try { return paths.dataRootRaw || null; } catch { return null; }
    },
    get dataRoot() {
      return ensureDir(paths.dataRootRaw);
    },
    get projects() { return ensureDir(path.join(paths.dataRoot, 'projects')); },
    projectDir(id) {
      if (!/^[A-Za-z0-9_-]+$/.test(String(id))) throw new Error('项目 id 非法');
      return ensureDir(path.join(paths.projects, id));
    },
    projectCache(id) { return ensureDir(path.join(paths.projectDir(id), 'cache')); },
    get library() { return ensureDir(path.join(paths.dataRoot, 'library')); },
    get analyses() { return ensureDir(path.join(paths.library, 'analyses')); },
    analysisDir(id) {
      if (!/^[A-Za-z0-9_-]+$/.test(String(id))) throw new Error('分析 id 非法');
      return ensureDir(path.join(paths.analyses, id));
    },
    get libraryMedia() { return ensureDir(path.join(paths.library, 'media')); },
    get cache() { return ensureDir(path.join(paths.dataRoot, 'cache')); },
    get thumbs() { return ensureDir(path.join(paths.cache, 'thumbs')); },
    get waveforms() { return ensureDir(path.join(paths.cache, 'waveforms')); },
    get tmpRaw() { return path.join(electronApp.getPath('temp'), 'frameflow'); },
    get tmp() { return ensureDir(paths.tmpRaw); },
    get bin() { return ensureDir(path.join(userData, 'bin')); },

    get ffmpeg() {
      const hit = locateOrWarn('ffmpeg');
      return hit ? hit.path : null;
    },
    get ffprobe() {
      const hit = locateOrWarn('ffprobe');
      return hit ? hit.path : null;
    },
    // { source: 'env'|'bundled'|'vendor'|'static'|'none', license: 'LGPL'|'GPL'|'unknown' }
    get ffmpegInfo() {
      const hit = locateBinary('ffmpeg');
      return hit ? { source: hit.source, license: hit.license } : { source: 'none', license: 'unknown' };
    },
    get ytdlp() { return path.join(paths.bin, 'yt-dlp.exe'); },

    // 内置音乐与音效目录（内含 manifest.json），没有时为 null
    get builtinAudio() {
      const hit = firstFile(resourceCandidates(path.join('builtin-audio', 'manifest.json'), path.join('builtin-audio', 'manifest.json')));
      return hit ? path.dirname(hit) : null;
    },
    // 第三方许可与隐私说明，绝对路径或 null
    get licensesFile() {
      return firstFile(resourceCandidates(path.join('licenses', 'THIRD_PARTY_LICENSES.txt'), 'THIRD_PARTY_LICENSES.txt'));
    },
    get privacyFile() {
      return firstFile(resourceCandidates(path.join('licenses', 'privacy.txt'), 'privacy.txt'));
    },
  };
  return paths;
}

module.exports = { createPaths, ensureDir, unpacked, locateBinary };
