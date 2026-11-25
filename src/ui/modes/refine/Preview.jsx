// 精修模式 · 预览：画布按画幅等比适配容器，单一 rAF 循环推进播放头并合成画面。
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../../store.js';
import api from '../../api.js';
import { Button, Empty, Icon, fmtTime } from '../../components/ui.jsx';
import { ASPECTS } from '../../../engine/model.js';
import { renderFrame, isPrevizSource } from '../../../render/compositor.js';
import { createMediaPool, slewToClock } from '../../../render/mediaPool.js';
import { readDroppedAssets, insertAssets, addAudioTrack, importFilesDialog, DND_ASSET } from '../../assetActions.js';
import {
  getLayout, getDuration, currentIndex, loopBounds, usePlaybackPrefs, playRate,
  togglePlay, stepFrames, goStart, goEnd, useShuttle, shuttleBadge,
} from './usePlayback.js';
import { shotRangeLabel } from './timelineUtils.js';
import { itemsInRange } from '../../../engine/timeline.js';
import TransformOverlay, { useTfUi } from './TransformOverlay.jsx';

const MAX_RENDER_W = 1920;
const STAGE_PAD = 16;
const FOLLOW_MS = 3000;   // 暂停时改变后持续补画的时长（等视频加载 / seek 完成）
const IDLE_REDRAW_MS = 300;

/**
 * 暂停在 0 秒且首段带「从黑淡入」时，预览显示淡入完成后的首帧，避免一打开就是黑屏
 *（播放与导出不受影响）。
 */
export function posterTime(project, t) {
  if (t > 1e-3) return t;
  const c = project && project.tracks && project.tracks.video && project.tracks.video[0];
  const tr = c && c.transitionIn;
  if (!tr || tr.type === 'cut') return t;
  return Math.min(Math.max(0, Number(tr.duration) || 0) + 1 / 30, Math.max(0, (c.out - c.in) / (c.speed || 1) - 0.05));
}

function hasDragAssets(e) {
  try { return Array.from(e.dataTransfer.types || []).includes(DND_ASSET); } catch { return false; }
}

function drawMessage(ctx, w, h, text) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#111215';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = `${Math.max(12, Math.round(h / 28))}px "Microsoft YaHei UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);
  ctx.restore();
}

