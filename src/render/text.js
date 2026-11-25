// 文字绘制：镜头字幕（caption）与文字轨（TextClip）。字号全部按画幅短边缩放，横竖屏观感一致。

import { clamp01, easeOutCubic, easeInOut } from './motion.js';

export const FONT_SANS = '"Microsoft YaHei UI","Microsoft YaHei","Segoe UI","PingFang SC","Noto Sans CJK SC",sans-serif';
export const FONT_HAND = '"KaiTi","STKaiti","Kaiti SC","Georgia","Times New Roman",serif';

// 行首不能出现的标点、行尾不能出现的标点（中文排版禁则）
const NO_LINE_START = '，。、；：！？）》」』】”’,.;:!?)]}%…—';
const NO_LINE_END = '（《「『【“‘([{';

/** 拆成不可分割的排版单元：每个汉字一个单元，连续的拉丁文 / 数字整词一个单元 */
function tokenize(text) {
  const tokens = [];
  const re = /[A-Za-z0-9][A-Za-z0-9'’\-_.]*\s*|\s+|[\s\S]/gu;
  let m;
  while ((m = re.exec(text))) tokens.push(m[0]);
  return tokens;
}

/**
 * 自动换行。支持 \n 硬换行、中英混排、行首标点回拉。
 * @param {{measureText:(s:string)=>{width:number}}} ctx
 * @returns {string[]}
 */
export function wrapText(ctx, text, maxWidth) {
  const out = [];
  for (const para of String(text == null ? '' : text).split(/\r?\n/)) {
    let line = '';
    for (const token of tokenize(para)) {
      const candidate = line + token;
      if (!line || ctx.measureText(candidate.trimEnd()).width <= maxWidth) {
        line = candidate;
        continue;
      }
      if (NO_LINE_START.includes(token[0])) {
        // 标点不放行首：宁可让它挤在上一行末尾
        line = candidate;
        continue;
      }
      const tail = line[line.length - 1];
      if (NO_LINE_END.includes(tail) && line.length > 1) {
        out.push(line.slice(0, -1).trimEnd());
        line = tail + token;
      } else {
        out.push(line.trimEnd());
        line = token.trimStart();
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

function hexToRgb(hex) {
  const s = String(hex || '').trim();
  const m6 = /^#([0-9a-f]{6})$/i.exec(s);
  if (m6) {
    const n = parseInt(m6[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m3 = /^#([0-9a-f]{3})$/i.exec(s);
  if (m3) return [...m3[1]].map((c) => parseInt(c + c, 16));
  return null;
}

function rgba(hex, a) {
  const c = hexToRgb(hex) || [255, 255, 255];
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

function isNearWhite(hex) {
  const c = hexToRgb(hex);
  return !c || (c[0] > 225 && c[1] > 225 && c[2] > 225);
}

function setFont(ctx, weight, size, family = FONT_SANS, italic = false) {
  ctx.font = `${italic ? 'italic ' : ''}${weight} ${size}px ${family}`;
}

function setSpacing(ctx, px) {
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${px}px`;
}

function clearEffects(ctx) {
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

/** 字幕描边 + 柔和投影：浅色背景上也能读 */
function softOutlinedText(ctx, text, x, y, size, fillStyle) {
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = size * 0.26;
  ctx.shadowOffsetY = size * 0.05;
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = size * 0.13;
  ctx.strokeText(text, x, y);
  clearEffects(ctx);
  ctx.strokeStyle = 'rgba(0,0,0,0.72)';
  ctx.lineWidth = size * 0.055;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fillStyle;
  ctx.fillText(text, x, y);
}

/** 镜头字幕两端的短淡入淡出，避免硬切 */
function captionEnvelope(progress) {
  const p = clamp01(progress);
  return clamp01(Math.min(p / 0.04, (1 - p) / 0.04));
}

/**
 * 镜头内字幕。
 * @param {{text:string, style:string, position:string}} caption
 * @param {number} progress 0..1 镜头内进度
 * @param {{alpha?:number}} [opts] 转场期间由 compositor 传入淡入淡出系数
 */
export function drawCaption(ctx, caption, w, h, progress = 0.5, opts = {}) {
  if (!caption || !caption.text || caption.style === 'none') return;
  const text = String(caption.text).trim();
  if (!text) return;
  const alpha = captionEnvelope(progress) * (opts.alpha == null ? 1 : clamp01(opts.alpha));
  if (alpha <= 0.002) return;
  const u = Math.min(w, h);
  const style = caption.style || 'subtitle';
  const position = caption.position || 'bottom';

  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.textBaseline = 'middle';

  if (style === 'title') drawCaptionTitle(ctx, text, w, h, u, position);
  else if (style === 'lower-third') drawCaptionLowerThird(ctx, text, w, h, u, position);
  else drawCaptionSubtitle(ctx, text, w, h, u, position);

  ctx.restore();
}

function anchorY(position, h, blockH, margin) {
  if (position === 'top') return margin + blockH / 2;
  if (position === 'center') return h / 2;
  return h - margin - blockH / 2;
}

function drawCaptionSubtitle(ctx, text, w, h, u, position) {
  let size = Math.round(u * 0.047);
  ctx.textAlign = 'center';
  setFont(ctx, 600, size);
  setSpacing(ctx, size * 0.02);
  const maxW = w * 0.84;
  let lines = wrapText(ctx, text, maxW);
  if (lines.length > 2) {
    // 字幕超过两行时收一点字号，尽量不遮画面
    size = Math.round(size * 0.86);
    setFont(ctx, 600, size);
    setSpacing(ctx, size * 0.02);
    lines = wrapText(ctx, text, maxW);
  }
  const lh = size * 1.36;
  const blockH = lh * lines.length;
  const cy = anchorY(position, h, blockH, h * 0.075);
  lines.forEach((line, i) => {
    softOutlinedText(ctx, line, w / 2, cy - blockH / 2 + lh * (i + 0.5), size, '#ffffff');
  });
}

function drawCaptionTitle(ctx, text, w, h, u, position) {
  const size = Math.round(u * 0.082);
  ctx.textAlign = 'center';
  setFont(ctx, 700, size);
  setSpacing(ctx, size * 0.08);
  const lines = wrapText(ctx, text, w * 0.8);
  const lh = size * 1.28;
  const blockH = lh * lines.length;
  const cy = anchorY(position === 'bottom' ? 'center' : position, h, blockH, h * 0.14);
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = size * 0.4;
  ctx.shadowOffsetY = size * 0.05;
  ctx.fillStyle = '#ffffff';
  lines.forEach((line, i) => ctx.fillText(line, w / 2, cy - blockH / 2 + lh * (i + 0.5)));
  clearEffects(ctx);
  const rule = size * 1.4;
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.fillRect(w / 2 - rule / 2, cy + blockH / 2 + size * 0.22, rule, Math.max(1, size * 0.03));
}

function drawCaptionLowerThird(ctx, text, w, h, u, position) {
  const size = Math.round(u * 0.04);
  ctx.textAlign = 'left';
  setFont(ctx, 600, size);
  setSpacing(ctx, size * 0.03);
  const lines = wrapText(ctx, text, w * 0.56);
  const lh = size * 1.4;
  const padX = size * 0.8;
  const padY = size * 0.5;
  const textW = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const boxW = textW + padX * 2;
  const boxH = lh * lines.length + padY * 2;
  const x = w * 0.06;
  const cy = anchorY(position, h, boxH, h * 0.09);
  const y = cy - boxH / 2;
  ctx.fillStyle = 'rgba(12,14,18,0.68)';
  roundedRect(ctx, x, y, boxW, boxH, size * 0.14);
  ctx.fill();
  ctx.fillStyle = '#e0a96d';
  ctx.fillRect(x, y, Math.max(3, size * 0.12), boxH);
  ctx.fillStyle = '#ffffff';
  lines.forEach((line, i) => ctx.fillText(line, x + padX, y + padY + lh * (i + 0.5)));
}

// ---------------- TextClip ----------------

const ENTER = 0.45;
const EXIT = 0.3;

/** 回弹缓动：冲过头再落回 */
function easeOutBack(t) {
  const c = 1.9;
  const x = clamp01(t) - 1;
  return 1 + (c + 1) * x * x * x + c * x * x;
}

/**
 * 动画状态（纯函数）。
 * @returns {{alpha:number, scale:number, dy:number /*字号倍数*\/, reveal:number /*0..1 打字进度*\/, typing:boolean}}
 */
export function textAnimState(animation, progress, local) {
  const p = clamp01(progress);
  const t = Math.max(0, Number(local) || 0);
  const duration = p > 0 ? t / p : ENTER + EXIT + 1;
  const enterLen = Math.min(ENTER, duration * 0.4);
  const exitLen = Math.min(EXIT, duration * 0.25);
  const inP = enterLen > 0 ? clamp01(t / enterLen) : 1;
  const remaining = Math.max(0, duration - t);
  const outAlpha = exitLen > 0 ? clamp01(remaining / exitLen) : 1;
  const state = { alpha: 1, scale: 1, dy: 0, reveal: 1, typing: false };
  switch (animation) {
    case 'none':
      return state;
    case 'pop':
      state.alpha = clamp01(inP * 3) * outAlpha;
      state.scale = 0.55 + 0.45 * easeOutBack(inP);
      return state;
    case 'slide-up':
      state.alpha = easeInOut(inP) * outAlpha;
      state.dy = 0.9 * (1 - easeOutCubic(inP));
      return state;
    case 'typewriter': {
      const typeLen = Math.max(0.2, duration * 0.62);
      state.reveal = clamp01(t / typeLen);
      state.typing = state.reveal < 1;
      state.alpha = outAlpha;
      return state;
    }
    case 'fade':
    default:
      state.alpha = easeInOut(inP) * outAlpha;
      return state;
  }
}

function revealLines(lines, reveal) {
  if (reveal >= 1) return lines;
  const total = lines.reduce((s, l) => s + [...l].length, 0);
  let left = Math.floor(total * reveal);
  return lines.map((line) => {
    const chars = [...line];
    const take = Math.max(0, Math.min(chars.length, left));
    left -= take;
    return chars.slice(0, take).join('');
  });
}

/** 每种预设的基础排版：字号比例、字重、字距、宽度比例 */
const PRESET_METRICS = {
  title: { size: 0.092, weight: 800, spacing: 0.1, wrap: 0.8, lineHeight: 1.26 },
  subtitle: { size: 0.05, weight: 500, spacing: 0.03, wrap: 0.84, lineHeight: 1.38 },
  'lower-third': { size: 0.042, weight: 600, spacing: 0.04, wrap: 0.56, lineHeight: 1.36, align: 'left' },
  'caption-box': { size: 0.044, weight: 600, spacing: 0.03, wrap: 0.74, lineHeight: 1.4 },
  'big-bold': { size: 0.12, weight: 900, spacing: 0.01, wrap: 0.88, lineHeight: 1.16 },
  handwrite: { size: 0.08, weight: 400, spacing: 0.02, wrap: 0.8, lineHeight: 1.3, family: FONT_HAND, italic: true },
  neon: { size: 0.09, weight: 700, spacing: 0.06, wrap: 0.82, lineHeight: 1.26 },
};

function paintTitle(ctx, line, x, y, size, color) {
  ctx.shadowColor = 'rgba(0,0,0,0.58)';
  ctx.shadowBlur = size * 0.36;
  ctx.shadowOffsetY = size * 0.04;
  ctx.fillStyle = color;
  ctx.fillText(line, x, y);
  clearEffects(ctx);
}

function paintBigBold(ctx, line, x, y, size, color) {
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  // 硬投影 + 粗描边：短视频封面字的标准做法
  ctx.strokeStyle = 'rgba(0,0,0,0.92)';
  ctx.lineWidth = size * 0.2;
  ctx.strokeText(line, x + size * 0.035, y + size * 0.05);
  ctx.strokeText(line, x, y);
  ctx.fillStyle = color;
  ctx.fillText(line, x, y);
}

function paintNeon(ctx, line, x, y, size, color) {
  const glow = isNearWhite(color) ? '#35e4ff' : color;
  ctx.fillStyle = rgba(glow, 1);
  for (const [blur, alpha] of [[1.1, 0.5], [0.55, 0.75], [0.22, 1]]) {
    ctx.shadowColor = rgba(glow, alpha);
    ctx.shadowBlur = size * blur;
    ctx.fillText(line, x, y);
  }
  clearEffects(ctx);
  ctx.lineJoin = 'round';
  ctx.strokeStyle = rgba(glow, 0.9);
  ctx.lineWidth = size * 0.05;
  ctx.strokeText(line, x, y);
  ctx.fillStyle = '#fffdfa';
  ctx.fillText(line, x, y);
}

function paintHand(ctx, line, x, y, size, color) {
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = size * 0.2;
  ctx.shadowOffsetY = size * 0.03;
  ctx.fillStyle = color;
  ctx.fillText(line, x, y);
  clearEffects(ctx);
}

/**
 * 文字轨元素。
 * @param {object} clip TextClip
 * @param {number} progress 0..1
 * @param {number} local 元素内已过秒数
 */
export function drawTextClip(ctx, clip, w, h, progress = 0.5, local = 1) {
  if (!clip || !clip.text) return;
  const text = String(clip.text);
  if (!text.trim()) return;
  const preset = PRESET_METRICS[clip.preset] ? clip.preset : 'title';
  const m = PRESET_METRICS[preset];
  const anim = clip.animIn || clip.animOut || clip.animLoop ? textAnimV3(clip, progress, local) : textAnimState(clip.animation || 'fade', progress, local);
  if (anim.alpha <= 0.002) return;
  const u = Math.min(w, h);
  const custom = !!(clip.stroke || clip.shadow || clip.bg);
  const rel = Number(clip.size) > 0 ? Number(clip.size) : 1;
  const size = Math.max(8, Math.round(u * m.size * rel));
  const color = clip.color || '#ffffff';

  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.globalAlpha *= anim.alpha;
  ctx.textBaseline = 'middle';
  ctx.textAlign = m.align || 'center';
  setFont(ctx, m.weight, size, m.family, m.italic);
  setSpacing(ctx, size * m.spacing);

  const lines = wrapText(ctx, text, w * m.wrap);
  const widths = lines.map((l) => ctx.measureText(l).width);
  const blockW = Math.max(1, ...widths);
  const lh = size * m.lineHeight;
  const blockH = lh * lines.length;

  // 把中心点夹在画内，文字不会被裁掉一半
  const halfW = blockW / 2 + size * 0.3;
  const halfH = blockH / 2 + size * 0.3;
  const cx = Math.min(w - halfW, Math.max(halfW, (Number.isFinite(clip.x) ? clip.x : 0.5) * w));
  const cy = Math.min(h - halfH, Math.max(halfH, (Number.isFinite(clip.y) ? clip.y : 0.5) * h)) + anim.dy * size;
  ctx.translate(cx + (anim.dx || 0) * size, cy);
  if (anim.rot) ctx.rotate(anim.rot);
  if (anim.scale !== 1) ctx.scale(anim.scale, anim.scale);
  if (preset === 'handwrite') ctx.rotate(-0.035);

  const shown = revealLines(lines, anim.reveal);
  const left = -blockW / 2;
  const lineX = m.align === 'left' ? left : 0;
  const lineY = (i) => -blockH / 2 + lh * (i + 0.5);

  if (custom) {
    paintCustom(ctx, clip, shown, lineX, lineY, blockW, blockH, size, color);
  } else if (preset === 'lower-third') {
    const padX = size * 0.75;
    const padY = size * 0.45;
    const bar = Math.max(3, size * 0.14);
    const accent = isNearWhite(color) ? '#e0a96d' : color;
    ctx.fillStyle = 'rgba(12,14,18,0.72)';
    ctx.fillRect(left - padX, -blockH / 2 - padY, blockW + padX * 2, blockH + padY * 2);
    ctx.fillStyle = accent;
    ctx.fillRect(left - padX - bar, -blockH / 2 - padY, bar, blockH + padY * 2);
    // 自定义颜色用在强调条上，正文保持白色以保证在深色底板上可读
    ctx.fillStyle = '#ffffff';
    shown.forEach((line, i) => ctx.fillText(line, lineX, lineY(i)));
  } else if (preset === 'caption-box') {
    const padX = size * 0.8;
    const padY = size * 0.42;
    ctx.fillStyle = 'rgba(10,11,14,0.62)';
    roundedRect(ctx, -blockW / 2 - padX, -blockH / 2 - padY, blockW + padX * 2, blockH + padY * 2, size * 0.34);
    ctx.fill();
    ctx.fillStyle = color;
    shown.forEach((line, i) => ctx.fillText(line, lineX, lineY(i)));
  } else if (preset === 'subtitle') {
    shown.forEach((line, i) => softOutlinedText(ctx, line, lineX, lineY(i), size, color));
  } else {
    const paint = { title: paintTitle, 'big-bold': paintBigBold, neon: paintNeon, handwrite: paintHand }[preset];
    shown.forEach((line, i) => { if (line) paint(ctx, line, lineX, lineY(i), size, color); });
    if (preset === 'title') {
      const rule = Math.min(blockW * 0.5, size * 1.8);
      ctx.fillStyle = rgba(color, 0.7);
      ctx.fillRect(-rule / 2, blockH / 2 + size * 0.14, rule, Math.max(1, size * 0.028));
    }
  }

  if (anim.typing) {
    // 打字光标：跟在最后一个已出现的字后面，半秒一闪
    const blink = Math.floor((Number(local) || 0) * 2) % 2 === 0;
    if (blink) {
      let idx = 0;
      shown.forEach((l, i) => { if (l) idx = i; });
      const lw = ctx.measureText(shown[idx] || '').width;
      const startX = m.align === 'left' ? left : -lw / 2;
      ctx.fillStyle = preset === 'neon' ? '#fffdfa' : color;
      ctx.fillRect(startX + lw + size * 0.08, lineY(idx) - size * 0.5, Math.max(2, size * 0.06), size);
    }
  }
  ctx.restore();
}

/** v3 自定义样式：背景板 → 阴影 → 描边 → 填充 */
function paintCustom(ctx, clip, lines, lineX, lineY, blockW, blockH, size, color) {
  const bg = clip.bg;
  if (bg && (bg.color || typeof bg === 'string')) {
    const bgColor = typeof bg === 'string' ? bg : bg.color;
    const pad = size * (Number(bg.pad) > 0 ? Number(bg.pad) : 0.45);
    ctx.save();
    ctx.globalAlpha *= Number.isFinite(Number(bg.opacity)) ? clamp01(Number(bg.opacity)) : 0.75;
    ctx.fillStyle = bgColor;
    roundedRect(ctx, -blockW / 2 - pad * 1.4, -blockH / 2 - pad, blockW + pad * 2.8, blockH + pad * 2, size * (Number(bg.radius) >= 0 ? Number(bg.radius) : 0.25));
    ctx.fill();
    ctx.restore();
  }
  const sh = clip.shadow;
  const st = clip.stroke;
  lines.forEach((line, i) => {
    if (!line) return;
    const y = lineY(i);
    if (sh) {
      ctx.save();
      ctx.shadowColor = (sh && sh.color) || 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = size * (Number.isFinite(Number(sh.blur)) ? Number(sh.blur) : 0.3);
      ctx.shadowOffsetX = size * (Number(sh.x) || 0.04);
      ctx.shadowOffsetY = size * (Number(sh.y) || 0.06);
      ctx.fillStyle = color;
      ctx.fillText(line, lineX, y);
      ctx.restore();
    }
    if (st && Number(st.width) !== 0) {
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.strokeStyle = st.color || '#000000';
      // stroke.width 在 UI 中以「px@1080p」计（0–12），≈ 字号的 4%/px；描边一半压在字形下，故 ×2
      ctx.lineWidth = size * (Number(st.width) > 0 ? Number(st.width) * 0.04 : 0.12) * 2;
      ctx.strokeText(line, lineX, y);
      ctx.restore();
    }
    ctx.fillStyle = color;
    ctx.fillText(line, lineX, y);
  });
}

/**
 * v3 入场 / 出场 / 循环动画（纯函数）。animIn/animOut: {type:'fade'|'slide-up'|'slide-down'|'slide-left'|'slide-right'|'pop'|'zoom'|'typewriter', dur}
 * animLoop: {type:'pulse'|'shake'|'float'|'swing', dur}
 */
export function textAnimV3(clip, progress, local) {
  const p = clamp01(progress);
  const t = Math.max(0, Number(local) || 0);
  const duration = p > 0 ? t / p : 3;
  const st = { alpha: 1, scale: 1, dy: 0, dx: 0, rot: 0, reveal: 1, typing: false };
  const apply = (spec, k) => {
    // k: 0 = 完全不可见（入场起点 / 出场终点），1 = 正常
    const e = easeOutCubic(k);
    switch (spec.type) {
      case 'none': return;
      case 'pop': st.alpha *= clamp01(k * 3); st.scale *= 0.55 + 0.45 * easeOutBack(k); return;
      case 'zoom': st.alpha *= e; st.scale *= 1.6 - 0.6 * e; return;
      case 'slide-up': st.alpha *= e; st.dy += 0.9 * (1 - e); return;
      case 'slide-down': st.alpha *= e; st.dy -= 0.9 * (1 - e); return;
      case 'slide-left': st.alpha *= e; st.dx += 1.6 * (1 - e); return;
      case 'slide-right': st.alpha *= e; st.dx -= 1.6 * (1 - e); return;
      case 'typewriter': st.reveal = Math.min(st.reveal, clamp01(k)); st.typing = st.reveal < 1; return;
      default: st.alpha *= easeInOut(k);
    }
  };
  const ain = clip.animIn;
  if (ain && ain.type) {
    const d = Math.min(Math.max(0.05, Number(ain.dur) || 0.4), duration * 0.6);
    if (t < d) apply(ain, t / d);
  }
  const aout = clip.animOut;
  if (aout && aout.type && aout.type !== 'typewriter') {
    const d = Math.min(Math.max(0.05, Number(aout.dur) || 0.35), duration * 0.4);
    const rem = duration - t;
    if (rem < d) apply(aout, clamp01(rem / d));
  }
  const loop = clip.animLoop;
  if (loop && loop.type) {
    const period = Math.max(0.2, Number(loop.dur) || 1.2);
    const ph = Math.sin((t / period) * Math.PI * 2);
    if (loop.type === 'pulse') st.scale *= 1 + 0.06 * ph;
    else if (loop.type === 'shake') st.dx += 0.04 * Math.sin((t / period) * Math.PI * 14);
    else if (loop.type === 'float') st.dy += 0.12 * ph;
    else if (loop.type === 'swing') st.rot += 0.06 * ph;
  }
  return st;
}