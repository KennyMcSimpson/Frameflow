// AI 生成内容标识（契约 C10）：显式标识（画面角标）+ 隐式标识（文件元数据）。纯函数，node 可测。
//
// 依据 GB 45438-2025《网络安全技术 人工智能生成合成内容标识方法》（2025-09-01 起实施）：
//  - 视频显式标识：提示文字含「人工智能」或「AI」，并含「生成」和/或「合成」；位于画面的边或角；
//    至少在起始画面出现，持续不少于 2 秒；文字高度不低于画面最短边的 5%。
//  - 附录 E 隐式标识（文件元数据）：键名含 AIGC，值依次为 Label、ContentProducer、ProduceID、ReservedCode1、
//    ContentPropagator、PropagateID、ReservedCode2。Label 取 "1"（属于）/"2"（可能）/"3"（疑似）。
//    取值字符限 0x21、0x23–0x5B、0x5D–0x7E；同一文件只写一份。
// 画面策略：开头 3 秒显示醒目标识（满足 5% 字高与 2 秒时长），随后 0.5 秒平滑缩成常驻角标
// （字号约为画面高的 2.4%，白色 85% 不透明，柔和阴影，契约 C10）。

import * as License from '../engine/license.js';

export const AI_LABEL_DEFAULT = Object.freeze({ text: 'AI 生成', corner: 'top-right' });
export const AI_LABEL_CORNERS = Object.freeze(['top-right', 'top-left', 'bottom-right', 'bottom-left']);

/** 醒目标识持续秒数（国标要求起始画面 ≥2 秒，留 1 秒余量） */
export const AI_LABEL_INTRO_SEC = 3;
const SHRINK_SEC = 0.5;
/** 醒目标识字号 / 画面最短边：汉字字面约占字号 90%，6% 字号 ≈ 5.4% 字高，满足「≥5%」 */
const INTRO_RATIO = 0.06;
/** 常驻角标字号 / 画面高（契约 C10：约 2.4%） */
const BADGE_RATIO = 0.024;
const FONT_STACK = '"Microsoft YaHei UI","Microsoft YaHei","Segoe UI","PingFang SC","Noto Sans CJK SC",sans-serif';

const str = (v) => (v == null ? '' : String(v).trim());
const lerp = (a, b, k) => a + (b - a) * k;
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

// ───────────────────────── 哪些素材算 AI 生成 ─────────────────────────

const AI_SOURCE_KINDS = new Set(['ai', 'ai-image', 'ai-video', 'videogen', 'generated']);
const AI_TAGS = new Set(['AI 生成', 'AI生成', 'AI 画面', 'AI 视频', 'AI 配音']);

/** 素材是否为 AI 生成：先问 license.isAiAsset（契约 C3），再认旧数据里的标记（videogen 字段、AI 标签等） */
export function isAiAssetLoose(asset) {
  if (!asset || typeof asset !== 'object') return false;
  try {
    if (typeof License.isAiAsset === 'function' && License.isAiAsset(asset)) return true;
  } catch { /* 提供方出错时按下面的规则判断 */ }
  if (asset.ai || asset.kind === 'generated-image') return true;
  const s = asset.source;
  if (typeof s === 'string') {
    if (AI_SOURCE_KINDS.has(s.toLowerCase())) return true;
  } else if (s && typeof s === 'object') {
    if (AI_SOURCE_KINDS.has(str(s.kind).toLowerCase()) || AI_SOURCE_KINDS.has(str(s.type).toLowerCase())) return true;
  }
  if (asset.meta && typeof asset.meta === 'object' && asset.meta.videogen) return true;
  return Array.isArray(asset.tags) && asset.tags.some((t) => AI_TAGS.has(str(t)));
}

function usedIds(project) {
  if (typeof License.usedAssetIds === 'function') {
    try {
      const ids = License.usedAssetIds(project);
      if (ids && typeof ids[Symbol.iterator] === 'function') return [...ids];
    } catch { /* 回退到下面的遍历 */ }
  }
  const ids = new Set();
  const t = (project && project.tracks) || {};
  for (const c of [...(Array.isArray(t.video) ? t.video : []), ...(Array.isArray(t.audio) ? t.audio : [])]) if (c && c.assetId) ids.add(c.assetId);
  for (const o of Array.isArray(project && project.overlays) ? project.overlays : []) if (o && o.assetId) ids.add(o.assetId);
  return [...ids];
}

