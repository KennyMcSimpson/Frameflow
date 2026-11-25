// 数据模型：默认值、工厂函数、枚举、normalize（SPEC §3）。纯函数，node 可测。
import { uid, clamp } from './ids.js';

export const ASPECTS = {
  '16:9': { width: 1920, height: 1080, label: '横屏 16:9' },
  '9:16': { width: 1080, height: 1920, label: '竖屏 9:16' },
  '1:1': { width: 1080, height: 1080, label: '方形 1:1' },
  '4:3': { width: 1440, height: 1080, label: '经典 4:3' },
  '21:9': { width: 2560, height: 1080, label: '宽银幕 21:9' },
};

export const LOOKS = ['none', 'cinematic', 'film-warm', 'film-cool', 'bw', 'noir', 'vintage', 'cool-night', 'vivid', 'soft-pastel', 'high-contrast', 'moody', 'golden-hour', 'cyberpunk'];
export const LOOK_LABELS = {
  none: '原色', cinematic: '电影青橙', 'film-warm': '暖调胶片', 'film-cool': '冷调胶片', bw: '黑白', noir: '黑色电影', vintage: '复古',
  'cool-night': '冷夜', vivid: '鲜艳', 'soft-pastel': '柔和粉彩', 'high-contrast': '高反差', moody: '情绪暗调', 'golden-hour': '黄金时刻', cyberpunk: '赛博朋克',
};
export const MOTIONS = ['none', 'push-in', 'pull-out', 'pan-left', 'pan-right', 'tilt-up', 'tilt-down', 'shake', 'zoom-punch', 'drift'];
export const MOTION_LABELS = {
  none: '无运镜', 'push-in': '缓慢推近', 'pull-out': '缓慢拉远', 'pan-left': '向左摇', 'pan-right': '向右摇', 'tilt-up': '向上摇', 'tilt-down': '向下摇',
  shake: '手持晃动', 'zoom-punch': '冲击变焦', drift: '缓慢漂移',
};
export const TRANSITIONS = ['cut', 'crossfade', 'dip-black', 'dip-white', 'slide-left', 'slide-right', 'slide-up', 'slide-down', 'zoom-in', 'zoom-out', 'wipe-left', 'wipe-right', 'blur', 'whip-pan', 'flash', 'spin'];
export const TRANSITION_LABELS = {
  cut: '硬切', crossfade: '叠化', 'dip-black': '黑场过渡', 'dip-white': '白场过渡', 'slide-left': '向左推', 'slide-right': '向右推', 'slide-up': '向上推', 'slide-down': '向下推',
  'zoom-in': '放大穿越', 'zoom-out': '缩小穿越', 'wipe-left': '向左擦除', 'wipe-right': '向右擦除', blur: '模糊过渡', 'whip-pan': '甩镜', flash: '闪白', spin: '旋转',
};
export const FX_KEYS = ['blur', 'grain', 'glow', 'sharpen', 'letterbox', 'chromatic', 'vhs', 'flash'];
export const FX_LABELS = { blur: '模糊', grain: '胶片颗粒', glow: '柔光辉光', sharpen: '锐化', letterbox: '电影黑边', chromatic: '色差', vhs: 'VHS 录像带', flash: '闪白' };
export const COLOR_KEYS = ['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'highlights', 'shadows', 'vignette'];
export const COLOR_LABELS = { exposure: '曝光', contrast: '对比度', saturation: '饱和度', temperature: '色温', tint: '色调', highlights: '高光', shadows: '阴影', vignette: '暗角' };
export const CAPTION_STYLES = ['subtitle', 'title', 'lower-third', 'none'];
export const TEXT_PRESETS = ['title', 'subtitle', 'lower-third', 'caption-box', 'big-bold', 'handwrite', 'neon'];
export const TEXT_ANIMATIONS = ['fade', 'pop', 'slide-up', 'typewriter', 'none'];
export const SHOT_SIZES = ['extreme-wide', 'wide', 'full', 'medium', 'medium-close', 'close-up', 'extreme-close-up', 'insert'];
export const SHOT_SIZE_LABELS = {
  'extreme-wide': '大远景', wide: '远景', full: '全景', medium: '中景', 'medium-close': '中近景', 'close-up': '近景特写', 'extreme-close-up': '大特写', insert: '插入镜头',
};
export const ANGLES = ['eye-level', 'high', 'low', 'top-down', 'dutch', 'over-shoulder', 'pov'];
export const ANGLE_LABELS = { 'eye-level': '平视', high: '俯拍', low: '仰拍', 'top-down': '顶拍', dutch: '倾斜', 'over-shoulder': '过肩', pov: '主观视角' };
export const SHOT_MOVEMENTS = [...MOTIONS, 'handheld', 'orbit', 'tracking', 'static'];
export const SHOT_MOVEMENT_LABELS = { ...MOTION_LABELS, handheld: '手持跟拍', orbit: '环绕', tracking: '跟随移动', static: '固定机位' };
export const PREVIZ_SETTINGS = ['cafe', 'street', 'nature', 'studio', 'office', 'home', 'night-city', 'beach', 'kitchen', 'shop', 'gym', 'abstract'];
export const PREVIZ_SUBJECTS = ['person', 'product', 'cup', 'phone', 'car', 'plant', 'box', 'text', 'food', 'laptop'];
export const PREVIZ_ACTIONS = ['idle', 'walk-left', 'walk-right', 'turn', 'raise', 'rotate', 'pour', 'talk', 'jump'];
export const TECHNIQUE_CATEGORIES = ['transition', 'lighting', 'camera', 'rhythm', 'composition', 'color', 'dialogue', 'vfx', 'product', 'narrative', 'sound'];
export const TECHNIQUE_CATEGORY_LABELS = {
  transition: '转场', lighting: '光线', camera: '运镜', rhythm: '节奏', composition: '构图', color: '调色', dialogue: '台词', vfx: '特效', product: '产品呈现', narrative: '叙事', sound: '声音',
};
export const ANALYSIS_CATEGORIES = ['film', 'tutorial', 'interview', 'short', 'ad', 'vfx', 'other'];
export const ANALYSIS_CATEGORY_LABELS = { film: '电影片段', tutorial: '拍摄教程', interview: '演员访谈', short: '短视频', ad: '广告/产品片', vfx: '特效/AI 视频', other: '其他' };

export const LIMITS = { maxClips: 200, maxDuration: 600, minClip: 0.2, maxTransition: 2, minTransition: 0.1, minSpeed: 0.1, maxSpeed: 10, speed: { min: 0.1, max: 10 }, maxOverlayTrack: 4, maxCrop: 0.45 };
/** 工程文件结构版本（迁移见 migrations.js）。3：镜头文案字幕只在初剪/迁移时生成一次，之后完全由用户掌控 */
export const PROJECT_VERSION = 3;
/** 文字片段可选的行号 row（C18）：整数 0..MAX_TEXT_ROW */
export const MAX_TEXT_ROW = 7;

// ---------- v3 新增（PLAN-v3 §1） ----------
export const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'add'];
export const BLEND_LABELS = { normal: '正常', multiply: '正片叠底', screen: '滤色', overlay: '叠加', darken: '变暗', lighten: '变亮', add: '线性减淡' };
export const FIT_MODES = ['contain', 'cover', 'fill'];
export const FIT_LABELS = { contain: '适应', cover: '填充', fill: '拉伸' };
export const CANVAS_TYPES = ['none', 'blur', 'color', 'image'];
export const MASK_SHAPES = ['linear', 'mirror', 'circle', 'rect'];
export const MASK_LABELS = { linear: '线性', mirror: '镜面', circle: '圆形', rect: '矩形' };
export const OVERLAY_KINDS = ['video', 'image', 'sticker'];
export const MARKER_COLORS = ['#c8e250', '#9d8cff', '#ff6b6b', '#4fc3f7', '#ffb74d'];
export const SPEED_CURVE_PRESETS = {
  montage: { label: '蒙太奇', curve: [{ t: 0, v: 1 }, { t: 0.3, v: 3 }, { t: 0.5, v: 0.4 }, { t: 0.7, v: 3 }, { t: 1, v: 1 }] },
  hero: { label: '英雄时刻', curve: [{ t: 0, v: 2 }, { t: 0.4, v: 2 }, { t: 0.5, v: 0.3 }, { t: 0.6, v: 2 }, { t: 1, v: 2 }] },
  bullet: { label: '子弹时间', curve: [{ t: 0, v: 1.5 }, { t: 0.35, v: 0.2 }, { t: 0.65, v: 0.2 }, { t: 1, v: 1.5 }] },
  jump: { label: '跳接', curve: [{ t: 0, v: 1 }, { t: 0.45, v: 1 }, { t: 0.5, v: 6 }, { t: 0.55, v: 1 }, { t: 1, v: 1 }] },
  flashIn: { label: '闪进', curve: [{ t: 0, v: 5 }, { t: 0.3, v: 1 }, { t: 1, v: 1 }] },
  flashOut: { label: '闪出', curve: [{ t: 0, v: 1 }, { t: 0.7, v: 1 }, { t: 1, v: 5 }] },
};
export function defaultCrop() { return { l: 0, t: 0, r: 0, b: 0 }; }
export function defaultMirror() { return { h: false, v: false }; }
export function defaultCanvas() { return { type: 'none', value: null }; }
export function defaultTrackFlags() { return { locked: false, hidden: false, muted: false }; }
/**
 * 轨道状态。注意：project.tracks 已被 video/text/audio 片段数组占用，
 * 因此 PLAN §1 的 `tracks:{video:{locked,hidden,muted},...}` 落在 project.trackState 上（同结构）。
 */
