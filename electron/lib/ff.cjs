'use strict';
// ffmpeg / ffprobe 工具库。
// 注意：本文件不依赖 electron，只接收 paths 对象（{ ffmpeg, ffprobe, cache, thumbs?, waveforms? }），便于在 node 中测试。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { run } = require('./proc.cjs');
const encoders = require('./encoders.cjs');

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.tif', '.tiff', '.avif', '.heic']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.ts', '.flv', '.wmv']);
const BROWSER_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const BROWSER_VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const BROWSER_AUDIO_EXT = new Set(['.mp3', '.aac', '.m4a', '.wav', '.ogg', '.opus', '.flac']);
const BROWSER_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
const H264_OK_PIX = new Set(['yuv420p', 'yuvj420p', 'nv12']);

const STATS_W = 32;
const STATS_H = 18;
const WAVE_RATE = 8000;
const PROXY_MAX_SIDE = 1280;
// 预览代理的关键帧间隔（帧）：拖动/跳转时最多解码 15 帧就能出画面
const PREVIEW_GOP = 15;
// 胶片条取帧时间的取整粒度（秒）：1 帧@25fps，缩放时间线时缓存能命中
const STRIP_STEP = 0.04;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function hashKey(...parts) {
  const h = crypto.createHash('sha1');
  h.update(parts.map((p) => (p == null ? '' : typeof p === 'object' ? JSON.stringify(p) : String(p))).join('|'));
  return h.digest('hex').slice(0, 16);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function baseName(file) {
  return path.basename(String(file || ''));
}

function round(v, d = 4) {
  const f = 10 ** d;
  return Math.round(Number(v) * f) / f;
}

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function cancelledError() {
  const e = new Error('已取消');
  e.code = 'CANCELLED';
  return e;
}

function lastLines(text, n = 3) {
  const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return lines.slice(-n).join(' / ');
}

function thumbsDir(paths) {
  return ensureDir(paths.thumbs || path.join(paths.cache, 'thumbs'));
}

function wavesDir(paths) {
  return ensureDir(paths.waveforms || path.join(paths.cache, 'waveforms'));
}

function bin(paths, name) {
  const p = paths && paths[name];
  if (!p) throw new Error(name === 'ffprobe' ? '找不到 ffprobe 组件，请重新安装镜流' : '找不到 ffmpeg 组件，请重新安装镜流');
  return p;
}

/** 文件存在性检查 + 返回 stat；不存在时抛中文错误 */
async function statFile(file) {
  if (!file || typeof file !== 'string') throw new Error('未提供文件路径');
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile()) throw new Error(`不是文件：${baseName(file)}`);
    return st;
  } catch (e) {
    if (e && e.code === 'ENOENT') throw new Error(`文件不存在或已被移动：${file}`);
    if (e && (e.code === 'EACCES' || e.code === 'EPERM')) throw new Error(`没有权限读取文件：${file}`);
    throw e;
  }
}

/** 文件签名：路径 + 大小 + 修改时间，用于缓存键 */
async function fileSig(file) {
  const st = await statFile(file);
  const abs = path.resolve(file);
  return `${process.platform === 'win32' ? abs.toLowerCase() : abs}|${st.size}|${Math.round(st.mtimeMs)}`;
}

function isImageFile(file) {
  return IMAGE_EXT.has(path.extname(String(file || '')).toLowerCase());
}

async function exists(p) {
  try { const st = await fs.promises.stat(p); return st.isFile() && st.size > 0; } catch { return false; }
}

async function safeUnlink(p) {
  try { await fs.promises.unlink(p); } catch {}
}