/** 时间线上实际用到的 AI 素材：{ count, names }（names 最多 5 个，给界面提示用） */
export function aiAssetSummary(project) {
  const assets = (project && project.assets) || {};
  const names = [];
  let count = 0;
  for (const id of usedIds(project)) {
    const a = assets[id];
    if (!isAiAssetLoose(a)) continue;
    count += 1;
    if (names.length < 5) names.push(str(a.name) || '未命名素材');
  }
  return { count, names };
}

/** 工程是否用到了 AI 生成的素材（导出时据此默认打开角标、写入元数据） */
export function projectUsesAiLoose(project) {
  return aiAssetSummary(project).count > 0;
}

// ───────────────────────── 显式标识：画面角标 ─────────────────────────

/** 提示文字是否合规：含「AI」或「人工智能」，并含「生成」或「合成」 */
export function isCompliantLabelText(text) {
  const t = str(text);
  return /AI|ＡＩ|人工智能/i.test(t) && /生成|合成/.test(t);
}

/**
 * 规范化角标设置。false / null / 'off' → null（不画）；true / {} → 默认；
 * 文字不合规时换回默认文字，保证导出的成片始终满足国标。
 */
export function normalizeAiLabel(raw) {
  if (raw === false || raw === null || raw === 0 || raw === 'off' || raw === undefined) return null;
  const o = raw && typeof raw === 'object' ? raw : {};
  let text = str(o.text).replace(/\s+/g, ' ').slice(0, 24);
  if (!isCompliantLabelText(text)) text = AI_LABEL_DEFAULT.text;
  const corner = AI_LABEL_CORNERS.includes(o.corner) ? o.corner : AI_LABEL_DEFAULT.corner;
  return { text, corner };
}

/**
 * 时刻 t 的角标排版（纯函数，单位为像素）。
 * 竖屏（高/宽 ≥ 1.3）时上角下移约 7%、下角上移约 14% 画面高，避开短视频平台的顶栏和右下角按钮。
 */
