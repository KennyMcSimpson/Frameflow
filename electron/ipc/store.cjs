'use strict';
// 设置、密钥、项目存储 IPC（SPEC §2.2 store.cjs）
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const log = require('../lib/log.cjs');
const { isUncPath } = require('../lib/urlSafety.cjs');

const SECRET_KEYS = { openaiKey: 'hasOpenaiKey', pexelsKey: 'hasPexelsKey', pixabayKey: 'hasPixabayKey' };
const DERIVED_KEYS = new Set([...Object.values(SECRET_KEYS), 'resolvedDataRoot', 'defaultDataRoot']);
const FALLBACK_VIDEOGEN_SECRETS = [
  'arkKey', 'klingAk', 'klingSk', 'minimaxKey', 'runwayKey', 'geminiKey',
  'soraKey', 'lumaKey', 'falKey', 'jimengAk', 'jimengSk',
];
const MEDIA_EXT = new Set([
  '.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.ts', '.mts', '.m2ts', '.wmv', '.flv', '.3gp',
  '.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.flac', '.wma', '.aiff', '.aif',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif',
  '.vtt', '.srt', '.ass', '.ssa', '.lrc',
]);
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_PROJECT_BYTES = 200 * 1024 * 1024;
const MAX_THUMB_BYTES = 12 * 1024 * 1024;

const ASPECTS = {
  '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:3': [1440, 1080], '21:9': [2560, 1080],
};

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function rnd(n = 6) { return crypto.randomBytes(n).toString('hex'); }
function newProjectId() { return 'prj_' + rnd(6); }
function nowIso() { return new Date().toISOString(); }
function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function checkId(id) {
  if (!id || typeof id !== 'string' || !ID_RE.test(id)) throw new Error('项目编号无效');
  return id;
}

async function fileExists(p) {
  try { return (await fs.promises.stat(p)).isFile(); } catch { return false; }
}

async function withRetry(fn, tries = 5) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      const transient = e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES');
      if (!transient || i >= tries - 1) throw e;
      await sleep(80 * (i + 1));
    }
  }
}

