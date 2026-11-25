'use strict';
// 拆片流水线：镜头切分、关键帧、亮度/运动/响度曲线、色彩、节奏、节拍、字幕、联系表。
// 纯 node 模块（不 require electron），paths 只需要 { ffmpeg, ffprobe }。
// 镜头切分 / 关键帧 / 主色由 shotdetect.cjs 完成（一遍解码，worker_threads 里计算，不卡主进程）。
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./proc.cjs');
const { parseVtt } = require('./ytdlp.cjs');
const shotdetect = require('./shotdetect.cjs');

const SAMPLE_FPS = 2;            // 亮度/运动曲线采样帧率
const GW = 64;                   // 曲线采样帧宽
const GH = 36;                   // 曲线采样帧高
const AUDIO_RATE = 11025;        // 响度与节拍共用一次音频解码
const FINE_WIN = 0.1;            // 响度细粒度窗口（秒）
const CURVE_WIN = 0.5;           // 响度曲线窗口（秒）
const KF_WIDTH = 320;
const SHEET_PER = 12;            // 每张联系表 12 格（横屏 4×3、竖屏 6×2、方形 4×3）
const SHEET_MAX = 4;
const CONCURRENCY = 4;
const SEEK_COST_MS = 250;        // 逐帧定位抽一张关键帧的大致耗时（用于在「再解码一遍」与「逐帧定位」间选快的）

// ───────────────────────── 依赖：A 组 ff.cjs（可选，失败回退私有实现） ─────────────────────────

let ffOverride;
function loadFf() {
  if (ffOverride !== undefined) return ffOverride;
  try { return require('./ff.cjs'); } catch { return null; }
}

// ───────────────────────── 小工具 ─────────────────────────

function cancelledError() { const e = new Error('已取消'); e.code = 'CANCELLED'; return e; }
function throwIfAborted(signal) { if (signal && signal.aborted) throw cancelledError(); }
function isCancelled(err, signal) { return !!((err && err.code === 'CANCELLED') || (signal && signal.aborted)); }
function clamp01(v) { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0; }
function clamp(v, lo, hi) { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo; }
function r3(v) { return Math.round(Number(v) * 1000) / 1000; }
function pad3(n) { return String(n).padStart(3, '0'); }
function lastLine(stderr) {
  const lines = String(stderr || '').split(/\r?\n|\r/).map((l) => l.trim()).filter((l) => l && !/^frame=|^size=|^video:|^\s*$/.test(l));
  return (lines[lines.length - 1] || '').slice(0, 200);
}
function fileOk(p) { try { return fs.statSync(p).size > 0; } catch { return false; } }
function parseRate(s) {
  if (!s) return 0;
  const [a, b] = String(s).split('/').map(Number);
  const v = b ? a / b : a;
  return Number.isFinite(v) && v > 0 && v < 1000 ? v : 0;
}
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function pool(items, limit, worker, signal) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      throwIfAborted(signal);
      const i = next++;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

// ───────────────────────── 探测 ─────────────────────────

async function probeVideo(paths, file, signal) {
  if (paths.ffprobe && fs.existsSync(paths.ffprobe)) {
    let r;
    try {
      r = await run(paths.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { signal, timeoutMs: 60000 });
    } catch (e) {
      if (isCancelled(e, signal)) throw cancelledError();
      throw new Error('无法读取视频信息：' + e.message);
    }
    let j = null;
    try { j = JSON.parse(String(r.stdout || '')); } catch {}
    if (!j || r.code !== 0) throw new Error('无法读取视频信息，文件可能已损坏或格式不受支持' + (lastLine(r.stderr) ? `（${lastLine(r.stderr)}）` : ''));
    const streams = Array.isArray(j.streams) ? j.streams : [];
    const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
    const a = streams.find((s) => s.codec_type === 'audio');
    const fmt = j.format || {};
    let duration = Number(fmt.duration);
    if (!(duration > 0) && v) duration = Number(v.duration);
    let width = v ? Number(v.width) || 0 : 0;
    let height = v ? Number(v.height) || 0 : 0;
    let rot = 0;
    if (v) {
      rot = Number(v.tags && v.tags.rotate) || 0;
      const sd = Array.isArray(v.side_data_list) ? v.side_data_list.find((d) => d && d.rotation != null) : null;
      if (sd) rot = Number(sd.rotation) || rot;
    }
    if (Math.abs(rot) % 180 === 90) [width, height] = [height, width];
    const startTime = Number(v && v.start_time) || Number(fmt.start_time) || 0;
    return {
      duration: duration > 0 ? duration : 0,
      width,
      height,
      fps: v ? (parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) || 0) : 0,
      hasVideo: !!v,
      hasAudio: !!a,
      startTime: Number.isFinite(startTime) ? startTime : 0,
    };
  }
  // 没有 ffprobe：解析 ffmpeg -i 的输出
  let r;
  try {
    r = await run(paths.ffmpeg, ['-hide_banner', '-nostdin', '-i', file], { signal, timeoutMs: 60000 });
  } catch (e) {
    if (isCancelled(e, signal)) throw cancelledError();
    throw new Error('无法读取视频信息：' + e.message);
  }
  const s = r.stderr || '';
  const dm = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(s);
  const vm = /Stream #\d+:\d+.*?: Video: .*?(\d{2,5})x(\d{2,5})/.exec(s);
  const fm = /(\d+(?:\.\d+)?) fps/.exec(s);
  const sm = /start:\s*(-?[\d.]+)/.exec(s);
  return {
    duration: dm ? Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3]) : 0,
    width: vm ? Number(vm[1]) : 0,
    height: vm ? Number(vm[2]) : 0,
    fps: fm ? Number(fm[1]) : 0,
    hasVideo: !!vm,
    hasAudio: /Stream #\d+:\d+.*?: Audio:/.test(s),
    startTime: sm ? Number(sm[1]) || 0 : 0,
  };
}

// ───────────────────────── 1+2) 一遍解码：切点、关键帧候选、主色、亮度/帧差曲线（见 shotdetect.cjs） ─────────────────────────

