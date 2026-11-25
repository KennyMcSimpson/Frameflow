// AI 预演：把 PrevizSpec 画成像专业动态分镜（animatic）的画面。确定性：同样 spec + progress 得到同样画面。
//
// 虚拟摄影机是一个针孔模型：世界单位 = 主体平面上的 1 个画幅高；y 向下，y=0 是视平线（画面上的 yh）。
// 距离主体平面 Δ 的图层，缩放 Z(Δ) = 1 / (1/Z + Δ)。所有图层绕灭点 (中心, yh) 缩放，因此：
//  - 景别 = 摄影机到主体的距离，推近时前景变化快、远景变化慢，景深和视差是自然结果；
//  - 地面上的点永远落在视平线下方，近处更低；
//  - 俯拍 / 仰拍 = 摄影机离地高度变化，不需要变形画面。
//
// 绘制顺序：背景（天空 / 墙）→ 远景 → 地面 → 中景 → 承托面 + 主体 → 前景 → 光线 → 标注。

import { motionTransform, clamp01, easeInOut } from './motion.js';
import { SHOT_SIZE_LABELS, SHOT_MOVEMENT_LABELS, ANGLE_LABELS, PREVIZ_SETTINGS } from '../engine/model.js';

import {
  TAU, rgbOf, toHex, mix, lighten, darken, rgba, luma, isHex, hashStr, hash01, rng,
  lin, rad, rect, rrPath, rr, circle, ellipse, poly, line, glow, makeCanvas, scratch,
} from './previz/util.js';
import { drawLitFigure, PERSON_SKIN, PERSON_HAIR } from './previz/figure.js';
import { paintTexture, atmosphere, godRays, bloom, lensFlare, grade } from './previz/post.js';
const FONT = '"Microsoft YaHei UI","Microsoft YaHei","Segoe UI",sans-serif';
const DEFAULT_PALETTE = ['#2b2f3a', '#e0a96d', '#f4efe6'];
const PERSON_H = 0.72; // 全景时人物占画幅高
const FAR = 0.8;       // 远景层到主体平面的距离
const MID = 0.34;      // 中景层

function tiles(v, period, fn) {
  const a = Math.floor(v.x0 / period) - 1;
  const b = Math.ceil(v.x1 / period) + 1;
  if (b - a > 80) return;
  for (let k = a; k <= b; k += 1) fn(k, k * period);
}


/** 景深：把一组图层画到半分辨率缓冲，在半分辨率上模糊后再放大贴回（比全分辨率滤镜便宜约 4 倍） */
function depthGroup(ctx, slot, w, h, blurPx, opaque, draw) {
  if (blurPx < 0.7 || !('filter' in ctx)) {
    draw(ctx);
    return;
  }
  const sw = Math.max(2, Math.ceil(w / 2));
  const sh = Math.max(2, Math.ceil(h / 2));
  const s = scratch(slot, sw, sh);
  s.ctx.save();
  s.ctx.scale(sw / w, sh / h);
  draw(s.ctx);
  s.ctx.restore();
  const b = scratch(`${slot}Blur`, sw, sh);
  if (opaque) b.ctx.drawImage(s.canvas, 0, 0); // 先铺一层，防止模糊后边缘透出
  b.ctx.filter = `blur(${(blurPx * (sw / w)).toFixed(2)}px)`;
  b.ctx.drawImage(s.canvas, 0, 0);
  b.ctx.filter = 'none';
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(b.canvas, 0, 0, w, h);
  ctx.restore();
}

// ---------------- 规范化 ----------------

const TOD = {
  day: { sky: ['#6fa8dc', '#b9d6ec', '#e6eef2'], amb: [1, 1, 1], sun: '#fff4dc', night: 0 },
  golden: { sky: ['#6d6a9c', '#e88f5a', '#ffd79c'], amb: [1, 0.86, 0.68], sun: '#ffc070', night: 0.1 },
  blue: { sky: ['#101d42', '#2b4a86', '#7a8fbf'], amb: [0.46, 0.56, 0.82], sun: '#a8c0ff', night: 0.75 },
  night: { sky: ['#05070f', '#0d1430', '#1e2748'], amb: [0.26, 0.3, 0.46], sun: '#c0d0ff', night: 1 },
};

const KEY = { warm: '#ffb56b', cool: '#8fc0ff', neutral: '#fff1de' };

const INDOOR = new Set(['cafe', 'studio', 'office', 'home', 'kitchen', 'shop', 'gym']);
const GROUND_OBJECTS = new Set(['car']);

