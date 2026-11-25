'use strict';
// 媒体 IPC：探测、导入（含兼容代理）、缩略图、胶片条、波形、色彩统计（SPEC §2.2 media.cjs）
// 素材文件的三种路径（ROADMAP P0-9.1）：
//   originalPath 原片；
//   editPath     浏览器解不了原片时转出的高画质 H.264（≤1920，剪辑和导出都用它，此时 path = editPath）；
//   previewPath  预览代理（≤1280、每 15 帧一个关键帧），4K / 关键帧稀疏的素材后台生成，只给预览用（同时写 proxyPath 兼容旧渲染端）。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ff = require('../lib/ff.cjs');
const editProxy = require('../lib/proxy.cjs');
const encoders = require('../lib/encoders.cjs');
const { isUncPath } = require('../lib/urlSafety.cjs');
let analyzerLib = null;
function analyzer() { if (!analyzerLib) { try { analyzerLib = require('../lib/analyzer.cjs'); } catch { analyzerLib = {}; } } return analyzerLib; }

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
// 兼容文件（editPath）最长边：1080p 导出不再从 720p 放大，画质不打折
const EDIT_MAX_SIDE = 1920;
// 预览代理最长边
const PREVIEW_MAX_SIDE = 1280;
// 原片关键帧间隔超过这个秒数就后台生成预览代理（拖动时每次跳转都要从关键帧解码）
const SPARSE_GOP_SEC = 2;
const ENCODER_SETTINGS = ['auto', 'gpu', 'cpu'];

function requireFile(p) {
  if (!p || typeof p !== 'string') throw new Error('未提供文件路径');
  if (isUncPath(p)) throw new Error('出于安全考虑，不允许访问网络路径（UNC）');
  if (!path.isAbsolute(p)) throw new Error('文件路径必须是完整的绝对路径');
  const abs = path.resolve(p);
  if (isUncPath(abs)) throw new Error('出于安全考虑，不允许访问网络路径（UNC）');
  return abs;
}

function assetId() { return 'ast_' + crypto.randomBytes(6).toString('hex'); }

function safeStem(file) {
  const stem = path.basename(file, path.extname(file)).replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '');
  return (stem || 'media').slice(0, 40);
}

function isCancel(e) { return !!(e && e.code === 'CANCELLED'); }

async function usable(p) {
  try { const st = await fs.promises.stat(p); return st.isFile() && st.size > 0; } catch { return false; }
}

/** 简单的并发闸门：后台预览代理一次只转一个，不和导入、导出抢显卡和 CPU */
function createGate(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active -= 1; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

// ---------------------------------------------------------------------------
// 内置音乐与音效（契约 C16）：读 <目录>/manifest.json，附绝对路径；只收清单目录里真实存在的音频文件
// ---------------------------------------------------------------------------
const BUILTIN_AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|opus|flac)$/i;

function insideDir(root, file) {
  const r = path.resolve(root);
  const f = path.resolve(file);
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(f).startsWith(norm(r.endsWith(path.sep) ? r : r + path.sep));
}

function normLicense(raw) {
  if (raw && typeof raw === 'object') {
    const out = { id: String(raw.id || 'builtin') };
    if (raw.name) out.name = String(raw.name);
    if (raw.url) out.url = String(raw.url);
    return out;
  }
  if (typeof raw === 'string' && raw.trim()) return { id: raw.trim() };
  return { id: 'builtin' };
}

/**
 * 读取内置音频清单（纯函数，便于单测）。
 * @param {string|null} dir 清单所在目录
 * @returns {Array<{id,kind,title,duration,file,path,license,source,mood?,bpm?,author?,sourceUrl?}>}
 */