/** 从 64×36 灰度帧缓冲计算每帧平均亮度与相邻帧差（0..1）。shotdetect 的 2fps 曲线与此同口径。 */
function computeCurves(buf, frameSize = GW * GH) {
  const n = Math.floor(buf.length / frameSize);
  const luma = new Array(n);
  const diff = new Array(n);
  for (let f = 0; f < n; f++) {
    const off = f * frameSize;
    let sum = 0;
    let d = 0;
    for (let i = 0; i < frameSize; i++) {
      const v = buf[off + i];
      sum += v;
      if (f > 0) d += Math.abs(v - buf[off - frameSize + i]);
    }
    luma[f] = sum / frameSize / 255;
    diff[f] = f > 0 ? d / frameSize / 255 : 0;
  }
  return { luma, diff };
}

/** 由切点生成镜头边界（纯函数，实现在 shotdetect.cjs，worker 里也要用） */
const { buildShotBounds } = shotdetect;

/** 镜头内运动强度（0..1）：帧差均值经软饱和映射 */
function shotMotion(diff, start, end, fps = SAMPLE_FPS) {
  const vals = [];
  for (let i = 1; i < diff.length; i++) {
    const tPrev = (i - 1) / fps;
    const t = i / fps;
    if (tPrev >= start - 1e-6 && t < end - 1e-6) vals.push(diff[i]);
  }
  if (!vals.length) {
    // 极短镜头：取最近的一帧（排除跨切点的那一帧）
    const i = Math.min(diff.length - 1, Math.max(1, Math.round(((start + end) / 2) * fps)));
    if (diff.length > 1 && i >= 1) vals.push(diff[i] * 0.5);
  }
  if (!vals.length) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return r3(1 - Math.exp(-mean / 0.04));
}

function shotLuma(luma, start, end, fps = SAMPLE_FPS) {
  const vals = [];
  for (let i = 0; i < luma.length; i++) { const t = i / fps; if (t >= start - 1e-6 && t < end) vals.push(luma[i]); }
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// ───────────────────────── 5) 音频 ─────────────────────────

function dbNorm(rms) {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return clamp01((db + 60) / 60);
}

/** s16le 单声道样本 → 细粒度能量窗口 */
function audioWindows(buf, rate = AUDIO_RATE, win = FINE_WIN) {
  const samples = Math.floor(buf.length / 2);
  const per = Math.max(1, Math.round(rate * win));
  const n = Math.ceil(samples / per);
  const sumsq = new Float64Array(n);
  const counts = new Uint32Array(n);
  for (let i = 0; i < samples; i++) {
    const v = buf.readInt16LE(i * 2) / 32768;
    const w = (i / per) | 0;
    sumsq[w] += v * v;
    counts[w] += 1;
  }
  return { sumsq, counts, win };
}

function rangeRms(aw, start, end) {
  if (!aw || !aw.sumsq.length) return 0;
  const a = Math.max(0, Math.floor(start / aw.win));
  const b = Math.min(aw.sumsq.length, Math.max(a + 1, Math.ceil(end / aw.win)));
  let s = 0;
  let c = 0;
  for (let i = a; i < b; i++) { s += aw.sumsq[i]; c += aw.counts[i]; }
  return c ? Math.sqrt(s / c) : 0;
}

/** 0.5 秒响度曲线（0..1）与峰值时间点（秒） */
function loudnessCurve(aw, duration, step = CURVE_WIN) {
  if (!aw || !aw.sumsq.length) return { curve: [], peaks: [] };
  const n = Math.max(1, Math.ceil(duration / step - 1e-6));
  const curve = [];
  for (let i = 0; i < n; i++) curve.push(r3(dbNorm(rangeRms(aw, i * step, Math.min(duration, (i + 1) * step)))));
  return { curve, peaks: findPeaks(curve, step) };
}

function findPeaks(curve, step = CURVE_WIN, maxPeaks = 40) {
  if (curve.length < 3) return [];
  const mean = curve.reduce((a, b) => a + b, 0) / curve.length;
  const sd = Math.sqrt(curve.reduce((a, b) => a + (b - mean) ** 2, 0) / curve.length);
  const cands = [];
  for (let i = 0; i < curve.length; i++) {
    const v = curve[i];
    const prev = i > 0 ? curve[i - 1] : -1;
    const next = i < curve.length - 1 ? curve[i + 1] : -1;
    if (v < 0.25 || v < prev || v <= next) continue;
    const before = Math.min(...curve.slice(Math.max(0, i - 3), i).concat([v]));
    const onset = v - before;
    if (v >= mean + sd * 0.8 || onset >= 0.15) cands.push({ i, score: v + onset });
  }
  cands.sort((a, b) => b.score - a.score);
  const chosen = [];
  for (const c of cands) {
    if (chosen.every((x) => Math.abs(x.i - c.i) * step >= 1)) chosen.push(c);
    if (chosen.length >= maxPeaks) break;
  }
  return chosen.map((c) => r3(c.i * step + step / 2)).sort((a, b) => a - b);
}

async function extractAudio(paths, file, seconds, signal) {
  let r;
  try {
    r = await run(paths.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-t', String(seconds), '-i', file,
      '-map', '0:a:0', '-vn', '-sn', '-ac', '1', '-ar', String(AUDIO_RATE), '-f', 's16le', 'pipe:1'],
    { signal, encoding: 'buffer', timeoutMs: 60000 + seconds * 1000 });
  } catch (e) {
    if (isCancelled(e, signal)) throw cancelledError();
    throw new Error('音频解码失败：' + e.message);
  }
  if (r.code !== 0 && (!r.stdout || !r.stdout.length)) throw new Error('音频解码失败' + (lastLine(r.stderr) ? `：${lastLine(r.stderr)}` : ''));
  return r.stdout;
}

// ───────────────────────── 3) 关键帧 / 4) 色彩 ─────────────────────────

async function privateExtractFrame(paths, file, time, outPath, { width = KF_WIDTH, signal } = {}) {
  const tryAt = async (t) => {
    const r = await run(paths.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-ss', String(Math.max(0, t).toFixed(3)), '-i', file,
      '-frames:v', '1', '-vf', `scale=${width}:-2:flags=bicubic`, '-q:v', '3', '-update', '1', '-y', outPath], { signal, timeoutMs: 60000 });
    return r.code === 0 && fileOk(outPath);
  };
  if (await tryAt(time)) return outPath;
  if (time > 0.6 && await tryAt(time - 0.5)) return outPath;
  if (await tryAt(0)) return outPath;
  throw new Error('抽帧失败');
}