async function renameRetry(from, to, tries = 5) {
  for (let i = 0; ; i++) {
    try { await fs.promises.rename(from, to); return; } catch (e) {
      if (i >= tries - 1 || !(e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES'))) throw e;
      await new Promise((r) => setTimeout(r, 60 * (i + 1)));
    }
  }
}

function tmpSuffix() {
  return crypto.randomBytes(4).toString('hex');
}

/** 并发限制器：短任务（取帧、探测）最多同时 4 个 ffmpeg，避免缩略图请求风暴拖垮机器 */
function createLimiter(max) {
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
const shortLimit = createLimiter(4);
const waveLimit = createLimiter(2);

/** 同一键的并发请求合并为一个 */
const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------
function parseRate(r) {
  if (!r || typeof r !== 'string') return 0;
  const m = /^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/.exec(r.trim());
  if (!m) return 0;
  const num = Number(m[1]);
  const den = m[2] != null ? Number(m[2]) : 1;
  if (!den || !Number.isFinite(num)) return 0;
  return num / den;
}

function streamRotation(s) {
  let rot = 0;
  if (s && s.tags && s.tags.rotate != null) rot = Number(s.tags.rotate) || 0;
  if (s && Array.isArray(s.side_data_list)) {
    for (const sd of s.side_data_list) if (sd && sd.rotation != null) rot = Number(sd.rotation) || rot;
  }
  return rot;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

// 时长兜底：ffprobe 读不出时长（部分录屏、直播切片、没写完的文件）时，
// 用 ffmpeg 把音视频流原样读一遍（不解码，很快），以最后的 time= 作为时长。按文件签名缓存。
const measuredDur = new Map();
async function measureDuration(paths, file, { signal, timeoutMs = 120000 } = {}) {
  const ffmpeg = paths && paths.ffmpeg;
  if (!ffmpeg) return 0;
  let sig;
  try { sig = await fileSig(file); } catch { return 0; }
  if (measuredDur.has(sig)) return measuredDur.get(sig);
  let tail = '';
  let best = 0;
  try {
    await shortLimit(() => run(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-stats', '-i', file,
      '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-f', 'null', '-'], {
      signal,
      timeoutMs,
      onStderr: (t) => {
        tail = (tail + t).slice(-600);
        const s = parseFfTime(tail);
        if (s != null && s > best) best = s;
      },
    }));
  } catch (e) {
    if (e && e.code === 'CANCELLED') throw e;
    // 超时等：用已经读到的时长
  }
  const d = best > 0 ? round(best, 3) : 0;
  if (d > 0) {
    if (measuredDur.size > 500) measuredDur.clear();
    measuredDur.set(sig, d);
  }
  return d;
}

/**
 * 读取媒体信息。
 * @returns {Promise<{duration,width,height,fps,hasVideo,hasAudio,vcodec,acodec,size,kind,pixFmt,hasCover}>}
 */
async function probe(paths, file, opts = {}) {
  const st = await statFile(file);
  const ffprobe = bin(paths, 'ffprobe');
  let r;
  try {
    r = await shortLimit(() => run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { timeoutMs: opts.timeoutMs || 30000, signal: opts.signal }));
  } catch (e) {
    if (e && e.code === 'CANCELLED') throw e;
    throw new Error(`读取媒体信息失败：${baseName(file)}（${e.message}）`);
  }
  let info = null;
  try { info = JSON.parse(r.stdout || '{}'); } catch { info = null; }
  if (r.code !== 0 || !info || !Array.isArray(info.streams)) {
    throw new Error(`无法识别的媒体文件：${baseName(file)}（文件可能已损坏或格式不受支持）`);
  }
  const streams = info.streams;
  const format = info.format || {};
  const covers = streams.filter((s) => s.codec_type === 'video' && s.disposition && Number(s.disposition.attached_pic) === 1);
  const videos = streams.filter((s) => s.codec_type === 'video' && !(s.disposition && Number(s.disposition.attached_pic) === 1));
  const audios = streams.filter((s) => s.codec_type === 'audio');
  const v = videos[0] || null;
  const a = audios[0] || null;
  const image = isImageFile(file) && (v || covers.length);

  const size = Number(format.size) || st.size || 0;
  let duration = num(format.duration);
  if (!(duration > 0)) {
    const ds = streams.map((s) => num(s.duration)).filter((d) => d > 0);
    duration = ds.length ? Math.max(...ds) : 0;
  }
  // ffprobe 读不出时长：用 ffmpeg 实测；仍然没有就标记 durationUnknown（界面按「时长未知」处理，不当作 0 秒）
  let unknown = false;
  if (!(duration > 0) && !image && (v || a) && opts.measure !== false) {
    duration = await measureDuration(paths, file, { signal: opts.signal });
    unknown = !(duration > 0);
  }
  const extra = unknown ? { durationUnknown: true } : {};

  if (image) {
    const s = v || covers[0];
    return {
      duration: 5, width: Number(s.width) || 0, height: Number(s.height) || 0, fps: 30,
      hasVideo: true, hasAudio: false, vcodec: s.codec_name || null, acodec: null, size, kind: 'image',
      pixFmt: s.pix_fmt || null, hasCover: false,
    };
  }
  if (v) {
    let width = Number(v.width) || 0;
    let height = Number(v.height) || 0;
    const rot = Math.abs(streamRotation(v)) % 180;
    if (rot === 90) [width, height] = [height, width];
    let fps = parseRate(v.r_frame_rate);
    if (!(fps > 0 && fps <= 240)) fps = parseRate(v.avg_frame_rate);
    if (!(fps > 0 && fps <= 240)) fps = 30;
    return {
      duration: round(duration, 3), width, height, fps: round(fps, 3),
      hasVideo: true, hasAudio: !!a, vcodec: v.codec_name || null, acodec: a ? a.codec_name || null : null, size, kind: 'video',
      pixFmt: v.pix_fmt || null, hasCover: false, ...extra,
    };
  }
  if (a) {
    return {
      duration: round(duration, 3), width: 0, height: 0, fps: 0,
      hasVideo: false, hasAudio: true, vcodec: null, acodec: a.codec_name || null, size, kind: 'audio',
      pixFmt: null, hasCover: covers.length > 0, ...extra,
    };
  }
  throw new Error(`文件中没有可用的画面或声音：${baseName(file)}`);
}

/**
 * 解析 ffprobe 的包列表（每行 "pts_time,flags"），返回关键帧最大间隔（秒），含开头和窗口末尾的空档（纯函数）。
 * 没有可用的包返回 null。
 */
function maxKeyGap(text) {
  const keys = [];
  let minT = Infinity;
  let maxT = -Infinity;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*([A-Z_]+)/.exec(line);
    if (!m) continue;
    const t = Number(m[1]);
    if (t < minT) minT = t;
    if (t > maxT) maxT = t;
    if (m[2][0] === 'K') keys.push(t);
  }
  if (!Number.isFinite(minT)) return null;
  if (!keys.length) return round(maxT - minT, 3) || null; // 整段都没有关键帧：极稀疏
  keys.sort((x, y) => x - y);
  let gap = keys[0] - minT;
  for (let i = 1; i < keys.length; i++) gap = Math.max(gap, keys[i] - keys[i - 1]);
  gap = Math.max(gap, maxT - keys[keys.length - 1]);
  return round(gap, 3);
}

/**
 * 开头一段（默认 8 秒）内关键帧的最大间隔（秒）。只读包头、不解码，很快。读不出来返回 null。
 * 用途：判断“能直接播但拖动会卡”的素材——关键帧稀疏（录屏、网上下载的视频常见 4~10 秒一个）时，
 * 每次拖动都要从很远的关键帧解码过来，这类素材后台生成预览代理（每 15 帧一个关键帧）。
 */
async function keyframeInterval(paths, file, { seconds = 8, signal } = {}) {
  const ffprobe = bin(paths, 'ffprobe');
  const win = Math.max(1, Math.min(60, Number(seconds) || 8));
  let r;
  try {
    r = await shortLimit(() => run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', `%+${win}`,
      '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file], { timeoutMs: 20000, signal }));
  } catch (e) {
    if (e && e.code === 'CANCELLED') throw e;
    return null;
  }
  if (!r || r.code !== 0) return null;
  return maxKeyGap(r.stdout);
}

// ---------------------------------------------------------------------------
// 取帧
// ---------------------------------------------------------------------------
function frameArgs(file, time, { width, height, image }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (!image && time > 0) args.push('-ss', String(round(time, 3)));
  args.push('-i', file, '-frames:v', '1', '-an', '-sn', '-dn');
  let vf;
  if (height && !width) vf = `scale=-2:${Math.round(height)}:flags=bicubic`;
  else if (width && height) vf = `scale=${Math.round(width)}:${Math.round(height)}:flags=bicubic`;
  else vf = `scale=${Math.round(width || 320)}:-2:flags=bicubic`;
  args.push('-vf', vf);
  return args;
}

async function grabFrame(paths, file, time, outPath, { width, height, signal } = {}) {
  await statFile(file);
  const ffmpeg = bin(paths, 'ffmpeg');
  const image = isImageFile(file);
  ensureDir(path.dirname(outPath));
  const tmp = `${outPath}.${tmpSuffix()}.tmp.jpg`;
  const attempt = async (t) => {
    const args = [...frameArgs(file, t, { width, height, image }), '-q:v', '3', '-update', '1', '-y', tmp];
    let r;
    try {
      r = await shortLimit(() => run(ffmpeg, args, { timeoutMs: 60000, signal }));
    } catch (e) {
      await safeUnlink(tmp);
      if (e && e.code === 'CANCELLED') throw e;
      throw new Error(`截取画面失败：${baseName(file)}（${e.message}）`);
    }
    if (r.code === 0 && await exists(tmp)) return true;
    await safeUnlink(tmp);
    return r.stderr;
  };
  const t0 = Math.max(0, Number(time) || 0);
  // 时间点超出片尾时 ffmpeg 不输出画面：依次退回 1 秒前、片头再试
  let res = await attempt(t0);
  if (res !== true && t0 > 0) res = await attempt(Math.max(0, t0 - 1));
  if (res !== true && t0 > 1) res = await attempt(0);
  if (res !== true) throw new Error(`截取画面失败：${baseName(file)}${res ? `（${lastLines(res, 1)}）` : ''}`);
  try {
    await renameRetry(tmp, outPath);
  } catch (e) {
    await safeUnlink(tmp);
    if (!(await exists(outPath))) throw new Error(`保存画面失败：${e.message}`);
  }
  return outPath;
}

/** 单帧 jpg（不缓存） */
async function extractFrame(paths, file, time, outPath, { width = 320, height, signal } = {}) {
  if (!outPath) throw new Error('未指定输出路径');
  return grabFrame(paths, file, time, outPath, { width, height, signal });
}

/** 带缓存的缩略图：<cache>/thumbs/<hash>.jpg */
async function thumb(paths, file, time = 0, width = 320) {
  const sig = await fileSig(file);
  const t = isImageFile(file) ? 0 : Math.max(0, Number(time) || 0);
  const w = Math.round(clamp(width || 320, 16, 1920));
  const key = hashKey('thumb', sig, t.toFixed(2), w);
  const out = path.join(thumbsDir(paths), `${key}.jpg`);
  if (await exists(out)) return out;
  return once(out, async () => {
    if (await exists(out)) return out;
    return grabFrame(paths, file, t, out, { width: w });
  });
}

/** 取帧时间取整到 0.04 秒（缓存键用） */
function snapTime(t) {
  const v = Math.max(0, Number(t) || 0);
  return Number((Math.round(v / STRIP_STEP) * STRIP_STEP).toFixed(2));
}

/** 带缓存的定高帧（胶片条用）：<cache>/thumbs/<hash>.jpg，按（文件签名, 时间取整到 0.04 秒, 高度）缓存 */
async function frameAtHeight(paths, file, time, height, { signal, sig } = {}) {
  const s = sig || await fileSig(file);
  const t = isImageFile(file) ? 0 : snapTime(time);
  const h = Math.round(clamp(height || 60, 16, 1080));
  const key = hashKey('strip', s, t.toFixed(2), h);
  const out = path.join(thumbsDir(paths), `${key}.jpg`);
  if (await exists(out)) return out;
  return once(out, async () => {
    if (await exists(out)) return out;
    return grabFrame(paths, file, t, out, { height: h, signal });
  });
}

/**
 * 胶片条取帧时间（纯函数）：在 [start, end]（缺省为整段）内均分 count 段，取每段中点，取整到 0.04 秒。
 * 区间无效（定格片段 in === out）时每张都取起点那一帧。
 */
function filmstripTimes(duration, count = 10, start, end) {
  const n = Math.round(clamp(Number(count) || 10, 1, 60));
  const dur = Math.max(0, Number(duration) || 0);
  const s = Number(start);
  const e = Number(end);
  let a = start != null && Number.isFinite(s) ? Math.max(0, s) : 0;
  let b = end != null && Number.isFinite(e) && e > 0 ? e : dur;
  if (dur > 0) { a = Math.min(a, dur); b = Math.min(b, dur); }
  if (!(b > a)) return Array.from({ length: n }, () => snapTime(a));
  const step = (b - a) / n;
  return Array.from({ length: n }, (_, i) => snapTime(a + (i + 0.5) * step));
}

/**
 * 胶片条：返回 count 张定高图片路径。
 * 每帧都有磁盘缓存，重复请求只做一次文件签名 + 若干次存在性检查；个别帧失败时用相邻成功的帧补位。
 * @param {{duration?:number, count?:number, height?:number, start?:number, end?:number, signal?:AbortSignal}} opts
 */
async function filmstrip(paths, file, { duration, count = 10, height = 60, start, end, signal } = {}) {
  const n = Math.round(clamp(Number(count) || 10, 1, 60));
  const h = Math.round(clamp(Number(height) || 60, 16, 360));
  let dur = Number(duration);
  const ext = path.extname(String(file || '')).toLowerCase();
  let kind = isImageFile(file) ? 'image' : (dur > 0 && VIDEO_EXT.has(ext) ? 'video' : null);
  if (!(dur > 0) || !kind) {
    const info = await probe(paths, file, { signal });
    kind = info.kind;
    if (!(dur > 0)) dur = info.duration || 0;
  }
  if (kind === 'audio') return [];
  const sig = await fileSig(file);
  if (kind === 'image') {
    const one = await frameAtHeight(paths, file, 0, h, { signal, sig });
    return Array(n).fill(one);
  }
  const times = filmstripTimes(dur, n, start, end);
  // 同一时间点只取一次（区间很短时多张会落在同一帧上）
  const uniq = [...new Set(times)];
  const got = new Map();
  await Promise.all(uniq.map(async (t) => {
    try { got.set(t, await frameAtHeight(paths, file, t, h, { signal, sig })); } catch (e) {
      if (e && e.code === 'CANCELLED') throw e;
      got.set(t, null);
    }
  }));
  const results = times.map((t) => got.get(t) || null);
  if (results.every((r) => !r)) throw new Error(`无法生成胶片条：${baseName(file)}`);
  let last = results.find(Boolean);
  return results.map((r) => { if (r) last = r; return r || last; });
}

// ---------------------------------------------------------------------------
// 色彩统计
// ---------------------------------------------------------------------------
function toHex(r, g, b) {
  const h = (v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** 5 主色：量化直方图选初始中心（彼此拉开距离）+ k-means 精修，按占比降序 */
function paletteFromPixels(px, k = 5) {
  const n = px.length / 3;
  if (!n) return Array(k).fill('#000000');
  const bins = new Map();
  for (let i = 0; i < n; i++) {
    const r = px[i * 3]; const g = px[i * 3 + 1]; const b = px[i * 3 + 2];
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    let e = bins.get(key);
    if (!e) { e = { c: 0, r: 0, g: 0, b: 0 }; bins.set(key, e); }
    e.c += 1; e.r += r; e.g += g; e.b += b;
  }
  const sorted = [...bins.values()].map((e) => ({ c: e.c, r: e.r / e.c, g: e.g / e.c, b: e.b / e.c })).sort((x, y) => y.c - x.c);
  const dist2 = (a, b) => (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2;
  const centers = [];
  for (const s of sorted) {
    if (centers.length >= k) break;
    if (centers.every((c) => dist2(c, s) > 48 * 48)) centers.push({ r: s.r, g: s.g, b: s.b });
  }
  for (const s of sorted) {
    if (centers.length >= k) break;
    if (!centers.some((c) => dist2(c, s) < 1)) centers.push({ r: s.r, g: s.g, b: s.b });
  }
  // k-means
  const assign = new Int32Array(n);
  let counts = new Array(centers.length).fill(0);
  for (let iter = 0; iter < 8; iter++) {
    const acc = centers.map(() => ({ c: 0, r: 0, g: 0, b: 0 }));
    for (let i = 0; i < n; i++) {
      const p = { r: px[i * 3], g: px[i * 3 + 1], b: px[i * 3 + 2] };
      let best = 0; let bd = Infinity;
      for (let j = 0; j < centers.length; j++) {
        const d = dist2(p, centers[j]);
        if (d < bd) { bd = d; best = j; }
      }
      assign[i] = best;
      const a = acc[best]; a.c += 1; a.r += p.r; a.g += p.g; a.b += p.b;
    }
    let moved = false;
    for (let j = 0; j < centers.length; j++) {
      if (!acc[j].c) continue;
      const nr = acc[j].r / acc[j].c; const ng = acc[j].g / acc[j].c; const nb = acc[j].b / acc[j].c;
      if (Math.abs(nr - centers[j].r) + Math.abs(ng - centers[j].g) + Math.abs(nb - centers[j].b) > 0.5) moved = true;
      centers[j] = { r: nr, g: ng, b: nb };
    }
    counts = acc.map((a) => a.c);
    if (!moved) break;
  }
  const order = centers.map((c, j) => ({ c, n: counts[j] || 0 })).sort((x, y) => y.n - x.n);
  const hex = order.map((o) => toHex(o.c.r, o.c.g, o.c.b));
  while (hex.length < k) hex.push(hex[hex.length - 1] || '#000000');
  return hex.slice(0, k);
}

/** 由 rgb24 像素缓冲计算 ColorStats */
function statsFromRgb(buf) {
  const n = Math.floor(buf.length / 3);
  if (!n) throw new Error('没有可统计的像素');
  let sumL = 0; let sumL2 = 0; let sumS = 0; let sumW = 0; let sumT = 0;
  for (let i = 0; i < n; i++) {
    const r = buf[i * 3] / 255; const g = buf[i * 3 + 1] / 255; const b = buf[i * 3 + 2] / 255;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const mx = Math.max(r, g, b); const mn = Math.min(r, g, b);
    sumL += l; sumL2 += l * l;
    sumS += mx > 0.02 ? (mx - mn) / mx : 0;
    sumW += r - b;
    sumT += g - (r + b) / 2;
  }
  const luma = sumL / n;
  const variance = Math.max(0, sumL2 / n - luma * luma);
  return {
    luma: round(clamp(luma, 0, 1)),
    contrast: round(clamp(Math.sqrt(variance) * 2, 0, 1)),
    saturation: round(clamp(sumS / n, 0, 1)),
    warmth: round(clamp(sumW / n, -1, 1)),
    tint: round(clamp(sumT / n, -1, 1)),
    palette: paletteFromPixels(buf.subarray(0, n * 3)),
  };
}

async function rawFrame(paths, file, time, { image, signal } = {}) {
  const ffmpeg = bin(paths, 'ffmpeg');
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (!image && time > 0) args.push('-ss', String(round(time, 3)));
  args.push('-i', file, '-frames:v', '1', '-an', '-sn', '-dn', '-vf', `scale=${STATS_W}:${STATS_H}:flags=area`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1');
  const r = await shortLimit(() => run(ffmpeg, args, { encoding: 'buffer', timeoutMs: 60000, signal }));
  const need = STATS_W * STATS_H * 3;
  if (r.code !== 0 || !r.stdout || r.stdout.length < need) return { buf: null, err: r.stderr };
  return { buf: r.stdout.subarray(0, need), err: '' };
}

async function colorStatsFromImage(paths, imagePath, { signal } = {}) {
  await statFile(imagePath);
  const { buf, err } = await rawFrame(paths, imagePath, 0, { image: true, signal });
  if (!buf) throw new Error(`色彩分析失败：${baseName(imagePath)}${err ? `（${lastLines(err, 1)}）` : ''}`);
  return statsFromRgb(buf);
}

/**
 * 在多个时间点取色彩统计。单个时间点失败时该项为 null（不伪造数据）；全部失败才抛错。
 * @returns {Promise<(ColorStats|null)[]>}
 */
async function colorStats(paths, file, times, { signal } = {}) {
  const info = await probe(paths, file, { signal });
  if (!info.hasVideo) throw new Error(`音频文件没有画面，无法做色彩分析：${baseName(file)}`);
  const image = info.kind === 'image';
  const list = Array.isArray(times) && times.length ? times : [info.duration > 0 ? info.duration / 2 : 0];
  const maxT = image ? 0 : Math.max(0, (info.duration || 0) - 0.1);
  const out = new Array(list.length).fill(null);
  let lastErr = '';
  await Promise.all(list.map(async (t, i) => {
    const tt = image ? 0 : clamp(Number(t) || 0, 0, maxT || 0);
    let { buf, err } = await rawFrame(paths, file, tt, { image, signal });
    if (!buf && tt > 0) ({ buf, err } = await rawFrame(paths, file, Math.max(0, tt - 1), { image, signal }));
    if (!buf) { lastErr = err || lastErr; return; }
    out[i] = statsFromRgb(buf);
  }));
  if (out.every((s) => !s)) throw new Error(`色彩分析失败：${baseName(file)}${lastErr ? `（${lastLines(lastErr, 1)}）` : ''}`);
  return out;
}

// ---------------------------------------------------------------------------
// 波形
// ---------------------------------------------------------------------------
async function waveform(paths, file, peaksPerSecond = 50, { signal } = {}) {
  const pps = Math.round(clamp(peaksPerSecond || 50, 1, 200));
  const sig = await fileSig(file);
  const key = hashKey('wave', sig, pps, 1);
  const cacheFile = path.join(wavesDir(paths), `${key}.json`);
  try {
    const cached = JSON.parse(await fs.promises.readFile(cacheFile, 'utf8'));
    if (cached && Array.isArray(cached.peaks) && Number.isFinite(cached.duration)) return cached;
  } catch {}
  return once(cacheFile, async () => {
    const info = await probe(paths, file, { signal });
    if (!info.hasAudio) return { peaks: [], duration: info.duration || 0, peaksPerSecond: pps, maxPeak: 0 };
    const ffmpeg = bin(paths, 'ffmpeg');
    const win = Math.max(1, Math.round(WAVE_RATE / pps));
    const raw = [];
    let cur = 0; let inWin = 0; let total = 0; let leftover = null;
    const onStdout = (chunk) => {
      let c = chunk;
      if (leftover) { c = Buffer.concat([leftover, c]); leftover = null; }
      const even = c.length - (c.length % 2);
      if (even < c.length) leftover = c.subarray(even);
      for (let o = 0; o < even; o += 2) {
        const s = Math.abs(c.readInt16LE(o));
        if (s > cur) cur = s;
        inWin += 1;
        if (inWin >= win) { raw.push(cur); cur = 0; inWin = 0; }
      }
      total += even / 2;
    };
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(WAVE_RATE), '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'];
    const r = await waveLimit(() => run(ffmpeg, args, { onStdout, timeoutMs: 15 * 60 * 1000, signal }));
    if (inWin > 0) raw.push(cur);
    if (r.code !== 0 && !total) throw new Error(`读取声音波形失败：${baseName(file)}${r.stderr ? `（${lastLines(r.stderr, 1)}）` : ''}`);
    const maxRaw = raw.reduce((m, v) => (v > m ? v : m), 0);
    const peaks = maxRaw > 0 ? raw.map((v) => round(v / maxRaw, 3)) : raw.map(() => 0);
    const result = {
      peaks,
      duration: round(total > 0 ? total / WAVE_RATE : info.duration || 0, 3),
      peaksPerSecond: pps,
      maxPeak: round(maxRaw / 32768, 4), // 归一化前的绝对峰值（0..1），便于需要绝对响度的调用方还原
    };
    try {
      const tmp = `${cacheFile}.${tmpSuffix()}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(result));
      await renameRetry(tmp, cacheFile).catch(() => safeUnlink(tmp));
    } catch {}
    return result;
  });
}

// ---------------------------------------------------------------------------
// 代理
// ---------------------------------------------------------------------------
function needsProxy(probeResult, file) {
  const p = probeResult || {};
  const ext = path.extname(String(file || '')).toLowerCase();
  if (p.kind === 'image') return false;
  const audioOk = (codec) => {
    if (!codec) return true;
    const c = String(codec).toLowerCase();
    return BROWSER_AUDIO_CODECS.has(c) || c.startsWith('pcm_');
  };
  if (p.kind === 'audio' || (!p.hasVideo && p.hasAudio)) {
    if (!BROWSER_AUDIO_EXT.has(ext)) return true;
    return !audioOk(p.acodec);
  }
  const vcodec = String(p.vcodec || '').toLowerCase();
  if (!BROWSER_VIDEO_CODECS.has(vcodec)) return true;
  if (!BROWSER_VIDEO_EXT.has(ext)) return true;
  // H.264 10bit / 4:2:2 / 4:4:4 浏览器无法解码
  if (vcodec === 'h264' && p.pixFmt && !H264_OK_PIX.has(String(p.pixFmt).toLowerCase())) return true;
  // 视频里的声音是浏览器不支持的编码（如 AC-3、DTS）也需要转
  if (p.hasAudio && !audioOk(p.acodec)) return true;
  return false;
}

function parseFfTime(text) {
  const re = /time=\s*(-?\d+):(\d+):(\d+(?:\.\d+)?)/g;
  let m; let last = null;
  while ((m = re.exec(text))) last = m;
  if (!last) return null;
  return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
}

/**
 * 兼容 / 预览代理：H.264 + AAC 的 mp4（音频文件则为仅 AAC 的 mp4/m4a），+faststart。
 * - 画面最长边 maxSide（默认 1280）；关键帧间隔固定 15 帧、不用 B 帧，拖动预览时跳转更快。
 * - 编码器按 encoders.cjs 的优先级选（显卡优先，没有就用 CPU）；某个编码器中途失败自动换下一个。
 * @param {{signal?:AbortSignal, onProgress?:(p:number)=>void, maxSide?:number, quality?:'high'|'standard'|'small'|'proxy',
 *          preferHw?:boolean, gop?:number, purpose?:'preview'|'proxy'|'export'|'videogen'}} [opts]
 */
async function makeProxy(paths, file, outPath, { signal, onProgress, maxSide = PROXY_MAX_SIDE, quality = 'proxy', preferHw = true, gop = PREVIEW_GOP, purpose = 'preview' } = {}) {
  if (!outPath) throw new Error('未指定代理输出路径');
  if (signal && signal.aborted) throw cancelledError();
  const info = await probe(paths, file, { signal });
  if (info.kind === 'image') throw new Error('图片不需要生成代理');
  const ffmpeg = bin(paths, 'ffmpeg');
  ensureDir(path.dirname(outPath));
  const L = Math.round(clamp(Number(maxSide) || PROXY_MAX_SIDE, 160, 4096) / 2) * 2;
  /** 拼 ffmpeg 参数；enc 为视频编码器（encoders.pickH264 的结果），音频文件为 null */
  const buildArgs = (enc, tmp) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-stats', '-nostdin', '-y', '-i', file];
    if (!enc) {
      args.push('-map', '0:a:0', '-vn', '-sn', '-dn', '-c:a', 'aac', '-b:a', '160k', '-ac', '2');
    } else {
      const vf = [
        'scale=trunc(iw*sar/2)*2:trunc(ih/2)*2',
        'setsar=1',
        `scale=w='if(gte(iw,ih),min(${L},trunc(iw/2)*2),-2)':h='if(gte(iw,ih),-2,min(${L},trunc(ih/2)*2))':flags=bicubic`,
        `format=${encoders.pixFmtOf(enc.args)}`,
      ].join(',');
      args.push('-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-vf', vf, ...enc.args,
        '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-max_muxing_queue_size', '1024');
    }
    args.push('-movflags', '+faststart', '-f', 'mp4', tmp);
    return args;
  };

  const dur = info.duration > 0 ? info.duration : 0;
  let tail = '';
  let lastP = -1;
  const report = (p) => {
    if (!onProgress) return;
    const v = clamp(p, 0, 1);
    if (v - lastP < 0.005 && v < 1) return;
    lastP = v;
    try { onProgress(v); } catch {}
  };
  report(0);
  /** 用某个视频编码器（音频文件为 null）跑一遍；失败抛错，由 encoders.withH264 决定是否换编码器 */
  const encodeWith = async (enc) => {
    const tmp = `${outPath}.${tmpSuffix()}.part`;
    tail = '';
    let r;
    try {
      r = await run(ffmpeg, buildArgs(enc, tmp), {
        signal,
        onStderr: (t) => {
          tail = (tail + t).slice(-400);
          if (!dur) return;
          const sec = parseFfTime(tail);
          if (sec != null && sec >= 0) report(Math.min(0.99, sec / dur));
        },
      });
    } catch (e) {
      await safeUnlink(tmp);
      if (e && e.code === 'CANCELLED') throw e;
      throw new Error(`生成兼容代理失败：${baseName(file)}（${e.message}）`);
    }
    if (r.code !== 0 || !(await exists(tmp))) {
      await safeUnlink(tmp);
      if (signal && signal.aborted) throw cancelledError();
      const errText = String(r.stderr || '').split(/\r?\n/).filter((l) => l && !/^\s*(frame|size)=/.test(l) && !/time=/.test(l));
      throw new Error(`生成兼容代理失败：${baseName(file)}${errText.length ? `（${errText.slice(-1)[0].trim()}）` : ''}`);
    }
    try {
      await safeUnlink(outPath);
      await renameRetry(tmp, outPath);
    } catch (e) {
      await safeUnlink(tmp);
      const err = new Error(`保存代理文件失败：${e.message}`);
      err.noRetry = true; // 与编码器无关，换编码器也没用
      throw err;
    }
  };
  if (info.kind === 'audio') {
    await encodeWith(null);
  } else {
    const k = Math.min(1, L / Math.max(Number(info.width) || 0, Number(info.height) || 0, 1));
    await encoders.withH264({
      ffmpegPath: ffmpeg, purpose, quality, preferHw, gop, fps: info.fps,
      width: Math.round((Number(info.width) || 1280) * k), height: Math.round((Number(info.height) || 720) * k),
    }, encodeWith);
  }
  report(1);
  return outPath;
}

// ---------------------------------------------------------------------------
// 硬件编码探测（旧接口）：内部改用 encoders.cjs（1 帧试编码 + 磁盘缓存）。
// export.cjs 仍在用 pickVideoEncoder，它只认 nvenc/qsv/amf/libx264 四个名字，所以这里只返回这四个；
// 新代码请直接用 encoders.pickH264（含 h264_mf / libopenh264 兜底和完整编码参数）。
// ---------------------------------------------------------------------------
const HW_ENCODERS = ['h264_nvenc', 'h264_qsv', 'h264_amf'];

/** 解析 fmpeg -encoders 输出，返回其中出现的硬件 H.264 编码器（纯函数） */
function parseHwEncoders(text) {
  const found = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*V\S*\s+(\S+)/.exec(line);
    if (m && HW_ENCODERS.includes(m[1])) found.add(m[1]);
  }
  return HW_ENCODERS.filter((e) => found.has(e));
}

/** 实测参数：编码 1 帧纯色画面到空输出（与 encoders.cjs 的试编码相同） */
function hwTestArgs(encoder) {
  return encoders.trialArgs(encoder);
}

/**
 * 探测可用硬件编码器（encoders.cjs 内存 + 磁盘缓存）。返回按优先级排序的可用列表，例如 ['h264_nvenc']；全部不可用时返回 []。
 * @param {{ffmpeg:string}} paths
 */
async function detectHwEncoders(paths, { force = false } = {}) {
  const ffmpeg = paths && paths.ffmpeg;
  if (!ffmpeg) return [];
  try {
    const r = await encoders.probeEncoders(ffmpeg, { force });
    return HW_ENCODERS.filter((e) => (r.h264 || []).includes(e));
  } catch {
    return [];
  }
}

/** 选编码器：hwaccel='off' 或无可用硬件时回退 libx264（本次运行中实际失败过的显卡编码器会被跳过） */
async function pickVideoEncoder(paths, hwaccel = 'auto') {
  if (hwaccel === 'off') return 'libx264';
  const ffmpeg = paths && paths.ffmpeg;
  if (!ffmpeg) return 'libx264';
  try {
    const enc = await encoders.pickH264({ ffmpegPath: ffmpeg, preferHw: true });
    return HW_ENCODERS.includes(enc.encoder) ? enc.encoder : 'libx264';
  } catch {
    return 'libx264';
  }
}

module.exports = {
  detectHwEncoders,
  pickVideoEncoder,
  parseHwEncoders,
  hwTestArgs,
  HW_ENCODERS,
  PREVIEW_GOP,
  probe,
  measureDuration,
  keyframeInterval,
  maxKeyGap,
  extractFrame,
  thumb,
  frameAtHeight,
  filmstrip,
  filmstripTimes,
  colorStatsFromImage,
  colorStats,
  statsFromRgb,
  waveform,
  needsProxy,
  makeProxy,
  hashKey,
  fileSig,
  isImageFile,
  parseRate,
};
