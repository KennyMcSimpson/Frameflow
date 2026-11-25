// 调色：look 预设（纯数据）+ effectiveColor（纯函数）+ 色调合成（Canvas2D）。
//
// 合成顺序与调色台一致：
//   一级校色（曝光/对比/饱和，ctx.filter，绘制源画面时一次完成）
//   → 白平衡（色温/色调） → 亮度分区（高光/阴影，用画面自身的亮度蒙版，只影响对应区域）
//   → 风格化（分离色调、整体染色、褪色黑位） → 暗角
//
// 分离色调的原理：screen 只抬升暗部（等于抬起该通道曲线的黑点），multiply 只压低亮部
// （等于压低该通道曲线的白点），两者合起来是对 R/G/B 三条曲线的真实调整，再用 soft-light
// 把色相带进中间调。这样高光偏橙、阴影偏青时，肤色和中间调不会被一层颜色蒙住。

import { clamp01 } from './motion.js';

function clampSigned(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < -1 ? -1 : n > 1 ? 1 : n;
}

export const LOOK_PRESETS = {
  none: { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0 },
  cinematic: { exposure: 0, contrast: 0.2, saturation: 0.02, temperature: 0.03, tint: 0, highlights: -0.12, shadows: -0.06, vignette: 0.16, splitShadow: '#0a5563', splitHighlight: '#ffbe80', fade: 0.02 },
  'film-warm': { exposure: 0.03, contrast: 0.1, saturation: -0.06, temperature: 0.22, tint: -0.03, highlights: -0.08, vignette: 0.1, splitShadow: '#402430', splitHighlight: '#ffdca8', fade: 0.12 },
  'film-cool': { exposure: 0, contrast: 0.1, saturation: -0.14, temperature: -0.2, tint: 0.05, highlights: -0.06, vignette: 0.1, splitShadow: '#0d2c42', splitHighlight: '#dcedff', fade: 0.1 },
  bw: { exposure: 0, contrast: 0.16, saturation: -1, temperature: 0, tint: 0 },
  noir: { exposure: -0.1, contrast: 0.42, saturation: -1, temperature: 0, tint: 0, highlights: 0.08, shadows: -0.34, vignette: 0.48, splitShadow: '#0a1218', fade: 0 },
  vintage: { exposure: 0.02, contrast: -0.1, saturation: -0.26, temperature: 0.18, tint: -0.04, vignette: 0.24, splitShadow: '#1f3f3a', splitHighlight: '#ffe2a6', wash: '#c9975a', washAmount: 0.12, fade: 0.26 },
  'cool-night': { exposure: -0.18, contrast: 0.16, saturation: -0.22, temperature: -0.46, tint: 0.05, highlights: -0.1, vignette: 0.3, splitShadow: '#081c40', splitHighlight: '#b4ceff', fade: 0.03 },
  vivid: { exposure: 0.03, contrast: 0.16, saturation: 0.45, temperature: 0.02, tint: 0 },
  'soft-pastel': { exposure: 0.12, contrast: -0.24, saturation: -0.18, temperature: 0.05, tint: -0.02, highlights: 0.05, shadows: 0.18, splitShadow: '#5b6b8c', splitHighlight: '#ffe9ef', fade: 0.2 },
  'high-contrast': { exposure: 0, contrast: 0.56, saturation: 0.1, temperature: 0, tint: 0, highlights: 0.14, shadows: -0.2 },
  moody: { exposure: -0.15, contrast: 0.24, saturation: -0.28, temperature: -0.06, tint: 0.02, highlights: -0.16, shadows: -0.1, vignette: 0.36, splitShadow: '#0e2432', splitHighlight: '#dcc8a4', fade: 0.05 },
  'golden-hour': { exposure: 0.05, contrast: 0.1, saturation: 0.18, temperature: 0.46, tint: -0.05, highlights: 0.06, vignette: 0.12, splitShadow: '#4c2517', splitHighlight: '#ffcf85', fade: 0.04 },
  cyberpunk: { exposure: -0.02, contrast: 0.26, saturation: 0.36, temperature: -0.2, tint: -0.36, vignette: 0.26, splitShadow: '#2c0a64', splitHighlight: '#6fe9ff', fade: 0.02 },
};

/**
 * 把 look × lookStrength 合并进用户参数，得到最终调色参数。
 * 用户滑杆和 look 相加：look 是一套基底，滑杆是在基底上的微调。
 */