async function extractFrame(paths, file, time, outPath, opts = {}) {
  const ff = loadFf();
  if (ff && typeof ff.extractFrame === 'function') {
    try {
      const p = await ff.extractFrame(paths, file, time, outPath, { width: opts.width || KF_WIDTH, signal: opts.signal });
      if (fileOk(p || outPath)) return p || outPath;
    } catch (e) {
      if (isCancelled(e, opts.signal)) throw cancelledError();
    }
  }
  return privateExtractFrame(paths, file, time, outPath, opts);
}

function toHex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
}
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbDist(a, b) { return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2); }

/** rgb24 像素 → ColorStats（与 SPEC §3.6 一致）。主色用 MMCQ，实现在 shotdetect.cjs。 */
const { statsFromRgb } = shotdetect;

async function privateColorStats(paths, imagePath, signal) {
  const r = await run(paths.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-i', imagePath, '-frames:v', '1',
    '-vf', 'scale=32:18:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { signal, encoding: 'buffer', timeoutMs: 30000 });
  const s = r.code === 0 ? statsFromRgb(r.stdout) : null;
  if (!s) throw new Error('色彩统计失败');
  return s;
}

function validStats(s) {
  return s && typeof s === 'object' && Number.isFinite(Number(s.luma)) && Array.isArray(s.palette);
}

async function colorStatsFromImage(paths, imagePath, signal) {
  const ff = loadFf();
  if (ff && typeof ff.colorStatsFromImage === 'function') {
    try {
      const s = await ff.colorStatsFromImage(paths, imagePath, { signal });
      if (validStats(s)) return s;
    } catch (e) {
      if (isCancelled(e, signal)) throw cancelledError();
    }
  }
  return privateColorStats(paths, imagePath, signal);
}

function fallbackStats(lumaValue) {
  const l = clamp01(lumaValue == null ? 0.5 : lumaValue);
  const g = Math.round(l * 255);
  const hex = toHex(g, g, g);
  return { luma: r3(l), contrast: 0, saturation: 0, warmth: 0, tint: 0, palette: [hex, hex, hex, hex, hex] };
}

/** 6) 按时长加权的全片色彩档案 + 合并主色 */
function mergeColorProfile(items) {
  const valid = items.filter((x) => x && validStats(x.stats) && x.weight > 0);
  if (!valid.length) return fallbackStats(0.5);
  const W = valid.reduce((a, x) => a + x.weight, 0);
  const avg = (k) => valid.reduce((a, x) => a + (Number(x.stats[k]) || 0) * x.weight, 0) / W;
  const clusters = [];
  for (const x of valid) {
    x.stats.palette.slice(0, 5).forEach((hex, rank) => {
      const rgb = hexToRgb(hex);
      if (!rgb) return;
      const w = x.weight * (5 - rank);
      const c = clusters.find((cl) => rgbDist(cl.rgb, rgb) < 40);
      if (c) {
        const t = c.w + w;
        c.rgb = c.rgb.map((v, i) => (v * c.w + rgb[i] * w) / t);
        c.w = t;
      } else clusters.push({ rgb, w });
    });
  }
  clusters.sort((a, b) => b.w - a.w);
  const palette = clusters.slice(0, 5).map((c) => toHex(c.rgb[0], c.rgb[1], c.rgb[2]));
  while (palette.length < 5) palette.push(palette.length ? palette[palette.length - 1] : '#808080');
  return {
    luma: r3(clamp01(avg('luma'))),
    contrast: r3(clamp01(avg('contrast'))),
    saturation: r3(clamp01(avg('saturation'))),
    warmth: r3(clamp(avg('warmth'), -1, 1)),
    tint: r3(clamp(avg('tint'), -1, 1)),
    palette,
  };
}

function computeRhythm(bounds, duration) {
  const durations = bounds.map((b) => r3(b.end - b.start));
  const total = durations.reduce((a, b) => a + b, 0);
  const D = duration > 0 ? duration : total;
  return {
    avgShot: r3(durations.length ? total / durations.length : 0),
    medianShot: r3(median(durations)),
    cutsPerMinute: r3(D > 0 ? (Math.max(0, durations.length - 1) / D) * 60 : 0),
    durations,
  };
}

// ───────────────────────── 8) 联系表 ─────────────────────────

function sampleForSheets(shots, max = SHEET_PER * SHEET_MAX) {
  const withThumb = shots.filter((s) => s.thumb && fileOk(s.thumb));
  if (withThumb.length <= max) return withThumb;
  const out = [];
  for (let i = 0; i < max; i++) out.push(withThumb[Math.round((i * (withThumb.length - 1)) / (max - 1))]);
  return [...new Set(out)];
}

// 联系表格子：横屏 4×3（320×180）、竖屏 6×2（180×320）、方形 4×3（240×240），每张都是 12 格
function sheetLayout(width, height) {
  const ar = width > 0 && height > 0 ? width / height : 16 / 9;
  if (ar < 0.8) return { cw: 180, ch: 320, cols: 6, rows: 2 };
  if (ar <= 1.25) return { cw: 240, ch: 240, cols: 4, rows: 3 };
  return { cw: 320, ch: 180, cols: 4, rows: 3 };
}

const SHEET_PAD = 4;
let sheetFontCache;
/** 烧入编号用的字体（系统自带等宽/无衬线字体）；找不到就不烧字，提示词里改用文字对照表 */
function sheetFont() {
  if (sheetFontCache !== undefined) return sheetFontCache;
  const winFonts = path.join(process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows', 'Fonts');
  const list = process.platform === 'win32'
    ? ['consola.ttf', 'arialbd.ttf', 'arial.ttf', 'segoeui.ttf'].map((f) => path.join(winFonts, f))
    : ['/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans.ttf'];
  sheetFontCache = list.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
  return sheetFontCache;
}

function fmtMmSs(t) {
  const s = Math.max(0, Math.floor(Number(t) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** 每格左上角烧入「#镜头号 分:秒」。两级转义：单引号保护滤镜图层，\: 保护选项层。 */
function sheetLabelFilters(group, cols, cell, font) {
  if (!font) return '';
  const ff = String(font).replace(/\\/g, '/').replace(/'/g, '').replace(/:/g, '\\:');
  return group.map((s, i) => {
    const x = SHEET_PAD + (i % cols) * (cell.cw + SHEET_PAD) + 6;
    const y = SHEET_PAD + Math.floor(i / cols) * (cell.ch + SHEET_PAD) + 6;
    const text = `#${s.index + 1} ${fmtMmSs(s.start)}`.replace(/:/g, '\\:');
    return `,drawtext=fontfile='${ff}':text='${text}':x=${x}:y=${y}:fontsize=16:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=4`;
  }).join('');
}

async function buildContactSheets(paths, shots, outDir, { signal, onFrac, errors, width = 0, height = 0 }) {
  const picked = sampleForSheets(shots);
  const sheets = [];
  const sheetShots = [];
  let numbered = true;
  if (!picked.length) return { sheets, sheetShots, numbered: false };
  const cell = sheetLayout(width, height);
  const font = sheetFont();
  const groups = [];
  for (let i = 0; i < picked.length && groups.length < SHEET_MAX; i += SHEET_PER) groups.push(picked.slice(i, i + SHEET_PER));
  const tmpRoot = path.join(outDir, '_sheet_tmp');
  try {
    for (let g = 0; g < groups.length; g++) {
      throwIfAborted(signal);
      const tmp = path.join(tmpRoot, String(g));
      await fs.promises.rm(tmp, { recursive: true, force: true });
      await fs.promises.mkdir(tmp, { recursive: true });
      await Promise.all(groups[g].map((s, i) => fs.promises.copyFile(s.thumb, path.join(tmp, `f_${pad3(i)}.jpg`))));
      const out = path.join(outDir, `sheet_${g + 1}.jpg`);
      // 不满一张时缩小网格，避免大片空白
      const n = groups[g].length;
      const cols = n < cell.cols ? n : cell.cols;
      const rows = Math.min(cell.rows, Math.ceil(n / cell.cols));
      const base = `scale=${cell.cw}:${cell.ch}:force_original_aspect_ratio=decrease,pad=${cell.cw}:${cell.ch}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,`
        + `tile=${cols}x${rows}:padding=${SHEET_PAD}:margin=${SHEET_PAD}:color=0x101114`;
      const labels = sheetLabelFilters(groups[g], cols, cell, font);
      const tile = async (vf) => {
        try {
          return await run(paths.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-reinit_filter', '0', '-framerate', '1', '-start_number', '0',
            '-i', path.join(tmp, 'f_%03d.jpg'), '-vf', vf, '-frames:v', '1', '-q:v', '3', '-update', '1', '-y', out], { signal, timeoutMs: 60000 });
        } catch (e) {
          if (isCancelled(e, signal)) throw cancelledError();
          return { code: -1, stderr: e.message };
        }
      };
      let r = labels ? await tile(base + labels) : null;
      if (!r || r.code !== 0 || !fileOk(out)) {
        // 没有可用字体或 drawtext 不可用 → 不烧编号，提示词里写格子与镜头的对照
        numbered = false;
        r = await tile(base);
      }
      if (r.code === 0 && fileOk(out)) {
        sheets.push(out);
        sheetShots.push(groups[g].map((s) => s.index));
      } else {
        errors.push(`联系表 ${g + 1} 生成失败` + (lastLine(r.stderr) ? `：${lastLine(r.stderr)}` : ''));
      }
      if (onFrac) onFrac((g + 1) / groups.length);
    }
  } finally {
    try { await fs.promises.rm(tmpRoot, { recursive: true, force: true }); } catch {}
  }
  return { sheets, sheetShots, numbered: numbered && sheets.length > 0 };
}

// ───────────────────────── 主流程 ─────────────────────────

/**
 * 拆片分析。返回除 id/title/category/source 外的 Analysis 字段（含 contactSheets / contactSheetShots）。
 * @param {{ paths:{ffmpeg:string, ffprobe?:string}, file:string, outDir:string, maxSeconds?:number,
 *           signal?:AbortSignal, onProgress?:(stage:string, p:number, message:string)=>void, subtitlesFile?:string|null }} opts
 */
/** s16le Buffer → Int16Array（字节偏移为奇数时复制一份） */
function toInt16(buf) {
  const len = buf.length >> 1;
  if (buf.byteOffset % 2 === 0) return new Int16Array(buf.buffer, buf.byteOffset, len);
  return new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + len * 2));
}

/**
 * 拆片主流程。keyframeMode：'auto'（按扫描耗时在「按帧号再解码一遍」与「逐帧定位」间选快的）| 'batch' | 'seek'
 */
async function analyzeVideo({ paths, file, outDir, maxSeconds = 600, signal, onProgress, subtitlesFile = null, keyframeMode = 'auto' } = {}) {
  if (!paths || !paths.ffmpeg || !fs.existsSync(paths.ffmpeg)) throw new Error('找不到 ffmpeg，无法分析视频');
  if (!file || !fs.existsSync(file)) throw new Error('找不到要分析的视频文件');
  if (!outDir) throw new Error('缺少分析输出目录');
  fs.mkdirSync(outDir, { recursive: true });
  const errors = [];
  let lastP = 0;
  const report = (stage, p, msg) => {
    lastP = Math.max(lastP, clamp01(p));
    if (onProgress) { try { onProgress(stage, lastP, msg); } catch {} }
  };
  const span = (stage, a, b, msg) => (f) => report(stage, a + (b - a) * clamp01(f), msg);

  // 0) 探测
  report('probe', 0.01, '正在读取视频信息…');
  throwIfAborted(signal);
  const info = await probeVideo(paths, file, signal);
  if (!info.hasVideo) throw new Error('这个文件没有视频画面，无法拆片（如果是音频，请作为音乐素材使用）');
  const limit = Number(maxSeconds) > 0 ? Number(maxSeconds) : Infinity;
  let scanSeconds = info.duration > 0 ? Math.min(info.duration, limit) : (Number.isFinite(limit) ? limit : 600);
  scanSeconds = Math.max(0.1, scanSeconds);
  if (info.duration > 0 && Number.isFinite(limit) && info.duration > limit) {
    errors.push(`视频较长（${Math.round(info.duration)} 秒），只分析了前 ${Math.round(limit)} 秒`);
  }

  // 1+2) 一遍解码（后台线程计算，不卡界面）：切点与转场类型、每镜关键帧帧号、每镜色彩、亮度/运动曲线
  report('scan', 0.02, '正在逐帧扫描画面与镜头切点…');
  const rate = shotdetect.scanRate(info.fps);
  const scanT0 = Date.now();
  const scan = await shotdetect.scanVideo(paths, file, {
    seconds: scanSeconds,
    rate,
    durationHint: info.duration > 0 ? Math.min(info.duration, limit) : 0,
    signal,
    onFrac: span('scan', 0.02, 0.45, '正在逐帧扫描画面与镜头切点…'),
  });
  const scanMs = Date.now() - scanT0;
  if (scan.exitCode !== 0) errors.push('解码过程中出现错误，部分画面可能缺失' + (lastLine(scan.stderr) ? `（${lastLine(scan.stderr)}）` : ''));
  const duration = r3(scan.duration);
  throwIfAborted(signal);
  if (!scan.shots.length || !(duration > 0)) throw new Error('无法确定视频时长，分析中止');
  const curveLuma = (scan.curves && scan.curves.luma) || [];
  const curveDiff = (scan.curves && scan.curves.diff) || [];

  // 5) 音频：响度曲线 + 节拍（同一次解码）
  report('audio', 0.46, '正在分析声音响度与节拍…');
  let aw = null;
  let audio = { curve: [], peaks: [], tempo: null };
  let tempo = null;
  if (info.hasAudio) {
    try {
      const pcm = await extractAudio(paths, file, scanSeconds, signal);
      if (pcm && pcm.length >= 2) {
        aw = audioWindows(pcm);
        audio = loudnessCurve(aw, duration);
        try { tempo = beatsFromPcm(toInt16(pcm), AUDIO_RATE); } catch { tempo = null; }
        audio.tempo = tempo ? { bpm: tempo.bpm, confidence: tempo.confidence } : null;
      }
    } catch (e) {
      if (isCancelled(e, signal)) throw cancelledError();
      errors.push(e.message);
    }
  }
  if (!('tempo' in audio)) audio.tempo = null;
  report('audio', 0.52, '声音分析完成');

  // 3) 关键帧：扫描时已按清晰度/代表性/避开黑场糊帧选好帧号，这里只负责导出成图片
  const shots = scan.shots.map((b, i) => ({
    index: i,
    start: r3(b.start),
    end: r3(b.end),
    duration: r3(b.end - b.start),
    thumb: null,
    keyframes: [],
    stats: b.stats || null,
    motion: shotMotion(curveDiff, b.start, b.end),
    loudness: aw ? r3(dbNorm(rangeRms(aw, b.start, b.end))) : 0,
    cutIn: b.cutIn || null,
    keyframeScore: Number.isFinite(b.keyframeScore) ? r3(b.keyframeScore) : null,
    ai: null,
  }));
  const lastFrame = Math.max(0, Math.floor(duration * rate) - 1);
  const tasks = [];
  shots.forEach((s, i) => {
    let kfs = (scan.shots[i].keyframes || []).slice(0, 3);
    if (!kfs.length) {
      const mid = (s.start + s.end) / 2;
      kfs = [{ frame: Math.round(mid * rate), t: mid }];
    }
    kfs.forEach((k, slot) => {
      const suffix = slot === 0 ? '' : slot === 1 ? '_a' : '_b';
      const frame = Math.min(lastFrame, Math.max(0, Math.round(k.frame)));
      tasks.push({ shot: s, slot, frame, out: path.join(outDir, `kf_${pad3(s.index)}${suffix}.jpg`) });
    });
  });
  report('keyframes', 0.52, '正在导出关键帧…');
  const kfProgress = span('keyframes', 0.52, 0.85, '正在导出关键帧…');
  const frames = new Map();
  // 逐帧定位大约每张 SEEK_COST_MS；按帧号再解码一遍约等于扫描耗时。选预计更快的一种，失败的再逐帧补。
  const seekEstimate = (tasks.length * SEEK_COST_MS) / CONCURRENCY;
  const useBatch = keyframeMode === 'batch' || (keyframeMode !== 'seek' && seekEstimate > scanMs * 0.9);
  let batchShare = 0;
  if (useBatch) {
    batchShare = 0.8;
    try {
      const ok = await shotdetect.extractFramesBatch(paths, file, tasks.map((t) => ({ frame: t.frame, out: t.out })), {
        rate, seconds: scanSeconds, signal, width: KF_WIDTH, tmpDir: path.join(outDir, '_kf_tmp'),
        onFrac: (f) => kfProgress(f * batchShare),
      });
      for (const t of tasks) if (ok.has(t.out)) frames.set(t, t.out);
    } catch (e) {
      if (isCancelled(e, signal)) throw cancelledError();
    }
  }
  const rest = tasks.filter((t) => !frames.has(t));
  let done = 0;
  let kfFailed = 0;
  await pool(rest, CONCURRENCY, async (t) => {
    const time = clamp((t.frame + 0.3) / rate, 0, Math.max(0, duration - 0.05));
    try {
      const p = await extractFrame(paths, file, time, t.out, { width: KF_WIDTH, signal });
      frames.set(t, p);
    } catch (e) {
      if (isCancelled(e, signal)) throw cancelledError();
      kfFailed += 1;
    }
    done += 1;
    kfProgress(batchShare + (1 - batchShare) * (done / rest.length));
  }, signal);
  for (const s of shots) {
    const own = tasks.filter((t) => t.shot === s && frames.has(t)).sort((a, b) => a.slot - b.slot).map((t) => frames.get(t));
    s.keyframes = own;
    s.thumb = own[0] || null;
  }
  if (kfFailed) errors.push(`有 ${kfFailed} 张关键帧抽取失败`);

  // 4) 每镜色彩：扫描时已按镜头中段多帧统计；个别缺失的再从关键帧图片补
  report('color', 0.85, '正在统计色彩与光线…');
  let colorFailed = 0;
  let cdone = 0;
  const colorProgress = span('color', 0.85, 0.92, '正在统计色彩与光线…');
  const needColor = shots.filter((s) => !validStats(s.stats));
  await pool(needColor, CONCURRENCY, async (s) => {
    s.stats = null;
    if (s.thumb) {
      try { s.stats = await colorStatsFromImage(paths, s.thumb, signal); } catch (e) {
        if (isCancelled(e, signal)) throw cancelledError();
        colorFailed += 1;
      }
    }
    if (!s.stats) s.stats = fallbackStats(shotLuma(curveLuma, s.start, s.end));
    cdone += 1;
    colorProgress(cdone / needColor.length);
  }, signal);
  if (colorFailed) errors.push(`有 ${colorFailed} 个镜头的色彩统计失败，已用亮度近似`);

  // 6) 节奏（含卡点）与色彩档案
  const rhythm = computeRhythm(shots, duration);
  const realCuts = shots.filter((s, i) => i > 0 && !(s.cutIn && s.cutIn.kind === 'split')).map((s) => s.start);
  rhythm.beatSync = tempo && tempo.bpm ? computeBeatSync(realCuts, tempo.beats, tempo.bpm, info.fps) : null;
  const colorProfile = mergeColorProfile(shots.map((s) => ({ stats: s.stats, weight: s.duration })));

  // 7) 字幕
  let transcript = [];
  if (subtitlesFile) {
    try {
      const text = await fs.promises.readFile(subtitlesFile, 'utf8');
      transcript = parseVtt(text).filter((c) => c.start < duration);
    } catch {
      errors.push('字幕文件读取失败');
    }
  }

  // 8) 联系表（每格烧入「#镜头号 时间」，AI 看图时不会对错镜头）
  report('sheets', 0.92, '正在拼接关键帧联系表…');
  let contactSheets = [];
  let contactSheetShots = [];
  let contactSheetsNumbered = false;
  try {
    const r = await buildContactSheets(paths, shots, outDir, {
      signal, errors, width: info.width, height: info.height, onFrac: span('sheets', 0.92, 0.99, '正在拼接关键帧联系表…'),
    });
    contactSheets = r.sheets;
    contactSheetShots = r.sheetShots;
    contactSheetsNumbered = !!r.numbered;
  } catch (e) {
    if (isCancelled(e, signal)) throw cancelledError();
    errors.push('联系表生成失败：' + e.message);
  }

  report('done', 1, `分析完成：${shots.length} 个镜头`);
  return {
    assetPath: file,
    duration,
    width: info.width,
    height: info.height,
    fps: r3(info.fps || 0),
    createdAt: new Date().toISOString(),
    status: errors.length ? 'partial' : 'done',
    errors,
    shots,
    rhythm,
    audio,
    transcript,
    colorProfile,
    ai: null,
    techniqueIds: [],
    contactSheets,
    contactSheetShots,
    contactSheetsNumbered,
    // 附加：每 0.5 秒的亮度与运动曲线（0..1），供详情页绘图
    curves: {
      step: 1 / SAMPLE_FPS,
      luma: curveLuma.slice(0, Math.ceil(duration * SAMPLE_FPS)).map(r3),
      motion: curveDiff.slice(0, Math.ceil(duration * SAMPLE_FPS)).map((d) => r3(1 - Math.exp(-d / 0.04))),
    },
  };
}

// ───────────────────────── 节拍检测（F1 速度 + F2 卡点） ─────────────────────────
// 结构借鉴 realtime-bpm-analyzer 的 tempogram 思路（Apache-2.0，只借鉴思路，代码为本项目自写）：
// 分频带起音包络 → 自相关 → 拍倍数梳状求和 × 对数高斯先验 → 抛物线插值；再沿节拍网格吸附起音，线性回归求精确 BPM。

const BEAT_RATE = AUDIO_RATE;
const BEAT_HOP = 256;            // ≈23ms
const TEMPO_MIN_CONF = 0.3;      // 低于此视为「无明显节拍」，不硬给 BPM（合成测试：说话声 0.08–0.24，鼓点配乐 0.5 以上）
const TEMPO_MIN_STRENGTH = 0.1;  // 节拍处起音强度下限（对数能量单位；持续音的拍频起伏约 0.05）
const TEMPO_PRIOR_BPM = 120;     // 短视频配乐多在 90–140 BPM
const TEMPO_MIN_BPM = 50;
const TEMPO_MAX_BPM = 200;

function lpCoef(fc, rate) { return 1 - Math.exp((-2 * Math.PI * fc) / rate); }

/** 前缀和局部均值（窗口 ±w） */
function localMean(arr, w) {
  const n = arr.length;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + arr[i];
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w); const b = Math.min(n - 1, i + w);
    out[i] = (pre[b + 1] - pre[a]) / (b - a + 1);
  }
  return out;
}

/**
 * Int16 单声道 PCM → 起音包络（每 hop 一个值；第 i 个值的起音落在第 i 个 hop 内，即 (i+0.5)·hop 时刻）。
 * 低（<150Hz 鼓）/中/高（>1500Hz 镲）三个频带的能量先按最近 4 个 hop（≈93ms）求和（抑制持续音拍频造成的假起音），
 * 再各取对数能量的正向差分，减去 ±0.25 秒局部均值、半波整流后相加，最后用 [1,2,3,2,1]/9 平滑。
 */
function onsetEnvelope(samples, hop = BEAT_HOP, rate = BEAT_RATE) {
  const n = Math.floor(samples.length / hop);
  if (n < 3) return new Float64Array(Math.max(0, n));
  const aLo = lpCoef(150, rate);
  const aHi = lpCoef(1500, rate);
  const hops = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  let lp1 = 0; let lp2 = 0;
  for (let i = 0; i < n; i++) {
    let e0 = 0; let e1 = 0; let e2 = 0;
    for (let j = i * hop, end = j + hop; j < end; j++) {
      const x = samples[j] / 32768;
      lp1 += aLo * (x - lp1);
      lp2 += aHi * (x - lp2);
      const b1 = lp2 - lp1; const b2 = x - lp2;
      e0 += lp1 * lp1; e1 += b1 * b1; e2 += b2 * b2;
    }
    hops[0][i] = e0; hops[1][i] = e1; hops[2][i] = e2;
  }
  const w = Math.max(1, Math.round((0.25 * rate) / hop));
  const sum = new Float64Array(n);
  for (const h of hops) {
    const band = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = i - 3; k <= i; k++) s += h[Math.max(0, k)];
      band[i] = s / (4 * hop);
    }
    let mean = 0;
    for (let i = 0; i < n; i++) mean += band[i];
    mean /= n;
    if (!(mean > 1e-10)) continue; // 这个频带几乎没声音
    const flux = new Float64Array(n);
    let prev = Math.log1p((100 * band[0]) / mean);
    for (let i = 1; i < n; i++) {
      const v = Math.log1p((100 * band[i]) / mean);
      flux[i] = Math.max(0, v - prev);
      prev = v;
    }
    const lm = localMean(flux, w);
    for (let i = 0; i < n; i++) sum[i] += Math.max(0, flux[i] - lm[i]);
  }
  const out = new Float64Array(n);
  const k = [1, 2, 3, 2, 1];
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let d = -2; d <= 2; d++) { const j = i + d; if (j >= 0 && j < n) s += sum[j] * k[d + 2]; }
    out[i] = s / 9;
  }
  return out;
}

