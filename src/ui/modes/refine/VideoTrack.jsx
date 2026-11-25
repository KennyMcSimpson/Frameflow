// 时间线 · 视频主轨：镜头块（胶片条 + 标题 + 时长 + 关键帧）、转场方块（拖改时长）、剪辑点 roll、Alt 拖 slip、拖动重排、拖边裁剪、可见区虚拟化。
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store.js';
import api from '../../api.js';
import { Icon } from '../../components/ui.jsx';
import { PrevizCanvas } from '../../components/media.jsx';
import { layoutVideo } from '../../../engine/timeline.js';
import { TRANSITION_LABELS } from '../../../engine/model.js';
import {
  startDrag, trimVideoClip, dropSlot, slotTime, moveTargetIndex, clampNum,
  filmstripRequestCount, pickFilmFrames, createQueue, createPromiseCache,
  keyframeTimes, shortDur, visibleItems, spanInView, slipLimits, rollLimits, transitionDurationFromDrag, round3,
} from './timelineUtils.js';
import { trimClip, moveClip, jumpToClip, slipClip, rollEditAt, setTransitionDuration } from './timelineActions.js';

// ---------------- 可见性（共享 IntersectionObserver） ----------------
let sharedIO = null;
const ioCallbacks = new Map();
function getIO() {
  if (sharedIO || typeof IntersectionObserver === 'undefined') return sharedIO;
  sharedIO = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const cb = ioCallbacks.get(en.target);
      if (cb) { ioCallbacks.delete(en.target); sharedIO.unobserve(en.target); cb(); }
    }
  }, { rootMargin: '200px 800px' });
  return sharedIO;
}

/** 元素进入（或接近）视口后返回 true，之后保持 true —— 用于懒加载胶片条/波形 */
export function useInView() {
  const ref = useRef(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return undefined;
    const io = getIO();
    if (!io) { setInView(true); return undefined; }
    ioCallbacks.set(el, () => setInView(true));
    io.observe(el);
    return () => { ioCallbacks.delete(el); try { io.unobserve(el); } catch { /* 已解除 */ } };
  }, [inView]);
  return [ref, inView];
}

// ---------------- 媒体请求（模块级缓存 + 并发限制） ----------------
export const mediaQueue = createQueue(2);
const filmCache = createPromiseCache();
const filmDone = new Map(); // key -> string[] (LRU 上限 200)
const MAX_FILM_CACHE = 200;

function setFilmDone(key, list) {
  if (filmDone.has(key)) filmDone.delete(key);
  filmDone.set(key, list);
  while (filmDone.size > MAX_FILM_CACHE) {
    filmDone.delete(filmDone.keys().next().value);
  }
}

function loadFilmstrip(path, duration, count, height) {
  const key = `${path}|${count}|${height}`;
  if (filmDone.has(key)) {
    const hit = filmDone.get(key);
    filmDone.delete(key);
    filmDone.set(key, hit);
    return Promise.resolve(hit);
  }
  return filmCache.get(key, () => mediaQueue.push(async () => {
    const r = await api.call('media:filmstrip', { path, duration, count, height });
    const list = Array.isArray(r) ? r.filter(Boolean) : [];
    if (!list.length) throw new Error('empty filmstrip');
    return list;
  }))
    .then((list) => {
      setFilmDone(key, list);
      return list;
    })
    .catch(() => []);
}


const STRIP_H = 90; // 请求的胶片条高度（像素）

// ---------------- 胶片条 ----------------
const Filmstrip = memo(function Filmstrip({ asset, srcIn, srcOut, width, height, thumbW }) {
  const [ref, inView] = useInView();
  const slots = clampNum(Math.ceil(width / Math.max(16, thumbW)), 1, 48);
  const assetDur = Number(asset.duration) > 0 ? Number(asset.duration) : Math.max(srcOut, 1);
  const count = filmstripRequestCount(slots, assetDur, srcOut - srcIn);
  const key = `${asset.path}|${count}|${STRIP_H}`;
  const [loaded, setLoaded] = useState(() => (filmDone.has(key) ? { key, frames: filmDone.get(key) } : null));
  const frames = loaded && loaded.key === key ? loaded.frames : null;

  useEffect(() => {
    if (!inView || !asset.path) return undefined;
    if (filmDone.has(key)) {
      const hit = filmDone.get(key);
      filmDone.delete(key);
      filmDone.set(key, hit);
      setLoaded({ key, frames: hit });
      return undefined;
    }
    let alive = true;
    loadFilmstrip(asset.path, assetDur, count, STRIP_H)
      .then((list) => { if (alive && list.length) setLoaded({ key, frames: list }); })
      .catch(() => { /* 失败时保留封面缩略图 */ });
    return () => { alive = false; };
  }, [inView, key, asset.path, assetDur, count]);

  const thumbUrl = asset.thumb ? api.mediaUrl(asset.thumb) : '';
  if (!frames || !frames.length) {
    return (
      <div
        ref={ref}
        className="tl-film fallback"
        style={thumbUrl ? { backgroundImage: `url("${thumbUrl}")`, backgroundSize: `${Math.round(thumbW)}px ${height}px` } : undefined}
      />
    );
  }
  const idx = pickFilmFrames(frames.length, assetDur, srcIn, srcOut, slots);
  const cellW = width / slots;
  return (
    <div ref={ref} className="tl-film">
      {idx.map((k, j) => (
        <img key={j} src={api.mediaUrl(frames[k])} alt="" draggable={false} style={{ width: cellW, height }} />
      ))}
    </div>
  );
});