export function defaultTrackState() {
  return {
    video: defaultTrackFlags(),
    overlay: { 1: defaultTrackFlags(), 2: defaultTrackFlags(), 3: defaultTrackFlags(), 4: defaultTrackFlags() },
    text: defaultTrackFlags(),
    audio: defaultTrackFlags(),
  };
}

export function defaultColor() {
  return { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0, vignette: 0, look: 'none', lookStrength: 1 };
}
export function defaultFx() {
  return { blur: 0, grain: 0, glow: 0, sharpen: 0, letterbox: 0, chromatic: 0, vhs: 0, flash: 0 };
}
export function defaultTransform() {
  return { scale: 1, x: 0, y: 0, rotation: 0, flipH: false };
}

export function createSettings(aspect = '16:9') {
  const a = ASPECTS[aspect] || ASPECTS['16:9'];
  return { aspect: ASPECTS[aspect] ? aspect : '16:9', width: a.width, height: a.height, fps: 30, background: '#000000' };
}

export function createProject({ name = '未命名项目', aspect = '16:9' } = {}) {
  const now = new Date().toISOString();
  return {
    version: PROJECT_VERSION,
    id: uid('prj'),
    name,
    createdAt: now,
    updatedAt: now,
    // 新工程不需要「旧工程字幕迁移」：用户删掉的文案字幕不会在重开时复活
    timeline: { captionsMigrated: true },
    settings: createSettings(aspect),
    assets: {},
    tracks: { video: [], text: [], audio: [] },
    brief: null,
    storyboard: [],
    memory: { styleGuide: '', decisions: [], colorBaseline: null },
    chats: { director: [], editor: [] },
    references: {},
    overlays: [],
    trackState: defaultTrackState(),
    markers: [],
    exportPreset: 'custom',
  };
}

