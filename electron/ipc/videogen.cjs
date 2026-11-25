'use strict';
// AI 真人视频生成 IPC：videogen:providers / test / generate / resume
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ff = require('../lib/ff.cjs');
const encoders = require('../lib/encoders.cjs');
const { run } = require('../lib/proc.cjs');
const vg = require('../lib/videogen/index.cjs');

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const RATIOS = new Set(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']);
// 参考图（首帧）：长边超过 1920、文件超过 2.5MB 或不是 PNG/JPG/WebP 时先压成 JPEG 再上传（上传更快，也不会超服务商的大小限制）
const REF_MAX_SIDE = 1920;
const REF_MAX_BYTES = 2.5 * 1024 * 1024;
const REF_DIRECT_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
// 素材上的 ai.provider 统一用平台名：Seedance 属于即梦
const AI_PROVIDER = { seedance: 'jimeng' };

function isCancel(e) { return !!(e && e.code === 'CANCELLED'); }
function sha1(s) { return crypto.createHash('sha1').update(String(s)).digest('hex'); }
function aiProviderOf(id) { return AI_PROVIDER[id] || String(id || 'unknown'); }

/** 工程里的素材表：新格式是 { [id]: asset }，旧格式是数组，两种都认 */
function projectAssets(proj) {
  if (!proj || !proj.assets || typeof proj.assets !== 'object') return [];
  return Array.isArray(proj.assets) ? proj.assets : Object.values(proj.assets);
}

/** 生成的视频导入为素材时的 AI 标记字段（纯函数，便于单测） */
function aiFields({ provider, model, prompt, taskId, name, createdAt } = {}) {
  const ap = aiProviderOf(provider);
  const ai = { provider: ap, createdAt: createdAt || new Date().toISOString() };
  if (model) ai.model = String(model);
  if (prompt) ai.prompt = String(prompt).slice(0, 1000);
  const source = { kind: 'ai', provider: ap };
  if (taskId) source.id = String(taskId);
  if (name) source.title = String(name);
  return { ai, source, license: { id: 'ai' } };
}

module.exports = function register({ handle, ctx }) {
  const { paths, settings } = ctx;
  const limiter = vg.createLimiter(2);
  const fetchFn = (...a) => globalThis.fetch(...a);

  /** 设置项 media.encoder（'auto' | 'gpu' | 'cpu'）→ 转码时是否优先显卡；未显式覆盖时尊重 export.hwaccel === 'off' */
  function preferHw() {
    let setting = 'auto';
    try {
      const s = settings && settings.get ? settings.get() : null;
      const enc = s && s.media && ['auto', 'gpu', 'cpu'].includes(s.media.encoder) ? s.media.encoder : 'auto';
      setting = enc === 'auto' && s && s.export && s.export.hwaccel === 'off' ? 'cpu' : enc;
    } catch {}
    return encoders.preferHwFor(setting, { purpose: 'proxy' });
  }

  function outDir(projectId) {
    if (projectId && ID_RE.test(projectId)) {
      try { const d = path.join(paths.projectCache(projectId), 'ai-videos'); fs.mkdirSync(d, { recursive: true }); return d; } catch {}
    }
    const d = path.join(paths.cache, 'ai-videos');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  async function readProject(projectId) {
    if (!projectId || !ID_RE.test(projectId)) return null;
    try { return JSON.parse(await fs.promises.readFile(path.join(paths.projectDir(projectId), 'project.json'), 'utf8')); } catch { return null; }
  }

  /**
   * 参考图 → data URL。小图（PNG/JPG/WebP、长边 ≤1920、≤2.5MB）直接读；
   * 大图或其它格式用 ffmpeg 压成长边 ≤1920 的 JPEG；视频素材取一帧（不用 320 像素的缩略图，太小会被服务商拒绝）。
   */
  async function refImageDataUrl(file, { video = false, duration = 0, signal } = {}) {
    if (/^(data:|https?:)/i.test(file)) return file;
    let st;
    try { st = await fs.promises.stat(file); } catch { throw new vg.util.VideogenError('参考图文件不存在或已被移动，请重新选择', 'BAD_IMAGE'); }
    if (!st.isFile() || st.size <= 0) throw new vg.util.VideogenError('参考图不是有效的图片文件，请重新选择', 'BAD_IMAGE');
    const ext = path.extname(file).toLowerCase();
    if (!video && !ff.isImageFile(file)) {
      throw new vg.util.VideogenError('参考图只支持常见图片格式（PNG/JPG/WebP/BMP/GIF 等）', 'BAD_IMAGE');
    }
    let w = 0; let h = 0;
    if (!video && paths && paths.ffprobe) {
      let info;
      try {
        info = await ff.probe(paths, file, { signal, measure: false });
      } catch (e) {
        if (isCancel(e)) throw e;
        throw new vg.util.VideogenError('所选文件不是有效的图片，请重新选择', 'BAD_IMAGE');
      }
      if (!info || info.kind !== 'image' || !(info.width > 0 && info.height > 0)) {
        throw new vg.util.VideogenError('所选文件不是有效的图片，请重新选择', 'BAD_IMAGE');
      }
      w = info.width;
      h = info.height;
    }
    if (!video && REF_DIRECT_EXT.has(ext) && st.size <= REF_MAX_BYTES) {
      if (w > 0 && h > 0 && Math.max(w, h) <= REF_MAX_SIDE) return vg.util.imageToDataUrl(file);
    }
    const fallback = () => {
      if (!video && REF_DIRECT_EXT.has(ext)) return vg.util.imageToDataUrl(file); // 压缩失败：≤10MB 的原图照样能发
      throw new vg.util.VideogenError('参考图读取失败，请换一张 PNG 或 JPG 图片', 'BAD_IMAGE');
    };
    if (!paths.ffmpeg) return fallback();
    const dir = path.join(paths.cache, 'videogen-ref');
    const out = path.join(dir, `${crypto.randomBytes(6).toString('hex')}.jpg`);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
      if (video && duration > 0) args.push('-ss', String(Math.min(1, duration * 0.1)));
      args.push('-i', file, '-frames:v', '1', '-an',
        '-vf', `scale=w='min(${REF_MAX_SIDE},iw)':h='min(${REF_MAX_SIDE},ih)':force_original_aspect_ratio=decrease:flags=lanczos,format=yuvj420p`,
        '-q:v', '3', out);
      const r = await run(paths.ffmpeg, args, { signal, timeoutMs: 30000 });
      if (!r || r.code !== 0) return fallback();
      return vg.util.imageToDataUrl(out);
    } catch (e) {
      if (isCancel(e)) throw e;
      return fallback();
    } finally {
      fs.promises.rm(out, { force: true }).catch(() => {});
    }
  }

  /** 参考图（首帧）：imagePath 优先；否则按 imageAssetId 在项目里找（图片用原图，视频取一帧） */
  async function resolveImage(payload, signal) {
    if (payload.imagePath != null && payload.imagePath !== '') {
      if (typeof payload.imagePath !== 'string' || !path.isAbsolute(payload.imagePath)) {
        throw new vg.util.VideogenError('参考图路径无效，请重新选择图片文件', 'BAD_IMAGE');
      }
      if (!ff.isImageFile(payload.imagePath)) {
        throw new vg.util.VideogenError('参考图只支持常见图片格式（PNG/JPG/WebP/BMP/GIF 等）', 'BAD_IMAGE');
      }
      return refImageDataUrl(payload.imagePath, { signal });
    }
    if (!payload.imageAssetId) return undefined;
    const proj = await readProject(payload.projectId);
    const a = projectAssets(proj).find((x) => x && x.id === payload.imageAssetId);
    if (!a) throw new vg.util.VideogenError('找不到这个镜头的参考图，请先保存工程后重试', 'BAD_IMAGE');
    const isImage = /image|previz/.test(String(a.kind || ''));
    if (isImage) {
      const file = a.originalPath || a.path;
      if (file) return refImageDataUrl(file, { signal });
    } else if (a.kind === 'video' && (a.path || a.originalPath)) {
      try { return await refImageDataUrl(a.path || a.originalPath, { video: true, duration: a.duration, signal }); } catch (e) { if (isCancel(e)) throw e; }
    }
    if (a.thumb) return refImageDataUrl(a.thumb, { signal });
    throw new vg.util.VideogenError('参考素材没有可用的画面', 'BAD_IMAGE');
  }

  // ------------------------- 演示样例 -------------------------
  function sampleDirs() {
    const out = [];
    if (process.resourcesPath) out.push(path.join(process.resourcesPath, 'sample-media'));
    out.push(path.join(__dirname, '..', '..', 'build', 'sample-media'));
    return out;
  }
  function listSamples() {
    for (const d of sampleDirs()) {
      try {
        const files = fs.readdirSync(d).filter((f) => /\.mp4$/i.test(f)).sort().map((f) => path.join(d, f));
        if (files.length) return files;
      } catch {}
    }
    return [];
  }
  async function mockSource(input, taskId) {
    const samples = listSamples();
    if (samples.length) {
      const idx = parseInt(sha1(input.prompt || taskId).slice(0, 8), 16) % samples.length;
      return samples[idx];
    }
    // 没有打包样例时，用 ffmpeg 生成一段 5 秒的演示片（仅用于无网络/无 key 演示）。编码器按本机可用的选（LGPL 版 ffmpeg 没有 x264）
    const out = path.join(paths.cache, 'videogen-demo.mp4');
    if (fs.existsSync(out)) return out;
    if (!paths.ffmpeg) return null;
    const sources = [
      ['-f', 'lavfi', '-i', 'gradients=s=1280x720:d=5:speed=0.02:c0=0x1d2b3a:c1=0x6d8a6a:c2=0xc8a26a', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-shortest', '-c:a', 'aac'],
      ['-f', 'lavfi', '-i', 'color=c=0x2a3440:s=1280x720:d=5'],
    ];
    const tmp = `${out}.${crypto.randomBytes(3).toString('hex')}.part.mp4`;
    try {
      await encoders.withH264({ ffmpegPath: paths.ffmpeg, purpose: 'videogen', quality: 'standard', width: 1280, height: 720, fps: 30, preferHw: preferHw() }, async (enc) => {
        let last = null;
        for (const src of sources) {
          const r = await run(paths.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...src, ...enc.args, '-t', '5', '-f', 'mp4', tmp]).catch((e) => ({ code: -1, stderr: String((e && e.message) || e) }));
          if (r && r.code === 0) return;
          last = new Error(`演示视频生成失败（${String((r && r.stderr) || '').trim().split(/\r?\n/).slice(-1)[0] || '未知原因'}）`);
        }
        throw last;
      });
      await fs.promises.rename(tmp, out);
    } catch (e) {
      console.warn('[videogen] 演示视频生成失败', e && e.message);
    } finally {
      fs.promises.rm(tmp, { force: true }).catch(() => {});
    }
    return fs.existsSync(out) ? out : null;
  }

  // ------------------------- 导入为素材 -------------------------
  async function importGenerated(file, meta, signal) {
    let info = await ff.probe(paths, file, { signal });
    if (info.kind !== 'video') throw new vg.util.VideogenError('服务商返回的不是视频文件，请重新生成', 'BAD_VIDEO');
    // 少数服务商会给 HEVC 等浏览器播不了的编码：转一份 ≤1920 的高画质 H.264（剪辑和导出都用它）
    let playPath = file;
    if (ff.needsProxy(info, file)) {
      const out = file.replace(/\.mp4$/i, '') + '.edit.mp4';
      try {
        const st = await fs.promises.stat(out).catch(() => null);
        if (!(st && st.size > 0)) await ff.makeProxy(paths, file, out, { signal, maxSide: 1920, quality: 'high', purpose: 'preview', preferHw: preferHw() });
        playPath = out;
        info = { ...(await ff.probe(paths, out, { signal })), durationUnknown: info.durationUnknown };
      } catch (e) {
        if (isCancel(e)) throw e;
        console.warn('[videogen] 转换为兼容格式失败', e && e.message);
      }
    }
    let thumb = null;
    try { thumb = await ff.thumb(paths, playPath, Math.min(1, (info.duration || 0) * 0.1), 320); } catch (e) { if (isCancel(e)) throw e; }
    const short = String(meta.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    const name = `AI · ${short || vg.getProvider(meta.provider).label}`;
    const model = meta.model || '';
    const asset = {
      id: 'ast_' + crypto.randomBytes(6).toString('hex'),
      kind: 'video',
      name,
      path: playPath,
      originalPath: file,
      duration: info.duration || 0,
      width: info.width || 0,
      height: info.height || 0,
      fps: info.fps || 0,
      hasAudio: !!info.hasAudio,
      size: info.size || 0,
      thumb,
      // 来源对象 + ai 标记 + 许可（旧代码按字符串 source==='videogen' 判断的，都已兼容 source.kind==='ai' 和 asset.ai）
      ...aiFields({ provider: meta.provider, model, prompt: meta.prompt, taskId: meta.taskId, name }),
      credit: `${vg.getProvider(meta.provider).label} 生成`,
      tags: ['AI 生成'],
      description: meta.prompt || '',
      proxied: playPath !== file,
      codec: { video: info.vcodec || null, audio: info.acodec || null },
      meta: { videogen: { provider: meta.provider, prompt: meta.prompt || '', taskId: meta.taskId, model } },
    };
    if (playPath !== file) asset.editPath = playPath;
    if (info.durationUnknown) asset.durationUnknown = true;
    ctx.registerMediaPath(asset.path);
    if (asset.originalPath !== asset.path) ctx.registerMediaPath(asset.originalPath);
    if (thumb) ctx.registerMediaPath(thumb);
    return asset;
  }

  function deps(job) {
    return { fetch: fetchFn, signal: job.signal, mockSource };
  }

  /** 公共流程：等待/提交 → 下载 → 导入 */
  async function execute(job, { p, cfg, input, taskId: existing, projectId, meta }) {
    const d = deps(job);
    let polls = 0;
    const pollOpts = p.isMock ? { interval: 700, maxInterval: 700 } : undefined;
    const onStatus = (st) => {
      polls += 1;
      const prog = st.progress > 0 ? st.progress : Math.min(0.9, 0.08 + polls * 0.04);
      job.progress(vg.STAGE[st.state] || '生成中', 0.05 + prog * 0.8, `${p.label} · ${vg.STAGE[st.state] || '生成中'}…`);
    };
    return limiter.run(p.id, async () => {
      job.throwIfCancelled();
      let taskId = existing;
      let result;
      if (existing) {
        job.progress('生成中', 0.1, `${p.label} · 恢复任务…`);
        result = await vg.waitTask(p, existing, cfg, d, { onStatus, pollOpts });
      } else {
        job.progress('排队中', 0.03, `${p.label} · 提交任务…`);
        const r = await vg.runTask(p, input, cfg, d, { onStatus, pollOpts, onSubmitted: (id) => { taskId = id; job.meta.taskId = id; job.progress('排队中', 0.05, `${p.label} · 已提交`); } });
        result = r.result;
      }
      job.throwIfCancelled();
      job.progress('下载中', 0.86, '下载生成的视频…');
      const dest = path.join(outDir(projectId), `${sha1(`${p.id}:${taskId}`)}.mp4`);
      if (!fs.existsSync(dest)) {
        if (result.localPath) await fs.promises.copyFile(result.localPath, dest);
        else {
          const allowedOrigins = cfg && cfg.baseUrl ? [cfg.baseUrl] : [];
          await vg.util.downloadWithRetry(fetchFn, result.url, dest, { headers: result.headers || {}, signal: job.signal, allowedOrigins, onProgress: (x) => job.progress('下载中', 0.86 + x * 0.1, `下载中 ${Math.round(x * 100)}%`) });
        }
      }
      job.progress('下载中', 0.97, '导入素材…');
      const asset = await importGenerated(dest, { ...meta, provider: p.id, taskId, model: cfg.model || p.defaultModel }, job.signal);
      job.progress('完成', 1, '生成完成');
      return { asset, taskId, provider: p.id, shotId: meta.shotId || null };
    }, () => job.progress('排队中', 0.01, `${p.label} 同时最多 2 个任务，正在排队…`));
  }

  handle('videogen:providers', async () => vg.describe(settings));

  handle('videogen:test', async ({ provider } = {}) => {
    const p = vg.getProvider(provider);
    const cfg = vg.resolveConfig(settings, p.id);
    if (!vg.isConfigured(p, cfg)) return { ok: false, error: '尚未填写密钥' };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    const t0 = Date.now();
    try {
      await p.test(cfg, { fetch: fetchFn, signal: ac.signal, mockSource });
      return { ok: true, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, error: isCancel(e) ? '连接超时（20 秒）' : (e && e.message) || String(e), ms: Date.now() - t0 };
    } finally { clearTimeout(timer); }
  });

  handle('videogen:generate', async (payload = {}) => {
    const id = payload.provider || (settings.get().videogen || {}).provider || 'mock';
    const p = vg.getProvider(id);
    const cfg = vg.resolveConfig(settings, p.id);
    if (!vg.isConfigured(p, cfg)) { const e = new Error(`尚未配置 ${p.label} 的密钥，请在「设置 → AI 视频生成」填写`); e.code = 'NO_KEY'; throw e; }
    const prompt = String(payload.prompt || '').trim().slice(0, 2000);
    if (!prompt && !payload.imageAssetId && !payload.imagePath) throw new Error('请填写画面描述');
    if (payload.imagePath != null && payload.imagePath !== '') {
      if (typeof payload.imagePath !== 'string' || !path.isAbsolute(payload.imagePath) || !ff.isImageFile(payload.imagePath)) {
        throw new vg.util.VideogenError('参考图必须是有效的图片文件（PNG/JPG/WebP 等）', 'BAD_IMAGE');
      }
    }
    const baseInput = {
      prompt,
      negative: payload.negative ? String(payload.negative).slice(0, 1000) : undefined,
      duration: Math.max(1, Math.min(20, Number(payload.duration) || 5)),
      ratio: RATIOS.has(payload.ratio) ? payload.ratio : '16:9',
      res: typeof payload.res === 'string' ? payload.res : '720p',
    };
    const meta = { projectId: payload.projectId || null, shotId: payload.shotId || null, provider: p.id, prompt, taskId: null };
    return ctx.jobs.start('videogen', async (job) => {
      job.throwIfCancelled();
      let image;
      if (payload.imagePath || payload.imageAssetId) {
        job.progress('排队中', 0.01, '正在准备参考图…');
        image = await resolveImage(payload, job.signal);
        job.throwIfCancelled();
      }
      return execute(job, { p, cfg, input: { ...baseInput, image }, projectId: payload.projectId, meta });
    }, meta);
  });

  handle('videogen:resume', async ({ projectId, tasks } = {}) => {
    if (!Array.isArray(tasks)) return [];
    const out = [];
    for (const t of tasks.slice(0, 50)) {
      if (!t || !t.taskId || !vg.BY_ID[t.provider]) continue;
      const p = vg.getProvider(t.provider);
      const cfg = vg.resolveConfig(settings, p.id);
      if (!vg.isConfigured(p, cfg)) { out.push({ shotId: t.shotId || null, taskId: t.taskId, error: '密钥未配置' }); continue; }
      const meta = { projectId: projectId || null, shotId: t.shotId || null, provider: p.id, prompt: t.prompt || '', taskId: t.taskId };
      const { jobId } = ctx.jobs.start('videogen', (job) => execute(job, { p, cfg, taskId: t.taskId, projectId, meta }), meta);
      out.push({ shotId: meta.shotId, taskId: t.taskId, jobId });
    }
    return out;
  });
};
