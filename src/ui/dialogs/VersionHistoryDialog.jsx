// Version History Dialog: browse auto-saved project snapshots and restore safely.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useStore from '../store.js';
import api from '../api.js';
import { useLocale, useT } from '../i18n.js';
import { Modal, Button, Icon, Spinner, EmptyState, ICON_NAMES, fmtTime } from '../components/ui.jsx';
import { normalizeSnapshots, fmtSnapshotTime, groupSnapshotsByDay, isMissingHandler } from './versionHistoryUtils.js';

const iconOr = (name, fallback) => (ICON_NAMES.includes(name) ? name : fallback);
const pad2 = (n) => String(n).padStart(2, '0');
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Singleton guard so only one instance renders if mounted from multiple hosts
let activeOwner = null;
function useSingleton() {
  const me = useRef({});
  const [owner, setOwner] = useState(false);
  useEffect(() => {
    if (!activeOwner) { activeOwner = me.current; setOwner(true); }
    return () => { if (activeOwner === me.current) activeOwner = null; };
  }, []);
  return owner;
}

function fmtSnapshotTimeLoc(iso, now, locale, tr) {
  if (locale === 'zh-CN') return fmtSnapshotTime(iso, now);
  const d = new Date(iso);
  const ts = d.getTime();
  if (!iso || !Number.isFinite(ts)) return { main: tr('history.timeUnknown'), rel: '' };
  const n = new Date(now);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const dayStart = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((dayStart(n) - dayStart(d)) / 86400000);
  let dayLabel;
  if (dayDiff === 0) dayLabel = tr('history.today');
  else if (dayDiff === 1) dayLabel = tr('history.yesterday');
  else if (d.getFullYear() === n.getFullYear()) dayLabel = `${EN_MONTHS[d.getMonth()]} ${d.getDate()}`;
  else dayLabel = `${EN_MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  const s = Math.max(0, Math.round((now - ts) / 1000));
  let rel = '';
  if (s < 60) rel = tr('start.time.justNow');
  else if (s < 3600) rel = tr('start.time.minsAgo', { n: Math.floor(s / 60) });
  else if (s < 86400) rel = tr('start.time.hoursAgo', { n: Math.floor(s / 3600) });
  else if (s < 30 * 86400) rel = tr('start.time.daysAgo', { n: Math.floor(s / 86400) });
  return { main: `${dayLabel} ${hm}`, rel };
}

function groupSnapshotsLoc(list, now, locale, tr) {
  if (locale === 'zh-CN') return groupSnapshotsByDay(list, now);
  const groups = [];
  for (const s of list || []) {
    const { main } = fmtSnapshotTimeLoc(s.createdAt, now, locale, tr);
    const label = main.includes(' ') ? main.slice(0, main.lastIndexOf(' ')) : main;
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(s);
    else groups.push({ label, items: [s] });
  }
  return groups;
}

export default function VersionHistoryDialog({ onClose }) {
  const isOwner = useSingleton();
  const locale = useLocale();
  const tr = useT();
  const projectId = useStore((s) => (s.project ? s.project.id : ''));
  const projectName = useStore((s) => (s.project ? s.project.name : ''));
  const currentClips = useStore((s) => (s.project && s.project.tracks && Array.isArray(s.project.tracks.video) ? s.project.tracks.video.length : 0));
  const saveState = useStore((s) => s.saveState);
  const closeDialog = useStore((s) => s.closeDialog);
  const close = useCallback(() => { if (onClose) onClose(); else closeDialog('versionHistory'); }, [onClose, closeDialog]);

  const [status, setStatus] = useState('loading'); // loading | ready | error | unsupported
  const [list, setList] = useState([]);
  const [error, setError] = useState('');
  const [confirmId, setConfirmId] = useState(null);
  const [restoringId, setRestoringId] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  const clipsLabel = (n) => (n === 1 ? tr('history.clipsOne') : n > 0 ? tr('history.clips', { count: n }) : tr('history.emptyTimeline'));

  const load = useCallback(async () => {
    if (!projectId) return;
    setStatus('loading'); setError('');
    try {
      const r = await api.call('project:listSnapshots', { id: projectId });
      setList(normalizeSnapshots(r));
      setNow(Date.now());
      setStatus('ready');
    } catch (e) {
      if (isMissingHandler(e)) setStatus('unsupported');
      else { setError((e && e.message) || String(e)); setStatus('error'); }
    }
  }, [projectId]);

  useEffect(() => { if (isOwner) load(); }, [isOwner, load]);

  useEffect(() => {
    if (!confirmId) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
      if (!restoringId) setConfirmId(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [confirmId, restoringId]);

  const restore = async (snap) => {
    const st = useStore.getState();
    if (!st.project || restoringId) return;
    const id = st.project.id;
    setRestoringId(snap.snapshotId); setError('');
    try {
      if (typeof st.setPlaying === 'function') st.setPlaying(false);
      const saved = await st.saveNow();
      if (saved === false || useStore.getState().saveState === 'error') {
        throw new Error(tr('history.saveBeforeRestoreErr'));
      }
      const prevMode = useStore.getState().mode;
      await api.call('project:restoreSnapshot', { id, snapshotId: snap.snapshotId });
      await useStore.getState().openProject(id);
      const after = useStore.getState();
      if (prevMode && after.mode !== prevMode && typeof after.setMode === 'function') after.setMode(prevMode);
      after.toast(tr('history.restoreSuccess', { time: fmtSnapshotTimeLoc(snap.createdAt, Date.now(), locale, tr).main }), 'success', 4000, { key: 'version-restore' });
      close();
    } catch (e) {
      const msg = (e && e.message) || String(e);
      setError(tr('history.restoreFailed', { error: msg }));
      setConfirmId(null);
    } finally {
      setRestoringId(null);
    }
  };

  const groups = useMemo(() => groupSnapshotsLoc(list, now, locale, tr), [list, now, locale, tr]);

  if (!isOwner || !projectId) return null;

  const footer = (
    <>
      <span className="hint grow vh-foot-hint">{tr('history.footerHint')}</span>
      <Button onClick={close} disabled={!!restoringId}>{tr('app.close')}</Button>
    </>
  );

  let body;
  if (status === 'loading') {
    body = (
      <div className="vh-state" role="status">
        <Spinner />
        <span>{tr('history.loading')}</span>
      </div>
    );
  } else if (status === 'unsupported') {
    body = (
      <EmptyState
        icon={iconOr('history', 'clock')}
        title={tr('history.unsupportedTitle')}
        desc={tr('history.unsupportedDesc')}
      />
    );
  } else if (status === 'error') {
    body = (
      <EmptyState
        icon="alert"
        title={tr('history.errorTitle')}
        desc={error || tr('history.errorFallback')}
        action={<Button icon="refresh" onClick={load}>{tr('app.retry')}</Button>}
      />
    );
  } else if (!list.length) {
    body = (
      <EmptyState
        icon={iconOr('history', 'clock')}
        title={tr('history.emptyTitle')}
        desc={tr('history.emptyDesc')}
      />
    );
  } else {
    body = (
      <div className="vh-list">
        <div className="vh-item current" aria-current="true">
          <div className="vh-when">
            <span className="vh-main">{tr('history.currentVersion')}</span>
            <span className="vh-rel">{saveState === 'saved' ? tr('history.stateSaved') : saveState === 'error' ? tr('history.stateError') : tr('history.stateEditing')}</span>
          </div>
          <div className="vh-meta">
            <span className="ellipsis">{projectName || tr('app.untitledProject')}</span>
            <span className="vh-dot" aria-hidden="true" />
            <span>{clipsLabel(currentClips)}</span>
          </div>
        </div>
        {groups.map((g) => (
          <section key={g.label} className="vh-group" aria-label={g.label}>
            <h4 className="vh-group-label">{g.label}</h4>
            {g.items.map((s) => {
              const tm = fmtSnapshotTimeLoc(s.createdAt, now, locale, tr);
              const hm = tm.main.slice(tm.main.lastIndexOf(' ') + 1);
              const confirming = confirmId === s.snapshotId;
              const busy = restoringId === s.snapshotId;
              const renamed = s.name && projectName && s.name !== projectName;
              return (
                <div key={s.snapshotId} className={'vh-item' + (confirming ? ' confirming' : '')}>
                  <div className="vh-row">
                    <div className="vh-when">
                      <span className="vh-main mono">{hm}</span>
                      {tm.rel && <span className="vh-rel">{tm.rel}</span>}
                    </div>
                    <div className="vh-meta">
                      <span>{clipsLabel(s.clipCount)}</span>
                      {s.duration != null && (<><span className="vh-dot" aria-hidden="true" /><span className="mono">{fmtTime(s.duration)}</span></>)}
                      {renamed && (<><span className="vh-dot" aria-hidden="true" /><span className="ellipsis" title={s.name}>{tr('history.namedThen', { name: s.name })}</span></>)}
                    </div>
                    {!confirming && (
                      <Button size="sm" icon="refresh" onClick={() => { setError(''); setConfirmId(s.snapshotId); }} disabled={!!restoringId}>
                        {tr('history.restore')}
                      </Button>
                    )}
                  </div>
                  {confirming && (
                    <div className="vh-confirm" role="group" aria-label={tr('history.confirmAria')}>
                      <Icon name="info" size={14} />
                      <span className="grow">{tr('history.confirmDesc')}</span>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmId(null)} disabled={busy}>{tr('app.cancel')}</Button>
                      <Button size="sm" variant="primary" onClick={() => restore(s)} disabled={busy} autoFocus>
                        {busy ? <><Spinner /> {tr('history.restoring')}</> : tr('history.restoreThis')}
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    );
  }

  return (
    <Modal title={tr('history.title')} onClose={restoringId ? undefined : close} footer={footer} className="vh-modal">
      <p className="vh-intro hint">{tr('history.intro')}</p>
      {error && status === 'ready' && (
        <div className="callout warn vh-error" role="alert">
          <Icon name="alert" size={14} /> <span>{error}</span>
        </div>
      )}
      {body}
    </Modal>
  );
}
