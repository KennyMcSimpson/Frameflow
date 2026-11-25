// 后台任务列表：由 StatusBar 的「后台任务」按钮弹出（store.jobsOpen）。可取消运行中的任务。
import React, { useEffect, useRef, useState } from 'react';
import useStore from '../store.js';
import api from '../api.js';
import { Icon, Button, ProgressBar, EmptyState } from './ui.jsx';

const STATUS_TEXT = { done: '已完成', error: '失败', cancelled: '已取消' };

export function isRunning(job) { return !job.status || job.status === 'running'; }

function JobRow({ job }) {
  const [cancelling, setCancelling] = useState(false);
  const running = isRunning(job);
  const pct = Number.isFinite(job.progress) ? Math.max(0, Math.min(1, job.progress)) : 0;
  const isAI = /^(ai|analysis|videogen|asr)/.test(job.kind || '') || /AI|拆片|分析|生成|识别/.test(job.label || '');
  const sub = running
    ? [job.stage, job.message].filter(Boolean).join(' · ') || '准备中…'
    : job.status === 'error' ? (job.message || '任务失败') : STATUS_TEXT[job.status] || '';

  const onCancel = async () => {
    if (!job.jobId || cancelling) return;
    setCancelling(true);
    try { await api.cancel(job.jobId); } catch (e) { useStore.getState().toast('取消失败：' + e.message, 'error'); setCancelling(false); }
  };

  return (
    <div className={'job-row ' + (job.status || 'running')}>
      <div className="job-row-head">
        <span className="job-status-icon">
          {running ? <span className={'spinner' + (isAI ? ' ai' : '')} /> : job.status === 'done' ? <Icon name="check" size={14} stroke={2} /> : job.status === 'cancelled' ? <Icon name="minus" size={14} stroke={2} /> : <Icon name="close" size={14} stroke={2} />}
        </span>
        <span className="job-label ellipsis" title={job.label}>{job.label || '后台任务'}</span>
        {running && <span className="job-pct mono">{pct > 0 ? `${Math.round(pct * 100)}%` : ''}</span>}
        {running && (
          <Button variant="ghost" size="sm" icon="close" title={cancelling ? '正在取消…' : '取消此任务'} onClick={onCancel} disabled={cancelling || !job.jobId} />
        )}
      </div>
      <div className="job-sub ellipsis" title={sub}>{cancelling && running ? '正在取消…' : sub}</div>
      {running && <ProgressBar value={pct} ai={isAI} indeterminate={!(pct > 0)} />}
    </div>
  );
}

/** 弹出面板。anchorRef：StatusBar 中触发按钮（点击它不算“外部点击”）。 */
export default function JobsTray({ anchorRef }) {
  const jobs = useStore((s) => s.jobs);
  const open = useStore((s) => s.jobsOpen);
  const setJobsOpen = useStore((s) => s.setJobsOpen);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && ref.current.contains(e.target)) return;
      if (anchorRef && anchorRef.current && anchorRef.current.contains(e.target)) return;
      setJobsOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setJobsOpen(false); };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown, true); window.removeEventListener('keydown', onKey); };
  }, [open, anchorRef, setJobsOpen]);
  if (!open) return null;
  const list = Object.values(jobs || {}).filter(Boolean);
  const running = list.filter(isRunning).length;
  return (
    <section className="jobs-pop" ref={ref} aria-label="后台任务">
      <div className="jobs-pop-head">
        <b>后台任务</b>
        <span className="muted xs">{running ? `${running} 个进行中` : list.length ? '全部结束' : ''}</span>
        <span className="grow" />
        <Button variant="ghost" size="sm" icon="close" title="收起" onClick={() => setJobsOpen(false)} />
      </div>
      <div className="jobs-list">
        {list.length
          ? list.map((j) => <JobRow key={j.jobId} job={j} />)
          : <EmptyState icon="clock" title="没有后台任务" desc="生成画面、导出、拆片等耗时操作会显示在这里，可随时取消。" />}
      </div>
    </section>
  );
}
