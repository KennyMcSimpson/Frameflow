// 精修模式 · 多轨时间线（DOM 实现）
// 结构：工具条 | 轨道头(120px) + 轨道区：标尺、标记行、画中画轨(上层在上)、主视频轨、文字轨、音频轨；播放头、框选、聚焦。
// 可见区域虚拟化：各轨只渲染与视窗相交的片段。
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store.js';
import api from '../../api.js';
import { Icon, fmtTime } from '../../components/ui.jsx';
import { snapPoints, itemsInRange, trackFlags } from '../../../engine/timeline.js';
import { readDroppedAssets, insertAssets, addAudioTrack, addAssetToOverlay, importPaths, DND_ASSET } from '../../assetActions.js';
import TimelineRuler from './TimelineRuler.jsx';
import TimelineToolbar from './TimelineToolbar.jsx';
import TrackHeader from './TrackHeader.jsx';
import MarkerLane from './MarkerLane.jsx';
import OverlayTrack from './OverlayTrack.jsx';
import VideoTrack from './VideoTrack.jsx';
import TextTrack from './TextTrack.jsx';
import AudioTrack from './AudioTrack.jsx';
import {
  startDrag, snapTime, snapSpan, dropSlot, slotTime, packRows, zoomToFit,
  clampNum, shotRangeLabel, overlayTrackList, overlayDuration, MIN_CLIP, ZOOM_MIN, ZOOM_MAX,
} from './timelineUtils.js';
import { getLayout, getDuration, seek, pause } from './usePlayback.js';
import {
  splitAtPlayhead, deleteClips, duplicateClips, toggleLockClips, clearEffects, focusClip, jumpToClip,
  addTextAtPlayhead, effectiveClipIds, updateText, removeText, updateAudio, removeAudio,
  removeOverlay, updateOverlay, freezeAtPlayhead, openInspectorTab, useTimelineUI,
} from './timelineActions.js';
import { kbdOf } from '../../shortcuts/registry.js';
import { useShortcutsVersion } from '../../shortcuts/customKeys.js';

const HEAD_W = 120;
const RULER_H = 26;
const MARKER_H = 20;
const OVERLAY_H = 44;
const OVERLAY_NEW_H = 12; // 最上面那条「拖到这里新建画中画轨」的细投放区
const VIDEO_H = 66;
const TEXT_ROW_H = 26;
const AUDIO_ROW_H = 46;
const SNAP_PX = 8;
const TAIL_SECONDS = 8;
const EDGE_ZONE = 40; // 拖到视口边缘这么近就自动滚动（像素）
const MAX_OVERLAY_TRACK = 4;

function hasDragAssets(e) {
  try { return Array.from(e.dataTransfer.types || []).includes(DND_ASSET); } catch { return false; }
}
/** 从资源管理器拖进来的文件（不是素材箱里的素材） */
function hasDragFiles(e) {
  try { const types = Array.from(e.dataTransfer.types || []); return types.includes('Files') && !types.includes(DND_ASSET); } catch { return false; }
}
const MEDIA_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|wmv|flv|mts|m2ts|3gp|mpg|mpeg|ts|jpg|jpeg|png|webp|gif|bmp|heic|heif|tif|tiff|mp3|wav|m4a|aac|flac|ogg|opus|wma)$/i;

