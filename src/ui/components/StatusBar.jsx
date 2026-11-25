// 底部状态栏（24px）：AI 服务状态 · 后台任务（点击弹出 JobsTray） · 工程时长/画幅/帧率。
import React, { useMemo, useRef } from 'react';
import useStore from '../store.js';
import { Icon, fmtTime } from './ui.jsx';
import { describeAI } from './TopBar.jsx';
import JobsTray, { isRunning } from './JobsTray.jsx';
import { layoutVideo, projectDuration } from '../../engine/timeline.js';

function AIStatus() {
  const ai = useStore((s) => s.aiStatus);
  const openDialog = useStore((s) => s.openDialog);
  const d = describeAI(ai);
  const label = d.label === 'Codex 已就绪' ? 'AI 导演已连接' : d.label;
  return (
    <button type="button" className={'sb-item sb-ai ' + d.kind} title={d.title} onClick={() => openDialog('settings', 'ai')}>
      <span className="sb-dot" />
      <span>{label}</span>
    </button>
  );
}

function JobsButton() {
  const jobs = useStore((s) => s.jobs);
  const open = useStore((s) => s.jobsOpen);
  const setJobsOpen = useStore((s) => s.setJobsOpen);
  const ref = useRef(null);
  const list = Object.values(jobs || {}).filter(Boolean);
  const running = list.filter(isRunning);
  const failed = list.filter((j) => j.status === 'error').length;
  const avg = running.length ? running.reduce((s, j) => s + (Number.isFinite(j.progress) ? j.progress : 0), 0) / running.length : 0;
  let text = '无后台任务';
  if (running.length) text = `${running.length} 个任务进行中${avg > 0 ? ` · ${Math.round(avg * 100)}%` : ''}`;
  else if (failed) text = `${failed} 个任务失败`;
  else if (list.length) text = '任务已完成';
  return (
    <div className="sb-jobs-wrap">
      <button type="button" ref={ref} className={'sb-item sb-jobs' + (open ? ' open' : '') + (running.length ? ' busy' : '') + (failed ? ' failed' : '')} onClick={() => setJobsOpen(!open)} title="查看后台任务">
        {running.length ? <span className="spinner sb-spin" /> : <Icon name={failed ? 'alert' : 'clock'} size={12} />}
        <span>{text}</span>
        <Icon name="chevronUp" size={11} />
      </button>
      <JobsTray anchorRef={ref} />
    </div>
  );
}

function ProjectFacts() {
  const project = useStore((s) => s.project);
  const info = useMemo(() => {
    if (!project) return null;
    let dur = 0;
    try { dur = projectDuration(project, layoutVideo(project)) || 0; } catch { dur = 0; }
    const st = project.settings || {};
    return { dur, aspect: st.aspect || '16:9', size: st.width && st.height ? `${st.width}×${st.height}` : '', fps: st.fps || 30, clips: (project.tracks && project.tracks.video && project.tracks.video.length) || 0 };
  }, [project]);
  if (!info) return null;
  return (
    <div className="sb-facts">
      <span className="sb-item static" title="成片总时长"><Icon name="clock" size={12} />成片 {fmtTime(info.dur)}</span>
      <span className="sb-item static" title="时间线上的视频片段数"><Icon name="film" size={12} />{info.clips} 个片段</span>
      <span className="sb-item static" title="画幅 · 分辨率 · 帧率">{info.aspect}{info.size ? ` · ${info.size}` : ''} · {info.fps}fps</span>
    </div>
  );
}

export default function StatusBar() {
  const version = useStore((s) => (s.appInfo && s.appInfo.version) || '');
  return (
    <footer className="statusbar" role="status">
      <AIStatus />
      <span className="sb-sep" />
      <JobsButton />
      <span className="grow" />
      <ProjectFacts />
      {version && <span className="sb-item static sb-ver">v{version}</span>}
    </footer>
  );
}