export function createOverlay(asset, partial = {}) {
  const isImg = asset && asset.kind !== 'video';
  const dur = asset && Number.isFinite(asset.duration) && asset.duration > 0 ? asset.duration : 4;
  return {
    id: uid('ovl'),
    assetId: asset ? asset.id : null,
    kind: isImg ? (asset && asset.kind === 'sticker' ? 'sticker' : 'image') : 'video',
    track: 1,
    start: 0,
    in: 0,
    out: isImg ? 4 : Math.min(dur, 8),
    speed: 1,
    // 贴纸按原大放（约占画面高度 1/5，接近剪映默认）；图片/视频画中画默认半屏
    transform: { ...defaultTransform(), scale: asset && asset.kind === 'sticker' ? 1 : 0.5 },
    opacity: 1,
    blend: 'normal',
    mask: null,
    crop: defaultCrop(),
    keys: {},
    volume: 1,
    muted: false,
    locked: false,
    ...partial,
  };
}

export function createMarker(partial = {}) {
  return { id: uid('mrk'), t: 0, label: '', color: MARKER_COLORS[0], ...partial };
}

function normCrop(c) {
  const o = { ...defaultCrop(), ...(c && typeof c === 'object' ? c : {}) };
  for (const k of ['l', 't', 'r', 'b']) o[k] = num(o[k], 0, LIMITS.maxCrop, 0);
  return o;
}
function normMask(m) {
  if (!m || typeof m !== 'object' || !MASK_SHAPES.includes(m.shape)) return null;
  return {
    shape: m.shape, cx: num(m.cx, 0, 1, 0.5), cy: num(m.cy, 0, 1, 0.5), w: num(m.w, 0, 2, 0.5), h: num(m.h, 0, 2, 0.5),
    rot: num(m.rot, -180, 180, 0), feather: num(m.feather, 0, 1, 0.1), invert: !!m.invert,
  };
}
/** 关键帧规范化：丢弃非法帧，按 t 升序 */
export function normalizeKeys(keys) {
  const out = {};
  if (!keys || typeof keys !== 'object') return out;
  for (const [path, list] of Object.entries(keys)) {
    if (!Array.isArray(list)) continue;
    const l = list.filter((k) => k && Number.isFinite(Number(k.t)) && Number.isFinite(Number(k.v)))
      .map((k) => ({ t: Math.max(0, Number(k.t)), v: Number(k.v), ease: ['linear', 'ease', 'easeIn', 'easeOut', 'hold'].includes(k.ease) ? k.ease : 'linear' }))
      .sort((a, b) => a.t - b.t);
    if (l.length) out[path] = l;
  }
  return out;
}
/** 变速曲线规范化：至少 2 点、t 升序、首尾 t=0/1、v 夹到 LIMITS.speed；非法返回 null */
export function normalizeSpeedCurve(curve) {
  if (!Array.isArray(curve)) return null;
  const pts = curve.filter((p) => p && Number.isFinite(Number(p.t)) && Number.isFinite(Number(p.v)))
    .map((p) => ({ t: clamp(Number(p.t), 0, 1), v: clamp(Number(p.v), LIMITS.minSpeed, LIMITS.maxSpeed) }))
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2) return null;
  pts[0] = { ...pts[0], t: 0 };
  pts[pts.length - 1] = { ...pts[pts.length - 1], t: 1 };
  return pts;
}
function normFlags(f) {
  return { locked: !!(f && f.locked), hidden: !!(f && f.hidden), muted: !!(f && f.muted) };
}
export function normalizeTrackState(s) {
  const src = s && typeof s === 'object' ? s : {};
  const ov = src.overlay && typeof src.overlay === 'object' ? src.overlay : {};
  return {
    video: normFlags(src.video), text: normFlags(src.text), audio: normFlags(src.audio),
    overlay: { 1: normFlags(ov[1]), 2: normFlags(ov[2]), 3: normFlags(ov[3]), 4: normFlags(ov[4]) },
  };
}
export function normalizeOverlay(o, asset) {
  const base = createOverlay(asset, { id: o && o.id });
  const out = { ...base, ...(o || {}) };
  out.kind = oneOf(out.kind, OVERLAY_KINDS, base.kind);
  out.track = Math.round(num(out.track, 1, LIMITS.maxOverlayTrack, 1));
  out.start = num(out.start, 0, LIMITS.maxDuration, 0);
  out.speed = num(out.speed, LIMITS.minSpeed, LIMITS.maxSpeed, 1);
  // 读不到时长（duration<=0）的素材不设上限，避免入出点被压成 0
  const maxSrc = asset && asset.kind === 'video' && Number(asset.duration) > 0 ? Number(asset.duration) : 3600;
  out.in = num(out.in, 0, Math.max(0, maxSrc - LIMITS.minClip), 0);
  out.out = num(out.out, out.in + LIMITS.minClip, maxSrc, Math.min(maxSrc, out.in + 4));
  const tr = o && isObj(o.transform) ? o.transform : {};
  out.transform = {
    scale: num(tr.scale, 0.05, 5, base.transform.scale),
    x: num(tr.x, -2, 2, 0),
    y: num(tr.y, -2, 2, 0),
    rotation: num(tr.rotation, -360, 360, 0),
    flipH: !!tr.flipH,
  };
  if (o && isObj(o.mirror)) out.mirror = { h: !!o.mirror.h, v: !!o.mirror.v };
  if (o && 'fit' in o) out.fit = oneOf(o.fit, FIT_MODES, 'contain');
  if (o && 'audioFadeIn' in o) out.audioFadeIn = num(o.audioFadeIn, 0, 30, 0);
  if (o && 'audioFadeOut' in o) out.audioFadeOut = num(o.audioFadeOut, 0, 30, 0);
  if (o && 'denoise' in o) out.denoise = !!o.denoise;
  out.opacity = num(out.opacity, 0, 1, 1);
  out.blend = oneOf(out.blend, BLEND_MODES, 'normal');
  out.mask = normMask(out.mask);
  out.crop = normCrop(out.crop);
  out.keys = normalizeKeys(out.keys);
  out.volume = num(out.volume, 0, 2, 1);
  out.muted = !!out.muted;
  out.locked = !!out.locked;
  return out;
}
/**
 * 这条文字是不是「字幕」：语音识别生成的（group:'caption'）或初剪按镜头文案生成的（source:'shot-caption'）。
 * 清空字幕、统一样式、字幕面板、导出 SRT 都用这一个判断，两种来源对用户来说都是字幕。
 */