/** 原子写：写入同目录临时文件 → fsync → rename 覆盖 */
async function atomicWrite(file, data) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${rnd(4)}.tmp`;
  let fh;
  try {
    fh = await fs.promises.open(tmp, 'w');
    await fh.writeFile(data);
    await fh.sync().catch(() => {});
    await fh.close();
    fh = null;
    await withRetry(() => fs.promises.rename(tmp, file));
  } catch (e) {
    if (fh) await fh.close().catch(() => {});
    await fs.promises.unlink(tmp).catch(() => {});
    throw e;
  }
}

async function readJson(file) {
  const st = await fs.promises.stat(file);
  if (st.size > MAX_PROJECT_BYTES) throw new Error('文件过大');
  const text = await fs.promises.readFile(file, 'utf8');
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

function fsError(e, action) {
  if (!e) return new Error(`${action}失败`);
  if (e.code === 'ENOSPC') return new Error(`${action}失败：磁盘空间不足`);
  if (e.code === 'EACCES' || e.code === 'EPERM') return new Error(`${action}失败：没有写入权限（文件可能被其他程序占用）`);
  if (e.code === 'EROFS') return new Error(`${action}失败：磁盘为只读`);
  return new Error(`${action}失败：${e.message}`);
}

function blankProject({ name, aspect }) {
  const a = ASPECTS[aspect] ? aspect : '16:9';
  const [width, height] = ASPECTS[a];
  const now = nowIso();
  return {
    version: 2,
    id: newProjectId(),
    name: name || '未命名项目',
    createdAt: now,
    updatedAt: now,
    settings: { aspect: a, width, height, fps: 30, background: '#000000' },
    assets: {},
    tracks: { video: [], text: [], audio: [] },
    brief: null,
    storyboard: [],
    memory: { styleGuide: '', decisions: [], colorBaseline: null },
    chats: { director: [], editor: [] },
    references: {},
  };
}

function looksLikeProject(p) {
  return !!p && typeof p === 'object' && !Array.isArray(p)
    && (p.version != null || p.tracks || p.assets || p.storyboard || p.brief);
}

function cleanName(name, fallback = '未命名项目') {
  const s = String(name == null ? '' : name).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120);
  return s || fallback;
}

/** 主轨各镜 (out-in)/speed 之和（近似，未扣除转场重叠），并考虑文字/音频轨结尾 */
function approxDuration(p) {
  const t = (p && p.tracks) || {};
  let main = 0;
  for (const c of Array.isArray(t.video) ? t.video : []) {
    if (!c) continue;
    const len = (Number(c.out) || 0) - (Number(c.in) || 0);
    const sp = Number(c.speed) > 0 ? Number(c.speed) : 1;
    if (len > 0) main += len / sp;
  }
  let end = main;
  for (const x of Array.isArray(t.text) ? t.text : []) {
    if (x) end = Math.max(end, (Number(x.start) || 0) + (Number(x.duration) || 0));
  }
  for (const a of Array.isArray(t.audio) ? t.audio : []) {
    if (!a) continue;
    const len = Math.max(0, (Number(a.out) || 0) - (Number(a.in) || 0));
    end = Math.max(end, (Number(a.start) || 0) + len);
  }
  return Math.round(end * 100) / 100;
}

// ---------------------------------------------------------------------------
module.exports = function register({ handle, ctx }) {
  const { paths, settings } = ctx;
  const deleted = new Set();
  const queues = new Map(); // id -> Promise（同一项目的写操作串行）

  function serial(id, fn) {
    const prev = queues.get(id) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const tail = next.catch(() => {});
    queues.set(id, tail);
    tail.then(() => { if (queues.get(id) === tail) queues.delete(id); });
    return next;
  }

  const projectsRoot = () => paths.projects;
  const dirOf = (id) => path.join(projectsRoot(), checkId(id));
  const fileOf = (id) => path.join(dirOf(id), 'project.json');
  const prevOf = (id) => path.join(dirOf(id), 'project.prev.json');
  const thumbOf = (id) => path.join(dirOf(id), 'thumb.jpg');

  function normPath(p) {
    const abs = path.resolve(p);
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  }

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

  function getUserDataDir() {
    let ud = '';
    try { ud = (paths && paths.userData) || ''; } catch {}
    if (!ud) {
      try {
        const e = require('electron');
        if (e && e.app) ud = e.app.getPath('userData') || '';
      } catch {}
    }
    return ud;
  }

  function isUserDataOrInside(abs, real) {
    const ud = getUserDataDir();
    if (!ud || isUncPath(ud)) return false;
    const udNorms = new Set([normPath(ud)]);
    const rud = resolveRealPathSafe(ud);
    if (rud) udNorms.add(normPath(rud));
    const targets = new Set();
    if (abs) targets.add(normPath(abs));
    if (real) targets.add(normPath(real));
    for (const udDir of udNorms) {
      for (const t of targets) {
        if (isInsideDir(udDir, t)) return true;
      }
    }
    return false;
  }

  function isBlockedUserDataMedia(p) {
    if (typeof p !== 'string' || !p || isUncPath(p)) return true;
    const abs = path.resolve(p);
    if (isUncPath(abs)) return true;
    const real = resolveRealPathSafe(abs);
    if (!real) return true;

    const blockedDirs = [];
    try { const ld = log.logDir && log.logDir(); if (ld) blockedDirs.push(ld); } catch {}

    const ud = getUserDataDir();
    if (ud) blockedDirs.push(path.join(ud, 'logs'));

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

    let dr = '';
    try {
      if (paths) {
        if (paths.dataRootRaw !== undefined) dr = paths.dataRootRaw || '';
        else if (typeof paths.tryDataRoot === 'function') dr = paths.tryDataRoot() || '';
        else if (typeof paths.dataRoot === 'string') dr = paths.dataRoot;
      }
    } catch {}
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

  function isSafeMediaPath(p) {
    if (typeof p !== 'string' || !p) return false;
    if (isUncPath(p) || !path.isAbsolute(p)) return false;
    const abs = path.resolve(p);
    if (isUncPath(abs)) return false;
    if (typeof ctx.isSafeMediaPath === 'function') return !!ctx.isSafeMediaPath(p);
    if (!MEDIA_EXT.has(path.extname(p).toLowerCase()) || !MEDIA_EXT.has(path.extname(abs).toLowerCase())) return false;
    const real = resolveRealPathSafe(abs);
    if (!real || isUncPath(real) || !MEDIA_EXT.has(path.extname(real).toLowerCase())) return false;
    if (isBlockedUserDataMedia(abs) || isBlockedUserDataMedia(real)) return false;
    try {
      if (!fs.statSync(real).isFile()) return false;
    } catch (e) {
      if (!e || e.code !== 'ENOENT') return false;
      try { if (fs.lstatSync(abs).isSymbolicLink()) return false; } catch {}
    }
    return true;
  }

  function registerProjectMedia(project) {
    const assets = project && project.assets && typeof project.assets === 'object' ? Object.values(project.assets) : [];
    for (const a of assets) {
      if (!a || typeof a !== 'object') continue;
      for (const p of [a.path, a.originalPath, a.thumb]) {
        if (isSafeMediaPath(p)) ctx.registerMediaPath(p);
      }
    }
  }

  // ------------------------- 设置 -------------------------
  function defaultDataRoot() {
    try {
      const { app } = require('electron');
      return path.join(app.getPath('documents'), 'Frameflow');
    } catch { return ''; }
  }

  function publicSettings() {
    const s = clone(settings.get()) || {};
    for (const [k, flag] of Object.entries(SECRET_KEYS)) { delete s[k]; s[flag] = !!settings.hasSecret(k); }
    let resolved = '';
    try { resolved = paths.dataRoot; } catch {}
    s.resolvedDataRoot = resolved;
    s.defaultDataRoot = defaultDataRoot();
    return s;
  }

  async function ensureWritableDir(dir) {
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      const probe = path.join(dir, `.ff-write-test-${rnd(3)}`);
      await fs.promises.writeFile(probe, 'ok');
      await fs.promises.unlink(probe);
    } catch (e) {
      throw new Error(`数据目录不可用：${dir}（${e.code === 'EACCES' || e.code === 'EPERM' ? '没有写入权限' : e.code === 'EROFS' ? '磁盘只读' : e.message}）`);
    }
  }

  handle('settings:get', async () => publicSettings());

  handle('settings:set', async (payload = {}) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('设置格式不正确');
    const patch = { ...payload };
    for (const k of Object.keys(SECRET_KEYS)) {
      if (k in patch) {
        const v = patch[k];
        delete patch[k];
        if (v === null || v === undefined) continue;
        if (typeof v !== 'string') throw new Error('密钥必须是文本');
        try { settings.setSecret(k, v.trim()); } catch (e) { throw new Error(`保存密钥失败：${e.message}`); }
      }
    }
    for (const k of Object.keys(patch)) if (DERIVED_KEYS.has(k)) delete patch[k];
    const allowed = new Set(Object.keys(settings.DEFAULTS || {}));
    if (allowed.size) {
      allowed.add('videogenProvider');
      const vgSecrets = Array.isArray(settings.VIDEOGEN_SECRETS) ? settings.VIDEOGEN_SECRETS : FALLBACK_VIDEOGEN_SECRETS;
      for (const k of vgSecrets) allowed.add(k);
    }
    for (const k of Object.keys(patch)) if (allowed.size && !allowed.has(k)) delete patch[k];

    if ('dataRoot' in patch) {
      const v = patch.dataRoot;
      if (v == null || v === '') patch.dataRoot = '';
      else {
        if (typeof v !== 'string' || !v.trim()) throw new Error('数据目录必须是完整的绝对路径');
        if (isUncPath(v)) throw new Error('出于安全考虑，数据目录不支持网络路径（UNC）');
        if (!path.isAbsolute(v)) throw new Error('数据目录必须是完整的绝对路径');
        const abs = path.resolve(v);
        if (isUncPath(abs)) throw new Error('出于安全考虑，数据目录不支持网络路径（UNC）');
        const real = resolveRealPathSafe(abs);
        if (!real || isUncPath(real)) throw new Error('数据目录路径无效或不安全');
        if (isUserDataOrInside(abs, real)) throw new Error('数据目录不能设在应用内部数据目录（userData）内');
        await ensureWritableDir(abs);
        const realAfter = resolveRealPathSafe(abs);
        if (!realAfter || isUncPath(realAfter) || isUserDataOrInside(abs, realAfter)) {
          throw new Error('数据目录不能设在应用内部数据目录（userData）内');
        }
        patch.dataRoot = abs;
      }
      if (patch.dataRoot === '') {
        const def = defaultDataRoot();
        if (def) await ensureWritableDir(def);
      }
    }
    if (Object.keys(patch).length) {
      try { settings.set(patch); } catch (e) { throw fsError(e, '保存设置'); }
    }
    return publicSettings();
  });

  // ------------------------- 项目 -------------------------
  async function readProjectFile(id) {
    const main = fileOf(id);
    const prev = prevOf(id);
    let firstErr = null;
    for (const f of [main, prev]) {
      if (!(await fileExists(f))) continue;
      try {
        const p = await readJson(f);
        if (looksLikeProject(p)) return { project: p, fromBackup: f === prev };
        firstErr = firstErr || new Error('内容不是镜流项目');
      } catch (e) { firstErr = firstErr || e; }
    }
    if (!firstErr) throw new Error('项目不存在或已被删除');
    throw new Error('项目文件已损坏，备份也无法读取');
  }

  async function writeProject(project) {
    const id = checkId(project.id);
    return serial(id, async () => {
      if (deleted.has(id)) throw new Error('该项目已被删除');
      const dir = dirOf(id);
      await fs.promises.mkdir(dir, { recursive: true });
      const updatedAt = nowIso();
      const data = JSON.stringify({ ...project, id, updatedAt }, null, 1);
      const main = fileOf(id);
      // 旧文件可正常解析时才复制为备份，避免把损坏文件覆盖到好备份上
      if (await fileExists(main)) {
        try {
          const old = await fs.promises.readFile(main, 'utf8');
          JSON.parse(old.replace(/^\uFEFF/, ''));
          await withRetry(() => fs.promises.copyFile(main, prevOf(id)));
        } catch {}
      }
      try { await atomicWrite(main, data); } catch (e) { throw fsError(e, '保存项目'); }
      try { await maybeSnapshot(id, data); } catch (e) { console.warn('[store] 历史快照失败', e && e.message); }
      return { updatedAt };
    });
  }

  // ------------------------- 历史快照（project/.history） -------------------------
  const SNAP_INTERVAL_MS = 5 * 60 * 1000;
  const SNAP_EVERY_N = 30;
  const SNAP_KEEP = 20;
  const snapState = new Map(); // id -> { last, count }
  const historyOf = (id) => path.join(dirOf(id), '.history');

  async function listSnapshotFiles(id) {
    let names = [];
    try { names = await fs.promises.readdir(historyOf(id)); } catch { return []; }
    return names.filter((n) => /^snap-\d+\.json$/.test(n)).sort();
  }

  async function writeSnapshot(id, data) {
    const dir = historyOf(id);
    await fs.promises.mkdir(dir, { recursive: true });
    await atomicWrite(path.join(dir, `snap-${Date.now()}.json`), data);
    const files = await listSnapshotFiles(id);
    for (const f of files.slice(0, Math.max(0, files.length - SNAP_KEEP))) {
      await fs.promises.unlink(path.join(dir, f)).catch(() => {});
    }
  }

  async function maybeSnapshot(id, data, force = false) {
    let st = snapState.get(id);
    if (!st) {
      const files = await listSnapshotFiles(id);
      const lastTs = files.length ? Number(/snap-(\d+)/.exec(files[files.length - 1])[1]) : 0;
      st = { last: lastTs, count: 0 };
      snapState.set(id, st);
    }
    st.count += 1;
    const now = Date.now();
    if (force || now - st.last >= SNAP_INTERVAL_MS || st.count >= SNAP_EVERY_N) {
      st.last = now; st.count = 0;
      await writeSnapshot(id, data);
    }
  }

  handle('project:listSnapshots', async ({ id } = {}) => {
    checkId(id);
    const files = await listSnapshotFiles(id);
    const out = await Promise.all(files.map(async (f) => {
      const ts = Number(/snap-(\d+)/.exec(f)[1]);
      let size = 0; let name = ''; let clipCount = 0;
      try {
        const full = path.join(historyOf(id), f);
        size = (await fs.promises.stat(full)).size;
        const p = await readJson(full);
        name = cleanName(p.name);
        clipCount = p.tracks && Array.isArray(p.tracks.video) ? p.tracks.video.length : 0;
      } catch {}
      return { snapshotId: f.replace(/\.json$/, ''), createdAt: new Date(ts).toISOString(), size, name, clipCount };
    }));
    return out.reverse();
  });

  handle('project:restoreSnapshot', async ({ id, snapshotId } = {}) => {
    checkId(id);
    if (!/^snap-\d+$/.test(String(snapshotId || ''))) throw new Error('快照 id 非法');
    const file = path.join(historyOf(id), `${snapshotId}.json`);
    if (!(await fileExists(file))) throw new Error('快照不存在或已过期');
    const snap = await readJson(file);
    if (!looksLikeProject(snap)) throw new Error('快照内容已损坏');
    // 恢复前把当前版本也存一份快照，便于反悔
    try {
      const cur = await fs.promises.readFile(fileOf(id), 'utf8');
      await serial(id, () => writeSnapshot(id, cur));
    } catch {}
    snap.id = id;
    const { updatedAt } = await writeProject(snap);
    snap.updatedAt = updatedAt;
    registerProjectMedia(snap);
    return snap;
  });

  handle('project:list', async () => {
    let names = [];
    try { names = await fs.promises.readdir(projectsRoot(), { withFileTypes: true }); } catch { return []; }
    const items = await Promise.all(names.filter((d) => d.isDirectory() && ID_RE.test(d.name) && !deleted.has(d.name)).map(async (d) => {
      try {
        const { project } = await readProjectFile(d.name);
        const t = thumbOf(d.name);
        const hasThumb = await fileExists(t);
        if (hasThumb) ctx.registerMediaPath(t);
        let updatedAt = project.updatedAt;
        if (!updatedAt) {
          try { updatedAt = (await fs.promises.stat(fileOf(d.name))).mtime.toISOString(); } catch { updatedAt = project.createdAt || ''; }
        }
        const video = project.tracks && Array.isArray(project.tracks.video) ? project.tracks.video : [];
        return {
          id: d.name,
          name: cleanName(project.name),
          updatedAt,
          createdAt: project.createdAt || updatedAt,
          duration: approxDuration(project),
          clipCount: video.length,
          aspect: (project.settings && project.settings.aspect) || '16:9',
          thumb: hasThumb ? t : null,
        };
      } catch { return null; }
    }));
    return items.filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  });

  handle('project:create', async ({ name, project, aspect } = {}) => {
    let p;
    if (project && typeof project === 'object') {
      if (!looksLikeProject(project)) throw new Error('项目内容格式不正确');
      p = clone(project);
      p.version = p.version || 2;
      p.id = newProjectId();
      p.name = cleanName(name || p.name);
      p.createdAt = nowIso();
      p.updatedAt = p.createdAt;
      if (aspect && ASPECTS[aspect]) {
        const [width, height] = ASPECTS[aspect];
        p.settings = { fps: 30, background: '#000000', ...(p.settings || {}), aspect, width, height };
      }
    } else {
      p = blankProject({ name: cleanName(name), aspect });
    }
    while (await fileExists(fileOf(p.id))) p.id = newProjectId();
    const { updatedAt } = await writeProject(p);
    p.updatedAt = updatedAt;
    registerProjectMedia(p);
    return p;
  });

  handle('project:load', async ({ id } = {}) => {
    checkId(id);
    if (deleted.has(id)) throw new Error('项目不存在或已被删除');
    const { project, fromBackup } = await readProjectFile(id);
    project.id = id;
    if (fromBackup) console.warn(`[store] 项目 ${id} 主文件损坏，已从备份恢复`);
    registerProjectMedia(project);
    const t = thumbOf(id);
    if (await fileExists(t)) ctx.registerMediaPath(t);
    return project;
  });

  handle('project:save', async ({ project } = {}) => {
    if (!project || typeof project !== 'object' || Array.isArray(project)) throw new Error('没有要保存的项目');
    checkId(project.id);
    registerProjectMedia(project);
    return writeProject(project);
  });

  handle('project:delete', async ({ id } = {}) => {
    checkId(id);
    deleted.add(id);
    await serial(id, async () => {
      try {
        await fs.promises.rm(dirOf(id), { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
      } catch (e) {
        deleted.delete(id);
        throw fsError(e, '删除项目');
      }
    });
    return true;
  });

  handle('project:saveThumb', async ({ id, dataUrl } = {}) => {
    checkId(id);
    if (deleted.has(id)) throw new Error('该项目已被删除');
    const m = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
    if (!m) throw new Error('封面图片格式不正确');
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length) throw new Error('封面图片为空');
    if (buf.length > MAX_THUMB_BYTES) throw new Error('封面图片过大');
    const out = thumbOf(id);
    try { await atomicWrite(out, buf); } catch (e) { throw fsError(e, '保存封面'); }
    ctx.registerMediaPath(out);
    return out;
  });

  handle('project:exportJson', async ({ project, path: out } = {}) => {
    if (!project || typeof project !== 'object') throw new Error('没有要导出的项目');
    if (!out || typeof out !== 'string') throw new Error('请选择导出位置');
    if (isUncPath(out)) throw new Error('出于安全考虑，不允许导出到网络路径（UNC）');
    if (!path.isAbsolute(out)) throw new Error('请选择导出位置');
    const target = path.resolve(/\.(ffproj|json)$/i.test(out) ? out : `${out}.ffproj`);
    if (isUncPath(target)) throw new Error('出于安全考虑，不允许导出到网络路径（UNC）');
    const data = JSON.stringify({ ...project, exportedAt: nowIso(), exportedBy: 'Frameflow' }, null, 2);
    try { await atomicWrite(target, data); } catch (e) { throw fsError(e, '导出项目'); }
    return target;
  });

  handle('project:importJson', async ({ path: src } = {}) => {
    if (!src || typeof src !== 'string') throw new Error('请选择要导入的项目文件');
    if (isUncPath(src)) throw new Error('出于安全考虑，不允许从网络路径（UNC）导入项目');
    const resolvedSrc = path.resolve(src);
    if (isUncPath(resolvedSrc)) throw new Error('出于安全考虑，不允许从网络路径（UNC）导入项目');
    let raw;
    try { raw = await readJson(resolvedSrc); } catch (e) {
      if (e && e.code === 'ENOENT') throw new Error('项目文件不存在');
      if (e instanceof SyntaxError) throw new Error('项目文件内容已损坏（不是有效的 JSON）');
      throw new Error(`读取项目文件失败：${e.message}`);
    }
    if (!looksLikeProject(raw)) throw new Error('这不是镜流项目文件');
    const p = clone(raw);
    delete p.exportedAt; delete p.exportedBy;
    p.version = p.version || 2;
    p.id = newProjectId();
    while (await fileExists(fileOf(p.id))) p.id = newProjectId();
    p.name = cleanName(p.name || path.basename(src, path.extname(src)));
    p.createdAt = p.createdAt || nowIso();
    const { updatedAt } = await writeProject(p);
    p.updatedAt = updatedAt;
    registerProjectMedia(p);
    return p;
  });

  handle('project:dir', async ({ id } = {}) => {
    checkId(id);
    if (deleted.has(id)) throw new Error('该项目已被删除');
    const dir = paths.projectDir(id);
    try { paths.projectCache(id); } catch {}
    return dir;
  });
};

module.exports.approxDuration = approxDuration;
module.exports.looksLikeProject = looksLikeProject;