/** 起音包络 → 速度（帧为单位的节拍周期）与置信度 */
function tempoFromEnvelope(env, fps) {
  const n = env.length;
  const minLag = Math.max(2, Math.floor((fps * 60) / TEMPO_MAX_BPM));
  const maxLag = Math.ceil((fps * 60) / TEMPO_MIN_BPM);
  if (n < maxLag * 2 + 4) return null;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = env[i] - mean;
  const maxAcf = Math.min(n - 1, maxLag * 4 + 2);
  const r = new Float64Array(maxAcf + 1);
  for (let L = 0; L <= maxAcf; L++) {
    let s = 0;
    for (let i = L; i < n; i++) s += x[i] * x[i - L];
    r[L] = s / (n - L);
  }
  if (!(r[0] > 1e-12)) return null;
  const at = (pos) => { const i = Math.floor(pos); if (i + 1 > maxAcf) return NaN; const f = pos - i; return r[i] * (1 - f) + r[i + 1] * f; };
  // 梳状求和：P、2P、3P、4P，权重 1/m（只用落在可算范围内且有足够数据的倍数）
  const comb = (P) => {
    let s = 0; let wsum = 0;
    for (let m = 1; m <= 4; m++) {
      const pos = m * P;
      if (pos > n / 2) break;
      const v = at(pos);
      if (!Number.isFinite(v)) break;
      s += v / m; wsum += 1 / m;
    }
    return wsum ? s / wsum : 0;
  };
  const prior = (P) => { const bpm = (fps * 60) / P; const o = Math.log2(bpm / TEMPO_PRIOR_BPM); return Math.exp(-0.5 * o * o); };
  const raw = [];
  let best = -1; let bestScore = -Infinity;
  for (let L = minLag; L <= maxLag; L++) {
    const c = comb(L);
    raw.push(c);
    // 基频本身必须有相关：只在高倍数上对齐的（例如 3 秒一次的提示音）不算节拍
    if (!(r[L] > 0)) continue;
    const sc = c * prior(L);
    if (sc > bestScore) { bestScore = sc; best = L; }
  }
  if (best < 0) return null;
  // 抛物线插值求分数周期
  let P = best;
  if (best > minLag && best < maxLag) {
    const y0 = comb(best - 1) * prior(best - 1); const y1 = bestScore; const y2 = comb(best + 1) * prior(best + 1);
    const den = y0 - 2 * y1 + y2;
    if (den < 0) P = best + clamp((0.5 * (y0 - y2)) / den, -0.5, 0.5);
  }
  const sorted = raw.slice().sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const fundamental = Math.max(at(P), r[best]);
  const confidence = clamp01((Math.min(comb(best), fundamental) - med) / r[0]);
  return { period: P, confidence };
}

