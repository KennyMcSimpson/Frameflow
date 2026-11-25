// 顶栏（PLAN-v3 §6）：左 Logo+项目名+项目菜单+保存状态；中 三模式切换；右 撤销/重做、帮助、设置、「导出」（精修模式下是唯一主按钮）。AI 状态与任务在 StatusBar。
import React, { Suspense, lazy, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import useStore from '../store.js';
import api from '../api.js';
import { Icon, Button, Tooltip, Menu, ICON_NAMES } from './ui.jsx';

// ---------------------------------------------------------------------------
// 品牌标
// ---------------------------------------------------------------------------
export function Logo({ size = 26, className = '' }) {
  const raw = useId();
  const gid = 'fflogo' + String(raw).replace(/[^a-zA-Z0-9_-]/g, '');
  return (
    <svg className={'ff-logo ' + className} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id={gid + 'a'} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--accent-hover)' }} />
          <stop offset="1" style={{ stopColor: 'var(--accent)' }} />
        </linearGradient>
        <linearGradient id={gid + 'b'} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--bg-3)' }} />
          <stop offset="1" style={{ stopColor: 'var(--bg-1)' }} />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${gid}b)`} style={{ stroke: 'var(--line-2)' }} strokeWidth="1" />
      {/* 取景框四角 */}
      <path d="M7 11V8.5A1.5 1.5 0 018.5 7H11M21 7h2.5A1.5 1.5 0 0125 8.5V11M25 21v2.5a1.5 1.5 0 01-1.5 1.5H21M11 25H8.5A1.5 1.5 0 017 23.5V21" fill="none" style={{ stroke: 'var(--text-2)' }} strokeWidth="1.4" strokeLinecap="round" />
      {/* 流动的光带 */}
      <path d="M8.5 18.2c2.4-3.6 4.8-3.6 7.2 0s4.9 3.6 7.8-.4" fill="none" stroke={`url(#${gid}a)`} strokeWidth="2.6" strokeLinecap="round" />
      <path d="M8.5 13.6c2.4-3.2 4.8-3.2 7.2 0s4.9 3.2 7.8-.3" fill="none" stroke={`url(#${gid}a)`} strokeWidth="1.6" strokeLinecap="round" opacity="0.45" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// 项目缩略图（返回首页时异步生成，失败静默）
// ---------------------------------------------------------------------------
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);
}

/**
 * 用合成器把项目某一刻画成一张 JPEG（dataURL）。失败返回 ''。
 * 返回首页的项目缩略图、导出完成页的成片预览都用它。
 * @param {object} project
 * @param {{ maxSide?: number, at?: number, quality?: number }} [opts] at 缺省取 30% 处（最多 3 秒）
 */
export async function renderProjectFrame(project, { maxSide = 480, at, quality = 0.82 } = {}) {
  if (!project || !project.tracks || !Array.isArray(project.tracks.video) || !project.tracks.video.length) return '';
  let pool = null;
  try {
    const [compositor, mediaPool, timeline] = await Promise.all([
      import('../../render/compositor.js'),
      import('../../render/mediaPool.js'),
      import('../../engine/timeline.js'),
    ]);
    const layout = timeline.layoutVideo(project);
    const dur = timeline.projectDuration(project, layout);
    if (!(dur > 0)) return '';
    const t = Number.isFinite(at) ? Math.max(0, Math.min(at, dur - 0.05)) : Math.max(0, Math.min(dur * 0.3, 3, dur - 0.05));
    const W = (project.settings && project.settings.width) || 1920;
    const H = (project.settings && project.settings.height) || 1080;
    const fps = Math.max(1, Number(project.settings && project.settings.fps) || 30);
    const k = maxSide / Math.max(W, H);
    const w = Math.max(2, Math.round(W * k));
    const h = Math.max(2, Math.round(H * k));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    pool = mediaPool.createMediaPool({ mediaUrl: (p) => api.mediaUrl(p) });
    try { await withTimeout(pool.seekExact(project, t, layout), 6000); } catch { /* 素材加载失败也继续画（会显示占位） */ }
    // 帧序号按项目自己的帧率算（粒子、噪点等逐帧效果依赖它）
    compositor.renderFrame(ctx, project, t, pool, { width: w, height: h, layout, mode: 'export', frameIndex: Math.round(t * fps) });
    return canvas.toDataURL('image/jpeg', quality);
  } catch (e) {
    console.warn('[thumb] 渲染项目画面失败', e);
    return '';
  } finally {
    try { if (pool) pool.dispose(); } catch { /* 忽略 */ }
  }
}

