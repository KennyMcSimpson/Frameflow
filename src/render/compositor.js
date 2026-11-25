// 画面合成：一帧 = 主轨（转场 / 调色 / look / 运镜 / 特效 / transform）→ 片内字幕 → 文字轨。
// 预览与导出走同一套代码；导出模式只是采样更多（运动模糊、径向模糊的采样数更高）。
//
// 每个活动镜头先在自己的工作画布（与输出同尺寸）上完成「源画面 → 一级校色 → 色调 → 特效」，
// 再按 transitionState 把一或两个镜头合成到目标画布。所有工作画布按尺寸缓存复用，不会每帧分配。

import * as TL from '../engine/timeline.js';
import { motionTransform, composeTransform, coverSize, clamp01, easeOutCubic, animatedProps, fitSize } from './motion.js';

const { layoutVideo, activeAt, textAt } = TL;
import { transitionState, introOverlay } from './transitions.js';
import { effectiveColor, primaryFilter, applyTone, needsToneOverlay } from './looks.js';
import { drawPreviz, drawPrevizHud } from './previz.js';
import { releaseScratchPool } from './previz/util.js';
import { releasePostCache } from './previz/post.js';
import { drawCaption, drawTextClip, FONT_SANS } from './text.js';

const DEG = Math.PI / 180;

// ---------------- 工作画布 ----------------

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  throw new Error('当前环境不支持画布，无法渲染画面');
}

class SurfaceSet {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.slots = new Map();
    this.previz = new Map(); // assetId → { surface, key, spec }
  }

  /** 取一块工作画布；div 为相对输出的缩小倍数 */
  get(name, div = 1) {
    const key = div === 1 ? name : `${name}@${div}`;
    let s = this.slots.get(key);
    const width = Math.max(1, Math.round(this.w / div));
    const height = Math.max(1, Math.round(this.h / div));
    if (!s) {
      const canvas = makeCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('无法创建渲染画布（显卡资源可能不足）');
      s = { canvas, ctx, width, height };
      this.slots.set(key, s);
    }
    resetCtx(s.ctx);
    return s;
  }
}

const surfaceSets = new Map();
const MAX_SETS = 3;

function surfacesFor(w, h) {
  const key = `${w}x${h}`;
  let set = surfaceSets.get(key);
  if (set) {
    surfaceSets.delete(key);
    surfaceSets.set(key, set);
    return set;
  }
  set = new SurfaceSet(w, h);
  surfaceSets.set(key, set);
  while (surfaceSets.size > MAX_SETS) surfaceSets.delete(surfaceSets.keys().next().value);
  return set;
}

/** 释放全部缓存的工作画布（例如关闭导出后释放显存） */
export function releaseRenderCache() {
  surfaceSets.clear();
  releaseScratchPool();
  releasePostCache();
}

function resetCtx(g) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.filter = 'none';
  g.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in g) g.imageSmoothingQuality = 'high';
  g.shadowColor = 'transparent';
  g.shadowBlur = 0;
}

function copyInto(dst, src, filter = 'none') {
  const g = dst.ctx;
  g.globalCompositeOperation = 'copy';
  g.filter = filter;
  g.drawImage(src.canvas || src, 0, 0, dst.width, dst.height);
  g.globalCompositeOperation = 'source-over';
  g.filter = 'none';
}

// ---------------- 确定性随机 ----------------

