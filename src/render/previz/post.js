// 预演的「镜头后期」：大气透视、柔光光束、辉光、镜头光晕、调色、暗角、胶片颗粒。
// 全部是确定性的（噪声纹理用固定种子生成并缓存；颗粒位移由 progress 推导）。

import {
  TAU, mix, lighten, rgba, rgbOf, toHex, lin, rad, hash01, rng, makeCanvas, scratch,
} from './util.js';

const cache = new Map();
const lookCache = new Map();

/** 胶片颗粒：256² 灰度噪声，均值为中灰（overlay 混合时不改变整体亮度） */
function grainTile() {
  let c = cache.get('grain');
  if (c) return c;
  const N = 256;
  c = makeCanvas(N, N);
  const g = c.getContext('2d');
  const img = g.createImageData(N, N);
  const r = rng(0x5eed);
  for (let i = 0; i < N * N; i += 1) {
    // 两个均匀分布相加，近似高斯，颗粒更自然
    const v = 128 + ((r() + r() - 1) * 92);
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  cache.set('grain', c);
  return c;
}

/** 低频「笔触」纹理：小尺寸随机值放大后天然平滑，用来打破大色块的塑料感 */
function mottleTile() {
  let c = cache.get('mottle');
  if (c) return c;
  const w = 48;
  const h = 27;
  c = makeCanvas(w, h);
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  const r = rng(0xbeef);
  for (let i = 0; i < w * h; i += 1) {
    const v = 128 + (r() - 0.5) * 120;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // 第二层更细的噪声
  const fine = makeCanvas(w * 3, h * 3);
  const fg = fine.getContext('2d');
  const img2 = fg.createImageData(w * 3, h * 3);
  for (let i = 0; i < w * h * 9; i += 1) {
    const v = 128 + (r() - 0.5) * 70;
    img2.data[i * 4] = v;
    img2.data[i * 4 + 1] = v;
    img2.data[i * 4 + 2] = v;
    img2.data[i * 4 + 3] = 255;
  }
  fg.putImageData(img2, 0, 0);
  const out = makeCanvas(w * 6, h * 6);
  const og = out.getContext('2d');
  og.imageSmoothingEnabled = true;
  og.drawImage(c, 0, 0, w * 6, h * 6);
  og.globalAlpha = 0.5;
  og.drawImage(fine, 0, 0, w * 6, h * 6);
  cache.set('mottle', out);
  return out;
}

export function isIdentity(ctx) {
  if (typeof ctx.getTransform !== 'function') return false;
  const m = ctx.getTransform();
  return m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0;
}

/** 绘画质感：在背景上叠一层很轻的低频明暗起伏（soft-light），只为打破大色块，不能显脏 */
export function paintTexture(ctx, w, h, e, strength = 1) {
  const t = mottleTile();
  ctx.save();
  ctx.globalCompositeOperation = 'soft-light';
  ctx.globalAlpha = 0.1 * strength;
  const ox = (e.seed % 97) / 97;
  ctx.drawImage(t, -ox * w * 0.4, 0, w * 1.4, h);
  ctx.restore();
}

/** 大气透视：视平线附近一层空气散射，越远越接近天色 */
export function atmosphere(ctx, w, h, e, cam) {
  const hy = (cam.yh + cam.sy) * h;
  const haze = e.indoor ? mix(e.lit, e.paper, 0.4) : mix(e.tod.sky[2], e.key, 0.3);
  const a = e.indoor ? 0.1 : 0.2 + e.night * 0.05;
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const band = h * (e.indoor ? 0.5 : 0.36);
  ctx.fillStyle = lin(ctx, 0, hy - band, 0, hy + band * 0.6, [[0, rgba(haze, 0)], [0.6, rgba(haze, a)], [0.75, rgba(haze, a * 0.9)], [1, rgba(haze, 0)]]);
  ctx.fillRect(0, hy - band, w, band * 1.6);
  ctx.restore();
}

/**
 * 体积光（god rays）：在 1/8 分辨率上画若干条长楔形光束，放大回来后自然柔和。
 * src: 光源屏幕坐标（可在画外）；dir: 光束主方向（弧度）。
 */
export function godRays(ctx, w, h, e, src, dir, strength, p, spread = 0.42) {
  const k = 8;
  const sw = Math.max(8, Math.ceil(w / k));
  const sh = Math.max(8, Math.ceil(h / k));
  const S = scratch('rays', sw, sh);
  const g = S.ctx;
  g.setTransform(sw / w, 0, 0, sh / h, 0, 0);
  const len = Math.hypot(w, h) * 1.4;
  const n = 7;
  const key = lighten(e.key, 0.25);
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i += 1) {
    const a = dir + (i / (n - 1) - 0.5) * spread + (hash01(i, e.seed) - 0.5) * 0.05;
    const width = 0.018 + hash01(i, e.seed + 3) * 0.05;
    const flick = 0.75 + 0.25 * Math.sin(p * 3 + i * 1.7);
    const alpha = strength * (0.25 + hash01(i, e.seed + 7) * 0.75) * flick;
    const ex1 = src.x + Math.cos(a - width) * len;
    const ey1 = src.y + Math.sin(a - width) * len;
    const ex2 = src.x + Math.cos(a + width) * len;
    const ey2 = src.y + Math.sin(a + width) * len;
    g.fillStyle = lin(g, src.x, src.y, src.x + Math.cos(a) * len * 0.7, src.y + Math.sin(a) * len * 0.7, [[0, rgba(key, alpha)], [0.4, rgba(key, alpha * 0.45)], [1, rgba(key, 0)]]);
    g.beginPath();
    g.moveTo(src.x, src.y);
    g.lineTo(ex1, ey1);
    g.lineTo(ex2, ey2);
    g.closePath();
    g.fill();
  }
  g.globalCompositeOperation = 'source-over';
  // 在低分辨率上模糊（比全分辨率滤镜便宜得多），放大回来自然柔和
  let src0 = S.canvas;
  if ('filter' in g) {
    const B = scratch('raysB', sw, sh);
    B.ctx.filter = 'blur(1.2px)';
    B.ctx.drawImage(S.canvas, 0, 0);
    B.ctx.filter = 'none';
    src0 = B.canvas;
  }
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(src0, 0, 0, w, h);
  ctx.restore();
}

/** 辉光：亮部提取（低分辨率 + 对比度滤镜当阈值）→ 模糊 → screen 叠回 */
export function bloom(ctx, w, h, strength, tint) {
  if (!('filter' in ctx) || !isIdentity(ctx) || ctx.canvas.width < w || ctx.canvas.height < h) return;
  const sw = Math.max(8, Math.ceil(w / 6));
  const sh = Math.max(8, Math.ceil(h / 6));
  const A = scratch('bloomA', sw, sh);
  A.ctx.filter = 'brightness(0.62) contrast(2.6) saturate(1.2)';
  A.ctx.drawImage(ctx.canvas, 0, 0, w, h, 0, 0, sw, sh);
  A.ctx.filter = 'none';
  const B = scratch('bloomB', sw, sh);
  B.ctx.filter = `blur(${Math.max(1.5, sh * 0.03).toFixed(1)}px)`;
  B.ctx.drawImage(A.canvas, 0, 0);
  B.ctx.filter = 'none';
  if (tint) {
    B.ctx.globalCompositeOperation = 'multiply';
    B.ctx.fillStyle = tint;
    B.ctx.fillRect(0, 0, sw, sh);
    B.ctx.globalCompositeOperation = 'source-over';
  }
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = strength;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(B.canvas, 0, 0, w, h);
  ctx.restore();
}

/** 镜头光晕：主光斑 + 沿光心连线的鬼影 + 横向变形宽银幕拉丝 */
export function lensFlare(ctx, w, h, x, y, color, strength) {
  const u = Math.min(w, h);
  const cx = w / 2;
  const cy = h / 2;
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  // 主光斑
  ctx.fillStyle = rad(ctx, x, y, 0, u * 0.5, [[0, rgba(lighten(color, 0.7), 0.9 * strength)], [0.08, rgba(lighten(color, 0.4), 0.55 * strength)], [0.3, rgba(color, 0.16 * strength)], [1, rgba(color, 0)]]);
  ctx.fillRect(x - u * 0.5, y - u * 0.5, u, u);
  // 横向拉丝
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, 0.012);
  ctx.fillStyle = rad(ctx, 0, 0, 0, w * 0.55, [[0, rgba(lighten(color, 0.5), 0.55 * strength)], [0.4, rgba(mix(color, '#7fb4ff', 0.5), 0.18 * strength)], [1, 'rgba(0,0,0,0)']]);
  ctx.fillRect(-w * 0.55, -w * 0.55, w * 1.1, w * 1.1);
  ctx.restore();
  // 鬼影：很淡、边缘柔和（太实会像廉价贴纸）
  const ghosts = [[0.55, 0.06, '#ffcf8a', 0.05], [0.9, 0.025, '#8fd0ff', 0.06], [1.45, 0.1, '#ffd9a0', 0.035]];
  for (const [t, r, c, a] of ghosts) {
    const gx = x + (cx - x) * t * 2;
    const gy = y + (cy - y) * t * 2;
    const rr = u * r;
    ctx.fillStyle = rad(ctx, gx, gy, 0, rr, [[0, rgba(c, a * strength * 0.6)], [0.7, rgba(c, a * strength)], [1, rgba(c, 0)]]);
    ctx.beginPath();
    ctx.arc(gx, gy, rr, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

/** 把颜色缩放到指定亮度（保持色相与饱和度），用来从配色里取「暗部色」 */
function atLuma(c, target) {
  const [r, g, b] = rgbOf(c);
  const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (l < 0.004) return toHex(target * 255, target * 255, target * 255);
  const k = target / l;
  return toHex(r * k, g * k, b * k);
}

const chroma = (c) => {
  const [r, g, b] = rgbOf(c);
  return Math.max(r, g, b) - Math.min(r, g, b);
};

/**
 * 项目配色 → 一套统一的调色：暗部染底色、亮部染纸色、中间调带一点强调色。
 * 同一个项目的所有镜头用同一套 palette，所以整片色调一致；黑白类配色直接去色。
 */
export function paletteLook(e) {
  const key = `${e.base}|${e.accent}|${e.paper}|${e.night > 0.5 ? 1 : 0}`;
  let v = lookCache.get(key);
  if (v) return v;
  const gray = chroma(e.base) < 26 && chroma(e.accent) < 26 && chroma(e.paper) < 26;
  // 暗部：底色的色相，亮度很低（screen 只抬暗处，形成「不死黑」）
  const shadow = atLuma(mix(e.base, e.night > 0.5 ? '#1a2a48' : '#16303a', 0.25), e.night > 0.5 ? 0.05 : 0.04);
  // 亮部：纸色归一化到最亮通道 = 255，再往白色靠，直到最暗通道 ≥ 226（multiply 只轻微染色）
  const [pr, pg, pb] = rgbOf(e.paper);
  const m = Math.max(pr, pg, pb, 1);
  let hr = (pr / m) * 255;
  let hg = (pg / m) * 255;
  let hb = (pb / m) * 255;
  const mn = Math.min(hr, hg, hb);
  if (mn < 226) {
    const t = (226 - mn) / (255 - mn);
    hr += (255 - hr) * t;
    hg += (255 - hg) * t;
    hb += (255 - hb) * t;
  }
  v = {
    gray,
    shadow: gray ? '#0c0c0c' : shadow,
    high: gray ? '#f6f6f6' : toHex(hr, hg, hb),
    mid: gray ? '#808080' : atLuma(e.accent, 0.5),
    midA: gray ? 0 : 0.12,
    desat: gray ? 0.92 : 0,
  };
  if (lookCache.size > 64) lookCache.clear();
  lookCache.set(key, v);
  return v;
}

/**
 * 调色：按项目配色做分离色调（暗部底色、亮部纸色、中间调强调色），
 * 然后一层很轻的上下压暗、柔和暗角和细颗粒。
 */
export function grade(ctx, w, h, e, p, opts = {}) {
  const night = e.night;
  const look = paletteLook(e);
  ctx.save();
  // 暗部：抬黑位并染上底色（screen 对暗处作用大、对亮处几乎没有）
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = look.shadow;
  ctx.fillRect(0, 0, w, h);
  // 亮部：轻压高光并染上纸色（像胶片的高光肩部，不会死白）
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = look.high;
  ctx.fillRect(0, 0, w, h);
  // 中间调：一点点强调色
  if (look.midA > 0) {
    ctx.globalCompositeOperation = 'soft-light';
    ctx.fillStyle = rgba(look.mid, look.midA);
    ctx.fillRect(0, 0, w, h);
  }
  // 亮部偏向主光色温
  ctx.globalCompositeOperation = 'overlay';
  ctx.fillStyle = rgba(mix(e.key, '#ffb070', 0.4), night > 0.5 ? 0.04 : 0.06);
  ctx.fillRect(0, 0, w, h);
  // 黑白类配色：去色
  if (look.desat > 0) {
    ctx.globalCompositeOperation = 'saturation';
    ctx.globalAlpha = look.desat;
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  }
  // 上下轻微压暗，帮助视线落在画面中部
  ctx.globalCompositeOperation = 'soft-light';
  ctx.fillStyle = lin(ctx, 0, 0, 0, h, [[0, 'rgba(0,0,0,0.07)'], [0.35, 'rgba(128,128,128,0)'], [0.7, 'rgba(128,128,128,0)'], [1, 'rgba(0,0,0,0.1)']]);
  ctx.fillRect(0, 0, w, h);
  // 暗角（椭圆，柔和，偏下略重）
  ctx.globalCompositeOperation = 'multiply';
  const r = Math.hypot(w, h) * 0.6;
  ctx.save();
  ctx.translate(w / 2, h * 0.48);
  ctx.scale(w / Math.hypot(w, h) * 1.25, h / Math.hypot(w, h) * 1.25 * 1.15);
  const va = opts.vignette ?? (e.dramatic ? 0.48 : 0.3);
  ctx.fillStyle = rad(ctx, 0, 0, r * 0.42, r, [[0, 'rgba(255,255,255,1)'], [0.55, `rgba(${Math.round(255 - 90 * va)},${Math.round(255 - 88 * va)},${Math.round(255 - 80 * va)},1)`], [1, `rgba(${Math.round(255 - 200 * va)},${Math.round(255 - 198 * va)},${Math.round(255 - 188 * va)},1)`]]);
  ctx.fillRect(-r * 2, -r * 2, r * 4, r * 4);
  ctx.restore();
  ctx.restore();

  // 颗粒：细、轻，每帧不同偏移（由 progress 推导，确定性）
  const u = Math.min(w, h);
  if (u >= 90) {
    const t = grainTile();
    const frame = Math.floor(p * 240);
    const ox = Math.floor(hash01(frame, 21) * 256);
    const oy = Math.floor(hash01(frame, 22) * 256);
    const scale = Math.max(1, u / 900);
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = 0.055 + night * 0.035;
    const pat = ctx.createPattern(t, 'repeat');
    if (pat) {
      ctx.translate(-ox, -oy);
      ctx.scale(scale, scale);
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, (w + 512) / scale, (h + 512) / scale);
    }
    ctx.restore();
  }
}