/**
 * 纯函数：PCM → 速度与节拍时间（秒）。
 * 置信度低（没有稳定节拍，例如纯人声、环境声、噪声）时 bpm 为 null、beats 为空，不硬给结果。
 * @returns {{ bpm:number|null, confidence:number, beats:number[] }}
 */
function beatsFromPcm(samples, rate = BEAT_RATE, hop = BEAT_HOP) {
  const none = (confidence = 0) => ({ bpm: null, confidence: r3(confidence), beats: [] });
  if (!samples || samples.length < hop * 4) return none();
  const env = onsetEnvelope(samples, hop, rate);
  const fps = rate / hop;
  const n = env.length;
  let energy = 0;
  for (let i = 0; i < n; i++) energy += env[i];
  if (energy <= 1e-6) return none();
  const tp = tempoFromEnvelope(env, fps);
  if (!tp) return none();
  if (tp.confidence < TEMPO_MIN_CONF) return none(tp.confidence);
  let P = tp.period;
  // 相位：网格上的包络之和最大（±1 帧取最大）
  const near = (c) => { const i = Math.round(c); return Math.max(env[i - 1] || 0, env[i] || 0, env[i + 1] || 0); };
  let phase = 0; let phaseScore = -1;
  for (let ph = 0; ph < P; ph += 0.5) {
    let sc = 0;
    for (let c = ph; c < n; c += P) sc += near(c);
    if (sc > phaseScore) { phaseScore = sc; phase = ph; }
  }
  // 沿网格在 ±tol 内吸附到起音峰
  const snap = (center, tol) => {
    const ci = Math.round(center);
    let bi = ci; let bv = env[ci] || 0;
    for (let k = Math.max(0, ci - tol); k <= Math.min(n - 1, ci + tol); k++) if (env[k] > bv) { bv = env[k]; bi = k; }
    return { i: bv > 0 ? bi : center, v: bv };
  };
  const grid = (ph, per, tol) => {
    const out = [];
    for (let k = 0; ph + k * per < n; k++) out.push({ k, ...snap(ph + k * per, tol) });
    return out;
  };
  // 第一遍：吸附 → 用强起音做线性回归，修正周期与相位（长曲目也不漂移）
  const first = grid(phase, P, Math.max(1, Math.round(P * 0.15)));
  const strengths = first.map((b) => b.v).sort((a, b) => a - b);
  const medStrength = strengths[Math.floor(strengths.length / 2)] || 0;
  // 节拍上的起音太弱（持续音的细小起伏、底噪）→ 不算节拍
  if (medStrength < TEMPO_MIN_STRENGTH) return { ...none(tp.confidence), strength: r3(medStrength) };
  const strong = first.filter((b) => b.v > 0 && b.v >= medStrength * 0.5);
  if (strong.length >= 4) {
    const m = strong.length;
    const mk = strong.reduce((a, b) => a + b.k, 0) / m;
    const mi = strong.reduce((a, b) => a + b.i, 0) / m;
    let sxy = 0; let sxx = 0;
    for (const b of strong) { sxy += (b.k - mk) * (b.i - mi); sxx += (b.k - mk) ** 2; }
    const slope = sxx > 0 ? sxy / sxx : P;
    if (slope > P * 0.9 && slope < P * 1.1) {
      P = slope;
      phase = mi - mk * P;
      while (phase - P >= -0.5) phase -= P;
      while (phase < -0.5) phase += P;
    }
  }
  // 第二遍：精确网格 ±10% 吸附得到输出节拍；去掉片头片尾没有起音的空拍
  const second = grid(Math.max(0, phase), P, Math.max(1, Math.round(P * 0.1)));
  const s2 = second.map((b) => b.v).sort((a, b) => a - b);
  const med2 = s2[Math.floor(s2.length / 2)] || 0;
  let a = 0; let b = second.length - 1;
  while (a <= b && second[a].v < med2 * 0.1) a++;
  while (b >= a && second[b].v < med2 * 0.1) b--;
  const beats = [];
  const minGap = ((P * hop) / rate) * 0.5;
  for (let k = a; k <= b; k++) {
    const t = r3(((second[k].i + 0.5) * hop) / rate);
    if (!beats.length || t - beats[beats.length - 1] > minGap) beats.push(t);
  }
  const bpm = (fps * 60) / P;
  return { bpm: Math.round(bpm * 10) / 10, confidence: r3(tp.confidence), strength: r3(medStrength), beats };
}

