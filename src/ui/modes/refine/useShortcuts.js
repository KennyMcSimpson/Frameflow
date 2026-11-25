// 精修模式快捷键：从 src/ui/shortcuts/registry.js 注册表分发（按 e.code，输入法下也可用）。
// 只在精修模式激活时注册；焦点在输入控件或有对话框打开时不触发（? 帮助除外）。
// scope='global' 的快捷键（撤销/重做/保存/导出/设置）由外壳 App.jsx 处理，这里不重复处理。
import { useEffect } from 'react';
import { useStore } from '../../store.js';
import { keymapFor, matchShortcut } from '../../shortcuts/customKeys.js';
import { togglePlay, play, pause, stepFrames, stepSeconds, goStart, goEnd, getLayout, seek, shuttle, setRate, useShuttle } from './usePlayback.js';
import {
  splitAtPlayhead, selectAllClips, rippleDeleteSelection, trimLeftAtPlayhead, trimRightAtPlayhead,
  markIn, markOut, addMarkerAtPlayhead, addTextAtPlayhead, copySelection, pasteAtPlayhead, duplicateSelection,
  useTimelineUI, zoomBy,
} from './timelineActions.js';
import { editPoints, nextEditPoint } from './timelineUtils.js';

export function isTypingTarget(el) {
  if (!el || el === document.body) return false;
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const type = (el.type || '').toLowerCase();
    return !(tag === 'input' && (type === 'range' || type === 'checkbox' || type === 'button'));
  }
  if (el.isContentEditable) return true;
  return !!(el.closest && el.closest('[contenteditable=""], [contenteditable="true"]'));
}

function anyDialogOpen(st) {
  const d = st.dialogs || {};
  if (Object.values(d).some(Boolean)) return true;
  return typeof document !== 'undefined' && !!document.querySelector('.modal-backdrop');
}

function jumpEdit(dir) {
  const st = useStore.getState();
  const markers = (st.project && st.project.markers || []).map((m) => m.t);
  const p = nextEditPoint(editPoints(getLayout(st.project), markers), st.playhead, dir);
  if (p != null) { pause(); seek(p); }
}

const HANDLERS = {
  playPause: () => {
    if (document.activeElement && document.activeElement.tagName === 'BUTTON') document.activeElement.blur();
    const r = useShuttle.getState().rate;
    if (r && r !== 1) { setRate(0); return; }
    togglePlay();
  },
  shuttleBack: () => shuttle('J'),
  shuttleStop: () => shuttle('K'),
  shuttleFwd: () => shuttle('L'),
  frameBack: () => stepFrames(-1),
  frameFwd: () => stepFrames(1),
  secBack: () => stepSeconds(-1),
  secFwd: () => stepSeconds(1),
  prevEdit: () => jumpEdit(-1),
  nextEdit: () => jumpEdit(1),
  goStart: () => goStart(),
  goEnd: () => goEnd(),
  split: () => splitAtPlayhead(),
  rippleDelete: () => rippleDeleteSelection(),
  trimLeft: () => trimLeftAtPlayhead(),
  trimRight: () => trimRightAtPlayhead(),
  markIn: () => markIn(),
  markOut: () => markOut(),
  addMarker: () => addMarkerAtPlayhead(),
  addText: () => addTextAtPlayhead(),
  selectAll: () => selectAllClips(),
  copy: () => copySelection(),
  paste: () => pasteAtPlayhead(),
  duplicate: () => duplicateSelection(),
  zoomIn: () => zoomBy(1.25),
  zoomOut: () => zoomBy(1 / 1.25),
  zoomFit: () => useTimelineUI.getState().requestFit(),
  toggleSnap: () => useTimelineUI.getState().toggleSnap(),
  help: () => useStore.getState().openDialog('shortcuts'),
  escape: () => {
    const st = useStore.getState();
    const sel = st.selection || {};
    const hasSel = (sel.clipIds && sel.clipIds.length) || sel.textId || sel.audioId || sel.overlayId || sel.kind;
    if (hasSel || st.range) { st.clearSelection(); st.setRange(null); return true; }
    if (st.focus) { st.setFocus(null); return true; }
    return false;
  },
};

export default function useShortcuts(active = true) {
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (isTypingTarget(e.target)) return;
      const st = useStore.getState();
      if (st.mode !== 'refine' || !st.project) return;
      const def = matchShortcut(e, keymapFor('refine'));
      if (!def) return;
      if (anyDialogOpen(st)) return;
      if (e.repeat && !def.repeat) { e.preventDefault(); return; }
      const fn = HANDLERS[def.id];
      if (!fn) return;
      const r = fn(e);
      if (r === false) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);
}
