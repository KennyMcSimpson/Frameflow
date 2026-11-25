// 检查器共享小组件：可折叠分组、实时预览 + 一步历史提交、数字/文字/颜色输入、可直接输入数值的滑杆。
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import useStore from '../../store.js';
import { applyOps } from '../../../engine/ops.js';
import { Icon } from '../../components/ui.jsx';
import { readPref, writePref } from './SideData.js';
import {
  FMT, parseNum, parseSeconds, clamp, nudge, stepDecimals, trimNum, nearlyEqual, normHex, upsertKey, localTime,
} from './inspValue.js';

export const T_IDS = (ids) => ({ mode: 'ids', indices: [], ids: [...ids] });
export const T_NONE = { mode: 'none', indices: [], ids: [] };

// 显示格式（带 edit/parse/unit，点开数值时按显示单位输入），定义在 inspValue.js，这里转出保持旧的引用方式
export { FMT };

/** 属性面板的轻提示（同一个 key 同一时间只留一条）；提示失败不影响编辑 */
function tip(message, kind = 'warn', key = 'insp-input') {
  try { useStore.getState().toast(message, kind, 2600, { key }); } catch { /* 忽略 */ }
}

/**
 * 实时预览 + 提交一步历史。
 * preview(opsOrFn)：从拖动开始时的原项目重新计算（不进历史、不保存）。
 * commit(opsOrFn, label)：先恢复原项目再 store.commit（保证撤销回到拖动前）。
 */
export function useLiveEdit(resetKey) {
  const origRef = useRef(null);
  const lastRef = useRef(null); // 最近一次预览写入的项目对象

  const restore = useCallback(() => {
    const orig = origRef.current;
    const last = lastRef.current;
    origRef.current = null;
    lastRef.current = null;
    const st = useStore.getState();
    // 只有当前项目仍是预览结果时才恢复，避免覆盖期间发生的其它修改
    if (orig && st.project && st.project === last) useStore.setState({ project: orig });
    return !!orig;
  }, []);

  // 选择切换时，若有未提交的预览就丢弃（回到原状态）
  useEffect(() => () => { restore(); }, [resetKey, restore]);

  const preview = useCallback((opsOrFn) => {
    const st = useStore.getState();
    if (!st.project) return;
    // 当前项目不是我们上次的预览结果（首次拖动或期间有别的修改）→ 以当前项目为新起点
    if (!origRef.current || st.project !== lastRef.current) origRef.current = st.project;
    const base = origRef.current;
    let next = null;
    try {
      if (typeof opsOrFn === 'function') next = opsOrFn(base);
      else {
        const r = applyOps(base, opsOrFn, { selectedClipIds: st.selection.clipIds, range: st.range, playhead: st.playhead });
        next = r && r.ok ? r.project : null;
      }
    } catch { next = null; }
    if (next) { lastRef.current = next; useStore.setState({ project: next }); }
  }, []);

  const commit = useCallback((opsOrFn, label, { onlyIfPreviewed = false } = {}) => {
    const had = restore();
    if (onlyIfPreviewed && !had) return { ok: false, applied: [], errors: [] };
    return useStore.getState().commit(opsOrFn, label);
  }, [restore]);

  return { preview, commit, restore };
}

/** 可折叠分组（状态记在本机） */
export function InspSection({ id, title, icon, children, actions, defaultOpen = true, badge }) {
  const [open, setOpen] = useState(() => readPref('insp.open.' + id, defaultOpen));
  const toggle = () => setOpen((o) => { writePref('insp.open.' + id, !o); return !o; });
  return (
    <section className={'insp-sec' + (open ? ' open' : '')}>
      <header className="insp-sec-head">
        <button
          type="button"
          className="insp-sec-toggle"
          onClick={toggle}
          aria-expanded={open}
          style={{
            flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6,
            padding: 0, border: 0, background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer',
          }}
        >
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
          {icon && <Icon name={icon} size={13} />}
          <span className="insp-sec-title">{title}</span>
          {badge && <span className="insp-sec-badge">{badge}</span>}
        </button>
        {actions && <span className="insp-sec-actions">{actions}</span>}
      </header>
      {open && <div className="insp-sec-body">{children}</div>}
    </section>
  );
}

/** 标签 + 控件 一行 */
export function InspRow({ label, children, hint }) {
  return (
    <div className="insp-row" title={hint}>
      <span className="insp-row-label">{label}</span>
      <div className="insp-row-ctl">{children}</div>
    </div>
  );
}