export function effectiveColor(color) {
  const c = color || {};
  const look = LOOK_PRESETS[c.look] || LOOK_PRESETS.none;
  // 滤镜强度：lookStrength（旧字段）或 strength（v3），0 = 原片，1 = 完整滤镜
  const raw = Number(c.lookStrength ?? c.strength);
  const s = Number.isFinite(raw) ? clamp01(raw) : 1;
  const add = (key) => clampSigned((Number(c[key]) || 0) + (Number(look[key]) || 0) * s);
  return {
    exposure: add('exposure'),
    contrast: add('contrast'),
    saturation: add('saturation'),
    temperature: add('temperature'),
    tint: add('tint'),
    highlights: add('highlights'),
    shadows: add('shadows'),
    vignette: clamp01((Number(c.vignette) || 0) + (Number(look.vignette) || 0) * s),
    fade: clamp01((Number(look.fade) || 0) * s),
    splitShadow: look.splitShadow || null,
    splitHighlight: look.splitHighlight || null,
    splitStrength: look.splitShadow || look.splitHighlight ? s : 0,
    wash: look.wash || null,
    washAmount: clamp01((Number(look.washAmount) || 0) * s),
    look: LOOK_PRESETS[c.look] ? c.look : 'none',
    lookStrength: s,
  };
}

const EPS = 0.004;

/** 判断最终参数是否为「什么都不用做」，无调色的镜头走最快路径 */
export function isNeutral(g) {
  return Math.abs(g.exposure) < EPS && Math.abs(g.contrast) < EPS && Math.abs(g.saturation) < EPS && !needsToneOverlay(g);
}

export function needsToneOverlay(g) {
  return Math.abs(g.temperature) >= EPS || Math.abs(g.tint) >= EPS || Math.abs(g.highlights) >= EPS || Math.abs(g.shadows) >= EPS
    || g.vignette >= EPS || g.fade >= EPS || g.splitStrength >= EPS || g.washAmount >= EPS;
}

/** 一级校色：返回 ctx.filter 字符串（不含模糊）。'' 表示不需要滤镜 */
export function primaryFilter(g) {
  const parts = [];
  if (Math.abs(g.exposure) >= EPS) parts.push(`brightness(${(2 ** (g.exposure * 1.1)).toFixed(4)})`);
  if (Math.abs(g.contrast) >= EPS) parts.push(`contrast(${(g.contrast >= 0 ? 1 + g.contrast * 0.6 : 1 + g.contrast * 0.5).toFixed(4)})`);
  if (Math.abs(g.saturation) >= EPS) parts.push(`saturate(${Math.max(0, 1 + g.saturation).toFixed(4)})`);
  return parts.join(' ');
}

function hexRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const css = (r, g, b) => `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;

function fill(ctx, w, h, op, style, alpha) {
  if (alpha <= 0) return;
  ctx.globalCompositeOperation = op;
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.fillStyle = style;
  ctx.fillRect(0, 0, w, h);
}

function whiteBalance(ctx, g, w, h) {
  const t = g.temperature;
  if (Math.abs(t) >= EPS) {
    const a = Math.abs(t);
    fill(ctx, w, h, 'soft-light', t > 0 ? 'rgb(255,136,36)' : 'rgb(36,116,255)', a * 0.62);
    // soft-light 不改变纯白，补一层很淡的 multiply，让高光也跟着偏色，才像真正的白平衡
    fill(ctx, w, h, 'multiply', t > 0 ? 'rgb(255,236,212)' : 'rgb(214,232,255)', a * 0.55);
  }
  const n = g.tint;
  if (Math.abs(n) >= EPS) {
    fill(ctx, w, h, 'soft-light', n > 0 ? 'rgb(52,255,92)' : 'rgb(255,52,206)', Math.abs(n) * 0.46);
  }
}

// 亮度蒙版：先转灰，再把目标亮度段拉开。brightness(.75) contrast(3) ≈ 2.25x-1，
// 对亮部蒙版：亮度 0.44 以下为黑、0.89 以上为白；反相后得到暗部蒙版。
const MASK_HIGH = 'grayscale(1) brightness(0.75) contrast(3)';
const MASK_LOW = 'grayscale(1) invert(1) brightness(0.75) contrast(3)';

/**
 * 用画面自身亮度做蒙版。半分辨率足够：蒙版被放大时自带羽化，还省一半填充率。
 * @param {*} mask 工作画布 { canvas, ctx, width, height }
 */
function zoneAdjust(ctx, g, w, h, mask) {
  if (!mask) return;
  const drawMask = (filter) => {
    const m = mask.ctx;
    m.save();
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.globalCompositeOperation = 'copy';
    m.globalAlpha = 1;
    m.filter = filter;
    m.drawImage(ctx.canvas, 0, 0, mask.width, mask.height);
    m.restore();
  };
  const apply = (op, alpha) => {
    if (alpha <= 0) return;
    ctx.globalCompositeOperation = op;
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(mask.canvas, 0, 0, w, h);
  };
  const hi = g.highlights;
  if (Math.abs(hi) >= EPS) {
    if (hi > 0) {
      drawMask(MASK_HIGH);
      apply('screen', hi * 0.55);
    } else {
      // 压高光：用反相蒙版 multiply，亮区按比例变暗，暗区不动
      drawMask(`${MASK_HIGH} invert(1)`);
      apply('multiply', -hi * 0.72);
    }
  }
  const lo = g.shadows;
  if (Math.abs(lo) >= EPS) {
    if (lo > 0) {
      drawMask(MASK_LOW);
      apply('screen', lo * 0.5);
    } else {
      drawMask(`${MASK_LOW} invert(1)`);
      apply('multiply', -lo * 0.8);
    }
  }
}

function splitTone(ctx, g, w, h) {
  const s = g.splitStrength;
  if (s < EPS) return;
  if (g.splitShadow) {
    const [r, gg, b] = hexRgb(g.splitShadow);
    // 暗部染色：screen 抬起通道黑点。乘 0.62 防止黑位被抬得发灰
    fill(ctx, w, h, 'screen', css(r * 0.34, gg * 0.34, b * 0.34), s); // 暗部染色：只轻抬通道黑点，黑位保持深而带色相，不发灰
    // 同色 soft-light 把色相带进中低调，同时不再继续抬亮度
    fill(ctx, w, h, 'soft-light', css(r, gg, b), 0.26 * s);
  }
  if (g.splitHighlight) {
    const [r, gg, b] = hexRgb(g.splitHighlight);
    const k = 0.55 * s; // 向白色插值：只压低高光里与目标色相反的通道
    fill(ctx, w, h, 'multiply', css(255 + (r - 255) * k, 255 + (gg - 255) * k, 255 + (b - 255) * k), 1);
    fill(ctx, w, h, 'soft-light', css(r, gg, b), 0.34 * s);
  }
}

function fadeBlacks(ctx, g, w, h) {
  if (g.fade < EPS) return;
  // 胶片褪色：黑位抬起、白位略压，形成 matte 质感
  const lift = Math.round(g.fade * 74);
  fill(ctx, w, h, 'lighten', css(lift, lift, lift), 1);
  const cap = Math.round(255 - g.fade * 30);
  fill(ctx, w, h, 'darken', css(cap, cap, cap), 1);
}

/** 暗角：椭圆径向渐变 multiply，边缘压暗但不死黑 */
export function drawVignette(ctx, amount, w, h) {
  const a = clamp01(amount);
  if (a < EPS) return;
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = 1;
  ctx.translate(w / 2, h / 2);
  const ratio = w / h;
  ctx.scale(ratio, 1);
  const r = h * 0.5 * Math.SQRT2 * 1.02;
  const grad = ctx.createRadialGradient(0, 0, r * (0.62 - a * 0.26), 0, 0, r);
  const edge = Math.round(255 * (1 - a * 0.9));
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.55, css(255 - (255 - edge) * 0.32, 255 - (255 - edge) * 0.32, 255 - (255 - edge) * 0.32));
  grad.addColorStop(1, css(edge, edge, edge));
  ctx.fillStyle = grad;
  ctx.fillRect(-w / (2 * ratio) - 2, -h / 2 - 2, w / ratio + 4, h + 4);
  ctx.restore();
}

/**
 * 在已画好源画面的 ctx 上做除一级校色外的全部调色。
 * @param {CanvasRenderingContext2D} ctx 目标（工作画布，尺寸 w×h）
 * @param {object} g effectiveColor 的结果
 * @param {{canvas,ctx,width,height}} mask 半分辨率蒙版工作画布
 */
export function applyTone(ctx, g, w, h, mask) {
  if (!needsToneOverlay(g)) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'none';
  whiteBalance(ctx, g, w, h);
  zoneAdjust(ctx, g, w, h, mask);
  splitTone(ctx, g, w, h);
  if (g.wash && g.washAmount >= EPS) fill(ctx, w, h, 'color', g.wash, g.washAmount);
  fadeBlacks(ctx, g, w, h);
  ctx.restore();
  drawVignette(ctx, g.vignette, w, h);
}
