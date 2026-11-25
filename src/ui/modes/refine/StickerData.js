// 精修 · 素材区的内置资源：贴纸、文字模板/花字、转场/滤镜/特效分组。纯数据 + 添加动作。
import useStore from '../../store.js';

export const STICKER_GROUPS = [
  { id: 'hot', label: '热门', items: ['🔥', '✨', '💯', '👍', '❤️', '😂', '🎉', '⭐', '👀', '💥', '✅', '❗'] },
  { id: 'mood', label: '表情', items: ['😀', '😍', '🤔', '😎', '😭', '😱', '🥳', '😴', '🤩', '😅', '🙌', '👏'] },
  { id: 'life', label: '生活', items: ['☕', '🍜', '🍰', '📷', '🎧', '🚗', '✈️', '🏠', '🌸', '🌙', '☀️', '🌈'] },
  { id: 'shape', label: '形状', items: ['●', '■', '▲', '★', '♥', '◆', '➜', '⬇', '○', '□', '◎', '✕'] },
];

let seq = 0;
function stickerAsset(glyph) {
  const code = Array.from(glyph).map((c) => c.codePointAt(0).toString(16)).join('-');
  return { id: `stk_${code}`, kind: 'sticker', name: `贴纸 ${glyph}`, glyph, source: 'local', duration: 3 };
}

/** 添加贴纸：优先作为画中画 overlay(kind:sticker)；当前版本不支持时退回为大号文字 */
export function addSticker(glyph) {
  const st = useStore.getState();
  if (!st.project) return false;
  const asset = stickerAsset(glyph);
  const start = st.playhead || 0;
  if (!st.project.assets[asset.id]) st.update((p) => ({ ...p, assets: { ...p.assets, [asset.id]: asset } }));
  const r = useStore.getState().commit([{ type: 'addOverlay', assetId: asset.id, start, track: 1 + ((seq++) % 2) }], `添加贴纸 ${glyph}`, { silent: true });
  if (r.ok) { st.toast(`已添加贴纸 ${glyph}，可在画中画轨调整位置和时长`, 'ok'); return true; }
  return addTextPreset({ id: 'sticker', text: glyph, preset: 'big-bold', size: 2.2 }, `添加贴纸 ${glyph}`);
}

// ---------------- 文字 ----------------
export const TEXT_TEMPLATES = [
  { id: 't-title', label: '大标题', text: '输入标题', preset: 'title', sample: 'title' },
  { id: 't-sub', label: '字幕', text: '在这里输入字幕', preset: 'subtitle', sample: 'subtitle' },
  { id: 't-lower', label: '人名条', text: '张三 · 摄影师', preset: 'lower-third', sample: 'lower' },
  { id: 't-box', label: '底框字幕', text: '底框说明文字', preset: 'caption-box', sample: 'box' },
];
export const FANCY_TEXTS = [
  { id: 'f-bold', label: '粗黑描边', text: '重点来了', preset: 'big-bold', color: '#ffffff', sample: 'bold' },
  { id: 'f-yellow', label: '综艺黄', text: '哈哈哈', preset: 'big-bold', color: '#ffd400', sample: 'yellow' },
  { id: 'f-neon', label: '霓虹', text: 'NIGHT', preset: 'neon', color: '#7cf7ff', sample: 'neon' },
  { id: 'f-pink', label: '甜粉', text: '好可爱', preset: 'neon', color: '#ff7ab8', sample: 'pink' },
  { id: 'f-hand', label: '手写', text: '今天也要开心', preset: 'handwrite', color: '#ffffff', sample: 'hand' },
  { id: 'f-red', label: '警示红', text: '注意！', preset: 'big-bold', color: '#ff4d4f', sample: 'red' },
];

/** 在播放头处添加文字（addText op） */
export function addTextPreset(tpl, label) {
  const st = useStore.getState();
  if (!st.project) return false;
  const text = { text: tpl.text, start: Math.max(0, st.playhead || 0), duration: 3, preset: tpl.preset, animation: 'fade' };
  if (tpl.color) text.color = tpl.color;
  if (tpl.size) text.size = tpl.size;
  const r = st.commit([{ type: 'addText', text }], label || `添加文字：${tpl.label || tpl.text}`);
  if (r.ok) st.toast(`已在 ${(st.playhead || 0).toFixed(1)} 秒处添加「${tpl.label || tpl.text}」，在右侧属性区修改内容`, 'ok');
  return r.ok;
}

// ---------------- 转场预览分组（决定 hover 动画） ----------------
export const TRANSITION_ANIM = {
  cut: 'cut', crossfade: 'fade', 'dip-black': 'dipb', 'dip-white': 'dipw',
  'slide-left': 'sl', 'slide-right': 'sr', 'slide-up': 'su', 'slide-down': 'sd',
  'zoom-in': 'zi', 'zoom-out': 'zo', 'wipe-left': 'wl', 'wipe-right': 'wr',
  blur: 'blur', 'whip-pan': 'whip', flash: 'dipw', spin: 'spin',
};

export const FX_ICONS = { blur: 'focus', grain: 'grid', glow: 'sun', sharpen: 'bolt', letterbox: 'film', chromatic: 'layers', vhs: 'camera', flash: 'bolt' };

/** 当前选择的作用目标：有选中镜头 → selected，否则 all */
export function currentTarget() {
  const st = useStore.getState();
  return st.selection.clipIds.length ? { mode: 'selected', indices: [], ids: [] } : { mode: 'all', indices: [], ids: [] };
}