export default function Preview() {
  const project = useStore((s) => s.project);
  const playing = useStore((s) => s.playing);
  const focus = useStore((s) => s.focus);
  const setMode = useStore((s) => s.setMode);
  const loop = usePlaybackPrefs((s) => s.loop);
  const volume = usePlaybackPrefs((s) => s.volume);
  const muted = usePlaybackPrefs((s) => s.muted);

  const rootRef = useRef(null);
  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const sizeRef = useRef({ w: 0, h: 0, rw: 0, rh: 0 });
  const [disp, setDisp] = useState({ w: 0, h: 0 });
  const [fullscreen, setFullscreen] = useState(false);
  const [dropOver, setDropOver] = useState(false);
  const [poolError, setPoolError] = useState(null);

  const settings = (project && project.settings) || { width: 1920, height: 1080, aspect: '16:9' };
  const aspectRatio = settings.width > 0 && settings.height > 0 ? settings.width / settings.height : 16 / 9;
  const aspectLabel = (ASPECTS[settings.aspect] && ASPECTS[settings.aspect].label) || settings.aspect || '';
  const isEmpty = !project || ((project.tracks.video || []).length === 0 && (project.tracks.text || []).length === 0);

  // ---------- 尺寸适配 ----------
  const fit = useCallback(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    const W = Math.max(0, stage.clientWidth - STAGE_PAD * 2);
    const H = Math.max(0, stage.clientHeight - STAGE_PAD * 2);
    if (W < 10 || H < 10) return;
    let w = Math.min(W, H * aspectRatio);
    let h = w / aspectRatio;
    w = Math.floor(w); h = Math.floor(h);
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const rw = Math.max(2, Math.min(MAX_RENDER_W, Math.round(w * dpr)));
    const rh = Math.max(2, Math.round(rw / aspectRatio));
    const cur = sizeRef.current;
    if (cur.w === w && cur.h === h && cur.rw === rw && cur.rh === rh) return;
    sizeRef.current = { w, h, rw, rh };
    canvas.width = rw;
    canvas.height = rh;
    setDisp({ w, h });
  }, [aspectRatio]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    fit();
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(() => fit()); ro.observe(stage); }
    window.addEventListener('resize', fit);
    return () => { if (ro) ro.disconnect(); window.removeEventListener('resize', fit); };
  }, [fit]);

  // ---------- 单一 rAF 循环 ----------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    let pool = null;
    try {
      pool = createMediaPool({ mediaUrl: (p) => api.mediaUrl(p) });
    } catch (e) {
      console.error('[preview] 媒体池创建失败', e);
      setPoolError('视频解码组件初始化失败：' + (e && e.message ? e.message : '未知原因'));
    }
    let raf = 0;
    let last = performance.now();
    let lastProject = null; let lastT = -1; let lastW = 0; let lastH = 0; let lastPlaying = false;
    let followUntil = 0; let lastDraw = 0; let frameNo = 0;
    let lastErr = '';

    const draw = (proj, t0, isPlaying) => {
      const t = isPlaying ? t0 : posterTime(proj, t0);
      const layout = getLayout(proj);
      const prefs = usePlaybackPrefs.getState();
      const vol = prefs.muted ? 0 : prefs.volume;
      if (pool) {
        // 倒放时告诉媒体池方向：它会预热上一个片段的出点
        const direction = useShuttle.getState().rate < 0 ? -1 : undefined;
        try { pool.sync(proj, t, layout, { playing: isPlaying, volume: vol, rate: playRate(), direction }); } catch (e) {
          if (lastErr !== 'sync:' + e.message) { lastErr = 'sync:' + e.message; console.error('[preview] 同步媒体失败', e); }
        }
      }
      try {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        renderFrame(ctx, proj, t, pool, { width: canvas.width, height: canvas.height, layout, mode: 'preview' });
        if (lastErr.startsWith('render:')) lastErr = '';
      } catch (e) {
        if (lastErr !== 'render:' + e.message) { lastErr = 'render:' + e.message; console.error('[preview] 画面合成失败', e); }
        drawMessage(ctx, canvas.width, canvas.height, '画面渲染出错：' + (e && e.message ? e.message : '未知原因'));
      }
      lastDraw = performance.now();
    };

    const tick = (now) => {
      raf = requestAnimationFrame(tick);
      frameNo += 1;
      const dt = Math.min(0.25, Math.max(0, (now - last) / 1000));
      last = now;
      const st = useStore.getState();
      const proj = st.project;
      if (!proj || canvas.width < 2) return;

      if (st.playing) {
        const dur = getDuration(proj);
        // commandedTime：按墙钟外推；有主视频在平稳播放时，再按它的实际进度（playerTime）慢慢校正，
        // 画面、声音和播放头不会越走越偏，也就少了漂移纠正时的卡顿
        const step = dt * playRate();
        let t = st.playhead + step;
        if (pool && typeof pool.clockTime === 'function') {
          try { t = slewToClock(t, pool.clockTime(), step); } catch { /* 读不到时钟时只用外推 */ }
        }
        const lb = loopBounds(st);
        let stop = false;
        if (lb) {
          if (t >= lb.end || t < lb.start - 0.5) t = lb.start;
        } else if (t >= dur) {
          t = dur; stop = true;
        }
        st.setPlayhead(t);
        if (stop) st.setPlaying(false);
        draw(proj, t, !stop);
        lastProject = proj; lastT = t; lastW = canvas.width; lastH = canvas.height; lastPlaying = !stop;
        if (stop) followUntil = now + FOLLOW_MS;
        return;
      }

      const t = st.playhead;
      const changed = proj !== lastProject || t !== lastT || canvas.width !== lastW || canvas.height !== lastH || lastPlaying;
      if (changed) {
        lastProject = proj; lastT = t; lastW = canvas.width; lastH = canvas.height; lastPlaying = false;
        followUntil = now + FOLLOW_MS;
        draw(proj, t, false);
        return;
      }
      // 视频 seek 是异步的：改变后的一段时间里隔帧补画，之后低频刷新，保证最终显示精确帧
      if (now < followUntil) { if (frameNo % 2 === 0) draw(proj, t, false); return; }
      if (now - lastDraw > IDLE_REDRAW_MS) draw(proj, t, false);
    };
    raf = requestAnimationFrame(tick);
    // 立即画一帧（不等下一次 rAF），加载 / 切换项目后不会先闪黑
    try { const st0 = useStore.getState(); if (st0.project && canvas.width >= 2) draw(st0.project, st0.playhead, false); followUntil = performance.now() + FOLLOW_MS; } catch { /* 忽略 */ }

    return () => {
      cancelAnimationFrame(raf);
      if (pool) { try { pool.dispose(); } catch (e) { console.error('[preview] 释放媒体池失败', e); } }
    };
  }, []);

  // ---------- 全屏 ----------
  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement && document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);
  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (rootRef.current && rootRef.current.requestFullscreen) await rootRef.current.requestFullscreen();
    } catch (e) {
      useStore.getState().toast('无法切换全屏：' + (e && e.message ? e.message : '系统拒绝'), 'error');
    }
  }, []);

  // ---------- 拖放素材到预览 ----------
  const onDragOver = (e) => {
    if (!project || !hasDragAssets(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dropOver) setDropOver(true);
  };
  const onDragLeave = (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropOver(false); };
  const onDrop = (e) => {
    setDropOver(false);
    if (!project || !hasDragAssets(e)) return;
    e.preventDefault();
    const assets = readDroppedAssets(e.dataTransfer);
    if (!assets.length) { useStore.getState().toast('没有读到拖入的素材，请重试', 'error'); return; }
    const visuals = assets.filter((a) => a.kind !== 'audio');
    const audios = assets.filter((a) => a.kind === 'audio');
    if (visuals.length) insertAssets(visuals, undefined, '添加到时间线');
    for (const a of audios) addAudioTrack(a, 0);
  };

  const effVolume = muted ? 0 : volume;
  const safe = useTfUi((s) => s.safe);

  return (
    <div className={'pv' + (fullscreen ? ' fullscreen' : '')} ref={rootRef}>
      <div
        className={'pv-stage' + (dropOver ? ' drop' : '')}
        ref={stageRef}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onDoubleClick={toggleFullscreen}
      >
        <div className="pv-frame" style={{ width: disp.w || 0, height: disp.h || 0, visibility: isEmpty ? 'hidden' : 'visible' }}>
          <canvas
            ref={canvasRef}
            className="pv-canvas"
            style={{ width: disp.w || 0, height: disp.h || 0 }}
            onClick={() => togglePlay()}
            title="单击播放/暂停，双击全屏"
          />
          {!isEmpty && <TransformOverlay width={disp.w} height={disp.h} />}
          {!isEmpty && <ShotCorner />}
          {focus && <FocusHint focus={focus} loop={loop} />}
        </div>
        {isEmpty && (
          <div className="pv-empty">
            <Empty
              icon="film"
              title="时间线还是空的"
              action={(
                <div className="row" style={{ justifyContent: 'center' }}>
                  <Button variant="secondary" icon="upload" onClick={() => importFilesDialog({ toTimeline: true }).catch(() => {})}>导入素材</Button>
                  <Button variant="ai" icon="sparkles" onClick={() => setMode('create')}>去创作模式一键成片</Button>
                </div>
              )}
            >
              把左侧素材拖到下方时间线，或先去「创作」让 AI 导演帮你规划镜头、自动配真人实拍。
            </Empty>
          </div>
        )}
        {poolError && <div className="pv-error">{poolError}</div>}
        {dropOver && <div className="pv-drop-hint"><Icon name="plus" size={18} />松开即可添加到时间线末尾</div>}
      </div>

      <div className="pv-controls">
        <div className="pv-ctl-left">
          <TimeDisplay />
        </div>
        <div className="pv-ctl-center">
          <Button variant="ghost" size="sm" icon="skipBack" title="跳到开头（Home）" onClick={goStart} disabled={!project} />
          <Button variant="ghost" size="sm" icon="chevronLeft" title="上一帧（←）" onClick={() => stepFrames(-1)} disabled={!project} />
          <button type="button" className={'pv-play' + (playing ? ' on' : '')} title={playing ? '暂停（空格）' : '播放（空格）'} aria-label={playing ? '暂停' : '播放'} onClick={() => togglePlay()} disabled={!project}>
            <Icon name={playing ? 'pause' : 'play'} size={16} />
          </button>
          <Button variant="ghost" size="sm" icon="chevronRight" title="下一帧（→）" onClick={() => stepFrames(1)} disabled={!project} />
          <Button variant="ghost" size="sm" icon="skipFwd" title="跳到结尾（End）" onClick={goEnd} disabled={!project} />
        </div>
        <div className="pv-ctl-right">
          <div className="pv-vol" title={`预览音量 ${Math.round(effVolume * 100)}%（不影响导出）`}>
            <Button variant="ghost" size="sm" icon={effVolume === 0 ? 'mute' : 'volume'} onClick={() => usePlaybackPrefs.getState().setMuted(!muted)} />
            <div className="pv-vol-pop">
              <input type="range" className="slider pv-volume" min={0} max={1} step={0.01} value={effVolume}
                onChange={(e) => usePlaybackPrefs.getState().setVolume(Number(e.target.value))} aria-label="预览音量" />
            </div>
          </div>
          <Button variant="ghost" size="sm" icon="refresh" active={loop} title={loop ? '循环播放：开' : '循环播放'} onClick={() => usePlaybackPrefs.getState().setLoop(!loop)} />
          <Button variant="ghost" size="sm" icon="grid" active={safe} title={safe ? '隐藏安全框' : '显示安全框'} onClick={() => useTfUi.setState({ safe: !safe })} />
          <AspectMenu settings={settings} label={aspectLabel} disabled={!project} />
          <Button variant="ghost" size="sm" icon="focus" title={fullscreen ? '退出全屏（Esc）' : '全屏预览'} onClick={toggleFullscreen} />
        </div>
      </div>
    </div>
  );
}