/** 用合成器为项目画一张缩略图并保存。返回是否成功。 */
export async function captureProjectThumb(project) {
  if (!project || !project.id) return false;
  if (!api.available) return false;
  try {
    const dataUrl = await renderProjectFrame(project, { maxSide: 480 });
    if (!dataUrl) return false;
    await api.call('project:saveThumb', { id: project.id, dataUrl });
    return true;
  } catch (e) {
    console.warn('[thumb] 生成项目缩略图失败', e);
    return false;
  }
}

/**
 * 保存并返回首页（之后异步更新缩略图）。
 * 契约 C14：closeProject 保存失败时返回 false 并自己弹「仍然关闭」提示，这时留在项目里。
 * @returns {Promise<boolean>} 是否真的回到了首页
 */
export async function goHome() {
  const st = useStore.getState();
  const project = st.project;
  st.setPlaying(false);
  let closed;
  try {
    closed = await st.closeProject();
  } catch (e) {
    st.toast('返回首页时保存失败：' + (e?.message || e) + '。项目仍保持打开，请检查磁盘空间后再试', 'error');
    return false;
  }
  if (closed === false || useStore.getState().project) return false;
  if (project) {
    captureProjectThumb(project).then((ok) => { if (ok) useStore.getState().refreshProjects(); });
  }
  return true;
}

// ---------------------------------------------------------------------------
// AI 状态
// ---------------------------------------------------------------------------
export function describeAI(ai) {
  if (!ai) return { kind: '', label: 'AI 检测中…', title: '正在检测可用的 AI 引擎' };
  const detail = ai.detail ? `\n${ai.detail}` : '';
  if (ai.provider === 'codex' && ai.ready) return { kind: 'ai', label: 'Codex 已就绪', title: `AI 引擎：本机 Codex CLI${ai.model ? `（${ai.model}）` : ''}${detail}\n点击打开 AI 设置` };
  if (ai.provider === 'openai' && ai.ready) return { kind: 'info', label: 'OpenAI API', title: `AI 引擎：OpenAI 兼容接口${ai.model ? `（${ai.model}）` : ''}${detail}\n点击打开 AI 设置` };
  if (ai.provider === 'codex') return { kind: 'warn', label: 'Codex 未就绪', title: `Codex 暂不可用，当前使用本地规则${detail}\n点击打开 AI 设置` };
  if (ai.provider === 'openai') return { kind: 'warn', label: 'API 未就绪', title: `OpenAI 接口暂不可用，当前使用本地规则${detail}\n点击打开 AI 设置` };
  return { kind: 'warn', label: '本地规则', title: `未连接 AI，使用本地规则（中文指令解析、模板分镜、统计拆片）${detail}\n点击打开设置连接 Codex 或 API` };
}