/** ffmpeg 解码为 11025Hz 单声道 PCM（最长 maxSeconds 秒） */
async function decodePcm(audioPath, { paths, ffmpeg, signal, maxSeconds = 900 } = {}) {
  const bin = ffmpeg || (paths && paths.ffmpeg);
  if (!bin) throw new Error('找不到 ffmpeg，无法检测节拍');
  if (!audioPath) throw new Error('缺少音频文件');
  await fs.promises.access(audioPath);
  const { spawn } = require('node:child_process');
  const chunks = [];
  await new Promise((resolve, reject) => {
    const p = spawn(bin, ['-hide_banner', '-nostdin', '-v', 'error', '-t', String(maxSeconds), '-i', audioPath,
      '-vn', '-ac', '1', '-ar', String(BEAT_RATE), '-f', 's16le', '-'], { windowsHide: true });
    const onAbort = () => { try { p.kill(); } catch {} };
    if (signal) { if (signal.aborted) onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', () => {});
    p.on('error', reject);
    p.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) reject(cancelledError());
      else if (code !== 0 && !chunks.length) reject(new Error(`节拍检测解码失败（${code}）`));
      else resolve();
    });
  });
  const buf = Buffer.concat(chunks);
  return new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + (buf.length & ~1)));
}

/**
 * 速度检测（供素材库写 asset.tempo）。
 * @returns {Promise<{ bpm:number|null, confidence:number, beats:number[] }>}
 */
