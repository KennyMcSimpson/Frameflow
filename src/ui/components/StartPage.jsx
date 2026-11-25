// Start Page: welcome hero, 3-step workflow overview, environment notices, and recent projects.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import useStore from '../store.js';
import api from '../api.js';
import { t, useLocale, useT } from '../i18n.js';
import { Icon, Button, Modal, Spinner, ProgressBar, fmtTime } from './ui.jsx';
import { Logo, LocaleToggle } from './TopBar.jsx';
import { createSampleProject } from '../../engine/sample.js';
import { buildFirstCut } from '../../engine/firstcut.js';
import { isLocalOnlyAI } from '../modes/create/createUtils.js';

export function relativeTime(iso, localeOverride = null) {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return '';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return t('start.time.justNow', null, localeOverride);
  if (min < 60) return t('start.time.minsAgo', { n: min }, localeOverride);
  const hour = Math.floor(min / 60);
  if (hour < 24) return t('start.time.hoursAgo', { n: hour }, localeOverride);
  const day = Math.floor(hour / 24);
  if (day === 1) return t('start.time.yesterday', null, localeOverride);
  if (day < 7) return t('start.time.daysAgo', { n: day }, localeOverride);
  if (day < 30) return t('start.time.weeksAgo', { n: Math.floor(day / 7) }, localeOverride);
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function safeFileName(name, fallback) {
  return String(name || fallback).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 80) || fallback;
}

// ---------------------------------------------------------------------------
// 3-Step Workflow Overview
// ---------------------------------------------------------------------------
const STEPS = [
  { n: 1, icon: 'chat', titleKey: 'start.step1.title', descKey: 'start.step1.desc', demoKey: 'start.step1.demo', tone: 'accent' },
  { n: 2, icon: 'camera', titleKey: 'start.step2.title', descKey: 'start.step2.desc', demoKey: 'start.step2.demo', tone: 'violet' },
  { n: 3, icon: 'wand', titleKey: 'start.step3.title', descKey: 'start.step3.desc', demoKey: 'start.step3.demo', tone: 'info' },
];

