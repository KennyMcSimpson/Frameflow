// 素材面板共享：联网来源可用性、带任务面板的后台任务、联网下载、弹出菜单、播放头插入位置。
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import api from '../../api.js';
import useStore from '../../store.js';
import { Icon } from '../../components/ui.jsx';
import { layoutVideo, indexAtTime } from '../../../engine/timeline.js';

// ---------------- 联网来源 ----------------
export const WEB_SOURCES = [
  { id: 'commons', label: 'Wikimedia Commons', short: 'Commons', kinds: ['video', 'image', 'audio'], needs: null, videoSite: false },
  { id: 'openverse', label: 'Openverse（开放许可图片和音乐）', short: 'Openverse', kinds: ['image', 'audio'], needs: null, videoSite: false },
  { id: 'archive', label: '互联网档案馆（公有领域老影像）', short: '档案馆', kinds: ['video'], needs: null, videoSite: false },
  { id: 'nasa', label: 'NASA 影像库（公共领域的航天、地球影像）', short: 'NASA', kinds: ['video', 'image'], needs: null, videoSite: false },
  { id: 'pexels', label: 'Pexels', short: 'Pexels', kinds: ['video', 'image'], needs: 'pexels', videoSite: false },
  { id: 'pixabay', label: 'Pixabay', short: 'Pixabay', kinds: ['video', 'image'], needs: 'pixabay', videoSite: false },
  { id: 'bilibili', label: 'B站', short: 'B站', kinds: ['video', 'audio'], needs: 'ytdlp', videoSite: true },
  { id: 'youtube', label: 'YouTube', short: 'YouTube', kinds: ['video', 'audio'], needs: 'ytdlp', videoSite: true },
];
export const WEB_SOURCE_MAP = Object.fromEntries(WEB_SOURCES.map((s) => [s.id, s]));
export const WEB_KINDS = [
  { value: 'video', label: '视频' },
  { value: 'image', label: '图片' },
  { value: 'audio', label: '音乐' },
];
export const VIDEO_SITE_NOTICE = '版权归原作者，仅供学习参考';

let ytdlpCache = { at: 0, value: null, pending: null };

/** yt-dlp 状态（60 秒缓存，永不抛错） */
export async function getYtdlpStatus(force = false) {
  const now = Date.now();
  if (!force && ytdlpCache.value && now - ytdlpCache.at < 60000) return ytdlpCache.value;
  if (ytdlpCache.pending) return ytdlpCache.pending;
  ytdlpCache.pending = api.call('web:ytdlpStatus')
    .then((v) => {
      const value = { installed: !!(v && v.installed), path: v && v.path, version: v && v.version };
      ytdlpCache = { at: Date.now(), value, pending: null };
      return value;
    })
    .catch(() => {
      const info = useStore.getState().appInfo;
      const value = { installed: !!(info && info.ytdlp && info.ytdlp.ok), path: info && info.ytdlp && info.ytdlp.path, version: info && info.ytdlp && info.ytdlp.version };
      ytdlpCache = { at: Date.now(), value, pending: null };
      return value;
    });
  return ytdlpCache.pending;
}

export function setYtdlpCache(value) { ytdlpCache = { at: Date.now(), value, pending: null }; }

/**
 * 某来源当前是否可用。
 * @returns {{ ok:boolean, reason:string, fix: 'settings'|'ytdlp'|null }}
 */
export function sourceAvailability(sourceId, kind, { settings, ytdlpInstalled }) {
  const s = WEB_SOURCE_MAP[sourceId];
  if (!s) return { ok: false, reason: '未知来源', fix: null };
  if (!s.kinds.includes(kind)) {
    const what = kind === 'audio' ? '音乐' : kind === 'image' ? '图片' : '视频';
    return { ok: false, reason: `${s.label} 不提供${what}`, fix: null };
  }
  if (s.needs === 'pexels' && !(settings && settings.hasPexelsKey)) return { ok: false, reason: '需要在「设置 → 素材与联网」填写 Pexels API Key（免费申请）', fix: 'settings' };
  if (s.needs === 'pixabay' && !(settings && settings.hasPixabayKey)) return { ok: false, reason: '需要在「设置 → 素材与联网」填写 Pixabay API Key（免费申请）', fix: 'settings' };
  if (s.needs === 'ytdlp' && !ytdlpInstalled) return { ok: false, reason: '需要先安装视频下载组件 yt-dlp', fix: 'ytdlp' };
  return { ok: true, reason: '', fix: null };
}

/** 免版权图库中当前可用的来源（给「缺少素材」自动搜索用） */
export function stockSourcesFor(kind, settings) {
  return ['commons', 'openverse', 'archive', 'nasa', 'pexels', 'pixabay'].filter((id) => sourceAvailability(id, kind, { settings, ytdlpInstalled: false }).ok);
}

