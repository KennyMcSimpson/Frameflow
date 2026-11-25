'use strict';
// 拆片库：拆片任务（下载 → 分析 → 保存）、分析记录 CRUD、技法卡与素材库存储。
// 存储位置：<dataRoot>/library/{analyses/<id>.json, analyses/<id>/, techniques.json, assets.json, media/}
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yt = require('../lib/ytdlp.cjs');
const { analyzeVideo } = require('../lib/analyzer.cjs');
const web = require('./web.cjs');

const ID_RE = /^[A-Za-z0-9_-]+$/;
const ANALYSIS_CATEGORIES = ['film', 'tutorial', 'interview', 'short', 'ad', 'vfx', 'other'];
const CATEGORY_LABELS = { film: '电影片段', tutorial: '拍摄教程', interview: '演员访谈', short: '短视频', ad: '广告', vfx: '特效', other: '其他' };
const TECHNIQUE_CATEGORIES = ['transition', 'lighting', 'camera', 'rhythm', 'composition', 'color', 'dialogue', 'vfx', 'product', 'narrative', 'sound'];

function rid(prefix) { return `${prefix}_${crypto.randomBytes(6).toString('hex')}`; }
function nowIso() { return new Date().toISOString(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ───────────────────────── 原子 JSON 读写（串行化 + 损坏容错） ─────────────────────────

const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return next;
}

async function readJson(file, fallback) {
  let primaryBroken = false;
  for (const f of [file, file + '.bak']) {
    let text;
    try { text = await fs.promises.readFile(f, 'utf8'); } catch (e) {
      if (e.code !== 'ENOENT') console.warn('[library] 读取失败', f, e.message);
      continue;
    }
    try {
      return JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
      if (f === file) primaryBroken = true;
      console.warn('[library] JSON 已损坏', f);
    }
  }
  if (primaryBroken) {
    // 留存损坏文件以便人工恢复，同时让后续写入正常进行
    try { await fs.promises.rename(file, `${file}.corrupt-${Date.now()}`); } catch {}
  }
  return fallback;
}

async function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { await fs.promises.rename(from, to); return; } catch (e) {
      if (i >= 6 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await sleep(40 * (i + 1));
    }
  }
}

async function writeJsonAtomic(file, data) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
    try { await fs.promises.copyFile(file, file + '.bak'); } catch {}
    await renameRetry(tmp, file);
  } catch (e) {
    try { await fs.promises.rm(tmp, { force: true }); } catch {}
    throw new Error('保存失败：' + e.message);
  }
}

/** 读-改-写（同一文件串行） */
function updateJson(file, fallback, mutate) {
  return withLock(file, async () => {
    const cur = await readJson(file, fallback);
    const { value, result } = await mutate(cur);
    await writeJsonAtomic(file, value);
    return result;
  });
}

// ───────────────────────── 文本匹配 ─────────────────────────

function tokens(q) {
  return String(q || '').toLowerCase().split(/[\s,，、;；。|/]+/).map((s) => s.trim()).filter(Boolean);
}