// 查表用的键只认普通字符串：'constructor' / '__proto__' 这类会命中原型链的名字一律当成不认识
const word = (v, d) => (typeof v === 'string' && v && !(v in Object.prototype) ? v : d);
const own = (table, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(table, k);
const okSize = (w, h) => Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0;

function normalizeSpec(spec) {
  const s = spec && typeof spec === 'object' ? spec : {};
  const pal = Array.isArray(s.palette) ? s.palette.filter(isHex) : [];
  const palette = [pal[0] || DEFAULT_PALETTE[0], pal[1] || DEFAULT_PALETTE[1], pal[2] || DEFAULT_PALETTE[2]];
  const subjects = (Array.isArray(s.subjects) ? s.subjects : []).filter((x) => x && typeof x === 'object').slice(0, 8).map((x, i) => ({
    kind: word(x.kind, 'person'),
    x: Number.isFinite(Number(x.x)) ? clamp01(x.x) : 0.5,
    y: Number.isFinite(Number(x.y)) ? clamp01(x.y) : 0.62,
    scale: Number.isFinite(Number(x.scale)) ? Math.min(2, Math.max(0.2, Number(x.scale))) : 1,
    color: isHex(x.color) ? x.color : palette[1],
    action: word(x.action, 'idle'),
    label: x.label ? String(x.label).slice(0, 24) : '',
    seed: i * 7 + hashStr(String(x.kind || '') + (x.label || '')) % 97,
  }));
  const camera = s.camera && typeof s.camera === 'object' ? s.camera : {};
  const light = s.light && typeof s.light === 'object' ? s.light : {};
  return {
    setting: PREVIZ_SETTINGS.includes(s.setting) ? s.setting : 'studio',
    timeOfDay: own(TOD, s.timeOfDay) ? s.timeOfDay : 'day',
    palette,
    subjects,
    camera: {
      shotSize: word(camera.shotSize, 'medium'),
      movement: word(camera.movement, 'static'),
      angle: word(camera.angle, 'eye-level'),
    },
    light: {
      direction: ['left', 'right', 'top', 'back', 'front'].includes(light.direction) ? light.direction : 'left',
      key: own(KEY, light.key) ? light.key : 'warm',
      mood: ['bright', 'soft', 'dramatic', 'night'].includes(light.mood) ? light.mood : 'soft',
    },
    overlayText: s.overlayText ? String(s.overlayText).slice(0, 40) : '',
  };
}

// ---------------- 摄影机 ----------------

const PERSON_FRAMING = {
  'extreme-wide': { zoom: 0.2, focus: 0.5, anchor: 0.64 },
  wide: { zoom: 0.4, focus: 0.5, anchor: 0.62 },
  full: { zoom: 1, focus: 0.5, anchor: 0.52 },
  medium: { zoom: 1.9, focus: 0.73, anchor: 0.5 },
  'medium-close': { zoom: 2.6, focus: 0.8, anchor: 0.5 },
  'close-up': { zoom: 4, focus: 0.885, anchor: 0.46 },
  'extreme-close-up': { zoom: 7, focus: 0.915, anchor: 0.47 },
  insert: { zoom: 3.2, focus: 0.56, anchor: 0.5 },
};

// 物体：frac = 物体占画幅高比例
const OBJECT_FRAMING = {
  'extreme-wide': 0.05, wide: 0.1, full: 0.26, medium: 0.42, 'medium-close': 0.55, 'close-up': 0.72, 'extreme-close-up': 1.3, insert: 0.86,
};

const OBJECT_BASE_H = 0.3;
const OBJECT_ASPECT_HEIGHT = { car: 0.3, laptop: 0.26, food: 0.2, phone: 0.34, cup: 0.26, box: 0.28, plant: 0.36, product: 0.34 };

function objectHeight(kind, scale, secondary) {
  const h = (OBJECT_ASPECT_HEIGHT[kind] || OBJECT_BASE_H) * scale;
  return secondary ? h * 0.42 : h;
}

function primaryOf(spec) {
  return spec.subjects.find((s) => s.kind !== 'text') || null;
}

/** 视线高度相对地面 / 承托面的选择决定了俯仰感 */
function groundHeight(angle, isPerson) {
  if (angle === 'high') return isPerson ? 1.2 : 0.3;
  if (angle === 'low') return isPerson ? 0.14 : 0.03;
  return isPerson ? 0.66 : 0.12;
}

function walkDir(action) {
  if (action === 'walk-left') return -1;
  if (action === 'walk-right') return 1;
  return 0;
}

/** 虚拟摄影机（纯函数）。shotSize / movement 可被 opts 覆盖 */
export function previzCamera(specIn, progress, wIn, hIn, optsIn = {}) {
  const opts = optsIn || {};
  const spec = normalizeSpec(specIn);
  const p = clamp01(progress);
  const shotSize = word(opts.shotSize, spec.camera.shotSize);
  const movement = word(opts.movement, spec.camera.movement);
  const angle = spec.camera.angle;
  const [w, h] = okSize(wIn, hIn) ? [wIn, hIn] : [16, 9];
  const A = w / h;
  const primary = primaryOf(spec);
  const isPerson = !primary || primary.kind === 'person';
  const isGround = primary && GROUND_OBJECTS.has(primary.kind);

  let zoom;
  let focusH; // 对焦点离地（承托面）高度，世界单位
  let anchor;
  let subjectH = PERSON_H;
  if (isPerson) {
    const f = PERSON_FRAMING[shotSize] || PERSON_FRAMING.medium;
    const sc = primary ? primary.scale : 1;
    subjectH = PERSON_H * sc;
    zoom = f.zoom / sc;
    focusH = subjectH * f.focus;
    anchor = f.anchor;
  } else {
    subjectH = objectHeight(primary.kind, primary.scale, false);
    const frac = OBJECT_FRAMING[shotSize] || OBJECT_FRAMING.medium;
    zoom = frac / subjectH;
    focusH = subjectH * (frac > 1 ? 0.62 : 0.5);
    anchor = frac > 1 ? 0.5 : 0.56;
  }

  let ground = groundHeight(angle, isPerson || isGround);
  if (angle === 'low') anchor -= isPerson ? 0.03 : 0.02;
  if (angle === 'high') anchor += 0.03;

  // 运镜
  const m = motionTransform(movement, 0.72, p, 4);
  let dolly = 1;
  let punch = 1;
  let sx = 0;
  let sy = 0;
  let Tx = 0;
  let rot = 0;
  switch (movement) {
    case 'push-in':
    case 'pull-out':
      dolly = 1 + (m.scale - 1) * 2.1;
      break;
    case 'zoom-punch':
      punch = m.scale;
      break;
    case 'pan-left':
    case 'pan-right':
    case 'tilt-up':
    case 'tilt-down':
      sx = m.x * 2.4;
      sy = m.y * 2.1;
      break;
    case 'shake':
    case 'handheld':
      sx = m.x * 1.1;
      sy = m.y * 1.1;
      rot = m.rotation;
      break;
    case 'drift':
      sx = m.x * 1.4;
      sy = m.y * 1.4;
      dolly = 1 + 0.04 * p;
      break;
    case 'orbit': {
      const o = Math.sin((p - 0.5) * 1.9) * 0.5;
      Tx = o / Math.max(1, zoom) * 1.4;
      sx = (Tx * zoom) / A;
      break;
    }
    default:
      break;
  }
  if (angle === 'dutch') rot += -7;
  if (angle === 'pov') {
    const hm = motionTransform('shake', 0.34, p, 4);
    sx += hm.x;
    sy += hm.y;
    rot += hm.rotation * 0.5;
  }

  const Z = zoom * dolly;
  const focusY = ground - focusH;
  const yh = anchor - focusY * Z;

  // 跟拍：摄影机横移跟上主体，主体相对画框不动，背景滚动
  let walkShift = 0;
  if (primary) {
    const dir = walkDir(primary.action);
    if (dir) walkShift = dir * (p - 0.5) * 0.62 * Math.min(1, 1 / Math.max(zoom, 0.4));
  }
  if (movement === 'tracking') Tx += walkShift || (p - 0.5) * 0.5 / Math.max(1, zoom);

  // 背景虚化：离主体越近、景别越紧，背景越糊
  const dof = clamp01((zoom - 1.05) / 3.2);
  const blurFar = h * 0.018 * dof;
  const blurMid = h * 0.011 * dof;

  return {
    A, Z, zoom, yh, ground, focusH, focusY, anchor, subjectH, sx, sy, Tx, rot, punch, angle, movement, shotSize, blurFar, blurMid, walkShift, isPerson,
    tableTop: isPerson || isGround ? ground - 0.31 : ground,
    zoomAt(delta) {
      const d = delta * Math.min(1, 1 / Z + 0.12);
      return 1 / Math.max(0.03, 1 / Z + d);
    },
  };
}

function withLayer(g, w, h, cam, delta, fn) {
  const Zl = cam.zoomAt(delta);
  const s = h * Zl;
  const ox = w / 2 + cam.sx * w;
  const oy = (cam.yh + cam.sy) * h;
  const pad = 0.3;
  const view = {
    x0: cam.Tx + (-ox) / s - pad / Zl,
    x1: cam.Tx + (w - ox) / s + pad / Zl,
    y0: -oy / s - pad / Zl,
    y1: (h - oy) / s + pad / Zl,
    Zl,
  };
  g.save();
  g.translate(ox, oy);
  g.scale(s, s);
  g.translate(-cam.Tx, 0);
  fn(view);
  g.restore();
}

function screenY(cam, y, delta, h) {
  return (cam.yh + cam.sy + y * cam.zoomAt(delta)) * h;
}

// ---------------- 环境 ----------------

function buildEnv(spec, cam, p) {
  const tod = TOD[spec.timeOfDay];
  const indoor = INDOOR.has(spec.setting);
  const moodGain = { bright: 1.06, soft: 1, dramatic: 0.66, night: 0.46 }[spec.light.mood];
  // 室内不完全跟随室外天色，只吸收一部分环境光
  const k = indoor ? 0.5 : 1;
  const amb = tod.amb.map((a) => (1 + (a - 1) * k) * moodGain);
  const night = Math.max(tod.night, spec.light.mood === 'night' ? 0.8 : 0);
  const tone = (c) => {
    const [r, g, b] = rgbOf(c);
    return toHex(r * amb[0], g * amb[1], b * amb[2]);
  };
  const key = mix(KEY[spec.light.key], tod.sun, indoor ? 0.1 : 0.35);
  const dir = spec.light.direction;
  return {
    spec,
    cam,
    p,
    G: cam.ground,
    tod,
    indoor,
    night,
    tone,
    key,
    keyX: dir === 'left' ? -1 : dir === 'right' ? 1 : 0,
    back: dir === 'back',
    dramatic: spec.light.mood === 'dramatic' || spec.light.mood === 'night',
    base: spec.palette[0],
    accent: spec.palette[1],
    paper: spec.palette[2],
    seed: hashStr(spec.setting + spec.timeOfDay),
    lit: mix('#ffcf8a', spec.palette[1], 0.25), // 灯光 / 窗灯颜色
  };
}

function skyFill(g, w, h, e, horizonPx) {
  const [a, b, c] = e.tod.sky;
  const hy = Math.max(h * 0.2, Math.min(h * 1.15, horizonPx));
  g.fillStyle = lin(g, 0, 0, 0, hy, [[0, a], [0.62, b], [1, c]]);
  g.fillRect(-w, -h, w * 3, h * 3);
}

// 窗外景色：窗格内的天光。夜里偏深，白天很亮（窗比墙亮才有室内感）
function windowPane(g, x, y, w, h, e) {
  const [a, b, c] = e.tod.sky;
  g.fillStyle = lin(g, 0, y, 0, y + h, [[0, lighten(a, e.night ? 0 : 0.35)], [0.7, lighten(b, e.night ? 0 : 0.4)], [1, lighten(c, e.night ? 0 : 0.45)]]);
  g.fillRect(x, y, w, h);
}

function drawWindow(g, x, y, w, h, e, cols = 2, rows = 3) {
  const frame = e.tone(darken(e.base, 0.25));
  rect(g, x - 0.025, y - 0.025, w + 0.05, h + 0.05, frame);
  windowPane(g, x, y, w, h, e);
  // 窗外虚影：对面楼 / 树
  g.fillStyle = rgba(e.night ? '#2a3350' : '#7f96a6', 0.35);
  g.fillRect(x, y + h * 0.62, w, h * 0.38);
  g.fillStyle = rgba(e.night ? '#39466a' : '#8fa7b0', 0.28);
  for (let i = 0; i < 4; i += 1) {
    const bw = w * (0.12 + hash01(i, 3) * 0.14);
    const bx = x + w * (i * 0.26 + hash01(i, 5) * 0.08);
    const bh = h * (0.2 + hash01(i, 8) * 0.34);
    if (bx + bw < x + w) g.fillRect(bx, y + h - bh, bw, bh);
  }
  const bar = Math.min(w, h) * 0.035;
  g.fillStyle = frame;
  for (let i = 1; i < cols; i += 1) g.fillRect(x + (w / cols) * i - bar / 2, y, bar, h);
  for (let i = 1; i < rows; i += 1) g.fillRect(x, y + (h / rows) * i - bar / 2, w, bar);
  // 窗下沿高光
  g.fillStyle = rgba('#ffffff', 0.12);
  g.fillRect(x - 0.025, y + h + 0.025, w + 0.05, 0.012);
}

function pendant(g, x, yTop, yLamp, e, shadeColor, scale = 1) {
  line(g, x, yTop, x, yLamp, e.tone(darken(e.base, 0.4)), 0.006);
  const s = 0.075 * scale;
  g.beginPath();
  g.moveTo(x - s * 0.22, yLamp);
  g.quadraticCurveTo(x - s, yLamp + s * 0.2, x - s * 1.1, yLamp + s * 0.82);
  g.lineTo(x + s * 1.1, yLamp + s * 0.82);
  g.quadraticCurveTo(x + s, yLamp + s * 0.2, x + s * 0.22, yLamp);
  g.closePath();
  g.fillStyle = shadeColor;
  g.fill();
  ellipse(g, x, yLamp + s * 0.82, s * 1.05, s * 0.13, lighten(e.lit, 0.4));
  glow(g, x, yLamp + s * 1.1, s * 6.4, e.lit, 0.34 + e.night * 0.22);
  // 灯下的光锥
  const cone = g.createLinearGradient(0, yLamp + s, 0, yLamp + s * 9);
  cone.addColorStop(0, rgba(e.lit, 0.14));
  cone.addColorStop(1, rgba(e.lit, 0));
  poly(g, [x - s, yLamp + s * 0.8, x + s, yLamp + s * 0.8, x + s * 4.8, yLamp + s * 9, x - s * 4.8, yLamp + s * 9], cone);
}

function drawPlant(g, x, y, s, e, seed) {
  const potH = 0.16 * s;
  const potW = 0.13 * s;
  const leaf = e.tone(mix('#3f7a52', e.base, 0.22));
  const leaf2 = e.tone(mix('#5a9a63', e.base, 0.12));
  const n = 9;
  for (let i = 0; i < n; i += 1) {
    const a = -Math.PI / 2 + (i / (n - 1) - 0.5) * 2.5 + (hash01(i, seed) - 0.5) * 0.24;
    const len = s * (0.3 + hash01(i, seed + 1) * 0.26);
    const tx = x + Math.cos(a) * len;
    const ty = y - potH + Math.sin(a) * len;
    const mx = x + Math.cos(a - 0.4) * len * 0.55;
    const my = y - potH + Math.sin(a - 0.4) * len * 0.55;
    g.beginPath();
    g.moveTo(x, y - potH);
    g.quadraticCurveTo(mx - 0.03 * s, my, tx, ty);
    g.quadraticCurveTo(mx + 0.05 * s, my + 0.04 * s, x, y - potH);
    g.fillStyle = i % 2 ? leaf : leaf2;
    g.fill();
  }
  const pot = e.tone(mix(e.paper, e.accent, 0.3));
  poly(g, [x - potW / 2, y - potH, x + potW / 2, y - potH, x + potW * 0.38, y, x - potW * 0.38, y], lin(g, x - potW / 2, 0, x + potW / 2, 0, [[0, lighten(pot, 0.1)], [1, darken(pot, 0.28)]]));
  rect(g, x - potW * 0.56, y - potH - 0.012 * s, potW * 1.12, 0.024 * s, lighten(pot, 0.05));
}

// ---------------- 自然景物：针叶树 / 阔叶树 / 灌木 / 小路 ----------------

/** 针叶树：一层层往上收窄的锯齿轮廓；背光一侧整体压暗，像真的有体积 */
function pineTree(g, x, G, hgt, wd, c, dark, shadeSide, trunk) {
  rect(g, x - wd * 0.09, G - hgt * 0.2, wd * 0.18, hgt * 0.2, trunk);
  const n = 5;
  const by = (i) => G - hgt * (0.1 + (0.82 * i) / n);
  const lw = (i) => wd * (1 - (0.8 * i) / n);
  const side = (sgn) => {
    const pts = [];
    for (let i = 0; i < n; i += 1) pts.push(x + sgn * lw(i), by(i), x + sgn * lw(i) * 0.32, by(i + 1) + hgt * 0.025);
    return pts;
  };
  const L = side(-1);
  const R = side(1);
  const bottom = by(0) - hgt * 0.02;
  g.fillStyle = c;
  g.beginPath();
  g.moveTo(x, G - hgt);
  for (let i = R.length - 2; i >= 0; i -= 2) g.lineTo(R[i], R[i + 1]);
  g.lineTo(x, bottom);
  for (let i = 0; i < L.length; i += 2) g.lineTo(L[i], L[i + 1]);
  g.closePath();
  g.fill();
  const S = shadeSide > 0 ? R : L;
  g.fillStyle = rgba(dark, 0.34);
  g.beginPath();
  g.moveTo(x, G - hgt);
  for (let i = S.length - 2; i >= 0; i -= 2) g.lineTo(S[i], S[i + 1]);
  g.lineTo(x, bottom);
  g.closePath();
  g.fill();
}

/** 一团叶子（树冠 / 灌木）：几个圆叠成不规则轮廓，受光侧上方亮、背光侧下方暗 */
function leafMass(g, blobs, cx, cy, r, c, dark, sunC, shadeSide) {
  g.save();
  g.beginPath();
  for (const [bx, byy, br] of blobs) {
    g.moveTo(bx + br, byy);
    g.arc(bx, byy, br, 0, TAU);
  }
  g.fillStyle = c;
  g.fill();
  g.clip();
  g.fillStyle = lin(g, cx - shadeSide * r * 1.1, cy - r * 1.1, cx + shadeSide * r * 0.9, cy + r * 1.1, [[0, rgba(sunC, 0.45)], [0.42, rgba(sunC, 0)], [0.58, rgba(dark, 0)], [1, rgba(dark, 0.5)]]);
  g.fillRect(cx - r * 2.5, cy - r * 2.5, r * 5, r * 5);
  g.restore();
}

/** 阔叶树：略收窄的树干 + 不规则树冠 */
function broadTree(g, x, G, hgt, r, c, dark, sunC, shadeSide, trunk, k) {
  const cy = G - hgt + r * 0.95;
  poly(g, [x - r * 0.13, G, x - r * 0.06, cy + r * 0.1, x + r * 0.06, cy + r * 0.1, x + r * 0.13, G], trunk);
  const blobs = [[x, cy - r * 0.12, r * 0.64]];
  for (let i = 0; i < 5; i += 1) {
    const a = (i / 5) * TAU + hash01(k, 40 + i) * 0.9;
    const d = r * (0.4 + hash01(k, 50 + i) * 0.24);
    blobs.push([x + Math.cos(a) * d * 1.15, cy + Math.sin(a) * d * 0.72, r * (0.46 + hash01(k, 60 + i) * 0.22)]);
  }
  leafMass(g, blobs, x, cy, r, c, dark, sunC, shadeSide);
}

/** 灌木：贴地的一丛，3–4 团大小不一 */
function bush(g, x, G, r, c, dark, sunC, shadeSide, k) {
  const n = 3 + Math.floor(hash01(k, 70) * 2);
  const blobs = [];
  for (let i = 0; i < n; i += 1) {
    const off = i - (n - 1) / 2;
    const br = r * (0.62 + hash01(k, 80 + i) * 0.45) * (1 - Math.abs(off) * 0.16);
    blobs.push([x + off * r * 0.85 + (hash01(k, 71 + i) - 0.5) * r * 0.35, G - br * 0.72, br]);
  }
  leafMass(g, blobs, x, G - r * 0.6, r, c, dark, sunC, shadeSide);
}

/**
 * 引导线：地面上一条有透视的小路（屏幕坐标绘制）。
 * 按屏幕行反求每一行对应的深度，再求小路在该深度的世界 x：近宽远窄、自然汇向远处。
 * 有人物时小路从人物脚下经过；没有人物时从画面下方一侧斜着伸向光源一侧（三分线附近）。
 */
function drawTrail(g, e, w, h, cam, colors) {
  const G = e.G;
  if (!(G > 0)) return;
  const hz = cam.yh + cam.sy;
  const yTop = screenY(cam, G, FAR, h);
  const yBot = h * 1.04;
  if (yTop >= h || yTop <= hz * h) return;
  const ox = w / 2 + cam.sx * w;
  const kk = Math.min(1, 1 / cam.Z + 0.12);
  const zAt = (y) => (y / h - hz) / G;
  const deltaAt = (y) => (1 / zAt(y) - 1 / cam.Z) / kk;
  const dMin = deltaAt(yBot);
  const dFar = FAR;
  const xf = (e.keyX || (hash01(e.seed, 33) < 0.5 ? -0.5 : 0.5)) * 0.9;
  const primary = primaryOf(e.spec);
  let pts;
  if (primary && primary.kind === 'person' && dMin < -0.05) {
    const xs = subjectWorldX(primary, cam, e.p);
    const xn = xs + (xs - xf) * (dMin / dFar) * 0.45;
    pts = [[dMin, xn], [0, xs], [dFar, xf]];
  } else {
    const zMin = zAt(yBot);
    const xn = cam.Tx + ((w * (xf > 0 ? 0.3 : 0.7)) - ox) / (zMin * h);
    const dm = (dMin + dFar) / 2;
    pts = [[dMin, xn], [dm, xn + (xf - xn) * 0.62], [dFar, xf]];
  }
  const [[a, xa], [b, xb], [c, xc]] = pts;
  const pathX = (d) => xa * ((d - b) * (d - c)) / ((a - b) * (a - c)) + xb * ((d - a) * (d - c)) / ((b - a) * (b - c)) + xc * ((d - a) * (d - b)) / ((c - a) * (c - b));
  const rows = 40;
  const strip = (half) => {
    const Lp = [];
    const Rp = [];
    for (let i = 0; i <= rows; i += 1) {
      const y = yTop + ((yBot - yTop) * i) / rows;
      const Zl = zAt(y);
      const xw = pathX(deltaAt(y));
      Lp.push(ox + (xw - half - cam.Tx) * Zl * h, y);
      Rp.push(ox + (xw + half - cam.Tx) * Zl * h, y);
    }
    g.beginPath();
    g.moveTo(Lp[0], Lp[1]);
    for (let i = 2; i < Lp.length; i += 2) g.lineTo(Lp[i], Lp[i + 1]);
    for (let i = Rp.length - 2; i >= 0; i -= 2) g.lineTo(Rp[i], Rp[i + 1]);
    g.closePath();
  };
  const hw = 0.15;
  strip(hw * 1.25);
  g.fillStyle = rgba(colors.rim, 0.5);
  g.fill();
  strip(hw);
  g.fillStyle = lin(g, 0, yTop, 0, h, [[0, colors.far], [1, colors.near]]);
  g.fill();
  strip(hw * 0.38);
  g.fillStyle = rgba(lighten(colors.near, 0.25), 0.16);
  g.fill();
}

// ---------------- 场景：每个函数返回 { backdrop, far, floor, mid, fg } ----------------

const SCENES = {
  cafe: {
    wall: (e) => e.tone(mix('#5a3c2a', e.base, 0.35)),
    floor: (e) => ({ far: e.tone(mix('#4a3122', e.base, 0.3)), near: e.tone(mix('#7a5236', e.base, 0.14)), lines: 'planks' }),
    surface: { top: '#8a5a3a', edge: '#4a2e1e', grain: true },
    far(g, e, v) {
      const wall = this.wall(e);
      const G = e.G;
      const top = G - 1.55;
      rect(g, v.x0 - 1, v.y0 - 2, v.x1 - v.x0 + 2, G - v.y0 + 2, lin(g, 0, top, 0, G, [[0, darken(wall, 0.4)], [0.6, wall], [1, darken(wall, 0.2)]]));
      tiles(v, 2.6, (k, x) => {
        const seed = k * 13 + 5;
        drawWindow(g, x - 1.0, G - 1.24, 0.94, 0.84, e, 3, 2);
        // 窗上遮阳字
        rect(g, x - 1.04, G - 1.32, 1.02, 0.05, e.tone(e.accent));
        // 菜单板
        const bx = x + 0.2;
        rect(g, bx - 0.02, G - 1.28, 0.54, 0.5, e.tone('#2a1a12'));
        rect(g, bx, G - 1.26, 0.5, 0.46, e.tone('#1c2622'));
        rect(g, bx + 0.05, G - 1.21, 0.24, 0.028, e.tone(lighten(e.paper, 0.1)));
        for (let i = 0; i < 6; i += 1) {
          const w = 0.2 + hash01(i, seed) * 0.16;
          rect(g, bx + 0.05, G - 1.155 + i * 0.05, w, 0.012, rgba(e.tone(e.paper), 0.6));
          rect(g, bx + 0.4, G - 1.155 + i * 0.05, 0.05, 0.012, rgba(e.tone(e.accent), 0.8));
        }
        // 层板 + 陶罐
        const sx = x + 0.86;
        for (let r = 0; r < 2; r += 1) {
          const sy = G - 1.0 + r * 0.26;
          rect(g, sx, sy, 0.62, 0.018, e.tone('#2e1c12'));
          for (let i = 0; i < 6; i += 1) {
            const jh = 0.07 + hash01(i + r * 7, seed) * 0.08;
            const jw = 0.05 + hash01(i + r * 3, seed + 1) * 0.03;
            const jx = sx + 0.03 + i * 0.1;
            const c = e.tone(mix(e.paper, i % 3 === 0 ? e.accent : '#8a6a4a', 0.45));
            rr(g, jx, sy - jh, jw, jh, 0.012, lin(g, jx, 0, jx + jw, 0, [[0, lighten(c, 0.14)], [1, darken(c, 0.24)]]));
          }
        }
      });
      // 木护墙
      rect(g, v.x0 - 1, G - 0.36, v.x1 - v.x0 + 2, 0.36, e.tone(darken(mix('#6a4630', e.base, 0.2), 0.12)));
      rect(g, v.x0 - 1, G - 0.37, v.x1 - v.x0 + 2, 0.014, e.tone('#2b1a10'));
      tiles(v, 0.26, (k, x) => rect(g, x, G - 0.355, 0.006, 0.355, rgba('#000000', 0.2)));
    },
    mid(g, e, v) {
      const G = e.G;
      const counterH = 0.5;
      tiles(v, 3.2, (k, x) => {
        const cx = x + 0.6;
        const seed = k * 7 + 2;
        const cw = 1.9;
        const body = e.tone(mix('#3a2418', e.base, 0.2));
        rect(g, cx - cw / 2, G - counterH, cw, counterH, lin(g, 0, G - counterH, 0, G, [[0, lighten(body, 0.08)], [1, darken(body, 0.3)]]));
        for (let i = 0; i < 8; i += 1) rect(g, cx - cw / 2 + i * (cw / 8) + 0.02, G - counterH + 0.08, cw / 8 - 0.04, counterH - 0.14, rgba('#000000', 0.12));
        const topC = e.tone(lighten(mix('#b48a64', e.paper, 0.3), 0.05));
        rect(g, cx - cw / 2 - 0.03, G - counterH - 0.035, cw + 0.06, 0.04, topC);
        rect(g, cx - cw / 2 - 0.03, G - counterH + 0.005, cw + 0.06, 0.012, rgba('#000000', 0.4));
        // 意式咖啡机
        const mx = cx - 0.42;
        const my = G - counterH - 0.035;
        const steel = e.tone('#b9bec4');
        const steelD = e.tone('#6f747a');
        rr(g, mx - 0.25, my - 0.34, 0.5, 0.1, 0.02, lin(g, 0, my - 0.34, 0, my - 0.24, [[0, lighten(steel, 0.25)], [1, steelD]]));
        rect(g, mx - 0.23, my - 0.24, 0.46, 0.17, e.tone(darken(e.accent, 0.35)));
        rect(g, mx - 0.25, my - 0.07, 0.5, 0.07, lin(g, 0, my - 0.07, 0, my, [[0, steel], [1, steelD]]));
        for (const dx of [-0.12, 0.12]) {
          rect(g, mx + dx - 0.035, my - 0.235, 0.07, 0.035, steelD);
          rect(g, mx + dx - 0.012, my - 0.2, 0.024, 0.05, steel);
          line(g, mx + dx - 0.03, my - 0.215, mx + dx - 0.11, my - 0.205, e.tone('#2a2a2a'), 0.012);
        }
        circle(g, mx, my - 0.29, 0.026, e.tone(lighten(e.paper, 0.1)));
        line(g, mx, my - 0.29, mx + 0.016, my - 0.302, e.tone('#c33'), 0.004);
        // 顶部杯架
        for (let i = 0; i < 5; i += 1) rr(g, mx - 0.2 + i * 0.085, my - 0.39, 0.06, 0.05, 0.012, e.tone(lighten(e.paper, 0.05)));
        // 磨豆机
        const gx = cx + 0.14;
        rr(g, gx - 0.06, my - 0.2, 0.12, 0.2, 0.014, e.tone('#2a2c30'));
        poly(g, [gx - 0.07, my - 0.34, gx + 0.07, my - 0.34, gx + 0.04, my - 0.2, gx - 0.04, my - 0.2], rgba(e.tone('#c8b49a'), 0.8));
        // 甜点柜
        const bx = cx + 0.34;
        rr(g, bx, my - 0.17, 0.5, 0.17, 0.01, rgba(e.tone('#cfe0e6'), 0.2));
        rect(g, bx, my - 0.09, 0.5, 0.008, rgba('#ffffff', 0.3));
        for (let i = 0; i < 5; i += 1) {
          const c = e.tone(mix('#d9a26a', e.accent, hash01(i, seed)));
          ellipse(g, bx + 0.06 + i * 0.095, my - 0.115, 0.034, 0.022, c);
          ellipse(g, bx + 0.06 + i * 0.095, my - 0.03, 0.034, 0.022, darken(c, 0.12));
        }
        glow(g, bx + 0.25, my - 0.08, 0.34, e.lit, 0.16);
      });
      tiles(v, 1.15, (k, x) => {
        pendant(g, x + 0.22, G - 2.2, G - 1.14 - hash01(k, 3) * 0.1, e, e.tone(darken(e.accent, 0.25)), 1.05);
      });
    },
  },

  street: {
    wall: (e) => e.tone('#6d7380'),
    floor: (e) => ({ far: e.tone('#696c73'), near: e.tone('#3c3f46'), lines: 'road' }),
    surface: { top: '#6a4d38', edge: '#32241a', grain: true },
    sky: true,
    far(g, e, v) {
      const G = e.G;
      // 远处楼群（大气透视：越远越接近天色）
      const hazeC = e.tod.sky[1];
      tiles(v, 0.46, (k, x) => {
        const hgt = 1.4 + hash01(k, 21) * 1.5;
        rect(g, x, G - hgt, 0.47, hgt, mix(e.tone(darken(e.base, 0.05)), hazeC, 0.62));
      });
      tiles(v, 1.12, (k, x) => {
        const hgt = 1.15 + hash01(k, 1) * 1.0;
        const c = e.tone(mix(['#8c7464', '#6d7a88', '#a08a78', '#5f6a78'][Math.abs(k) % 4], e.base, 0.22));
        const wd = 1.1;
        rect(g, x, G - hgt, wd, hgt, lin(g, x, 0, x + wd, 0, [[0, lighten(c, 0.08)], [1, darken(c, 0.2)]]));
        rect(g, x - 0.012, G - hgt - 0.02, wd + 0.024, 0.03, darken(c, 0.3));
        const cols = 5;
        const rows = Math.floor((hgt - 0.42) / 0.2);
        for (let r = 0; r < rows; r += 1) {
          for (let i = 0; i < cols; i += 1) {
            const on = hash01(k * 31 + r * 7 + i, 4) < 0.25 + e.night * 0.38;
            const wx = x + 0.085 + i * 0.195;
            const wy = G - hgt + 0.08 + r * 0.2;
            rect(g, wx, wy, 0.12, 0.13, on && e.night > 0.05 ? mix(e.lit, '#ffe9c2', hash01(i + r, k)) : mix(darken(c, 0.4), e.tod.sky[1], 0.34));
            if (!e.night) rect(g, wx, wy, 0.12, 0.04, rgba('#ffffff', 0.12));
          }
        }
        // 底商
        rect(g, x + 0.04, G - 0.34, wd - 0.08, 0.34, darken(c, 0.46));
        const shop = e.night > 0.2 ? mix(e.lit, '#ffe9c2', 0.4) : mix(e.tod.sky[2], '#c9d6dd', 0.5);
        rect(g, x + 0.08, G - 0.27, 0.56, 0.21, shop);
        rect(g, x + 0.72, G - 0.3, 0.2, 0.3, darken(c, 0.62));
        const aw = e.tone(Math.abs(k) % 2 ? e.accent : mix(e.accent, '#c94f4f', 0.6));
        poly(g, [x + 0.06, G - 0.33, x + 0.66, G - 0.33, x + 0.7, G - 0.26, x + 0.02, G - 0.26], aw);
        for (let i = 0; i < 6; i += 1) poly(g, [x + 0.04 + i * 0.114, G - 0.26, x + 0.1 + i * 0.114, G - 0.26, x + 0.09 + i * 0.114, G - 0.33, x + 0.06 + i * 0.114, G - 0.33], rgba('#ffffff', 0.16));
        if (e.night > 0.2) glow(g, x + 0.36, G - 0.14, 0.55, e.lit, 0.4);
      });
    },
    mid(g, e, v) {
      const G = e.G;
      tiles(v, 1.9, (k, x) => {
        const lx = x + 0.3;
        const pole = e.tone('#22262e');
        rect(g, lx - 0.008, G - 1.02, 0.016, 1.02, pole);
        rect(g, lx - 0.024, G - 0.07, 0.048, 0.07, pole);
        g.strokeStyle = pole;
        g.lineWidth = 0.012;
        g.beginPath();
        g.moveTo(lx, G - 1.02);
        g.quadraticCurveTo(lx + 0.02, G - 1.11, lx + 0.15, G - 1.1);
        g.stroke();
        rr(g, lx + 0.11, G - 1.115, 0.09, 0.026, 0.008, pole);
        const on = e.night > 0.1 || e.spec.timeOfDay === 'golden';
        if (on) {
          ellipse(g, lx + 0.155, G - 1.09, 0.036, 0.012, '#fff2d0');
          glow(g, lx + 0.155, G - 1.08, 0.52, e.lit, 0.34 + e.night * 0.3);
        }
        // 行道树
        const tx = x + 1.2;
        const tr = e.tone('#3a2c20');
        rect(g, tx - 0.016, G - 0.46, 0.032, 0.46, tr);
        const leaf = e.tone(mix('#3f6e4a', e.base, 0.25));
        for (let i = 0; i < 7; i += 1) {
          const a = (i / 7) * TAU;
          circle(g, tx + Math.cos(a) * 0.1, G - 0.62 + Math.sin(a) * 0.09, 0.1, i % 2 ? leaf : lighten(leaf, 0.08));
        }
        circle(g, tx, G - 0.64, 0.13, lighten(leaf, 0.12));
      });
    },
  },

  nature: {
    wall: (e) => e.tone('#7a8f6a'),
    floor: (e) => ({ far: e.tone('#6f8f4f'), near: e.tone('#37552f'), lines: 'none' }),
    surface: { top: '#7a6650', edge: '#3a2f24', grain: false },
    sky: true,
    far(g, e, v) {
      const G = e.G;
      const sunX = (e.keyX || 0.5) * 1.1;
      const sunY = e.spec.timeOfDay === 'golden' ? -0.05 : -0.55;
      if (e.night < 0.9) {
        glow(g, sunX, sunY, 1.5, e.tod.sun, 0.8);
        circle(g, sunX, sunY, 0.1, lighten(e.tod.sun, 0.5));
      } else {
        circle(g, sunX, -0.75, 0.07, '#e8ecf8');
        glow(g, sunX, -0.75, 0.5, '#9fb4e6', 0.3);
        tiles(v, 0.17, (k, x) => {
          const y = -0.2 - hash01(k, 3) * 1.3;
          circle(g, x + hash01(k, 8) * 0.1, y, 0.0035 + hash01(k, 9) * 0.0045, rgba('#ffffff', 0.5 + hash01(k, 5) * 0.4));
        });
      }
      // 云：每团大小不一，中间高两头低
      const cloud = rgba(mix(e.paper, e.tod.sky[2], 0.3), e.night ? 0.05 : 0.45);
      tiles(v, 1.4, (k, x) => {
        if (hash01(k, 12) < 0.3) return;
        const cy = -0.72 - hash01(k, 2) * 0.5;
        const dx = e.p * 0.05;
        const n = 3 + Math.floor(hash01(k, 13) * 4);
        for (let i = 0; i < n; i += 1) {
          const t = n > 1 ? i / (n - 1) : 0.5;
          const rx = 0.06 + 0.08 * Math.sin(Math.PI * t) + hash01(k * 7 + i, 14) * 0.04;
          ellipse(g, x + dx + i * 0.1, cy - Math.sin(Math.PI * t) * 0.022 + Math.sin(i * 1.7) * 0.008, rx, rx * 0.34, cloud);
        }
      });
      // 三层山脊：色调向天色收敛
      const ridges = [
        { base: -0.05, amp: 0.26, f: 0.9, c: mix(e.tone('#55708a'), e.tod.sky[2], 0.62) },
        { base: 0.08, amp: 0.2, f: 1.5, c: mix(e.tone('#3f5f60'), e.tod.sky[2], 0.36) },
        { base: 0.2, amp: 0.14, f: 2.3, c: mix(e.tone('#34523f'), e.tod.sky[2], 0.14) },
      ];
      ridges.forEach((r, i) => {
        g.beginPath();
        g.moveTo(v.x0 - 1, G + 1);
        const step = (v.x1 - v.x0 + 2) / 90;
        for (let x = v.x0 - 1; x <= v.x1 + 1; x += step) {
          const y = r.base - r.amp * (0.5 + 0.5 * Math.sin(x * r.f + i * 2.1)) * (0.6 + 0.4 * Math.sin(x * r.f * 2.6 + i)) - 0.02 * Math.sin(x * r.f * 7.1);
          g.lineTo(x, y);
        }
        g.lineTo(v.x1 + 1, G + 1);
        g.closePath();
        g.fillStyle = r.c;
        g.fill();
      });
      // 远处树线
      const treeC = e.tone('#2c4a34');
      tiles(v, 0.13, (k, x) => {
        const hgt = 0.14 + hash01(k, 3) * 0.16;
        const ty = G - 0.02;
        poly(g, [x, ty, x + 0.075, ty - hgt, x + 0.15, ty], mix(treeC, e.tod.sky[2], 0.14 + hash01(k, 6) * 0.08));
      });
    },
    mid(g, e, v) {
      const G = e.G;
      const sd = e.seed % 1009;
      const shadeSide = e.keyX < 0 ? 1 : -1; // 背光的一侧
      const trunk = e.tone('#3b2d22');
      const pineC = e.tone(mix('#33593b', e.accent, 0.06));
      const leafC = e.tone(mix('#5a8441', e.accent, 0.1));
      const bushC = e.tone(mix('#4a7639', e.base, 0.12));
      const dark = mix('#0b140f', e.base, 0.3);
      const sunC = lighten(mix(leafC, e.key, 0.5), 0.14);
      // 树成簇出现：密度沿横向缓慢起伏，一段是林子、一段是空地；两种树、大小不一
      tiles(v, 0.3, (k, x) => {
        const dens = 0.36 + 0.44 * Math.sin(k * 0.57 + sd);
        if (hash01(k, sd + 11) > dens) return;
        const tx = x + (hash01(k, 3) - 0.5) * 0.2;
        const s = 0.5 + hash01(k, 4) * 0.8;
        if (hash01(k, sd + 5) < 0.6) pineTree(g, tx, G, 0.6 * s + 0.14, 0.11 * s + 0.04, pineC, dark, shadeSide, trunk);
        else broadTree(g, tx, G, 0.5 * s + 0.12, 0.12 * s + 0.05, leafC, dark, sunC, shadeSide, trunk, k);
        if (hash01(k, sd + 7) < 0.55) bush(g, tx + (hash01(k, 9) - 0.3) * 0.25, G, 0.045 + hash01(k, 10) * 0.05, bushC, dark, sunC, shadeSide, k);
      });
    },
    ground(g, e, w, h, cam) {
      drawTrail(g, e, w, h, cam, {
        near: e.tone('#6e5f4a'),
        far: mix(mix(e.tone('#93826a'), e.tone('#6f8f4f'), 0.25), e.tod.sky[2], 0.22),
        rim: e.tone('#2c4226'),
      });
    },
    fg(g, e, v) {
      const G = e.G;
      g.lineCap = 'round';
      g.lineWidth = 0.006;
      // 一簇簇的草：位置、高矮、深浅都不同，不排成栅栏
      tiles(v, 0.075, (k, x) => {
        if (hash01(k, 21) > 0.5) return;
        const bx = x + hash01(k, 22) * 0.05;
        const by = G + 0.1 + hash01(k, 23) * 0.07;
        const hgt = 0.045 + hash01(k, 7) * 0.08;
        const sway = Math.sin(e.p * 5 + k) * 0.006;
        g.strokeStyle = e.tone(darken('#3b5f30', 0.12 + 0.32 * hash01(k, 8)));
        g.beginPath();
        for (let i = 0; i < 5; i += 1) {
          const a = (i - 2) * 0.28 + (hash01(k * 5 + i, 24) - 0.5) * 0.2;
          const bh = hgt * (0.55 + hash01(k * 5 + i, 25) * 0.45) * (1 - Math.abs(i - 2) * 0.12);
          g.moveTo(bx + (i - 2) * 0.004, by);
          g.quadraticCurveTo(bx + Math.sin(a) * bh * 0.3, by - bh * 0.6, bx + Math.sin(a) * bh + sway, by - Math.cos(a) * bh);
        }
        g.stroke();
      });
    },
  },

  studio: {
    wall: (e) => e.tone(mix(e.base, '#3a3f4c', 0.3)),
    floor: (e) => ({ far: e.tone(mix(e.base, '#555a68', 0.3)), near: e.tone(darken(e.base, 0.25)), lines: 'none', seamless: true }),
    surface: { top: '#3a3d48', edge: '#16181e', reflect: true, seamless: true },
    far(g, e, v) {
      const G = e.G;
      const wall = this.wall(e);
      rect(g, v.x0 - 1, v.y0 - 2, v.x1 - v.x0 + 2, G - v.y0 + 3, wall);
      // 无缝背景上的光斑（背景灯）：打在主体身后略偏上，中性偏暖，四周自然暗下去
      const spot = e.tone(mix(e.paper, e.accent, 0.3));
      const sy = ((e.cam.focusY - (e.cam.isPerson ? 0.22 : 0.06)) * e.cam.Z) / v.Zl;
      const r = 0.8 / v.Zl;
      g.fillStyle = rad(g, -e.keyX * 0.12, sy, 0, r, [[0, rgba(lighten(spot, 0.12), 0.5)], [0.4, rgba(spot, 0.2)], [1, rgba(spot, 0)]]);
      g.fillRect(-r * 1.2, sy - r * 1.2, r * 2.4, r * 2.4);
      // 灯架与柔光箱
      for (const side of [-1, 1]) {
        const lit = side === e.keyX || e.keyX === 0;
        const x = side * 1.5;
        const y = G - 1.28;
        const stand = e.tone('#17191e');
        rect(g, x - 0.009, y + 0.2, 0.018, G - y - 0.2, stand);
        line(g, x, G, x - 0.16, G + 0.02, stand, 0.014);
        line(g, x, G, x + 0.16, G + 0.02, stand, 0.014);
        line(g, x, G - 0.3, x, G, stand, 0.014);
        g.save();
        g.translate(x, y);
        g.rotate(side * 0.35);
        poly(g, [-0.3, -0.42, 0.3, -0.42, 0.11, -0.1, -0.11, -0.1], stand);
        rect(g, -0.34, -0.5, 0.68, 0.1, stand);
        const lampC = lit ? lighten(e.key, 0.55) : mix(e.tone('#d7dae0'), e.base, 0.5);
        rr(g, -0.32, -0.49, 0.64, 0.08, 0.01, lampC);
        g.restore();
        if (lit) glow(g, x, y - 0.3, 1.1, e.key, 0.42);
      }
    },
  },

  office: {
    wall: (e) => e.tone(mix('#c9cdd2', e.base, 0.25)),
    floor: (e) => ({ far: e.tone('#8d9096'), near: e.tone(mix('#55585f', e.base, 0.2)), lines: 'tile' }),
    surface: { top: '#c9b79e', edge: '#4f4436', grain: true },
    far(g, e, v) {
      const G = e.G;
      const wall = this.wall(e);
      rect(g, v.x0 - 1, v.y0 - 2, v.x1 - v.x0 + 2, G - v.y0 + 2, lin(g, 0, G - 1.6, 0, G, [[0, darken(wall, 0.18)], [1, wall]]));
      tiles(v, 3.4, (k, x) => {
        // 落地窗 + 城市
        const wx = x - 1.3;
        const ww = 2.0;
        const wy = G - 1.5;
        const wh = 1.42;
        windowPane(g, wx, wy, ww, wh, e);
        for (let i = 0; i < 14; i += 1) {
          const bw = 0.09 + hash01(i, 11 + k) * 0.11;
          const bh = 0.2 + hash01(i, 13 + k) * 0.5;
          const bx = wx + i * 0.145;
          if (bx + bw > wx + ww) continue;
          const c = mix(e.tone('#7c8da0'), e.tod.sky[1], 0.45 + hash01(i, 15) * 0.2);
          rect(g, bx, wy + wh - bh, bw, bh, c);
          if (e.night > 0.2) {
            for (let r = 0; r < 7; r += 1) if (hash01(i * 9 + r, 3) < 0.5) rect(g, bx + 0.012, wy + wh - bh + 0.03 + r * 0.06, bw - 0.024, 0.02, rgba(e.lit, 0.8));
          }
        }
        const frame = e.tone('#3c4048');
        for (let i = 0; i <= 5; i += 1) rect(g, wx + (ww / 5) * i - 0.009, wy, 0.018, wh, frame);
        rect(g, wx, wy + 0.42, ww, 0.016, frame);
        rect(g, wx, wy + wh - 0.01, ww, 0.05, frame);
        // 白板
        const bx = x + 0.9;
        rr(g, bx, G - 1.22, 0.92, 0.6, 0.012, e.tone('#f2f3f4'));
        rect(g, bx, G - 0.63, 0.92, 0.014, e.tone('#7c8087'));
        const bars = [0.22, 0.34, 0.28, 0.44, 0.38];
        bars.forEach((b, i) => rect(g, bx + 0.1 + i * 0.09, G - 0.72 - b, 0.06, b, rgba(e.tone(e.accent), 0.72)));
        line(g, bx + 0.6, G - 1.1, bx + 0.84, G - 1.1, rgba('#333', 0.4), 0.008);
        line(g, bx + 0.6, G - 1.04, bx + 0.8, G - 1.04, rgba('#333', 0.3), 0.008);
        line(g, bx + 0.6, G - 0.98, bx + 0.82, G - 0.98, rgba('#333', 0.3), 0.008);
      });
    },
    mid(g, e, v) {
      const G = e.G;
      tiles(v, 1.7, (k, x) => {
        const dx = x + 0.2;
        const top = e.tone('#d8d3c8');
        const leg = e.tone('#3c4048');
        rect(g, dx - 0.5, G - 0.34, 1.0, 0.03, top);
        rect(g, dx - 0.46, G - 0.31, 0.022, 0.31, leg);
        rect(g, dx + 0.44, G - 0.31, 0.022, 0.31, leg);
        rect(g, dx - 0.46, G - 0.2, 0.92, 0.012, rgba('#000', 0.26));
        // 显示器
        rr(g, dx - 0.2, G - 0.62, 0.4, 0.25, 0.008, e.tone('#16181d'));
        rect(g, dx - 0.185, G - 0.605, 0.37, 0.22, e.night > 0.2 ? mix('#2a3a5a', e.accent, 0.25) : e.tone(mix('#3e6d8f', e.accent, 0.2)));
        rect(g, dx - 0.15, G - 0.57, 0.14, 0.012, rgba('#fff', 0.6));
        for (let i = 0; i < 3; i += 1) rect(g, dx - 0.15, G - 0.54 + i * 0.03, 0.26 - i * 0.05, 0.008, rgba('#fff', 0.35));
        rect(g, dx - 0.016, G - 0.37, 0.032, 0.03, e.tone('#2a2c30'));
        rect(g, dx - 0.07, G - 0.345, 0.14, 0.01, e.tone('#2a2c30'));
        if (e.night > 0.2) glow(g, dx, G - 0.5, 0.5, '#7fb4ff', 0.2);
        // 椅子
        const chair = e.tone(mix('#2c3038', e.accent, 0.18));
        rr(g, dx - 0.12, G - 0.5, 0.24, 0.24, 0.04, chair);
        rect(g, dx - 0.13, G - 0.27, 0.26, 0.04, darken(chair, 0.2));
        rect(g, dx - 0.012, G - 0.23, 0.024, 0.16, leg);
        line(g, dx, G - 0.07, dx - 0.12, G - 0.01, leg, 0.016);
        line(g, dx, G - 0.07, dx + 0.12, G - 0.01, leg, 0.016);
        drawPlant(g, dx + 0.68, G, 0.8, e, k + 3);
      });
      tiles(v, 1.8, (k, x) => {
        rect(g, x + 0.1, G - 1.55, 0.9, 0.02, rgba('#fff', 0.92));
        glow(g, x + 0.55, G - 1.52, 0.8, '#fff6e6', 0.16);
      });
    },
  },

  home: {
    wall: (e) => e.tone(mix('#d8c6ae', e.base, 0.18)),
    floor: (e) => ({ far: e.tone('#8a6848'), near: e.tone('#55402e'), lines: 'planks' }),
    surface: { top: '#9a7a5a', edge: '#4c3a2a', grain: true },
    far(g, e, v) {
      const G = e.G;
      const wall = this.wall(e);
      rect(g, v.x0 - 1, v.y0 - 2, v.x1 - v.x0 + 2, G - v.y0 + 2, lin(g, 0, G - 1.7, 0, G, [[0, darken(wall, 0.24)], [1, wall]]));
      tiles(v, 3.1, (k, x) => {
        const wx = x - 0.95;
        drawWindow(g, wx, G - 1.42, 0.82, 1.02, e, 2, 3);
        const curtain = e.tone(mix(e.paper, e.accent, 0.3));
        for (const [cx, dir] of [[wx - 0.13, 1], [wx + 0.82, -1]]) {
          // 褶皱：靠窗一侧受光更亮，远离窗户逐渐变暗
          for (let i = 0; i < 5; i += 1) {
            const away = dir > 0 ? 4 - i : i;
            const fold = i % 2 ? curtain : darken(curtain, 0.1);
            rect(g, cx + i * 0.05 * 0.9, G - 1.52, 0.05, 1.44, darken(fold, away * 0.025));
          }
        }
        rect(g, wx - 0.2, G - 1.54, 1.22, 0.022, e.tone('#3a2c20'));
        // 挂画
        const fx = x + 0.28;
        const frames = [[0, -1.22, 0.42, 0.32], [0.5, -1.28, 0.28, 0.38], [0.08, -0.82, 0.3, 0.22], [0.46, -0.84, 0.32, 0.24]];
        frames.forEach(([ox, oy, fw, fh], i) => {
          rect(g, fx + ox, G + oy, fw, fh, e.tone('#2e241c'));
          rect(g, fx + ox + 0.014, G + oy + 0.014, fw - 0.028, fh - 0.028, e.tone(lighten(e.paper, 0.1)));
          const c = e.tone(mix(e.accent, e.base, i * 0.2));
          circle(g, fx + ox + fw / 2, G + oy + fh * 0.52, Math.min(fw, fh) * 0.24, c);
          rect(g, fx + ox + 0.014, G + oy + fh * 0.66, fw - 0.028, fh * 0.34 - 0.014, rgba(e.tone(e.base), 0.26));
        });
        // 书架
        const bx = x + 1.14;
        rect(g, bx, G - 1.42, 0.62, 1.42, e.tone('#4a3626'));
        for (let r = 0; r < 5; r += 1) {
          const sy = G - 1.38 + r * 0.28;
          rect(g, bx + 0.024, sy, 0.572, 0.25, e.tone('#2a1f16'));
          let cx = bx + 0.034;
          let i = 0;
          while (cx < bx + 0.55) {
            const bw = 0.022 + hash01(i + r * 11, 5) * 0.03;
            const bh = 0.13 + hash01(i + r * 7, 6) * 0.1;
            const c = e.tone(mix(['#8a4a3a', '#3f6070', '#c9a86a', '#5c6e4a', '#d8c6ae'][(i + r) % 5], e.accent, 0.15));
            rect(g, cx, sy + 0.25 - bh, bw, bh, c);
            cx += bw + 0.002;
            i += 1;
          }
        }
      });
      rect(g, v.x0 - 1, G - 0.06, v.x1 - v.x0 + 2, 0.06, e.tone(lighten(mix('#e8dfd0', e.base, 0.1), 0.1)));
    },
    mid(g, e, v) {
      const G = e.G;
      tiles(v, 3.1, (k, x) => {
        // 沙发
        const sx = x - 0.4;
        const c = e.tone(mix(e.accent, '#6f7a6a', 0.45));
        rr(g, sx - 0.68, G - 0.52, 1.36, 0.4, 0.07, lin(g, 0, G - 0.52, 0, G - 0.1, [[0, lighten(c, 0.08)], [1, darken(c, 0.14)]]));
        rr(g, sx - 0.78, G - 0.38, 0.2, 0.32, 0.06, darken(c, 0.08));
        rr(g, sx + 0.58, G - 0.38, 0.2, 0.32, 0.06, darken(c, 0.08));
        rr(g, sx - 0.6, G - 0.28, 0.58, 0.14, 0.04, lighten(c, 0.1));
        rr(g, sx + 0.02, G - 0.28, 0.58, 0.14, 0.04, lighten(c, 0.07));
        rr(g, sx - 0.42, G - 0.44, 0.22, 0.18, 0.04, e.tone(mix(e.paper, e.accent, 0.1)));
        rect(g, sx - 0.62, G - 0.08, 0.024, 0.08, e.tone('#2a1f16'));
        rect(g, sx + 0.6, G - 0.08, 0.024, 0.08, e.tone('#2a1f16'));
        // 落地灯
        const lx = sx + 1.05;
        rect(g, lx - 0.006, G - 0.98, 0.012, 0.98, e.tone('#1f1c1a'));
        ellipse(g, lx, G - 0.004, 0.08, 0.012, e.tone('#1f1c1a'));
        poly(g, [lx - 0.09, G - 1.13, lx + 0.09, G - 1.13, lx + 0.14, G - 0.95, lx - 0.14, G - 0.95], lighten(e.lit, 0.5));
        glow(g, lx, G - 1.0, 0.72, e.lit, 0.34 + e.night * 0.24);
        drawPlant(g, sx - 1.0, G, 1.15, e, k + 9);
      });
    },
    onFloor(g, e) {
      // 地毯：贴在地面，随透视压扁
      const c = e.tone(mix(e.paper, e.accent, 0.35));
      ellipse(g, 0, e.G, 1.1, 0.11, rgba(c, 0.5));
      ellipse(g, 0, e.G, 0.94, 0.09, rgba(darken(c, 0.14), 0.4));
    },
  },

  'night-city': {
    wall: (e) => e.tone('#141a2c'),
    floor: (e) => ({ far: '#141824', near: '#0a0c13', lines: 'wet' }),
    surface: { top: '#1c2130', edge: '#07090f', reflect: true },
    sky: true,
    forceNight: true,
    far(g, e, v) {
      const G = e.G;
      const neon = [e.accent, '#ff3d8b', '#35e4ff', '#ffb648', '#8a5bff'];
      // 远处楼群：被夜雾笼罩，窗灯稀疏、偏暗
      const farC = mix('#141c34', e.tod.sky[2], 0.22);
      tiles(v, 0.34, (k, x) => {
        const hgt = 2.0 + hash01(k, 17) * 1.5;
        rect(g, x, G - hgt, 0.35, hgt, farC);
        for (let r = 0; r < hgt / 0.09; r += 1) {
          if (hash01(k * 41 + r, 4) < 0.5) continue;
          for (let i = 0; i < 3; i += 1) {
            if (hash01(k * 37 + r * 3 + i, 2) < 0.3) rect(g, x + 0.04 + i * 0.1, G - hgt + 0.04 + r * 0.09, 0.05, 0.04, rgba(hash01(k + r, 1) < 0.75 ? '#ffd9a0' : '#9fd0ff', 0.26));
          }
        }
      });
      tiles(v, 0.92, (k, x) => {
        const hgt = 1.3 + hash01(k, 1) * 1.1;
        const wd = 0.86;
        const c = mix('#0e1220', '#1b2238', hash01(k, 7));
        rect(g, x, G - hgt, wd, hgt, c);
        // 窗灯按楼层成片亮着（有的整层黑着），暖色为主、少量冷色
        const rows = Math.floor(hgt / 0.095);
        for (let r = 0; r < rows; r += 1) {
          if (hash01(k * 29 + r, 6) < 0.45) continue;
          for (let i = 0; i < 7; i += 1) {
            if (hash01(k * 53 + r * 11 + i, 3) < 0.48) {
              const lit = mix(hash01(k * 3 + i, r) < 0.78 ? '#ffc27a' : '#8fd0ff', neon[Math.abs(k) % neon.length], 0.12);
              rect(g, x + 0.05 + i * 0.112, G - hgt + 0.05 + r * 0.095, 0.075, 0.055, rgba(lit, 0.45 + hash01(r, i) * 0.3));
            }
          }
        }
        // 竖向霓虹招牌
        const sc = neon[Math.abs(k * 3 + 1) % neon.length];
        const nx = x + 0.05 + hash01(k, 9) * (wd - 0.24);
        const ny = G - 0.96 - hash01(k, 11) * 0.3;
        const flicker = 0.8 + 0.2 * Math.sin(e.p * 40 + k * 2.3);
        rr(g, nx, ny, 0.13, 0.5, 0.02, '#0a0c14');
        g.strokeStyle = rgba(sc, flicker);
        g.lineWidth = 0.008;
        rrPath(g, nx + 0.014, ny + 0.014, 0.102, 0.472, 0.016);
        g.stroke();
        for (let i = 0; i < 4; i += 1) rect(g, nx + 0.036, ny + 0.05 + i * 0.105, 0.058, 0.06, rgba(sc, 0.82 * flicker));
        glow(g, nx + 0.065, ny + 0.25, 0.6, sc, 0.36 * flicker);
        // 底商灯箱
        const shop = neon[Math.abs(k * 5 + 2) % neon.length];
        rect(g, x + 0.06, G - 0.28, wd - 0.12, 0.24, rgba(mix(shop, '#ffe2bf', 0.5), 0.78));
        rect(g, x + 0.06, G - 0.34, wd - 0.12, 0.05, shop);
        glow(g, x + wd / 2, G - 0.2, 0.6, shop, 0.34);
      });
    },
    onFloorWet(g, e, w, h, cam) {
      // 湿路面：灯牌、灯箱、路灯在地上拉出柔和渐隐的竖向倒影，位置对准真实光源
      const yTop = screenY(cam, e.G, FAR, h);
      if (yTop >= h) return;
      const neon = [e.accent, '#ff3d8b', '#35e4ff', '#ffb648', '#8a5bff'];
      const ox = w / 2 + cam.sx * w;
      const streak = (sx, y0, c, rw, len, a) => {
        if (sx < -rw || sx > w + rw || len <= 0) return;
        g.save();
        g.translate(sx, y0);
        g.scale(1, len / rw);
        g.fillStyle = rad(g, 0, 0, 0, rw, [[0, rgba(c, a)], [0.35, rgba(c, a * 0.42)], [1, rgba(c, 0)]]);
        g.fillRect(-rw, 0, rw * 2, rw);
        g.restore();
      };
      g.save();
      g.globalCompositeOperation = 'screen';
      const sf = cam.zoomAt(FAR) * h;
      const run = h * 1.1 - yTop;
      const a0 = Math.floor((cam.Tx - ox / sf) / 0.92) - 1;
      const a1 = Math.min(a0 + 40, Math.ceil((cam.Tx + (w - ox) / sf) / 0.92) + 1);
      for (let k = a0; k <= a1; k += 1) {
        const x = k * 0.92;
        const nx = x + 0.05 + hash01(k, 9) * (0.86 - 0.24) + 0.065;
        streak(ox + (nx - cam.Tx) * sf, yTop, neon[Math.abs(k * 3 + 1) % neon.length], sf * 0.06, run * 0.95, 0.3);
        streak(ox + (x + 0.43 - cam.Tx) * sf, yTop, neon[Math.abs(k * 5 + 2) % neon.length], sf * 0.32, run * 0.5, 0.16);
      }
      const sm = cam.zoomAt(MID) * h;
      const yLamp = screenY(cam, e.G, MID, h);
      const b0 = Math.floor((cam.Tx - ox / sm) / 2.2) - 1;
      const b1 = Math.min(b0 + 40, Math.ceil((cam.Tx + (w - ox) / sm) / 2.2) + 1);
      for (let k = b0; k <= b1; k += 1) streak(ox + (k * 2.2 + 0.46 - cam.Tx) * sm, yLamp, '#ffcf8a', sm * 0.05, h * 1.1 - yLamp, 0.26);
      g.restore();
    },
    mid(g, e, v) {
      const G = e.G;
      tiles(v, 2.2, (k, x) => {
        const lx = x + 0.3;
        rect(g, lx - 0.008, G - 1.12, 0.016, 1.12, '#07090f');
        rect(g, lx - 0.006, G - 1.12, 0.17, 0.012, '#07090f');
        ellipse(g, lx + 0.16, G - 1.1, 0.032, 0.01, '#fff0d0');
        glow(g, lx + 0.16, G - 1.08, 0.46, '#ffcf8a', 0.42);
      });
    },
  },

  beach: {
    wall: (e) => e.tone('#7ab8d0'),
    floor: (e) => ({ far: e.tone('#e4d0a4'), near: e.tone('#c7a97a'), lines: 'none', shore: true }),
    surface: { top: '#c9a878', edge: '#7c6444', grain: false },
    sky: true,
    far(g, e, v) {
      const G = e.G;
      const sunX = (e.keyX || 0.4) * 1.0;
      const sunY = e.spec.timeOfDay === 'golden' ? -0.06 : -0.62;
      glow(g, sunX, sunY, 1.5, e.tod.sun, 0.75);
      if (e.night < 0.9) circle(g, sunX, sunY, 0.11, lighten(e.tod.sun, 0.45));
      const cloud = rgba(lighten(e.tod.sky[2], 0.3), e.night ? 0.05 : 0.42);
      tiles(v, 1.7, (k, x) => {
        const cy = -0.5 - hash01(k, 2) * 0.5;
        for (let i = 0; i < 5; i += 1) ellipse(g, x + e.p * 0.04 + i * 0.13, cy + Math.sin(i * 1.3) * 0.02, 0.16, 0.03, cloud);
      });
      // 海面
      const sea = e.tone(mix('#2f86a8', e.base, 0.12));
      const far = mix(sea, e.tod.sky[2], 0.48);
      rect(g, v.x0 - 1, 0, v.x1 - v.x0 + 2, G + 2, lin(g, 0, 0, 0, G, [[0, far], [1, lighten(sea, 0.18)]]));
      // 太阳在海面的碎光
      for (let i = 0; i < 26; i += 1) {
        const yy = (i / 26) ** 1.5 * G;
        const ww = 0.05 + (i / 26) * 0.28 + hash01(i, 4) * 0.09;
        const ph = Math.sin(e.p * 8 + i * 1.7) * 0.03;
        ellipse(g, sunX + ph, yy + 0.008, ww, 0.0045 + i * 0.0003, rgba(lighten(e.tod.sun, 0.3), 0.55 - i * 0.012));
      }
      // 浪线
      for (let r = 0; r < 7; r += 1) {
        const yy = G * (0.16 + r * 0.13);
        g.strokeStyle = rgba('#ffffff', 0.08 + r * 0.03);
        g.lineWidth = 0.005 + r * 0.0012;
        g.beginPath();
        for (let x = v.x0; x <= v.x1; x += 0.08) {
          const y = yy + Math.sin(x * 3 + e.p * 2.4 + r) * 0.006;
          if (x === v.x0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.stroke();
      }
    },
    mid(g, e, v) {
      const G = e.G;
      tiles(v, 3.4, (k, x) => {
        const px = x + 1.1;
        const trunk = e.tone('#5a4230');
        g.strokeStyle = trunk;
        g.lineCap = 'round';
        g.lineWidth = 0.04;
        g.beginPath();
        g.moveTo(px, G);
        g.quadraticCurveTo(px + 0.1, G - 0.62, px + 0.3, G - 1.1);
        g.stroke();
        const leaf = e.tone('#2f6a46');
        for (let i = 0; i < 8; i += 1) {
          const a = (i / 8) * TAU + Math.sin(e.p * 4 + i) * 0.04;
          const lx = px + 0.3 + Math.cos(a) * 0.46;
          const ly = G - 1.1 + Math.sin(a) * 0.2 + 0.1;
          g.beginPath();
          g.moveTo(px + 0.3, G - 1.1);
          g.quadraticCurveTo(px + 0.3 + Math.cos(a) * 0.26, G - 1.2 + Math.sin(a) * 0.14, lx, ly);
          g.quadraticCurveTo(px + 0.3 + Math.cos(a) * 0.2, G - 1.1 + Math.sin(a) * 0.1, px + 0.3, G - 1.1);
          g.fillStyle = i % 2 ? leaf : lighten(leaf, 0.12);
          g.fill();
        }
        // 太阳伞
        const ux = x - 0.4;
        line(g, ux, G, ux + 0.05, G - 0.6, e.tone('#6b5a48'), 0.012);
        const c = e.tone(e.accent);
        g.beginPath();
        g.moveTo(ux - 0.34, G - 0.54);
        g.quadraticCurveTo(ux + 0.05, G - 0.86, ux + 0.42, G - 0.52);
        g.closePath();
        g.fillStyle = c;
        g.fill();
        g.beginPath();
        g.moveTo(ux - 0.12, G - 0.59);
        g.quadraticCurveTo(ux + 0.05, G - 0.86, ux + 0.2, G - 0.58);
        g.closePath();
        g.fillStyle = e.tone(e.paper);
        g.fill();
      });
    },
  },

  kitchen: {
    wall: (e) => e.tone(mix('#e4ded2', e.base, 0.14)),
    floor: (e) => ({ far: e.tone('#a59a88'), near: e.tone('#6b6252'), lines: 'tile' }),
    surface: { top: '#e6e2da', edge: '#7b7570', marble: true },
    far(g, e, v) {
      const G = e.G;
      const wall = this.wall(e);
      rect(g, v.x0 - 1, v.y0 - 2, v.x1 - v.x0 + 2, G - v.y0 + 2, wall);
      // 地铁砖
      const tile = rgba('#000000', 0.07);
      const y0 = G - 1.06;
      for (let r = 0; r < 14; r += 1) {
        const y = y0 + r * 0.05;
        rect(g, v.x0 - 1, y, v.x1 - v.x0 + 2, 0.004, tile);
        tiles(v, 0.14, (k, x) => rect(g, x + (r % 2) * 0.07, y, 0.004, 0.05, tile));
      }
      const cab = e.tone(mix('#6f8077', e.accent, 0.12));
      tiles(v, 2.9, (k, x) => {
        const cx = x - 1.3;
        // 吊柜
        rect(g, cx, G - 1.6, 1.34, 0.56, lin(g, 0, G - 1.6, 0, G - 1.04, [[0, darken(cab, 0.14)], [1, cab]]));
        for (let i = 0; i < 4; i += 1) {
          rect(g, cx + 0.02 + i * 0.335, G - 1.58, 0.295, 0.52, lighten(cab, 0.05));
          rect(g, cx + 0.05 + i * 0.335, G - 1.55, 0.235, 0.46, rgba('#000', 0.08));
          rect(g, cx + 0.15 + i * 0.335, G - 1.09, 0.04, 0.01, e.tone('#c9b78a'));
        }
        // 油烟机
        const hx = x + 0.48;
        poly(g, [hx - 0.1, G - 1.7, hx + 0.1, G - 1.7, hx + 0.1, G - 1.26, hx + 0.36, G - 1.08, hx - 0.36, G - 1.08, hx - 0.1, G - 1.26], lin(g, hx - 0.3, 0, hx + 0.3, 0, [[0, e.tone('#d8dadc')], [0.5, e.tone('#a9adb1')], [1, e.tone('#7e8387')]]));
        rect(g, hx - 0.36, G - 1.08, 0.72, 0.02, e.tone('#60656a'));
        glow(g, hx, G - 0.98, 0.52, e.lit, 0.26);
        // 挂杆 + 厨具
        const rx = x + 0.98;
        rect(g, rx, G - 0.88, 0.62, 0.01, e.tone('#7c6a50'));
        for (let i = 0; i < 5; i += 1) {
          const ux = rx + 0.05 + i * 0.13;
          line(g, ux, G - 0.88, ux, G - 0.78, e.tone('#4a4034'), 0.005);
          if (i % 2) ellipse(g, ux, G - 0.72, 0.04, 0.06, e.tone('#2d2d2f'));
          else { rect(g, ux - 0.008, G - 0.78, 0.016, 0.14, e.tone('#a9adb1')); circle(g, ux, G - 0.63, 0.024, e.tone('#a9adb1')); }
        }
      });
      // 操作台 + 底柜
      rect(g, v.x0 - 1, G - 0.46, v.x1 - v.x0 + 2, 0.46, lin(g, 0, G - 0.46, 0, G, [[0, cab], [1, darken(cab, 0.24)]]));
      rect(g, v.x0 - 1, G - 0.5, v.x1 - v.x0 + 2, 0.04, e.tone('#e8e4dc'));
      tiles(v, 0.42, (k, x) => {
        rect(g, x, G - 0.44, 0.006, 0.44, rgba('#000', 0.22));
        rect(g, x + 0.17, G - 0.4, 0.07, 0.008, e.tone('#c9b78a'));
      });
      tiles(v, 1.5, (k, x) => {
        // 台面小物
        const seed = k * 3;
        rr(g, x + 0.1, G - 0.62, 0.11, 0.12, 0.02, e.tone(mix(e.paper, e.accent, hash01(seed, 1))));
        rr(g, x + 0.24, G - 0.6, 0.08, 0.1, 0.018, e.tone(mix('#b6a48a', e.accent, 0.2)));
        drawPlant(g, x + 0.46, G - 0.5, 0.42, e, seed + 1);
      });
    },
    mid(g, e, v) {
      const G = e.G;
      tiles(v, 3.2, (k, x) => {
        pendant(g, x + 1.3, G - 2.2, G - 1.3, e, e.tone('#2d3336'), 1.1);
        pendant(g, x + 1.74, G - 2.2, G - 1.3, e, e.tone('#2d3336'), 1.1);
      });
    },
  },

  shop: {
    wall: (e) => e.tone(mix('#efe8dc', e.base, 0.14)),
    floor: (e) => ({ far: e.tone('#b9ad9a'), near: e.tone('#786d5c'), lines: 'tile' }),
    surface: { top: '#b89a78', edge: '#544232', grain: true },
    far(g, e, v) {
      const G = e.G;
      const wall = this.wall(e);
      rect(g, v.x0 - 1, v.y0 - 2, v.x1 - v.x0 + 2, G - v.y0 + 2, lin(g, 0, G - 1.7, 0, G, [[0, darken(wall, 0.12)], [1, wall]]));
      tiles(v, 1.5, (k, x) => {
        const wx = x + 0.04;
        const wood = e.tone('#7c5b40');
        rect(g, wx, G - 1.5, 1.42, 1.5, e.tone('#3a2c20'));
        for (let r = 0; r < 5; r += 1) {
          const sy = G - 1.46 + r * 0.29;
          rect(g, wx + 0.03, sy, 1.36, 0.26, e.tone(mix('#584838', e.base, 0.2)));
          glow(g, wx + 0.7, sy + 0.01, 0.55, e.lit, 0.14);
          rect(g, wx + 0.03, sy + 0.26, 1.36, 0.024, wood);
          let cx = wx + 0.05;
          let i = 0;
          while (cx < wx + 1.3) {
            const seed = k * 37 + r * 11 + i;
            const bw = 0.08 + hash01(seed, 1) * 0.07;
            const bh = 0.12 + hash01(seed, 2) * 0.11;
            const base = ['#d6b28a', '#c96a50', '#6f8fa6', '#e8dcc4', '#7f9a7a', '#b08ac0'][seed % 6 < 0 ? 0 : Math.abs(seed) % 6];
            const c = e.tone(mix(base, e.accent, 0.22));
            if (hash01(seed, 3) < 0.5) {
              rr(g, cx, sy + 0.26 - bh, bw, bh, 0.008, lin(g, cx, 0, cx + bw, 0, [[0, lighten(c, 0.16)], [1, darken(c, 0.2)]]));
              rect(g, cx + 0.012, sy + 0.26 - bh * 0.62, bw - 0.024, bh * 0.28, rgba('#fff', 0.5));
            } else {
              rr(g, cx + bw * 0.28, sy + 0.26 - bh - 0.02, bw * 0.44, 0.03, 0.004, darken(c, 0.3));
              rr(g, cx, sy + 0.26 - bh, bw, bh, 0.024, lin(g, cx, 0, cx + bw, 0, [[0, lighten(c, 0.22)], [1, darken(c, 0.24)]]));
            }
            cx += bw + 0.014;
            i += 1;
          }
        }
      });
    },
    mid(g, e, v) {
      const G = e.G;
      tiles(v, 2.8, (k, x) => {
        // 展台
        const dx = x + 0.3;
        const c = e.tone(mix('#efe8dc', e.accent, 0.2));
        rect(g, dx - 0.5, G - 0.36, 1.0, 0.36, lin(g, 0, G - 0.36, 0, G, [[0, c], [1, darken(c, 0.3)]]));
        rect(g, dx - 0.53, G - 0.38, 1.06, 0.022, lighten(c, 0.2));
        for (let i = 0; i < 6; i += 1) {
          const seed = k * 5 + i;
          const bw = 0.11;
          const bh = 0.1 + hash01(seed, 4) * 0.1;
          const cc = e.tone(mix(['#c96a50', '#6f8fa6', '#e8dcc4'][Math.abs(seed) % 3], e.accent, 0.3));
          rr(g, dx - 0.46 + i * 0.155, G - 0.38 - bh, bw, bh, 0.008, lin(g, 0, G - 0.38 - bh, 0, G - 0.38, [[0, lighten(cc, 0.14)], [1, darken(cc, 0.1)]]));
        }
      });
      tiles(v, 1.4, (k, x) => pendant(g, x + 0.3, G - 2.2, G - 1.5, e, e.tone('#2b2a28'), 0.9));
    },
  },

  gym: {
    wall: (e) => e.tone(mix('#3a3e46', e.base, 0.3)),
    floor: (e) => ({ far: e.tone('#3a3b40'), near: e.tone('#1c1d21'), lines: 'mats' }),
    surface: { top: '#3f4148', edge: '#141519' },
    far(g, e, v) {
      const G = e.G;
      const wall = this.wall(e);
      rect(g, v.x0 - 1, v.y0 - 2, v.x1 - v.x0 + 2, G - v.y0 + 2, lin(g, 0, G - 1.6, 0, G, [[0, darken(wall, 0.3)], [1, wall]]));
      // 高窗 + 镜面墙
      tiles(v, 1.15, (k, x) => {
        windowPane(g, x + 0.05, G - 1.6, 1.05, 0.3, e);
        rect(g, x + 0.05, G - 1.46, 1.05, 0.012, e.tone('#1c1d21'));
        for (let i = 1; i < 4; i += 1) rect(g, x + 0.05 + i * 0.262, G - 1.6, 0.012, 0.3, e.tone('#1c1d21'));
        const my = G - 1.2;
        g.fillStyle = lin(g, x, my, x + 1.1, G - 0.1, [[0, e.tone('#7c8a96')], [0.5, e.tone('#4f5962')], [1, e.tone('#6b7782')]]);
        g.fillRect(x + 0.03, my, 1.09, 1.08);
        poly(g, [x + 0.2, my, x + 0.42, my, x + 0.14, G - 0.12, x + 0.03, G - 0.12, x + 0.03, my + 0.42], rgba('#ffffff', 0.08));
        poly(g, [x + 0.6, my, x + 0.68, my, x + 0.4, G - 0.12, x + 0.32, G - 0.12], rgba('#ffffff', 0.06));
        rect(g, x, my, 0.03, 1.08, e.tone('#1c1d21'));
      });
      // 墙面品牌色带
      rect(g, v.x0 - 1, G - 0.11, v.x1 - v.x0 + 2, 0.05, e.tone(e.accent));
      rect(g, v.x0 - 1, G - 0.06, v.x1 - v.x0 + 2, 0.06, e.tone('#17181c'));
    },
    mid(g, e, v) {
      const G = e.G;
      const iron = e.tone('#17181c');
      const steel = e.tone('#a0a5ab');
      tiles(v, 3.0, (k, x) => {
        // 深蹲架
        const rx = x - 0.9;
        for (const dx of [-0.42, 0.42]) {
          rect(g, rx + dx - 0.022, G - 1.2, 0.044, 1.2, iron);
          for (let i = 0; i < 12; i += 1) circle(g, rx + dx, G - 1.14 + i * 0.09, 0.006, e.tone('#44464c'));
        }
        rect(g, rx - 0.46, G - 1.22, 0.92, 0.04, iron);
        rect(g, rx - 0.72, G - 0.62, 1.44, 0.02, steel);
        for (const dx of [-0.66, -0.6, 0.6, 0.66]) {
          const r = Math.abs(dx) > 0.63 ? 0.13 : 0.17;
          rr(g, rx + dx - 0.022, G - 0.61 - r, 0.044, r * 2, 0.01, e.tone(dx < 0 ? mix('#1c1d21', e.accent, 0.3) : mix('#1c1d21', e.accent, 0.5)));
        }
        // 哑铃架
        const dx0 = x + 0.36;
        rect(g, dx0, G - 0.5, 0.86, 0.022, iron);
        rect(g, dx0, G - 0.27, 0.86, 0.022, iron);
        rect(g, dx0, G - 0.5, 0.02, 0.5, iron);
        rect(g, dx0 + 0.84, G - 0.5, 0.02, 0.5, iron);
        for (const ry of [G - 0.53, G - 0.3]) {
          for (let i = 0; i < 5; i += 1) {
            const cx = dx0 + 0.09 + i * 0.165;
            rect(g, cx - 0.05, ry - 0.004, 0.1, 0.009, steel);
            rr(g, cx - 0.07, ry - 0.022, 0.034, 0.044, 0.006, e.tone('#2a2b30'));
            rr(g, cx + 0.036, ry - 0.022, 0.034, 0.044, 0.006, e.tone('#2a2b30'));
          }
        }
      });
      tiles(v, 1.5, (k, x) => {
        rect(g, x + 0.2, G - 1.7, 0.9, 0.018, rgba('#eef4ff', 0.9));
        glow(g, x + 0.65, G - 1.68, 0.7, '#dbe8ff', 0.16);
      });
    },
  },

  abstract: {
    wall: (e) => e.tone(e.base),
    floor: () => null,
    surface: { top: '#2a2d36', edge: '#0f1014', reflect: true, seamless: true },
    far(g, e, v) {
      const a = e.tone(darken(e.base, 0.2));
      const b = e.tone(mix(e.base, e.accent, 0.6));
      const c = e.tone(mix(e.accent, e.paper, 0.35));
      const span = (v.x1 - v.x0) + (v.y1 - v.y0);
      g.fillStyle = lin(g, v.x0, v.y0, v.x1, v.y1, [[0, a], [0.55, b], [1, darken(c, 0.2)]]);
      g.fillRect(v.x0 - span, v.y0 - span, span * 3, span * 3);
      const cx = (v.x0 + v.x1) / 2;
      const cy = (v.y0 + v.y1) / 2;
      const t = e.p;
      circle(g, cx + span * 0.13, cy - span * 0.08, span * 0.15, rgba(e.tone(e.paper), 0.1));
      glow(g, cx - span * 0.1, cy + span * 0.02, span * 0.34, c, 0.32);
      g.lineWidth = span * 0.0028;
      for (let i = 0; i < 5; i += 1) {
        g.strokeStyle = rgba(e.tone(e.paper), 0.16 - i * 0.02);
        g.beginPath();
        g.arc(cx + span * 0.13, cy - span * 0.08, span * (0.17 + i * 0.03), t * 0.8 + i, t * 0.8 + i + 4.2);
        g.stroke();
      }
      g.save();
      g.translate(cx - span * 0.17, cy + span * 0.05);
      g.rotate(t * 0.5 + 0.4);
      const s = span * 0.1;
      g.fillStyle = rgba(e.tone(e.accent), 0.26);
      g.fillRect(-s, -s, s * 2, s * 2);
      g.strokeStyle = rgba(e.tone(e.paper), 0.26);
      g.strokeRect(-s * 1.3, -s * 1.3, s * 2.6, s * 2.6);
      g.restore();
      for (let i = 0; i < 12; i += 1) {
        const x = cx + (hash01(i, 3) - 0.5) * span * 0.9;
        const y = cy + (hash01(i, 4) - 0.5) * span * 0.5 - t * span * 0.012 * (i % 3 + 1);
        circle(g, x, y, span * (0.0015 + hash01(i, 5) * 0.003), rgba(e.tone(e.paper), 0.4));
      }
    },
  },
};

// ---------------- 地面 ----------------

function drawFloor(g, e, w, h, cam) {
  const scene = SCENES[e.spec.setting];
  const f = scene.floor(e);
  if (!f) return;
  const yFar = screenY(cam, e.G, FAR, h);
  if (yFar >= h * 1.6) return;
  const top = Math.max(-h, yFar);
  g.fillStyle = lin(g, 0, top, 0, Math.max(top + 1, h * 1.05), [[0, f.far], [1, f.near]]);
  g.fillRect(-w, top, w * 3, h * 3);
  if (f.seamless) {
    // 无缝背景的地面和墙之间不应有硬线
    const wall = scene.wall(e);
    g.fillStyle = lin(g, 0, top - h * 0.12, 0, top + h * 0.2, [[0, rgba(wall, 0)], [0.45, rgba(mix(wall, f.far, 0.5), 1)], [1, rgba(f.far, 0)]]);
    g.fillRect(-w, top - h * 0.12, w * 3, h * 0.32);
    return;
  }
  if (f.shore) {
    // 海岸线：波动的浪沫
    g.fillStyle = rgba('#ffffff', 0.7);
    g.beginPath();
    g.moveTo(-w, top + h * 0.012);
    for (let i = 0; i <= 48; i += 1) {
      const x = -w + (i / 48) * w * 3;
      g.lineTo(x, top + h * 0.009 * Math.sin(i * 0.9 + e.p * 3) + h * 0.006);
    }
    g.lineTo(w * 2, top - h * 0.002);
    g.lineTo(-w, top - h * 0.002);
    g.closePath();
    g.fill();
    return;
  }
  const ox = w / 2 + cam.sx * w;
  const oy = (cam.yh + cam.sy) * h;
  const Znear = Math.max(cam.zoomAt(-0.15), cam.Z * 2.2);
  const Zfar = cam.zoomAt(FAR);
  const px = (x, Z) => ox + (x - cam.Tx) * Z * h;
  const py = (Z) => oy + e.G * Z * h;
  g.save();
  g.lineWidth = Math.max(0.5, h * 0.0012);
  if (f.lines === 'planks' || f.lines === 'tile' || f.lines === 'mats') {
    const step = f.lines === 'planks' ? 0.22 : 0.42;
    g.strokeStyle = rgba('#000000', f.lines === 'planks' ? 0.2 : 0.13);
    const span = (w / h) / Zfar + 2;
    const n = Math.min(60, Math.ceil(span / step));
    g.beginPath();
    for (let i = -n; i <= n; i += 1) {
      const x = i * step + Math.round(cam.Tx / step) * step;
      g.moveTo(px(x, Zfar), py(Zfar));
      g.lineTo(px(x, Znear), py(Znear));
    }
    g.stroke();
    if (f.lines !== 'planks') {
      g.beginPath();
      for (let i = 0; i < 26; i += 1) {
        const Z = 1 / (1 / Zfar - i * ((1 / Zfar) / 26) * 0.97);
        const y = py(Z);
        if (y > h * 1.2) break;
        g.moveTo(-w, y);
        g.lineTo(w * 2, y);
      }
      g.stroke();
    }
  } else if (f.lines === 'road') {
    // 路缘 + 车道线
    const curbZ = cam.zoomAt(FAR * 0.72);
    const curbY = py(curbZ);
    if (curbY < h * 1.1) {
      g.fillStyle = rgba('#ffffff', 0.08);
      g.fillRect(-w, top, w * 3, curbY - top);
      g.fillStyle = rgba('#000000', 0.28);
      g.fillRect(-w, curbY, w * 3, Math.max(1, h * 0.004));
      const laneZ = cam.zoomAt(FAR * 0.26);
      const laneY = py(laneZ);
      g.fillStyle = rgba('#ffffff', 0.5);
      const dash = laneZ * h * 0.34;
      const gap = dash * 1.1;
      const startX = -(((cam.Tx * laneZ * h) % (dash + gap)) + dash + gap);
      for (let x = startX; x < w * 1.2; x += dash + gap) g.fillRect(x, laneY, dash, Math.max(1, h * 0.005 * laneZ));
    }
  }
  g.restore();
  // 墙根阴影，让墙和地真正接触
  g.fillStyle = lin(g, 0, top, 0, top + h * 0.05, [[0, rgba('#000000', 0.34)], [1, rgba('#000000', 0)]]);
  g.fillRect(-w, top, w * 3, h * 0.05);
  if (scene.onFloorWet) scene.onFloorWet(g, e, w, h, cam);
}

// ---------------- 承托面（桌面 / 台面）----------------

function drawSurface(g, e, w, h, cam) {
  const scene = SCENES[e.spec.setting];
  const s = scene.surface || { top: '#6a5a4a', edge: '#2a2018' };
  const yTop = cam.tableTop;
  const backD = 0.36;
  const yBack = screenY(cam, yTop, backD, h);
  if (yBack > h * 1.2) return;
  const base = e.tone(mix(s.top, e.base, 0.1));
  const near = darken(base, 0.26);
  const back = Math.max(-h, yBack);
  if (s.seamless && !cam.isPerson) {
    g.fillStyle = lin(g, 0, back - h * 0.1, 0, h, [[0, rgba(base, 0)], [0.24, rgba(lighten(base, 0.1), 1)], [1, near]]);
    g.fillRect(-w, back - h * 0.1, w * 3, h * 2);
    return;
  }
  g.fillStyle = lin(g, 0, back, 0, Math.max(back + 1, h), [[0, lighten(base, 0.12)], [1, near]]);
  g.fillRect(-w, back, w * 3, h * 2);
  rect(g, -w, back - Math.max(1, h * 0.0016), w * 3, Math.max(1, h * 0.003), rgba(lighten(base, 0.45), 0.75));
  const ox = w / 2 + cam.sx * w;
  const oy = (cam.yh + cam.sy) * h;
  const Zb = cam.zoomAt(backD);
  const Zn = cam.Z * 3;
  const px = (x, Z) => ox + (x - cam.Tx) * Z * h;
  const py = (Z) => oy + yTop * Z * h;
  if (s.grain) {
    g.save();
    g.strokeStyle = rgba('#000000', 0.14);
    g.lineWidth = Math.max(0.5, h * 0.0014);
    g.beginPath();
    for (let i = -40; i <= 40; i += 1) {
      const x = i * 0.09;
      g.moveTo(px(x, Zb), py(Zb));
      g.lineTo(px(x, Zn), py(Zn));
    }
    g.stroke();
    g.restore();
  }
  if (s.marble) {
    g.save();
    g.strokeStyle = rgba('#6e6e74', 0.2);
    g.lineWidth = Math.max(1, h * 0.002);
    for (let i = 0; i < 7; i += 1) {
      g.beginPath();
      let x = hash01(i, 2) * w;
      let y = back;
      g.moveTo(x, y);
      for (let k = 0; k < 8; k += 1) {
        x += (hash01(i * 9 + k, 3) - 0.3) * w * 0.09;
        y += h * 0.05;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    g.restore();
  }
}

/** 小物件和人同框时放在一张小圆桌上，不让杯子悬空 */
function sideTable(g, x, topY, ground, e) {
  const c = e.tone('#3a2c22');
  const legH = ground - topY;
  rect(g, x - 0.012, topY, 0.024, legH, darken(c, 0.2));
  ellipse(g, x, ground, 0.09, 0.016, darken(c, 0.35));
  ellipse(g, x, topY, 0.17, 0.03, lighten(c, 0.2));
  ellipse(g, x, topY + 0.008, 0.17, 0.03, c);
  ellipse(g, x, topY, 0.165, 0.026, lighten(c, 0.34));
}

// ---------------- 人物 ----------------

function personPose(action, p, seed) {
  const T = p * 4;
  const breathe = Math.sin(T * 1.7 + seed) * 0.5 + 0.5;
  // 默认站姿：重心落在一条腿上（对立平衡），两臂自然下垂、左右略有不同，避免机器人式的对称
  const pose = {
    view: 0.35 * (seed % 2 ? 1 : -1), facing: seed % 2 ? 1 : -1, lift: 0, bob: 0.003 * breathe, lean: 0.012, squash: 1,
    armNear: [0.1, 0.3 + 0.04 * breathe], armFar: [0.17, 0.16], legNear: [0.075, 0.05], legFar: [-0.04, 0], head: 0.03 * (seed % 2 ? 1 : -1), mouth: 0, holdKettle: false, pour: 0,
  };
  const dir = walkDir(action);
  switch (action) {
    case 'walk-left':
    case 'walk-right': {
      const ph = T * TAU * 0.95;
      const s = Math.sin(ph);
      pose.facing = dir;
      pose.view = dir * 0.92;
      pose.bob = Math.abs(Math.cos(ph)) * 0.014;
      pose.lean = 0.03;
      pose.legNear = [s * 0.5, Math.max(0, -Math.cos(ph)) * 0.75];
      pose.legFar = [-s * 0.5, Math.max(0, Math.cos(ph)) * 0.75];
      pose.armNear = [-s * 0.5, 0.35];
      pose.armFar = [s * 0.5, 0.35];
      break;
    }
    case 'turn': {
      pose.view = 1 - easeInOut(p * 1.3);
      pose.facing = 1;
      pose.head = 0.3 * (1 - easeInOut(p * 1.8));
      break;
    }
    case 'rotate':
      pose.view = Math.sin(p * TAU);
      pose.facing = pose.view >= 0 ? 1 : -1;
      break;
    case 'raise': {
      const e = easeInOut(p * 1.6);
      const wave = Math.sin(T * 7) * 0.18 * e;
      pose.view = 0.3;
      pose.facing = 1;
      pose.armNear = [0.2 + e * 2.65 + wave, 0.2 + e * 0.28];
      pose.head = -0.08 * e;
      break;
    }
    case 'talk': {
      const g1 = Math.sin(T * 3.1 + seed);
      const g2 = Math.sin(T * 1.7 + 1.1);
      pose.view = 0.42 * pose.facing;
      // 讲话时近侧手肘贴着身体、小臂向前上方抬起（手在胸前高度比划），不会伸到旁边人身上
      pose.armNear = [0.12 + 0.06 * g2, 2.18 + 0.2 * g1];
      pose.armFar = [0.12, 0.28];
      pose.head = 0.06 * g2;
      pose.bob = 0.004 * Math.abs(g1);
      pose.mouth = 0.45 + 0.55 * Math.abs(Math.sin(T * 8.3));
      break;
    }
    case 'jump': {
      const c = (T * 0.72) % 1;
      const air = Math.sin(Math.min(1, Math.max(0, (c - 0.14) / 0.72)) * Math.PI);
      const crouch = c < 0.14 ? Math.sin((c / 0.14) * Math.PI) : c > 0.86 ? Math.sin(((c - 0.86) / 0.14) * Math.PI) : 0;
      pose.view = 0;
      pose.lift = air * 0.24;
      pose.squash = 1 - crouch * 0.1;
      pose.legNear = [0.28 * air + 0.42 * crouch, 0.9 * air + 0.82 * crouch];
      pose.legFar = [-0.28 * air - 0.42 * crouch, -0.9 * air - 0.82 * crouch];
      pose.armNear = [0.2 + 2.3 * air, 0.22];
      pose.armFar = [0.2 + 2.3 * air, 0.22];
      break;
    }
    case 'pour': {
      pose.facing = pose.facing >= 0 ? 1 : -1;
      pose.view = pose.facing * 0.82;
      const e = easeInOut(p * 2.2);
      pose.armNear = [0.62 + 0.12 * e, 0.85];
      pose.armFar = [0.12, 0.35];
      pose.holdKettle = true;
      pose.pour = e;
      pose.head = 0.16;
      break;
    }
    default:
      break;
  }
  return pose;
}

const HAIR = ['#1e1a18', '#3a2a20', '#58402c', '#22242c'];
const SKIN = ['#e6b796', '#d9a382', '#f0c6a6', '#c48c6c'];

function limbPoints(x0, y0, a1, l1, a2, l2) {
  const x1 = x0 + Math.sin(a1) * l1;
  const y1 = y0 + Math.cos(a1) * l1;
  const x2 = x1 + Math.sin(a1 + a2) * l2;
  const y2 = y1 + Math.cos(a1 + a2) * l2;
  return [x0, y0, x1, y1, x2, y2];
}

function strokeLimb(g, pts, width, color) {
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.lineWidth = width;
  g.strokeStyle = color;
  g.beginPath();
  g.moveTo(pts[0], pts[1]);
  g.lineTo(pts[2], pts[3]);
  g.lineTo(pts[4], pts[5]);
  g.stroke();
}

/** 用 paint 中的颜色画出人物。rim 通道用单色重画同一形状，错位后形成轮廓光 */
function drawFigure(g, pose, c, detail) {
  const f = pose.facing;
  const v = Math.abs(pose.view);
  const sw = 0.118 * (1 - 0.48 * v);
  const hw = 0.082 * (1 - 0.3 * v);
  const sy = -0.795;
  const hy = -0.5;
  const nearSide = pose.view >= 0 ? 1 : -1; // 靠近观众的一侧
  const lift = pose.lift;
  g.save();
  g.translate(0, -lift - pose.bob);
  g.scale(1, pose.squash);

  // 腿（下半身不抬升时站地，抬升时一起离地）
  const hipFar = -nearSide * hw * 0.55;
  const hipNear = nearSide * hw * 0.55;
  const legFar = limbPoints(hipFar, hy, f * pose.legFar[0], 0.26, -f * pose.legFar[1], 0.25);
  const legNear = limbPoints(hipNear, hy, f * pose.legNear[0], 0.26, -f * pose.legNear[1], 0.25);
  strokeLimb(g, legFar, 0.066, c.pantsDark);
  shoe(g, legFar, f, c.shoe, pose);
  // 后臂
  const shFar = -nearSide * sw;
  const shNear = nearSide * sw;
  const armSign = (side) => (v > 0.5 ? f : side);
  const armFar = limbPoints(shFar, sy + 0.012, armSign(-nearSide) * pose.armFar[0], 0.165, armSign(-nearSide) * pose.armFar[1], 0.15);
  strokeLimb(g, armFar, 0.05, c.clothDark);
  circle(g, armFar[4], armFar[5], 0.027, c.skinDark);

  strokeLimb(g, legNear, 0.07, c.pants);
  shoe(g, legNear, f, c.shoe, pose);

  // 躯干
  g.save();
  g.translate(0, hy);
  g.rotate(f * pose.lean);
  g.translate(0, -hy);
  g.beginPath();
  g.moveTo(-sw - 0.012, sy + 0.012);
  g.quadraticCurveTo(-sw * 0.62, sy - 0.03, -0.03, sy - 0.03);
  g.lineTo(0.03, sy - 0.03);
  g.quadraticCurveTo(sw * 0.62, sy - 0.03, sw + 0.012, sy + 0.012);
  g.quadraticCurveTo(sw + 0.004, sy + 0.14, hw + 0.012, hy + 0.04);
  g.lineTo(-hw - 0.012, hy + 0.04);
  g.quadraticCurveTo(-sw - 0.004, sy + 0.14, -sw - 0.012, sy + 0.012);
  g.closePath();
  g.fillStyle = c.torso;
  g.fill();
  if (detail) {
    // 衣襟中线 + 领口
    const cx = pose.view * 0.05;
    line(g, cx, sy - 0.015, cx * 0.8, hy + 0.03, rgba('#000000', 0.16), 0.004);
    g.beginPath();
    g.moveTo(cx - 0.034, sy - 0.03);
    g.lineTo(cx, sy + 0.03);
    g.lineTo(cx + 0.034, sy - 0.03);
    g.closePath();
    g.fillStyle = c.collar;
    g.fill();
  }
  // 腰带线
  rect(g, -hw - 0.012, hy + 0.012, (hw + 0.012) * 2, 0.028, c.pantsDark);

  // 脖子
  rect(g, -0.026 + pose.view * 0.01, sy - 0.07, 0.052, 0.06, c.skinDark);

  // 头
  drawHead(g, pose, c, detail);
  g.restore();

  // 前臂
  const armNear = limbPoints(shNear, sy + 0.012, armSign(nearSide) * pose.armNear[0], 0.165, armSign(nearSide) * pose.armNear[1], 0.15);
  strokeLimb(g, armNear, 0.054, c.cloth);
  circle(g, armNear[4], armNear[5], 0.029, c.skin);
  if (pose.holdKettle) drawKettle(g, armNear[4], armNear[5], f, pose.pour, c);
  g.restore();
}

function shoe(g, leg, f, color) {
  const x = leg[4];
  const y = leg[5];
  g.fillStyle = color;
  g.beginPath();
  g.ellipse(x + f * 0.024, y + 0.002, 0.052, 0.022, 0, 0, TAU);
  g.fill();
}

function drawHead(g, pose, c, detail) {
  const hx = pose.view * 0.012 + pose.head * 0.05;
  const hy = -0.905;
  const r = 0.076;
  const fx = pose.view * 0.046; // 五官朝向
  g.save();
  g.translate(hx, hy);
  g.rotate(pose.head);
  // 后发（长发 / 发髻）
  if (c.hairStyle === 1) rr(g, -r * 1.08, -r * 0.5, r * 2.16, r * 2.2, r * 0.8, c.hairDark);
  if (c.hairStyle === 2) circle(g, -pose.view * r * 0.7, -r * 1.05, r * 0.46, c.hairDark);
  ellipse(g, 0, 0, r * 0.94, r * 1.08, c.head);
  if (Math.abs(pose.view) > 0.55) {
    // 侧脸：鼻尖
    const s = pose.view > 0 ? 1 : -1;
    g.beginPath();
    g.moveTo(s * r * 0.86, -r * 0.2);
    g.quadraticCurveTo(s * r * 1.2, r * 0.05, s * r * 0.84, r * 0.2);
    g.closePath();
    g.fillStyle = c.head;
    g.fill();
  }
  if (detail) drawFace(g, pose, c, r, fx);
  // 前发
  g.beginPath();
  g.ellipse(0, -r * 0.34, r * 1.0, r * 0.8, 0, Math.PI, TAU);
  g.quadraticCurveTo(r * 0.95 + fx * 0.3, -r * 0.1, r * 0.72 + fx * 0.5, r * 0.02);
  g.quadraticCurveTo(fx * 0.4 + r * 0.2, -r * 0.46, -r * 0.2 + fx, -r * 0.48);
  g.quadraticCurveTo(-r * 0.72 + fx * 0.4, -r * 0.42, -r * 0.82 + fx * 0.3, r * 0.02);
  g.closePath();
  g.fillStyle = c.hair;
  g.fill();
  g.restore();
}

function drawFace(g, pose, c, r, fx) {
  const v = pose.view;
  const eyeY = -r * 0.06;
  const gap = r * 0.42 * (1 - Math.abs(v) * 0.5);
  // 脸部明暗分界
  if (c.faceShade) {
    g.save();
    g.beginPath();
    g.ellipse(0, 0, r * 0.94, r * 1.08, 0, 0, TAU);
    g.clip();
    g.fillStyle = c.faceShade;
    g.fillRect(-r * 2, -r * 2, r * 4, r * 4);
    g.restore();
  }
  for (const s of [-1, 1]) {
    const ex = fx + s * gap;
    ellipse(g, ex, eyeY, r * 0.135, r * 0.09, '#fbf7f2');
    circle(g, ex + fx * 0.06, eyeY, r * 0.07, '#3a2a22');
    circle(g, ex + fx * 0.06 - r * 0.02, eyeY - r * 0.024, r * 0.022, '#ffffff');
    g.strokeStyle = c.hair;
    g.lineWidth = r * 0.065;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(ex - r * 0.17, eyeY - r * 0.2);
    g.quadraticCurveTo(ex, eyeY - r * 0.29, ex + r * 0.17, eyeY - r * 0.2);
    g.stroke();
    g.strokeStyle = rgba('#3a2a22', 0.7);
    g.lineWidth = r * 0.03;
    g.beginPath();
    g.arc(ex, eyeY + r * 0.02, r * 0.14, Math.PI * 1.15, Math.PI * 1.85);
    g.stroke();
  }
  // 鼻
  g.strokeStyle = rgba('#8a5a44', 0.55);
  g.lineWidth = r * 0.04;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(fx + r * 0.02, eyeY + r * 0.12);
  g.quadraticCurveTo(fx + r * 0.1 * (v >= 0 ? 1 : -1), eyeY + r * 0.34, fx - r * 0.02, eyeY + r * 0.38);
  g.stroke();
  // 嘴
  const my = r * 0.58;
  if (pose.mouth > 0.05) {
    ellipse(g, fx, my, r * 0.2, r * 0.06 + r * 0.12 * pose.mouth, '#6a2e2a');
    rect(g, fx - r * 0.14, my - r * 0.06 - r * 0.1 * pose.mouth * 0.6, r * 0.28, r * 0.05, '#f5efe8');
  } else {
    g.strokeStyle = '#a0544a';
    g.lineWidth = r * 0.05;
    g.beginPath();
    g.moveTo(fx - r * 0.2, my);
    g.quadraticCurveTo(fx, my + r * 0.08, fx + r * 0.2, my);
    g.stroke();
  }
}

function drawKettle(g, x, y, f, pour, c) {
  g.save();
  g.translate(x, y);
  g.rotate(f * (0.05 + pour * 0.72));
  const s = 0.16;
  rr(g, -s * 0.2 * f - s * 0.28, -s * 0.05, s * 0.56, s * 0.5, s * 0.1, c.kettle);
  g.strokeStyle = c.kettle;
  g.lineWidth = s * 0.11;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(f * s * 0.08, s * 0.28);
  g.quadraticCurveTo(f * s * 0.5, s * 0.25, f * s * 0.72, -s * 0.06);
  g.stroke();
  g.restore();
  if (pour > 0.42 && c.water) {
    const sx = x + f * 0.13;
    const sy = y + 0.06;
    g.strokeStyle = c.water;
    g.lineWidth = 0.013;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(sx, sy);
    g.quadraticCurveTo(sx + f * 0.03, sy + 0.1, sx + f * 0.034, sy + 0.2);
    g.stroke();
  }
}

function drawPerson(g, s, e, pxScale, p, extra = {}) {
  const pose = personPose(s.action, p, s.seed);
  const seed = Math.abs(s.seed);
  const backlit = e.back;
  const shadowTint = e.night > 0.5 ? '#141a33' : e.indoor ? '#2a1a1e' : '#1c2238';
  const look = {
    cloth: e.tone(s.color),
    pants: e.tone(mix(e.base, '#262a34', 0.55)),
    shoe: e.tone('#1b1a1c'),
    shirt: e.tone(mix(e.paper, '#ffffff', 0.3)),
    skin: e.tone(PERSON_SKIN[seed % PERSON_SKIN.length]),
    hair: e.tone(PERSON_HAIR[(seed >> 1) % PERSON_HAIR.length]),
    hairStyle: seed % 3,
    part: (seed >> 3) % 2 ? 1 : -1,
    seed,
    metal: e.tone('#b9bcc0'),
    water: e.tone('#6a3a1e'),
    shadowTint,
    ambient: e.indoor ? mix(e.base, e.accent, 0.3) : e.tod.sky[1],
    silhouette: backlit ? 0.62 : e.dramatic ? 0.12 : 0,
    castColor: e.night > 0.5 ? '#05060c' : '#140e0c',
  };
  if (drawLitFigure(g, pose, look, e, { pose, ...extra })) return pose;
  return drawPersonFlat(g, s, e, pxScale, p);
}

function drawPersonFlat(g, s, e, pxScale, p) {
  const pose = personPose(s.action, p, s.seed);
  const backlit = e.back;
  const cloth = e.tone(s.color);
  const seed = Math.abs(s.seed);
  const skinBase = SKIN[seed % SKIN.length];
  const hairBase = HAIR[seed % HAIR.length];
  const dark = backlit ? 0.72 : e.dramatic ? 0.22 : 0.05;
  const shade = (c) => darken(e.tone(c), dark);
  const litSide = e.keyX || (pose.view >= 0 ? 1 : -1);
  const cl = darken(cloth, dark);
  const torso = lin(g, -0.13, 0, 0.13, 0, litSide < 0
    ? [[0, lighten(mix(cl, e.key, 0.22), 0.05)], [1, darken(cl, 0.32)]]
    : [[0, darken(cl, 0.32)], [1, lighten(mix(cl, e.key, 0.22), 0.05)]]);
  const paint = {
    cloth: cl,
    clothDark: darken(cl, 0.26),
    torso,
    collar: lighten(cl, 0.3),
    pants: shade(mix(e.base, '#2a2f3c', 0.5)),
    pantsDark: darken(shade(mix(e.base, '#2a2f3c', 0.5)), 0.26),
    shoe: shade('#1a1a1e'),
    skin: shade(skinBase),
    skinDark: darken(shade(skinBase), 0.14),
    head: shade(skinBase),
    hair: shade(hairBase),
    hairDark: darken(shade(hairBase), 0.1),
    hairStyle: seed % 3,
    kettle: shade('#c8ccd0'),
    water: rgba(e.tone('#8a5a3a'), 0.85),
    faceShade: lin(g, litSide < 0 ? -0.03 : 0.03, 0, litSide < 0 ? 0.08 : -0.08, 0, [[0, 'rgba(70,30,20,0)'], [1, 'rgba(70,30,20,0.34)']]),
  };
  const detail = pxScale > 150;
  // 轮廓光：整形错位。逆光时两侧都亮
  const rim = {
    cloth: e.key, clothDark: e.key, torso: e.key, collar: e.key, pants: e.key, pantsDark: e.key, shoe: e.key, skin: e.key, skinDark: e.key, head: e.key, hair: e.key, hairDark: e.key,
    hairStyle: paint.hairStyle, kettle: e.key, water: null, faceShade: null,
  };
  const rimAmount = backlit ? 0.009 : 0.0055;
  const sides = backlit ? [-1, 1] : e.keyX ? [e.keyX] : [];
  g.save();
  g.globalAlpha = backlit ? 0.95 : 0.7;
  for (const sd of sides) {
    g.save();
    g.translate(sd * rimAmount, -rimAmount * 0.45);
    drawFigure(g, pose, rim, false);
    g.restore();
  }
  g.restore();
  drawFigure(g, pose, paint, detail);
  return pose;
}

// ---------------- 物体（单位高度 = 1，原点在底部中心）----------------

function steam(g, x, y, p, color, spread) {
  for (let i = 0; i < 3; i += 1) {
    const rise = (p * 2.2 + i * 0.34) % 1;
    const ox = x + (i - 1) * spread;
    g.strokeStyle = rgba(color, 0.42 * (1 - rise) * Math.min(1, rise * 5));
    g.lineWidth = 0.036;
    g.lineCap = 'round';
    g.beginPath();
    const y0 = y - rise * 0.5;
    g.moveTo(ox, y0);
    g.bezierCurveTo(ox - 0.07, y0 - 0.1, ox + 0.08, y0 - 0.17, ox, y0 - 0.28);
    g.stroke();
  }
}

/** rotate 动作：横向压缩模拟绕竖轴旋转，并让高光带移动 */
function spinScale(s, p) {
  return s.action === 'rotate' ? 0.72 + 0.28 * Math.abs(Math.cos(p * TAU * 0.5)) : 1;
}

function drawProduct(g, s, e, p) {
  const c = e.tone(s.color);
  const sc = spinScale(s, p);
  const shift = s.action === 'rotate' ? Math.sin(p * TAU) * 0.08 : 0;
  const side = e.keyX > 0 ? 1 : -1; // 受光的一侧
  g.save();
  g.scale(sc, 1);
  const w = 0.36;
  const x0 = (side * w) / 2; // 渐变从受光边开始
  const body = lin(g, x0, 0, -x0, 0, [[0, darken(c, 0.3)], [0.3 + shift, lighten(c, 0.16)], [0.42 + shift, lighten(c, 0.5)], [0.56 + shift, c], [1, darken(c, 0.46)]]);
  // 瓶身
  g.beginPath();
  g.moveTo(-w / 2, -0.04);
  g.quadraticCurveTo(-w / 2, 0, -w / 2 + 0.04, 0);
  g.lineTo(w / 2 - 0.04, 0);
  g.quadraticCurveTo(w / 2, 0, w / 2, -0.04);
  g.lineTo(w / 2, -0.62);
  g.quadraticCurveTo(w / 2, -0.74, 0.08, -0.79);
  g.lineTo(-0.08, -0.79);
  g.quadraticCurveTo(-w / 2, -0.74, -w / 2, -0.62);
  g.closePath();
  g.fillStyle = body;
  g.fill();
  // 柔光箱的反射：受光侧一条宽而柔的亮带，另一侧贴边一条细而锐的亮线；肩部受光、底部压暗
  const spec = lighten(mix(e.key, '#ffffff', 0.55), 0.2);
  g.save();
  g.clip();
  const strip = (cx, half, a) => {
    g.fillStyle = lin(g, cx - half, 0, cx + half, 0, [[0, rgba(spec, 0)], [0.5, rgba(spec, a)], [1, rgba(spec, 0)]]);
    g.fillRect(cx - half, -0.8, half * 2, 0.8);
  };
  strip(side * (w / 2 - 0.085) - side * shift * 0.6, 0.05, 0.5);
  strip(-side * (w / 2 - 0.035) - side * shift * 0.3, 0.011, 0.7);
  g.fillStyle = lin(g, 0, -0.8, 0, 0, [[0, rgba(spec, 0.16)], [0.16, rgba(spec, 0)], [0.8, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,0.28)']]);
  g.fillRect(-w, -0.8, w * 2, 0.8);
  g.restore();
  // 瓶盖
  const cap = e.tone(mix(darken(e.base, 0.25), '#22242c', 0.5));
  rr(g, -0.085, -1, 0.17, 0.2, 0.02, lin(g, side * 0.09, 0, -side * 0.09, 0, [[0, darken(cap, 0.1)], [0.3, lighten(cap, 0.34)], [0.45, lighten(cap, 0.08)], [1, darken(cap, 0.36)]]));
  rect(g, -0.095, -0.84, 0.19, 0.05, lighten(cap, 0.14));
  rect(g, -0.095, -0.84, 0.19, 0.008, rgba(spec, 0.35));
  // 标签：哑光纸 + 品牌标记 + 标题和小字
  const paper = e.tone(e.paper);
  const ink = e.tone(darken(c, 0.3));
  rect(g, -w / 2 + 0.002, -0.54, w - 0.004, 0.32, lin(g, x0, 0, -x0, 0, [[0, darken(paper, 0.18)], [0.4 + shift, lighten(paper, 0.1)], [1, darken(paper, 0.34)]]));
  circle(g, 0, -0.5, 0.014, e.tone(e.accent));
  rect(g, -0.1, -0.465, 0.2, 0.034, ink);
  rect(g, -0.07, -0.405, 0.14, 0.014, rgba(ink, 0.5));
  rect(g, -0.055, -0.375, 0.11, 0.014, rgba(ink, 0.38));
  rect(g, -w / 2 + 0.002, -0.27, w - 0.004, 0.006, rgba(e.tone(e.accent), 0.7));
  g.restore();
}

/** 影棚里的小物件放在一个圆台上（像电商主图），圆台随机位和主体一起移动 */
function riserGeom(base, H, cam) {
  const R = H * 0.55;
  const rh = H * 0.16;
  const ry = R * Math.max(0.04, Math.min(0.42, Math.abs(base) * cam.Z));
  const ryB = R * Math.max(0.05, Math.min(0.5, Math.abs(base + rh) * cam.Z));
  return { R, rh, ry, ryB };
}

function drawRiser(g, x, base, H, e, cam) {
  const { R, rh, ry, ryB } = riserGeom(base, H, cam);
  const c = e.tone(mix(e.paper, e.base, 0.35));
  const side = e.keyX > 0 ? 1 : -1;
  contactShadow(g, x, base + rh, R * 1.25, ryB * 1.3 + H * 0.02, e, 0.9);
  // 侧面
  g.beginPath();
  g.moveTo(x - R, base);
  g.lineTo(x - R, base + rh);
  g.ellipse(x, base + rh, R, ryB, 0, Math.PI, 0, true);
  g.lineTo(x + R, base);
  g.closePath();
  g.fillStyle = lin(g, x + side * R, 0, x - side * R, 0, [[0, lighten(c, 0.06)], [0.35, c], [1, darken(c, 0.5)]]);
  g.fill();
  // 顶面 + 前沿一道细高光
  ellipse(g, x, base, R, ry, lin(g, 0, base - ry, 0, base + ry, [[0, darken(c, 0.06)], [1, lighten(c, 0.1)]]));
  g.strokeStyle = rgba(lighten(c, 0.55), 0.5);
  g.lineWidth = Math.max(0.002, H * 0.006);
  g.beginPath();
  g.ellipse(x, base, R, ry, 0, 0, Math.PI);
  g.stroke();
}

function drawCup(g, s, e, p) {
  const c = e.tone(mix(s.color, e.paper, 0.72));
  const coffee = e.tone('#4a2b1a');
  // 碟
  ellipse(g, 0, -0.012, 0.56, 0.05, darken(c, 0.14));
  ellipse(g, 0, -0.03, 0.54, 0.046, c);
  ellipse(g, 0, -0.034, 0.34, 0.022, darken(c, 0.12));
  // 杯把
  g.strokeStyle = lin(g, 0.2, 0, 0.6, 0, [[0, darken(c, 0.14)], [1, lighten(c, 0.1)]]);
  g.lineWidth = 0.075;
  g.beginPath();
  g.ellipse(0.42, -0.42, 0.14, 0.19, 0, -Math.PI * 0.55, Math.PI * 0.55);
  g.stroke();
  // 杯身
  const w = 0.68;
  g.beginPath();
  g.moveTo(-w / 2, -0.76);
  g.lineTo(w / 2, -0.76);
  g.bezierCurveTo(w / 2, -0.32, w / 2 - 0.08, -0.06, w / 4, -0.06);
  g.lineTo(-w / 4, -0.06);
  g.bezierCurveTo(-w / 2 + 0.08, -0.06, -w / 2, -0.32, -w / 2, -0.76);
  g.closePath();
  g.fillStyle = lin(g, -w / 2, 0, w / 2, 0, [[0, darken(c, 0.3)], [0.34, lighten(c, 0.3)], [0.5, c], [1, darken(c, 0.34)]]);
  g.fill();
  ellipse(g, 0, -0.76, w / 2, 0.075, lighten(c, 0.3));
  ellipse(g, 0, -0.755, w / 2 - 0.035, 0.056, coffee);
  // 拉花
  ellipse(g, 0.01, -0.757, 0.11, 0.024, e.tone('#c9a27c'));
  ellipse(g, 0.015, -0.757, 0.05, 0.012, coffee);
  if (s.action === 'pour') {
    const k = clamp01(p * 1.6);
    g.strokeStyle = rgba(e.tone('#6a3c22'), 0.9);
    g.lineWidth = 0.05 * k;
    g.beginPath();
    g.moveTo(-0.02, -1.5);
    g.quadraticCurveTo(0.012, -1.05, 0, -0.76);
    g.stroke();
  }
  steam(g, 0, -0.84, p, e.tone('#ffffff'), 0.12);
}

function drawPhone(g, s, e, p) {
  const c = e.tone(mix('#17181d', s.color, 0.2));
  const sc = spinScale(s, p);
  g.save();
  g.scale(sc, 1);
  const w = 0.5;
  rr(g, -w / 2, -1, w, 1, 0.07, lin(g, -w / 2, -1, w / 2, 0, [[0, lighten(c, 0.3)], [0.3, c], [1, darken(c, 0.2)]]));
  const sx = -w / 2 + 0.026;
  const sw = w - 0.052;
  const sy = -0.974;
  const sh = 0.948;
  rrPath(g, sx, sy, sw, sh, 0.05);
  g.save();
  g.clip();
  g.fillStyle = lin(g, 0, sy, 0, sy + sh, [[0, e.tone(mix(e.accent, '#4a7fd0', 0.4))], [1, e.tone(mix(s.color, e.base, 0.4))]]);
  g.fillRect(sx, sy, sw, sh);
  circle(g, sx + sw * 0.72, sy + sh * 0.3, sw * 0.5, rgba('#ffffff', 0.12));
  const y0 = sy + 0.14 + Math.sin(p * 3) * 0.008;
  rr(g, sx + 0.04, y0, sw - 0.08, 0.3, 0.03, rgba('#ffffff', 0.24));
  for (let i = 0; i < 3; i += 1) rr(g, sx + 0.04, y0 + 0.36 + i * 0.1, sw - 0.08, 0.075, 0.02, rgba('#ffffff', 0.16));
  rr(g, sx + sw / 2 - 0.08, sy + 0.022, 0.16, 0.036, 0.018, '#0b0b0d');
  poly(g, [sx, sy, sx + sw * 0.5, sy, sx, sy + sh * 0.58], rgba('#ffffff', 0.08));
  g.restore();
  g.restore();
  glow(g, 0, -0.5, 0.9, e.accent, 0.1 + e.night * 0.22);
}

function drawCar(g, s, e) {
  const c = e.tone(s.color);
  const glass = e.tone(mix('#2a3a4a', e.tod.sky[1], 0.4));
  const W = 3.1;
  g.save();
  g.translate(-W / 2, 0);
  g.scale(W, 1);
  g.beginPath();
  g.moveTo(0.015, -0.36);
  g.quadraticCurveTo(0.03, -0.52, 0.18, -0.55);
  g.lineTo(0.3, -0.58);
  g.quadraticCurveTo(0.39, -0.93, 0.52, -0.93);
  g.lineTo(0.68, -0.93);
  g.quadraticCurveTo(0.76, -0.9, 0.84, -0.6);
  g.quadraticCurveTo(0.97, -0.58, 0.985, -0.44);
  g.lineTo(0.99, -0.26);
  g.quadraticCurveTo(0.99, -0.18, 0.95, -0.17);
  g.lineTo(0.03, -0.17);
  g.quadraticCurveTo(0.005, -0.2, 0.015, -0.36);
  g.closePath();
  g.fillStyle = lin(g, 0, -0.95, 0, -0.17, [[0, lighten(c, 0.3)], [0.5, c], [1, darken(c, 0.42)]]);
  g.fill();
  // 车窗
  g.beginPath();
  g.moveTo(0.335, -0.585);
  g.quadraticCurveTo(0.41, -0.87, 0.52, -0.87);
  g.lineTo(0.585, -0.87);
  g.lineTo(0.585, -0.585);
  g.closePath();
  g.fillStyle = glass;
  g.fill();
  g.beginPath();
  g.moveTo(0.605, -0.87);
  g.lineTo(0.67, -0.87);
  g.quadraticCurveTo(0.73, -0.86, 0.79, -0.6);
  g.lineTo(0.605, -0.585);
  g.closePath();
  g.fillStyle = glass;
  g.fill();
  // 腰线 + 门缝
  rect(g, 0.05, -0.47, 0.92, 0.012, rgba('#ffffff', 0.26));
  rect(g, 0.595, -0.58, 0.003, 0.4, rgba('#000', 0.3));
  rect(g, 0.33, -0.58, 0.003, 0.4, rgba('#000', 0.3));
  g.restore();
  // 车灯
  const on = e.night > 0.1 || e.dramatic;
  ellipse(g, W / 2 - 0.05, -0.42, 0.05, 0.03, on ? '#fff3cc' : lighten(c, 0.4));
  if (on) glow(g, W / 2 + 0.1, -0.42, 0.8, '#fff3cc', 0.52);
  ellipse(g, -W / 2 + 0.05, -0.42, 0.045, 0.03, '#d13030');
  if (on) glow(g, -W / 2, -0.42, 0.4, '#ff3030', 0.4);
  // 车轮：确定性转动
  for (const x of [-W * 0.3, W * 0.3]) {
    circle(g, x, -0.15, 0.17, '#0f1014');
    circle(g, x, -0.15, 0.1, e.tone('#a9adb4'));
    circle(g, x, -0.15, 0.032, e.tone('#50545a'));
    const a = e.p * 18;
    for (let i = 0; i < 5; i += 1) {
      line(g, x, -0.15, x + Math.cos(a + (i * TAU) / 5) * 0.095, -0.15 + Math.sin(a + (i * TAU) / 5) * 0.095, e.tone('#50545a'), 0.016);
    }
  }
}

function drawBox(g, s, e, p) {
  const c = e.tone(s.color);
  const sc = spinScale(s, p);
  g.save();
  g.scale(sc, 1);
  const w = 0.72;
  const d = 0.26;
  // 正面 + 侧面 + 顶面
  poly(g, [-w / 2, -0.74, w / 2, -0.74, w / 2, 0, -w / 2, 0], lin(g, 0, -0.74, 0, 0, [[0, lighten(c, 0.1)], [1, darken(c, 0.16)]]));
  poly(g, [w / 2, -0.74, w / 2 + d, -0.9, w / 2 + d, -0.16, w / 2, 0], darken(c, 0.32));
  poly(g, [-w / 2, -0.74, -w / 2 + d, -0.9, w / 2 + d, -0.9, w / 2, -0.74], lighten(c, 0.24));
  // 丝带
  const r = e.tone(e.paper);
  rect(g, -0.05, -0.74, 0.1, 0.74, r);
  poly(g, [-0.05, -0.74, -0.05 + d, -0.9, 0.05 + d, -0.9, 0.05, -0.74], lighten(r, 0.1));
  poly(g, [-w / 2 + d * 0.5, -0.82, w / 2 + d * 0.5, -0.82, w / 2 + d * 0.5, -0.8, -w / 2 + d * 0.5, -0.8], lighten(r, 0.1));
  ellipse(g, d * 0.5 - 0.1, -0.86, 0.11, 0.05, r, -0.3);
  ellipse(g, d * 0.5 + 0.1, -0.86, 0.11, 0.05, r, 0.3);
  circle(g, d * 0.5, -0.84, 0.04, darken(r, 0.1));
  g.restore();
}

function drawFood(g, s, e, p) {
  const plate = e.tone(mix(e.paper, '#ffffff', 0.5));
  ellipse(g, 0, -0.08, 1.2, 0.2, darken(plate, 0.32));
  ellipse(g, 0, -0.12, 1.18, 0.19, plate);
  ellipse(g, 0, -0.13, 0.84, 0.13, darken(plate, 0.1));
  // 食物主体：叠层蛋糕
  const c = e.tone(mix('#d9a56a', s.color, 0.4));
  const cream = e.tone('#f7efe2');
  const dark = e.tone('#6a3a22');
  rr(g, -0.54, -0.5, 1.08, 0.38, 0.1, lin(g, -0.5, 0, 0.5, 0, [[0, darken(c, 0.24)], [0.4, lighten(c, 0.12)], [1, darken(c, 0.3)]]));
  rect(g, -0.54, -0.33, 1.08, 0.05, cream);
  rect(g, -0.54, -0.25, 1.08, 0.04, dark);
  ellipse(g, 0, -0.5, 0.54, 0.09, lighten(c, 0.26));
  for (let i = 0; i < 6; i += 1) {
    const x = -0.4 + i * 0.16;
    const hgt = 0.1 + (i % 2) * 0.05;
    g.beginPath();
    g.moveTo(x - 0.06, -0.5);
    g.quadraticCurveTo(x - 0.05, -0.5 - hgt, x, -0.5 - hgt - 0.05);
    g.quadraticCurveTo(x + 0.05, -0.5 - hgt, x + 0.06, -0.5);
    g.closePath();
    g.fillStyle = cream;
    g.fill();
  }
  circle(g, -0.05, -0.74, 0.1, e.tone(mix('#c23a3a', s.color, 0.3)));
  circle(g, -0.08, -0.77, 0.025, rgba('#ffffff', 0.6));
  line(g, -0.05, -0.82, 0.02, -0.92, e.tone('#4a7a3a'), 0.018);
  if (s.action === 'rotate' || s.action === 'idle') steam(g, 0.1, -0.86, p * 0.7, e.tone('#ffffff'), 0.1);
}

function drawLaptop(g, s, e, p) {
  const c = e.tone(mix('#a9adb4', s.color, 0.16));
  const open = s.action === 'raise' ? 0.45 + 0.55 * easeInOut(p * 1.8) : 1;
  const W = 1.6;
  // 底座（透视梯形）
  poly(g, [-W / 2 + 0.1, -0.16, W / 2 - 0.1, -0.16, W / 2 + 0.06, 0, -W / 2 - 0.06, 0], lin(g, 0, -0.16, 0, 0, [[0, lighten(c, 0.18)], [1, darken(c, 0.14)]]));
  for (let r = 0; r < 3; r += 1) {
    rect(g, -W / 2 + 0.2 - r * 0.02, -0.14 + r * 0.03, W - 0.4 + r * 0.04, 0.02, rgba('#000', 0.3));
  }
  poly(g, [-0.16, -0.035, 0.16, -0.035, 0.18, -0.008, -0.18, -0.008], rgba('#000', 0.16));
  // 屏幕（翻开角度决定高度）
  const hgt = 0.86 * open;
  g.save();
  g.translate(0, -0.15);
  rr(g, -W / 2 + 0.08, -hgt, W - 0.16, hgt, 0.03, darken(c, 0.5));
  const sx = -W / 2 + 0.12;
  const sw = W - 0.24;
  const sh = hgt - 0.06;
  const top = -hgt + 0.035;
  rect(g, sx, top, sw, sh, lin(g, 0, top, 0, top + sh, [[0, e.tone(mix('#2d4a72', e.accent, 0.25))], [1, e.tone(mix('#101a2c', e.base, 0.3))]]));
  // 屏幕内容：时间线样式
  if (open > 0.8) {
    const barY = top + sh * 0.68;
    rect(g, sx + 0.05, top + 0.05, sw * 0.58, sh * 0.5, rgba('#ffffff', 0.13));
    rect(g, sx + sw * 0.66, top + 0.05, sw * 0.28, sh * 0.5, rgba('#ffffff', 0.08));
    for (let i = 0; i < 9; i += 1) rect(g, sx + 0.05 + i * (sw - 0.1) / 9, barY, (sw - 0.1) / 9 - 0.008, sh * 0.12, rgba(i % 3 ? e.accent : '#ffffff', 0.35));
    rect(g, sx + 0.05, barY + sh * 0.15, (sw - 0.1) * ((p * 1.2) % 1), 0.012, rgba(e.accent, 0.8));
  }
  g.restore();
  glow(g, 0, -0.56, 1.3, mix('#7fb4ff', e.accent, 0.3), 0.1 + e.night * 0.26);
}

function drawPotPlant(g, s, e) {
  drawPlant(g, 0, 0, 1.25, e, s.seed);
}

const OBJECTS = { product: drawProduct, cup: drawCup, phone: drawPhone, car: drawCar, box: drawBox, food: drawFood, laptop: drawLaptop, plant: drawPotPlant };

function contactShadow(g, x, y, rx, ry, e, strength = 1) {
  const ox = -e.keyX * rx * 0.3;
  const a = (e.dramatic ? 0.62 : 0.46) * strength;
  g.save();
  g.translate(x + ox, y);
  g.scale(1, ry / rx);
  g.fillStyle = rad(g, 0, 0, 0, rx, [[0, `rgba(0,0,0,${a})`], [0.6, `rgba(0,0,0,${a * 0.52})`], [1, 'rgba(0,0,0,0)']]);
  g.fillRect(-rx, -rx, rx * 2, rx * 2);
  g.restore();
}

function subjectDelta(s, primary) {
  return (primary.y - s.y) * 0.5;
}

function subjectWorldX(s, cam, p) {
  const zref = Math.max(0.55, cam.zoom);
  let x = s.x;
  // 特写时把主体往中间收，避免半张脸出画
  if (cam.zoom > 2) x = 0.5 + (x - 0.5) * (1 - clamp01((cam.zoom - 2) / 3) * 0.7);
  let wx = ((x - 0.5) * cam.A) / zref;
  const dir = walkDir(s.action);
  if (dir) wx += dir * (p - 0.5) * 0.62 * Math.min(1, 1 / Math.max(cam.zoom, 0.4));
  return wx;
}

function drawSubjects(g, e, w, h, cam, p) {
  const spec = e.spec;
  const list = spec.subjects.filter((s) => s.kind !== 'text');
  if (!list.length) return;
  const primary = list[0];
  // 远的先画
  const ordered = [...list].sort((a, b) => a.y - b.y);
  const hasPerson = list.some((s) => s.kind === 'person');
  const primaryIsSmall = primary.kind !== 'person' && !GROUND_OBJECTS.has(primary.kind);
  let surfaceDrawn = false;
  const surfaceOnce = () => {
    if (surfaceDrawn) return;
    surfaceDrawn = true;
    drawSurface(g, e, w, h, cam);
  };
  // 小物件为主体时先画承托面；人物若在它后面，先画人
  const peopleFirst = ordered.filter((s) => primaryIsSmall && s.kind === 'person');
  const rest = ordered.filter((s) => !(primaryIsSmall && s.kind === 'person'));
  const drawOne = (s) => {
    const delta = subjectDelta(s, primary) + (primaryIsSmall && s.kind === 'person' ? 0.16 : 0);
    withLayer(g, w, h, cam, delta, (view) => {
      const x = subjectWorldX(s, cam, p);
      if (s.kind === 'person') {
        const H = PERSON_H * s.scale;
        const px = H * view.Zl * h;
        const G = e.G;
        const shadowLift = 1 - Math.min(1, personLift(s, p) * 2.6);
        contactShadow(g, x, G, 0.2 * H * (0.7 + shadowLift * 0.3), 0.045 * H, e, shadowLift);
        g.save();
        g.translate(x, G);
        const squeeze = cam.angle === 'high' ? 0.93 : cam.angle === 'low' ? 1.06 : 1;
        g.scale(H, H * squeeze);
        drawPerson(g, s, e, px, p, { shadowLift, blur: s === primary ? 0 : cam.blurMid * 0.6 * Math.abs(delta) * 3 });
        g.restore();
      } else {
        const small = !GROUND_OBJECTS.has(s.kind);
        const secondary = s !== primary && (hasPerson || primary.kind === 'person');
        const H = objectHeight(s.kind, s.scale, primary.kind === 'person' || secondary);
        let base = e.G;
        if (small) {
          base = cam.tableTop;
          if (primary.kind === 'person' || GROUND_OBJECTS.has(primary.kind)) sideTable(g, x, base, e.G, e);
        }
        const riser = small && primaryIsSmall && s === primary && spec.setting === 'studio';
        if (riser) drawRiser(g, x, base, H, e, cam);
        contactShadow(g, x, base, H * (riser ? 0.42 : s.kind === 'car' ? 1.8 : 0.7), H * 0.09, e);
        const surf = SCENES[spec.setting].surface;
        if (small && surf && surf.reflect && primaryIsSmall) {
          // 高光台面的倒影（放在圆台上时只出现在圆台顶面里）
          g.save();
          if (riser) {
            const { R, ry } = riserGeom(base, H, cam);
            g.beginPath();
            g.ellipse(x, base, R, ry, 0, 0, TAU);
            g.clip();
          }
          g.translate(x, base);
          g.scale(H, -H * 0.55);
          g.globalAlpha = riser ? 0.22 : 0.16;
          const fn = OBJECTS[s.kind];
          if (fn) fn(g, s, e, p);
          g.restore();
        }
        g.save();
        g.translate(x, base);
        g.scale(H, H);
        const fn = OBJECTS[s.kind];
        if (fn) fn(g, s, e, p);
        g.restore();
      }
    });
  };
  peopleFirst.forEach(drawOne);
  if (primaryIsSmall) surfaceOnce();
  rest.forEach(drawOne);
}

function personLift(s, p) {
  if (s.action !== 'jump') return 0;
  return personPose('jump', p, s.seed).lift;
}

// ---------------- 顶拍（俯视平面）----------------

function drawTopDown(ctx, e, w, h, cam, p) {
  const spec = e.spec;
  const u = Math.min(w, h);
  const scene = SCENES[spec.setting];
  const surface = scene.surface || { top: '#6a5a4a' };
  const base = e.tone(mix(surface.top, e.base, 0.08));
  ctx.fillStyle = base;
  ctx.fillRect(-w, -h, w * 3, h * 3);
  const Z = Math.pow(Math.max(0.3, cam.zoom), 0.62) * (cam.movement === 'push-in' ? 1 + 0.26 * easeInOut(p) : cam.movement === 'pull-out' ? 1.26 - 0.26 * easeInOut(p) : 1);
  ctx.save();
  ctx.translate(w / 2 + cam.sx * w, h / 2 + cam.sy * h);
  ctx.scale(Z, Z);
  ctx.translate(-w / 2, -h / 2);
  // 台面纹理
  if (surface.grain) {
    for (let i = -14; i < 30; i += 1) {
      rect(ctx, -w, i * h * 0.1, w * 3, h * 0.1 - 1, i % 2 ? rgba('#000000', 0.03) : rgba('#ffffff', 0.025));
      rect(ctx, -w, i * h * 0.1, w * 3, Math.max(1, h * 0.0016), rgba('#000000', 0.22));
    }
  } else if (surface.marble) {
    for (let i = 0; i < 8; i += 1) {
      ctx.strokeStyle = rgba('#8a8a90', 0.26);
      ctx.lineWidth = u * 0.002;
      ctx.beginPath();
      let x = hash01(i, 1) * w;
      let y = -h * 0.1;
      ctx.moveTo(x, y);
      for (let k = 0; k < 9; k += 1) {
        x += (hash01(i * 7 + k, 2) - 0.5) * w * 0.14;
        y += h * 0.15;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
  const subjects = spec.subjects.filter((s) => s.kind !== 'text');
  subjects.forEach((s, i) => {
    const x = s.x * w;
    const y = (s.y * 0.8 + 0.1) * h;
    const r = u * 0.13 * s.scale;
    const c = e.tone(s.color);
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = rad(ctx, r * 0.1, r * 0.14, r * 0.2, r * 1.5, [[0, 'rgba(0,0,0,0.42)'], [1, 'rgba(0,0,0,0)']]);
    ctx.fillRect(-r * 2, -r * 2, r * 4, r * 4);
    switch (s.kind) {
      case 'person': {
        const a = (s.action === 'walk-left' ? Math.PI : s.action === 'walk-right' ? 0 : -Math.PI / 2) + Math.PI / 2;
        ctx.rotate(a);
        ellipse(ctx, 0, 0, r * 0.62, r * 0.32, lighten(c, 0.06));
        circle(ctx, 0, 0, r * 0.24, e.tone(HAIR[Math.abs(s.seed) % HAIR.length]));
        break;
      }
      case 'cup':
        circle(ctx, 0, 0, r * 0.85, e.tone(lighten(e.paper, 0.2)));
        circle(ctx, 0, 0, r * 0.5, e.tone(darken(e.paper, 0.05)));
        circle(ctx, 0, 0, r * 0.42, e.tone('#4a2b1a'));
        circle(ctx, 0, 0, r * 0.26, e.tone('#c9a27c'));
        circle(ctx, 0, 0, r * 0.13, e.tone('#4a2b1a'));
        rr(ctx, r * 0.46, -r * 0.08, r * 0.3, r * 0.16, r * 0.04, e.tone(lighten(e.paper, 0.1)));
        break;
      case 'food':
        circle(ctx, 0, 0, r * 1.05, e.tone('#f4efe6'));
        circle(ctx, 0, 0, r * 0.82, e.tone('#e4dccc'));
        circle(ctx, 0, 0, r * 0.56, e.tone(mix('#d9a56a', s.color, 0.4)));
        for (let k = 0; k < 7; k += 1) circle(ctx, Math.cos(k * 0.9) * r * 0.34, Math.sin(k * 0.9) * r * 0.34, r * 0.1, e.tone(k % 2 ? '#c23a3a' : '#f7efe2'));
        break;
      case 'phone':
        rr(ctx, -r * 0.42, -r * 0.82, r * 0.84, r * 1.64, r * 0.1, e.tone('#17181d'));
        rr(ctx, -r * 0.37, -r * 0.76, r * 0.74, r * 1.52, r * 0.07, e.tone(mix(e.accent, '#4a7fd0', 0.4)));
        break;
      case 'laptop':
        rr(ctx, -r * 1.05, -r * 0.7, r * 2.1, r * 1.4, r * 0.06, e.tone('#a9adb4'));
        rr(ctx, -r * 0.92, -r * 0.56, r * 1.84, r * 0.78, r * 0.03, e.tone('#2a2c32'));
        rr(ctx, -r * 0.3, r * 0.3, r * 0.6, r * 0.28, r * 0.03, e.tone('#8a8e94'));
        break;
      case 'car':
        rr(ctx, -r * 1.3, -r * 0.6, r * 2.6, r * 1.2, r * 0.3, c);
        rr(ctx, -r * 0.5, -r * 0.46, r * 1.1, r * 0.92, r * 0.16, e.tone('#2a3440'));
        break;
      case 'plant':
        circle(ctx, 0, 0, r * 0.5, e.tone('#7c5b40'));
        for (let k = 0; k < 10; k += 1) {
          const a = (k / 10) * TAU;
          ellipse(ctx, Math.cos(a) * r * 0.62, Math.sin(a) * r * 0.62, r * 0.5, r * 0.18, e.tone(k % 2 ? '#3f7a52' : '#5a9a63'), a);
        }
        break;
      case 'box':
        rr(ctx, -r * 0.8, -r * 0.8, r * 1.6, r * 1.6, r * 0.04, c);
        rect(ctx, -r * 0.1, -r * 0.8, r * 0.2, r * 1.6, e.tone(e.paper));
        rect(ctx, -r * 0.8, -r * 0.1, r * 1.6, r * 0.2, e.tone(e.paper));
        break;
      default:
        circle(ctx, 0, 0, r * 0.7, c);
        circle(ctx, -r * 0.2, -r * 0.2, r * 0.24, rgba('#ffffff', 0.34));
    }
    ctx.restore();
    void i;
  });
  ctx.restore();
}

// ---------------- 前景遮挡 ----------------

function drawForegroundAngle(ctx, e, w, h, cam) {
  if (cam.angle === 'over-shoulder') {
    const side = (primaryOf(e.spec)?.x ?? 0.5) < 0.5 ? 1 : -1;
    const x = side > 0 ? w * 0.86 : w * 0.14;
    depthGroup(ctx, 'fgos', w, h, h * 0.012, false, (g) => {
      const c = darken(e.tone(mix(e.base, '#20242e', 0.5)), 0.2);
      ellipse(g, x, h * 1.16, w * 0.3, h * 0.46, c);
      circle(g, x + side * w * 0.015, h * 0.6, h * 0.2, darken(c, 0.14));
      ellipse(g, x + side * w * 0.01, h * 0.47, h * 0.18, h * 0.13, e.tone('#1c1714'));
    });
  } else if (cam.angle === 'pov') {
    depthGroup(ctx, 'fgpov', w, h, h * 0.006, false, (g) => {
      const skin = e.tone('#d9a382');
      const sleeve = darken(e.tone(mix(e.base, '#2a3040', 0.4)), 0.14);
      g.lineCap = 'round';
      for (const s of [-1, 1]) {
        const x0 = w / 2 + s * w * 0.42;
        const x1 = w / 2 + s * w * 0.22;
        g.strokeStyle = sleeve;
        g.lineWidth = h * 0.13;
        g.beginPath();
        g.moveTo(x0, h * 1.12);
        g.lineTo(x1 + s * w * 0.04, h * 0.88);
        g.stroke();
        g.strokeStyle = skin;
        g.lineWidth = h * 0.092;
        g.beginPath();
        g.moveTo(x1 + s * w * 0.03, h * 0.87);
        g.lineTo(x1, h * 0.79);
        g.stroke();
      }
    });
  }
}

// ---------------- 光线 ----------------

function lightSource(e, w, h, cam) {
  const dir = e.spec.light.direction;
  if (dir === 'left') return { x: -w * 0.08, y: -h * 0.22, a: 0.62, spread: 0.5 };
  if (dir === 'right') return { x: w * 1.08, y: -h * 0.22, a: Math.PI - 0.62, spread: 0.5 };
  if (dir === 'top') return { x: w * 0.5, y: -h * 0.35, a: Math.PI / 2, spread: 0.55 };
  if (dir === 'back') {
    const first = e.spec.subjects.find((s) => s.kind !== 'text');
    const wx = first ? subjectWorldX(first, cam, e.p) : 0;
    const bx = w / 2 + cam.sx * w + (wx - cam.Tx) * h * cam.Z;
    const by = h * Math.min(0.5, Math.max(0.16, cam.yh + cam.sy - 0.08));
    return { x: bx + w * 0.06, y: by, a: Math.PI / 2, spread: 2.6, back: true };
  }
  return { x: w * 0.5, y: -h * 0.1, a: Math.PI / 2, spread: 0.9 };
}

function drawLight(ctx, e, w, h, cam, p) {
  const spec = e.spec;
  const { direction, mood } = spec.light;
  const strength = { bright: 0.42, soft: 0.34, dramatic: 0.62, night: 0.46 }[mood];
  ctx.save();

  // 环境明暗：背光一侧压暗（大面积明暗关系）；暗面带一点项目底色，而不是统一的灰蓝
  ctx.globalCompositeOperation = 'multiply';
  const shadeA = { bright: 0.1, soft: 0.17, dramatic: 0.42, night: 0.34 }[mood];
  const dark = rgba(mix(darken(e.base, 0.55), '#0e121e', 0.5), shadeA);
  if (direction === 'left' || direction === 'right') {
    const from = direction === 'left' ? 0 : w;
    const to = direction === 'left' ? w : 0;
    ctx.fillStyle = lin(ctx, from, 0, to, 0, [[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,1)'], [1, dark]]);
    ctx.fillRect(0, 0, w, h);
  } else if (direction === 'top') {
    ctx.fillStyle = rad(ctx, w / 2, h * 0.45, h * 0.2, Math.max(w, h) * 0.7, [[0, 'rgba(255,255,255,1)'], [1, dark]]);
    ctx.fillRect(0, 0, w, h);
  } else if (direction === 'back') {
    ctx.fillStyle = lin(ctx, 0, 0, 0, h, [[0, 'rgba(255,255,255,1)'], [0.55, `rgba(40,36,50,${shadeA * 0.4})`], [1, dark]]);
    ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();

  // 体积光：影棚是柔光箱，几乎看不到光束；室内窗光适中；户外最明显
  const src = lightSource(e, w, h, cam);
  const placeK = spec.setting === 'studio' ? 0.12 : e.indoor ? 0.3 : 0.38;
  const rayK = placeK * (mood === 'dramatic' ? 1.3 : mood === 'night' ? 0.6 : 1) * (direction === 'front' ? 0.4 : 1);
  if (cam.angle !== 'top-down') godRays(ctx, w, h, e, src, src.a, strength * rayK, p, src.spread);

  // 空气中的微尘：只在光里看得见
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const motes = Math.round(30 * (mood === 'dramatic' ? 1.4 : 1));
  const u = Math.min(w, h);
  if (u > 110) {
    for (let i = 0; i < motes; i += 1) {
      const sx = hash01(i, 11);
      const sy = hash01(i, 12);
      const drift = hash01(i, 13);
      let x = sx + (p * 0.06 + drift * 0.02) * (e.keyX >= 0 ? -1 : 1);
      x -= Math.floor(x);
      const y = (sy + p * 0.03 * (drift - 0.3) + 1) % 1;
      const bright = direction === 'left' ? 1 - x : direction === 'right' ? x : 0.7;
      const near = hash01(i, 16) > 0.85; // 少数离镜头很近：大而虚
      const r = u * (near ? 0.006 + hash01(i, 15) * 0.008 : 0.0009 + hash01(i, 15) * 0.0022);
      const a = (0.05 + 0.32 * bright * hash01(i, 14)) * (near ? 0.35 : 1);
      ctx.fillStyle = near ? rad(ctx, x * w, y * h, 0, r, [[0, rgba(lighten(e.key, 0.4), a)], [1, rgba(e.key, 0)]]) : rgba(lighten(e.key, 0.4), a);
      ctx.beginPath();
      ctx.arc(x * w, y * h, r, 0, TAU);
      ctx.fill();
    }
  }
  // 整体色温
  ctx.globalCompositeOperation = 'soft-light';
  ctx.fillStyle = rgba(e.key, mood === 'dramatic' ? 0.2 : 0.12);
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
  return src;
}

/** 镜头后期：辉光、光晕、调色、暗角、颗粒 */
function drawFinish(ctx, e, w, h, cam, p, src) {
  const mood = e.spec.light.mood;
  bloom(ctx, w, h, mood === 'dramatic' || e.night > 0.5 ? 0.55 : 0.4, rgba(mix(e.key, '#ffffff', 0.4), 1));
  const sunVisible = src.back || (!e.indoor && e.spec.timeOfDay === 'golden' && src.y > -h * 0.3);
  if (src.back && cam.angle !== 'top-down') lensFlare(ctx, w, h, src.x, src.y, e.key, mood === 'dramatic' ? 0.9 : 0.65);
  else if (sunVisible && cam.angle !== 'top-down') lensFlare(ctx, w, h, Math.max(w * 0.04, Math.min(w * 0.96, src.x)), Math.max(h * 0.04, src.y), e.key, 0.35);
  grade(ctx, w, h, e, p);
}
/** 逆光：光源在主体身后，光晕画在背景之上、主体之下，主体呈剪影并带轮廓光 */
function drawBackHalo(ctx, e, w, h, cam) {
  if (e.spec.light.direction !== 'back') return;
  const strength = { bright: 0.42, soft: 0.34, dramatic: 0.62, night: 0.46 }[e.spec.light.mood];
  const first = e.spec.subjects.find((s) => s.kind !== 'text');
  // 光晕跟着主体走：主体平面上的世界坐标换算到屏幕
  const wx = first ? subjectWorldX(first, cam, e.p) : 0;
  const bx = w / 2 + cam.sx * w + (wx - cam.Tx) * h * cam.Z;
  const by = h * Math.min(0.5, Math.max(0.2, cam.yh + cam.sy - 0.06));
  const r = Math.max(w, h) * 0.7;
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = rad(ctx, bx, by, 0, r, [[0, rgba(lighten(e.key, 0.35), Math.min(1, strength * 1.15))], [0.18, rgba(lighten(e.key, 0.15), strength * 0.7)], [0.5, rgba(e.key, strength * 0.22)], [1, rgba(e.key, 0)]]);
  ctx.fillRect(-w, -h, w * 3, h * 3);
  ctx.restore();
}

// ---------------- 叠加文字与标注 ----------------

function pill(ctx, x, y, text, size, bg, fg, align = 'left', dot = '') {
  ctx.font = `600 ${size}px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const padX = size * 0.62;
  const hgt = size * 1.72;
  const tw = ctx.measureText(text).width;
  const dw = dot ? size * 0.82 : 0;
  const bw = tw + padX * 2 + dw;
  const bx = align === 'right' ? x - bw : x;
  rr(ctx, bx, y, bw, hgt, hgt / 2, bg);
  if (dot) circle(ctx, bx + padX + size * 0.26, y + hgt / 2, size * 0.26, dot);
  ctx.fillStyle = fg;
  ctx.fillText(text, bx + padX + dw, y + hgt / 2 + size * 0.04);
  return { x: bx, y, w: bw, h: hgt };
}

/** 画面上的图形字（片名、品牌名）：白字或浅色字，配柔和投影与一条强调色短线，保证在任何背景上都清楚 */
function drawSubjectText(ctx, e, w, h, p) {
  const u = Math.min(w, h);
  for (const s of e.spec.subjects) {
    if (s.kind !== 'text' || !s.label) continue;
    const size = Math.round(u * 0.08 * s.scale);
    const inP = easeInOut(p / 0.2);
    const light = luma(s.color) > 0.62;
    const x = s.x * w;
    const y = s.y * h + (1 - inP) * size * 0.4;
    ctx.save();
    ctx.globalAlpha = inP;
    ctx.font = `800 ${size}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${(size * 0.04).toFixed(1)}px`;
    const tw = Math.min(w * 0.9, ctx.measureText(s.label).width);
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = size * 0.28;
    ctx.shadowOffsetY = size * 0.04;
    // 浅色保持原色；深色或中间色改用白字，原色用在下方的短线上
    ctx.fillStyle = light ? s.color : '#ffffff';
    ctx.fillText(s.label, x, y, w * 0.9);
    ctx.shadowColor = 'transparent';
    const bar = light ? e.accent : s.color;
    rr(ctx, x - Math.min(tw * 0.18, size * 1.2), y + size * 0.7, Math.min(tw * 0.36, size * 2.4) * inP, Math.max(2, size * 0.07), size * 0.035, bar);
    ctx.restore();
  }
}

function drawOverlayText(ctx, spec, w, h) {
  if (!spec.overlayText) return;
  const u = Math.min(w, h);
  const size = Math.max(11, Math.round(u * 0.058));
  ctx.save();
  ctx.font = `700 ${size}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${size * 0.08}px`;
  ctx.shadowColor = 'rgba(0,0,0,0.65)';
  ctx.shadowBlur = size * 0.4;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(spec.overlayText, w / 2, h * 0.72, w * 0.86);
  ctx.restore();
}

function subjectLabels(ctx, e, w, h, cam, p) {
  const u = Math.min(w, h);
  if (u < 240) return;
  const list = e.spec.subjects.filter((s) => s.kind !== 'text' && s.label);
  if (!list.length) return;
  const primary = primaryOf(e.spec);
  const size = Math.max(10, Math.round(u * 0.018));
  for (const s of list) {
    const delta = subjectDelta(s, primary);
    const Zl = cam.zoomAt(delta);
    const x = w / 2 + cam.sx * w + (subjectWorldX(s, cam, p) - cam.Tx) * Zl * h;
    const headY = s.kind === 'person' ? e.G - PERSON_H * s.scale : (GROUND_OBJECTS.has(s.kind) ? e.G : cam.tableTop) - objectHeight(s.kind, s.scale, false);
    const y = (cam.yh + cam.sy + headY * Zl) * h - size * 2.4;
    if (x < 0 || x > w) continue;
    const yy = Math.max(h * 0.1, Math.min(h * 0.86, y));
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.42)';
    ctx.lineWidth = Math.max(1, u * 0.001);
    ctx.beginPath();
    ctx.moveTo(x, yy + size * 1.72);
    ctx.lineTo(x, yy + size * 2.3);
    ctx.stroke();
    ctx.font = `600 ${size}px ${FONT}`;
    const tw = ctx.measureText(s.label).width;
    pill(ctx, Math.max(4, Math.min(w - tw - size * 2, x - tw / 2 - size * 0.62)), yy, s.label, size, 'rgba(12,14,18,0.46)', 'rgba(255,255,255,0.92)');
    ctx.restore();
  }
}

function movementGlyph(movement) {
  return {
    'push-in': '▲', 'pull-out': '▼', 'pan-left': '◀', 'pan-right': '▶', 'tilt-up': '▲', 'tilt-down': '▼', shake: '≈', handheld: '≈', 'zoom-punch': '◆', drift: '↗', orbit: '↻', tracking: '→',
  }[movement] || '';
}

/**
 * 标注层：取景角标、景别 / 运镜标签、「AI 预演」水印、镜头标题。整体做得轻：小字、半透明底、圆角胶囊，
 * 不抢画面。opts.corners === false 不画角标；opts.shotInfo === false 不画景别标签（导出成片时可只留水印）。
 */
function drawHud(ctx, spec, cam, w, h, opts) {
  const u = Math.min(w, h);
  const showWatermark = opts.watermark !== false;
  const margin = Math.max(5, Math.round(u * 0.024));
  const size = Math.max(9, Math.round(u * 0.02));

  if (opts.corners !== false && (u >= 150 || w >= 240)) {
    // 取景框角标
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = Math.max(1, u * 0.0014);
    const m = margin * 0.5;
    const l = u * 0.032;
    ctx.beginPath();
    for (const [x, y, dx, dy] of [[m, m, 1, 1], [w - m, m, -1, 1], [m, h - m, 1, -1], [w - m, h - m, -1, -1]]) {
      ctx.moveTo(x + dx * l, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y + dy * l);
    }
    ctx.stroke();
    ctx.restore();
  }

  if (opts.shotInfo !== false && w >= 220) {
    const size0 = SHOT_SIZE_LABELS[cam.shotSize] || '镜头';
    const mv = SHOT_MOVEMENT_LABELS[cam.movement];
    const angle = cam.angle !== 'eye-level' ? ANGLE_LABELS[cam.angle] : '';
    const glyph = movementGlyph(cam.movement);
    const parts = [size0];
    if (angle) parts.push(angle);
    if (mv && cam.movement !== 'static' && cam.movement !== 'none') parts.push(`${glyph ? glyph + ' ' : ''}${mv}`);
    pill(ctx, margin, margin, parts.join(' · '), size, 'rgba(12,14,18,0.42)', 'rgba(255,255,255,0.92)');
  }
  if (showWatermark) {
    pill(ctx, w - margin, margin, 'AI 预演', size, 'rgba(12,14,18,0.46)', 'rgba(255,255,255,0.94)', 'right', '#a98bff');
  }
  if (opts.label) {
    const ls = Math.max(10, Math.round(u * 0.028));
    ctx.save();
    ctx.font = `600 ${ls}px ${FONT}`;
    const text = String(opts.label).slice(0, 40);
    const tw = Math.min(w * 0.86, ctx.measureText(text).width);
    const bh = ls * 1.8;
    const by = h - margin - bh;
    rr(ctx, w / 2 - tw / 2 - ls * 0.8, by, tw + ls * 1.6, bh, bh / 2, 'rgba(12,14,18,0.48)');
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, by + bh / 2 + ls * 0.04, w * 0.86);
    ctx.restore();
  }
}

// ---------------- 入口 ----------------

/**
 * 画一帧预演。
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} specIn PrevizSpec（缺字段自动补默认）
 * @param {number} progress 0..1
 * @param {{label?:string, watermark?:boolean, shotSize?:string, movement?:string, hud?:boolean, labels?:boolean, corners?:boolean, shotInfo?:boolean}} [opts]
 *   hud=false 时不画标注层（由 compositor 在调色之后用 drawPrevizHud 单独画）；
 *   labels=false 不画主体名称；corners / shotInfo=false 分别不画取景角标、景别标签
 */
export function drawPreviz(ctx, specIn, progress, w, h, optsIn = {}) {
  if (!okSize(w, h)) return;
  const opts = optsIn || {};
  const spec = normalizeSpec(specIn);
  if (SCENES[spec.setting].forceNight && spec.timeOfDay !== 'night' && spec.timeOfDay !== 'blue') spec.timeOfDay = 'night';
  const p = clamp01(progress);
  const cam = previzCamera(spec, p, w, h, opts);
  const e = buildEnv(spec, cam, p);
  const scene = SCENES[spec.setting];

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.imageSmoothingEnabled = true;

  // 整体摄影机：倾斜、晃动、冲击变焦都是绕画面中心
  ctx.save();
  ctx.translate(w / 2, h / 2);
  if (cam.rot) ctx.rotate((cam.rot * Math.PI) / 180);
  const cover = cam.rot ? 1 + Math.abs(Math.sin((cam.rot * Math.PI) / 180)) * Math.max(w / h, h / w) : 1;
  ctx.scale(cam.punch * cover, cam.punch * cover);
  ctx.translate(-w / 2, -h / 2);

  if (cam.angle === 'top-down') {
    drawTopDown(ctx, e, w, h, cam, p);
  } else {
    depthGroup(ctx, 'far', w, h, cam.blurFar, true, (g) => {
      if (scene.sky) skyFill(g, w, h, e, (cam.yh + cam.sy) * h);
      else { g.fillStyle = scene.wall(e); g.fillRect(-w, -h, w * 3, h * 3); }
      withLayer(g, w, h, cam, FAR, (v) => scene.far.call(scene, g, e, v));
      drawFloor(g, e, w, h, cam);
      if (scene.ground) scene.ground.call(scene, g, e, w, h, cam);
      if (scene.onFloor) withLayer(g, w, h, cam, MID * 0.6, () => scene.onFloor(g, e));
    });
    if (scene.mid) depthGroup(ctx, 'mid', w, h, cam.blurMid, false, (g) => withLayer(g, w, h, cam, MID, (v) => scene.mid.call(scene, g, e, v)));
    paintTexture(ctx, w, h, e, 1);
    atmosphere(ctx, w, h, e, cam);
    drawBackHalo(ctx, e, w, h, cam);
    drawSubjects(ctx, e, w, h, cam, p);
    if (scene.fg) withLayer(ctx, w, h, cam, -0.12, (v) => scene.fg.call(scene, ctx, e, v));
    drawForegroundAngle(ctx, e, w, h, cam);
  }
  ctx.restore();

  const src = drawLight(ctx, e, w, h, cam, p);
  drawFinish(ctx, e, w, h, cam, p, src);
  drawSubjectText(ctx, e, w, h, p);
  drawOverlayText(ctx, spec, w, h);
  // 主体名称标注只在带标注层的预览里画；成片（hud=false，由 compositor 画）里不出现
  if (opts.hud !== false) {
    if (opts.labels !== false) subjectLabels(ctx, e, w, h, cam, p);
    drawHud(ctx, spec, cam, w, h, opts);
  }
  ctx.restore();
}

/**
 * 只画标注层（景别 / 运镜标签、「AI 预演」水印、镜头标题、取景角标）。
 * compositor 用它把标注画在调色和运镜之后，标注不会被推近放大或被调色染色。
 */
export function drawPrevizHud(ctx, specIn, progress, w, h, optsIn = {}) {
  if (!okSize(w, h)) return;
  const opts = optsIn || {};
  const spec = normalizeSpec(specIn);
  const cam = previzCamera(spec, clamp01(progress), w, h, opts);
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  drawHud(ctx, spec, cam, w, h, opts);
  ctx.restore();
}
