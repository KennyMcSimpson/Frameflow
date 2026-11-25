// 预演共用的颜色 / 随机 / 绘图工具。
import { clamp01 } from '../motion.js';

export const TAU = Math.PI * 2;

// ---------------- 颜色工具 ----------------

const colorCache = new Map();

export function rgbOf(c) {
  let v = colorCache.get(c);
  if (v) return v;
  const s = String(c || '').trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    v = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  } else {
    m = /^#([0-9a-f]{3})$/i.exec(s);
    v = m ? [...m[1]].map((ch) => parseInt(ch + ch, 16)) : [128, 128, 128];
  }
  if (colorCache.size > 2048) colorCache.clear();
  colorCache.set(c, v);
  return v;
}

export const toHex = (r, g, b) => '#' + [r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');

export function mix(a, b, t) {
  const x = rgbOf(a);
  const y = rgbOf(b);
  const k = clamp01(t);
  return toHex(x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k);
}
export const lighten = (c, t) => mix(c, '#ffffff', t);
export const darken = (c, t) => mix(c, '#000000', t);

export function rgba(c, a) {
  const [r, g, b] = rgbOf(c);
  return `rgba(${r},${g},${b},${a})`;
}

export function luma(c) {
  const [r, g, b] = rgbOf(c);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function isHex(c) {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(c || '').trim());
}

// ---------------- 确定性随机 ----------------

export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function hash01(n, salt = 0) {
  let x = Math.imul((n | 0) ^ Math.imul(salt + 1, 0x9e3779b1), 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------- 绘图工具 ----------------

export function lin(g, x0, y0, x1, y1, stops) {
  const gr = g.createLinearGradient(x0, y0, x1, y1);
  stops.forEach(([o, c]) => gr.addColorStop(o, c));
  return gr;
}

export function rad(g, x, y, r0, r1, stops) {
  const gr = g.createRadialGradient(x, y, r0, x, y, r1);
  stops.forEach(([o, c]) => gr.addColorStop(o, c));
  return gr;
}

export function rect(g, x, y, w, h, fill) {
  g.fillStyle = fill;
  g.fillRect(x, y, w, h);
}

export function rrPath(g, x, y, w, h, r) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
}

export function rr(g, x, y, w, h, r, fill) {
  rrPath(g, x, y, w, h, r);
  g.fillStyle = fill;
  g.fill();
}

export function circle(g, x, y, r, fill) {
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.fillStyle = fill;
  g.fill();
}

export function ellipse(g, x, y, rx, ry, fill, rot = 0) {
  g.beginPath();
  g.ellipse(x, y, rx, ry, rot, 0, TAU);
  g.fillStyle = fill;
  g.fill();
}

export function poly(g, pts, fill) {
  g.beginPath();
  g.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
}

export function line(g, x0, y0, x1, y1, stroke, width) {
  g.strokeStyle = stroke;
  g.lineWidth = width;
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(x1, y1);
  g.stroke();
}

/** 软光晕：发光体周围的径向渐变 */
export function glow(g, x, y, r, color, alpha) {
  const op = g.globalCompositeOperation;
  g.globalCompositeOperation = 'screen';
  g.fillStyle = rad(g, x, y, 0, r, [[0, rgba(color, alpha)], [0.35, rgba(color, alpha * 0.42)], [1, rgba(color, 0)]]);
  g.fillRect(x - r, y - r, r * 2, r * 2);
  g.globalCompositeOperation = op;
}

export function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export const scratchPool = new Map();

export function scratch(slot, w, h) {
  let s = scratchPool.get(slot);
  if (!s) {
    const canvas = makeCanvas(w, h);
    s = { canvas, ctx: canvas.getContext('2d') };
    scratchPool.set(slot, s);
  }
  if (s.canvas.width !== w || s.canvas.height !== h) {
    s.canvas.width = w;
    s.canvas.height = h;
  } else {
    s.ctx.setTransform(1, 0, 0, 1, 0, 0);
    s.ctx.clearRect(0, 0, w, h);
  }
  return s;
}