function FlowSteps() {
  const tr = useT();
  return (
    <ol className="sp-steps">
      {STEPS.map((s, i) => (
        <React.Fragment key={s.n}>
          <li className={'sp-step ' + s.tone}>
            <div className="sp-step-head">
              <span className="sp-step-icon"><Icon name={s.icon} size={16} /></span>
              <span className="sp-step-no mono">0{s.n}</span>
            </div>
            <h3>{tr(s.titleKey)}</h3>
            <p>{tr(s.descKey)}</p>
            <div className="sp-step-demo">{tr(s.demoKey)}</div>
          </li>
          {i < STEPS.length - 1 && <li className="sp-step-arrow" aria-hidden="true"><Icon name="chevronRight" size={16} /></li>}
        </React.Fragment>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Environment Notices (shown only when a component or optional setup is missing)
// ---------------------------------------------------------------------------
function EnvNotices() {
  const tr = useT();
  const appInfo = useStore((s) => s.appInfo);
  const aiStatus = useStore((s) => s.aiStatus);
  const openDialog = useStore((s) => s.openDialog);
  const toast = useStore((s) => s.toast);
  const [install, setInstall] = useState(null); // { progress, message }
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const refresh = async () => {
    try {
      const info = await api.call('app:info');
      useStore.setState({ appInfo: info });
      await useStore.getState().refreshAI?.();
    } catch { /* silent refresh failure */ }
  };

  const installYtdlp = async () => {
    if (install) return;
    setInstall({ progress: 0, message: tr('start.env.ytdlpConnecting') });
    try {
      await useStore.getState().trackJob('web:ytdlpInstall', {}, tr('start.env.ytdlpJobLabel'), (p) => {
        if (mounted.current) setInstall({ progress: p.progress || 0, message: p.message || p.stage || tr('start.env.ytdlpDownloading') });
      });
      toast(tr('start.env.ytdlpDone'), 'ok');
      await refresh();
    } catch (e) {
      if (!e.cancelled) toast(tr('start.env.ytdlpFailed', { error: e.message }), 'error');
    } finally {
      if (mounted.current) setInstall(null);
    }
  };

  if (!appInfo && !aiStatus) return null;
  const ffmpeg = appInfo && appInfo.ffmpeg;
  const ffprobe = appInfo && appInfo.ffprobe;
  const ytdlp = appInfo && appInfo.ytdlp;
  const rows = [];
  if (appInfo && !(ffmpeg && ffmpeg.ok && ffprobe && ffprobe.ok)) {
    rows.push({ key: 'media', tone: 'bad', text: tr('start.env.mediaMissing') });
  }
  if (isLocalOnlyAI(aiStatus)) {
    rows.push({
      key: 'ai',
      tone: 'idle',
      text: tr('start.env.aiOffline'),
      action: <button type="button" className="sp-env-act" onClick={() => openDialog('settings', 'ai')}>{tr('start.env.aiConnect')}</button>,
    });
  }
  if (appInfo && !(ytdlp && ytdlp.ok)) {
    rows.push({
      key: 'ytdlp',
      tone: 'idle',
      text: tr('start.env.ytdlpMissing'),
      action: install
        ? <span className="sp-env-busy"><Spinner /> {install.message}</span>
        : <button type="button" className="sp-env-act" onClick={installYtdlp}>{tr('start.env.ytdlpEnable')}</button>,
      progress: install ? install.progress : null,
    });
  }
  if (!rows.length) return null;
  return (
    <div className="sp-env" role="status">
      {rows.map((r) => (
        <div key={r.key} className={'sp-env-row ' + r.tone}>
          <span className="sp-env-dot" aria-hidden="true" />
          <span className="sp-env-text">{r.text}</span>
          {r.action && <><span className="sp-env-sep" aria-hidden="true">·</span>{r.action}</>}
          {r.progress != null && <span className="sp-env-progress"><ProgressBar value={r.progress} indeterminate={!(r.progress > 0)} /></span>}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sample Project Card (shown in the Recent Projects empty state)
// ---------------------------------------------------------------------------
const SAMPLE_BARS = [4.5, 3.5, 4, 5, 4, 5, 4];

function SampleCard({ busy, disabled, onOpen }) {
  const tr = useT();
  return (
    <button type="button" className={'sp-sample-card' + (busy ? ' busy' : '')} disabled={disabled} onClick={onOpen} title={tr('start.sampleCardTitle')}>
      <span className="sp-sample-thumb" aria-hidden="true">
        <span className="sp-sample-play"><Icon name="play" size={16} /></span>
        <span className="sp-sample-track">
          {SAMPLE_BARS.map((d, i) => <i key={i} style={{ flexGrow: d }} />)}
        </span>
        <span className="sp-sample-badge">{tr('start.sampleBadge')}</span>
        {busy && <span className="sp-sample-loading"><Spinner ai /></span>}
      </span>
      <span className="sp-sample-info">
        <span className="sp-sample-name">{tr('start.sampleName')}</span>
        <span className="sp-sample-meta">{tr('start.sampleMeta')}</span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Context Menu
// ---------------------------------------------------------------------------
function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useEffect(() => {
    const el = ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
    }
    const close = (e) => { if (!ref.current || !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [x, y, onClose]);

  return (
    <div ref={ref} className="ctx-menu" role="menu" style={pos}>
      {items.map((it) => (
        <button key={it.label} type="button" role="menuitem" className={'ctx-item' + (it.danger ? ' danger' : '')} onClick={() => { onClose(); it.onClick(); }}>
          <Icon name={it.icon} size={14} />
          {it.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recent Project Card
// ---------------------------------------------------------------------------
function ProjectCard({ item, nonce, busy, isLast, onOpen, onMenu }) {
  const locale = useLocale();
  const tr = useT();
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [item.thumb, nonce]);
  const src = item.thumb && !broken ? `${api.mediaUrl(item.thumb)}?v=${nonce}` : null;
  const clips = Number(item.clipCount) || 0;
  const duration = Number(item.duration) || 0;
  const displayName = item.name || tr('app.untitledProject');
  const clipLabel = clips === 1 ? tr('start.cardClipsOne') : clips > 0 ? tr('start.cardClips', { count: clips }) : tr('start.cardEmptyTimeline');
  return (
    <div
      className={'proj-card' + (busy ? ' busy' : '')}
      style={{ position: 'relative' }}
      onContextMenu={(e) => { e.preventDefault(); onMenu(item, e.clientX, e.clientY); }}
    >
      <button
        type="button"
        title={tr('start.cardOpenTitle', { name: displayName })}
        onClick={() => onOpen(item)}
        onKeyDown={(e) => {
          if (e.key === 'ContextMenu') { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); onMenu(item, r.left + 24, r.top + 24); }
        }}
        style={{ display: 'block', width: '100%', padding: 0, margin: 0, border: 0, background: 'none', color: 'inherit', textAlign: 'left', cursor: 'inherit' }}
      >
        <div className="proj-thumb">
          {src
            ? <img src={src} alt="" draggable={false} onError={() => setBroken(true)} />
            : <span className="proj-thumb-empty"><Icon name="film" size={26} stroke={1.3} /></span>}
          {duration > 0 && <span className="proj-duration mono">{fmtTime(duration, false)}</span>}
          {isLast && <span className="proj-last">{tr('start.cardLastOpened')}</span>}
          {busy && <span className="proj-loading"><Spinner /></span>}
        </div>
        <div className="proj-info" style={{ paddingRight: 38 }}>
          <div className="proj-text">
            <div className="proj-name ellipsis">{displayName}</div>
            <div className="proj-meta ellipsis">
              {clipLabel}
              <span className="proj-meta-sep">·</span>
              {relativeTime(item.updatedAt, locale) || tr('start.cardTimeUnknown')}
            </div>
          </div>
        </div>
      </button>
      <button
        type="button"
        className="proj-more"
        title={tr('start.cardMore')}
        aria-label={tr('start.cardMoreAria', { name: displayName })}
        style={{ position: 'absolute', right: 6, bottom: 13 }}
        onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); onMenu(item, r.left, r.bottom + 4); }}
      >
        <Icon name="dots" size={16} stroke={2.6} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Start Page
// ---------------------------------------------------------------------------
export default function StartPage({ onOpenLibrary }) {
  const locale = useLocale();
  const tr = useT();
  const projectList = useStore((s) => s.projectList);
  const lastProjectId = useStore((s) => (s.settings && s.settings.ui ? s.settings.ui.lastProjectId : ''));
  const openDialog = useStore((s) => s.openDialog);
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(null); // 'sample' | 'import' | projectId
  const [menu, setMenu] = useState(null); // { item, x, y }
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    useStore.getState().refreshProjects();
    useStore.getState().refreshSettings();
    return () => { mounted.current = false; };
  }, []);

  const nonce = useMemo(() => Date.now(), [projectList]);
  const closeMenu = useMemo(() => () => setMenu(null), []);
  const done = () => { if (mounted.current) setBusy(null); };

  const openItem = async (item) => {
    if (busy) return;
    setBusy(item.id);
    try {
      await useStore.getState().openProject(item.id);
    } catch (e) {
      toast(tr('start.toast.openFailed', { name: item.name, error: e.message }), 'error');
    } finally {
      done();
    }
  };

  const createSample = async () => {
    if (busy) return;
    setBusy('sample');
    try {
      const seed = createSampleProject({ appInfo: useStore.getState().appInfo });
      const st = useStore.getState();
      await st.newProject({ project: seed, name: seed.name || tr('start.sampleCta'), aspect: seed.settings && seed.settings.aspect });
      const r = useStore.getState().commit((p) => buildFirstCut(p).project, tr('start.toast.sampleFirstCutLabel'));
      useStore.getState().setMode('create');
      if (r.ok) toast(tr('start.toast.sampleReady'), 'ok', 4000, { key: 'sample-ready' });
      else toast(tr('start.toast.samplePartial', { errors: (r.errors || []).join('; ') }), 'warn');
    } catch (e) {
      toast(tr('start.toast.sampleFailed', { error: e.message }), 'error');
    } finally {
      done();
    }
  };

  const importJson = async () => {
    if (busy) return;
    setBusy('import');
    try {
      const filters = [{ name: tr('start.projectFileFilter'), extensions: ['ffproj', 'json'] }];
      const files = await api.call('dialog:openFiles', { title: tr('start.toast.importDialogTitle'), multi: false, filters });
      if (!files || !files.length) return;
      const imported = await api.call('project:importJson', { path: files[0] });
      if (!imported) throw new Error(tr('start.toast.importEmpty'));
      const st = useStore.getState();
      await st.refreshProjects();
      const exists = imported.id && useStore.getState().projectList.some((p) => p.id === imported.id);
      if (exists) await st.openProject(imported.id);
      else {
        await st.newProject({ project: imported, name: imported.name });
        const paths = Object.values(imported.assets || {}).map((a) => a && a.path).filter(Boolean);
        if (paths.length) await api.call('media:register', { paths }).catch(() => {});
      }
      toast(tr('start.toast.importOk', { name: imported.name || tr('app.untitledProject') }), 'ok');
    } catch (e) {
      toast(tr('start.toast.importFailed', { error: e.message }), 'error');
    } finally {
      done();
    }
  };

  const exportJson = async (item) => {
    try {
      const filters = [{ name: tr('start.projectFileFilter'), extensions: ['ffproj'] }];
      const path = await api.call('dialog:saveFile', {
        title: tr('start.toast.exportDialogTitle'),
        defaultPath: `${safeFileName(item.name, tr('start.defaultFileName'))}.ffproj`,
        filters,
      });
      if (!path) return;
      const project = await api.call('project:load', { id: item.id });
      const saved = (await api.call('project:exportJson', { project, path })) || path;
      toast(tr('start.toast.exportOk'), 'ok', 6000, {
        key: 'project-export',
        action: { label: tr('start.toast.showInFolder'), run: () => { api.call('shell:showItem', { path: saved }).catch(() => {}); } },
      });
    } catch (e) {
      toast(tr('start.toast.exportFailed', { error: e.message }), 'error');
    }
  };

  const doDelete = async () => {
    const item = confirmDelete;
    if (!item || deleting) return;
    setDeleting(true);
    try {
      await api.call('project:delete', { id: item.id });
      await useStore.getState().refreshProjects();
      toast(tr('start.toast.deleteOk', { name: item.name }), 'ok');
      setConfirmDelete(null);
    } catch (e) {
      toast(tr('start.toast.deleteFailed', { error: e.message }), 'error');
    } finally {
      setDeleting(false);
    }
  };

  const list = Array.isArray(projectList) ? projectList : [];

  return (
    <div className="start-page">
      <div className="start-inner">
        <header className="sp-brandbar">
          <Logo size={30} />
          <span className="sp-brandname">
            {locale === 'zh-CN' ? <>镜流 <b>Frameflow</b></> : <b>Frameflow</b>}
          </span>
          <span className="grow" />
          <LocaleToggle />
          <Button variant="ghost" size="sm" icon="settings" onClick={() => openDialog('settings')}>{tr('start.settings')}</Button>
          <Button variant="ghost" size="sm" icon="help" onClick={() => openDialog('help')}>{tr('start.help')}</Button>
        </header>

        <section className="sp-hero">
          <div className="sp-hero-main">
            <h1>{tr('start.heroTitle')}</h1>
            <p className="sp-lead">{tr('start.heroLead')}</p>
            <div className="sp-actions">
              <Button variant="primary" size="lg" icon="plus" onClick={() => openDialog('newProject')} disabled={!!busy}>{tr('start.newProject')}</Button>
              <Button variant="ai" size="lg" icon={busy === 'sample' ? undefined : 'sparkles'} onClick={createSample} disabled={!!busy} data-sample="hero">
                {busy === 'sample' ? <><Spinner ai /> {tr('start.sampleBusy')}</> : tr('start.sampleCta')}
              </Button>
            </div>
            <div className="sp-subactions">
              <Button variant="ghost" size="sm" icon="book" onClick={onOpenLibrary} disabled={!!busy}>{tr('start.openLibrary')}</Button>
              <Button variant="ghost" size="sm" icon={busy === 'import' ? undefined : 'upload'} onClick={importJson} disabled={!!busy}>
                {busy === 'import' ? <><Spinner /> {tr('start.importing')}</> : tr('start.importProject')}
              </Button>
            </div>
            <EnvNotices />
          </div>
        </section>

        <FlowSteps />
        <p className="sp-honest">
          <Icon name="eye" size={13} /> {tr('start.honest')}
        </p>

        <section className="sp-recent">
          <div className="sp-section-head">
            <h2>{tr('start.recentTitle')}</h2>
            {list.length > 0 && (
              <span className="muted small">
                {list.length === 1 ? tr('start.recentMetaOne') : tr('start.recentMeta', { count: list.length })}
              </span>
            )}
          </div>
          {list.length === 0 ? (
            <div className="proj-grid sp-empty-grid">
              <SampleCard busy={busy === 'sample'} disabled={!!busy} onOpen={createSample} />
              <button type="button" className="sp-new-card" onClick={() => openDialog('newProject')} disabled={!!busy}>
                <span className="sp-new-icon" aria-hidden="true"><Icon name="plus" size={22} /></span>
                <span className="sp-new-title">{tr('start.newProject')}</span>
                <span className="sp-new-desc">{tr('start.emptyNewDesc')}</span>
              </button>
              <p className="sp-empty-hint">{tr('start.emptyHint')}</p>
            </div>
          ) : (
            <div className="proj-grid">
              {list.map((item) => (
                <ProjectCard
                  key={item.id}
                  item={item}
                  nonce={nonce}
                  busy={busy === item.id}
                  isLast={item.id === lastProjectId}
                  onOpen={openItem}
                  onMenu={(it, x, y) => setMenu({ item: it, x, y })}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          items={[
            { label: tr('start.ctx.open'), icon: 'folder', onClick: () => openItem(menu.item) },
            { label: tr('start.ctx.exportFile'), icon: 'download', onClick: () => exportJson(menu.item) },
            { label: tr('start.ctx.delete'), icon: 'trash', danger: true, onClick: () => setConfirmDelete(menu.item) },
          ]}
        />
      )}

      {confirmDelete && (
        <Modal
          title={tr('start.deleteTitle')}
          onClose={deleting ? undefined : () => setConfirmDelete(null)}
          className="confirm-modal"
          footer={(
            <>
              <Button onClick={() => setConfirmDelete(null)} disabled={deleting}>{tr('app.cancel')}</Button>
              <Button variant="danger" icon={deleting ? undefined : 'trash'} onClick={doDelete} disabled={deleting}>
                {deleting ? <><Spinner /> {tr('start.deleting')}</> : tr('start.deleteAction')}
              </Button>
            </>
          )}
        >
          <p className="confirm-text">
            {tr('start.deleteConfirmBefore')}<b>{confirmDelete.name || tr('app.untitledProject')}</b>{tr('start.deleteConfirmAfter')}
          </p>
          <p className="hint">{tr('start.deleteHint')}</p>
        </Modal>
      )}
    </div>
  );
}