export function isCaptionText(t) {
  return !!t && (t.group === 'caption' || t.source === 'shot-caption');
}

function normTextExtra(t) {
  const o = createTextClip(t);
  o.start = num(o.start, 0, LIMITS.maxDuration, 0);
  o.duration = num(o.duration, 0.1, LIMITS.maxDuration, 3);
  o.x = num(o.x, 0, 1, 0.5);
  o.y = num(o.y, 0, 1, 0.5);
  o.size = num(o.size, 0.2, 5, 1);
  o.text = typeof o.text === 'string' ? o.text.slice(0, 500) : (o.text == null ? '' : String(o.text).slice(0, 500));
  o.preset = oneOf(o.preset, TEXT_PRESETS, 'title');
  o.animation = oneOf(o.animation, TEXT_ANIMATIONS, 'fade');
  o.locked = !!o.locked;
  o.group = o.group === 'caption' ? 'caption' : null;
  o.stroke = o.stroke && typeof o.stroke === 'object' ? { color: o.stroke.color || '#000000', width: num(o.stroke.width, 0, 20, 0) } : null;
  o.shadow = o.shadow && typeof o.shadow === 'object' ? o.shadow : (o.shadow === true ? { color: '#000000', blur: 6, x: 0, y: 2 } : null);
  o.bg = o.bg && typeof o.bg === 'object' ? o.bg : null;
  for (const k of ['animIn', 'animOut', 'animLoop']) o[k] = o[k] && typeof o[k] === 'object' && o[k].type ? { type: String(o[k].type), dur: num(o[k].dur, 0, 10, 0.5) } : null;
  // 行号（C18）：只保留 0..7 的整数，其它值去掉，交给时间线自动排
  if ('row' in o) {
    const row = Number(o.row);
    if (o.row !== null && o.row !== '' && Number.isInteger(row) && row >= 0 && row <= MAX_TEXT_ROW) o.row = row;
    else delete o.row;
  }
  // 来源标记（镜头文案字幕 source:'shot-caption'）与所跟随的片段 id：只认字符串
  if ('source' in o && typeof o.source !== 'string') delete o.source;
  if ('linkShotId' in o && (typeof o.linkShotId !== 'string' || !o.linkShotId)) delete o.linkShotId;
  return o;
}
function normAudioExtra(a, asset) {
  const o = createAudioClip(asset, a);
  const maxSrc = asset && Number.isFinite(Number(asset.duration)) && Number(asset.duration) > 0 ? Number(asset.duration) : 3600;
  const minSpan = Math.min(0.05, maxSrc);
  o.start = num(o.start, 0, LIMITS.maxDuration, 0);
  o.in = num(o.in, 0, Math.max(0, maxSrc - minSpan), 0);
  o.out = num(o.out, Math.min(maxSrc, o.in + minSpan), maxSrc, Math.min(maxSrc, o.in + 10));
  o.volume = num(o.volume, 0, 2, 1);
  o.fadeIn = num(o.fadeIn, 0, 30, 0.5);
  o.fadeOut = num(o.fadeOut, 0, 30, 0.8);
  o.locked = !!o.locked;
  o.volumeKeys = Array.isArray(o.volumeKeys)
    ? o.volumeKeys.filter((k) => k && Number.isFinite(Number(k.t)) && Number.isFinite(Number(k.v))).map((k) => ({ t: Math.max(0, Number(k.t)), v: clamp(Number(k.v), 0, 2) })).sort((x, y) => x.t - y.t)
    : [];
  o.denoise = !!o.denoise;
  o.muted = !!o.muted;
  return o;
}