/**
 * 数字输入：回车/失焦提交，Esc 复原；↑↓ 微调（Shift 十倍步长）并立即生效，按住连调只算一步撤销。
 * 能识别「1:05.5」「1分30秒」「１２」「120%」等写法；超出范围自动夹到范围内。
 * onCommit(v, mergeKey)：方向键连调时带 mergeKey，调用方转给提交函数即可合并成一步。
 */
export function NumField({ value, min = -Infinity, max = Infinity, step = 0.1, onCommit, disabled, suffix, digits = 2, parse, label }) {
  const fmt = (v) => (Number.isFinite(Number(v)) ? trimNum(Number(v), digits) : '');
  const [draft, setDraft] = useState(fmt(value));
  const focused = useRef(false);
  const cancelled = useRef(false);
  const numId = useId();
  const mergeKey = 'insp:num:' + numId;
  useEffect(() => { if (!focused.current) setDraft(fmt(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const read = (text) => {
    const n = (parse || (suffix === '秒' ? parseSeconds : parseNum))(text);
    return n == null || !Number.isFinite(n) ? null : n;
  };
  const commit = () => {
    const text = String(draft == null ? '' : draft).trim();
    if (!text) { setDraft(fmt(value)); return; }
    const n = read(text);
    if (n == null) {
      setDraft(fmt(value));
      tip(`${label ? `「${label}」` : ''}请输入数字，例如 ${fmt(value) || '1'}${suffix === '秒' ? '（也可以写 1:05.5）' : ''}`);
      return;
    }
    const v = clamp(n, min, max);
    setDraft(fmt(v));
    if (!nearlyEqual(v, Number(value), 1e-6)) onCommit(v);
  };
  return (
    <div className="insp-num">
      <input
        type="text"
        inputMode="decimal"
        className="input insp-num-input"
        value={draft}
        disabled={disabled}
        spellCheck={false}
        aria-label={label || undefined}
        title="可直接输入；↑↓ 微调，按住 Shift 调得更快"
        onFocus={(e) => { focused.current = true; cancelled.current = false; e.target.select(); }}
        onBlur={() => {
          focused.current = false;
          if (cancelled.current) { cancelled.current = false; setDraft(fmt(value)); return; }
          commit();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); return; }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelled.current = true; e.currentTarget.blur(); return; }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            e.stopPropagation();
            const n = read(String(draft));
            const v = nudge(n == null ? Number(value) || 0 : n, e.key === 'ArrowUp' ? 1 : -1, step, e.shiftKey, min, max);
            setDraft(fmt(v));
            if (!nearlyEqual(v, Number(value), 1e-6)) onCommit(v, mergeKey);
          }
        }}
      />
      {suffix && <span className="insp-num-suffix">{suffix}</span>}
    </div>
  );
}

/** 文本输入：输入时 onPreview（可选），失焦或 Ctrl+Enter 提交 */
export function TextDraft({ value, onPreview, onCommit, placeholder, multiline = true, disabled, rows = 2, maxLength = 300 }) {
  const [draft, setDraft] = useState(value || '');
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(value || ''); }, [value]);
  const commit = () => { if ((draft || '') !== (value || '')) onCommit(draft); };
  const common = {
    value: draft,
    placeholder,
    disabled,
    maxLength,
    spellCheck: false,
    onFocus: () => { focused.current = true; },
    onBlur: () => { focused.current = false; commit(); },
    onChange: (e) => { setDraft(e.target.value); if (onPreview) onPreview(e.target.value); },
    onKeyDown: (e) => {
      if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) { e.preventDefault(); e.currentTarget.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); setDraft(value || ''); if (onPreview) onPreview(value || ''); }
    },
  };
  return multiline
    ? <textarea className="textarea insp-text" rows={rows} {...common} />
    : <input type="text" className="input" {...common} />;
}

/**
 * 颜色：色块打开取色器（拖动中预览，关闭取色器时提交）；旁边可直接输入色值（回车确认、Esc 取消）；
 * swatches 给出常用色，一键套用。
 */