/** 块内画面：视频胶片条 / 图片平铺 / 预演静帧 / 缺失占位 */
function ClipMedia({ asset, clip, width, height, thumbW }) {
  if (!asset) return <div className="tl-film missing"><span>素材丢失</span></div>;
  if (asset.kind === 'previz') {
    return (
      <div className="tl-film previz">
        {asset.previz && width >= 28 && (
          <PrevizCanvas spec={asset.previz} width={Math.round(Math.min(thumbW, width))} height={Math.round(height)} progress={0.35} watermark={false} />
        )}
        {width >= 70 && <span className="tl-previz-tag">AI 预演</span>}
      </div>
    );
  }
  if (asset.kind === 'image' || asset.kind === 'generated-image') {
    const src = asset.path ? api.mediaUrl(asset.path) : (asset.thumb ? api.mediaUrl(asset.thumb) : '');
    return (
      <div className={'tl-film still' + (asset.kind === 'generated-image' ? ' ai' : '')} style={src ? { backgroundImage: `url("${src}")`, backgroundSize: `${Math.round(thumbW)}px ${height}px` } : undefined}>
        {asset.kind === 'generated-image' && width >= 70 && <span className="tl-previz-tag">AI 画面</span>}
      </div>
    );
  }
  if (!asset.path) return <div className="tl-film missing"><span>素材未就绪</span></div>;
  return <Filmstrip asset={asset} srcIn={Number(clip.in) || 0} srcOut={Number(clip.out) || 0} width={width} height={height} thumbW={thumbW} />;
}

// ---------------- 镜头块 ----------------
// 只显示：缩略图条 + 左上标题 + 右下时长 + 关键帧小菱形（细节信息放在悬停提示与属性区）
const ClipBlock = memo(function ClipBlock({
  clip, asset, index, start, duration, pps, height, thumbW, selected, ghostLeft, trimming, locked, onDown, onDbl, onCtx,
}) {
  const left = ghostLeft != null ? ghostLeft : start * pps;
  const width = Math.max(3, duration * pps);
  const name = clip.label || (asset && asset.name) || `第 ${index + 1} 镜`;
  const kfs = keyframeTimes(clip.keys);
  const speed = Number(clip.speed) || 1;
  const kindCls = !asset ? 'missing' : asset.kind;
  const cls = ['tl-item', 'tl-clip', 'k-' + kindCls, selected ? 'sel' : '', locked ? 'locked' : '', ghostLeft != null ? 'ghost' : '', trimming ? 'trimming' : ''].filter(Boolean).join(' ');
  const flags = [clip.reverse ? '倒放' : '', clip.mirror && (clip.mirror.h || clip.mirror.v) ? '镜像' : '', clip.still ? '定格' : '', speed !== 1 || clip.speedCurve ? `变速 ${clip.speedCurve ? '曲线' : speed + '×'}` : ''].filter(Boolean);
  const tip = [
    `第 ${index + 1} 镜 · ${name}`,
    `时长 ${duration.toFixed(2)} 秒${flags.length ? ' · ' + flags.join(' / ') : ''}`,
    asset && asset.source === 'previz' ? '示意画面（占位），建议替换为实拍或 AI 视频' : '',
    locked ? '已锁定' : '拖动重排 · 拖边缘裁剪 · Alt+拖动滑动内容 · 双击跳到开头',
  ].filter(Boolean).join('\n');

  return (
    <div
      className={cls}
      style={{ left, width, height }}
      data-clip-id={clip.id}
      title={tip}
      onPointerDown={(e) => onDown(e, clip.id, 'body')}
      onDoubleClick={() => onDbl(clip.id)}
      onContextMenu={(e) => onCtx(e, clip.id)}
    >
      <ClipMedia asset={asset} clip={clip} width={width} height={height} thumbW={thumbW} />
      {width > 40 && <span className="tl-clip-title">{name}</span>}
      {(trimming || width > 64) && <span className={'tl-clip-dur mono' + (trimming ? ' on' : '')}>{trimming ? `${duration.toFixed(2)}s` : shortDur(duration)}</span>}
      {flags.length > 0 && width > 30 && <span className="tl-clip-flag" />}
      {kfs.map((t) => <span key={t} className="tl-kf" style={{ left: t * pps }} />)}
      <div className={'tl-handle l' + (locked ? ' off' : '')} onPointerDown={(e) => onDown(e, clip.id, 'left')} />
      <div className={'tl-handle r' + (locked ? ' off' : '')} onPointerDown={(e) => onDown(e, clip.id, 'right')} />
    </div>
  );
});

