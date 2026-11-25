// Top bar: brand + project name + project menu + save state (left); mode switcher (center);
// undo/redo, language toggle, help, settings, and export action (right).
import React, { Suspense, lazy, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import useStore from '../store.js';
import api from '../api.js';
import { getLocale, normalizeLocale, setLocale, t, useLocale, useT } from '../i18n.js';
import { Icon, Button, Tooltip, Menu, ICON_NAMES } from './ui.jsx';

// ---------------------------------------------------------------------------
// Brand Logo
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
      {/* Viewfinder corners */}
      <path d="M7 11V8.5A1.5 1.5 0 018.5 7H11M21 7h2.5A1.5 1.5 0 0125 8.5V11M25 21v2.5a1.5 1.5 0 01-1.5 1.5H21M11 25H8.5A1.5 1.5 0 017 23.5V21" fill="none" style={{ stroke: 'var(--text-2)' }} strokeWidth="1.4" strokeLinecap="round" />
      {/* Flowing ribbons */}
      <path d="M8.5 18.2c2.4-3.6 4.8-3.6 7.2 0s4.9 3.6 7.8-.4" fill="none" stroke={`url(#${gid}a)`} strokeWidth="2.6" strokeLinecap="round" />
      <path d="M8.5 13.6c2.4-3.2 4.8-3.2 7.2 0s4.9 3.2 7.8-.3" fill="none" stroke={`url(#${gid}a)`} strokeWidth="1.6" strokeLinecap="round" opacity="0.45" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Project Thumbnail (rendered asynchronously when returning home; silent fail)
// ---------------------------------------------------------------------------
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);
}

/**
 * Render a single JPEG frame (dataURL) from the compositor. Returns '' on failure.
 * Shared by home-page project thumbnails and export completion previews.
 * @param {object} project
 * @param {{ maxSide?: number, at?: number, quality?: number }} [opts]
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
    const frameTime = Number.isFinite(at) ? Math.max(0, Math.min(at, dur - 0.05)) : Math.max(0, Math.min(dur * 0.3, 3, dur - 0.05));
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
    try { await withTimeout(pool.seekExact(project, frameTime, layout), 6000); } catch { /* render placeholder if media seek fails */ }
    compositor.renderFrame(ctx, project, frameTime, pool, { width: w, height: h, layout, mode: 'export', frameIndex: Math.round(frameTime * fps) });
    return canvas.toDataURL('image/jpeg', quality);
  } catch (e) {
    console.warn('[thumb] renderProjectFrame failed', e);
    return '';
  } finally {
    try { if (pool) pool.dispose(); } catch { /* ignore */ }
  }
}

/** Render and persist a thumbnail for the project. Returns whether it succeeded. */
export async function captureProjectThumb(project) {
  if (!project || !project.id) return false;
  if (!api.available) return false;
  try {
    const dataUrl = await renderProjectFrame(project, { maxSide: 480 });
    if (!dataUrl) return false;
    await api.call('project:saveThumb', { id: project.id, dataUrl });
    return true;
  } catch (e) {
    console.warn('[thumb] captureProjectThumb failed', e);
    return false;
  }
}

/**
 * Save and return to the Start Page (updating thumbnail asynchronously afterwards).
 * If closeProject fails to save, it returns false and shows a force-close prompt.
 * @returns {Promise<boolean>}
 */
export async function goHome() {
  const st = useStore.getState();
  const project = st.project;
  st.setPlaying(false);
  let closed;
  try {
    closed = await st.closeProject();
  } catch (e) {
    st.toast(t('top.goHomeSaveFailed', { error: (e && e.message) || String(e) }), 'error');
    return false;
  }
  if (closed === false || useStore.getState().project) return false;
  if (project) {
    captureProjectThumb(project).then((ok) => { if (ok) useStore.getState().refreshProjects(); });
  }
  return true;
}

