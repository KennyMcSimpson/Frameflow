// 时间线 · 画中画轨（project.overlays，track 1..4）：缩略图块，可拖动、拖边裁剪、上下拖动跨轨；关键帧小菱形。
import React, { memo, useCallback, useRef, useState } from 'react';
import { useStore } from '../../store.js';
import api from '../../api.js';
import { startDrag, round3, clampNum, overlayDuration, keyframeTimes, shortDur, visibleItems, MIN_CLIP } from './timelineUtils.js';
import { updateOverlay, selectOverlay } from './timelineActions.js';

function trackUnder(clientX, clientY) {
  if (typeof document === 'undefined') return null;
  const el = document.elementFromPoint(clientX, clientY);
  const lane = el && el.closest ? el.closest('[data-ov-track]') : null;
  return lane ? Number(lane.dataset.ovTrack) : null;
}

export const OverlayBlock = memo(function OverlayBlock({ ov, asset, start, dur, pps, height, selected, locked, moveTo, onDown, onCtx }) {
  const left = start * pps;
  const width = Math.max(4, dur * pps);
  const thumb = asset && (asset.thumb || (asset.kind === 'image' ? asset.path : '')) ? api.mediaUrl(asset.thumb || asset.path) : '';
  const name = (asset && asset.name) || '画中画';
  const kfs = keyframeTimes(ov.keys);
  const cls = ['tl-item', 'tl-ov', selected ? 'sel' : '', locked ? 'locked' : '', moveTo ? 'xtrack' : ''].filter(Boolean).join(' ');
  return (
    <div
      className={cls}
      style={{ left, width, height }}
      data-ov-id={ov.id}
      title={`画中画：${name}\n${start.toFixed(2)}s 起 · ${dur.toFixed(2)} 秒\n${locked ? '已锁定' : '拖动改位置（上下拖可换轨），拖边缘裁剪'}`}
      onPointerDown={(e) => onDown(e, ov.id, 'body')}
      onContextMenu={(e) => onCtx(e, ov.id)}
    >
      <div className="tl-film-strip" style={thumb ? { backgroundImage: `url("${thumb}")`, backgroundSize: `${Math.round(height * 16 / 9)}px ${height}px` } : undefined} />
      {width > 46 && <span className="tl-clip-title">{moveTo ? `移到画中画 ${moveTo}` : name}</span>}
      {width > 70 && <span className="tl-clip-dur mono">{shortDur(dur)}</span>}
      {kfs.map((t) => <span key={t} className="tl-kf" style={{ left: t * pps }} />)}
      <div className={'tl-handle l' + (locked ? ' off' : '')} onPointerDown={(e) => onDown(e, ov.id, 'left')} />
      <div className={'tl-handle r' + (locked ? ' off' : '')} onPointerDown={(e) => onDown(e, ov.id, 'right')} />
    </div>
  );
});