export function ColorField({ value, onPreview, onCommit, disabled, swatches, label }) {
  const ref = useRef(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    // 原生 change 只在取色器关闭且颜色确实改变时触发
    const onChange = () => { if (commitRef.current) commitRef.current(el.value); };
    el.addEventListener('change', onChange);
    return () => el.removeEventListener('change', onChange);
  }, []);
  const safe = normHex(value) || '#ffffff';
  const [hex, setHex] = useState(null); // 色值输入框里的文字；null = 没在输入
  const skip = useRef(false);
  const commitHex = () => {
    const text = hex;
    setHex(null);
    if (skip.current) { skip.current = false; return; }
    if (text == null) return;
    const c = normHex(text);
    if (!c) { if (String(text).trim()) tip('颜色请写成 #RRGGBB，例如 #FFD400'); return; }
    if (c !== safe && onCommit) onCommit(c);
  };
  const name = label || '颜色';
  return (
    <div className="insp-color">
      <input ref={ref} type="color" value={safe} disabled={disabled} aria-label={`${name}：打开取色器`} title="打开取色器" onChange={(e) => onPreview && onPreview(e.target.value)} />
      <input
        type="text"
        className="insp-hex"
        value={hex != null ? hex : safe.toUpperCase()}
        disabled={disabled}
        spellCheck={false}
        maxLength={9}
        aria-label={`${name}色值`}
        title="可直接输入色值，例如 #FFD400，回车确认"
        onFocus={(e) => { setHex(safe.toUpperCase()); e.target.select(); }}
        onChange={(e) => setHex(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); skip.current = true; e.currentTarget.blur(); }
        }}
        onBlur={commitHex}
      />
      {Array.isArray(swatches) && swatches.length > 0 && (
        <span className="insp-swatches" role="group" aria-label="常用颜色">
          {swatches.map((c) => {
            const n = normHex(c);
            if (!n) return null;
            return (
              <button
                key={n} type="button" className={'insp-sw' + (n === safe ? ' on' : '')} style={{ '--sw': n }} disabled={disabled}
                title={n.toUpperCase()} aria-label={`使用颜色 ${n.toUpperCase()}`} aria-pressed={n === safe}
                onClick={() => { if (n !== safe && onCommit) onCommit(n); }}
              />
            );
          })}
        </span>
      )}
    </div>
  );
}

// ====================== v3 · 按选中对象驱动的属性面板公共件 ======================
import * as UI from '../../components/ui.jsx';
import { layoutVideo, overlayDuration } from '../../../engine/timeline.js';

// 其它工作包的可选模块（未完成时为空对象，自动降级为本地实现）
const OPT = import.meta.glob(['../../../engine/keyframes.js', '../../../engine/captions.js', '../../../export/presets.js'], { eager: true });
const pick = (suffix) => { const k = Object.keys(OPT).find((p) => p.endsWith(suffix)); return (k && OPT[k]) || {}; };
export const KF = pick('keyframes.js');
export const CAPTIONS = pick('captions.js');
export const PRESETS = pick('presets.js');

const UNSUPPORTED_OP_RE = /未知操作|不支持的操作/;
function isUnsupportedOpResult(r) {
  return !!(r && r.ok === false && Array.isArray(r.errors) && r.errors.length > 0
    && r.errors.every((e) => UNSUPPORTED_OP_RE.test(String(e || ''))));
}

/**
 * 统一提交一个 op：优先 store.apply(op,{label,mergeKey})，其次 store.commit。
 * 仅当引擎明确报错「未知/不支持的操作」时才走 fallback 兜底；轨道锁、片段锁、定格变速限制或参数校验失败一律原样拒绝。
 */
export function runOp(op, label, { mergeKey, fallback, silent } = {}) {
  const st = useStore.getState();
  if (!st.project) return { ok: false, applied: [], errors: ['没有打开的项目'] };
  const quiet = !!fallback || !!silent;
  let r = null;
  try {
    r = typeof st.apply === 'function'
      ? st.apply(op, { label, mergeKey, silent: quiet })
      : st.commit([op], label, { mergeKey, silent: quiet });
  } catch (e) {
    r = { ok: false, applied: [], errors: [(e && e.message) || '操作失败'] };
  }
  if (fallback && isUnsupportedOpResult(r)) {
    return st.commit(fallback, label, { mergeKey, silent });
  }
  if (r && r.ok === false && fallback && !silent) {
    st.toast(`未修改：${(r.errors || []).join('；') || '操作无效'}`, 'error');
  }
  return r || { ok: false, applied: [], errors: ['操作无效'] };
}

/** 兜底：给主轨/画中画/音频/文字的某一项打补丁 */
export function patchItem(kind, id, patchOrFn) {
  return (p) => {
    const ap = (x) => (x.id === id ? (typeof patchOrFn === 'function' ? patchOrFn(x) : { ...x, ...patchOrFn }) : x);
    if (kind === 'overlay') return { ...p, overlays: (p.overlays || []).map(ap) };
    return { ...p, tracks: { ...p.tracks, [kind === 'clip' ? 'video' : kind]: (p.tracks[kind === 'clip' ? 'video' : kind] || []).map(ap) } };
  };
}