// ---------------------------------------------------------------------------
// AI Status (provider-neutral: APIs, multi-Agent CLIs, MCP, or local rules)
// ---------------------------------------------------------------------------
const PROVIDER_KEY_MAP = {
  openai: 'top.aiProvider.openai',
  api: 'top.aiProvider.openai',
  anthropic: 'top.aiProvider.anthropic',
  gemini: 'top.aiProvider.geminiCli',
  deepseek: 'top.aiProvider.deepseek',
  openrouter: 'top.aiProvider.openrouter',
  ollama: 'top.aiProvider.ollama',
  codex: 'top.aiProvider.codex',
  claude: 'top.aiProvider.claude',
  'claude-code': 'top.aiProvider.claude',
  'gemini-cli': 'top.aiProvider.geminiCli',
  cli: 'top.aiProvider.cli',
  mcp: 'top.aiProvider.mcp',
};

const API_PRESET_KEY_MAP = {
  openai: 'top.aiProvider.openai',
  anthropic: 'top.aiProvider.anthropic',
  gemini: 'top.aiProvider.gemini',
  deepseek: 'top.aiProvider.deepseek',
  openrouter: 'top.aiProvider.openrouter',
  ollama: 'top.aiProvider.ollama',
};

const CLI_PROVIDERS = new Set(['codex', 'claude', 'claude-code', 'gemini', 'gemini-cli', 'cli']);

function providerDisplayName(ai, loc) {
  if (ai && ai.providerLabel) return String(ai.providerLabel);
  const resolvedLoc = loc ? normalizeLocale(loc) : getLocale();
  const p = String((ai && ai.provider) || '').trim().toLowerCase();
  if (p === 'openai' || p === 'api') {
    const preset = String((ai && (ai.preset || (ai.api && ai.api.preset))) || '').trim().toLowerCase();
    if (preset === 'lmstudio') return 'LM Studio';
    if (preset === 'ark') return resolvedLoc === 'en-US' ? 'Volcengine Ark' : '火山方舟';
    if (preset && API_PRESET_KEY_MAP[preset]) return t(API_PRESET_KEY_MAP[preset], null, resolvedLoc);
  }
  if (p === 'lmstudio') return 'LM Studio';
  if (p === 'ark') return resolvedLoc === 'en-US' ? 'Volcengine Ark' : '火山方舟';
  const k = PROVIDER_KEY_MAP[p];
  return k ? t(k, null, resolvedLoc) : (ai && ai.provider) || 'AI';
}

export function describeAI(ai, localeOverride = null) {
  if (!ai) {
    return {
      kind: '',
      label: t('top.aiChecking', null, localeOverride),
      title: t('top.aiCheckingTitle', null, localeOverride),
    };
  }
  const detail = ai.detail ? `\n${ai.detail}` : '';
  const p = String(ai.provider || '').toLowerCase();
  const isLocal = !p || p === 'local' || p === 'none';

  if (!isLocal && ai.ready) {
    const loc = localeOverride ? normalizeLocale(localeOverride) : getLocale();
    const name = providerDisplayName(ai, loc);
    const model = ai.model ? (loc === 'en-US' ? ` (${ai.model})` : `（${ai.model}）`) : '';
    const isCli = CLI_PROVIDERS.has(p) || p === 'mcp';
    return {
      kind: isCli ? 'ai' : 'info',
      label: isCli ? t('top.aiConnected', null, loc) : name,
      title: t('top.aiReadyTitle', { name, model, detail }, loc),
    };
  }
  if (!isLocal) {
    const name = providerDisplayName(ai, localeOverride);
    return {
      kind: 'warn',
      label: t('top.aiNotReady', { name }, localeOverride),
      title: t('top.aiNotReadyTitle', { name, detail }, localeOverride),
    };
  }
  return {
    kind: 'warn',
    label: t('top.aiLocal', null, localeOverride),
    title: t('top.aiLocalTitle', { detail }, localeOverride),
  };
}