function hash01(a, b = 0) {
  let x = Math.imul((a | 0) ^ Math.imul((b | 0) + 0x632be5ab, 0x9e3779b1), 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

// 颗粒纹理：256×256 灰阶噪点，均值 128，近似高斯分布（三个均匀分布求和）
let grainCanvas = null;

function grainTexture() {
  if (grainCanvas) return grainCanvas;
  const N = 256;
  const c = makeCanvas(N, N);
  const g = c.getContext('2d');
  const img = g.createImageData(N, N);
  let s = 0x2f6b9a1d;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < N * N; i += 1) {
    const v = (rnd() + rnd() + rnd() - 1.5) / 1.5; // -1..1
    const n = Math.max(0, Math.min(255, Math.round(128 + v * 110)));
    img.data[i * 4] = n;
    img.data[i * 4 + 1] = n;
    img.data[i * 4 + 2] = n;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  grainCanvas = c;
  return c;
}

const patternCache = new WeakMap();

function patternFor(g, key, source, repeat = 'repeat') {
  let m = patternCache.get(g);
  if (!m) {
    m = new Map();
    patternCache.set(g, m);
  }
  let p = m.get(key);
  if (!p) {
    p = g.createPattern(source, repeat);
    m.set(key, p);
  }
  return p;
}

const scanlineCache = new Map();

function scanlineTexture(pitch) {
  let c = scanlineCache.get(pitch);
  if (c) return c;
  c = makeCanvas(4, pitch);
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 4, pitch);
  const dark = Math.max(1, Math.round(pitch * 0.42));
  g.fillStyle = 'rgb(70,70,78)';
  g.fillRect(0, pitch - dark, 4, dark);
  scanlineCache.set(pitch, c);
  return c;
}

// ---------------- 参数整理 ----------------

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

function fxOf(clip) {
  const f = (clip && clip.fx) || {};
  const k = (key) => clamp01(num(f[key]));
  return { blur: k('blur'), grain: k('grain'), glow: k('glow'), sharpen: k('sharpen'), letterbox: k('letterbox'), chromatic: k('chromatic'), vhs: k('vhs'), flash: k('flash') };
}

function sourceSize(src) {
  const w = src.videoWidth || src.naturalWidth || src.displayWidth || src.width || 0;
  const h = src.videoHeight || src.naturalHeight || src.displayHeight || src.height || 0;
  return { w, h };
}

// ---------------- 占位画面 ----------------

function drawPlaceholder(g, w, h, title, sub) {
  const u = Math.min(w, h);
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#2a2c33');
  grad.addColorStop(1, '#1b1c21');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  // 细斜纹：一眼能看出这是占位而不是黑场
  g.save();
  g.strokeStyle = 'rgba(255,255,255,0.035)';
  g.lineWidth = Math.max(1, u * 0.012);
  g.beginPath();
  const step = u * 0.06;
  for (let x = -h; x < w + h; x += step) {
    g.moveTo(x, 0);
    g.lineTo(x + h, h);
  }
  g.stroke();
  g.restore();
  const size = Math.max(10, Math.round(u * 0.042));
  g.font = `600 ${size}px ${FONT_SANS}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(255,255,255,0.78)';
  g.fillText(title, w / 2, h / 2 - (sub ? size * 0.5 : 0), w * 0.9);
  if (sub) {
    g.font = `400 ${Math.round(size * 0.62)}px ${FONT_SANS}`;
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.fillText(sub, w / 2, h / 2 + size * 0.85, w * 0.9);
  }
}

/** 预览里素材还没出画面时，等这么久才画「加载中」（短暂的 seek 不闪占位） */
const LOADING_DELAY_MS = 400;

function mediaWait(pool, asset) {
  if (!pool || typeof pool.waitInfo !== 'function') return null;
  try { return pool.waitInfo(asset) || null; } catch { return null; }
}

/**
 * 取不到画面时画什么：
 * - 素材离线 / 读取出错：说清原因和下一步；
 * - 预览：素材出过画面（只是 seek 慢一点）或刚开始加载不到 400ms，保持底色不闪字；超过 400ms 才画「加载中」；
 * - 导出：照旧画占位（导出前已精确 seek，走到这里说明真的读不出来）。
 */
function drawMediaWait(g, w, h, asset, rc) {
  const wait = mediaWait(rc.pool, asset);
  const name = asset.name || '';
  if (asset.offline || asset.missing) {
    drawPlaceholder(g, w, h, '素材离线', `找不到原文件${name ? `「${name}」` : ''}，请在素材库里重新链接`);
    return;
  }
  if (wait && wait.error) {
    drawPlaceholder(g, w, h, '素材无法读取', `${name ? `${name}：` : ''}${wait.error}`);
    return;
  }
  if (rc.mode === 'preview' && wait && (wait.framed || num(wait.waitMs) <= LOADING_DELAY_MS)) return;
  drawPlaceholder(g, w, h, '素材加载中…', name);
}

/** 素材是否是「示意画面」生成的（旧数据 source 是字符串 'previz'，新数据是对象） */
export function isPrevizSource(asset) {
  const s = asset && asset.source;
  if (s === 'previz') return true;
  return !!(s && typeof s === 'object' && (s.kind === 'previz' || s.type === 'previz'));
}

// ---------------- 源画面 ----------------

/** 裁剪比例 → 源矩形；返回 [sx, sy, sWidth, sHeight] */
export function cropRect(sw, sh, crop) {
  const c = crop || {};
  const f = (v) => Math.min(0.45, Math.max(0, num(v)));
  const l = f(c.l);
  const t = f(c.t);
  const r = f(c.r);
  const b = f(c.b);
  return [sw * l, sh * t, Math.max(1, sw * (1 - l - r)), Math.max(1, sh * (1 - t - b))];
}

function drawSource(g, src, sw, sh, tf, filter, blur, w, h, place = {}) {
  const [cx, cy, cw, ch] = cropRect(sw, sh, place.crop);
  const box = fitSize(cw, ch, w, h, place.fit || 'cover');
  const scale = Math.max(0.01, tf.scale);
  const mirrorH = (place.mirror && place.mirror.h !== undefined) ? !!place.mirror.h : !!tf.flipH;
  const mirrorV = !!(place.mirror && place.mirror.v);
  g.save();
  g.translate(w / 2 + tf.x * w, h / 2 + tf.y * h);
  if (tf.rotation) g.rotate(tf.rotation * DEG);
  g.scale(mirrorH ? -scale : scale, mirrorV ? -scale : scale);
  const blurPx = blur > 0.001 ? blur * h * 0.022 : 0;
  g.filter = filter || 'none';
  g.drawImage(src, cx, cy, cw, ch, -box.width / 2, -box.height / 2, box.width, box.height);
  if (blurPx >= 0.5) {
    // 先画清晰版垫底，模糊版盖上去：模糊让边缘半透明，底下的清晰版负责补满，画面边缘不发黑
    g.filter = `${filter ? filter + ' ' : ''}blur(${blurPx.toFixed(2)}px)`;
    g.drawImage(src, cx, cy, cw, ch, -box.width / 2, -box.height / 2, box.width, box.height);
  }
  g.restore();
  g.filter = 'none';
}

// ---------------- 画布背景 / 蒙版 / 示意水印 ----------------

/** 主轨片段的画布背景：blur=同源放大模糊铺底（剪映「画布模糊」），color=纯色，image=图片素材 */
function drawCanvasBg(g, canvasSpec, src, sw, sh, rc) {
  const { w, h } = rc;
  const type = canvasSpec && canvasSpec.type;
  if (!type || type === 'none') return;
  if (type === 'color') {
    g.fillStyle = typeof canvasSpec.value === 'string' && canvasSpec.value ? canvasSpec.value : '#000000';
    g.fillRect(0, 0, w, h);
    return;
  }
  let img = src;
  let iw = sw;
  let ih = sh;
  if (type === 'image') {
    const asset = ((rc.project && rc.project.assets) || {})[canvasSpec.value];
    img = asset && rc.pool && typeof rc.pool.getFrame === 'function' ? safeFrame(rc.pool, asset, 0) : null;
    if (img) ({ w: iw, h: ih } = sourceSize(img));
  }
  if (!img || !(iw > 0 && ih > 0)) return;
  const cover = coverSize(iw, ih, w, h);
  const amt = type === 'blur' ? clamp01(num(canvasSpec.value, 0.6) || 0.6) : 0;
  const low = rc.surfaces.get('canvasbg', 4);
  low.ctx.drawImage(img, (low.width - cover.width / 4) / 2, (low.height - cover.height / 4) / 2, cover.width / 4, cover.height / 4);
  g.save();
  g.filter = type === 'blur' ? `blur(${(h * 0.012 + amt * h * 0.03).toFixed(1)}px) brightness(0.82)` : 'none';
  g.drawImage(low.canvas, -w * 0.05, -h * 0.05, w * 1.1, h * 1.1);
  g.restore();
}

function safeFrame(pool, asset, t) {
  try {
    return pool.getFrame(asset, t);
  } catch {
    return null;
  }
}

/** 在离屏画布上生成蒙版（白=保留），再 destination-in 到图层 S */
export function maskGeometry(mask, w, h) {
  const m = mask || {};
  return {
    shape: ['linear', 'mirror', 'circle', 'rect'].includes(m.shape) ? m.shape : 'circle',
    cx: (Number.isFinite(Number(m.cx)) ? Number(m.cx) : 0.5) * w,
    cy: (Number.isFinite(Number(m.cy)) ? Number(m.cy) : 0.5) * h,
    mw: Math.max(1, (Number(m.w) > 0 ? Number(m.w) : 0.5) * w),
    mh: Math.max(1, (Number(m.h) > 0 ? Number(m.h) : 0.5) * h),
    rot: num(m.rot) * DEG,
    feather: clamp01(num(m.feather)) * Math.min(w, h) * 0.25,
    invert: !!m.invert,
  };
}

function applyMask(S, mask, rc) {
  if (!mask) return;
  const { w, h } = rc;
  const geo = maskGeometry(mask, w, h);
  const M = rc.surfaces.get('maskL');
  const g = M.ctx;
  g.clearRect(0, 0, w, h);
  g.save();
  g.translate(geo.cx, geo.cy);
  g.rotate(geo.rot);
  if (geo.feather >= 0.5) g.filter = `blur(${geo.feather.toFixed(1)}px)`;
  g.fillStyle = '#ffffff';
  const big = Math.hypot(w, h) * 2;
  if (geo.shape === 'circle') {
    g.beginPath();
    g.ellipse(0, 0, geo.mw / 2, geo.mh / 2, 0, 0, Math.PI * 2);
    g.fill();
  } else if (geo.shape === 'rect') {
    g.fillRect(-geo.mw / 2, -geo.mh / 2, geo.mw, geo.mh);
  } else if (geo.shape === 'mirror') {
    g.fillRect(-big, -geo.mh / 2, big * 2, geo.mh);
  } else {
    // linear：中心线以上保留
    g.fillRect(-big, -big, big * 2, big);
  }
  g.restore();
  g.filter = 'none';
  if (geo.invert) {
    g.globalCompositeOperation = 'xor';
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'source-over';
  }
  S.ctx.save();
  S.ctx.setTransform(1, 0, 0, 1, 0, 0);
  S.ctx.globalCompositeOperation = 'destination-in';
  S.ctx.drawImage(M.canvas, 0, 0, w, h);
  S.ctx.restore();
}

/** 示意素材（previz）水印：右上角「示意」角标，提醒这不是成片画面 */
export function drawPrevizBadge(g, w, h) {
  const u = Math.min(w, h);
  const size = Math.max(10, Math.round(u * 0.034));
  g.save();
  g.font = `700 ${size}px ${FONT_SANS}`;
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  const label = '示意 · 待替换实拍';
  const tw = g.measureText(label).width;
  const padX = size * 0.7;
  const bw = tw + padX * 2;
  const bh = size * 1.8;
  const x = w - bw - u * 0.03;
  const y = u * 0.03;
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.fillRect(x, y, bw, bh);
  g.fillStyle = 'rgba(255,214,102,0.95)';
  g.fillRect(x, y, Math.max(2, size * 0.18), bh);
  g.fillStyle = '#ffffff';
  g.fillText(label, x + bw / 2, y + bh / 2);
  // 大号斜向半透明水印
  g.translate(w / 2, h / 2);
  g.rotate(-20 * DEG);
  g.font = `800 ${Math.round(u * 0.16)}px ${FONT_SANS}`;
  g.fillStyle = 'rgba(255,255,255,0.08)';
  g.fillText('示意', 0, 0);
  g.restore();
}

const BLEND_OPS = { normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten', add: 'lighter' };
export function blendOp(blend) {
  return BLEND_OPS[blend] || 'source-over';
}

/** 片段本地时刻 → 源素材时刻：优先 timeline.sourceTimeAt（倒放 / 曲线 / 定格），缺失时线性 */
export function srcTimeOf(clip, localT, fallback) {
  if (typeof TL.sourceTimeAt === 'function') {
    try {
      const v = TL.sourceTimeAt(clip, localT);
      if (Number.isFinite(v)) return v;
    } catch { /* 回退 */ }
  }
  if (Number.isFinite(fallback)) return fallback;
  const c = clip || {};
  const inP = num(c.in);
  const outP = Number.isFinite(Number(c.out)) ? Number(c.out) : inP + 1e9;
  if (c.still) return inP;
  const sp = num(c.speed, 1) || 1;
  const raw = c.reverse ? outP - localT * sp : inP + localT * sp;
  return Math.min(outP, Math.max(inP, raw));
}

function previzProgress(entry, asset) {
  const total = Math.max(0.001, num(asset.duration) || num(entry.clip.out) || entry.duration || 1);
  return clamp01(entry.srcTime / total);
}

/** 预演帧缓存：暂停时每帧都是同一画面，不必重画整个场景 */
function previzSource(rc, asset, entry, opts) {
  const spec = asset.previz || {};
  const prog = previzProgress(entry, asset);
  const key = `${Math.round(prog * 2000)}|${opts.movement || ''}`;
  const set = rc.surfaces;
  let rec = set.previz.get(asset.id);
  if (rec && rec.spec === spec && rec.key === key) {
    set.previz.delete(asset.id);
    set.previz.set(asset.id, rec);
    return { canvas: rec.surface.canvas, spec, prog };
  }
  if (!rec) {
    if (set.previz.size >= 3) {
      const [oldId, old] = set.previz.entries().next().value;
      set.previz.delete(oldId);
      rec = { surface: old.surface };
    } else {
      const canvas = makeCanvas(rc.w, rc.h);
      rec = { surface: { canvas, ctx: canvas.getContext('2d'), width: rc.w, height: rc.h } };
    }
  } else {
    set.previz.delete(asset.id);
  }
  const g = rec.surface.ctx;
  resetCtx(g);
  g.clearRect(0, 0, rc.w, rc.h);
  drawPreviz(g, spec, prog, rc.w, rc.h, { ...opts, hud: false });
  rec.spec = spec;
  rec.key = key;
  set.previz.set(asset.id, rec);
  return { canvas: rec.surface.canvas, spec, prog };
}

// ---------------- 特效 ----------------

function fxSharpen(S, amount, rc) {
  const hp = rc.surfaces.get('hp');
  const r = Math.max(1, rc.h / 520);
  // 高通：0.5·原图 + 0.5·(1 − 模糊图) = 0.5 + (原图 − 模糊图)/2，中灰为不变
  copyInto(hp, S);
  hp.ctx.globalAlpha = 0.5;
  hp.ctx.filter = `blur(${r.toFixed(2)}px) invert(1)`;
  hp.ctx.drawImage(S.canvas, 0, 0, rc.w, rc.h);
  resetCtx(hp.ctx);
  const g = S.ctx;
  g.globalCompositeOperation = 'overlay';
  g.globalAlpha = Math.min(1, amount * 0.95);
  g.drawImage(hp.canvas, 0, 0, rc.w, rc.h);
  resetCtx(g);
  if (amount > 0.5) {
    // 强锐化时补一点局部对比，接近 USM 的观感
    g.globalCompositeOperation = 'soft-light';
    g.globalAlpha = (amount - 0.5) * 0.8;
    g.drawImage(hp.canvas, 0, 0, rc.w, rc.h);
    resetCtx(g);
  }
}

function fxGlow(S, amount, rc) {
  const low = rc.surfaces.get('glow1', 4);
  const low2 = rc.surfaces.get('glow2', 8);
  // 只留亮部：对比拉开后再压暗，中间调以下接近黑
  copyInto(low, S, `contrast(2.2) brightness(0.78) saturate(1.15) blur(${Math.max(1, low.height * 0.012).toFixed(2)}px)`);
  copyInto(low2, low, `blur(${Math.max(1, low2.height * 0.03).toFixed(2)}px)`);
  const g = S.ctx;
  g.globalCompositeOperation = 'screen';
  g.globalAlpha = Math.min(1, amount * 0.75);
  g.drawImage(low.canvas, 0, 0, rc.w, rc.h);
  g.globalAlpha = Math.min(1, amount * 0.6);
  g.drawImage(low2.canvas, 0, 0, rc.w, rc.h);
  resetCtx(g);
}

const CHANNELS = [['#ff0000', 2], ['#00ff00', 1], ['#0000ff', 0]];

function fxChromatic(S, amount, rc) {
  const { w, h } = rc;
  const d = amount * h * 0.009; // 画面边缘处的通道错位像素
  if (d < 0.3) return;
  const m = d / (w / 2);
  const tmp = rc.surfaces.get('ca1');
  const acc = rc.surfaces.get('ca2');
  acc.ctx.fillStyle = '#000000';
  acc.ctx.fillRect(0, 0, w, h);
  for (const [color, k] of CHANNELS) {
    copyInto(tmp, S);
    tmp.ctx.globalCompositeOperation = 'multiply';
    tmp.ctx.fillStyle = color;
    tmp.ctx.fillRect(0, 0, w, h);
    resetCtx(tmp.ctx);
    // 径向错位：红通道放大最多，蓝通道不动，像镜头的横向色差
    const s = 1 + m * k;
    acc.ctx.globalCompositeOperation = 'lighter';
    acc.ctx.drawImage(tmp.canvas, (w - w * s) / 2, (h - h * s) / 2, w * s, h * s);
  }
  resetCtx(acc.ctx);
  copyInto(S, acc);
}

function fxVhs(S, amount, rc) {
  const { w, h, frameIndex } = rc;
  const g = S.ctx;
  const u = Math.min(w, h);
  // 1. 色度拖尾：低分辨率、横向拉糊的副本只贡献色相饱和度
  const low = rc.surfaces.get('vhs1', 4);
  copyInto(low, S, `saturate(1.35) blur(${Math.max(0.6, low.height * 0.006).toFixed(2)}px)`);
  const shift = amount * w * 0.006;
  g.globalCompositeOperation = 'color';
  g.globalAlpha = Math.min(1, 0.75 * amount);
  g.drawImage(low.canvas, shift, 0, w, h);
  resetCtx(g);

  // 2. 横向抖动：按帧号确定哪几条横带错位
  const tmp = rc.surfaces.get('vhs2');
  copyInto(tmp, S);
  // 带数固定：mode 只能影响采样质量，不能改变画面内容（预览与导出必须一致）
  const bands = 18;
  const bh = Math.ceil(h / bands);
  const slow = Math.floor(frameIndex / 2);
  for (let b = 0; b < bands; b += 1) {
    const r = hash01(slow, b);
    if (r > 0.12 + amount * 0.22) continue;
    const off = (hash01(slow, b + 97) - 0.5) * amount * w * 0.018;
    g.drawImage(tmp.canvas, 0, b * bh, w, bh, off, b * bh, w, bh);
  }
  // 整体轻微水平漂移
  const sway = (hash01(Math.floor(frameIndex / 3), 7) - 0.5) * amount * w * 0.003;
  if (Math.abs(sway) > 0.3) {
    copyInto(tmp, S);
    g.drawImage(tmp.canvas, sway, 0, w, h);
  }

  // 3. 红色重影
  g.globalCompositeOperation = 'screen';
  g.globalAlpha = 0.16 * amount;
  g.filter = 'sepia(1) saturate(4) hue-rotate(-30deg)';
  g.drawImage(tmp.canvas, shift * 2.4, 0, w, h);
  resetCtx(g);

  // 4. 扫描线
  const pitch = Math.max(2, Math.round(h / 270));
  g.globalCompositeOperation = 'multiply';
  g.globalAlpha = Math.min(1, 0.55 * amount);
  g.fillStyle = patternFor(g, `scan${pitch}`, scanlineTexture(pitch));
  g.fillRect(0, 0, w, h);
  resetCtx(g);

  // 5. 底部跟踪噪声条
  const barH = Math.max(3, h * 0.028);
  const barY = h * (0.9 + 0.06 * hash01(Math.floor(frameIndex / 5), 3)) - barH;
  g.save();
  g.beginPath();
  g.rect(0, barY, w, barH);
  g.clip();
  g.globalCompositeOperation = 'screen';
  g.globalAlpha = Math.min(1, 0.85 * amount);
  const pat = patternFor(g, 'grain', grainTexture());
  // 纹理按画面高度等比缩放（以 1080 高为基准）：预览小画布和导出大画布上噪声条的相对大小一致
  const k = Math.max(0.05, h / 1080);
  g.translate(-hash01(frameIndex, 11) * 256 * k, barY - hash01(frameIndex, 12) * 256 * k);
  g.scale(3 * k, 0.6 * k);
  g.fillStyle = pat;
  g.fillRect(0, 0, w / (3 * k) + 512, barH / (0.6 * k) + 512);
  g.restore();
  g.fillStyle = `rgba(255,255,255,${0.12 * amount})`;
  g.fillRect(0, barY + barH * 0.4, w, Math.max(1, u * 0.002));

  // 6. 磁带的黑位：抬起并偏紫
  g.globalCompositeOperation = 'lighten';
  g.globalAlpha = 1;
  const lift = Math.round(22 * amount);
  g.fillStyle = `rgb(${lift},${Math.round(lift * 0.75)},${Math.round(lift * 1.1)})`;
  g.fillRect(0, 0, w, h);
  resetCtx(g);
}

function fxGrain(S, amount, rc) {
  const g = S.ctx;
  const { w, h, frameIndex } = rc;
  const pat = patternFor(g, 'grain', grainTexture());
  // 颗粒大小与画面高度等比（不设下限）：预览小画布上的颗粒和导出成片的相对大小一致
  const sc = Math.max(0.05, h / 760);
  g.save();
  g.globalCompositeOperation = 'overlay';
  g.globalAlpha = Math.min(1, amount * 0.6);
  // 每帧整体偏移纹理：确定性，同一帧导出两次结果完全相同
  const ox = Math.floor(hash01(frameIndex, 1) * 256);
  const oy = Math.floor(hash01(frameIndex, 2) * 256);
  g.translate(-ox * sc, -oy * sc);
  g.scale(sc, sc);
  g.fillStyle = pat;
  g.fillRect(0, 0, w / sc + 256, h / sc + 256);
  g.restore();
  resetCtx(g);
}

function fxLetterbox(S, amount, rc) {
  const { w, h } = rc;
  const natural = (h - w / 2.39) / 2;
  const bar = Math.min(Math.max(0, natural), h * 0.3) * amount;
  if (bar < 0.5) return;
  const g = S.ctx;
  g.fillStyle = '#000000';
  g.fillRect(0, 0, w, Math.round(bar));
  g.fillRect(0, h - Math.round(bar), w, Math.round(bar) + 1);
}

function fxFlash(S, amount, entry, rc) {
  const local = entry.progress * entry.duration;
  const len = Math.min(0.6, Math.max(0.05, entry.duration / 2));
  if (local >= len) return;
  const a = amount * (1 - easeOutCubic(local / len));
  if (a <= 0.002) return;
  const g = S.ctx;
  g.fillStyle = `rgba(255,255,255,${Math.min(1, a).toFixed(4)})`;
  g.fillRect(0, 0, rc.w, rc.h);
}

// ---------------- 单个镜头 ----------------

function renderClip(entry, rc, slot) {
  const { w, h, project, pool } = rc;
  const S = rc.surfaces.get(slot);
  const g = S.ctx;
  g.fillStyle = rc.bg;
  g.fillRect(0, 0, w, h);
  const clip = entry.clip || {};
  const assets = (project && project.assets) || {};
  const asset = clip.assetId ? assets[clip.assetId] : null;

  const localT = num(entry.progress) * num(entry.duration);
  const anim = animatedProps(clip, localT);
  entry.anim = anim;
  const preset = (clip.motion && clip.motion.preset) || 'none';
  const intensity = num(clip.motion && clip.motion.intensity, 0.5);
  const motion = motionTransform(preset, intensity, entry.progress, entry.duration);
  const tf = composeTransform(anim.transform, motion);
  const fx = fxOf(clip);
  const srcTime = srcTimeOf(clip, localT, entry.srcTime);

  let src = null;
  let sw = 0;
  let sh = 0;
  let hud = null;
  if (!asset) {
    if (slot === 'ovl') return null;
    drawPlaceholder(g, w, h, '素材缺失', '这个镜头引用的素材已被删除，请替换素材');
    return S;
  }
  if (asset.kind === 'previz') {
    const opts = { watermark: true, label: clip.label || '' };
    // 镜头自己设置了运镜时，预演内的虚拟摄影机保持静止，避免两套运镜叠加
    if (preset !== 'none') opts.movement = 'static';
    const pz = previzSource(rc, asset, entry, opts);
    src = pz.canvas;
    sw = w;
    sh = h;
    hud = { spec: pz.spec, prog: pz.prog, opts: { watermark: true, label: clip.label || '' } };
  } else if (asset.kind === 'audio') {
    if (slot === 'ovl') return null;
    drawPlaceholder(g, w, h, '音频素材没有画面', asset.name || '');
    return S;
  } else {
    try {
      src = pool && typeof pool.getFrame === 'function' ? pool.getFrame(asset, srcTime) : null;
    } catch {
      src = null;
    }
    if (src) {
      const size = sourceSize(src);
      sw = size.w;
      sh = size.h;
      if (!(sw > 0 && sh > 0)) src = null;
    }
    if (!src) {
      if (slot === 'ovl') return null;
      drawMediaWait(g, w, h, asset, rc);
      return S;
    }
  }

  const grade = effectiveColor(anim.color);
  if (slot !== 'ovl') drawCanvasBg(g, clip.canvas, src, sw, sh, rc);
  else g.clearRect(0, 0, w, h);
  drawSource(g, src, sw, sh, tf, primaryFilter(grade), fx.blur, w, h, { crop: clip.crop, fit: clip.fit || (slot === 'ovl' ? 'contain' : 'cover'), mirror: clip.mirror });
  if (slot === 'ovl' && needsToneOverlay(grade)) {
    // 透明画中画做全画幅色调叠加后，用原图层 alpha 做 destination-in，避免染色溢出到透明背景区域
    const alphaKeep = rc.surfaces.get('ovlAlpha');
    copyInto(alphaKeep, S);
    applyTone(g, grade, w, h, rc.surfaces.get('mask', 2));
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(alphaKeep.canvas, 0, 0, w, h);
    g.restore();
  } else {
    applyTone(g, grade, w, h, rc.surfaces.get('mask', 2));
  }
  if (fx.sharpen > 0.004) fxSharpen(S, fx.sharpen, rc);
  if (fx.glow > 0.004) fxGlow(S, fx.glow, rc);
  if (fx.chromatic > 0.004) fxChromatic(S, fx.chromatic, rc);
  if (fx.vhs > 0.004) fxVhs(S, fx.vhs, rc);
  if (fx.grain > 0.004) fxGrain(S, fx.grain, rc);
  if (fx.letterbox > 0.004) fxLetterbox(S, fx.letterbox, rc);
  if (fx.flash > 0.004) fxFlash(S, fx.flash, entry, rc);
  if (hud) drawPrevizHud(g, hud.spec, hud.prog, w, h, hud.opts);
  if (clip.mask) applyMask(S, clip.mask, rc);
  if (isPrevizSource(asset) && asset.kind !== 'previz') drawPrevizBadge(g, w, h);
  return S;
}

// ---------------- 画中画（overlays） ----------------

function overlayDuration(o) {
  if (typeof TL.clipDuration === 'function') {
    try {
      const d = TL.clipDuration(o);
      if (Number.isFinite(d) && d > 0) return d;
    } catch { /* 回退 */ }
  }
  const len = Math.max(0, num(o.out, num(o.in) + 3) - num(o.in));
  return o.still ? Math.max(0.1, num(o.duration, 3)) : len / Math.max(0.1, num(o.speed, 1) || 1);
}

/** 时刻 t 可见的画中画，按 track 升序（越大越靠上） */
export function visibleOverlays(project, t) {
  if (!project) return [];
  const stateTracks = (project.trackState && project.trackState.overlay) || {};
  const legacyTracks = (project.tracks && project.tracks.overlay) || {};
  const isTrackHidden = (track) => {
    const n = track || 1;
    if (typeof TL.trackFlags === 'function' && TL.trackFlags(project, 'overlay', n).hidden) return true;
    if (stateTracks[n] && stateTracks[n].hidden) return true;
    return !!(legacyTracks[n] && legacyTracks[n].hidden);
  };
  let list;
  if (typeof TL.overlaysAt === 'function') {
    try { list = TL.overlaysAt(project, t); } catch { list = null; }
  }
  if (!Array.isArray(list)) {
    list = (Array.isArray(project.overlays) ? project.overlays : []).filter((o) => {
      const s = num(o.start);
      return t >= s && t < s + overlayDuration(o);
    });
  }
  return list
    .map((x) => (x && x.overlay ? x.overlay : x))
    .filter((o) => o && !isTrackHidden(o.track))
    .sort((a, b) => num(a.track, 1) - num(b.track, 1));
}

/** 贴纸在 scale=1 时的大小：字形实际墨迹的长边 = 画面短边 × STICKER_BASE（TransformOverlay 共用，控制框与画面一致） */
export const STICKER_BASE = 0.22;
const STICKER_FONT = `"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",${FONT_SANS}`;
const GLYPH_PX = 100;
const glyphCache = new Map();
let measureCtx = null;

export function stickerGlyph(asset) {
  return (asset && (asset.glyph || String(asset.name || '').replace(/^贴纸\s*/, ''))) || '★';
}

/** 字形在 100px 字号下的墨迹包围盒（相对 textAlign=center、textBaseline=alphabetic 的绘制点） */
function glyphMetrics(glyph, ctx) {
  const hit = glyphCache.get(glyph);
  if (hit) return hit;
  let g = ctx || null;
  if (!g) {
    if (!measureCtx) {
      try {
        const c = makeCanvas(8, 8);
        measureCtx = c ? c.getContext('2d') : null;
      } catch { measureCtx = null; }
    }
    g = measureCtx;
  }
  // 量不到时（无画布环境）按字号的方块处理：中心在基线上方 0.35em
  let m = { w: GLYPH_PX, h: GLYPH_PX, cx: 0, cy: -GLYPH_PX * 0.35, measured: false };
  if (g && typeof g.measureText === 'function') {
    try {
      g.save();
      g.font = `${GLYPH_PX}px ${STICKER_FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'alphabetic';
      const r = g.measureText(glyph);
      g.restore();
      const left = num(r.actualBoundingBoxLeft);
      const right = num(r.actualBoundingBoxRight);
      const asc = num(r.actualBoundingBoxAscent);
      const desc = num(r.actualBoundingBoxDescent);
      if (left + right > 1 && asc + desc > 1) {
        m = { w: left + right, h: asc + desc, cx: (right - left) / 2, cy: (desc - asc) / 2, measured: true };
      }
    } catch { /* 用默认方块 */ }
  }
  if (m.measured || !ctx) glyphCache.set(glyph, m);
  return m;
}

