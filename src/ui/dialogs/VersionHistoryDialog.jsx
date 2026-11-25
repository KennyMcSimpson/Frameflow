// 历史版本（契约 C6）：列出编辑时自动保存的版本，选一个恢复。
// 数据：project:listSnapshots { id } → [{ snapshotId, createdAt, size, name, clipCount, duration? }]（新的在前）
// 恢复：先 saveNow 把当前修改写盘 → project:restoreSnapshot（主进程会先把当前版本也存一份）→ openProject 重新载入。
// 由 TopBar 在 dialogs.versionHistory 为真时挂载；同一时刻只渲染一个实例。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useStore from '../store.js';
import api from '../api.js';
import { Modal, Button, Icon, Spinner, EmptyState, ICON_NAMES, fmtTime } from '../components/ui.jsx';
import { normalizeSnapshots, fmtSnapshotTime, groupSnapshotsByDay, isMissingHandler } from './versionHistoryUtils.js';

const iconOr = (name, fallback) => (ICON_NAMES.includes(name) ? name : fallback);

// 单例：App 和 TopBar 若同时挂载，只让先挂上的那个渲染
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

function clipsLabel(n) {
  return n > 0 ? `${n} 个片段` : '时间线为空';
}

export default function VersionHistoryDialog({ onClose }) {
  const isOwner = useSingleton();
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

  // 确认恢复时按 Esc 先取消确认，而不是直接关掉对话框
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
      // 先把当前修改写盘：恢复前主进程会给磁盘上的当前版本拍快照，这样随时能换回来
      const saved = await st.saveNow();
      if (saved === false || useStore.getState().saveState === 'error') {
        throw new Error('当前的修改还没保存成功，为避免丢失先不恢复。请检查磁盘空间后再试');
      }
      const prevMode = useStore.getState().mode;
      await api.call('project:restoreSnapshot', { id, snapshotId: snap.snapshotId });
      await useStore.getState().openProject(id);
      const after = useStore.getState();
      if (prevMode && after.mode !== prevMode && typeof after.setMode === 'function') after.setMode(prevMode);
      after.toast(`已恢复到 ${fmtSnapshotTime(snap.createdAt).main} 的版本。恢复前的版本也已保存，可在「历史版本」里换回`, 'success', 4000, { key: 'version-restore' });
      close();
    } catch (e) {
      const msg = (e && e.message) || String(e);
      setError('恢复失败：' + msg);
      setConfirmId(null);
    } finally {
      setRestoringId(null);
    }
  };

  const groups = useMemo(() => groupSnapshotsByDay(list, now), [list, now]);

  if (!isOwner || !projectId) return null;

  const footer = (
    <>
      <span className="hint grow vh-foot-hint">编辑时每 5 分钟（或每保存 30 次）自动存一份，保留最近 20 份。</span>
      <Button onClick={close} disabled={!!restoringId}>关闭</Button>
    </>
  );

  let body;
  if (status === 'loading') {
    body = (
      <div className="vh-state" role="status">
        <Spinner />
        <span>正在读取历史版本…</span>
      </div>
    );
  } else if (status === 'unsupported') {
    body = (
      <EmptyState
        icon={iconOr('history', 'clock')}
        title="当前版本还不支持历史版本"
        desc="更新到新版镜流后即可使用。项目仍会照常自动保存。"
      />
    );
  } else if (status === 'error') {
    body = (
      <EmptyState
        icon="alert"
        title="读取历史版本失败"
        desc={error || '请稍后再试。'}
        action={<Button icon="refresh" onClick={load}>重试</Button>}
      />
    );
  } else if (!list.length) {
    body = (
      <EmptyState
        icon={iconOr('history', 'clock')}
        title="还没有历史版本"
        desc="继续编辑一会儿，镜流会自动存下版本。以后改坏了，可以在这里回到之前的样子。"
      />
    );
  } else {
    body = (
      <div className="vh-list">
        <div className="vh-item current" aria-current="true">
          <div className="vh-when">
            <span className="vh-main">当前版本</span>
            <span className="vh-rel">{saveState === 'saved' ? '已保存' : saveState === 'error' ? '保存失败' : '正在编辑'}</span>
          </div>
          <div className="vh-meta">
            <span className="ellipsis">{projectName || '未命名项目'}</span>
            <span className="vh-dot" aria-hidden="true" />
            <span>{clipsLabel(currentClips)}</span>
          </div>
        </div>
        {groups.map((g) => (
          <section key={g.label} className="vh-group" aria-label={g.label}>
            <h4 className="vh-group-label">{g.label}</h4>
            {g.items.map((s) => {
              const tm = fmtSnapshotTime(s.createdAt, now);
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
                      {renamed && (<><span className="vh-dot" aria-hidden="true" /><span className="ellipsis" title={s.name}>当时叫「{s.name}」</span></>)}
                    </div>
                    {!confirming && (
                      <Button size="sm" icon="refresh" onClick={() => { setError(''); setConfirmId(s.snapshotId); }} disabled={!!restoringId}>
                        恢复
                      </Button>
                    )}
                  </div>
                  {confirming && (
                    <div className="vh-confirm" role="group" aria-label="确认恢复">
                      <Icon name="info" size={14} />
                      <span className="grow">恢复后当前内容会被替换，撤销记录也会清空。当前版本会先自动存一份，之后可以在这里换回来。</span>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmId(null)} disabled={busy}>取消</Button>
                      <Button size="sm" variant="primary" onClick={() => restore(s)} disabled={busy} autoFocus>
                        {busy ? <><Spinner /> 正在恢复…</> : '恢复这个版本'}
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
    <Modal title="历史版本" onClose={restoringId ? undefined : close} footer={footer} className="vh-modal">
      <p className="vh-intro hint">选一个之前的版本恢复。恢复前，当前版本也会自动存一份，不怕改错。</p>
      {error && status === 'ready' && (
        <div className="callout warn vh-error" role="alert">
          <Icon name="alert" size={14} /> <span>{error}</span>
        </div>
      )}
      {body}
    </Modal>
  );
}
