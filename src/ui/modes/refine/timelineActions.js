// 时间线编辑动作（工具条、右键菜单、快捷键共用）。全部修改走 store.commit(ops, label)。
import { useStore } from '../../store.js';
import { create } from 'zustand';
import { defaultFx } from '../../../engine/model.js';
import { getLayout, seek, pause } from './usePlayback.js';
import { MIN_CLIP, readPref, writePref } from './timelineUtils.js';

/** 时间线本地 UI 状态（吸附、联动、适配请求），快捷键与工具条共用 */
export const useTimelineUI = create((set, get) => ({
  snap: readPref('ff.refine.snap', true) !== false,
  link: readPref('ff.refine.link', true) !== false,
  fitTick: 0,
  setSnap(v) { writePref('ff.refine.snap', !!v); set({ snap: !!v }); },
  setLink(v) {
    const on = !!v;
    writePref('ff.refine.link', on);
    set({ link: on });
    // 联动开关写入 project.timeline.linked，由 ops 读取（PLAN-v3 R2）
    const s = useStore.getState();
    const cur = s.project ? !(s.project.timeline && s.project.timeline.linked === false) : on;
    if (s.project && cur !== on) s.commit([{ type: 'setProject', target: { mode: 'none', indices: [], ids: [] }, settings: { linked: on } }], on ? '开启联动' : '关闭联动');
  },
  toggleSnap() { const v = !get().snap; get().setSnap(v); useStore.getState().toast(v ? '吸附已开启' : '吸附已关闭'); },
  requestFit() { set({ fitTick: get().fitTick + 1 }); },
}));

// 打开/撤销后以工程里的 timeline.linked 为准，保持工具条状态与 ops 一致
if (typeof useStore.subscribe === 'function') {
  useStore.subscribe((state, prev) => {
    if (!state || (prev && state.project === prev.project) || !state.project) return;
    const linked = !(state.project.timeline && state.project.timeline.linked === false);
    if (useTimelineUI.getState().link !== linked) useTimelineUI.setState({ link: linked });
  });
}

export function zoomBy(f) { const s = useStore.getState(); s.setTimelineZoom(s.timelineZoom * f); }

export const targetIds = (ids) => ({ mode: 'ids', indices: [], ids: (ids || []).filter(Boolean) });
export const targetNone = () => ({ mode: 'none', indices: [], ids: [] });

function st() { return useStore.getState(); }
function commit(ops, label) { return st().commit(ops, label); }

function itemOf(project, clipId) {
  return getLayout(project).find((it) => it.clip.id === clipId) || null;
}

/** 右键 / 操作的目标：若点到的镜头在多选里，作用于全部所选，否则只作用于它 */
export function effectiveClipIds(clipId) {
  const sel = st().selection.clipIds || [];
  if (!clipId) return sel.slice();
  return sel.includes(clipId) ? sel.slice() : [clipId];
}

/** 在播放头分割：优先所选且包含播放头的镜头，否则播放头下的镜头 */
export function splitAtPlayhead(clipId) {
  const s = st();
  const project = s.project;
  const layout = getLayout(project);
  if (!project || !layout.length) { s.toast('时间线上还没有镜头'); return false; }
  const t = s.playhead;
  let item = null;
  if (clipId) item = itemOf(project, clipId);
  if (!item) {
    const sel = s.selection.clipIds || [];
    item = layout.find((it) => sel.includes(it.clip.id) && t > it.start && t < it.end) || null;
  }
  if (!item) {
    // 转场重叠期取后一镜；不在任何镜头内则失败
    for (let i = layout.length - 1; i >= 0; i -= 1) { if (layout[i].start < t && layout[i].end > t) { item = layout[i]; break; } }
  }
  if (!item || t <= item.start + MIN_CLIP || t >= item.end - MIN_CLIP) {
    s.toast('请把播放头移到镜头内部再分割（离镜头边缘至少 0.2 秒）');
    return false;
  }
  if (item.clip.locked) { s.toast(`第 ${item.index + 1} 镜已锁定，先解锁再分割`, 'error'); return false; }
  pause();
  return commit([{ type: 'split', target: targetIds([item.clip.id]), at: t }], '分割镜头').ok;
}