function bigrams(s) {
  const t = String(s).replace(/\s+/g, '');
  const out = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

/** 关键词打分：整词子串优先；中文长串无空格时退回二元组匹配 */
function scoreText(hay, query) {
  const h = String(hay || '').toLowerCase();
  const ts = tokens(query);
  if (!ts.length) return 1;
  let score = 0;
  let hit = 0;
  for (const t of ts) if (h.includes(t)) { score += 2 + t.length; hit++; }
  if (hit) return score + (hit === ts.length ? 5 : 0);
  // 回退：二元组
  const grams = ts.flatMap(bigrams);
  if (!grams.length) return 0;
  const g = grams.filter((x) => h.includes(x)).length;
  return g / grams.length >= 0.5 ? g : 0;
}

// ───────────────────────── 素材库与技法库存储 ─────────────────────────

const libraryStore = {
  assetsFile(paths) { return path.join(paths.library, 'assets.json'); },
  techniquesFile(paths) { return path.join(paths.library, 'techniques.json'); },

  async listAssets(paths) {
    const list = await readJson(this.assetsFile(paths), []);
    return Array.isArray(list) ? list.filter((a) => a && typeof a === 'object' && a.id) : [];
  },

  /**
   * 加入素材库。copy=true 时把库外文件复制到 library/media；按来源路径/URL 去重（重复则更新）。
   * @returns {Promise<Asset[]>} 入库后的素材
   */
  async addAssets(paths, assets, { copy = true } = {}) {
    const input = (Array.isArray(assets) ? assets : []).filter((a) => a && typeof a === 'object');
    const prepared = [];
    const skipped = [];
    for (const a of input) {
      if (a.kind === 'previz' || !a.path) { skipped.push(`${a.name || '素材'}：预演或无文件的素材不能加入素材库`); continue; }
      if (!fs.existsSync(a.path)) { skipped.push(`${a.name || '素材'}：文件不存在`); continue; }
      const entry = { ...a, source: { ...(a.source || {}), type: 'library' }, tags: Array.isArray(a.tags) ? a.tags.map(String).slice(0, 30) : [] };
      if (copy && !isInside(a.path, paths.library)) {
        const ext = path.extname(a.path) || '.mp4';
        const dest = path.join(paths.libraryMedia, `${yt.safeBase(a.name || 'asset')}_${crypto.createHash('sha1').update(path.resolve(a.path)).digest('hex').slice(0, 8)}${ext}`);
        if (!fs.existsSync(dest)) {
          const tmp = dest + '.copying';
          try {
            await fs.promises.copyFile(a.path, tmp);
            await renameRetry(tmp, dest);
          } catch (e) {
            try { fs.rmSync(tmp, { force: true }); } catch {}
            skipped.push(`${a.name || '素材'}：复制到素材库失败（${e.message}）`);
            continue;
          }
        }
        entry.libraryFrom = path.resolve(a.originalPath || a.path);
        entry.path = dest;
        delete entry.originalPath;
      }
      prepared.push(entry);
    }
    if (!prepared.length) {
      if (skipped.length) throw new Error(skipped.join('；'));
      return [];
    }
    return updateJson(this.assetsFile(paths), [], (cur) => {
      const list = Array.isArray(cur) ? cur.filter((x) => x && x.id) : [];
      const out = [];
      for (const e of prepared) {
        const same = (x) => (x.path && path.resolve(x.path).toLowerCase() === path.resolve(e.path).toLowerCase())
          || (e.libraryFrom && x.libraryFrom === e.libraryFrom);
        const i = list.findIndex(same);
        if (i >= 0) {
          const merged = { ...list[i], ...e, id: list[i].id, addedAt: list[i].addedAt || nowIso(), updatedAt: nowIso() };
          merged.tags = [...new Set([...(list[i].tags || []), ...(e.tags || [])])].slice(0, 30);
          list[i] = merged;
          out.push(merged);
        } else {
          const id = e.id && !list.some((x) => x.id === e.id) ? e.id : rid('ast');
          const item = { ...e, id, addedAt: nowIso() };
          list.push(item);
          out.push(item);
        }
      }
      return { value: list, result: out };
    });
  },

  async patchAssets(paths, predicate, patch) {
    return updateJson(this.assetsFile(paths), [], (cur) => {
      const list = Array.isArray(cur) ? cur : [];
      let n = 0;
      const value = list.map((a) => { if (a && predicate(a)) { n++; return patch(a); } return a; });
      return { value, result: n };
    });
  },

  async listTechniques(paths) {
    const list = await readJson(this.techniquesFile(paths), []);
    return Array.isArray(list) ? list.filter((t) => t && typeof t === 'object' && t.id) : [];
  },

  async saveTechnique(paths, technique) {
    const t = normalizeTechnique(technique);
    return updateJson(this.techniquesFile(paths), [], (cur) => {
      const list = Array.isArray(cur) ? cur.filter((x) => x && x.id) : [];
      const i = list.findIndex((x) => x.id === t.id);
      if (i >= 0) {
        t.createdAt = list[i].createdAt || t.createdAt;
        list[i] = t;
      } else list.push(t);
      return { value: list, result: t };
    });
  },

  async deleteTechniques(paths, predicate) {
    return updateJson(this.techniquesFile(paths), [], (cur) => {
      const list = Array.isArray(cur) ? cur.filter((x) => x && x.id) : [];
      const removed = list.filter(predicate);
      return { value: list.filter((x) => !predicate(x)), result: removed };
    });
  },

  async patchTechniques(paths, predicate, patch) {
    return updateJson(this.techniquesFile(paths), [], (cur) => {
      const list = Array.isArray(cur) ? cur.filter((x) => x && x.id) : [];
      let n = 0;
      const value = list.map((t) => { if (predicate(t)) { n++; return patch(t); } return t; });
      return { value, result: n };
    });
  },
};

function isInside(child, parent) {
  const c = path.resolve(child).toLowerCase();
  const p = path.resolve(parent).toLowerCase();
  return c === p || c.startsWith(p + path.sep);
}

function strArr(v, max = 30) {
  return Array.isArray(v) ? v.map((x) => String(x == null ? '' : x).trim()).filter(Boolean).slice(0, max) : [];
}

function normalizeTechnique(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('技法卡数据无效');
  const title = String(raw.title || '').trim();
  if (!title) throw new Error('技法卡需要一个标题');
  let id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : '';
  // 内置卡不可改写：保存为一份用户副本
  if (!id || id.startsWith('bt_')) id = rid('tq');
  const t = {
    id,
    category: TECHNIQUE_CATEGORIES.includes(raw.category) ? raw.category : 'narrative',
    title: title.slice(0, 80),
    summary: String(raw.summary || '').trim().slice(0, 1000),
    steps: strArr(raw.steps, 20),
    whenToUse: String(raw.whenToUse || '').trim().slice(0, 500),
    tags: [...new Set(strArr(raw.tags, 20))],
    builtin: false,
    createdAt: raw.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
  if (raw.source && typeof raw.source === 'object' && raw.source.analysisId) {
    t.source = {
      analysisId: String(raw.source.analysisId),
      title: String(raw.source.title || ''),
      start: Number(raw.source.start) || 0,
      end: Number(raw.source.end) || 0,
    };
  }
  t.apply = raw.apply && typeof raw.apply === 'object' && Array.isArray(raw.apply.ops)
    ? { ops: raw.apply.ops, note: raw.apply.note ? String(raw.apply.note) : undefined }
    : null;
  if (t.apply && t.apply.note === undefined) delete t.apply.note;
  return t;
}

// ───────────────────────── 分析记录 ─────────────────────────

function analysisFile(paths, id) {
  if (!ID_RE.test(String(id || ''))) throw new Error('分析记录 id 无效');
  return path.join(paths.analyses, `${id}.json`);
}

async function readAnalysis(paths, id) {
  const a = await readJson(analysisFile(paths, id), null);
  if (!a || typeof a !== 'object') throw new Error('找不到这条拆片记录，可能已被删除');
  return a;
}

const listCache = new Map(); // id → { mtimeMs, summary }

function summarize(a, techCount) {
  const shots = Array.isArray(a.shots) ? a.shots : [];
  const thumb = (shots.find((s) => s && s.thumb) || {}).thumb || null;
  return {
    id: a.id,
    title: a.title || '未命名',
    category: a.category || 'other',
    duration: Number(a.duration) || 0,
    shotCount: shots.length,
    thumb,
    createdAt: a.createdAt || null,
    techniqueCount: techCount,
    status: a.status || 'done',
    hasAI: !!a.ai,
    source: a.source ? { type: a.source.type, url: a.source.url, platform: a.source.platform } : null,
  };
}

async function listAnalyses(paths) {
  let names = [];
  try { names = (await fs.promises.readdir(paths.analyses)).filter((n) => /^[A-Za-z0-9_-]+\.json$/.test(n)); } catch {}
  const techs = await libraryStore.listTechniques(paths);
  const byAnalysis = new Map();
  for (const t of techs) {
    const aid = t.source && t.source.analysisId;
    if (aid) { if (!byAnalysis.has(aid)) byAnalysis.set(aid, new Set()); byAnalysis.get(aid).add(t.id); }
  }
  const out = [];
  const seen = new Set();
  for (const n of names) {
    const id = n.slice(0, -5);
    seen.add(id);
    const file = path.join(paths.analyses, n);
    let st;
    try { st = await fs.promises.stat(file); } catch { continue; }
    let cached = listCache.get(id);
    if (!cached || cached.mtimeMs !== st.mtimeMs) {
      const a = await readJson(file, null);
      if (!a || typeof a !== 'object') continue;
      cached = { mtimeMs: st.mtimeMs, a: { ...a, shots: (a.shots || []).map((s) => ({ thumb: s && s.thumb })), id: a.id || id }, techIds: strArr(a.techniqueIds, 500) };
      listCache.set(id, cached);
    }
    const ids = new Set([...(cached.techIds || []), ...(byAnalysis.get(id) || [])]);
    out.push(summarize(cached.a, ids.size));
  }
  for (const k of listCache.keys()) if (!seen.has(k)) listCache.delete(k);
  out.sort((x, y) => String(y.createdAt || '').localeCompare(String(x.createdAt || '')));
  return out;
}

function registerAnalysisMedia(ctx, a) {
  if (!a) return;
  for (const p of [a.assetPath, a.source && a.source.path]) if (p) ctx.registerMediaPath(p);
}

async function linkTechniqueToAnalysis(paths, analysisId, techId, add) {
  let file;
  try { file = analysisFile(paths, analysisId); } catch { return; }
  if (!fs.existsSync(file)) return;
  await updateJson(file, null, (cur) => {
    if (!cur || typeof cur !== 'object') return { value: cur, result: null };
    const ids = strArr(cur.techniqueIds, 500);
    const next = add ? [...new Set([...ids, techId])] : ids.filter((x) => x !== techId);
    return { value: { ...cur, techniqueIds: next }, result: null };
  });
}

// ───────────────────────── 拆片任务 ─────────────────────────

async function startAnalysis(ctx, job, payload) {
  const { paths } = ctx;
  const ff = require('../lib/ff.cjs');
  const url = String(payload.url || '').trim();
  const localPath = String(payload.path || '').trim();
  const category = ANALYSIS_CATEGORIES.includes(payload.category) ? payload.category : 'other';
  const maxSeconds = payload.maxSeconds == null ? 600 : Math.max(0, Number(payload.maxSeconds) || 0);
  const id = rid('ana');
  let outDir = null;
  let finished = false;
  try {
    let file;
    let subtitlesFile = null;
    let title = String(payload.title || '').trim();
    let source;
    let assetPath;
    let base = 0;

    if (url) {
      if (!/^https?:\/\//i.test(url)) throw new Error('网址格式不正确，请粘贴以 http(s):// 开头的视频链接');
      const platform = yt.platformOf(url);
      job.progress('download', 0, '正在解析视频链接…');
      const dl = await yt.downloadVideo(paths, url, paths.libraryMedia, {
        maxSeconds: maxSeconds > 0 ? maxSeconds : 0,
        withSubs: true,
        signal: job.signal,
        fileBase: `${yt.safeBase(title || platform || 'video')}_${id.slice(4, 12)}`,
        onProgress: (p, msg) => job.progress('download', p * 0.35, msg),
      });
      file = dl.file;
      subtitlesFile = dl.subtitlesFile;
      if (!title) title = dl.info.title || '';
      job.throwIfCancelled();
      // 视频作为素材加入素材库（契约 C3：视频站下载的素材标为 videosite + reference，仅供参考）
      const author = dl.info.uploader || null;
      const asset = await web.buildAssetFromFile(ctx, file, {
        name: title || '拆片视频',
        proxyDir: paths.libraryMedia,
        signal: job.signal,
        source: {
          kind: 'videosite', provider: platform || '', url, pageUrl: url,
          ...(author ? { author } : {}), ...(title ? { title } : {}),
          type: 'library', platform, license: yt.WEB_LICENSE,
        },
        tags: web.makeTags(title, CATEGORY_LABELS[category], dl.info.tags),
        description: `拆片来源（${CATEGORY_LABELS[category]}）${author ? '；作者：' + author : ''}`,
        onProgress: (stage, p, msg) => job.progress(stage, 0.35 + p * 0.05, msg),
      });
      asset.license = { id: 'reference', name: yt.WEB_LICENSE };
      asset.reference = true;
      asset.analysisId = id;
      if (maxSeconds > 0) asset.clipSeconds = maxSeconds;
      if (subtitlesFile) asset.subtitlesPath = subtitlesFile;
      try { await libraryStore.addAssets(paths, [asset], { copy: false }); } catch (e) { console.warn('[analysis] 加入素材库失败', e.message); }
      assetPath = asset.path;
      source = { type: 'url', url, platform, path: file };
      base = 0.4;
    } else if (localPath) {
      if (!fs.existsSync(localPath)) throw new Error('找不到这个视频文件，可能已被移动或删除');
      file = path.resolve(localPath);
      ctx.registerMediaPath(file);
      if (!title) title = path.basename(file, path.extname(file));
      source = { type: 'file', path: file };
      assetPath = file;
      // 浏览器无法直接播放的格式 → 为详情页生成代理
      job.progress('probe', 0, '正在读取视频信息…');
      let info = null;
      try { info = await ff.probe(paths, file, { signal: job.signal }); } catch (e) {
        if (job.signal.aborted) throw e;
        throw new Error(e.message || '无法读取视频信息');
      }
      if (!info.hasVideo || info.kind !== 'video') throw new Error('这个文件没有视频画面，无法拆片');
      // 本地字幕：同名 .vtt / .srt
      for (const ext of ['.vtt', '.zh.vtt', '.srt']) {
        const cand = file.slice(0, -path.extname(file).length) + ext;
        if (fs.existsSync(cand)) { subtitlesFile = cand; break; }
      }
      if (ff.needsProxy(info, file)) {
        outDir = paths.analysisDir(id);
        const proxy = path.join(outDir, 'proxy.mp4');
        await ff.makeProxy(paths, file, proxy, { signal: job.signal, onProgress: (p) => job.progress('proxy', p * 0.15, `正在生成可播放的预览 ${Math.round(p * 100)}%`) });
        assetPath = proxy;
        base = 0.15;
      }
    } else {
      throw new Error('请提供视频网址或本地视频文件');
    }

    job.throwIfCancelled();
    outDir = outDir || paths.analysisDir(id);
    const result = await analyzeVideo({
      paths,
      file,
      outDir,
      maxSeconds,
      subtitlesFile,
      signal: job.signal,
      onProgress: (stage, p, msg) => job.progress(stage, base + (0.98 - base) * p, msg),
    });
    job.throwIfCancelled();
    const analysis = {
      id,
      title: (title || '未命名视频').slice(0, 120),
      category,
      source,
      ...result,
      assetPath: assetPath || result.assetPath,
      ai: null,
      techniqueIds: [],
      useAI: payload.useAI !== false,
    };
    await writeJsonAtomic(analysisFile(paths, id), analysis);
    registerAnalysisMedia(ctx, analysis);
    finished = true;
    job.progress('done', 1, `拆片完成：${analysis.shots.length} 个镜头`);
    return analysis;
  } finally {
    if (!finished) {
      try { fs.rmSync(path.join(paths.analyses, id), { recursive: true, force: true }); } catch {}
    }
  }
}

// ───────────────────────── 注册 ─────────────────────────

/** 契约 C4：视频站同意检查。consent.cjs 缺失（旧版本）时不拦截；未同意时抛出 code='NEED_CONSENT' 的错误。 */
function requireVideoSiteConsent(ctx) {
  let consent = null;
  try { consent = require('../lib/consent.cjs'); } catch { return; }
  if (!consent || typeof consent.requireConsent !== 'function') return;
  let settings = null;
  try { settings = ctx.settings && typeof ctx.settings.get === 'function' ? ctx.settings.get() : null; } catch { settings = null; }
  consent.requireConsent(settings, 'videoSites');
}

module.exports = function register({ handle, ctx }) {
  const { paths, jobs } = ctx;

  handle('analysis:start', async (payload = {}) => {
    payload = payload || {};
    if (!payload.url && !payload.path) throw new Error('请提供视频网址或本地视频文件');
    // 契约 C4：带视频站链接时，联网之前先确认用户已同意使用须知（未同意 → NEED_CONSENT，渲染端弹同意框后重试）
    if (payload.url) requireVideoSiteConsent(ctx);
    const title = payload.title || payload.url || (payload.path ? path.basename(payload.path) : '拆片');
    return jobs.start('analysis', (job) => startAnalysis(ctx, job, payload), { title: String(title).slice(0, 80), url: payload.url || null, path: payload.path || null });
  });

  handle('analysis:list', async () => listAnalyses(paths));

  handle('analysis:get', async ({ id } = {}) => {
    const a = await readAnalysis(paths, id);
    registerAnalysisMedia(ctx, a);
    return a;
  });

  handle('analysis:update', async ({ analysis } = {}) => {
    if (!analysis || typeof analysis !== 'object' || !analysis.id) throw new Error('要保存的拆片记录无效');
    const file = analysisFile(paths, analysis.id);
    const saved = await updateJson(file, null, (cur) => {
      if (!cur || typeof cur !== 'object') throw new Error('找不到这条拆片记录，可能已被删除');
      const next = {
        ...cur,
        ...analysis,
        id: cur.id,
        createdAt: cur.createdAt,
        source: cur.source,
        shots: Array.isArray(analysis.shots) ? analysis.shots : cur.shots,
        techniqueIds: strArr(analysis.techniqueIds != null ? analysis.techniqueIds : cur.techniqueIds, 500),
        updatedAt: nowIso(),
      };
      return { value: next, result: next };
    });
    registerAnalysisMedia(ctx, saved);
    return saved;
  });

  handle('analysis:delete', async ({ id } = {}) => {
    const file = analysisFile(paths, id);
    await withLock(file, async () => {
      for (const f of [file, file + '.bak']) { try { fs.rmSync(f, { force: true }); } catch {} }
    });
    try { fs.rmSync(path.join(paths.analyses, id), { recursive: true, force: true }); } catch (e) {
      throw new Error('删除分析文件夹失败（文件可能正被占用）：' + e.message);
    }
    listCache.delete(id);
    // 技法卡保留在「我的全部」里（删除确认框里向用户承诺过），只断开指向已删视频的链接，「跳到来源」随之隐藏
    await libraryStore.patchTechniques(
      paths,
      (t) => t.source && t.source.analysisId === id && !t.builtin,
      (t) => { const n = { ...t, updatedAt: nowIso() }; delete n.source; return n; },
    );
    await libraryStore.patchAssets(paths, (a) => a.analysisId === id, (a) => { const n = { ...a }; delete n.analysisId; return n; });
    return true;
  });

  handle('library:techniques', async ({ query, category } = {}) => {
    let list = await libraryStore.listTechniques(paths);
    if (category && TECHNIQUE_CATEGORIES.includes(category)) list = list.filter((t) => t.category === category);
    const q = String(query || '').trim();
    if (!q) return list.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return list
      .map((t) => ({ t, s: scoreText([t.title, t.title, t.summary, (t.tags || []).join(' '), (t.steps || []).join(' '), t.whenToUse].join('\n'), q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.t);
  });

  handle('library:saveTechnique', async ({ technique } = {}) => {
    const saved = await libraryStore.saveTechnique(paths, technique);
    if (saved.source && saved.source.analysisId) await linkTechniqueToAnalysis(paths, saved.source.analysisId, saved.id, true);
    return saved;
  });

  handle('library:deleteTechnique', async ({ id } = {}) => {
    if (!id) throw new Error('缺少技法卡 id');
    if (String(id).startsWith('bt_')) throw new Error('内置技法卡不能删除');
    const removed = await libraryStore.deleteTechniques(paths, (t) => t.id === id);
    for (const t of removed) if (t.source && t.source.analysisId) await linkTechniqueToAnalysis(paths, t.source.analysisId, t.id, false);
    return true;
  });

  handle('library:assets', async ({ query } = {}) => {
    const list = (await libraryStore.listAssets(paths)).filter((a) => a.path && fs.existsSync(a.path));
    for (const a of list) for (const p of [a.path, a.originalPath, a.thumb]) if (p) ctx.registerMediaPath(p);
    const q = String(query || '').trim();
    const sorted = list.sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')));
    if (!q) return sorted;
    return sorted
      .map((a) => ({ a, s: scoreText([a.name, (a.tags || []).join(' '), a.description].join('\n'), q) }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s)
      .map((x) => x.a);
  });

  handle('library:addAssets', async ({ assets } = {}) => {
    if (!Array.isArray(assets) || !assets.length) throw new Error('没有要加入素材库的素材');
    const saved = await libraryStore.addAssets(paths, assets, { copy: true });
    for (const a of saved) for (const p of [a.path, a.thumb]) if (p) ctx.registerMediaPath(p);
    return saved;
  });
};

module.exports.libraryStore = libraryStore;
module.exports._internals = { readJson, writeJsonAtomic, updateJson, normalizeTechnique, scoreText, listAnalyses, startAnalysis };