function readBuiltinAudio(dir) {
  if (!dir) return [];
  let manifest;
  try {
    // trim() 顺带去掉记事本保存时加的 BOM
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8').trim());
  } catch { return []; }
  const list = Array.isArray(manifest) ? manifest : manifest && Array.isArray(manifest.items) ? manifest.items : [];
  const out = [];
  const seen = new Set();
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const id = String(it.id || '').trim();
    const file = String(it.file || '').trim();
    if (!id || !file || seen.has(id)) continue;
    const abs = path.resolve(dir, file);
    if (!insideDir(dir, abs) || !BUILTIN_AUDIO_EXT.test(abs)) continue;
    try { if (!fs.statSync(abs).isFile()) continue; } catch { continue; }
    seen.add(id);
    const title = String(it.title || path.basename(file, path.extname(file))).trim();
    const author = it.author ? String(it.author) : '';
    const sourceUrl = it.sourceUrl ? String(it.sourceUrl) : '';
    out.push({
      ...it,
      id,
      kind: it.kind === 'sfx' ? 'sfx' : 'music',
      title,
      duration: Number(it.duration) > 0 ? Number(it.duration) : 0,
      file,
      path: abs,
      license: normLicense(it.license),
      // 加入工程建素材时直接用（契约 C3 / C16）
      source: { kind: 'builtin', id, title, author, url: sourceUrl },
    });
  }
  return out;
}

function builtinAudioDir(paths) {
  try { if (paths && paths.builtinAudio) return paths.builtinAudio; } catch {}
  const cands = [];
  if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'builtin-audio'));
  cands.push(path.join(__dirname, '..', '..', 'build', 'builtin-audio'));
  for (const d of cands) { try { if (fs.statSync(path.join(d, 'manifest.json')).isFile()) return d; } catch {} }
  return null;
}