/** 删除所选：镜头 / 文字 / 音频 */
export function deleteSelection() {
  const s = st();
  if (!s.project) return false;
  const { clipIds, textId, audioId } = s.selection;
  if (clipIds && clipIds.length) {
    const r = commit([{ type: 'delete', target: targetIds(clipIds) }], clipIds.length > 1 ? `删除 ${clipIds.length} 个镜头` : '删除镜头');
    if (r.ok) s.clearSelection();
    return r.ok;
  }
  if (textId) {
    const r = commit([{ type: 'removeText', target: targetNone(), textId }], '删除文字');
    if (r.ok) s.clearSelection();
    return r.ok;
  }
  if (audioId) {
    const r = commit([{ type: 'removeAudio', target: targetNone(), audioId }], '删除音频');
    if (r.ok) s.clearSelection();
    return r.ok;
  }
  s.toast('先在时间线上选中要删除的镜头、文字或音频');
  return false;
}

export function deleteClips(ids) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return false;
  const r = commit([{ type: 'delete', target: targetIds(list) }], list.length > 1 ? `删除 ${list.length} 个镜头` : '删除镜头');
  if (r.ok) st().clearSelection();
  return r.ok;
}

export function duplicateClips(ids) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) { st().toast('先选中要复制的镜头'); return false; }
  return commit([{ type: 'duplicate', target: targetIds(list) }], list.length > 1 ? `复制 ${list.length} 个镜头` : '复制镜头').ok;
}

/** 有任一未锁定 → 全部锁定；否则全部解锁 */
export function toggleLockClips(ids) {
  const s = st();
  const list = (ids || []).filter(Boolean);
  if (!s.project || !list.length) return false;
  const clips = s.project.tracks.video.filter((c) => list.includes(c.id));
  const lock = clips.some((c) => !c.locked);
  return commit([{ type: lock ? 'lock' : 'unlock', target: targetIds(list) }], lock ? '锁定镜头' : '解锁镜头').ok;
}

/** 清除调色、风格、特效、运镜（保留素材、时长、转场、字幕） */
export function clearEffects(ids) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return false;
  const target = targetIds(list);
  return commit([
    { type: 'setColor', target, color: { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0, vignette: 0 }, relative: false },
    { type: 'setLook', target, look: 'none', lookStrength: 1 },
    { type: 'setFx', target, fx: defaultFx(), relative: false },
    { type: 'setMotion', target, preset: 'none', intensity: 0.5 },
  ], '清除效果').ok;
}

export function moveClip(clipId, toIndex1) {
  return commit([{ type: 'move', target: targetIds([clipId]), toIndex: toIndex1 }], '移动镜头').ok;
}

/** 视频改 in/out（源时间）；图片/预演改时长 */
export function trimClip(clipId, res) {
  if (res.still) return commit([{ type: 'setDuration', target: targetIds([clipId]), duration: res.duration }], '调整镜头时长').ok;
  return commit([{ type: 'trim', target: targetIds([clipId]), in: res.in, out: res.out, relative: false }], '裁剪镜头').ok;
}

export function selectAllClips() {
  const s = st();
  if (!s.project) return;
  s.select(s.project.tracks.video.map((c) => c.id));
}

/** 在播放头添加文字层，并选中它 */
export function addTextAtPlayhead() {
  const s = st();
  if (!s.project) return false;
  const before = new Set((s.project.tracks.text || []).map((t) => t.id));
  const r = commit([{ type: 'addText', target: targetNone(), text: { start: Math.max(0, s.playhead), duration: 3, text: '在检查器里输入文字', preset: 'title' } }], '添加文字');
  if (r.ok) {
    const added = (st().project.tracks.text || []).find((t) => !before.has(t.id));
    if (added) st().selectText(added.id);
  }
  return r.ok;
}