export default function Timeline() {
  const project = useStore((s) => s.project);
  const pps = useStore((s) => s.timelineZoom);
  const selection = useStore((s) => s.selection);
  const range = useStore((s) => s.range);
  const focus = useStore((s) => s.focus);
  const setTimelineZoom = useStore((s) => s.setTimelineZoom);
  const snapOn = useTimelineUI((s) => s.snap);
  const fitTick = useTimelineUI((s) => s.fitTick);
  const shortcutsVer = useShortcutsVersion();

  const [view, setView] = useState({ left: 0, width: 0 });
  const [menu, setMenu] = useState(null); // { x, y, kind, id }
  const [dropHint, setDropHint] = useState(null); // { lane, slot, t }

  const scrollRef = useRef(null);
  const lanesRef = useRef(null);
  const guideRef = useRef(null);
  const pendingScroll = useRef(null);
  const zoomAnchor = useRef(null);
  const prevPps = useRef(pps);
  const scrubbing = useRef(false);
  const prevTextRows = useRef({});
  const prevAudioRows = useRef({});

  const layout = getLayout(project);
  const duration = getDuration(project);
  const texts = (project && project.tracks.text) || [];
  const audios = (project && project.tracks.audio) || [];
  const overlays = (project && project.overlays) || [];
  const markers = (project && project.markers) || [];
  const laneViewW = Math.max(100, view.width - HEAD_W);
  // 末尾留右侧内边距，保证最右刻度文字完整可见
  const LANE_PAD_R = 48;
  const laneW = Math.ceil(Math.max((duration + TAIL_SECONDS) * pps + LANE_PAD_R, laneViewW));

  // 行号稳定（契约 C18）：优先用工程里保存的 row，其次保持上一次所在的行
  const textPack = useMemo(() => {
    const prev = prevTextRows.current;
    const pack = packRows(texts.map((t) => {
      const start = Number(t.start) || 0;
      const saved = Number.isInteger(t.row) ? t.row : undefined;
      return { id: t.id, start, end: start + (Number(t.duration) || 0), row: saved, prefRow: prev[t.id] };
    }), { maxRows: 8 });
    prevTextRows.current = pack.logical;
    return pack;
  }, [texts]);
  const audioPack = useMemo(() => {
    const prev = prevAudioRows.current;
    const pack = packRows(audios.map((a) => {
      const start = Number(a.start) || 0;
      return { id: a.id, start, end: start + Math.max(0, (Number(a.out) || 0) - (Number(a.in) || 0)), prefRow: prev[a.id] };
    }), { maxRows: 32 });
    prevAudioRows.current = pack.logical;
    return pack;
  }, [audios]);
  const textH = textPack.count * TEXT_ROW_H + 6;
  const audioH = audioPack.count * AUDIO_ROW_H + 6;
  // 只显示用到的画中画轨（至少 1 条）；最上面再留一条细投放区，拖进去就新建一条轨
  const ovTracks = overlayTrackList(overlays, 1, MAX_OVERLAY_TRACK);
  const ovNext = ovTracks.length && ovTracks[0] < MAX_OVERLAY_TRACK ? ovTracks[0] + 1 : null;
  const flags = (kind, n) => (project ? trackFlags(project, kind, n) : {});

  const points = useMemo(() => (project ? snapPoints(layout, project) : []), [layout, project]);

  // ---------- 供子轨道使用的稳定工具（读 ref，避免重渲染） ----------
  const live = useRef(null);
  live.current = { pps, points, snapOn, duration, layout, laneViewW };
  const pointerBusy = useRef(false); // 鼠标正按在时间线上（拖动/刮擦中），此时不自动滚动视口
  const lastPointer = useRef(null);

  const tools = useMemo(() => {
    // 鼠标位置对应的时间（读实时 DOM 位置，滚动后也准确；不截断负值，用于算拖动增量）
    const timeAtRaw = (clientX) => {
      const el = lanesRef.current;
      if (!el) return 0;
      const r = el.getBoundingClientRect();
      return (clientX - r.left) / live.current.pps;
    };
    const timeAt = (clientX) => Math.max(0, timeAtRaw(clientX));
    const snapPts = () => [...live.current.points, useStore.getState().playhead];
    // 吸附导引线：直接改 DOM，不触发重渲染
    const showGuide = (t) => {
      const g = guideRef.current;
      if (!g) return;
      if (t == null || !Number.isFinite(t)) { g.style.display = 'none'; return; }
      g.style.display = 'block';
      g.style.transform = `translateX(${Math.round(t * live.current.pps)}px)`;
    };
    const hideGuide = () => showGuide(null);
    const snap = (t, exclude = []) => {
      if (!live.current.snapOn) { hideGuide(); return t; }
      const r = snapTime(t, snapPts(), SNAP_PX / live.current.pps, exclude);
      showGuide(r.snapped ? r.t : null);
      return r.t;
    };
    const snapSpanFn = (start, dur, exclude = []) => {
      if (!live.current.snapOn) { hideGuide(); return start; }
      const r = snapSpan(start, dur, snapPts(), SNAP_PX / live.current.pps, exclude);
      showGuide(r.point != null && Number.isFinite(Number(r.point)) ? Number(r.point) : null);
      return r.start;
    };

    // 边缘自动滚动：拖到视口左右边缘附近时持续滚动；每滚一帧补发一次 pointermove，让拖动中的元素跟上
    const auto = { raf: 0, vx: 0, vy: 0, at: 0 };
    const stopAuto = () => { if (auto.raf) cancelAnimationFrame(auto.raf); auto.raf = 0; auto.vx = 0; auto.vy = 0; };
    const tick = () => {
      auto.raf = 0;
      const el = scrollRef.current;
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (!el || (!auto.vx && !auto.vy) || now - auto.at > 120) { stopAuto(); return; }
      const l0 = el.scrollLeft; const t0 = el.scrollTop;
      if (auto.vx) el.scrollLeft = Math.max(0, l0 + auto.vx);
      if (auto.vy) el.scrollTop = Math.max(0, t0 + auto.vy);
      const p = lastPointer.current;
      if (p && pointerBusy.current && (el.scrollLeft !== l0 || el.scrollTop !== t0)) {
        try {
          const Ctor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
          window.dispatchEvent(new Ctor('pointermove', {
            bubbles: true, clientX: p.x, clientY: p.y, pointerId: p.id, isPrimary: true,
            altKey: p.alt, shiftKey: p.shift, ctrlKey: p.ctrl, metaKey: p.meta, buttons: 1,
          }));
        } catch { /* 合成事件失败时只滚动，不补发 */ }
      }
      auto.raf = requestAnimationFrame(tick);
    };
    const ramp = (depth) => Math.round(Math.min(28, 3 + (Math.max(0, depth) / EDGE_ZONE) * 22));
    const edgeScroll = (clientX, clientY) => {
      const el = scrollRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const left = r.left + HEAD_W;
      let vx = 0; let vy = 0;
      if (clientX > r.right - EDGE_ZONE) vx = ramp(clientX - (r.right - EDGE_ZONE));
      else if (clientX < left + EDGE_ZONE && el.scrollLeft > 0) vx = -ramp(left + EDGE_ZONE - clientX);
      if (Number.isFinite(clientY) && el.scrollHeight > el.clientHeight + 1) {
        const top = r.top + RULER_H;
        const zone = EDGE_ZONE / 2;
        if (clientY > r.bottom - zone) vy = Math.ceil(ramp((clientY - (r.bottom - zone)) * 2) / 2);
        else if (clientY < top + zone && el.scrollTop > 0) vy = -Math.ceil(ramp((top + zone - clientY) * 2) / 2);
      }
      auto.vx = vx; auto.vy = vy;
      auto.at = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (!vx && !vy) { stopAuto(); return; }
      if (!auto.raf) auto.raf = requestAnimationFrame(tick);
    };
    const endInteraction = () => { stopAuto(); hideGuide(); };
    return { timeAt, timeAtRaw, snap, snapSpan: snapSpanFn, edgeScroll, hideGuide, endInteraction };
  }, []);

  // 松手 / 取消时：收起吸附线、停止边缘滚动；记录真实鼠标位置供自动滚动补发事件
  useEffect(() => {
    const onMove = (e) => {
      if (!e.isTrusted) return;
      lastPointer.current = { x: e.clientX, y: e.clientY, id: e.pointerId, alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey };
    };
    let timer = 0;
    const onUp = () => {
      // 延后一拍：拖动在松手回调里可能还会做最后一次吸附
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = 0; pointerBusy.current = false; tools.endInteraction(); }, 0);
    };
    const onKey = (e) => { if (e.key === 'Escape') onUp(); };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    window.addEventListener('blur', onUp);
    window.addEventListener('keydown', onKey, true);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      window.removeEventListener('blur', onUp);
      window.removeEventListener('keydown', onKey, true);
      tools.endInteraction();
    };
  }, [tools]);

  // ---------- 视口 / 滚动 ----------
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    let raf = 0;
    const update = () => {
      raf = 0;
      setView((v) => (v.left === el.scrollLeft && v.width === el.clientWidth ? v : { left: el.scrollLeft, width: el.clientWidth }));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    el.addEventListener('scroll', onScroll, { passive: true });
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(onScroll); ro.observe(el); }
    return () => { el.removeEventListener('scroll', onScroll); if (ro) ro.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [project ? project.id : null]);

  // 缩放后保持锚点（鼠标位置 / 播放头 / 视口中心）不动
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const old = prevPps.current;
    prevPps.current = pps;
    if (!el) return;
    if (pendingScroll.current != null) {
      el.scrollLeft = Math.max(0, pendingScroll.current);
      pendingScroll.current = null;
      zoomAnchor.current = null;
      return;
    }
    if (old === pps) return;
    const vw = Math.max(100, el.clientWidth - HEAD_W);
    let anchor = zoomAnchor.current;
    zoomAnchor.current = null;
    if (anchor == null) {
      const ph = useStore.getState().playhead;
      const phX = ph * old;
      anchor = phX >= el.scrollLeft && phX <= el.scrollLeft + vw ? ph : (el.scrollLeft + vw / 2) / old;
    }
    const screen = anchor * old - el.scrollLeft;
    el.scrollLeft = Math.max(0, anchor * pps - screen);
  }, [pps]);

  // Ctrl+滚轮缩放；普通滚轮在无竖向滚动时横向滚动
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomAnchor.current = tools.timeAt(e.clientX);
        const f = Math.exp(-e.deltaY * 0.0015);
        useStore.getState().setTimelineZoom(live.current.pps * f);
        return;
      }
      if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX) && el.scrollHeight <= el.clientHeight + 1) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [tools, project ? project.id : null]);

  // 播放头跟随：播放时翻页跟随；暂停时（Home/End、上下一个片段、新增元素等）跑出视口也滚回来。
  // 鼠标正按在时间线上（刮擦、拖动）时不跟随，避免和边缘自动滚动打架。
  useEffect(() => useStore.subscribe((s, prev) => {
    if (s.playhead === prev.playhead || pointerBusy.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const x = s.playhead * live.current.pps;
    const vw = el.clientWidth - HEAD_W;
    if (vw <= 40) return;
    if (s.playing) {
      if (x > el.scrollLeft + vw - 24 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 48);
    } else if (x < el.scrollLeft + 4 || x > el.scrollLeft + vw - 12) {
      el.scrollLeft = Math.max(0, x - vw * 0.3);
    }
  }), []);

  // 选中变化来自别处（检查器、AI 面板、快捷键、新增元素）时，把选中的元素滚进视口
  useEffect(() => useStore.subscribe((s, prev) => {
    if (s.selection === prev.selection || pointerBusy.current || !s.project) return;
    const el = scrollRef.current;
    const sel = s.selection || {};
    if (!el) return;
    let span = null; let query = '';
    const p = s.project;
    if (sel.clipIds && sel.clipIds.length === 1 && sel.clipIds !== (prev.selection || {}).clipIds) {
      const it = (getLayout(p) || []).find((x) => x.clip.id === sel.clipIds[0]);
      if (it) { span = [it.start, it.end]; query = `[data-clip-id="${CSS.escape(String(it.clip.id))}"]`; }
    } else if (sel.textId && sel.textId !== (prev.selection || {}).textId) {
      const t = (p.tracks.text || []).find((x) => x.id === sel.textId);
      if (t) { const a = Number(t.start) || 0; span = [a, a + (Number(t.duration) || 0)]; query = `[data-text-id="${CSS.escape(String(t.id))}"]`; }
    } else if (sel.audioId && sel.audioId !== (prev.selection || {}).audioId) {
      const a = (p.tracks.audio || []).find((x) => x.id === sel.audioId);
      if (a) { const st = Number(a.start) || 0; span = [st, st + Math.max(0, (Number(a.out) || 0) - (Number(a.in) || 0))]; query = `[data-audio-id="${CSS.escape(String(a.id))}"]`; }
    } else if (sel.kind === 'overlay' && sel.id && sel.id !== (prev.selection || {}).id) {
      const o = (p.overlays || []).find((x) => x.id === sel.id);
      if (o) { const st = Number(o.start) || 0; span = [st, st + overlayDuration(o)]; query = `[data-ov-id="${CSS.escape(String(o.id))}"]`; }
    }
    if (!span) return;
    const z = live.current.pps;
    const vw = el.clientWidth - HEAD_W;
    if (span[1] * z < el.scrollLeft || span[0] * z > el.scrollLeft + vw) el.scrollLeft = Math.max(0, span[0] * z - vw * 0.2);
    // 纵向：等虚拟化渲染出该元素后，若在可视区外就滚到它
    requestAnimationFrame(() => {
      const node = query && el.querySelector(query);
      if (!node) return;
      const nr = node.getBoundingClientRect();
      const sr = el.getBoundingClientRect();
      const top = sr.top + RULER_H;
      if (nr.top < top) el.scrollTop -= top - nr.top + 6;
      else if (nr.bottom > sr.bottom) el.scrollTop += nr.bottom - sr.bottom + 6;
    });
  }), []);

  // ---------- 缩放适配 ----------
  const applyZoom = useCallback((z, scrollTo) => {
    const target = clampNum(z, ZOOM_MIN, ZOOM_MAX);
    if (Math.abs(target - live.current.pps) < 1e-6) {
      if (scrollRef.current && scrollTo != null) scrollRef.current.scrollLeft = Math.max(0, scrollTo);
      return;
    }
    pendingScroll.current = scrollTo;
    setTimelineZoom(target);
  }, [setTimelineZoom]);

  const fitAll = useCallback(() => {
    const d = Math.max(1, live.current.duration);
    applyZoom(zoomToFit(0, d, live.current.laneViewW, 0.88), 0);
  }, [applyZoom]);

  useEffect(() => { if (fitTick) fitAll(); }, [fitTick, fitAll]);

  const fitRange = useCallback((r) => {
    if (!r || !(r.end > r.start)) return;
    const vw = live.current.laneViewW;
    const z = zoomToFit(r.start, r.end, vw, 0.9);
    applyZoom(z, r.start * z - vw * 0.05);
  }, [applyZoom]);

  // 聚焦变化（来自时间线或 AI 面板）：进入 → 缩放到该段；退出 → 适配全片
  const prevFocus = useRef(focus);
  useEffect(() => {
    const prev = prevFocus.current;
    prevFocus.current = focus;
    if (focus && (!prev || prev.start !== focus.start || prev.end !== focus.end)) fitRange(focus);
    else if (!focus && prev) fitAll();
  }, [focus, fitRange, fitAll]);

  // 打开项目时，若全片明显放不下或太短，自动适配一次
  const fittedFor = useRef(null);
  useEffect(() => {
    if (!project || fittedFor.current === project.id || view.width < 200) return;
    fittedFor.current = project.id;
    if (duration > 0) {
      const w = duration * pps;
      if (w > laneViewW || w < laneViewW * 0.7) fitAll();
    }
  }, [project, view.width, duration, pps, laneViewW, fitAll]);

  // ---------- 标尺 / 空白处交互 ----------
  const startRangeDrag = useCallback((e, clickClears) => {
    const st = useStore.getState();
    const before = st.range;
    const t0 = tools.snap(tools.timeAt(e.clientX));
    startDrag(e, {
      threshold: 3,
      raf: true,
      onMove: (dx, dy, ev) => {
        const dur = live.current.duration;
        if (!(dur > 0)) return;
        const t1 = tools.snap(tools.timeAt(ev.clientX));
        const a = clampNum(Math.min(t0, t1), 0, dur);
        const b = clampNum(Math.max(t0, t1), 0, dur);
        if (b - a > 0.02) useStore.getState().setRange({ start: a, end: b });
        tools.edgeScroll(ev.clientX);
      },
      onEnd: (dx, dy, ev, moved, cancelled) => {
        const s = useStore.getState();
        if (cancelled) { s.setRange(before); return; }
        if (!moved && clickClears) { s.clearSelection(); s.setRange(null); }
      },
    });
  }, [tools]);

  const startScrub = useCallback((e) => {
    pause();
    const go = (clientX) => {
      const dur = live.current.duration;
      seek(clampNum(tools.snap(tools.timeAt(clientX)), 0, dur));
    };
    go(e.clientX);
    startDrag(e, {
      threshold: 0,
      raf: true,
      cursor: 'col-resize',
      onMove: (dx, dy, ev) => { go(ev.clientX); tools.edgeScroll(ev.clientX); },
    });
  }, [tools]);

  const onRulerDown = useCallback((e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    if (e.shiftKey) startRangeDrag(e, false);
    else startScrub(e);
  }, [startRangeDrag, startScrub]);

  const onGripDown = useCallback((e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    startScrub(e);
  }, [startScrub]);

  const onLanesDown = (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.tl-item, .tl-range-actions, .tl-trans, .tl-cut, .tl-marker, .tl-playhead-grip, .tl-ruler')) return;
    e.preventDefault();
    startRangeDrag(e, true);
  };

  // ---------- 拖放素材（素材箱里的素材，或从资源管理器直接拖进来的文件） ----------
  const laneOf = (e) => {
    const laneEl = e.target.closest ? e.target.closest('[data-lane]') : null;
    return laneEl ? laneEl.dataset.lane : 'video';
  };
  const onDragOver = (e) => {
    if (!project) return;
    const files = hasDragFiles(e);
    if (!files && !hasDragAssets(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const lane = laneOf(e);
    const t = tools.snap(tools.timeAt(e.clientX));
    const slot = dropSlot(layout, t);
    tools.edgeScroll(e.clientX);
    setDropHint((h) => (h && h.lane === lane && h.slot === slot && Math.abs(h.t - t) * pps < 1 ? h : { lane, slot, t }));
  };
  const onDragLeave = (e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setDropHint(null);
    tools.endInteraction();
  };
  // 按松手位置放置素材：画中画轨 → 该轨；音频 → 音频轨；其它画面 → 主轨插入点
  const placeAssets = (assets, lane, t, slot) => {
    const st = useStore.getState();
    const visuals = assets.filter((a) => a.kind !== 'audio');
    const audioAssets = assets.filter((a) => a.kind === 'audio');
    if (lane.startsWith('overlay:') && visuals.length) {
      const track = clampNum(Number(lane.split(':')[1]) || 1, 1, MAX_OVERLAY_TRACK);
      const cur = st.project ? trackFlags(st.project, 'overlay', track) : {};
      if (cur && cur.locked) {
        st.toast(`画中画 ${track} 轨已锁定，先点轨道头的锁解锁，再拖进来`, 'warn');
      } else {
        let at = t;
        visuals.forEach((a) => { addAssetToOverlay(a, { start: at, track }); at += Number(a.duration) > 0 ? Number(a.duration) : 3; });
      }
    } else if (visuals.length) {
      insertAssets(visuals, slot + 1, visuals.length > 1 ? `添加 ${visuals.length} 个片段` : '添加片段');
    }
    audioAssets.forEach((a) => addAudioTrack(a, t, 'music'));
  };
  const onDrop = (e) => {
    setDropHint(null);
    tools.endInteraction();
    if (!project) return;
    const lane = laneOf(e);
    const t = tools.snap(tools.timeAt(e.clientX));
    const slot = dropSlot(layout, t);
    tools.hideGuide();
    if (hasDragFiles(e)) {
      // 资源管理器里的文件（契约 C13）：取到路径就导入并按落点放置；取不到交给全局拖放（会打开导入窗口）
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      const paths = files.map((f) => { try { return api.pathForFile?.(f) || ''; } catch { return ''; } }).filter(Boolean);
      if (!paths.length) return;
      e.preventDefault();
      const media = paths.filter((p) => MEDIA_EXT.test(p));
      if (!media.length) { useStore.getState().toast('这些文件不是视频、图片或音频，没有添加', 'warn'); return; }
      if (media.length < paths.length) useStore.getState().toast(`已跳过 ${paths.length - media.length} 个不支持的文件`, 'info');
      importPaths(media).then((assets) => {
        const cur = useStore.getState().project;
        if (assets && assets.length && cur && cur.id === project.id) placeAssets(assets, lane, t, slot);
      }).catch(() => {});
      return;
    }
    if (!hasDragAssets(e)) return;
    e.preventDefault();
    const assets = readDroppedAssets(e.dataTransfer);
    if (!assets.length) { useStore.getState().toast('没有读到拖入的素材，请重试', 'error'); return; }
    placeAssets(assets, lane, t, slot);
  };

  // ---------- 右键菜单 ----------
  const openMenu = useCallback((e, kind, id) => {
    setMenu({ x: e.clientX, y: e.clientY, kind, id });
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  const menuItems = useMemo(() => {
    if (!menu || !project) return [];
    const st = useStore.getState();
    const delKbd = kbdOf('rippleDelete');
    if (menu.kind === 'clip') {
      const item = layout.find((it) => it.clip.id === menu.id);
      if (!item) return [];
      const ids = effectiveClipIds(menu.id);
      const many = ids.length > 1;
      const ph = st.playhead;
      const canSplit = ph > item.start + MIN_CLIP && ph < item.end - MIN_CLIP && !item.clip.locked;
      const chosen = project.tracks.video.filter((c) => ids.includes(c.id));
      const allLocked = chosen.length > 0 && chosen.every((c) => c.locked);
      const isMirrored = (c) => (c.mirror ? !!c.mirror.h : !!(c.transform && c.transform.flipH));
      const allReversed = chosen.length > 0 && chosen.every((c) => !!c.reverse);
      const allMirrored = chosen.length > 0 && chosen.every(isMirrored);
      const applyReverse = () => {
        if (!chosen.length) return;
        if (chosen.some((c) => c.locked)) { st.toast('所选镜头中有已锁定的，先解锁再操作', 'error'); return; }
        const next = !allReversed;
        const ops = chosen.map((c) => ({ type: 'setClipProps', id: c.id, patch: { reverse: next } }));
        st.commit(ops, next ? (many ? `倒放 ${chosen.length} 个片段` : '倒放') : (many ? `取消倒放 ${chosen.length} 个片段` : '取消倒放'));
      };
      const applyMirror = () => {
        if (!chosen.length) return;
        if (chosen.some((c) => c.locked)) { st.toast('所选镜头中有已锁定的，先解锁再操作', 'error'); return; }
        const next = !allMirrored;
        const ops = chosen.map((c) => {
          const m = { h: false, v: false, ...(c.mirror || {}) };
          return { type: 'setClipProps', id: c.id, patch: { mirror: { ...m, h: next } } };
        });
        st.commit(ops, next ? (many ? `水平镜像 ${chosen.length} 个片段` : '水平镜像') : (many ? `取消水平镜像 ${chosen.length} 个片段` : '取消水平镜像'));
      };
      return [
        { label: '分割于播放头', icon: 'scissors', kbd: kbdOf('split'), disabled: !canSplit, hint: canSplit ? '' : '先把播放头移到这个片段中间', onClick: () => splitAtPlayhead(menu.id) },
        { label: '定格当前帧（2 秒）', icon: 'clock', disabled: !canSplit, onClick: () => freezeAtPlayhead(2) },
        { label: many ? `复制 ${ids.length} 个片段` : '创建副本', icon: 'copy', kbd: kbdOf('duplicate'), onClick: () => duplicateClips(ids) },
        { label: many ? `删除 ${ids.length} 个片段` : '删除片段', icon: 'trash', kbd: delKbd, danger: true, onClick: () => deleteClips(ids) },
        'sep',
        { label: allReversed ? '取消倒放' : '倒放', icon: 'refresh', onClick: applyReverse },
        { label: allMirrored ? '取消水平镜像' : '水平镜像', icon: 'layers', onClick: applyMirror },
        { label: '裁剪画面…', icon: 'grid', onClick: () => openInspectorTab('crop') },
        { label: '变速…', icon: 'bolt', onClick: () => openInspectorTab('speed') },
        'sep',
        { label: allLocked ? '解锁' : '锁定', icon: allLocked ? 'unlock' : 'lock', onClick: () => toggleLockClips(ids) },
        { label: '聚焦精修这一段', icon: 'focus', onClick: () => focusClip(menu.id) },
        { label: '跳到片段开头', icon: 'skipBack', onClick: () => jumpToClip(menu.id) },
        { label: '清除效果（调色/风格/特效/运镜）', icon: 'refresh', onClick: () => clearEffects(ids) },
      ];
    }
    if (menu.kind === 'overlay') {
      const o = overlays.find((x) => x.id === menu.id);
      if (!o) return [];
      return [
        { label: '跳到开头', icon: 'skipBack', onClick: () => { pause(); seek(Number(o.start) || 0); } },
        { label: '裁剪画面…', icon: 'grid', onClick: () => openInspectorTab('crop') },
        { label: o.locked ? '解锁' : '锁定', icon: o.locked ? 'unlock' : 'lock', onClick: () => updateOverlay(o.id, { locked: !o.locked }, o.locked ? '解锁画中画' : '锁定画中画') },
        'sep',
        { label: '删除画中画', icon: 'trash', kbd: delKbd, danger: true, onClick: () => removeOverlay(o.id) },
      ];
    }
    if (menu.kind === 'text') {
      const t = texts.find((x) => x.id === menu.id);
      if (!t) return [];
      return [
        { label: '跳到文字开头', icon: 'skipBack', onClick: () => { pause(); seek(Number(t.start) || 0); } },
        { label: t.locked ? '解锁' : '锁定', icon: t.locked ? 'unlock' : 'lock', onClick: () => updateText(t.id, { locked: !t.locked }, t.locked ? '解锁文字' : '锁定文字') },
        'sep',
        { label: '删除文字', icon: 'trash', kbd: delKbd, danger: true, onClick: () => removeText(t.id) },
      ];
    }
    if (menu.kind === 'audio') {
      const a = audios.find((x) => x.id === menu.id);
      if (!a) return [];
      return [
        { label: '跳到音频开头', icon: 'skipBack', onClick: () => { pause(); seek(Number(a.start) || 0); } },
        { label: a.locked ? '解锁' : '锁定', icon: a.locked ? 'unlock' : 'lock', onClick: () => updateAudio(a.id, { locked: !a.locked }, a.locked ? '解锁音频' : '锁定音频') },
        { label: '清除音量关键帧', icon: 'refresh', disabled: !(a.volumeKeys && a.volumeKeys.length), onClick: () => updateAudio(a.id, { volumeKeys: [] }, '清除音量关键帧') },
        'sep',
        { label: '删除音频', icon: 'trash', kbd: delKbd, danger: true, onClick: () => removeAudio(a.id) },
      ];
    }
    return [];
  }, [menu, project, layout, texts, audios, overlays, shortcutsVer]);

  // ---------- 派生显示 ----------
  const rangeSameAsFocus = range && focus && Math.abs(range.start - focus.start) < 1e-6 && Math.abs(range.end - focus.end) < 1e-6;
  const showRange = range && range.end > range.start && !rangeSameAsFocus;
  const rangeLabel = showRange ? shotRangeLabel(itemsInRange(layout, range.start, range.end).map((it) => it.index)) : '';
  const focusLabel = focus ? shotRangeLabel(itemsInRange(layout, focus.start, focus.end).map((it) => it.index)) : '';
  const aspect = project && project.settings && project.settings.height > 0 ? project.settings.width / project.settings.height : 16 / 9;
  const hasSelection = !!((selection.clipIds && selection.clipIds.length) || selection.textId || selection.audioId || selection.kind);
  const viewStart = Math.max(0, view.left / pps - 1);
  const viewEnd = (view.left + laneViewW) / pps + 1;
  const hasCaptions = texts.some((t) => t.group === 'caption');

  if (!project) return <div className="tl" data-tour="refine-timeline"><div className="tl-lane-ph">没有打开的项目</div></div>;

  // 轨道纵向布局（与轨道头一一对应）
  const rows = [
    { key: 'ruler', h: RULER_H },
    { key: 'marker', h: MARKER_H },
    ...(ovNext ? [{ key: 'ov' + ovNext, n: ovNext, h: OVERLAY_NEW_H }] : []),
    ...ovTracks.map((n) => ({ key: 'ov' + n, n, h: OVERLAY_H })),
    { key: 'video', h: VIDEO_H },
    { key: 'text', h: textH },
    { key: 'audio', h: audioH },
  ];
  const topOf = (key) => { let y = 0; for (const r of rows) { if (r.key === key) return y; y += r.h; } return y; };
  const rowH = (key) => { const r = rows.find((x) => x.key === key); return r ? r.h : OVERLAY_H; };
  const newTrackHot = !!(dropHint && ovNext && dropHint.lane === `overlay:${ovNext}`);

  return (
    <div className="tl" data-tour="refine-timeline">
      <TimelineToolbar layout={layout} duration={duration} pps={pps} hasSelection={hasSelection} onFit={fitAll} />

      {focus && (
        <div className="tl-focusbar">
          <Icon name="focus" size={14} />
          <span>聚焦精修：<b className="mono">{fmtTime(focus.start, false)}–{fmtTime(focus.end, false)}</b>{focusLabel ? `（${focusLabel}）` : ''}</span>
          <span className="muted">· 只改这一段，AI 仍记得全片风格</span>
          <button type="button" className="tl-focus-exit" onClick={() => useStore.getState().setFocus(null)}>退出聚焦</button>
        </div>
      )}

      <div className="tl-scroll" ref={scrollRef} onPointerDownCapture={() => { pointerBusy.current = true; }}>
        <div className="tl-inner" style={{ width: HEAD_W + laneW }}>
          <div className="tl-heads" style={{ width: HEAD_W }}>
            <div className="tl-th tl-th-ruler" style={{ height: RULER_H }}>
              <PlayheadTime />
              <span className="tl-th-total mono" title="全片时长">{fmtTime(duration)}</span>
            </div>
            <TrackHeader kind="marker" track="marker" name="标记" meta={markers.length ? String(markers.length) : ''} height={MARKER_H} />
            {ovNext && (
              <div className={'tl-th tl-th-newtrack' + (newTrackHot ? ' is-hot' : '')} style={{ height: OVERLAY_NEW_H }} title={`把素材拖到右侧这条细线上，新建画中画 ${ovNext} 轨`} aria-hidden="true" />
            )}
            {ovTracks.map((n) => (
              <TrackHeader key={n} kind="overlay" track={`overlay:${n}`} name={`画中画 ${n}`} height={OVERLAY_H} state={flags('overlay', n)} canMute />
            ))}
            <TrackHeader kind="video" track="video" name="主视频" meta={layout.length ? `${layout.length} 个片段` : ''} height={VIDEO_H} state={flags('video')} canMute />
            <TrackHeader kind={hasCaptions ? 'caption' : 'text'} track="text" name={hasCaptions ? '文字 / 字幕' : '文字'} height={textH} state={flags('text')} onAdd={() => addTextAtPlayhead()} addLabel="在播放头添加文字" />
            <TrackHeader kind="audio" track="audio" name="音频" meta={audios.length ? String(audios.length) : ''} height={audioH} state={flags('audio')} canHide={false} canMute />
          </div>

          <div
            className="tl-lanes"
            ref={lanesRef}
            style={{ width: laneW }}
            onPointerDown={onLanesDown}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            <TimelineRuler pps={pps} viewStart={viewStart} viewEnd={viewEnd} width={laneW} visibleRight={view.left + laneViewW} height={RULER_H} duration={duration} onPointerDown={onRulerDown} />
            <MarkerLane markers={markers} pps={pps} height={MARKER_H} tools={tools} selectedId={selection.kind === 'marker' ? selection.id : null} />
            {ovNext && (
              <div
                className={'tl-lane tl-lane-newtrack' + (newTrackHot ? ' is-hot' : '')}
                data-lane={`overlay:${ovNext}`}
                data-ov-track={ovNext}
                style={{ height: OVERLAY_NEW_H }}
                title={`拖到这里新建画中画 ${ovNext} 轨`}
              >
                {newTrackHot && <span className="tl-newtrack-tip">松手新建画中画 {ovNext} 轨</span>}
              </div>
            )}
            {ovTracks.map((n) => (
              <OverlayTrack
                key={n}
                project={project}
                track={n}
                pps={pps}
                height={OVERLAY_H}
                tools={tools}
                onMenu={openMenu}
                flags={flags('overlay', n)}
                viewStart={viewStart}
                viewEnd={viewEnd}
                selectedId={selection.kind === 'overlay' ? selection.id : null}
              />
            ))}
            <VideoTrack
              project={project}
              layout={layout}
              pps={pps}
              selectedIds={selection.clipIds}
              height={VIDEO_H}
              tools={tools}
              onMenu={openMenu}
              aspect={aspect}
              flags={flags('video')}
              viewStart={viewStart}
              viewEnd={viewEnd}
            />
            <TextTrack
              project={project}
              pps={pps}
              rows={textPack.rows}
              rowH={TEXT_ROW_H}
              height={textH}
              selectedId={selection.textId}
              tools={tools}
              onMenu={openMenu}
              flags={flags('text')}
              viewStart={viewStart}
              viewEnd={viewEnd}
            />
            <AudioTrack
              project={project}
              pps={pps}
              rows={audioPack.rows}
              rowH={AUDIO_ROW_H}
              height={audioH}
              selectedId={selection.audioId}
              tools={tools}
              onMenu={openMenu}
              flags={flags('audio')}
              viewStart={viewStart}
              viewEnd={viewEnd}
            />

            {focus && (
              <>
                <div className="tl-dim" style={{ left: 0, width: Math.max(0, focus.start * pps) }} />
                <div className="tl-dim" style={{ left: focus.end * pps, width: Math.max(0, laneW - focus.end * pps) }} />
                <div className="tl-focus-frame" style={{ left: focus.start * pps, width: Math.max(2, (focus.end - focus.start) * pps) }} />
              </>
            )}

            {showRange && (
              <div className="tl-range" style={{ left: range.start * pps, width: Math.max(2, (range.end - range.start) * pps) }}>
                <div className="tl-range-actions" style={{ top: RULER_H + 4 }} onPointerDown={(e) => e.stopPropagation()}>
                  <span className="tl-range-info mono">
                    {fmtTime(range.start)}–{fmtTime(range.end)} · {(range.end - range.start).toFixed(1)} 秒{rangeLabel ? ` · ${rangeLabel}` : ''}
                  </span>
                  <button type="button" className="btn sm primary" onClick={() => useStore.getState().setFocus({ start: range.start, end: range.end })}>
                    <Icon name="focus" size={13} />聚焦此段
                  </button>
                  <button type="button" className="btn sm" onClick={() => useStore.getState().setRange(null)}>清除</button>
                </div>
              </div>
            )}

            {dropHint && (
              dropHint.lane === 'audio'
                ? <div className="tl-insert audio" style={{ left: dropHint.t * pps, top: topOf('audio'), height: audioH }} />
                : dropHint.lane.startsWith('overlay:')
                  ? <div className="tl-insert ov" style={{ left: dropHint.t * pps, top: topOf('ov' + dropHint.lane.split(':')[1]), height: rowH('ov' + dropHint.lane.split(':')[1]) }} />
                  : <div className="tl-insert drop" style={{ left: slotTime(layout, dropHint.slot) * pps, top: topOf('video'), height: VIDEO_H }} />
            )}

            <div className="tl-snap-guide" ref={guideRef} aria-hidden="true" />
            <Playhead pps={pps} onGripDown={onGripDown} />
          </div>
        </div>
      </div>

      {menu && menuItems.length > 0 && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />}
    </div>
  );
}

// ---------------- 播放头 ----------------
// 播放头位置每帧都在变：直接订阅 store 改 transform / 文字，不走 React 重渲染
const Playhead = memo(function Playhead({ pps, onGripDown }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const put = (t) => { el.style.transform = `translateX(${(Number(t) || 0) * pps}px)`; };
    put(useStore.getState().playhead);
    return useStore.subscribe((s, prev) => { if (s.playhead !== prev.playhead) put(s.playhead); });
  }, [pps]);
  return (
    <div className="tl-playhead" ref={ref}>
      <div className="tl-playhead-grip" onPointerDown={onGripDown} title="拖动播放头" />
    </div>
  );
});

function PlayheadTime() {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    let last = '';
    const put = (t) => { const s = fmtTime(t); if (s !== last) { last = s; el.textContent = s; } };
    put(useStore.getState().playhead);
    return useStore.subscribe((s, prev) => { if (s.playhead !== prev.playhead) put(s.playhead); });
  }, []);
  return <span className="tl-head-time mono" title="播放头位置" ref={ref} />;
}

// ---------------- 右键菜单 ----------------
function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, window.innerWidth - r.width - 6));
    const top = Math.max(4, Math.min(y, window.innerHeight - r.height - 6));
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const onBlur = () => onClose();
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    };
  }, [onClose]);

  return (
    <div className="tl-menu" ref={ref} style={pos} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) => (it === 'sep'
        ? <div key={'s' + i} className="tl-menu-sep" />
        : (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            className={'tl-menu-item' + (it.danger ? ' danger' : '')}
            disabled={it.disabled}
            title={it.hint || undefined}
            onClick={() => { onClose(); it.onClick(); }}
          >
            <Icon name={it.icon} size={14} />
            <span className="grow">{it.label}</span>
            {it.kbd && <kbd>{it.kbd}</kbd>}
          </button>
        )))}
    </div>
  );
}
