// 时间线 · 音频轨：波形 + 音量线 + 音量关键帧点 + 淡入淡出拖柄；可拖动改起点、拖边裁剪；可见区虚拟化。
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../store.js';
import api from '../../api.js';
import {
  startDrag, trimAudioClip, slicePeaks, createPromiseCache, round3, spanInView, shortDur,
  volumeLinePoints, volumeToY, yToVolume, fadeFromDrag,
} from './timelineUtils.js';
import { updateAudio } from './timelineActions.js';
import { seek, pause } from './usePlayback.js';
import { useInView, mediaQueue } from './VideoTrack.jsx';

const ROLE_LABELS = { music: '音乐', sfx: '音效', voice: '配音' };
const PEAKS_PER_SECOND = 50;
const MAX_CANVAS_W = 4096;

const waveCache = createPromiseCache();
const waveDone = new Map(); // path -> { peaks, duration } (LRU 上限 200)
const MAX_WAVE_CACHE = 200;

function setWaveDone(path, data) {
  if (waveDone.has(path)) waveDone.delete(path);
  waveDone.set(path, data);
  while (waveDone.size > MAX_WAVE_CACHE) {
    waveDone.delete(waveDone.keys().next().value);
  }
}

function loadWaveform(path) {
  if (waveDone.has(path)) {
    const hit = waveDone.get(path);
    waveDone.delete(path);
    waveDone.set(path, hit);
    return Promise.resolve(hit);
  }
  return waveCache.get(path, () => mediaQueue.push(() => api.call('media:waveform', { path, peaksPerSecond: PEAKS_PER_SECOND })))
    .then((r) => {
      const data = { peaks: Array.isArray(r && r.peaks) ? r.peaks : [], duration: Number(r && r.duration) || 0 };
      if (data.peaks.length > 0 || data.duration > 0) setWaveDone(path, data);
      return data;
    });
}

/** 波形画布：按块宽度绘制 [srcIn, srcOut] 的峰值 */
const Waveform = memo(function Waveform({ path, srcIn, srcOut, width, height, volume }) {
  const [ref, inView] = useInView();
  const canvasRef = useRef(null);
  const [loaded, setLoaded] = useState(() => (path && waveDone.has(path) ? { path, data: waveDone.get(path) } : null));
  const [failedPath, setFailedPath] = useState(null);
  const data = loaded && loaded.path === path ? loaded.data : null;
  const failed = failedPath === path;

  useEffect(() => {
    if (!inView || !path) return undefined;
    if (waveDone.has(path)) {
      const hit = waveDone.get(path);
      waveDone.delete(path);
      waveDone.set(path, hit);
      setLoaded({ path, data: hit });
      setFailedPath(null);
      return undefined;
    }
    if (loaded && loaded.path === path) return undefined;
    let alive = true;
    loadWaveform(path)
      .then((d) => { if (alive) { setLoaded({ path, data: d }); setFailedPath(null); } })
      .catch(() => { if (alive) setFailedPath(path); });
    return () => { alive = false; };
  }, [inView, path, loaded]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const cw = Math.max(1, Math.min(MAX_CANVAS_W, Math.round(width * dpr)));
    const ch = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, cw, ch);
    const pps = data.duration > 0 && data.peaks.length ? data.peaks.length / data.duration : PEAKS_PER_SECOND;
    const barW = Math.max(1, Math.round(dpr));
    const step = barW * 2;
    const bins = Math.max(1, Math.floor(cw / step));
    const peaks = slicePeaks(data.peaks, pps, srcIn, srcOut, bins);
    const gain = Math.max(0.15, Math.min(1.6, Number(volume) || 1));
    ctx.fillStyle = getComputedStyle(canvas).color || '#7fd6b0';
    const mid = ch / 2;
    for (let i = 0; i < bins; i += 1) {
      const v = Math.min(1, peaks[i] * gain);
      const h = Math.max(barW, v * (ch - 2));
      ctx.fillRect(i * step, mid - h / 2, barW, h);
    }
  }, [data, srcIn, srcOut, width, height, volume]);

  return (
    <div ref={ref} className="tl-wave">
      {data ? <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} /> : <div className={'tl-wave-placeholder' + (failed ? ' failed' : '')} />}
    </div>
  );
});