export function updateText(textId, patch, label = '修改文字') {
  return commit([{ type: 'updateText', target: targetNone(), textId, text: patch }], label).ok;
}
export function removeText(textId) {
  const r = commit([{ type: 'removeText', target: targetNone(), textId }], '删除文字');
  if (r.ok) st().clearSelection();
  return r.ok;
}
export function updateAudio(audioId, patch, label = '修改音频') {
  return commit([{ type: 'updateAudio', target: targetNone(), audioId, audio: patch }], label).ok;
}
export function removeAudio(audioId) {
  const r = commit([{ type: 'removeAudio', target: targetNone(), audioId }], '删除音频');
  if (r.ok) st().clearSelection();
  return r.ok;
}

/** 把一个镜头设为聚焦段 */
export function focusClip(clipId) {
  const s = st();
  const item = itemOf(s.project, clipId);
  if (!item) return;
  s.setFocus({ start: item.start, end: item.end });
  seek(item.start);
}

export function jumpToClip(clipId) {
  const item = itemOf(st().project, clipId);
  if (item) { pause(); seek(item.start); }
}

// ======================= v3：W5 op 调用（store.apply） =======================
// PLAN-v3 §3：UI 经 store.apply(op, {label, mergeKey}) 调用。W5 未就绪时退回 commit([op])，
// 引擎不认识的 op 会被校验拒绝并由 store 提示，不会破坏工程。

/** 执行一个 W5 op；返回是否成功 */
export function applyOp(op, label, opts = {}) {
  const s = st();
  if (!s.project) return false;
  try {
    if (typeof s.apply === 'function') {
      const r = s.apply(op, { label, ...opts });
      return !(r && r.ok === false);
    }
    const r = s.commit([{ target: targetNone(), ...op }], label);
    return !!(r && r.ok);
  } catch (err) {
    s.toast((err && err.message) || '操作失败', 'error');
    return false;
  }
}

/** 当前选中的主轨镜头（未选则取播放头下的镜头） */
export function primaryClip() {
  const s = st();
  const layout = getLayout(s.project);
  const sel = s.selection.clipIds || [];
  let item = layout.find((it) => sel.includes(it.clip.id)) || null;
  if (!item) item = layout.find((it) => s.playhead >= it.start && s.playhead < it.end) || null;
  return item;
}

export function selectedOverlayId() {
  const sel = st().selection || {};
  return sel.kind === 'overlay' ? sel.id || null : null;
}

/** 选中画中画 / 标记等（store.selectItem） */
export function selectOverlay(id) {
  const s = st();
  if (typeof s.selectItem === 'function') { s.selectItem('overlay', id); return; }
  useStore.setState({ selection: { ...s.selection, clipIds: [], textId: null, audioId: null, kind: 'overlay', id } });
}
export function selectMarker(id) {
  const s = st();
  if (typeof s.selectItem === 'function') s.selectItem('marker', id);
}

/** 波纹删除所选：镜头 → rippleDelete；画中画 → removeOverlay；其余同普通删除 */
export function rippleDeleteSelection() {
  const s = st();
  const sel = s.selection || {};
  const ov = selectedOverlayId();
  if (ov) { const ok = applyOp({ type: 'removeOverlay', id: ov }, '删除画中画'); if (ok) s.clearSelection(); return ok; }
  if (sel.kind === 'marker' && sel.id) return applyOp({ type: 'removeMarker', id: sel.id }, '删除标记');
  if (sel.clipIds && sel.clipIds.length) {
    const ok = applyOp({ type: 'rippleDelete', ids: sel.clipIds.slice() }, sel.clipIds.length > 1 ? `波纹删除 ${sel.clipIds.length} 个镜头` : '波纹删除');
    if (ok) s.clearSelection();
    return ok;
  }
  return deleteSelection();
}