export function createAsset(partial = {}) {
  return {
    id: partial.id || uid('ast'),
    kind: 'video',
    name: '素材',
    path: null,
    duration: 5,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: false,
    size: 0,
    thumb: null,
    // 契约 C3：本地导入记 kind:'local'（type 为旧写法，保留兼容）；调用方传入的 source/license/ai/reference 原样保留
    source: { type: 'local', kind: 'local' },
    tags: [],
    description: '',
    ...partial,
  };
}

export function createClip(asset, partial = {}) {
  // 读不到时长（0 或缺失）时按 5 秒算，避免生成 0.2 秒的碎片段
  const dur = asset && Number(asset.duration) > 0 ? Number(asset.duration) : 5;
  const isStill = asset && (asset.kind === 'image' || asset.kind === 'previz' || asset.kind === 'generated-image');
  const defaultLen = isStill ? Math.min(dur || 4, 4) : Math.min(dur, 8);
  return {
    id: uid('clp'),
    assetId: asset ? asset.id : null,
    in: 0,
    out: Math.max(LIMITS.minClip, defaultLen),
    speed: 1,
    label: '',
    caption: { text: '', style: 'subtitle', position: 'bottom' },
    color: defaultColor(),
    transform: defaultTransform(),
    motion: { preset: 'none', intensity: 0.5 },
    fx: defaultFx(),
    transitionIn: { type: 'cut', duration: 0.5 },
    volume: 1,
    mute: false,
    audioFadeIn: 0,
    audioFadeOut: 0,
    locked: false,
    notes: '',
    shotId: null,
    reverse: false,
    mirror: defaultMirror(),
    still: false,
    speedCurve: null,
    crop: defaultCrop(),
    fit: 'cover',
    canvas: defaultCanvas(),
    opacity: 1,
    blend: 'normal',
    mask: null,
    keys: {},
    muted: false,
    ...partial,
  };
}