// ---------------------------------------------------------------------------
// 保存状态
// ---------------------------------------------------------------------------
function fmtClock(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function SaveState() {
  const saveState = useStore((s) => s.saveState);
  const lastSavedAt = useStore((s) => s.lastSavedAt);
  const saveNow = useStore((s) => s.saveNow);
  const map = {
    saved: { cls: 'ok', label: '已保存', icon: 'check', title: lastSavedAt ? `最近保存于 ${fmtClock(lastSavedAt)}` : '所有修改都已保存' },
    saving: { cls: 'saving', label: '保存中…', icon: null, title: '正在写入磁盘' },
    dirty: { cls: 'dirty', label: '未保存', icon: null, title: '有修改即将自动保存，点击立即保存（Ctrl+S）' },
    error: { cls: 'error', label: '保存失败', icon: 'refresh', title: '保存失败，点击重试（Ctrl+S）' },
  };
  const m = map[saveState] || map.saved;
  return (
    <button type="button" className={'tb-save ' + m.cls} title={m.title} onClick={() => saveNow()} disabled={saveState === 'saving'}>
      {saveState === 'saving' ? <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} /> : m.icon ? <Icon name={m.icon} size={12} stroke={2.2} /> : <span className="tb-save-dot" />}
      <span>{m.label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// 项目名（点击编辑）
// ---------------------------------------------------------------------------
function ProjectName() {
  const name = useStore((s) => (s.project ? s.project.name : ''));
  const update = useStore((s) => s.update);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const inputRef = useRef(null);

  useEffect(() => { if (!editing) setValue(name); }, [name, editing]);
  useEffect(() => { if (editing && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); } }, [editing]);

  const commit = () => {
    const v = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    setEditing(false);
    if (!v) { setValue(name); return; }
    if (v !== name) update((p) => ({ ...p, name: v }));
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="tb-name-input input"
        value={value}
        maxLength={60}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setValue(name); setEditing(false); }
        }}
        aria-label="项目名称"
      />
    );
  }
  return (
    <button type="button" className="tb-name" title="点击修改项目名称" onClick={() => setEditing(true)}>
      <span className="ellipsis">{name || '未命名项目'}</span>
      <svg className="tb-name-pen" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" /></svg>
    </button>
  );
}

// ---------------------------------------------------------------------------
// 模式切换
// ---------------------------------------------------------------------------
export const MODES = [
  { value: 'create', label: '创作', icon: 'sparkles', key: '1', desc: '和 AI 导演聊想法，生成分镜与实拍画面' },
  { value: 'refine', label: '精修', icon: 'scissors', key: '2', desc: '在时间线上剪辑、调色、加字幕和音乐' },
  { value: 'library', label: '拆片库', icon: 'book', key: '3', desc: '拆解优秀视频，沉淀可复用的技法' },
];

function ModeSwitch() {
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  return (
    <nav className="mode-switch" role="tablist" aria-label="工作模式">
      {MODES.map((m) => (
        <Tooltip key={m.value} label={`${m.label}模式`} desc={m.desc} kbd={`Ctrl+${m.key}`}>
          <button
            type="button"
            role="tab"
            aria-selected={mode === m.value}
            className={'mode-btn' + (mode === m.value ? ' active' : '')}
            onClick={() => setMode(m.value)}
            data-mode={m.value}
          >
            <Icon name={m.icon} size={15} />
            <span>{m.label}</span>
          </button>
        </Tooltip>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// 项目菜单（项目名旁的 ⋯）：历史版本、立即保存、返回首页
// ---------------------------------------------------------------------------
/** 新图标还没进图标库时用旧图标兜底（契约 C2 的新名字由 design 包补齐） */
const iconOr = (name, fallback) => (ICON_NAMES.includes(name) ? name : fallback);

function ProjectMenu() {
  const openDialog = useStore((s) => s.openDialog);
  const saveNow = useStore((s) => s.saveNow);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    const onDown = (e) => {
      if ((menuRef.current && menuRef.current.contains(e.target)) || (btnRef.current && btnRef.current.contains(e.target))) return;
      close();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); if (btnRef.current) btnRef.current.focus(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = menuRef.current ? [...menuRef.current.querySelectorAll('.menu-item:not(:disabled)')] : [];
        if (!items.length) return;
        e.preventDefault();
        const i = items.indexOf(document.activeElement);
        const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
        items[next].focus();
      }
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    // 打开后把焦点放到第一项，键盘可直接上下选择
    const t = setTimeout(() => { const first = menuRef.current && menuRef.current.querySelector('.menu-item'); if (first) first.focus(); }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [open]);

  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ left: Math.max(8, r.left - 4), top: r.bottom + 6 });
    }
    setOpen((v) => !v);
  };

  const items = [
    { id: 'history', label: '历史版本…', icon: iconOr('history', 'clock'), onClick: () => openDialog('versionHistory') },
    { id: 'save', label: '立即保存', icon: iconOr('save', 'check'), kbd: 'Ctrl+S', onClick: () => saveNow() },
    { sep: true },
    { id: 'home', label: '保存并返回首页', icon: 'home', onClick: () => { goHome(); } },
  ];

  return (
    <>
      <Tooltip label="项目菜单" desc="历史版本、立即保存、返回首页">
        <button
          ref={btnRef}
          type="button"
          className={'tb-proj-more' + (open ? ' open' : '')}
          aria-label="项目菜单"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggle}
          data-testid="project-menu"
        >
          <Icon name="chevronDown" size={14} />
        </button>
      </Tooltip>
      {open && pos && typeof document !== 'undefined' && createPortal(
        <div ref={menuRef} className="tb-proj-menu" style={{ left: pos.left, top: pos.top }}>
          <Menu items={items} onClose={() => setOpen(false)} />
        </div>,
        document.body,
      )}
    </>
  );
}