// ---------------- 后台任务（同步到任务面板，并暴露 jobId 以便取消） ----------------
export async function runTrackedJob(channel, payload, label, { onProgress, onStart } = {}) {
  let jid = null;
  const setJob = (patch) => {
    if (!jid) return;
    const jobs = useStore.getState().jobs || {};
    useStore.setState({ jobs: { ...jobs, [jid]: { ...(jobs[jid] || {}), jobId: jid, label, ...patch } } });
  };
  try {
    const result = await api.job(
      channel,
      payload,
      (p) => {
        if (!jid) jid = p.jobId;
        setJob({ kind: p.kind, stage: p.stage, progress: p.progress, message: p.message, status: 'running' });
        if (onProgress) onProgress(p);
      },
      (jobId) => {
        jid = jobId;
        setJob({ stage: '开始', progress: 0, message: '', status: 'running' });
        if (onStart) onStart(jobId);
      },
    );
    setJob({ status: 'done', progress: 1 });
    return result;
  } catch (e) {
    setJob({ status: e && e.cancelled ? 'cancelled' : 'error', message: e && e.message });
    throw e;
  } finally {
    if (jid) {
      const id = jid;
      setTimeout(() => {
        const jobs = { ...(useStore.getState().jobs || {}) };
        delete jobs[id];
        useStore.setState({ jobs });
      }, 6000);
    }
  }
}

/** 下载一个联网结果到项目，返回 Asset（失败抛中文错误；取消时 err.cancelled=true） */
export async function downloadWebResult(result, { onProgress, onStart } = {}) {
  const st = useStore.getState();
  if (!st.project) throw new Error('没有打开的项目');
  if (!result) throw new Error('没有可下载的结果');
  const maxSeconds = (st.settings && st.settings.web && st.settings.web.maxDownloadSeconds) || 180;
  const title = String(result.title || '联网素材').slice(0, 24);
  const r = await runTrackedJob(
    'web:download',
    { result, target: 'project', projectId: st.project.id, maxSeconds, withSubs: false },
    `下载：${title}`,
    { onProgress, onStart },
  );
  if (!r || !r.asset || !r.asset.id) throw new Error('下载已完成，但没有得到可用的素材文件');
  return r.asset;
}

/** 安全显示远程缩略图（http → https） */
export function remoteThumb(url) {
  if (!url || typeof url !== 'string') return null;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('http://')) return 'https://' + url.slice(7);
  return url;
}

// ---------------- 时间线位置 ----------------
/** 播放头所在位置对应的插入序号（1 起）：过镜头中点插到它后面，否则插到它前面 */
export function insertionIndexAtPlayhead(project, playhead) {
  if (!project) return 1;
  let layout = [];
  try { layout = layoutVideo(project) || []; } catch { layout = []; }
  if (!layout.length) return 1;
  const last = layout[layout.length - 1];
  if (playhead >= last.end) return layout.length + 1;
  let i = -1;
  try { i = indexAtTime(layout, playhead); } catch { i = -1; }
  if (i < 0) return playhead <= 0 ? 1 : layout.length + 1;
  const it = layout[i];
  return playhead - it.start > it.duration / 2 ? i + 2 : i + 1;
}

/** 素材在主轨/音频轨的使用次数 */
export function assetUsage(project) {
  const map = new Map();
  if (!project) return map;
  for (const c of project.tracks.video) map.set(c.assetId, (map.get(c.assetId) || 0) + 1);
  for (const c of project.tracks.audio) map.set(c.assetId, (map.get(c.assetId) || 0) + 1);
  for (const c of project.overlays || []) map.set(c.assetId, (map.get(c.assetId) || 0) + 1);
  return map;
}

// ---------------- 弹出菜单 ----------------
/**
 * 右键/更多菜单。items: [{ label, icon?, onClick, disabled?, hint?, danger? } | { divider:true } | { header:string }]
 */
export function PopupMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth; const vh = window.innerHeight;
    setPos({ left: Math.max(4, Math.min(x, vw - r.width - 6)), top: Math.max(4, Math.min(y, vh - r.height - 6)) });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const onBlur = () => onClose();
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    };
  }, [onClose]);

  return (
    <div className="side-menu" ref={ref} style={{ left: pos.left, top: pos.top }} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {items.filter(Boolean).map((it, i) => {
        if (it.divider) return <div key={i} className="side-menu-divider" />;
        if (it.header) return <div key={i} className="side-menu-header ellipsis">{it.header}</div>;
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={'side-menu-item' + (it.danger ? ' danger' : '')}
            disabled={!!it.disabled}
            title={it.hint || undefined}
            onClick={() => { if (it.disabled) return; onClose(); it.onClick && it.onClick(); }}
          >
            <Icon name={it.icon || 'dots'} size={14} style={{ opacity: it.icon ? 1 : 0 }} />
            <span className="grow">
              {it.label}
              {it.disabled && it.hint && <span className="side-menu-hint">{it.hint}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