export function createTextClip(partial = {}) {
  return {
    id: uid('txt'), start: 0, duration: 3, text: '标题', preset: 'title', x: 0.5, y: 0.5, size: 1, color: '#ffffff', animation: 'fade', locked: false,
    group: null, stroke: null, shadow: null, bg: null, animIn: null, animOut: null, animLoop: null,
    ...partial,
  };
}

export function createAudioClip(asset, partial = {}) {
  const dur = asset && Number(asset.duration) > 0 ? Number(asset.duration) : 10;
  return {
    id: uid('aud'), assetId: asset ? asset.id : null, start: 0, in: 0, out: dur, volume: 1, fadeIn: 0.5, fadeOut: 0.8, role: 'music', locked: false,
    volumeKeys: [], denoise: false, muted: false,
    ...partial,
  };
}

export function createBrief(partial = {}) {
  return {
    title: '', goal: '', audience: '', platform: '其他', duration: 30, aspect: '16:9', style: '', mood: '', look: 'none', pacing: 'medium',
    music: '', keyMessage: '', mustHave: [], avoid: [],
    ...partial,
  };
}

export function createShot(partial = {}) {
  return {
    id: uid('sht'), index: 1, title: '镜头', duration: 4, shotSize: 'medium', angle: 'eye-level', movement: 'static', lighting: '', location: '', subject: '', action: '',
    caption: '', voiceover: '', shootingTips: [], transitionIn: 'cut', look: 'none', referenceQueries: [], techniqueIds: [],
    previz: createPrevizSpec(), assetId: null, status: 'planned',
    aiVideoAssetId: null, aiVideoTask: null, mediaSource: null,
    ...partial,
  };
}

export function createPrevizSpec(partial = {}) {
  return {
    setting: 'studio', timeOfDay: 'day', palette: ['#2b2f3a', '#e0a96d', '#f4efe6'],
    subjects: [{ kind: 'person', x: 0.5, y: 0.62, scale: 1, color: '#e0a96d', action: 'idle', label: '' }],
    camera: { shotSize: 'medium', movement: 'static', angle: 'eye-level' },
    light: { direction: 'left', key: 'warm', mood: 'soft' },
    overlayText: '',
    ...partial,
  };
}

function oneOf(v, list, dflt) { return list.includes(v) ? v : dflt; }
function num(v, lo, hi, dflt) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, lo, hi) : dflt;
}