/** 画幅下拉：图标按钮 + 浮层列表 */
function AspectMenu({ settings, label, disabled }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  const pick = (aspect) => {
    setOpen(false);
    if (aspect === settings.aspect) return;
    useStore.getState().commit([{ type: 'setProject', target: { mode: 'none', indices: [], ids: [] }, settings: { aspect } }], '修改画幅');
  };
  const ratio = (a) => { const w = a.width || 16; const h = a.height || 9; const k = 14 / Math.max(w, h); return { width: Math.round(w * k), height: Math.round(h * k) }; };
  return (
    <div className="pv-aspect-wrap" ref={ref}>
      <button type="button" className="pv-aspect" disabled={disabled} onClick={() => setOpen((o) => !o)} title={`画幅 ${settings.width}×${settings.height}`}>
        <span className="pv-aspect-ico" style={ratio(ASPECTS[settings.aspect] || {})} />
        <span>{(settings.aspect || '').replace(':', '∶')}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <div className="pv-menu" role="menu">
          {Object.entries(ASPECTS).map(([k, a]) => (
            <button key={k} type="button" role="menuitemradio" aria-checked={k === settings.aspect} className={'pv-menu-item' + (k === settings.aspect ? ' on' : '')} onClick={() => pick(k)}>
              <span className="pv-aspect-ico" style={ratio(a)} />
              <span className="grow">{a.label}</span>
              {k === settings.aspect && <Icon name="check" size={12} />}
            </button>
          ))}
        </div>
      )}
      <span hidden>{label}</span>
    </div>
  );
}