/**
 * 贴纸在画面里的实际大小（像素，scale=1 时）：墨迹包围盒按长边 = 短边 × STICKER_BASE 归一化。
 * 画面尺寸 W×H 用预览/导出各自的画布尺寸，结果等比。
 */
export function stickerSize(asset, W, H) {
  const base = Math.min(num(W), num(H)) * STICKER_BASE;
  const m = glyphMetrics(stickerGlyph(asset));
  const k = base / Math.max(1e-3, Math.max(m.w, m.h));
  return { w: m.w * k, h: m.h * k };
}

/** 贴纸（asset.kind==='sticker'，glyph 字形）：按 transform（位置/缩放/旋转）与透明度绘制；形状类字形用 o.color 上色（默认白） */
function drawSticker(ctx, o, asset, rc, local) {
  const { w, h } = rc;
  const base = { scale: 1, x: 0, y: 0, rotation: 0, ...(o.transform || {}) };
  let anim = null;
  try { anim = animatedProps({ ...o, transform: base }, local); } catch { anim = null; }
  const tf = (anim && anim.transform) || base;
  const op = anim ? anim.opacity : clamp01(num(o.opacity, 1));
  if (op <= 0.001) return;
  const glyph = stickerGlyph(asset);
  const m = glyphMetrics(glyph, ctx);
  const s = Math.max(0.01, num(tf.scale, 1));
  // 字号 100px 量出墨迹盒，再整体缩放到 短边×STICKER_BASE×scale：不同字形（emoji / 几何形状）看起来一样大
  const target = Math.min(w, h) * STICKER_BASE * s;
  const k = target / Math.max(1e-3, Math.max(m.w, m.h));
  ctx.save();
  ctx.globalAlpha = op;
  ctx.globalCompositeOperation = blendOp(o.blend);
  ctx.translate(w / 2 + num(tf.x) * w, h / 2 + num(tf.y) * h);
  if (num(tf.rotation)) ctx.rotate(num(tf.rotation) * DEG);
  ctx.scale(k, k);
  ctx.font = `${GLYPH_PX}px ${STICKER_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  // 阴影参数不受变换矩阵影响，按最终像素尺寸给
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = target * 0.06;
  ctx.shadowOffsetY = target * 0.02;
  const color = (typeof o.color === 'string' && o.color) || (typeof asset.color === 'string' && asset.color) || '#ffffff';
  ctx.fillStyle = color;
  // 墨迹盒中心对准变换中心（控制框的中心）
  ctx.fillText(glyph, -m.cx, -m.cy);
  ctx.restore();
}

function drawOverlays(ctx, rc, t) {
  const list = visibleOverlays(rc.project, t);
  const assets = (rc.project && rc.project.assets) || {};
  for (const o of list) {
    const dur = overlayDuration(o);
    const local = Math.max(0, t - num(o.start));
    const sa = assets[o.assetId];
    if (o.kind === 'sticker' || (sa && sa.kind === 'sticker')) {
      if (sa) drawSticker(ctx, o, sa, rc, local);
      continue;
    }
    const clip = { ...o, transform: { scale: 0.42, x: 0.22, y: -0.2, ...(o.transform || {}) } };
    const entry = { clip, progress: dur > 0 ? Math.min(1, local / dur) : 0, duration: dur };
    entry.srcTime = srcTimeOf(clip, local);
    const S = renderClip(entry, rc, 'ovl');
    if (!S) continue;
    const op = entry.anim ? entry.anim.opacity : clamp01(num(o.opacity, 1));
    if (op <= 0.001) continue;
    ctx.save();
    ctx.globalAlpha = op;
    ctx.globalCompositeOperation = blendOp(o.blend);
    ctx.drawImage(S.canvas, 0, 0, rc.w, rc.h);
    ctx.restore();
  }
}

// ---------------- 转场图层 ----------------

function blurred(img, amount, rc, slot) {
  const r = amount * rc.h * 0.035;
  if (r < 0.6) return img;
  const div = r > 8 ? 4 : 2;
  const T = rc.surfaces.get(slot, div);
  T.ctx.drawImage(img, 0, 0, T.width, T.height);
  T.ctx.filter = `blur(${(r / div).toFixed(2)}px)`;
  T.ctx.drawImage(img, 0, 0, T.width, T.height);
  T.ctx.filter = 'none';
  return T.canvas;
}

/** 运动模糊：多次错位叠加取平均（第 i 次以 1/(i+1) 透明度覆盖 = 等权平均） */
function streaked(img, L, rc, slot) {
  const lx = L.streakX * rc.w;
  const ly = L.streakY * rc.h;
  const len = Math.hypot(lx, ly);
  if (len < 1) return img;
  const T = rc.surfaces.get(slot, 2);
  const maxTaps = rc.mode === 'export' ? 28 : 12;
  const taps = Math.max(3, Math.min(maxTaps, Math.ceil(len / 6)));
  const g = T.ctx;
  g.drawImage(img, 0, 0, T.width, T.height);
  for (let i = 0; i < taps; i += 1) {
    const k = taps === 1 ? 0 : i / (taps - 1) - 0.5;
    g.globalAlpha = 1 / (i + 2);
    g.drawImage(img, (k * lx) / 2, (k * ly) / 2, T.width, T.height);
  }
  g.globalAlpha = 1;
  return T.canvas;
}

/** 径向（变焦）模糊：围绕画面中心的多次缩放叠加 */
function radialBlurred(img, amount, rc, slot) {
  const T = rc.surfaces.get(slot, 2);
  const taps = rc.mode === 'export' ? 14 : 7;
  const spread = amount * 0.22;
  const g = T.ctx;
  const W = T.width;
  const H = T.height;
  g.drawImage(img, 0, 0, W, H);
  for (let i = 0; i < taps; i += 1) {
    const s = 1 + spread * (i / (taps - 1));
    g.globalAlpha = 1 / (i + 2);
    g.drawImage(img, (W - W * s) / 2, (H - H * s) / 2, W * s, H * s);
  }
  g.globalAlpha = 1;
  return T.canvas;
}

function placeTransformed(g, img, L, rc) {
  const { w, h } = rc;
  g.translate(w / 2 + L.x * w, h / 2 + L.y * h);
  if (L.rotation) g.rotate(L.rotation * DEG);
  const s = Math.max(0.01, L.scale);
  g.scale(s, s);
  if (L.tile && (s < 1 || L.rotation || L.x || L.y)) {
    // 镜像平铺补边：缩小或旋转时露出的空白由相邻镜像补满，接缝处像素连续
    for (let i = -1; i <= 1; i += 1) {
      for (let j = -1; j <= 1; j += 1) {
        g.save();
        g.translate(i * w, j * h);
        g.scale(i % 2 ? -1 : 1, j % 2 ? -1 : 1);
        g.drawImage(img, -w / 2, -h / 2, w, h);
        g.restore();
      }
    }
  } else {
    g.drawImage(img, -w / 2, -h / 2, w, h);
  }
}

function drawLayer(ctx, src, L, rc, composite, tag) {
  if (!L || L.alpha <= 0.001) return;
  let img = src.canvas;
  if (L.blur > 0.002) img = blurred(img, L.blur, rc, `tb${tag}`);
  if (L.streakX > 0.0005 || L.streakY > 0.0005) img = streaked(img, L, rc, `ts${tag}`);
  if (L.radial > 0.002) img = radialBlurred(img, L.radial, rc, `tr${tag}`);
  const { w, h } = rc;
  if (L.clip) {
    const T = rc.surfaces.get(`tc${tag}`);
    T.ctx.clearRect(0, 0, w, h);
    T.ctx.save();
    placeTransformed(T.ctx, img, L, rc);
    T.ctx.restore();
    const { edge, keep, feather } = L.clip;
    const a = (edge - feather / 2) * w;
    const b = (edge + feather / 2) * w;
    const grad = T.ctx.createLinearGradient(Math.min(a, b - 0.5), 0, Math.max(b, a + 0.5), 0);
    grad.addColorStop(0, keep === 'before' ? 'rgba(0,0,0,1)' : 'rgba(0,0,0,0)');
    grad.addColorStop(1, keep === 'before' ? 'rgba(0,0,0,0)' : 'rgba(0,0,0,1)');
    T.ctx.globalCompositeOperation = 'destination-in';
    T.ctx.fillStyle = grad;
    T.ctx.fillRect(0, 0, w, h);
    T.ctx.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.globalAlpha = Math.min(1, L.alpha);
    ctx.globalCompositeOperation = composite;
    ctx.drawImage(T.canvas, 0, 0, w, h);
    ctx.restore();
    return;
  }
  ctx.save();
  ctx.globalAlpha = Math.min(1, L.alpha);
  ctx.globalCompositeOperation = composite;
  placeTransformed(ctx, img, L, rc);
  ctx.restore();
}

function fillOverlay(ctx, overlay, rc) {
  if (!overlay || overlay.alpha <= 0.001) return;
  ctx.save();
  ctx.globalAlpha = Math.min(1, overlay.alpha);
  ctx.fillStyle = overlay.color;
  ctx.fillRect(0, 0, rc.w, rc.h);
  ctx.restore();
}

function drawMain(ctx, active, rc) {
  if (typeof TL.trackFlags === 'function' && TL.trackFlags(rc.project, 'video').hidden) return;
  const tr = active.transition;
  if (active.out && active.in && tr) {
    const st = transitionState(tr.type, tr.p);
    const outVisible = st.outgoing.alpha > 0.001;
    const inVisible = st.incoming.alpha > 0.001;
    const A = outVisible ? renderClip(active.out, rc, 'clipA') : null;
    const B = inVisible ? renderClip(active.in, rc, 'clipB') : null;
    const outOp = active.out.anim ? active.out.anim.opacity : 1;
    const inOp = active.in.anim ? active.in.anim.opacity : 1;
    const outLayer = outOp < 1 ? { ...st.outgoing, alpha: st.outgoing.alpha * outOp } : st.outgoing;
    const inLayer = inOp < 1 ? { ...st.incoming, alpha: st.incoming.alpha * inOp } : st.incoming;
    if (st.mix === 'add') {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, rc.w, rc.h);
      if (A) drawLayer(ctx, A, outLayer, rc, 'lighter', 'A');
      if (B) drawLayer(ctx, B, inLayer, rc, 'lighter', 'B');
    } else {
      if (A) drawLayer(ctx, A, outLayer, rc, 'source-over', 'A');
      if (B) drawLayer(ctx, B, inLayer, rc, 'source-over', 'B');
    }
    fillOverlay(ctx, st.overlay, rc);
    return;
  }
  const B = renderClip(active.in, rc, 'clipB');
  const anim = active.in.anim;
  const clipIn = active.in.clip || {};
  ctx.save();
  ctx.globalAlpha = anim ? anim.opacity : 1;
  ctx.globalCompositeOperation = blendOp(clipIn.blend);
  ctx.drawImage(B.canvas, 0, 0, rc.w, rc.h);
  ctx.restore();
  if (tr && !active.out) fillOverlay(ctx, introOverlay(tr.type, tr.p), rc);
}

// ---------------- 字幕 ----------------

function sameCaption(a, b) {
  return !!a && !!b && a.text === b.text && (a.style || 'subtitle') === (b.style || 'subtitle') && (a.position || 'bottom') === (b.position || 'bottom');
}

function drawCaptions(ctx, active, rc) {
  const capIn = active.in && active.in.clip && active.in.clip.caption;
  const capOut = active.out && active.out.clip && active.out.clip.caption;
  if (active.out && active.transition) {
    const p = active.transition.p;
    if (sameCaption(capOut, capIn)) {
      drawCaption(ctx, capIn, rc.w, rc.h, 0.5);
      return;
    }
    if (capOut && capOut.text) drawCaption(ctx, capOut, rc.w, rc.h, 0.5, { alpha: 1 - p });
    if (capIn && capIn.text) drawCaption(ctx, capIn, rc.w, rc.h, 0.5, { alpha: p });
    return;
  }
  if (capIn && capIn.text && active.in) {
    let alpha = 1;
    if (active.transition && !active.out) {
      const o = introOverlay(active.transition.type, active.transition.p);
      if (o) alpha = 1 - o.alpha;
    }
    drawCaption(ctx, capIn, rc.w, rc.h, active.in.progress, { alpha });
  }
}

// ---------------- 入口 ----------------

/**
 * 画一帧。
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx 目标画布上下文
 * @param {object} project 项目
 * @param {number} t 时间线时刻（秒）
 * @param {object} pool mediaPool（getFrame）
 * @param {{width:number,height:number,layout?:object[],mode?:'preview'|'export'}} opts
 */
export function renderFrame(ctx, project, t, pool, opts = {}) {
  if (!ctx) return;
  const w = Math.max(1, Math.round(num(opts.width) || (ctx.canvas && ctx.canvas.width) || 1));
  const h = Math.max(1, Math.round(num(opts.height) || (ctx.canvas && ctx.canvas.height) || 1));
  const settings = (project && project.settings) || {};
  const fps = num(settings.fps) > 0 ? num(settings.fps) : 30;
  const time = Math.max(0, num(t));
  const mode = opts.mode === 'export' ? 'export' : 'preview';
  // 噪声种子（VHS 抖动、跟踪条、颗粒）统一按「时间线时刻 × 工程帧率」推导：预览、导出（任意导出帧率）、封面同一时刻画面一致。
  // opts.frameIndex 已不再使用（旧调用方传了也忽略）
  const frameIndex = Math.round(time * fps + 1e-6);
  const bg = typeof settings.background === 'string' && settings.background ? settings.background : '#000000';

  ctx.save();
  resetCtx(ctx);
  try {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    if (!project) return;
    const layout = Array.isArray(opts.layout) ? opts.layout : layoutVideo(project);
    let active = activeAt(layout, time);
    if (!active.in && layout.length) {
      // 浮点误差落在末尾之外半帧以内时，仍显示最后一帧，避免导出最后一帧黑场
      const end = layout[layout.length - 1].end;
      if (time > end && time - end < 0.5 / fps + 1e-6) active = activeAt(layout, end);
    }
    const rc = { w, h, mode, frameIndex, fps, pool, project, bg, surfaces: surfacesFor(w, h) };
    const videoHidden = typeof TL.trackFlags === 'function' && TL.trackFlags(project, 'video').hidden;
    if (active.in && !videoHidden) {
      drawMain(ctx, active, rc);
      resetCtx(ctx);
    }
    drawOverlays(ctx, rc, time);
    resetCtx(ctx);
    // R2：镜头文案字幕已由初剪生成为文字轨 TextClip，这里只渲染文字轨，避免双份字幕
    if (active.in && opts.legacyCaptions && !videoHidden) drawCaptions(ctx, active, rc);
    resetCtx(ctx);
    const textHidden = typeof TL.trackFlags === 'function' && TL.trackFlags(project, 'text').hidden;
    if (!textHidden) {
      for (const item of textAt(project, time)) {
        drawTextClip(ctx, item.text, w, h, item.progress, item.local);
      }
    }
  } finally {
    ctx.restore();
  }
}

/**
 * 精确渲染某一时刻（暂停 / 拖动 / 跳到 0 秒时用）：先等媒体池把所有活动源 seek 到位，再画一帧。
 * 解决「未播放时首帧黑屏」：素材首次加载完成前 getFrame 返回空，这里等待后重画。
 */
export async function renderAt(ctx, project, t, pool, opts = {}) {
  if (pool && typeof pool.seekExact === 'function') {
    try {
      await pool.seekExact(project, t, opts.layout);
    } catch { /* 媒体错误由占位画面显示 */ }
  }
  renderFrame(ctx, project, t, pool, opts);
}