/** 规范化单个 Clip（缺字段补默认、越界夹紧） */
export function normalizeClip(c, asset) {
  const base = createClip(asset, { id: c && c.id });
  const out = { ...base, ...(c || {}) };
  out.color = { ...defaultColor(), ...(c && c.color) };
  for (const k of ['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'highlights', 'shadows']) out.color[k] = num(out.color[k], -1, 1, 0);
  out.color.vignette = num(out.color.vignette, 0, 1, 0);
  out.color.look = oneOf(out.color.look, LOOKS, 'none');
  out.color.lookStrength = num(out.color.lookStrength, 0, 1, 1);
  out.fx = { ...defaultFx(), ...(c && c.fx) };
  for (const k of FX_KEYS) out.fx[k] = num(out.fx[k], 0, 1, 0);
  out.transform = { ...defaultTransform(), ...(c && c.transform) };
  out.transform.scale = num(out.transform.scale, 0.05, 5, 1);
  out.transform.x = num(out.transform.x, -2, 2, 0);
  out.transform.y = num(out.transform.y, -2, 2, 0);
  out.transform.rotation = num(out.transform.rotation, -180, 180, 0);
  out.transform.flipH = !!out.transform.flipH;
  out.motion = { preset: oneOf(c && c.motion && c.motion.preset, MOTIONS, 'none'), intensity: num(c && c.motion && c.motion.intensity, 0, 1, 0.5) };
  out.transitionIn = {
    type: oneOf(c && c.transitionIn && c.transitionIn.type, TRANSITIONS, 'cut'),
    duration: num(c && c.transitionIn && c.transitionIn.duration, LIMITS.minTransition, LIMITS.maxTransition, 0.5),
  };
  out.caption = { ...base.caption, ...(c && c.caption) };
  out.caption.text = String(out.caption.text || '').slice(0, 300);
  out.caption.style = oneOf(out.caption.style, CAPTION_STYLES, 'subtitle');
  out.caption.position = oneOf(out.caption.position, ['bottom', 'center', 'top'], 'bottom');
  out.speed = num(out.speed, LIMITS.minSpeed, LIMITS.maxSpeed, 1);
  out.volume = num(out.volume, 0, 2, 1);
  out.audioFadeIn = num(out.audioFadeIn, 0, 30, 0);
  out.audioFadeOut = num(out.audioFadeOut, 0, 30, 0);
  out.mute = !!out.mute;
  out.locked = !!out.locked;
  // 读不到时长（duration<=0）的素材不设上限，否则入出点会被压成 0、片段消失
  const maxSrc = asset && (asset.kind === 'video' || asset.kind === 'audio') && Number(asset.duration) > 0 ? Number(asset.duration) : 3600;
  out.still = !!out.still;
  if (out.still) {
    // 定格：in===out 取同一帧，时长存于 duration
    out.in = num(out.in, 0, maxSrc, 0);
    out.out = out.in;
    out.duration = num(out.duration, LIMITS.minClip, LIMITS.maxDuration, 2);
  } else {
    out.in = num(out.in, 0, Math.max(0, maxSrc - LIMITS.minClip), 0);
    out.out = num(out.out, out.in + LIMITS.minClip, maxSrc, Math.min(maxSrc, out.in + 5));
  }
  out.reverse = !!out.reverse;
  const mir = c && c.mirror && typeof c.mirror === 'object' ? c.mirror : {};
  out.mirror = { h: mir.h !== undefined ? !!mir.h : !!out.transform.flipH, v: !!mir.v };
  out.speedCurve = normalizeSpeedCurve(out.speedCurve);
  out.crop = normCrop(out.crop);
  out.fit = oneOf(out.fit, FIT_MODES, 'cover');
  const cv = out.canvas && typeof out.canvas === 'object' ? out.canvas : {};
  out.canvas = { type: oneOf(cv.type, CANVAS_TYPES, 'none'), value: cv.value ?? null };
  out.opacity = num(out.opacity, 0, 1, 1);
  out.blend = oneOf(out.blend, BLEND_MODES, 'normal');
  out.mask = normMask(out.mask);
  out.keys = normalizeKeys(out.keys);
  // 旧字段 mute 与新字段 muted 同义，保持两者一致
  out.muted = c && c.muted !== undefined ? !!c.muted : out.mute;
  out.mute = out.muted;
  if (c && 'denoise' in c) out.denoise = !!c.denoise;
  return out;
}

function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function arr(v) { return Array.isArray(v) ? v.filter(isObj) : []; }

/**
 * 素材记录丢失时的占位素材：保住引用它的片段（时长、调色、关键帧都不丢），
 * 画面按离线处理（预览/导出画占位），用户可在素材区「重新链接」找回。
 */
function missingAsset(id, kind, refs) {
  const dur = Math.max(1, ...refs.map((r) => Number(r.out) || 0).filter(Number.isFinite));
  return createAsset({ id, kind, name: '缺失的素材', path: null, duration: Math.ceil(dur * 100) / 100, missing: true, offline: true, source: { kind: 'local' } });
}

/**
 * 规范化整个项目：补齐旧数据缺的字段，并兜住损坏的数据（单条坏记录不会让整个工程打不开）。
 * opts.report(message)：修复了用户能感知的问题时回调（例如素材记录丢失），由调用方汇总提示。
 * 版本升级（结构迁移）不在这里做，见 migrations.js。
 */
export function normalizeProject(p, opts = {}) {
  const src = isObj(p) ? p : {};
  const report = typeof opts.report === 'function' ? opts.report : () => {};
  const name = typeof src.name === 'string' && src.name.trim() ? src.name : '未命名项目';
  const srcSettings = isObj(src.settings) ? src.settings : {};
  const base = createProject({ name, aspect: srcSettings.aspect });
  const out = { ...base, ...src };
  // 版本按文件里记的；缺失视为第 2 版（由 migrations.js 升级），不会把更新的版本降级
  const ver = Math.floor(Number(src.version));
  out.version = Number.isFinite(ver) && ver >= 1 ? ver : 2;
  out.id = typeof src.id === 'string' && src.id ? src.id : base.id;
  out.name = name;
  // timeline 只取文件里的：新工程模板里的 captionsMigrated 不能套到旧工程上
  out.timeline = isObj(src.timeline) ? { ...src.timeline } : {};
  out.settings = { ...createSettings(srcSettings.aspect), ...srcSettings };
  const a = ASPECTS[out.settings.aspect] || ASPECTS['16:9'];
  out.settings.width = a.width; out.settings.height = a.height;
  out.settings.fps = num(out.settings.fps, 12, 60, 30);

  // 素材：兼容数组写法；丢弃空记录，清洗异常数值字段
  const rawAssets = Array.isArray(src.assets)
    ? Object.fromEntries(src.assets.filter((as) => isObj(as) && as.id).map((as) => [String(as.id), as]))
    : isObj(src.assets) ? src.assets : {};
  out.assets = {};
  for (const [id, as] of Object.entries(rawAssets)) {
    if (!isObj(as)) continue;
    const asset = createAsset({ ...as, id });
    const isStillKind = asset.kind === 'image' || asset.kind === 'sticker' || asset.kind === 'generated-image';
    asset.duration = num(asset.duration, 0, 86400, isStillKind ? 0 : 5);
    const rawW = asset.width === null || asset.width === '' || typeof asset.width === 'boolean' ? NaN : Number(asset.width);
    const rawH = asset.height === null || asset.height === '' || typeof asset.height === 'boolean' ? NaN : Number(asset.height);
    const rawFps = asset.fps === null || asset.fps === '' || typeof asset.fps === 'boolean' ? NaN : Number(asset.fps);
    asset.width = asset.kind === 'audio'
      ? Math.round(num(asset.width, 0, 16384, 0))
      : (Number.isFinite(rawW) && rawW > 0 ? Math.round(clamp(rawW, 1, 16384)) : 1920);
    asset.height = asset.kind === 'audio'
      ? Math.round(num(asset.height, 0, 16384, 0))
      : (Number.isFinite(rawH) && rawH > 0 ? Math.round(clamp(rawH, 1, 16384)) : 1080);
    asset.fps = Number.isFinite(rawFps) && rawFps > 0 ? clamp(rawFps, 1, 240) : 30;
    out.assets[id] = asset;
  }

  const tracks = isObj(src.tracks) ? src.tracks : {};
  const video = arr(tracks.video);
  const audio = arr(tracks.audio);
  const overlays = arr(src.overlays);
  // 片段引用了不存在的素材：补占位素材而不是悄悄删掉片段（删了下次保存就永久丢了）
  const lost = new Map(); // assetId -> { kind, refs }
  const need = (c, kind) => {
    const id = c.assetId;
    if (id === null || id === undefined || id === '' || out.assets[id]) return;
    const k = String(id);
    if (!lost.has(k)) lost.set(k, { kind, refs: [] });
    lost.get(k).refs.push(c);
  };
  video.forEach((c) => need(c, 'video'));
  overlays.forEach((o) => need(o, 'video'));
  audio.forEach((c) => need(c, 'audio'));
  for (const [id, { kind, refs }] of lost) out.assets[id] = missingAsset(id, kind, refs);
  if (lost.size) {
    const n = [...lost.values()].reduce((s, l) => s + l.refs.length, 0);
    report(`${n} 个片段找不到素材记录，已保留并标成「缺失的素材」，可在素材区重新链接`);
  }
  const has = (c) => c.assetId !== null && c.assetId !== undefined && c.assetId !== '' && !!out.assets[c.assetId];
  out.tracks = {
    video: video.filter(has).map((c) => normalizeClip(c, out.assets[c.assetId])),
    text: arr(tracks.text).map((t) => normTextExtra(t)),
    audio: audio.filter(has).map((c) => normAudioExtra(c, out.assets[c.assetId])),
  };
  out.overlays = overlays.filter(has).map((o) => normalizeOverlay(o, out.assets[o.assetId]));
  out.trackState = normalizeTrackState(src.trackState);
  out.markers = arr(src.markers).filter((m) => Number.isFinite(Number(m.t)))
    .map((m) => createMarker({ ...m, t: Math.max(0, Number(m.t)), label: String(m.label || '').slice(0, 60) })).sort((x, y) => x.t - y.t);
  out.exportPreset = typeof src.exportPreset === 'string' ? src.exportPreset : 'custom';
  out.brief = isObj(src.brief) ? createBrief(src.brief) : null;
  out.storyboard = arr(src.storyboard).map((s, i) => createShot({ ...s, index: i + 1, previz: createPrevizSpec(isObj(s.previz) ? s.previz : undefined) }));
  const memory = isObj(src.memory) ? src.memory : {};
  out.memory = { styleGuide: '', decisions: [], colorBaseline: null, ...memory };
  if (!Array.isArray(out.memory.decisions)) out.memory.decisions = [];
  const chats = isObj(src.chats) ? src.chats : {};
  out.chats = { director: [], editor: [], ...chats };
  for (const k of ['director', 'editor']) if (!Array.isArray(out.chats[k])) out.chats[k] = [];
  out.references = isObj(src.references) ? { ...src.references } : {};
  return out;
}
