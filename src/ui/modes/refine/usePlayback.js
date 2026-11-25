// 精修模式的播放控制：布局缓存、播放/暂停/逐帧/跳转动作、播放偏好（循环、音量）。
// 播放头推进本身在 Preview.jsx 的单一 rAF 循环里完成，这里只提供动作与共享状态。
import { create } from 'zustand';
import { useStore } from '../../store.js';
import { layoutVideo, projectDuration, indexAtTime } from '../../../engine/timeline.js';
import { readPref, writePref, clampNum } from './timelineUtils.js';
import { SHUTTLE_STEPS, nextShuttleRate, shuttleBadge } from './shuttle.js';

export { SHUTTLE_STEPS, nextShuttleRate, shuttleBadge };

// ---------------- 布局 / 总长缓存（按 project 对象身份） ----------------
const layoutCache = new WeakMap();
const durationCache = new WeakMap();

/** 主轨布局（同一个 project 对象只算一次） */
export function getLayout(project) {
  if (!project) return [];
  let l = layoutCache.get(project);
  if (!l) {
    try { l = layoutVideo(project) || []; } catch (e) { console.error('[refine] 时间线布局失败', e); l = []; }
    layoutCache.set(project, l);
  }
  return l;
}

/** 项目总时长（主轨/文字/音频取最大） */
export function getDuration(project) {
  if (!project) return 0;
  let d = durationCache.get(project);
  if (d == null) {
    try { d = projectDuration(project, getLayout(project)) || 0; } catch { d = 0; }
    durationCache.set(project, d);
  }
  return d;
}

export function getFps(project) {
  const f = Number(project && project.settings && project.settings.fps);
  return f >= 1 && f <= 120 ? f : 30;
}

/** 当前播放头所在镜头（0 起），空主轨 -1 */
export function currentIndex(project, t) {
  const layout = getLayout(project);
  if (!layout.length) return -1;
  return indexAtTime(layout, t);
}

// ---------------- 播放偏好（不进项目，记在本机） ----------------
const PREF_KEY = 'ff.refine.playback';
const initialPrefs = readPref(PREF_KEY, {});

export const usePlaybackPrefs = create((set, get) => ({
  loop: !!initialPrefs.loop,
  volume: clampNum(initialPrefs.volume == null ? 1 : initialPrefs.volume, 0, 1),
  muted: !!initialPrefs.muted,
  setLoop(loop) { set({ loop: !!loop }); persist(get()); },
  setVolume(v) { set({ volume: clampNum(v, 0, 1), muted: false }); persist(get()); },
  setMuted(muted) { set({ muted: !!muted }); persist(get()); },
}));

function persist(s) { writePref(PREF_KEY, { loop: s.loop, volume: s.volume, muted: s.muted }); }

/** 当前生效的循环区间：开启循环时，有聚焦就是聚焦段，否则整片；未开启返回 null */
export function loopBounds(state = useStore.getState()) {
  if (!usePlaybackPrefs.getState().loop) return null;
  const dur = getDuration(state.project);
  if (!(dur > 0)) return null;
  if (state.focus && state.focus.end > state.focus.start) {
    const start = clampNum(state.focus.start, 0, dur);
    const end = clampNum(state.focus.end, start, dur);
    if (end - start > 0.05) return { start, end };
  }
  return { start: 0, end: dur };
}

// ---------------- 动作 ----------------
export function seek(t) {
  const st = useStore.getState();
  const dur = getDuration(st.project);
  st.setPlayhead(clampNum(t, 0, Math.max(0, dur)));
}

export function play() {
  const st = useStore.getState();
  if (!st.project) return false;
  const dur = getDuration(st.project);
  if (!(dur > 0)) { st.toast('时间线是空的，先从左侧拖入素材'); return false; }
  const frame = 1 / getFps(st.project);
  const lb = loopBounds(st);
  if (lb) {
    if (st.playhead < lb.start || st.playhead >= lb.end - frame) st.setPlayhead(lb.start);
  } else if (st.playhead >= dur - frame) {
    st.setPlayhead(0);
  }
  st.setPlaying(true);
  return true;
}

export function pause() {
  stopShuttle();
  const st = useStore.getState();
  if (st.playing) st.setPlaying(false);
}