async function detectTempo(audioPath, opts = {}) {
  return beatsFromPcm(await decodePcm(audioPath, opts));
}

/**
 * 节拍检测：返回节拍时间（秒）。没有明显节拍时返回空数组。
 * @returns {Promise<number[]>}
 */
async function detectBeats(audioPath, opts = {}) {
  return (await detectTempo(audioPath, opts)).beats;
}

/**
 * F2 卡点：切点落在节拍 ±tol 内的比例（卡点率），与「随便剪也会碰上」的随机基线相比得到显著度。
 * 显著度 > 2 基本可以认定是刻意踩点；≈1 与随机剪辑没有区别。切点或节拍太少时返回 null。
 * @param {number[]} cuts 切点时间（秒，不含 0）
 * @param {number[]} beats 节拍时间（秒）
 */
function computeBeatSync(cuts, beats, bpm, fps = 25) {
  if (!(Number(bpm) > 0) || !Array.isArray(beats) || beats.length < 4) return null;
  const bs = beats.filter((t) => Number.isFinite(t)).sort((x, y) => x - y);
  if (bs.length < 4) return null;
  const period = 60 / bpm;
  const lo = bs[0] - period / 2;
  const hi = bs[bs.length - 1] + period / 2;
  const cs = (Array.isArray(cuts) ? cuts : []).filter((t) => Number.isFinite(t) && t > 0 && t >= lo && t <= hi);
  if (cs.length < 3) return null;
  const tol = Math.max(0.08, 1.5 / (Number(fps) > 0 ? Number(fps) : 25));
  const nearestGap = (t) => {
    let a = 0; let b = bs.length - 1;
    while (b - a > 1) { const m = (a + b) >> 1; if (bs[m] < t) a = m; else b = m; }
    return Math.min(Math.abs(bs[a] - t), Math.abs(bs[b] - t));
  };
  const onBeatCuts = cs.filter((t) => nearestGap(t) <= tol + 1e-9).map(r3);
  const hitRate = onBeatCuts.length / cs.length;
  const baseline = Math.min(1, (2 * tol) / period);
  return {
    bpm: Math.round(Number(bpm) * 10) / 10,
    beats: bs.slice(0, 2000),
    tol: r3(tol),
    cuts: cs.length,
    hits: onBeatCuts.length,
    hitRate: r3(hitRate),
    baseline: r3(baseline),
    significance: Math.round((baseline > 0 ? hitRate / baseline : 0) * 100) / 100,
    onBeatCuts,
  };
}

module.exports = {
  analyzeVideo,
  detectBeats,
  detectTempo,
  beatsFromPcm,
  computeBeatSync,
  _internals: {
    buildShotBounds, computeCurves, shotMotion, audioWindows, loudnessCurve, findPeaks, dbNorm,
    statsFromRgb, mergeColorProfile, computeRhythm, sampleForSheets, probeVideo, onsetEnvelope, tempoFromEnvelope, sheetLayout,
    setFf(mod) { ffOverride = mod; },
  },
};