export function aiLabelLayout(width, height, t = 0, label = AI_LABEL_DEFAULT) {
  const W = Math.max(1, Number(width) || 1);
  const H = Math.max(1, Number(height) || 1);
  const minSide = Math.min(W, H);
  const tt = Number.isFinite(Number(t)) ? Number(t) : 0;
  const k = smooth((tt - AI_LABEL_INTRO_SEC) / SHRINK_SEC); // 0 = 醒目标识，1 = 常驻角标
  const big = Math.ceil(minSide * INTRO_RATIO);
  const small = Math.min(big, Math.max(12, Math.round(H * BADGE_RATIO)));
  const fontPx = Math.round(lerp(big, small, k));
  const corner = AI_LABEL_CORNERS.includes(label && label.corner) ? label.corner : AI_LABEL_DEFAULT.corner;
  const portrait = H / W >= 1.3;
  const bottom = corner.startsWith('bottom');
  return {
    corner,
    phase: k <= 0 ? 'intro' : k >= 1 ? 'badge' : 'shrink',
    fontPx,
    margin: Math.round(minSide * lerp(0.035, 0.025, k)),
    offsetY: portrait ? Math.round(H * (bottom ? 0.14 : 0.07)) : 0,
    padX: Math.max(4, Math.round(fontPx * 0.42)),
    padY: Math.max(2, Math.round(fontPx * 0.2)),
    radius: Math.max(3, Math.round(fontPx * 0.34)),
    alpha: lerp(0.94, 0.85, k),
    bgAlpha: lerp(0.32, 0.2, k),
    shadowBlur: Math.max(2, fontPx * 0.32),
  };
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * 在已合成好的画面上画 AI 标识（每帧调用）。label 可以是 normalizeAiLabel 的结果或原始设置。
 * 返回画出的框 { x, y, w, h, fontPx }；不画时返回 null。
 */
export function drawAiLabel(ctx, width, height, t, label) {
  const lab = label && typeof label === 'object' && typeof label.text === 'string' && AI_LABEL_CORNERS.includes(label.corner) && isCompliantLabelText(label.text)
    ? label
    : normalizeAiLabel(label === undefined ? true : label);
  if (!ctx || !lab) return null;
  const W = Math.max(1, Number(width) || 1);
  const H = Math.max(1, Number(height) || 1);
  const L = aiLabelLayout(W, H, t, lab);
  ctx.save();
  try {
    if (typeof ctx.setTransform === 'function') ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if ('filter' in ctx) ctx.filter = 'none';
    ctx.font = `600 ${L.fontPx}px ${FONT_STACK}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const tw = Math.max(L.fontPx, Number(ctx.measureText(lab.text).width) || lab.text.length * L.fontPx);
    const boxW = Math.round(tw + L.padX * 2);
    const boxH = Math.round(L.fontPx + L.padY * 2);
    const right = L.corner.endsWith('right');
    const bottom = L.corner.startsWith('bottom');
    const x = right ? W - L.margin - boxW : L.margin;
    const y = bottom ? H - L.margin - L.offsetY - boxH : L.margin + L.offsetY;
    // 半透明底板：亮背景（天空、白墙）上也清晰可辨
    ctx.fillStyle = `rgba(0,0,0,${L.bgAlpha.toFixed(3)})`;
    roundRectPath(ctx, x, y, boxW, boxH, L.radius);
    ctx.fill();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = L.shadowBlur;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = Math.max(1, Math.round(L.fontPx * 0.05));
    ctx.fillStyle = `rgba(255,255,255,${L.alpha.toFixed(3)})`;
    ctx.fillText(lab.text, x + L.padX, y + boxH / 2 + L.fontPx * 0.04);
    return { x, y, w: boxW, h: boxH, fontPx: L.fontPx };
  } finally {
    ctx.restore();
  }
}

// ───────────────────────── 隐式标识：文件元数据 ─────────────────────────

export const AIGC_FIELDS = Object.freeze(['Label', 'ContentProducer', 'ProduceID', 'ReservedCode1', 'ContentPropagator', 'PropagateID', 'ReservedCode2']);
export const AIGC_PRODUCER = 'Frameflow';

/** 元数据取值只保留附录 E 允许的字符：去掉空格、双引号、反斜杠和非 ASCII 字符 */
export function aigcSafe(v, max = 64) {
  return str(v).replace(/[^\x21\x23-\x5B\x5D-\x7E]/g, '').slice(0, max);
}

function randomHex(bytes) {
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const a = c.getRandomValues(new Uint8Array(bytes));
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  let s = '';
  for (let i = 0; i < bytes; i += 1) s += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  return s;
}

/** 内容制作编号：每次导出唯一，例如 FF-20261109T153012-3fa9c1d2 */
export function makeProduceId(now = new Date()) {
  const d = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `FF-${stamp}-${randomHex(4)}`;
}

/**
 * 生成隐式标识的七个要素（顺序固定）。首次写入时传播方与制作方相同。
 * @param {{ producer?:string, produceId?:string, label?:'1'|'2'|'3' }} opts
 */
export function buildAigcMeta({ producer = AIGC_PRODUCER, produceId, label = '1' } = {}) {
  const who = aigcSafe(producer) || AIGC_PRODUCER;
  const id = aigcSafe(produceId) || makeProduceId();
  const lab = ['1', '2', '3'].includes(String(label)) ? String(label) : '1';
  return { Label: lab, ContentProducer: who, ProduceID: id, ReservedCode1: '', ContentPropagator: who, PropagateID: id, ReservedCode2: '' };
}

/** 元数据值：七个要素按固定顺序序列化成 JSON（写入 MP4/MOV 的 AIGC 键、MP3 的 TXXX:AIGC） */
export function aigcMetaString(meta) {
  const m = meta && typeof meta === 'object' ? meta : buildAigcMeta();
  const out = {};
  for (const k of AIGC_FIELDS) out[k] = aigcSafe(m[k]);
  if (!['1', '2', '3'].includes(out.Label)) out.Label = '1';
  return JSON.stringify(out);
}