export function trimLeftAtPlayhead() { pause(); return applyOp({ type: 'trimLeft', at: st().playhead }, '向左裁剪'); }
export function trimRightAtPlayhead() { pause(); return applyOp({ type: 'trimRight', at: st().playhead }, '向右裁剪'); }
export function freezeAtPlayhead(duration = 2) { pause(); return applyOp({ type: 'freezeFrame', at: st().playhead, duration }, '定格画面'); }

function clipPatch(item, patch, label) {
  if (!item) { st().toast('先选中一个镜头'); return false; }
  if (item.clip.locked) { st().toast(`第 ${item.index + 1} 镜已锁定`, 'error'); return false; }
  return applyOp({ type: 'setClipProps', id: item.clip.id, patch }, label);
}
export function toggleReverse() { const it = primaryClip(); return clipPatch(it, { reverse: !(it && it.clip.reverse) }, it && it.clip.reverse ? '取消倒放' : '倒放'); }
export function toggleMirror() {
  const it = primaryClip();
  const m = (it && it.clip.mirror) || { h: false, v: false };
  return clipPatch(it, { mirror: { ...m, h: !m.h } }, m.h ? '取消镜像' : '水平镜像');
}

/** 让检查器切到某个分页（裁剪 / 变速）。W9 可读 store.inspectorTab 或监听 ff:inspector-tab 事件 */
export function openInspectorTab(tab) {
  const s = st();
  const it = primaryClip();
  if (!it && !selectedOverlayId()) { s.toast('先选中一个镜头'); return false; }
  if (it && !(s.selection.clipIds || []).includes(it.clip.id) && !selectedOverlayId()) s.select([it.clip.id]);
  if (typeof s.setInspectorTab === 'function') s.setInspectorTab(tab);
  else useStore.setState({ inspectorTab: tab });
  try { window.dispatchEvent(new CustomEvent('ff:inspector-tab', { detail: { tab } })); } catch { /* node */ }
  return true;
}

export function addMarkerAtPlayhead(label = '') { return applyOp({ type: 'addMarker', t: st().playhead, label }, '添加标记'); }
export function removeMarker(id) { return applyOp({ type: 'removeMarker', id }, '删除标记'); }

/** 轨道锁定/隐藏/静音：track 为 'video' | 'text' | 'audio' | 'overlay:1' … */
export function setTrackProp(track, patch) {
  const word = patch.locked != null ? (patch.locked ? '锁定' : '解锁') : patch.hidden != null ? (patch.hidden ? '隐藏' : '显示') : (patch.muted ? '静音' : '取消静音');
  return applyOp({ type: 'setTrack', track, patch }, `${word}轨道`);
}

export function rollEditAt(at, delta) { return applyOp({ type: 'roll', at, delta }, '滚动剪辑点'); }
export function slipClip(id, delta) { return applyOp({ type: 'slip', id, delta }, '滑动内容'); }
export function setTransitionDuration(clipId, duration) {
  return commit([{ type: 'setTransition', target: targetIds([clipId]), transition: { duration } }], '调整转场时长').ok;
}

export function addOverlayAt(assetId, start, track = 1) { return applyOp({ type: 'addOverlay', assetId, start, track }, '添加画中画'); }
export function updateOverlay(id, patch, label = '修改画中画') { return applyOp({ type: 'updateOverlay', id, patch }, label); }
export function removeOverlay(id) { return applyOp({ type: 'removeOverlay', id }, '删除画中画'); }

/** 框选入点 / 出点（I / O） */
export function markIn() {
  const s = st(); const t = s.playhead; const r = s.range;
  s.setRange({ start: t, end: r && r.end > t ? r.end : Math.max(t + 0.5, (r && r.end) || 0) });
}
export function markOut() {
  const s = st(); const t = s.playhead; const r = s.range;
  s.setRange({ start: r && r.start < t ? r.start : Math.max(0, t - 0.5), end: t });
}