// 音量包络：音量线（0..200%）+ volumeKeys 点 + 淡入淡出拖柄。坐标为块内像素。
function Envelope({ audio, len, pps, width, height, locked, onEdit }) {
  const base = Number(audio.volume) >= 0 ? Number(audio.volume) : 1;
  const keys = Array.isArray(audio.volumeKeys) ? audio.volumeKeys : [];
  const fi = fadeFromDrag(len, audio.fadeIn); const fo = fadeFromDrag(len, audio.fadeOut);
  const points = volumeLinePoints({ base, keys, fadeIn: fi, fadeOut: fo, len, pps, h: height });

  const dragFade = (e, edge) => {
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    if (locked) return;
    const v0 = edge === 'in' ? fi : fo;
    let v = v0;
    startDrag(e, {
      threshold: 1, cursor: 'ew-resize',
      onMove: (dx) => { v = fadeFromDrag(len, v0 + (edge === 'in' ? dx : -dx) / pps); onEdit({ [edge === 'in' ? 'fadeIn' : 'fadeOut']: v }, true); },
      onEnd: (dx, dy, ev, moved, cancelled) => {
        if (cancelled || !moved) { onEdit(null, true); return; }
        onEdit({ [edge === 'in' ? 'fadeIn' : 'fadeOut']: v }, false, edge === 'in' ? '调整淡入' : '调整淡出');
      },
    });
  };

  // 拖动音量线：无关键帧时改整体音量；有关键帧时拖最近的点
  const dragLevel = (e, keyIndex) => {
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    if (locked) return;
    const rect = e.currentTarget.closest('.tl-env').getBoundingClientRect();
    const y0 = e.clientY - rect.top;
    let patch = null;
    startDrag(e, {
      threshold: 1, cursor: 'ns-resize',
      onMove: (dx, dy) => {
        const v = yToVolume(y0 + dy, height);
        if (keyIndex == null) patch = { volume: v };
        else patch = { volumeKeys: keys.map((k, i) => (i === keyIndex ? { ...k, v } : k)) };
        onEdit(patch, true);
      },
      onEnd: (dx, dy, ev, moved, cancelled) => {
        if (cancelled || !moved || !patch) { onEdit(null, true); return; }
        onEdit(patch, false, keyIndex == null ? '调整音量' : '调整音量关键帧');
      },
    });
  };

  const addKey = (e) => {
    e.stopPropagation();
    if (locked) return;
    const rect = e.currentTarget.closest('.tl-env').getBoundingClientRect();
    const t = round3(Math.max(0, Math.min(len, (e.clientX - rect.left) / pps)));
    const v = yToVolume(e.clientY - rect.top, height);
    const next = [...keys.filter((k) => Math.abs(k.t - t) > 0.05), { t, v }].sort((a, b) => a.t - b.t);
    onEdit({ volumeKeys: next }, false, '添加音量关键帧');
  };
  const removeKey = (e, i) => {
    e.preventDefault(); e.stopPropagation();
    if (!locked) onEdit({ volumeKeys: keys.filter((_, k) => k !== i) }, false, '删除音量关键帧');
  };

  return (
    <div className="tl-env">
      <svg width={width} height={height} className="tl-env-svg">
        {fi > 0 && <polygon className="tl-fade-area" points={`0,0 ${fi * pps},0 0,${height}`} />}
        {fo > 0 && <polygon className="tl-fade-area" points={`${width},0 ${width - fo * pps},0 ${width},${height}`} />}
        <polyline className="tl-env-line" points={points} />
        <polyline className="tl-env-hit" points={points} onPointerDown={(e) => dragLevel(e, keys.length ? nearestKey(keys, e, pps) : null)} onDoubleClick={addKey}>
          <title>{`音量 ${Math.round(base * 100)}% · 上下拖动调整 · 双击添加关键帧`}</title>
        </polyline>
      </svg>
      {keys.map((k, i) => (
        <span
          key={i}
          className="tl-vkey"
          style={{ left: k.t * pps, top: volumeToY(k.v, height) }}
          title={`音量关键帧 ${Math.round(k.v * 100)}% @ ${k.t.toFixed(2)}s（右键删除）`}
          onPointerDown={(e) => dragLevel(e, i)}
          onContextMenu={(e) => removeKey(e, i)}
        />
      ))}
      {width > 30 && (
        <>
          <span className="tl-fade-h in" style={{ left: fi * pps }} title={`淡入 ${fi.toFixed(2)}s（拖动调整）`} onPointerDown={(e) => dragFade(e, 'in')} />
          <span className="tl-fade-h out" style={{ left: width - fo * pps }} title={`淡出 ${fo.toFixed(2)}s（拖动调整）`} onPointerDown={(e) => dragFade(e, 'out')} />
        </>
      )}
    </div>
  );
}