function OverlayTrack({ project, track, pps, height, tools, onMenu, flags, viewStart, viewEnd, selectedId }) {
  const all = project.overlays || [];
  const list = all.filter((o) => (Number(o.track) || 1) === track);
  const [draft, setDraft] = useState(null); // { id, start, in, out }
  const live = useRef(null);
  live.current = { all, assets: project.assets, pps, tools, flags, track };

  const onDown = useCallback((e, id, part) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const { all: ovs, assets, pps: z, tools: tl, flags: fl, track: tr } = live.current;
    const ov = ovs.find((o) => o.id === id);
    if (!ov) return;
    selectOverlay(id);
    if (fl && fl.locked) { useStore.getState().toast('该轨道已锁定，先在轨道头解锁'); return; }
    if (ov.locked) { useStore.getState().toast('该画中画已锁定，先在属性面板或右键解锁'); return; }
    const asset = assets[ov.assetId];
    const still = !asset || asset.kind === 'image' || ov.kind === 'image' || ov.kind === 'sticker';
    const sp = Number(ov.speed) > 0 ? Number(ov.speed) : 1;
    const s0 = Math.max(0, Number(ov.start) || 0);
    const in0 = Math.max(0, Number(ov.in) || 0);
    const out0 = Number(ov.out) || in0 + 3;
    const d0 = overlayDuration(ov);
    const maxOut = still ? Infinity : (Number(asset && asset.duration) || Infinity);
    const exclude = [s0, s0 + d0];
    let res = null;
    startDrag(e, {
      threshold: part === 'body' ? 4 : 2,
      cursor: part === 'body' ? 'grabbing' : 'ew-resize',
      onMove: (dx, dy, ev) => {
        const dt = dx / z;
        if (part === 'body') {
          const ns = Math.max(0, tl.snapSpan(Math.max(0, s0 + dt), d0, exclude));
          const nt = trackUnder(ev.clientX, ev.clientY) || tr;
          res = { start: round3(ns), in: in0, out: out0, track: nt };
        } else if (part === 'left') {
          const target = clampNum(tl.snap(s0 + dt, exclude), Math.max(0, s0 - (still ? s0 : in0 / sp)), s0 + d0 - MIN_CLIP);
          const k = target - s0;
          res = { start: round3(target), in: round3(still ? in0 : in0 + k * sp), out: still ? round3(out0 - k * sp) : out0, track: tr };
        } else {
          const target = tl.snap(s0 + d0 + dt, exclude);
          const nd = Math.max(MIN_CLIP, target - s0);
          res = { start: s0, in: in0, out: round3(Math.min(maxOut, in0 + nd * sp)), track: tr };
        }
        setDraft({ id, ...res });
        tl.edgeScroll(ev.clientX);
      },
      onEnd: (dx, dy, ev, moved, cancelled) => {
        setDraft(null);
        if (!moved || cancelled || !res) return;
        const patch = {};
        if (Math.abs(res.start - s0) > 1e-3) patch.start = res.start;
        if (Math.abs(res.in - in0) > 1e-3) patch.in = res.in;
        if (Math.abs(res.out - out0) > 1e-3) patch.out = res.out;
        if (res.track !== (Number(ov.track) || 1)) patch.track = res.track;
        if (Object.keys(patch).length) updateOverlay(id, patch, part === 'body' ? (patch.track ? '画中画换轨' : '移动画中画') : '裁剪画中画');
      },
    });
  }, []);

  const onCtx = useCallback((e, id) => {
    e.preventDefault();
    e.stopPropagation();
    selectOverlay(id);
    onMenu(e, 'overlay', id);
  }, [onMenu]);

  const shown = visibleItems(list, viewStart, viewEnd, (o) => { const s = Number(o.start) || 0; return [s, s + overlayDuration(o)]; });
  const cls = 'tl-lane tl-lane-overlay' + (flags && flags.hidden ? ' is-hidden' : '') + (flags && flags.locked ? ' is-locked' : '');
  return (
    <div className={cls} data-lane={`overlay:${track}`} data-ov-track={track} style={{ height }}>
      {!list.length && <div className="tl-lane-ph">拖入图片或视频叠加到画面上</div>}
      {shown.map((o) => {
        const d = draft && draft.id === o.id ? draft : null;
        const eff = d ? { ...o, in: d.in, out: d.out } : o;
        return (
          <OverlayBlock
            key={o.id}
            ov={o}
            asset={project.assets[o.assetId]}
            start={d ? d.start : Math.max(0, Number(o.start) || 0)}
            dur={overlayDuration(eff)}
            pps={pps}
            height={height - 8}
            selected={selectedId === o.id}
            locked={!!((flags && flags.locked) || o.locked)}
            moveTo={d && d.track !== track ? d.track : null}
            onDown={onDown}
            onCtx={onCtx}
          />
        );
      })}
    </div>
  );
}

export default memo(OverlayTrack);