// ---------------------------------------------------------------------------
// Language Quick-Toggle (1-click zh-CN <-> en-US, persisted via settings:set)
// ---------------------------------------------------------------------------
export function LocaleToggle() {
  const locale = useLocale();
  const tr = useT();
  const nextLocale = locale === 'zh-CN' ? 'en-US' : 'zh-CN';

  const onToggle = () => {
    setLocale(nextLocale);
    const cur = useStore.getState().settings;
    useStore.setState({ settings: { ...(cur || {}), ui: { ...((cur && cur.ui) || {}), locale: nextLocale } } });
    api.call('settings:set', { ui: { locale: nextLocale } }).catch(() => {});
  };

  return (
    <Tooltip label={tr('top.langSwitchTitle')} desc={tr('top.langSwitchDesc')}>
      <button
        type="button"
        className="btn ghost sm tb-lang"
        onClick={onToggle}
        aria-label={tr('top.langSwitchAria')}
        data-testid="locale-toggle"
        style={{ padding: '0 7px', fontSize: 'var(--fs-11, 11px)', fontWeight: 600, letterSpacing: '0.02em', gap: 1 }}
      >
        <span style={{ opacity: locale === 'zh-CN' ? 1 : 0.45 }}>中</span>
        <span style={{ opacity: 0.35 }}>/</span>
        <span style={{ opacity: locale === 'en-US' ? 1 : 0.45 }}>EN</span>
      </button>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Save State Indicator
// ---------------------------------------------------------------------------
function fmtClock(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function SaveState() {
  const tr = useT();
  const saveState = useStore((s) => s.saveState);
  const lastSavedAt = useStore((s) => s.lastSavedAt);
  const saveNow = useStore((s) => s.saveNow);
  const map = {
    saved: { cls: 'ok', label: tr('top.save.saved'), icon: 'check', title: lastSavedAt ? tr('top.save.savedAt', { time: fmtClock(lastSavedAt) }) : tr('top.save.savedAll') },
    saving: { cls: 'saving', label: tr('top.save.saving'), icon: null, title: tr('top.save.savingTitle') },
    dirty: { cls: 'dirty', label: tr('top.save.dirty'), icon: null, title: tr('top.save.dirtyTitle') },
    error: { cls: 'error', label: tr('top.save.error'), icon: 'refresh', title: tr('top.save.errorTitle') },
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
// Project Name (click to inline-rename)
// ---------------------------------------------------------------------------
function ProjectName() {
  const tr = useT();
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
        aria-label={tr('top.projectNameAria')}
      />
    );
  }
  return (
    <button type="button" className="tb-name" title={tr('top.projectNameTitle')} onClick={() => setEditing(true)}>
      <span className="ellipsis">{name || tr('app.untitledProject')}</span>
      <svg className="tb-name-pen" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" /></svg>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Mode Switcher
// ---------------------------------------------------------------------------
export const MODES = [
  { value: 'create', label: '创作', labelKey: 'app.mode.create', icon: 'sparkles', key: '1', desc: '和 AI 导演聊想法，生成分镜与实拍画面', descKey: 'top.mode.createDesc' },
  { value: 'refine', label: '精修', labelKey: 'app.mode.refine', icon: 'scissors', key: '2', desc: '在时间线上剪辑、调色、加字幕和音乐', descKey: 'top.mode.refineDesc' },
  { value: 'library', label: '拆片库', labelKey: 'app.mode.library', icon: 'book', key: '3', desc: '拆解优秀视频，沉淀可复用的技法', descKey: 'top.mode.libraryDesc' },
];

function ModeSwitch() {
  const tr = useT();
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  return (
    <nav className="mode-switch" role="tablist" aria-label={tr('top.modeSwitchAria')}>
      {MODES.map((m) => {
        const label = tr(m.labelKey);
        return (
          <Tooltip key={m.value} label={tr('top.modeLabelWithSuffix', { label })} desc={tr(m.descKey)} kbd={`Ctrl+${m.key}`}>
            <button
              type="button"
              role="tab"
              aria-selected={mode === m.value}
              className={'mode-btn' + (mode === m.value ? ' active' : '')}
              onClick={() => setMode(m.value)}
              data-mode={m.value}
            >
              <Icon name={m.icon} size={15} />
              <span>{label}</span>
            </button>
          </Tooltip>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Project Menu (Version History, Save Now, Return Home)
// ---------------------------------------------------------------------------
const iconOr = (name, fallback) => (ICON_NAMES.includes(name) ? name : fallback);

function ProjectMenu() {
  const tr = useT();
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
    const timer = setTimeout(() => { const first = menuRef.current && menuRef.current.querySelector('.menu-item'); if (first) first.focus(); }, 0);
    return () => {
      clearTimeout(timer);
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
    { id: 'history', label: tr('top.menu.history'), icon: iconOr('history', 'clock'), onClick: () => openDialog('versionHistory') },
    { id: 'save', label: tr('top.menu.saveNow'), icon: iconOr('save', 'check'), kbd: 'Ctrl+S', onClick: () => saveNow() },
    { sep: true },
    { id: 'home', label: tr('top.menu.goHome'), icon: 'home', onClick: () => { goHome(); } },
  ];

  return (
    <>
      <Tooltip label={tr('top.menu.label')} desc={tr('top.menu.desc')}>
        <button
          ref={btnRef}
          type="button"
          className={'tb-proj-more' + (open ? ' open' : '')}
          aria-label={tr('top.menu.label')}
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

/** Lazy-loaded Version History modal host. */
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
// Top Bar
// ---------------------------------------------------------------------------
export default function TopBar({ standalone = false, onExitStandalone }) {
  const tr = useT();
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
  // Single primary CTA per screen: Export is primary in Refine mode, secondary in Create mode.
  const exportPrimary = mode === 'refine';

  return (
    <header className="topbar">
      <div className="tb-left">
        <Tooltip label={standalone ? tr('top.goHome') : tr('top.saveAndGoHome')}>
          <button type="button" className="tb-brand" onClick={onHome} disabled={leaving} aria-label={tr('top.goHome')}>
            <Logo size={24} />
            <Icon name="home" size={14} className="tb-brand-home" />
          </button>
        </Tooltip>
        {standalone ? (
          <div className="tb-standalone-title"><Icon name="book" size={14} /> {tr('app.mode.library')}<span className="muted xs">{tr('top.standaloneNoProject')}</span></div>
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
            <Button variant="icon" icon="undo" tip={undoLabel ? tr('top.undo', { label: undoLabel }) : tr('top.undoEmpty')} kbd="Ctrl+Z" onClick={() => undo()} disabled={!undoLabel} />
            <Button variant="icon" icon="redo" tip={redoLabel ? tr('top.redo', { label: redoLabel }) : tr('top.redoEmpty')} kbd="Ctrl+Shift+Z" onClick={() => redo()} disabled={!redoLabel} />
          </div>
        )}
        <LocaleToggle />
        <Button variant="icon" icon="help" tip={tr('top.help')} kbd="F1" onClick={() => openDialog('help')} />
        <Button variant="icon" icon="settings" tip={tr('top.settings')} kbd="Ctrl+," onClick={() => openDialog('settings')} />
        {inProject && (
          <Tooltip label={tr('top.exportTip')} desc={tr('top.exportDesc')} kbd="Ctrl+E">
            <Button variant={exportPrimary ? 'primary' : 'secondary'} icon="export" className="tb-export" onClick={() => openDialog('export')} data-tour="export">{tr('top.export')}</Button>
          </Tooltip>
        )}
      </div>
      {inProject && <VersionHistoryHost />}
    </header>
  );
}