/** 选中项在时间线上的起点（求片段本地时间用） */
export function itemStart(project, target, item) {
  if (!item) return 0;
  if (target === 'clip') {
    try { const it = (layoutVideo(project) || []).find((x) => x.clip.id === item.id); return it ? it.start : 0; } catch { return 0; }
  }
  return Number(item.start) || 0;
}

const near = (a, b, eps) => Math.abs(a - b) <= eps;
export function keyList(item, path) {
  if (!item) return [];
  if (path === 'volume' && Array.isArray(item.volumeKeys) && !(item.keys && item.keys.volume)) return item.volumeKeys;
  return (item.keys && Array.isArray(item.keys[path])) ? item.keys[path] : [];
}

/** 在项目里按对象类型和 id 找到这一项（主轨片段 / 画中画 / 音频 / 文字） */
export function findItem(project, target, id) {
  if (!project || !id) return null;
  if (target === 'overlay') return (project.overlays || []).find((x) => x.id === id) || null;
  const key = target === 'clip' ? 'video' : target;
  return ((project.tracks && project.tracks[key]) || []).find((x) => x.id === id) || null;
}

/** 关键帧对象在时间线上的范围 { start, dur }（求片段本地时间用） */
function itemRange(project, target, item) {
  if (!project || !item) return { start: 0, dur: 0 };
  if (target === 'clip') {
    try {
      const it = (layoutVideo(project) || []).find((x) => x.clip.id === item.id);
      if (it) return { start: Number(it.start) || 0, dur: Number(it.duration) || 0 };
    } catch { /* 布局失败按 0 处理 */ }
    return { start: 0, dur: 0 };
  }
  const start = Number(item.start) || 0;
  if (target === 'overlay') {
    let dur = 0;
    try { dur = overlayDuration(item); } catch { dur = 0; }
    return { start, dur: Number(dur) || 0 };
  }
  if (target === 'audio') return { start, dur: Math.max(0, (Number(item.out) || 0) - (Number(item.in) || 0)) };
  return { start, dur: Math.max(0, Number(item.duration) || 0) };
}

/** 关键帧插值（优先用引擎 keyframes.js，缺失时按线性） */
function keyValueAt(list, path, t, base) {
  if (typeof KF.valueAt === 'function') {
    try { return KF.valueAt({ [path]: list }, path, t, base); } catch { /* 退回线性 */ }
  }
  if (!list.length) return base;
  if (t <= list[0].t) return list[0].v;
  const last = list[list.length - 1];
  if (t >= last.t) return last.v;
  let i = 0;
  while (i < list.length - 1 && list[i + 1].t <= t) i += 1;
  const a = list[i];
  const b = list[i + 1];
  return b.t > a.t ? a.v + (b.v - a.v) * ((t - a.t) / (b.t - a.t)) : b.v;
}

const NO_KEYS = [];
const KEY_SAME = Number(KF.KEY_EPS) > 0 ? Number(KF.KEY_EPS) : 1 / 120;
const r3 = (t) => Math.round((Number(t) || 0) * 1000) / 1000;

/**
 * 关键帧逻辑。kf = { target, item, path, value(基础值), label }；没有 kf 返回 undefined。
 * 返回：active/hasKeys/count/label/onToggle/onPrev/onNext（给 ◆ 按钮），
 *       value —— 播放头处的实际值（参数有关键帧时滑杆显示它），
 *       previewAt(v)/commitAt(v) —— 有关键帧时调参数 = 改播放头处的关键帧（那里没有就新建）。
 * 只有已经有关键帧的参数才跟着播放头刷新，播放时其它参数不重绘。
 * 播放头不在这个片段上时，打关键帧前先把播放头移到片段内（不会打出片段范围外、看不见的关键帧）。
 */