// ---------------- 视频轨 ----------------
function VideoTrack({ project, layout, pps, selectedIds, height, tools, onMenu, aspect, flags, viewStart = 0, viewEnd = Infinity }) {
  const [draft, setDraft] = useState(null);
  const selSet = useMemo(() => new Set(selectedIds || []), [selectedIds]);
  const innerH = height - 8;
  const thumbW = innerH * clampNum(aspect || 16 / 9, 0.5, 2.4);
  const trackLocked = !!(flags && flags.locked);

  // 草稿：重新布局一次以实时显示新时长与后续镜头位移
  const view = useMemo(() => {
    if (!draft || (draft.type !== 'trim' && draft.type !== 'roll' && draft.type !== 'slip')) return layout;
    const patch = draft.patch || {};
    const video = project.tracks.video.map((c) => (patch[c.id] ? { ...c, ...patch[c.id] } : c));
    return layoutVideo({ ...project, tracks: { ...project.tracks, video } });
  }, [draft, layout, project]);

  const live = useRef(null);
  live.current = { project, layout, pps, tools, selSet, trackLocked };

  const onDown = useCallback((e, clipId, part) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const { project: proj, layout: lay, pps: z, tools: tl, selSet: sel, trackLocked: tLock } = live.current;
    const item = lay.find((it) => it.clip.id === clipId);
    if (!item) return;
    const st = useStore.getState();
    const asset = proj.assets[item.clip.assetId];
    const locked = item.clip.locked || tLock;

    if (part === 'left' || part === 'right') {
      e.preventDefault();
      if (locked) { st.toast(tLock ? '视频轨已锁定，先在轨道头解锁' : `第 ${item.index + 1} 镜已锁定，先右键解锁再裁剪`); return; }
      if (!sel.has(clipId)) st.select([clipId]);
      let res = null;
      startDrag(e, {
        threshold: 2,
        cursor: 'ew-resize',
        onMove: (dx, dy, ev) => {
          let dt = dx / z;
          if (part === 'right') dt = tl.snap(item.end + dt, [item.start, item.end]) - item.end;
          else dt = tl.snap(item.start + dt, [item.start, item.end]) - item.start;
          res = trimVideoClip(item.clip, asset, part, dt);
          const clipPatch = item.clip.still ? { duration: res.duration } : { in: res.in, out: res.out };
          setDraft({ type: 'trim', clipId, patch: { [clipId]: clipPatch } });
          tl.edgeScroll(ev.clientX);
        },
        onEnd: (dx, dy, ev, moved, cancelled) => {
          setDraft(null);
          if (!moved || cancelled || !res) return;
          if (Math.abs(res.duration - item.duration) < 1e-3 && Math.abs(res.in - (Number(item.clip.in) || 0)) < 1e-3) return;
          trimClip(clipId, res);
        },
      });
      return;
    }

    // Alt+拖动：slip（内容滑动，位置与时长不变）
    if (e.altKey && !locked) {
      e.preventDefault();
      if (!sel.has(clipId)) st.select([clipId]);
      const lim = slipLimits(item.clip, asset);
      if (!(lim.max > lim.min)) { st.toast('图片或素材没有余量，无法滑动内容'); return; }
      const sp = Number(item.clip.speed) > 0 ? Number(item.clip.speed) : 1;
      let delta = 0;
      startDrag(e, {
        threshold: 2,
        cursor: 'grab',
        onMove: (dx) => {
          delta = round3(clampNum(-(dx / z) * sp, lim.min, lim.max)); // 向右拖 = 看更早的内容
          setDraft({ type: 'slip', clipId, delta, patch: { [clipId]: { in: (Number(item.clip.in) || 0) + delta, out: (Number(item.clip.out) || 0) + delta } } });
        },
        onEnd: (dx, dy, ev, moved, cancelled) => {
          setDraft(null);
          if (moved && !cancelled && Math.abs(delta) > 1e-3) slipClip(clipId, delta);
        },
      });
      return;
    }

    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    const wasSelected = sel.has(clipId);
    if (!additive && !wasSelected) st.select([clipId]);
    const grab = tl.timeAt(e.clientX) - item.start;
    let slot = null;
    startDrag(e, {
      threshold: 4,
      onMove: (dx, dy, ev) => {
        if (additive || locked) return;
        const t = tl.timeAt(ev.clientX);
        slot = dropSlot(lay, t);
        setDraft({ type: 'move', clipId, slot, ghostLeft: Math.max(0, (t - grab) * z) });
        tl.edgeScroll(ev.clientX);
      },
      onEnd: (dx, dy, ev, moved, cancelled) => {
        setDraft(null);
        const s2 = useStore.getState();
        if (!moved) {
          if (additive) {
            if (wasSelected) s2.select(s2.selection.clipIds.filter((id) => id !== clipId));
            else s2.select([clipId], { additive: true });
          } else s2.select([clipId]);
          return;
        }
        if (cancelled || additive) return;
        if (locked) { s2.toast(`第 ${item.index + 1} 镜已锁定，不能移动`); return; }
        if (slot == null) return;
        const to = moveTargetIndex(item.index, slot);
        if (to !== item.index) moveClip(clipId, to + 1);
      },
    });
  }, []);

  // 剪辑点拖拽：roll（左镜出点与右镜入点一起移动，总长不变）
  const onCutDown = useCallback((e, idx) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const { project: proj, layout: lay, pps: z, tools: tl, trackLocked: tLock } = live.current;
    const a = lay[idx - 1]; const b = lay[idx];
    if (!a || !b) return;
    if (tLock || a.clip.locked || b.clip.locked) { useStore.getState().toast('相邻镜头已锁定，无法移动剪辑点'); return; }
    const lim = rollLimits(a.clip, proj.assets[a.clip.assetId], b.clip, proj.assets[b.clip.assetId]);
    const cut = b.start;
    const ls = Number(a.clip.speed) > 0 ? Number(a.clip.speed) : 1;
    const rs = Number(b.clip.speed) > 0 ? Number(b.clip.speed) : 1;
    let delta = 0;
    startDrag(e, {
      threshold: 2,
      cursor: 'col-resize',
      onMove: (dx, dy, ev) => {
        const target = tl.snap(cut + dx / z, [cut, a.start, b.end]);
        delta = round3(clampNum(target - cut, lim.min, lim.max));
        setDraft({
          type: 'roll', cut: idx, delta,
          patch: {
            [a.clip.id]: a.clip.still ? { duration: Math.max(0.2, a.duration + delta) } : { out: (Number(a.clip.out) || 0) + delta * ls },
            [b.clip.id]: b.clip.still ? { duration: Math.max(0.2, b.duration - delta) } : { in: (Number(b.clip.in) || 0) + delta * rs },
          },
        });
        tl.edgeScroll(ev.clientX);
      },
      onEnd: (dx, dy, ev, moved, cancelled) => {
        setDraft(null);
        if (moved && !cancelled && Math.abs(delta) > 1e-3) rollEditAt(cut, delta);
      },
    });
  }, []);

  // 转场方块：左右拖改时长，单击选中后一镜
  const onTransDown = useCallback((e, it) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const { pps: z, trackLocked: tLock } = live.current;
    const locked = !!(tLock || it.clip.locked);
    const tr = it.clip.transitionIn || {};
    const d0 = Number(tr.duration) || 0.5;
    const isCut = !tr.type || tr.type === 'cut';
    let nd = d0;
    startDrag(e, {
      threshold: 3,
      cursor: locked || isCut ? 'pointer' : 'ew-resize',
      onMove: (dx) => {
        if (isCut || locked) return;
        nd = transitionDurationFromDrag(d0, dx, z, Math.min(3, it.duration / 2));
        setDraft({ type: 'trans', clipId: it.clip.id, duration: nd });
      },
      onEnd: (dx, dy, ev, moved, cancelled) => {
        setDraft(null);
        if (!moved) { useStore.getState().select([it.clip.id]); return; }
        if (locked && !isCut) {
          useStore.getState().toast(tLock ? '视频轨已锁定，先在轨道头解锁' : `第 ${it.index + 1} 镜已锁定，先右键解锁再调整转场`);
          return;
        }
        if (!cancelled && !isCut && Math.abs(nd - d0) > 1e-3) setTransitionDuration(it.clip.id, nd);
      },
    });
  }, []);

  const onDbl = useCallback((clipId) => jumpToClip(clipId), []);
  const onCtx = useCallback((e, clipId) => {
    e.preventDefault();
    e.stopPropagation();
    const st = useStore.getState();
    if (!st.selection.clipIds.includes(clipId)) st.select([clipId]);
    onMenu(e, 'clip', clipId);
  }, [onMenu]);

  const moveDraft = draft && draft.type === 'move' ? draft : null;
  const trimId = draft && (draft.type === 'trim' || draft.type === 'slip') ? draft.clipId : null;
  // 可见区域虚拟化（拖动中的镜头始终渲染）
  const clips = visibleItems(view, viewStart, viewEnd, (it) => [it.start, it.end]).concat(
    moveDraft ? view.filter((it) => it.clip.id === moveDraft.clipId && !spanInView(it.start, it.end, viewStart, viewEnd, 2)) : [],
  );
  const cls = 'tl-lane tl-lane-video' + (flags && flags.hidden ? ' is-hidden' : '') + (trackLocked ? ' is-locked' : '');

  return (
    <div className={cls} data-lane="video" style={{ height }}>
      {!view.length && <div className="tl-lane-ph">主视频轨：把左侧素材拖到这里开始剪辑，或在「创作」模式一键成片</div>}

      {clips.map((it) => (
        it.index > 0 && it.overlap > 0
          ? <div key={'ov' + it.clip.id} className="tl-overlap" style={{ left: it.start * pps, width: it.overlap * pps, height: innerH }} />
          : null
      ))}

      {clips.map((it) => (
        <ClipBlock
          key={it.clip.id}
          clip={it.clip}
          asset={project.assets[it.clip.assetId]}
          index={it.index}
          start={it.start}
          duration={it.duration}
          pps={pps}
          height={innerH}
          thumbW={thumbW}
          selected={selSet.has(it.clip.id)}
          ghostLeft={moveDraft && moveDraft.clipId === it.clip.id ? moveDraft.ghostLeft : null}
          trimming={trimId === it.clip.id}
          locked={it.clip.locked || trackLocked}
          onDown={onDown}
          onDbl={onDbl}
          onCtx={onCtx}
        />
      ))}

      {/* 剪辑点（roll）与转场方块 */}
      {clips.map((it) => {
        if (it.index === 0) return null;
        const tr = it.clip.transitionIn || {};
        const isCut = !tr.type || tr.type === 'cut';
        const dur = draft && draft.type === 'trans' && draft.clipId === it.clip.id ? draft.duration : Number(tr.duration) || 0;
        const x = (it.start + (it.overlap || 0) / 2) * pps;
        const label = TRANSITION_LABELS[tr.type] || tr.type || '硬切';
        const tip = isCut
          ? `第 ${it.index} → ${it.index + 1} 镜：硬切。单击选中后一镜，在属性区添加转场`
          : `第 ${it.index} → ${it.index + 1} 镜：${label} ${dur.toFixed(1)} 秒。左右拖动改时长`;
        return (
          <React.Fragment key={'cut' + it.clip.id}>
            <div
              className={'tl-cut' + (draft && draft.type === 'roll' && draft.cut === it.index ? ' on' : '')}
              style={{ left: x }}
              title="拖动剪辑点：前后两镜一起改（总长不变）"
              onPointerDown={(e) => onCutDown(e, it.index)}
            />
            <button
              type="button"
              className={'tl-trans' + (isCut ? ' cut' : '') + (selSet.has(it.clip.id) ? ' sel' : '')}
              style={{ left: x }}
              title={tip}
              aria-label={tip}
              onPointerDown={(e) => onTransDown(e, it)}
            >
              {!isCut && pps * dur > 30 && <span className="tl-trans-dur mono">{dur.toFixed(1)}</span>}
            </button>
          </React.Fragment>
        );
      })}

      {moveDraft && moveDraft.slot != null && (
        <div className="tl-insert" style={{ left: slotTime(layout, moveDraft.slot) * pps }} />
      )}
      {draft && draft.type === 'slip' && (
        <div className="tl-slip-tip mono">内容 {draft.delta > 0 ? '+' : ''}{draft.delta.toFixed(2)}s</div>
      )}
    </div>
  );
}

export default memo(VideoTrack);