/** 历史版本对话框（契约 C6）：dialogs.versionHistory 为真时挂到 body 上，懒加载 */
const VersionHistoryDialog = lazy(() => import('../dialogs/VersionHistoryDialog.jsx'));

function VersionHistoryHost() {
  const open = useStore((s) => !!(s.dialogs && s.dialogs.versionHistory));
  const hasProject = useStore((s) => !!s.project);
  const closeDialog = useStore((s) => s.closeDialog);
  if (!open || !hasProject || typeof document === 'undefined') return null;
  return createPortal(
    <Suspense fallback={null}>
      <VersionHistoryDialog onClose={() => closeDialog('versionHistory')} />
    </Suspense>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// 顶栏
// ---------------------------------------------------------------------------
export default function TopBar({ standalone = false, onExitStandalone }) {
  const project = useStore((s) => s.project);
  const mode = useStore((s) => s.mode);
  const undoLabel = useStore((s) => (s.past.length ? s.past[s.past.length - 1].label : ''));
  const redoLabel = useStore((s) => (s.future.length ? s.future[0].label : ''));
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const openDialog = useStore((s) => s.openDialog);
  const [leaving, setLeaving] = useState(false);

  const onHome = async () => {
    if (standalone) { if (onExitStandalone) onExitStandalone(); return; }
    if (leaving) return;
    setLeaving(true);
    try { await goHome(); } finally { setLeaving(false); }
  };

  const inProject = !standalone && !!project;
  // 一屏只有一个主按钮：「导出」只在精修模式做主按钮，创作模式让位给「生成全部画面 / 进入剪辑」
  const exportPrimary = mode === 'refine';

  return (
    <header className="topbar">
      <div className="tb-left">
        <Tooltip label={standalone ? '返回首页' : '保存并返回首页'}>
          <button type="button" className="tb-brand" onClick={onHome} disabled={leaving} aria-label="返回首页">
            <Logo size={24} />
            <Icon name="home" size={14} className="tb-brand-home" />
          </button>
        </Tooltip>
        {standalone ? (
          <div className="tb-standalone-title"><Icon name="book" size={14} /> 拆片库<span className="muted xs">（未打开项目）</span></div>
        ) : project ? (
          <div className="tb-project">
            <ProjectName />
            <ProjectMenu />
            <SaveState />
          </div>
        ) : null}
      </div>

      <div className="tb-center">
        {inProject && <ModeSwitch />}
      </div>

      <div className="tb-right">
        {inProject && (
          <div className="tb-group">
            <Button variant="icon" icon="undo" tip={undoLabel ? `撤销：${undoLabel}` : '没有可撤销的操作'} kbd="Ctrl+Z" onClick={() => undo()} disabled={!undoLabel} />
            <Button variant="icon" icon="redo" tip={redoLabel ? `重做：${redoLabel}` : '没有可重做的操作'} kbd="Ctrl+Shift+Z" onClick={() => redo()} disabled={!redoLabel} />
          </div>
        )}
        <Button variant="icon" icon="help" tip="帮助与快捷键" kbd="F1" onClick={() => openDialog('help')} />
        <Button variant="icon" icon="settings" tip="设置" kbd="Ctrl+," onClick={() => openDialog('settings')} />
        {inProject && (
          <Tooltip label="导出成片" desc="选择抖音 / B站 / 4K 等预设" kbd="Ctrl+E">
            <Button variant={exportPrimary ? 'primary' : 'secondary'} icon="export" className="tb-export" onClick={() => openDialog('export')} data-tour="export">导出</Button>
          </Tooltip>
        )}
      </div>
      {inProject && <VersionHistoryHost />}
    </header>
  );
}