export function useKf(kf) {
  const project = useStore((s) => s.project);
  const item = kf ? kf.item : null;
  const target = kf ? kf.target : '';
  const path = kf ? kf.path : '';
  const list = item ? keyList(item, path) : NO_KEYS;
  const animated = list.length > 0;
  const playhead = useStore((s) => (animated ? s.playhead : 0));
  const range = useMemo(() => itemRange(project, target, item), [project, target, item]);
  if (!kf || !item) return undefined;
  const base = kf.value;
  const label = kf.label;
  const name = label || path;
  const fps = Number(project && project.settings && project.settings.fps) || 30;
  const eps = 0.5 / fps;
  const audioVol = target === 'audio' && path === 'volume';
  const loc = localTime(playhead, range.start, range.dur, fps);
  const before = !loc.inside && playhead < range.start;
  const cur = animated && loc.inside ? list.find((k) => near(k.t, loc.lt, eps)) : null;
  let prev = null;
  let next = null;
  if (animated) {
    if (before) next = list[0];
    else if (!loc.inside) prev = list[list.length - 1];
    else {
      prev = [...list].filter((k) => k.t < loc.lt - eps).pop() || null;
      next = list.find((k) => k.t > loc.lt + eps) || null;
    }
  }
  const writeKeys = (x, arr) => (audioVol ? { ...x, volumeKeys: arr } : { ...x, keys: { ...(x.keys || {}), [path]: arr } });
  const setKeyFb = (t, v) => patchItem(target, item.id, (x) => writeKeys(x, upsertKey(keyList(x, path), t, v, { audio: audioVol })));
  // 播放头不在片段上时先移进来，返回片段本地时间
  const enter = () => {
    const st = useStore.getState();
    const now = localTime(Number(st.playhead) || 0, range.start, range.dur, fps);
    if (!now.inside) {
      try { st.setPlayhead(range.start + now.lt); } catch { /* 忽略 */ }
      tip('播放头不在这个片段上，已移到片段内', 'info', 'insp-kf-seek');
    }
    return now;
  };
  const freshList = () => keyList(findItem(useStore.getState().project, target, item.id) || item, path);
  const onToggle = () => {
    const now = enter();
    const keys = freshList();
    const at = keys.find((k) => near(k.t, now.lt, eps));
    if (at && now.inside) {
      runOp({ type: 'removeKeyframe', target, id: item.id, path, t: at.t }, `删除关键帧：${name}`, {
        fallback: patchItem(target, item.id, (x) => writeKeys(x, keyList(x, path).filter((k) => !near(k.t, at.t, 1e-4)))),
      });
      return;
    }
    if (at) return; // 刚移到的位置已经有关键帧：只移动播放头
    const t = r3(now.lt);
    // 已有关键帧时取这一刻的插值，添加关键帧不会让画面跳变
    const v = keys.length ? keyValueAt(keys, path, now.lt, base) : base;
    runOp({ type: 'setKeyframe', target, id: item.id, path, t, v, ease: 'ease' }, `添加关键帧：${name}`, { fallback: setKeyFb(t, v) });
  };
  const jump = (k) => { if (k) { try { useStore.getState().setPlayhead(range.start + k.t); } catch { /* 忽略 */ } } };
  return {
    active: !!cur,
    hasKeys: animated,
    count: list.length,
    label,
    value: animated ? keyValueAt(list, path, loc.lt, base) : base,
    onToggle,
    onPrev: () => jump(prev),
    onNext: () => jump(next),
    previewAt: (v) => setKeyFb(r3(enter().lt), v),
    commitAt: (v) => {
      const t = r3(enter().lt);
      const exists = freshList().some((k) => near(k.t, t, KEY_SAME));
      // 改已有关键帧时不传缓动（保留原来的），新建的用缓入缓出
      return runOp({ type: 'setKeyframe', target, id: item.id, path, t, v, ...(exists ? {} : { ease: 'ease' }) }, `调整关键帧：${name}`, {
        mergeKey: `insp:kf:${item.id}:${path}`,
        fallback: setKeyFb(t, v),
      });
    },
  };
}

// ---------------------- 滑杆：拖动、方向键、直接输入 ----------------------

const RANGE_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'];

/**
 * 属性面板滑杆（类名与通用 Slider 一致）：
 *   拖动或方向键调整，按住 Shift 十倍步长；点数值直接输入，回车确认、Esc 取消、↑↓ 微调；双击名称或滑杆恢复默认。
 *   一次连续调整（一次拖动 / 按住方向键）只提交一次；值没变不进历史；拖动中按 Esc 撤回到拖动前。
 * onChange：调整中持续触发（实时预览）；onCommit：调整结束且值有变化；onCancel：取消或没有变化（丢弃预览）。
 * format 可带 edit/parse/unit（见 inspValue.js 的 makeFormat），输入时按显示单位换算。
 */