export function togglePlay() {
  if (useStore.getState().playing || useShuttle.getState().rate < 0) {
    stopShuttle();
    const st = useStore.getState();
    if (st.playing) st.setPlaying(false);
    return false;
  }
  if (useShuttle.getState().rate) stopShuttle();
  return play();
}

/** 逐帧移动（会暂停），对齐到帧网格 */
export function stepFrames(n = 1) {
  const st = useStore.getState();
  if (!st.project) return;
  pause();
  const fps = getFps(st.project);
  const frameNo = Math.round(st.playhead * fps) + n;
  seek(frameNo / fps);
}

export function stepSeconds(s = 1) {
  const st = useStore.getState();
  if (!st.project) return;
  pause();
  seek(st.playhead + s);
}

// ---------------- J/K/L 穿梭倍速 ----------------
// rate：正值（1/2/4）由 Preview 的 rAF 推进并带声音（媒体 playbackRate×倍速，音调不变）；
// 负值（倒放）由这里的 rAF 逐帧回退 seek，浏览器无法倒序播放声音，倒放预览静音（导出时倒放片段有声）。
// 当前倍速显示在预览左上角的角标上（shuttleBadge），不再弹提示条。
export const useShuttle = create(() => ({ rate: 0 }));

/** Preview 推进播放头用的倍速：正在播放且穿梭倍速 >1 时为该倍速，否则 1 */
export function playRate() {
  const r = useShuttle.getState().rate;
  return r > 1 && useStore.getState().playing ? r : 1;
}

let shuttleRaf = 0;
let shuttleLast = 0;
function stopShuttleLoop() { if (shuttleRaf) cancelAnimationFrame(shuttleRaf); shuttleRaf = 0; }

/** 停止穿梭倍速（含倒放 rAF 循环），卸载或切换模式时调用 */
export function stopShuttle() {
  stopShuttleLoop();
  if (useShuttle.getState().rate !== 0) useShuttle.setState({ rate: 0 });
}

function shuttleTick(now) {
  const rate = useShuttle.getState().rate;
  const st = useStore.getState();
  if (!(rate < 0) || !st.project || st.mode !== 'refine') { stopShuttle(); return; }
  const dt = Math.min(0.1, (now - shuttleLast) / 1000);
  shuttleLast = now;
  const dur = getDuration(st.project);
  const fps = getFps(st.project);
  // 按帧网格推进（倒放即逐帧回退 seek）
  const t = Math.round((st.playhead + rate * dt) * fps * 1000) / (fps * 1000);
  if (t <= 0 || t >= dur) { seek(t); useShuttle.setState({ rate: 0 }); shuttleRaf = 0; return; }
  seek(t);
  shuttleRaf = requestAnimationFrame(shuttleTick);
}

/** 设置穿梭倍速：0 停；1 正常播放；其它值进入快进/倒放 */
export function setRate(rate) {
  stopShuttleLoop();
  useShuttle.setState({ rate });
  if (rate > 0) {
    if (!useStore.getState().playing && !play()) useShuttle.setState({ rate: 0 });
    return;
  }
  const st = useStore.getState();
  if (st.playing) st.setPlaying(false);
  if (!rate) return;
  if (!st.project || !(getDuration(st.project) > 0)) { useShuttle.setState({ rate: 0 }); return; }
  shuttleLast = performance.now();
  shuttleRaf = requestAnimationFrame(shuttleTick);
}

let reverseHinted = false;
export function shuttle(key) {
  let cur = useShuttle.getState().rate;
  // 用户用空格等方式暂停/播放后，以实际播放状态为准
  if (cur > 0 && !useStore.getState().playing) cur = 0;
  if (cur === 0 && useStore.getState().playing) cur = 1;
  const next = nextShuttleRate(cur, key);
  setRate(next);
  // 倍速由预览左上角的角标显示；只在本次运行第一次倒放时说明一次「没有声音」（同 key 原地替换，不叠加）
  if (next < 0 && !reverseHinted) {
    reverseHinted = true;
    try {
      useStore.getState().toast?.('倒放预览没有声音，正常播放和导出不受影响', 'info', undefined, { key: 'shuttle' });
    } catch { /* 提示失败不影响倒放 */ }
  }
  return next;
}

export function goStart() { pause(); seek(0); }
export function goEnd() { pause(); seek(getDuration(useStore.getState().project)); }
