// AI 结构化输出的严格 JSON Schema 与 AI 操作规范化。
// 严格模式约束（兼容 OpenAI Structured Outputs 等结构化输出接口）：
//  - 所有 object 都 additionalProperties:false，且 properties 全部列入 required
//  - 可空字段用 type:[x,'null']；可空枚举用 anyOf [{enum}, {type:'null'}]
//  - 不使用 minItems/maxItems/minLength/pattern/format/minimum/maximum 等关键字（数量、范围在提示词里约束，解析时再夹紧）
import {
  LOOKS, MOTIONS, TRANSITIONS, FX_KEYS, COLOR_KEYS, CAPTION_STYLES, TEXT_PRESETS, TEXT_ANIMATIONS,
  SHOT_SIZES, ANGLES, SHOT_MOVEMENTS, PREVIZ_SETTINGS, PREVIZ_SUBJECTS, PREVIZ_ACTIONS, TECHNIQUE_CATEGORIES,
  ASPECTS, LIMITS, BLEND_MODES, SPEED_CURVE_PRESETS,
} from '../engine/model.js';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const str = (description) => (description ? { type: 'string', description } : { type: 'string' });
const nstr = (description) => (description ? { type: ['string', 'null'], description } : { type: ['string', 'null'] });
const num = (description) => (description ? { type: 'number', description } : { type: 'number' });
const nnum = (description) => (description ? { type: ['number', 'null'], description } : { type: ['number', 'null'] });
const nint = (description) => (description ? { type: ['integer', 'null'], description } : { type: ['integer', 'null'] });
const nbool = (description) => (description ? { type: ['boolean', 'null'], description } : { type: ['boolean', 'null'] });
const bool = (description) => (description ? { type: 'boolean', description } : { type: 'boolean' });
const arr = (items, description) => (description ? { type: 'array', items, description } : { type: 'array', items });
const enm = (values, description) => (description ? { type: 'string', enum: [...values], description } : { type: 'string', enum: [...values] });
const nenm = (values, description) => {
  const s = { anyOf: [{ type: 'string', enum: [...values] }, { type: 'null' }] };
  if (description) s.description = description;
  return s;
};