export function InspSlider({
  label, value, min = -1, max = 1, step = 0.01, onChange, onCommit, onCancel, onReset, format, disabled, resetValue, keyframe, unit, hint,
}) {
  const [local, setLocal] = useState(value);
  const [draft, setDraft] = useState(null); // 数值输入框里的文字；null = 没在输入
  const gesture = useRef(null); // 一次连续调整：{ from: 调整前的值, cancelled: 已按 Esc 撤回 }
  const cur = useRef(Number(value) || 0); // 最新值（松手时读取）
  const pointer = useRef(false); // 鼠标按着滑杆
  const pointerCleanup = useRef(null);
  const editing = useRef(null); // 输入中：{ from, previewed: 用 ↑↓ 预览过 }
  const valueBtn = useRef(null);
  const refocus = useRef(false);
  useEffect(() => () => {
    if (pointerCleanup.current) { pointerCleanup.current(); pointerCleanup.current = null; }
  }, []);
  useEffect(() => {
    if (!gesture.current && !editing.current) { setLocal(value); cur.current = Number(value) || 0; }
  }, [value]);
  useEffect(() => {
    if (draft == null && refocus.current) { refocus.current = false; if (valueBtn.current) valueBtn.current.focus(); }
  }, [draft]);

  const num = Number(local) || 0;
  const name = typeof label === 'string' ? label : '';
  const dec = stepDecimals(step);
  const show = (v) => (format ? format(v) : `${trimNum(v, dec)}${unit || ''}`);
  const editText = (v) => (format && typeof format.edit === 'function' ? format.edit(v) : trimNum(v, Math.max(dec, 2)));
  const parseText = (text) => {
    const n = format && typeof format.parse === 'function' ? format.parse(text) : parseNum(text);
    return n == null || !Number.isFinite(n) ? null : n;
  };
  const editUnit = format ? (format.unit || '') : (unit || '');
  const shown = show(num);
  const canReset = !!onReset || resetValue != null;
  const isDefault = resetValue != null && nearlyEqual(num, resetValue);
  const pct = max > min ? ((clamp(num, min, max) - min) / (max - min)) * 100 : 0;

  const set = (v) => { cur.current = v; setLocal(v); if (onChange) onChange(v); };
  const begin = () => { if (!gesture.current) gesture.current = { from: cur.current, cancelled: false }; };
  const end = () => {
    const g = gesture.current;
    gesture.current = null;
    if (!g || g.cancelled) return;
    if (nearlyEqual(cur.current, g.from)) { if (onCancel) onCancel(); return; }
    if (onCommit) onCommit(cur.current);
  };
  const cancel = () => {
    const g = gesture.current;
    if (!g || g.cancelled) return false;
    g.cancelled = true;
    cur.current = g.from;
    setLocal(g.from);
    if (onCancel) onCancel();
    if (!pointer.current) gesture.current = null; // 键盘调整直接结束；拖动等松手
    return true;
  };
  const reset = () => {
    if (disabled) return;
    if (onReset) { onReset(); return; }
    if (resetValue == null || nearlyEqual(cur.current, resetValue)) return;
    gesture.current = null;
    begin();
    set(resetValue);
    end();
  };

  const onRangeChange = (e) => {
    if (gesture.current && gesture.current.cancelled) return; // 已按 Esc 撤回：松手前不再跟随
    begin();
    set(Number(e.target.value));
  };
  const onPointerDown = (e) => {
    if (disabled || (e.button != null && e.button !== 0)) return;
    if (pointerCleanup.current) { pointerCleanup.current(); pointerCleanup.current = null; }
    pointer.current = true;
    begin();
    const cleanup = () => {
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      pointer.current = false;
      pointerCleanup.current = null;
    };
    const up = () => {
      cleanup();
      end();
    };
    pointerCleanup.current = cleanup;
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  };
  const onRangeKeyDown = (e) => {
    if (e.key === 'Escape') { if (cancel()) { e.preventDefault(); e.stopPropagation(); } return; }
    if (!RANGE_KEYS.includes(e.key)) return;
    e.stopPropagation(); // 交给滑杆，不触发全局快捷键（逐帧移动、跳到开头/结尾）
    if (gesture.current && gesture.current.cancelled) { e.preventDefault(); return; }
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    begin();
    if (!dir) return; // PageUp/PageDown/Home/End 用浏览器自带行为，在 onChange 里预览
    e.preventDefault();
    set(nudge(cur.current, dir, step, e.shiftKey, min, max));
  };

  const startEdit = () => {
    if (disabled) return;
    editing.current = { from: cur.current, previewed: false };
    setDraft(editText(cur.current));
  };
  const finishEdit = (accept, back) => {
    const ed = editing.current;
    if (!ed) return;
    editing.current = null;
    refocus.current = !!back;
    const text = String(draft == null ? '' : draft);
    setDraft(null);
    const revert = () => { cur.current = ed.from; setLocal(ed.from); if (ed.previewed && onCancel) onCancel(); };
    if (!accept || !text.trim()) { revert(); return; }
    const n = parseText(text);
    if (n == null) { tip(`${name ? `「${name}」` : ''}请输入数字，例如 ${editText(ed.from)}`); revert(); return; }
    const v = clamp(n, min, max);
    cur.current = v;
    setLocal(v);
    if (!nearlyEqual(v, n)) tip(`${name ? `「${name}」` : ''}范围是 ${show(min)} 到 ${show(max)}，已按 ${show(v)} 处理`, 'info');
    if (nearlyEqual(v, ed.from)) { if (ed.previewed && onCancel) onCancel(); return; }
    if (onCommit) onCommit(v);
  };
  const onEditKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const text = String(draft == null ? '' : draft);
      if (text.trim() && parseText(text) == null) {
        tip(`${name ? `「${name}」` : ''}请输入数字，例如 ${editText(editing.current ? editing.current.from : num)}`);
        e.currentTarget.select();
        return;
      }
      finishEdit(true, true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finishEdit(false, true);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      const ed = editing.current;
      if (!ed) return;
      const n = parseText(String(draft == null ? '' : draft));
      const v = nudge(n == null ? cur.current : clamp(n, min, max), e.key === 'ArrowUp' ? 1 : -1, step, e.shiftKey, min, max);
      ed.previewed = true;
      setDraft(editText(v));
      set(v);
    }
  };

  return (
    <div className="slider-field">
      <div className="slider-head">
        <span className="label" title={hint || (canReset && !disabled ? '双击恢复默认' : undefined)} onDoubleClick={canReset ? reset : undefined}>{label}</span>
        {draft != null ? (
          <span className="slider-edit-wrap">
            <input
              className="slider-edit"
              value={draft}
              inputMode="decimal"
              spellCheck={false}
              autoFocus
              aria-label={`${name || '数值'}，回车确认，Esc 取消`}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onEditKeyDown}
              onBlur={() => finishEdit(true, false)}
            />
            {editUnit && <span className="slider-edit-unit">{editUnit}</span>}
          </span>
        ) : (
          <button
            type="button" ref={valueBtn} className={'slider-value' + (disabled ? '' : ' editable')} disabled={disabled} onClick={startEdit}
            title={disabled ? undefined : '点击输入数值'} aria-label={`${name || '数值'} ${shown}，点击输入数值`}
          >{shown}</button>
        )}
        {canReset && (
          <button type="button" className={'slider-reset' + (isDefault ? ' is-default' : '')} title="恢复默认" aria-label={`${name}恢复默认`} onClick={reset} disabled={disabled || isDefault}>
            <Icon name="reset" size={11} stroke={1.8} />
          </button>
        )}
        {keyframe && (
          <UI.KeyframeButton
            disabled={disabled} active={keyframe.active} hasKeys={keyframe.hasKeys} count={keyframe.count}
            label={keyframe.label || name} onToggle={keyframe.onToggle} onPrev={keyframe.onPrev} onNext={keyframe.onNext}
          />
        )}
      </div>
      <input
        type="range" className="slider" min={min} max={max} step={step} value={clamp(num, min, max)} disabled={disabled}
        aria-label={name || undefined} aria-valuetext={shown}
        style={{ '--pct': `${pct}%` }}
        onChange={onRangeChange}
        onPointerDown={onPointerDown}
        onKeyDown={onRangeKeyDown}
        onKeyUp={(e) => { if (RANGE_KEYS.includes(e.key)) end(); }}
        onBlur={() => { if (!pointer.current) end(); }}
        onDoubleClick={canReset ? reset : undefined}
      />
    </div>
  );
}