/** 画面左上角：倒放 / 快进时显示倍速角标；其余时候悬停显示当前片段 */
function ShotCorner() {
  const rate = useShuttle((s) => s.rate);
  const playing = useStore((s) => s.playing);
  const badge = shuttleBadge(rate, playing);
  if (badge) return <ShuttleBadge badge={badge} />;
  return <CurrentShotLabel />;
}

// 与 .pv-hover-info 同一套半透明黑底（样式表归属别的包，这里用行内样式，令牌带兜底值）
const SHUTTLE_STYLE = {
  position: 'absolute', left: 10, top: 10, zIndex: 5,
  display: 'inline-flex', alignItems: 'center', gap: 5,
  height: 22, padding: '0 9px', boxSizing: 'border-box',
  borderRadius: 'var(--radius-pill, 999px)', background: 'rgba(10,10,12,.66)', backdropFilter: 'blur(6px)',
  color: 'var(--text-0, #eeeef0)', font: '600 var(--fs-s, 12px) var(--font-mono, monospace)',
  lineHeight: 1, whiteSpace: 'nowrap', pointerEvents: 'none', userSelect: 'none',
};
const ARROW_STYLE = { fontSize: '0.8em', letterSpacing: '-0.18em', marginRight: '0.18em' };

/** 穿梭倍速角标：◀ 1× / ◀◀ 4× / ▶▶ 2× */
function ShuttleBadge({ badge }) {
  // U+FE0E：箭头按文字字形显示，不被系统换成彩色 emoji
  const arrows = badge.arrows.replace(/[◀▶]/g, (c) => c + '\uFE0E');
  return (
    <span className="pv-shuttle" data-dir={badge.dir} data-rate={badge.rate} role="status" aria-label={badge.title} title={badge.title} style={SHUTTLE_STYLE}>
      <span aria-hidden="true" style={ARROW_STYLE}>{arrows}</span>
      <span aria-hidden="true">{badge.rate}×</span>
    </span>
  );
}