module.exports = function register({ handle, ctx }) {
  const paths = ctx.paths;

  const reg = (p) => { if (typeof p === 'string' && p) ctx.registerMediaPath(p); };
  const bgGate = createGate(1);

  // 编码器探测结果缓存到 userData/encoders.json（契约 C12）；启动几秒后后台预热，第一次导入/导出不用等
  try { encoders.setCacheFile(path.join(paths.userData || paths.cache, 'encoders.json')); } catch {}
  const warm = setTimeout(() => {
    try { const bin = paths.ffmpeg; if (bin) encoders.probeEncoders(bin).catch(() => {}); } catch {}
  }, 4000);
  if (warm && typeof warm.unref === 'function') warm.unref();

  /** 设置项 media.encoder：'auto' | 'gpu' | 'cpu'（默认 auto；未显式覆盖时尊重 export.hwaccel === 'off'） */
  function encoderSetting() {
    try {
      const s = ctx.settings && typeof ctx.settings.get === 'function' ? ctx.settings.get() : null;
      const m = s ? s.media : null;
      const enc = m && ENCODER_SETTINGS.includes(m.encoder) ? m.encoder : 'auto';
      if (enc === 'auto' && s && s.export && s.export.hwaccel === 'off') return 'cpu';
      return enc;
    } catch { return 'auto'; }
  }
  const preferHw = () => encoders.preferHwFor(encoderSetting(), { purpose: 'proxy' });

  function proxyDir(projectId) {
    if (projectId && typeof projectId === 'string' && ID_RE.test(projectId)) {
      try { return paths.projectCache(projectId); } catch {}
    }
    const dir = path.join(paths.cache, 'proxies');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * 浏览器解不了的素材：转成最长边 ≤1920 的高画质 H.264（editPath；剪辑预览和导出都用它，关键帧密，拖动也顺）。
   * 已有可用文件就复用（同一文件重复导入时秒完成）。
   */
  async function ensureProxy(file, info, projectId, signal, onProgress) {
    const sig = await ff.fileSig(file);
    const ext = info.kind === 'audio' ? '.m4a' : '.mp4';
    const out = path.join(proxyDir(projectId), `${safeStem(file)}-${ff.hashKey('edit1920', sig)}.edit${ext}`);
    if (await usable(out)) {
      try {
        const p = await ff.probe(paths, out, { signal });
        if (!ff.needsProxy(p, out) && (!info.duration || Math.abs((p.duration || 0) - info.duration) < Math.max(1, info.duration * 0.05))) {
          onProgress(1);
          return { path: out, info: p };
        }
      } catch (e) { if (isCancel(e)) throw e; }
    }
    await ff.makeProxy(paths, file, out, { signal, onProgress, maxSide: EDIT_MAX_SIDE, quality: 'high', purpose: 'preview', preferHw: preferHw() });
    const p = await ff.probe(paths, out, { signal });
    return { path: out, info: p };
  }

  function previewPathFor(projectId, file, sig) {
    return path.join(proxyDir(projectId), `${safeStem(file)}-${ff.hashKey('preview1280', sig)}.preview.mp4`);
  }

  /**
   * 后台生成预览代理（≤1280、每 15 帧一个关键帧）。一次只转一个。
   * 完成后 job:done(kind='proxy') 回传 { projectId, assetId, proxyPath, previewPath }（两个字段同值，proxyPath 兼容旧渲染端）。
   */
  function startPreviewJob(assetId, projectId, file, out) {
    return ctx.jobs.start('proxy', async (job) => {
      const name = path.basename(file);
      job.progress('优化预览', 0, `${name}（排队中）`);
      if (!(await usable(out))) {
        await bgGate(async () => {
          job.throwIfCancelled();
          await ff.makeProxy(paths, file, out, {
            signal: job.signal, maxSide: PREVIEW_MAX_SIDE, quality: 'proxy', purpose: 'proxy', preferHw: preferHw(),
            onProgress: (p) => job.progress('优化预览', p, `${name}（${Math.round(p * 100)}%）`),
          });
        });
      }
      reg(out);
      return { projectId: projectId || null, assetId, proxyPath: out, previewPath: out };
    }, { projectId: projectId || null, assetId, background: true });
  }

  /** 540p 全 I 帧剪辑代理（显式请求时用；编码器按优先级选） */
  function startProxyJob(assetId, projectId, file, out, info) {
    return ctx.jobs.start('proxy', async (job) => {
      job.progress('生成剪辑代理', 0, path.basename(file));
      await bgGate(() => editProxy.makeEditProxy({
        ffmpeg: paths.ffmpeg, input: file, output: out, info, signal: job.signal, preferHw: preferHw(),
        onProgress: (p) => job.progress('生成剪辑代理', p, `${path.basename(file)}（${Math.round(p * 100)}%）`),
      }));
      reg(out);
      return { projectId: projectId || null, assetId, proxyPath: out };
    }, { projectId: projectId || null, assetId, background: true });
  }

  handle('media:makeProxy', async ({ projectId, assetId, path: p, tier } = {}) => {
    const file = requireFile(p);
    const info = await ff.probe(paths, file);
    const sig = await ff.fileSig(file).catch(() => '');
    if (tier === 'preview') return startPreviewJob(assetId || null, projectId, file, previewPathFor(projectId, file, sig));
    const out = editProxy.proxyPathFor(proxyDir(projectId), file, sig);
    return startProxyJob(assetId || null, projectId, file, out, info);
  });

  /** 编码器信息（设置页「视频编码」用）：可用编码器、当前会用哪个、是否有显卡加速；refresh=true 重新探测 */
  handle('media:encoders', async ({ refresh = false } = {}) => {
    const bin = paths.ffmpeg;
    if (!bin) return { setting: encoderSetting(), h264: [], hevc: [], hasGpu: false, options: [], selected: null, checkedAt: null, error: '找不到 ffmpeg 组件' };
    return encoders.describeEncoders(bin, { setting: encoderSetting(), force: !!refresh });
  });

  /** 内置音乐与音效（契约 C16）：清单条目附绝对路径 path，并已注册到 ffmedia://；没有清单时返回 [] */
  handle('media:builtinAudio', async () => {
    const items = readBuiltinAudio(builtinAudioDir(paths));
    items.forEach((it) => reg(it.path));
    return items;
  });

  handle('media:beats', async ({ path: p } = {}) => {
    const file = requireFile(p);
    if (typeof analyzer().detectBeats !== 'function') throw new Error('节拍检测不可用');
    return analyzer().detectBeats(file, { paths });
  });

  async function importOne(file, projectId, job, report) {
    const name = path.basename(file, path.extname(file)) || path.basename(file);
    report(0.02, `读取信息：${path.basename(file)}`);
    const info = await ff.probe(paths, file, { signal: job.signal });
    job.throwIfCancelled();
    const proxy = ff.needsProxy(info, file);
    const W = proxy ? { probe: 0.05, proxyEnd: 0.85, thumb: 0.93 } : { probe: 0.3, proxyEnd: 0.3, thumb: 0.7 };
    report(W.probe, `读取信息：${path.basename(file)}`);

    let playPath = file;
    if (proxy) {
      report(W.probe, `转换为兼容格式：${path.basename(file)}`);
      const r = await ensureProxy(file, info, projectId, job.signal, (p) => {
        report(W.probe + (W.proxyEnd - W.probe) * p, `转换为兼容格式：${path.basename(file)}（${Math.round(p * 100)}%）`);
      });
      playPath = r.path;
      job.throwIfCancelled();
    }

    // 缩略图
    report(W.thumb - 0.02, `生成缩略图：${path.basename(file)}`);
    let thumb = null;
    if (info.kind === 'video') {
      const t = Math.min(1, (info.duration || 0) * 0.1);
      try { thumb = await ff.thumb(paths, file, t, 320); } catch (e) {
        if (isCancel(e)) throw e;
        if (playPath !== file) { try { thumb = await ff.thumb(paths, playPath, t, 320); } catch {} }
      }
    } else if (info.kind === 'image') {
      try { thumb = await ff.thumb(paths, file, 0, 320); } catch (e) { if (isCancel(e)) throw e; }
    } else if (info.kind === 'audio' && info.hasCover) {
      try { thumb = await ff.thumb(paths, file, 0, 320); } catch (e) { if (isCancel(e)) throw e; }
    }
    job.throwIfCancelled();

    // 色彩统计（一张中间帧；失败为 undefined）
    report(W.thumb, `分析色彩：${path.basename(file)}`);
    let stats;
    if (info.kind === 'video') {
      try {
        const [s] = await ff.colorStats(paths, file, [(info.duration || 0) / 2], { signal: job.signal });
        stats = s || undefined;
      } catch (e) { if (isCancel(e)) throw e; }
    } else if (info.kind === 'image') {
      try { stats = await ff.colorStatsFromImage(paths, file, { signal: job.signal }); } catch (e) { if (isCancel(e)) throw e; }
    }
    job.throwIfCancelled();

    const asset = {
      id: assetId(),
      kind: info.kind,
      name,
      path: playPath,
      originalPath: file,
      duration: info.duration || (info.kind === 'image' ? 5 : 0),
      width: info.width || 0,
      height: info.height || 0,
      fps: info.fps || 0,
      hasAudio: !!info.hasAudio,
      size: info.size || 0,
      thumb,
      source: { type: 'local' },
      tags: [],
      description: '',
      proxied: playPath !== file,
      codec: { video: info.vcodec || null, audio: info.acodec || null },
    };
    if (playPath !== file) asset.editPath = playPath;
    if (info.durationUnknown) asset.durationUnknown = true;
    if (stats) asset.stats = stats;

    // 音频：节拍检测（失败不影响导入，最多 20 秒；超时主动中止 ffmpeg 并清定时器）
    if (info.kind === 'audio' && typeof analyzer().detectBeats === 'function') {
      report(0.96, `检测节拍：${path.basename(file)}`);
      const ac = new AbortController();
      let timedOut = false;
      const onJobAbort = () => ac.abort();
      if (job.signal) {
        if (job.signal.aborted) ac.abort();
        else job.signal.addEventListener('abort', onJobAbort, { once: true });
      }
      const timer = setTimeout(() => { timedOut = true; ac.abort(); }, 20000);
      try {
        const p = Promise.resolve().then(() => analyzer().detectBeats(file, { paths, signal: ac.signal }));
        p.catch(() => {});
        const beats = await p;
        if (Array.isArray(beats) && beats.length) asset.beats = beats;
      } catch (e) {
        if (job.signal && job.signal.aborted) throw e;
        if (timedOut && isCancel(e)) {
          console.warn('[media:import] 节拍检测超时（20 秒），已跳过');
        } else if (isCancel(e)) {
          throw e;
        } else {
          console.warn('[media:import] 节拍检测失败', e && e.message);
        }
      } finally {
        clearTimeout(timer);
        if (job.signal) job.signal.removeEventListener('abort', onJobAbort);
      }
    }

    // 预览代理（≤1280、每 15 帧一个关键帧）：原片能直接播、但 4K / 解码重（VP9、AV1）/ 关键帧稀疏（>2 秒）时后台生成。
    // 已经转过兼容文件（editPath，本身关键帧就密）的不再生成。完成后 job:done(kind='proxy') 回传 { projectId, assetId, proxyPath, previewPath }
    if (info.kind === 'video' && playPath === file && (info.duration || 0) > 3) {
      try {
        let want = editProxy.needsEditProxy(info);
        if (!want) {
          const gop = await ff.keyframeInterval(paths, file, { signal: job.signal }).catch((e) => { if (isCancel(e)) throw e; return null; });
          want = gop != null && gop > SPARSE_GOP_SEC;
        }
        if (want) {
          const sig = await ff.fileSig(file).catch(() => '');
          const out = previewPathFor(projectId, file, sig);
          if (await usable(out)) { asset.previewPath = out; asset.proxyPath = out; reg(out); }
          else startPreviewJob(asset.id, projectId, file, out);
        }
      } catch (e) {
        if (isCancel(e)) throw e;
        console.warn('[media:import] 预览代理排队失败', e && e.message);
      }
    }
    reg(asset.path); reg(asset.originalPath); reg(asset.thumb);
    report(1, `完成：${path.basename(file)}`);
    return asset;
  }

  handle('media:probe', async ({ path: p } = {}) => {
    const file = requireFile(p);
    return ff.probe(paths, file);
  });

  handle('media:import', async ({ paths: list, projectId } = {}) => {
    if (!Array.isArray(list) || !list.length) throw new Error('没有选择要导入的文件');
    const seen = new Set();
    const files = [];
    for (const p of list) {
      if (typeof p !== 'string' || !p || isUncPath(p) || !path.isAbsolute(p)) continue;
      const abs = path.resolve(p);
      if (isUncPath(abs)) continue;
      const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
      if (seen.has(key)) continue;
      seen.add(key);
      files.push(abs);
    }
    if (!files.length) throw new Error('文件路径无效');

    return ctx.jobs.start('import', async (job) => {
      const n = files.length;
      const assets = [];
      const errors = [];
      for (let i = 0; i < n; i++) {
        job.throwIfCancelled();
        const file = files[i];
        const report = (p, msg) => job.progress(n > 1 ? `导入 ${i + 1}/${n}` : '导入', (i + Math.max(0, Math.min(1, p))) / n, msg);
        try {
          assets.push(await importOne(file, projectId, job, report));
        } catch (e) {
          if (isCancel(e) || job.cancelled) throw e;
          const msg = String((e && e.message) || e);
          errors.push(msg.includes(path.basename(file)) ? msg : `${path.basename(file)}：${msg}`);
          console.warn('[media:import]', file, msg);
        }
      }
      if (!assets.length) {
        if (n === 1) throw new Error(errors[0] || '导入失败');
        throw new Error(`${n} 个文件全部导入失败：${errors.slice(0, 3).join('；')}${errors.length > 3 ? '…' : ''}`);
      }
      job.progress('完成', 1, errors.length ? `已导入 ${assets.length} 个，${errors.length} 个失败：${errors.slice(0, 2).join('；')}` : `已导入 ${assets.length} 个素材`);
      return assets;
    }, { count: files.length, projectId: projectId || null });
  });

  handle('media:thumb', async ({ path: p, time = 0, width = 320 } = {}) => {
    const file = requireFile(p);
    const out = await ff.thumb(paths, file, Number(time) || 0, Number(width) || 320);
    reg(out);
    return out;
  });

  // 胶片条（契约 C5）：start/end（秒，可选）只在这段区间里均匀取帧——片段裁剪后胶片条跟着变。
  // 每帧按 文件签名 + 时间（对齐到 0.04 秒）+ 高度 缓存到磁盘，同一素材反复拖动/裁剪不重复抽帧。
  handle('media:filmstrip', async ({ path: p, duration, count = 10, height = 60, start, end } = {}) => {
    const file = requireFile(p);
    const out = await ff.filmstrip(paths, file, { duration, count, height, start, end });
    for (const f of new Set(out)) if (f) reg(f);
    return out;
  });

  handle('media:waveform', async ({ path: p, peaksPerSecond = 50 } = {}) => {
    const file = requireFile(p);
    return ff.waveform(paths, file, Number(peaksPerSecond) || 50);
  });

  handle('media:colorStats', async ({ path: p, times } = {}) => {
    const file = requireFile(p);
    const list = Array.isArray(times) ? times.map(Number).filter((t) => Number.isFinite(t) && t >= 0).slice(0, 200) : [];
    if (ff.isImageFile(file)) {
      const s = await ff.colorStatsFromImage(paths, file);
      return (list.length ? list : [0]).map(() => s);
    }
    return ff.colorStats(paths, file, list);
  });
};

// 供单测：内置音效清单解析（不依赖 electron）
module.exports.readBuiltinAudio = readBuiltinAudio;
module.exports.builtinAudioDir = builtinAudioDir;