function nearestKey(keys, e, pps) {
  const rect = e.currentTarget.closest('.tl-env').getBoundingClientRect();
  const t = (e.clientX - rect.left) / pps;
  let best = 0;
  keys.forEach((k, i) => { if (Math.abs(k.t - t) < Math.abs(keys[best].t - t)) best = i; });
  return best;
}

const AudioBlock = memo(function AudioBlock({ audio, asset, start, srcIn, srcOut, pps, top, height, selected, dragging, locked, onDown, onCtx }) {
  const len = Math.max(0, srcOut - srcIn);
  const left = start * pps;
  const width = Math.max(4, len * pps);
  const name = (asset && asset.name) || '音频';
  const [envDraft, setEnvDraft] = useState(null);
  const shown = envDraft ? { ...audio, ...envDraft } : audio;
  const onEdit = useCallback((patch, preview, label) => {
    if (preview) { setEnvDraft(patch); return; }
    setEnvDraft(null);
    if (patch) updateAudio(audio.id, patch, label);
  }, [audio.id]);
  const cls = ['tl-item', 'tl-audio', 'r-' + (audio.role || 'music'), selected ? 'sel' : '', locked ? 'locked' : '', dragging ? 'dragging' : ''].filter(Boolean).join(' ');
  return (
    <div
      className={cls}
      style={{ left, width, top, height }}
      data-audio-id={audio.id}
      title={`${ROLE_LABELS[audio.role] || '音频'}：${name}\n${start.toFixed(2)}s 起 · ${len.toFixed(2)} 秒 · 音量 ${Math.round((Number(shown.volume) || 0) * 100)}%${locked ? '\n已锁定' : '\n拖动改位置，拖边缘裁剪；音量线上下拖，角上圆点调淡入淡出'}`}
      onPointerDown={(e) => onDown(e, audio.id, 'body')}
      onDoubleClick={() => { pause(); seek(start); }}
      onContextMenu={(e) => onCtx(e, audio.id)}
    >
      {asset && asset.path
        ? <Waveform path={asset.path} srcIn={srcIn} srcOut={srcOut} width={width} height={height - 4} volume={shown.volume} />
        : <div className="tl-wave"><div className="tl-wave-placeholder failed" /></div>}
      <Envelope audio={shown} len={len} pps={pps} width={width} height={height} locked={locked} onEdit={onEdit} />
      {width > 46 && <span className="tl-clip-title">{name}</span>}
      {(dragging || width > 70) && <span className={'tl-clip-dur mono' + (dragging ? ' on' : '')}>{dragging ? `${len.toFixed(2)}s` : shortDur(len)}</span>}
      <div className={'tl-handle l' + (locked ? ' off' : '')} onPointerDown={(e) => onDown(e, audio.id, 'left')} />
      <div className={'tl-handle r' + (locked ? ' off' : '')} onPointerDown={(e) => onDown(e, audio.id, 'right')} />
    </div>
  );
});