/** 画面左上角（悬停显示）：当前片段号与名称 */
function CurrentShotLabel() {
  const text = useStore((s) => {
    const p = s.project;
    if (!p) return '';
    const i = currentIndex(p, s.playhead);
    if (i < 0) return '';
    const clip = p.tracks.video[i];
    if (!clip) return '';
    const asset = p.assets[clip.assetId];
    const name = clip.label || (asset && asset.name) || '未命名片段';
    const fake = asset && (asset.kind === 'previz' || isPrevizSource(asset));
    return `${i + 1}\u0000${name}\u0000${fake ? '1' : ''}`;
  });
  if (!text) return null;
  const [num, name, previz] = text.split('\u0000');
  return (
    <span className="pv-hover-info">
      <span className="pv-shot-no">{num}</span>
      <span className="pv-shot-name ellipsis">{name}</span>
      {previz && <span className="pv-shot-flag" title="示意画面，导出带水印；在属性面板可一键替换为真人实拍">示意</span>}
    </span>
  );
}
function FocusHint({ focus, loop }) {
  const project = useStore((s) => s.project);
  const layout = getLayout(project);
  const idx = itemsInRange(layout, focus.start, focus.end).map((it) => it.index);
  const label = shotRangeLabel(idx);
  return (
    <span className="pv-focus" title="正在聚焦精修该时间段；AI 修改会参考全片风格保持一致">
      <Icon name="focus" size={13} />
      聚焦精修 {fmtTime(focus.start, false)}–{fmtTime(focus.end, false)}{label ? `（${label}）` : ''}
      {loop ? ' · 段内循环' : ''}
    </span>
  );
}

function TimeDisplay() {
  const project = useStore((s) => s.project);
  const dur = getDuration(project);
  const curRef = useRef(null);
  // 播放头每帧都在变：直接改文字，不让这个组件每帧重渲染（只在工程变化时重渲染总时长）
  useLayoutEffect(() => {
    const paint = (t) => {
      const el = curRef.current;
      if (!el) return;
      const d = getDuration(useStore.getState().project);
      const text = fmtTime(Math.min(t, d || t));
      if (el.textContent !== text) el.textContent = text;
    };
    paint(useStore.getState().playhead);
    return useStore.subscribe((s, prev) => {
      if (s.playhead !== prev.playhead || s.project !== prev.project) paint(s.playhead);
    });
  }, []);
  return (
    <span className="pv-time mono" title="当前时间 / 总时长">
      <span className="cur" ref={curRef} />
      <span className="sep">/</span>
      <span className="tot">{fmtTime(dur)}</span>
    </span>
  );
}