/** 构造严格 object：所有属性 required、禁止额外属性 */
export function obj(properties, description) {
  const s = { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
  if (description) s.description = description;
  return s;
}

export const PLATFORMS = ['抖音', 'B站', '小红书', 'YouTube', '朋友圈', '其他'];
export const PACINGS = ['slow', 'medium', 'fast'];
export const ASPECT_KEYS = Object.keys(ASPECTS);
export const TARGET_MODES = ['selected', 'index', 'ids', 'range', 'all', 'none'];
export const CAPTION_POSITIONS = ['bottom', 'center', 'top'];
export const AUDIO_ROLES = ['music', 'sfx', 'voice'];
export const TIMES_OF_DAY = ['day', 'golden', 'night', 'blue'];
export const LIGHT_DIRECTIONS = ['left', 'right', 'top', 'back', 'front'];
export const LIGHT_KEYS = ['warm', 'cool', 'neutral'];
export const LIGHT_MOODS = ['bright', 'soft', 'dramatic', 'night'];

/** AI 可以输出的操作类型（matchColor 需要完整 ColorStats，交给 harmonize 代替） */
export const AI_OP_TYPES = [
  'setColor', 'setLook', 'setMotion', 'setTransform', 'setFx', 'setTransition', 'setCaption', 'setSpeed', 'setVolume',
  'trim', 'setDuration', 'split', 'delete', 'duplicate', 'move', 'insertAsset', 'replaceAsset', 'lock', 'unlock',
  'addText', 'updateText', 'removeText', 'addAudio', 'updateAudio', 'removeAudio', 'harmonize', 'applyPacing', 'setProject',
  // 扩展剪辑操作（倒放/镜像/曲线变速/定格/波纹删除/分轨/标记/自动闪避/节拍对齐等）
  'setClipProps', 'setSpeedCurve', 'freezeFrame', 'rippleDelete', 'detachAudio', 'addMarker', 'autoDuck', 'snapCutsToBeats',
  'setTransitionAll', 'clearCaptions',
];
export const SPEED_PRESET_KEYS = Object.keys(SPEED_CURVE_PRESETS);

/** 不作用于主轨镜头的操作（target 固定为 none） */
const NO_TARGET_TYPES = new Set(['insertAsset', 'addText', 'updateText', 'removeText', 'addAudio', 'updateAudio', 'removeAudio', 'setProject', 'freezeFrame', 'addMarker', 'autoDuck', 'snapCutsToBeats', 'setTransitionAll', 'clearCaptions']);

// ---------------------------------------------------------------------------
// 扁平操作 Schema（EDIT / 技法卡共用）
// ---------------------------------------------------------------------------
const FX_FIELD = { blur: 'fxBlur', grain: 'fxGrain', glow: 'fxGlow', sharpen: 'fxSharpen', letterbox: 'fxLetterbox', chromatic: 'fxChromatic', vhs: 'fxVhs', flash: 'fxFlash' };

export const AI_OP_SCHEMA = obj({
  type: enm(AI_OP_TYPES, '操作类型'),
  targetMode: enm(TARGET_MODES, '作用对象：selected=用户所选镜头，index=按编号，ids=按镜头 id，range=聚焦/框选范围内，all=全部镜头，none=不针对镜头（插入素材/文字/音频/画幅）'),
  indices: arr({ type: 'integer' }, 'targetMode=index 时的镜头编号（从 1 开始）；否则为空数组'),
  ids: arr({ type: 'string' }, 'targetMode=ids 时的镜头 id；否则为空数组'),
  exposure: nnum('曝光 -1..1'),
  contrast: nnum('对比度 -1..1'),
  saturation: nnum('饱和度 -1..1'),
  temperature: nnum('色温 -1..1，正=暖'),
  tint: nnum('色调 -1..1，正=偏绿'),
  highlights: nnum('高光 -1..1'),
  shadows: nnum('阴影 -1..1'),
  vignette: nnum('暗角 0..1'),
  relative: nbool('setColor/setFx/trim：true=在当前值上增减'),
  look: nenm(LOOKS, 'setLook 的风格预设'),
  lookStrength: nnum('setLook 强度 0..1'),
  preset: nenm(MOTIONS, 'setMotion 的运镜预设'),
  intensity: nnum('setMotion 强度 0..1'),
  scale: nnum('setTransform 缩放 0.05..5'),
  offsetX: nnum('setTransform 水平偏移 -2..2'),
  offsetY: nnum('setTransform 垂直偏移 -2..2'),
  rotation: nnum('setTransform 旋转角度'),
  fxBlur: nnum('setFx 模糊 0..1'),
  fxGrain: nnum('setFx 胶片颗粒 0..1'),
  fxGlow: nnum('setFx 辉光 0..1'),
  fxSharpen: nnum('setFx 锐化 0..1'),
  fxLetterbox: nnum('setFx 电影黑边 0..1'),
  fxChromatic: nnum('setFx 色差 0..1'),
  fxVhs: nnum('setFx VHS 0..1'),
  fxFlash: nnum('setFx 闪白 0..1'),
  transitionType: nenm(TRANSITIONS, 'setTransition 入场转场类型'),
  transitionDuration: nnum('setTransition 转场时长 0.1..2 秒'),
  captionText: nstr('setCaption 字幕文字'),
  captionStyle: nenm(CAPTION_STYLES, 'setCaption 字幕样式'),
  captionPosition: nenm(CAPTION_POSITIONS, 'setCaption 字幕位置'),
  speed: nnum('setSpeed 倍速 0.1..10'),
  volume: nnum('setVolume 音量 0..2 / updateAudio 音量'),
  mute: nbool('setVolume 静音'),
  fadeIn: nnum('setVolume 声音淡入秒数'),
  fadeOut: nnum('setVolume 声音淡出秒数'),
  trimIn: nnum('trim 源入点（秒）'),
  trimOut: nnum('trim 源出点（秒）'),
  duration: nnum('setDuration 镜头时长 / insertAsset 时长（秒）'),
  at: nnum('split 分割点（时间线秒）'),
  toIndex: nint('move 目标位置（从 1 开始）'),
  assetId: nstr('insertAsset/replaceAsset/addAudio 使用的素材 id（必须来自提供的素材列表）'),
  atIndex: nint('insertAsset 插入位置（从 1 开始，null=末尾）'),
  textId: nstr('updateText/removeText 的文字 id'),
  textContent: nstr('addText/updateText 的文字内容'),
  textPreset: nenm(TEXT_PRESETS, 'addText/updateText 文字样式'),
  textStart: nnum('addText 开始时间（秒）'),
  textDuration: nnum('addText 持续秒数'),
  textY: nnum('addText 垂直位置 0..1（0.5=居中，0.85=下方）'),
  textAnimation: nenm(TEXT_ANIMATIONS, 'addText 动画'),
  audioId: nstr('updateAudio/removeAudio 的音频片段 id'),
  audioStart: nnum('addAudio/updateAudio 开始时间（秒）'),
  audioRole: nenm(AUDIO_ROLES, 'addAudio 角色'),
  strength: nnum('harmonize 强度 0..1'),
  pacing: nenm(PACINGS, 'applyPacing 节奏'),
  aspect: nenm(ASPECT_KEYS, 'setProject 画幅'),
  reverse: nbool('setClipProps 倒放'),
  mirrorH: nbool('setClipProps 水平镜像'),
  mirrorV: nbool('setClipProps 垂直镜像'),
  opacity: nnum('setClipProps 不透明度 0..1'),
  blend: nenm(BLEND_MODES, 'setClipProps 混合模式'),
  speedPreset: nenm(SPEED_PRESET_KEYS, 'setSpeedCurve 曲线变速预设；null=取消曲线变速'),
  freezeDuration: nnum('freezeFrame 定格时长（秒，默认 2）'),
  markerLabel: nstr('addMarker 标记名称'),
  duckAmount: nnum('autoDuck 人声出现时音乐降到的比例 0..1（默认 0.25）'),
});

// ---------------------------------------------------------------------------
// 分镜 Schema
// ---------------------------------------------------------------------------
export const PREVIZ_SCHEMA = obj({
  setting: enm(PREVIZ_SETTINGS, '预演场景'),
  timeOfDay: enm(TIMES_OF_DAY, '时间段'),
  palette: arr({ type: 'string' }, '3 个十六进制主色，如 #f2c48d'),
  subjects: arr(obj({
    kind: enm(PREVIZ_SUBJECTS),
    x: num('0..1 画面水平位置'),
    y: num('0..1 画面垂直位置（脚/底部所在）'),
    scale: num('0.2..2 相对大小'),
    color: str('十六进制颜色'),
    action: enm(PREVIZ_ACTIONS),
    label: str('简短标签，如「店员」「拿铁」'),
  }), '1–4 个主体'),
  light: obj({
    direction: enm(LIGHT_DIRECTIONS),
    key: enm(LIGHT_KEYS),
    mood: enm(LIGHT_MOODS),
  }),
  overlayText: str('画面上叠加的文字（无则空字符串）'),
}, '用于生成 AI 预演动画');

export const SHOT_SCHEMA = obj({
  title: str('镜头标题，6–14 字'),
  duration: num('秒'),
  shotSize: enm(SHOT_SIZES),
  angle: enm(ANGLES),
  movement: enm(SHOT_MOVEMENTS),
  lighting: str('光线描述，如「窗光侧逆，暖色」'),
  location: str('拍摄地点'),
  subject: str('主体'),
  action: str('动作/画面内容'),
  caption: str('屏幕字幕（无则空字符串）'),
  voiceover: str('旁白/台词（无则空字符串）'),
  shootingTips: arr({ type: 'string' }, '3–4 条具体拍法（每条不超过 45 字）：手机怎么拿、站哪、几倍焦段、灯放哪、提前准备什么'),
  transitionIn: enm(TRANSITIONS),
  look: enm(LOOKS),
  referenceQueries: arr({ type: 'string' }, '2 条联网找参考的搜索词：第一条中文，第二条英文'),
  techniqueIds: arr({ type: 'string' }, '只能使用提供的技法卡 id'),
  previz: PREVIZ_SCHEMA,
});

const BRIEF_PATCH_SCHEMA = obj({
  title: nstr('片名'),
  goal: nstr('目的'),
  audience: nstr('目标受众'),
  platform: nenm(PLATFORMS, '发布平台'),
  duration: nnum('总时长（秒）'),
  aspect: nenm(ASPECT_KEYS, '画幅'),
  style: nstr('风格'),
  mood: nstr('情绪'),
  look: nenm(LOOKS, '调色风格'),
  pacing: nenm(PACINGS, '节奏'),
  music: nstr('音乐建议'),
  keyMessage: nstr('核心信息'),
  mustHave: { type: ['array', 'null'], items: { type: 'string' }, description: '必须出现的内容' },
  avoid: { type: ['array', 'null'], items: { type: 'string' }, description: '要避免的内容' },
}, '只填本轮新确定或要修改的字段，其余为 null');

export const DIRECTOR_SCHEMA = obj({
  reply: str('对用户说的话（中文，口语、专业、简洁）'),
  questions: arr({ type: 'string' }, '还需要用户回答的关键问题（0–4 个）'),
  briefPatch: BRIEF_PATCH_SCHEMA,
  readyForStoryboard: bool('信息是否已足够生成分镜'),
  storyboard: { anyOf: [arr(SHOT_SCHEMA), { type: 'null' }], description: '只有用户要求出分镜且信息足够时才给出，否则 null' },
});

export const STORYBOARD_SCHEMA = obj({
  reply: str('给用户的一段说明：整体思路、节奏安排、拍摄前提醒'),
  styleGuide: str('全片风格指南：色调、光线、运镜、字幕、音乐的统一规则（3–6 句）'),
  shots: arr(SHOT_SCHEMA, '按顺序的分镜'),
});

// ---------------------------------------------------------------------------
// 精修 Schema（先写计划，每步带理由，做不到的单独列出，不硬凑操作）
// ---------------------------------------------------------------------------
/** 精修用的操作：在扁平操作上多一个 reason（只用于展示，执行时丢弃） */
export const EDIT_OP_SCHEMA = obj({
  ...AI_OP_SCHEMA.properties,
  reason: str('这一步为什么这样改（中文一句话，说人话，不写字段名）'),
});

const MATERIAL_REQUEST_SCHEMA = obj({
  query: str('搜索素材用的关键词（中文或英文）'),
  purpose: str('这个素材用来做什么'),
  atIndex: nint('希望插入的位置（从 1 开始），不确定为 null'),
  duration: nnum('建议时长（秒）'),
});

export const EDIT_SCHEMA = obj({
  plan: obj({
    goal: str('用一句话复述用户想要的效果'),
    steps: arr({ type: 'string' }, '打算怎么做，1–5 步中文短句'),
    assumptions: arr({ type: 'string' }, '指令不明确时你做的假设（例如把「这段」理解为第 3 个片段）；没有则空数组'),
  }, '先想清楚再动手'),
  ops: arr(EDIT_OP_SCHEMA, '将要执行的操作，按顺序'),
  unsupported: arr(obj({
    request: str('用户要求里暂时做不到的部分'),
    why: str('为什么做不到（说人话）'),
    alternative: str('能做到的替代做法，用户可以直接发给你；没有则空串'),
  }), '做不到的要求放这里，不要硬凑操作；没有则空数组'),
  materialRequests: arr(MATERIAL_REQUEST_SCHEMA, '缺少素材时的需求，没有则空数组'),
  reply: str('对用户说明你做了什么、为什么这样能和全片一致（中文，简洁）'),
  memoryNote: nstr('值得写入全片记忆的决定（如「全片统一暖调胶片」「不要用转场」），没有则 null'),
  memoryKind: nenm(['rule', 'note'], 'memoryNote 的类型：rule=用户明确定下、以后都要遵守的规矩（如「不要用转场」），note=一般记录；memoryNote 为 null 时也为 null'),
});

/** 定向修复（只修预检没通过的那几步，最多 1 次） */
export const EDIT_REPAIR_SCHEMA = obj({
  fixes: arr(obj({
    opIndex: { type: 'integer', description: '要修复的那一步的编号（与提示里的编号一致）' },
    ops: arr(EDIT_OP_SCHEMA, '替换这一步的操作；修不好或不该做时为空数组'),
    why: str('怎么修的，或者为什么放弃（中文一句话）'),
  }), '每个出错的步骤一项'),
  reply: str('一句话告诉用户修正了什么（中文）'),
});

// ---------------------------------------------------------------------------
// 拆片 Schema
// ---------------------------------------------------------------------------
export const ANALYZE_SCHEMA = obj({
  summary: str('这段视频讲了什么、怎么拍的（2–4 句）'),
  style: str('整体视听风格（色调、光线、运镜、剪辑节奏）'),
  structure: arr(obj({
    label: str('段落名，如「钩子」「卖点展示」「行动号召」'),
    start: num('秒'),
    end: num('秒'),
    description: str('这一段做了什么'),
  })),
  highlights: arr({ type: 'string' }, '最值得学习的 3–6 个亮点'),
  shots: arr(obj({
    index: { type: 'integer', description: '镜头 index（与提供的编号一致）' },
    shotSize: enm(SHOT_SIZES),
    angle: enm(ANGLES),
    movement: enm(SHOT_MOVEMENTS),
    lighting: str('光线'),
    composition: str('构图'),
    subject: str('主体'),
    transitionIn: enm(TRANSITIONS),
    purpose: str('这个镜头在片中的作用'),
    notes: str('可学习的细节'),
  })),
  techniques: arr(obj({
    category: enm(TECHNIQUE_CATEGORIES),
    title: str('技法名，6–16 字'),
    summary: str('2 句话说明'),
    steps: arr({ type: 'string' }, '3–6 步可执行步骤'),
    whenToUse: str('适用场景'),
    tags: arr({ type: 'string' }),
    start: nnum('示例片段开始（秒）'),
    end: nnum('示例片段结束（秒）'),
    ops: arr(AI_OP_SCHEMA, '能在时间线上一键套用的操作（targetMode 用 selected），不能套用则空数组'),
    applyNote: nstr('套用说明'),
  }), '2–6 条可复用技法卡'),
});

export const TAGS_SCHEMA = obj({
  tags: arr({ type: 'string' }, '3–8 个中文标签'),
  description: str('一句话描述画面内容'),
});

export const ALL_SCHEMAS = { DIRECTOR_SCHEMA, STORYBOARD_SCHEMA, SHOT_SCHEMA, EDIT_SCHEMA, EDIT_REPAIR_SCHEMA, ANALYZE_SCHEMA, TAGS_SCHEMA };

// ---------------------------------------------------------------------------
// normalizeAiOps：扁平 AI 操作 → 标准引擎 Op（丢弃非法值与无效操作）
// ---------------------------------------------------------------------------
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function toNum(v) {
  if (isNum(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}
function clampN(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function pickNum(v, lo, hi) { const n = toNum(v); return n == null ? null : clampN(n, lo, hi); }
function pickInt(v, lo, hi) { const n = toNum(v); return n == null ? null : clampN(Math.round(n), lo, hi); }
function pickEnum(v, list) { return typeof v === 'string' && list.includes(v) ? v : null; }
function pickStr(v, max = 300) { return typeof v === 'string' ? v.slice(0, max) : null; }
function pickBool(v) { return typeof v === 'boolean' ? v : null; }

function normTarget(raw, type) {
  if (NO_TARGET_TYPES.has(type)) return { mode: 'none', indices: [], ids: [] };
  let mode = pickEnum(raw.targetMode, TARGET_MODES) || (raw.target && pickEnum(raw.target.mode, TARGET_MODES)) || 'selected';
  const rawIdx = Array.isArray(raw.indices) ? raw.indices : (raw.target && Array.isArray(raw.target.indices) ? raw.target.indices : []);
  const rawIds = Array.isArray(raw.ids) ? raw.ids : (raw.target && Array.isArray(raw.target.ids) ? raw.target.ids : []);
  const indices = Array.from(new Set(rawIdx.map((n) => toNum(n)).filter((n) => n != null && n >= 1).map((n) => Math.round(n)))).slice(0, LIMITS.maxClips);
  const ids = Array.from(new Set(rawIds.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())));
  if (mode === 'none') mode = 'selected'; // 针对镜头的操作不能没有对象
  if (mode === 'index' && !indices.length) return null;
  if (mode === 'ids' && !ids.length) return null;
  return { mode, indices: mode === 'index' ? indices : [], ids: mode === 'ids' ? ids : [] };
}

function compact(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

/**
 * 把单条扁平 AI 操作转为标准引擎 Op；无效返回 null。
 * 也接受已经是标准引擎 Op 结构的对象（兼容技法卡里存的 ops）。
 */
export function normalizeAiOp(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = pickEnum(raw.type, AI_OP_TYPES) || (raw.type === 'matchColor' ? 'matchColor' : null);
  if (!type) return null;
  const target = normTarget(raw, type);
  if (!target) return null;
  const op = { type, target };
  const relative = pickBool(raw.relative) === true;
  switch (type) {
    case 'setColor': {
      const src = raw.color && typeof raw.color === 'object' ? { ...raw, ...raw.color } : raw;
      const color = {};
      for (const k of COLOR_KEYS) {
        const lo = k === 'vignette' && !relative ? 0 : -1;
        const v = pickNum(src[k], lo, 1);
        if (v != null) color[k] = v;
      }
      if (!Object.keys(color).length) return null;
      op.color = color; op.relative = relative;
      return op;
    }
    case 'setLook': {
      const look = pickEnum(raw.look, LOOKS);
      if (!look) return null;
      op.look = look; op.lookStrength = pickNum(raw.lookStrength, 0, 1) ?? 1;
      return op;
    }
    case 'setMotion': {
      const preset = pickEnum(raw.preset, MOTIONS);
      if (!preset) return null;
      op.preset = preset; op.intensity = pickNum(raw.intensity, 0, 1) ?? 0.5;
      return op;
    }
    case 'setTransform': {
      const src = raw.transform && typeof raw.transform === 'object' ? raw.transform : {};
      const transform = compact({
        scale: pickNum(raw.scale ?? src.scale, 0.05, 5),
        x: pickNum(raw.offsetX ?? src.x, -2, 2),
        y: pickNum(raw.offsetY ?? src.y, -2, 2),
        rotation: pickNum(raw.rotation ?? src.rotation, -180, 180),
      });
      if (pickBool(src.flipH) != null) transform.flipH = src.flipH;
      if (!Object.keys(transform).length) return null;
      op.transform = transform;
      return op;
    }
    case 'setFx': {
      const src = raw.fx && typeof raw.fx === 'object' ? raw.fx : {};
      const fx = {};
      for (const k of FX_KEYS) {
        const v = pickNum(raw[FX_FIELD[k]] ?? src[k], relative ? -1 : 0, 1);
        if (v != null) fx[k] = v;
      }
      if (!Object.keys(fx).length) return null;
      op.fx = fx; op.relative = relative;
      return op;
    }
    case 'setTransition': {
      const src = raw.transition && typeof raw.transition === 'object' ? raw.transition : {};
      const t = pickEnum(raw.transitionType ?? src.type, TRANSITIONS);
      if (!t) return null;
      op.transition = { type: t, duration: pickNum(raw.transitionDuration ?? src.duration, LIMITS.minTransition, LIMITS.maxTransition) ?? 0.5 };
      return op;
    }
    case 'setCaption': {
      const src = raw.caption && typeof raw.caption === 'object' ? raw.caption : {};
      const caption = compact({
        text: pickStr(raw.captionText ?? src.text),
        style: pickEnum(raw.captionStyle ?? src.style, CAPTION_STYLES),
        position: pickEnum(raw.captionPosition ?? src.position, CAPTION_POSITIONS),
      });
      if (!Object.keys(caption).length) return null;
      op.caption = caption;
      return op;
    }
    case 'setSpeed': {
      const s = pickNum(raw.speed, LIMITS.minSpeed, LIMITS.maxSpeed);
      if (s == null) return null;
      op.speed = s;
      return op;
    }
    case 'setVolume': {
      const p = compact({
        volume: pickNum(raw.volume, 0, 2),
        mute: pickBool(raw.mute),
        audioFadeIn: pickNum(raw.fadeIn ?? raw.audioFadeIn, 0, 10),
        audioFadeOut: pickNum(raw.fadeOut ?? raw.audioFadeOut, 0, 10),
      });
      if (!Object.keys(p).length) return null;
      Object.assign(op, p);
      return op;
    }
    case 'trim': {
      const lo = relative ? -3600 : 0;
      const p = compact({ in: pickNum(raw.trimIn ?? raw.in, lo, 3600), out: pickNum(raw.trimOut ?? raw.out, lo, 3600) });
      if (!Object.keys(p).length) return null;
      Object.assign(op, p); op.relative = relative;
      return op;
    }
    case 'setDuration': {
      const d = pickNum(raw.duration, LIMITS.minClip, LIMITS.maxDuration);
      if (d == null) return null;
      op.duration = d;
      return op;
    }
    case 'split': {
      const at = pickNum(raw.at, 0, LIMITS.maxDuration);
      if (at == null) return null;
      op.at = at;
      return op;
    }
    case 'move': {
      const to = pickInt(raw.toIndex, 1, LIMITS.maxClips);
      if (to == null) return null;
      op.toIndex = to;
      return op;
    }
    case 'insertAsset': {
      const assetId = pickStr(raw.assetId, 120);
      if (!assetId) return null;
      op.assetId = assetId;
      const at = pickInt(raw.atIndex, 1, LIMITS.maxClips + 1);
      if (at != null) op.atIndex = at;
      const d = pickNum(raw.duration, LIMITS.minClip, LIMITS.maxDuration);
      if (d != null) op.duration = d;
      const i = pickNum(raw.trimIn ?? raw.in, 0, 3600); if (i != null) op.in = i;
      const o = pickNum(raw.trimOut ?? raw.out, 0, 3600); if (o != null && (i == null || o > i)) op.out = o;
      return op;
    }
    case 'replaceAsset': {
      const assetId = pickStr(raw.assetId, 120);
      if (!assetId) return null;
      op.assetId = assetId;
      return op;
    }
    case 'addText': {
      const src = raw.text && typeof raw.text === 'object' ? raw.text : {};
      const text = pickStr(raw.textContent ?? src.text, 200);
      if (!text || !text.trim()) return null;
      op.text = compact({
        text,
        preset: pickEnum(raw.textPreset ?? src.preset, TEXT_PRESETS),
        start: pickNum(raw.textStart ?? src.start, 0, LIMITS.maxDuration),
        duration: pickNum(raw.textDuration ?? src.duration, 0.3, 60),
        y: pickNum(raw.textY ?? src.y, 0, 1),
        animation: pickEnum(raw.textAnimation ?? src.animation, TEXT_ANIMATIONS),
      });
      return op;
    }
    case 'updateText': {
      const textId = pickStr(raw.textId, 120);
      if (!textId) return null;
      const src = raw.text && typeof raw.text === 'object' ? raw.text : {};
      const text = compact({
        text: pickStr(raw.textContent ?? src.text, 200),
        preset: pickEnum(raw.textPreset ?? src.preset, TEXT_PRESETS),
        start: pickNum(raw.textStart ?? src.start, 0, LIMITS.maxDuration),
        duration: pickNum(raw.textDuration ?? src.duration, 0.3, 60),
        y: pickNum(raw.textY ?? src.y, 0, 1),
        animation: pickEnum(raw.textAnimation ?? src.animation, TEXT_ANIMATIONS),
      });
      if (!Object.keys(text).length) return null;
      op.textId = textId; op.text = text;
      return op;
    }
    case 'removeText': {
      const textId = pickStr(raw.textId, 120);
      if (!textId) return null;
      op.textId = textId;
      return op;
    }
    case 'addAudio': {
      const src = raw.audio && typeof raw.audio === 'object' ? raw.audio : {};
      const assetId = pickStr(raw.assetId ?? src.assetId, 120);
      if (!assetId) return null;
      op.audio = compact({
        assetId,
        start: pickNum(raw.audioStart ?? src.start, 0, LIMITS.maxDuration),
        volume: pickNum(raw.volume ?? src.volume, 0, 2),
        role: pickEnum(raw.audioRole ?? src.role, AUDIO_ROLES),
        fadeIn: pickNum(raw.fadeIn ?? src.fadeIn, 0, 10),
        fadeOut: pickNum(raw.fadeOut ?? src.fadeOut, 0, 10),
      });
      return op;
    }
    case 'updateAudio': {
      const audioId = pickStr(raw.audioId, 120);
      if (!audioId) return null;
      const src = raw.audio && typeof raw.audio === 'object' ? raw.audio : {};
      const audio = compact({
        start: pickNum(raw.audioStart ?? src.start, 0, LIMITS.maxDuration),
        volume: pickNum(raw.volume ?? src.volume, 0, 2),
        role: pickEnum(raw.audioRole ?? src.role, AUDIO_ROLES),
        fadeIn: pickNum(raw.fadeIn ?? src.fadeIn, 0, 10),
        fadeOut: pickNum(raw.fadeOut ?? src.fadeOut, 0, 10),
      });
      if (!Object.keys(audio).length) return null;
      op.audioId = audioId; op.audio = audio;
      return op;
    }
    case 'removeAudio': {
      const audioId = pickStr(raw.audioId, 120);
      if (!audioId) return null;
      op.audioId = audioId;
      return op;
    }
    case 'harmonize':
      op.strength = pickNum(raw.strength, 0, 1) ?? 0.6;
      return op;
    case 'matchColor': {
      if (!raw.reference || typeof raw.reference !== 'object') return null;
      op.reference = raw.reference; op.strength = pickNum(raw.strength, 0, 1) ?? 1;
      return op;
    }
    case 'applyPacing': {
      const pacing = pickEnum(raw.pacing, PACINGS);
      if (pacing) { op.pacing = pacing; return op; }
      if (Array.isArray(raw.durations)) {
        const d = raw.durations.map((x) => pickNum(x, LIMITS.minClip, 60)).filter((x) => x != null);
        if (d.length) { op.durations = d; return op; }
      }
      return null;
    }
    case 'setProject': {
      const aspect = pickEnum(raw.aspect ?? (raw.settings && raw.settings.aspect), ASPECT_KEYS);
      if (!aspect) return null;
      op.settings = { aspect };
      return op;
    }
    case 'delete': case 'duplicate': case 'lock': case 'unlock':
      return op;
    case 'setClipProps': {
      const patch = compact({ reverse: pickBool(raw.reverse), opacity: pickNum(raw.opacity, 0, 1), blend: pickEnum(raw.blend, BLEND_MODES) });
      const mh = pickBool(raw.mirrorH); const mv = pickBool(raw.mirrorV);
      if (mh != null || mv != null) patch.mirror = { h: !!mh, v: !!mv };
      if (raw.patch && typeof raw.patch === 'object') Object.assign(patch, raw.patch);
      if (!Object.keys(patch).length) return null;
      op.patch = patch;
      return op;
    }
    case 'setSpeedCurve': {
      const preset = pickEnum(raw.speedPreset ?? raw.preset, SPEED_PRESET_KEYS);
      if (preset) op.preset = preset;
      else if (Array.isArray(raw.curve)) op.curve = raw.curve;
      else op.curve = null;
      return op;
    }
    case 'freezeFrame': {
      const at = pickNum(raw.at, 0, LIMITS.maxDuration);
      if (at != null) op.at = at;
      op.duration = pickNum(raw.freezeDuration ?? raw.duration, LIMITS.minClip, 30) ?? 2;
      return op;
    }
    case 'rippleDelete': case 'detachAudio':
      if (Array.isArray(raw.ids) && raw.targetMode === undefined && !raw.target) op.ids = raw.ids;
      return op;
    case 'addMarker': {
      const t = pickNum(raw.at ?? raw.t, 0, LIMITS.maxDuration);
      if (t != null) op.t = t;
      const label = pickStr(raw.markerLabel ?? raw.label, 60);
      if (label) op.label = label;
      return op;
    }
    case 'autoDuck':
      op.amount = pickNum(raw.duckAmount ?? raw.amount, 0, 1) ?? 0.25;
      return op;
    case 'snapCutsToBeats': {
      const id = pickStr(raw.assetId, 200);
      if (id) op.assetId = id;
      return op;
    }
    case 'setTransitionAll': {
      const src = raw.transition && typeof raw.transition === 'object' ? raw.transition : {};
      const t = pickEnum(raw.transitionType ?? (typeof raw.transition === 'string' ? raw.transition : src.type), TRANSITIONS);
      if (!t) return null;
      op.transition = t;
      const d = pickNum(raw.transitionDuration ?? raw.duration ?? src.duration, LIMITS.minTransition, LIMITS.maxTransition);
      if (d != null) op.duration = d;
      return op;
    }
    case 'clearCaptions':
      return op;
    default:
      return null;
  }
}

/** 批量规范化：丢弃非法操作，最多 60 条 */
export function normalizeAiOps(rawOps) {
  if (!Array.isArray(rawOps)) return [];
  const out = [];
  for (const r of rawOps) {
    const op = normalizeAiOp(r);
    if (op) out.push(op);
    if (out.length >= 60) break;
  }
  return out;
}

/**
 * 把标准引擎 Op 转成扁平 AI 字段（用于把技法卡示例给 AI 看，或回写成严格 schema 形状）。
 */
export function flattenOp(op) {
  const f = {};
  for (const k of Object.keys(AI_OP_SCHEMA.properties)) f[k] = null;
  f.type = op.type;
  const t = op.target || { mode: 'selected', indices: [], ids: [] };
  f.targetMode = t.mode || 'selected'; f.indices = t.indices || []; f.ids = t.ids || [];
  if (op.color) for (const k of COLOR_KEYS) if (op.color[k] != null) f[k] = op.color[k];
  if ('relative' in op) f.relative = !!op.relative;
  if (op.look) { f.look = op.look; f.lookStrength = op.lookStrength ?? 1; }
  if (op.preset && op.type !== 'setSpeedCurve') { f.preset = op.preset; f.intensity = op.intensity ?? 0.5; }
  if (op.type === 'setSpeedCurve') f.speedPreset = op.preset ?? null;
  if (op.type === 'setClipProps' && op.patch) {
    f.reverse = op.patch.reverse ?? null; f.opacity = op.patch.opacity ?? null; f.blend = op.patch.blend ?? null;
    if (op.patch.mirror) { f.mirrorH = !!op.patch.mirror.h; f.mirrorV = !!op.patch.mirror.v; }
  }
  if (op.type === 'freezeFrame') f.freezeDuration = op.duration ?? 2;
  if (op.type === 'addMarker') { f.at = op.t ?? null; f.markerLabel = op.label ?? null; }
  if (op.type === 'autoDuck') f.duckAmount = op.amount ?? null;
  if (op.type === 'setTransitionAll') { f.transitionType = typeof op.transition === 'string' ? op.transition : op.transition && op.transition.type; f.transitionDuration = op.duration ?? 0.5; }
  if (op.transform) { f.scale = op.transform.scale ?? null; f.offsetX = op.transform.x ?? null; f.offsetY = op.transform.y ?? null; f.rotation = op.transform.rotation ?? null; }
  if (op.fx) for (const k of FX_KEYS) if (op.fx[k] != null) f[FX_FIELD[k]] = op.fx[k];
  if (op.transition && typeof op.transition === 'object') { f.transitionType = op.transition.type; f.transitionDuration = op.transition.duration ?? 0.5; }
  if (op.caption) { f.captionText = op.caption.text ?? null; f.captionStyle = op.caption.style ?? null; f.captionPosition = op.caption.position ?? null; }
  if (op.speed != null) f.speed = op.speed;
  if (op.type === 'setVolume') { f.volume = op.volume ?? null; f.mute = op.mute ?? null; f.fadeIn = op.audioFadeIn ?? null; f.fadeOut = op.audioFadeOut ?? null; }
  if (op.type === 'trim' || op.type === 'insertAsset') { f.trimIn = op.in ?? null; f.trimOut = op.out ?? null; }
  if (op.duration != null && op.type !== 'freezeFrame' && op.type !== 'setTransitionAll') f.duration = op.duration;
  if (op.at != null) f.at = op.at;
  if (op.toIndex != null) f.toIndex = op.toIndex;
  if (op.assetId) f.assetId = op.assetId;
  if (op.atIndex != null) f.atIndex = op.atIndex;
  if (op.textId) f.textId = op.textId;
  if (op.text && typeof op.text === 'object') {
    f.textContent = op.text.text ?? null;
    f.textPreset = op.text.preset ?? null;
    f.textStart = op.text.start ?? null;
    f.textDuration = op.text.duration ?? null;
    f.textY = op.text.y ?? null;
    f.textAnimation = op.text.animation ?? null;
  }
  if (op.audioId) f.audioId = op.audioId;
  if (op.audio && typeof op.audio === 'object') {
    if (op.audio.assetId) f.assetId = op.audio.assetId;
    f.audioStart = op.audio.start ?? null;
    f.audioRole = op.audio.role ?? null;
    f.volume = op.audio.volume ?? null;
    f.fadeIn = op.audio.fadeIn ?? null;
    f.fadeOut = op.audio.fadeOut ?? null;
  }
  if (op.strength != null) f.strength = op.strength;
  if (op.pacing) f.pacing = op.pacing;
  if (op.settings && op.settings.aspect) f.aspect = op.settings.aspect;
  return f;
}