function AudioTrack({ project, pps, rows, rowH, height, selectedId, tools, onMenu, flags, viewStart = 0, viewEnd = Infinity }) {
  const audios = project.tracks.audio || [];
  const [draft, setDraft] = useState(null); // { id, start, in, out }
  const trackLocked = !!(flags && flags.locked);
  const live = useRef(null);
  live.current = { audios, assets: project.assets, pps, tools, trackLocked };

  const onDown = useCallback((e, id, part) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const { audios: list, assets, pps: z, tools: tl, trackLocked: tLock } = live.current;
    const audio = list.find((a) => a.id === id);
    if (!audio) return;
    const st = useStore.getState();
    if (st.selection.audioId !== id) st.selectAudio(id);
    const locked = audio.locked || tLock;
    const asset = assets[audio.assetId];
    const assetDur = asset && Number(asset.duration) > 0 ? Number(asset.duration) : 0;
    const s0 = Math.max(0, Number(audio.start) || 0);
    const in0 = Math.max(0, Number(audio.in) || 0);
    const out0 = Number.isFinite(Number(audio.out)) ? Number(audio.out) : (assetDur || in0 + 10);
    const len0 = Math.max(0.2, out0 - in0);
    const exclude = [s0, s0 + len0];
    let res = null;
    startDrag(e, {
      threshold: part === 'body' ? 4 : 2,
      cursor: part === 'body' ? 'grabbing' : 'ew-resize',
      onMove: (dx, dy, ev) => {
        if (locked) return;
        const dt = dx / z;
        if (part === 'body') {
          const ns = tl.snapSpan(Math.max(0, s0 + dt), len0, exclude);
          res = { start: round3(Math.max(0, ns)), in: in0, out: out0 };
        } else if (part === 'left') {
          const target = tl.snap(s0 + dt, exclude);
          res = trimAudioClip({ start: s0, in: in0, out: out0 }, assetDur, 'left', target - s0);
        } else {
          const target = tl.snap(s0 + len0 + dt, exclude);
          res = trimAudioClip({ start: s0, in: in0, out: out0 }, assetDur, 'right', target - (s0 + len0));
        }
        setDraft({ id, ...res });
        tl.edgeScroll(ev.clientX);
      },
      onEnd: (dx, dy, ev, moved, cancelled) => {
        setDraft(null);
        if (!moved || cancelled) return;
        if (locked) { useStore.getState().toast(tLock ? '音频轨已锁定，先在轨道头解锁' : '这段音频已锁定，先右键解锁'); return; }
        if (!res) return;
        const changed = Math.abs(res.start - s0) > 1e-3 || Math.abs(res.in - in0) > 1e-3 || Math.abs(res.out - out0) > 1e-3;
        if (!changed) return;
        const patch = part === 'body' ? { start: res.start } : { start: res.start, in: res.in, out: res.out };
        updateAudio(id, patch, part === 'body' ? '移动音频' : '裁剪音频');
      },
    });
  }, []);

  const onCtx = useCallback((e, id) => {
    e.preventDefault();
    e.stopPropagation();
    useStore.getState().selectAudio(id);
    onMenu(e, 'audio', id);
  }, [onMenu]);

  const cls = 'tl-lane tl-lane-audio' + (flags && flags.muted ? ' is-muted' : '') + (trackLocked ? ' is-locked' : '');
  return (
    <div className={cls} data-lane="audio" style={{ height }}>
      {!audios.length && <div className="tl-lane-ph">拖入音乐或音效</div>}
      {audios.map((a) => {
        const d = draft && draft.id === a.id ? draft : null;
        const asset = project.assets[a.assetId];
        const s = d ? d.start : Math.max(0, Number(a.start) || 0);
        const i = d ? d.in : Math.max(0, Number(a.in) || 0);
        const o = d ? d.out : (Number.isFinite(Number(a.out)) ? Number(a.out) : i + ((asset && asset.duration) || 10));
        if (!d && !spanInView(s, s + (o - i), viewStart, viewEnd, 2)) return null;
        const row = rows[a.id] || 0;
        return (
          <AudioBlock
            key={a.id}
            audio={a}
            asset={asset}
            start={s}
            srcIn={i}
            srcOut={o}
            pps={pps}
            top={3 + row * rowH}
            height={rowH - 4}
            selected={selectedId === a.id}
            dragging={!!d}
            locked={a.locked || trackLocked}
            onDown={onDown}
            onCtx={onCtx}
          />
        );
      })}
    </div>
  );
}

export default memo(AudioTrack);