// ---------- 剪贴板 ----------
// { kind:'clips', items:[整段镜头（去掉 id）] } | { kind:'text', text }
// 剪贴板放在模块里，切换工程后还在：粘贴时要核对素材是否还存在。
let clipboard = null;
// 粘贴文字时带过去的只有内容和样式。来源标记（初剪字幕的 source）、跟随的镜头（linkShotId）、
// 分组、行号、锁定都不带：粘贴出来的是一条独立的普通文字。
const TEXT_COPY_KEYS = ['text', 'duration', 'preset', 'x', 'y', 'size', 'color', 'animation', 'stroke', 'shadow', 'bg', 'animIn', 'animOut', 'animLoop', 'font', 'align'];
const cloneJson = (v) => JSON.parse(JSON.stringify(v));

export function copySelection() {
  const s = st();
  const p = s.project;
  if (!p) return false;
  const sel = s.selection;
  if (sel.clipIds && sel.clipIds.length) {
    const items = p.tracks.video.filter((c) => sel.clipIds.includes(c.id)).map((c) => { const { id, ...rest } = cloneJson(c); return rest; });
    if (items.length) {
      clipboard = { kind: 'clips', items };
      s.toast(`已复制 ${items.length} 个镜头`);
      return true;
    }
  }
  if (sel.textId) {
    const t = (p.tracks.text || []).find((x) => x.id === sel.textId);
    if (t) {
      const text = {};
      for (const k of TEXT_COPY_KEYS) if (t[k] !== undefined && t[k] !== null) text[k] = cloneJson(t[k]);
      clipboard = { kind: 'text', text };
      s.toast('已复制文字');
      return true;
    }
  }
  s.toast('先选中要复制的镜头或文字');
  return false;
}
export function pasteAtPlayhead() {
  const s = st();
  if (!s.project || !clipboard) { s.toast('剪贴板是空的'); return false; }
  if (clipboard.kind === 'text') {
    const before = new Set((s.project.tracks.text || []).map((t) => t.id));
    const r = commit([{ type: 'addText', target: targetNone(), text: { ...clipboard.text, start: Math.max(0, s.playhead) } }], '粘贴文字');
    if (r.ok) {
      const added = (st().project.tracks.text || []).find((t) => !before.has(t.id));
      if (added) st().selectText(added.id);
    }
    return r.ok;
  }
  // 切换过工程后，素材可能已经不在这个工程里了：只粘贴还能用的
  const items = clipboard.items.filter((c) => c && s.project.assets[c.assetId]);
  if (!items.length) { s.toast('复制的镜头用到的素材不在这个项目里，无法粘贴', 'warn'); return false; }
  const layout = getLayout(s.project);
  let idx = layout.findIndex((it) => s.playhead < (it.start + it.end) / 2);
  if (idx < 0) idx = layout.length;
  const before = new Set(s.project.tracks.video.map((c) => c.id));
  // 带上整段镜头：调色、特效、变速、定格、裁剪都保留
  const ops = items.map((c, i) => ({ type: 'insertAsset', target: targetNone(), assetId: c.assetId, clip: c, atIndex: idx + 1 + i }));
  const r = commit(ops, ops.length > 1 ? `粘贴 ${ops.length} 个镜头` : '粘贴镜头');
  if (r.ok) {
    const added = st().project.tracks.video.filter((c) => !before.has(c.id)).map((c) => c.id);
    if (added.length) st().select(added);
    if (items.length < clipboard.items.length) s.toast(`有 ${clipboard.items.length - items.length} 个镜头的素材不在这个项目里，没有粘贴`, 'warn');
  }
  return r.ok;
}
export function duplicateSelection() {
  const sel = st().selection;
  if (sel.clipIds && sel.clipIds.length) return duplicateClips(sel.clipIds);
  if (copySelection()) return pasteAtPlayhead();
  return false;
}