/**
 * 一个参数：滑杆（可直接输入、可复位）+ 可选关键帧（◆ 添加/删除，‹ › 跳到上/下一帧）。
 * 参数已有关键帧时，调整 = 修改播放头处的关键帧（没有就新建一个）；否则改了基础值画面也不会变。
 */
export function Param({ kf, ...slider }) {
  const k = useKf(kf);
  const keyEdit = useLiveEdit(kf && kf.item ? `${kf.target}:${kf.item.id}:${kf.path}` : '');
  const auto = !!(k && k.hasKeys && !slider.disabled);
  const keyed = auto ? {
    value: k.value,
    onChange: (v) => keyEdit.preview(k.previewAt(v)),
    onCommit: (v) => { keyEdit.restore(); k.commitAt(v); },
    onCancel: () => { keyEdit.restore(); },
    hint: `已有关键帧：调整会改播放头处的关键帧（没有就新建一个）`,
  } : null;
  return (
    <div className={'insp-param' + (k ? ' with-kf' : '') + (k && k.hasKeys ? ' animated' : '')}>
      <InspSlider {...slider} {...keyed} keyframe={k} />
    </div>
  );
}

/** 子页切换（属性面板内的二级页签）：←/→/Home/End 切换，焦点跟着走 */
export function SubPages({ pages, value, onChange }) {
  const refs = useRef([]);
  const cur = pages.some((p) => p.id === value) ? value : (pages[0] && pages[0].id);
  const onKey = (e, i) => {
    let j = -1;
    if (e.key === 'ArrowRight') j = (i + 1) % pages.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + pages.length) % pages.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = pages.length - 1;
    if (j < 0) return;
    e.preventDefault();
    e.stopPropagation();
    onChange(pages[j].id);
    const el = refs.current[j];
    if (el) el.focus();
  };
  return (
    <div className="insp-pages" role="tablist" aria-label="属性分类">
      {pages.map((p, i) => {
        const on = cur === p.id;
        return (
          <button
            key={p.id} ref={(el) => { refs.current[i] = el; }} type="button" role="tab" aria-selected={on} tabIndex={on ? 0 : -1}
            className={'insp-page' + (on ? ' on' : '')} onClick={() => onChange(p.id)} onKeyDown={(e) => onKey(e, i)}
          >
            {p.icon && <UI.Icon name={p.icon} size={14} />}<span>{p.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 记住每类对象上次停留的子页 */
export function usePage(kind, def) {
  const [page, setPage] = useState(() => readPref('insp.page.' + kind, def));
  return [page, (p) => { setPage(p); writePref('insp.page.' + kind, p); }];
}

/** 卡片式选项网格（预设/动画/曲线） */
export function ChoiceGrid({ options, value, onPick, disabled, cols = 3 }) {
  return (
    <div className="insp-choices" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {options.map((o) => (
        <button key={o.value} type="button" disabled={disabled} className={'insp-choice' + (value === o.value ? ' on' : '')} onClick={() => onPick(o.value)} title={o.hint || o.label} aria-pressed={value === o.value}>
          {o.preview && <span className="insp-choice-pv">{o.preview}</span>}
          <span className="insp-choice-label">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/** 提交一组 op（仅当引擎明确报错未知/不支持的操作时走 fallback 兜底），返回结果 */
export function runOps(ops, label, { mergeKey, fallback, silent } = {}) {
  if (ops.length === 1) return runOp(ops[0], label, { mergeKey, fallback, silent });
  const st = useStore.getState();
  if (!st.project) return { ok: false, applied: [], errors: ['没有打开的项目'] };
  const quiet = !!fallback || !!silent;
  let r = null;
  try { r = st.commit(ops, label, { mergeKey, silent: quiet }); }
  catch (e) { r = { ok: false, applied: [], errors: [(e && e.message) || '操作失败'] }; }
  if (fallback && isUnsupportedOpResult(r)) {
    return st.commit(fallback, label, { mergeKey, silent });
  }
  if (r && r.ok === false && fallback && !silent) {
    st.toast(`未修改：${(r.errors || []).join('；') || '操作无效'}`, 'error');
  }
  return r || { ok: false, applied: [], errors: ['操作无效'] };
}

/**
 * 编辑器钩子：make(v) => { ops:[...], fb:(project)=>project }
 * bind(make,label) 用于滑杆：拖动时用 fb 实时预览，松手一次提交；连续调整同一对象的同一参数合并成一步撤销
 * （mergeKey 带上对象 id，换了对象不会被合并）；没改动或按 Esc 取消时丢弃预览，不进历史。
 * now(make(v),label[,mergeKey]) 立即提交。
 */
export function useEdit(resetKey) {
  const live = useLiveEdit(resetKey);
  const now = useCallback(({ ops, fb }, label, mergeKey) => { live.restore(); return runOps(ops, label, { mergeKey, fallback: fb }); }, [live]);
  const bind = useCallback((make, label) => ({
    onChange: (v) => live.preview(make(v).fb),
    onCommit: (v) => now(make(v), label, `insp:${resetKey}:${label}`),
    onCancel: () => { live.restore(); },
  }), [live, now, resetKey]);
  return { live, now, bind };
}
