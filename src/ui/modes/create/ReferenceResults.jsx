// 联网参考结果抽屉：缩略图、来源、许可，打开原网页 / 下载到素材 / 下载并拆片学习。
import React, { useEffect, useState } from 'react';
import useStore from '../../store.js';
import { Button, Chip, Empty, Icon, ProgressBar, Spinner, fmtTime } from '../../components/ui.jsx';
import { useCreateUI, setUI } from './createState.js';
import {
  findReferences, downloadReference, cancelDownload, analyzeReference, cancelAnalyze, openExternal, assignAsset,
} from './createActions.js';
import { SOURCE_LABELS } from './createLabels.js';
import { findAssetForResult, resultKey, shotQueries } from './createUtils.js';

const NO_RESULTS = [];
const isRestricted = (license) => /版权归|仅供学习/.test(license || '');

function ResultThumb({ result }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="cr-ref-thumb">
      {result.thumb && !broken
        ? <img src={result.thumb} alt="" referrerPolicy="no-referrer" loading="lazy" draggable={false} onError={() => setBroken(true)} />
        : <Icon name="film" size={20} />}
      {Number(result.duration) > 0 && <span className="cr-ref-dur mono">{fmtTime(result.duration, false)}</span>}
    </div>
  );
}

function TaskProgress({ label, task, onCancel }) {
  return (
    <div className="cr-ref-task">
      <div className="row">
        <span className="xs muted grow">{label} {Math.round((task.progress || 0) * 100)}%</span>
        <Button size="sm" variant="ghost" disabled={!task.jobId} onClick={onCancel}>取消</Button>
      </div>
      <ProgressBar value={task.progress} indeterminate={!task.progress} />
    </div>
  );
}

function ResultCard({ result, shotId, shotAssetId }) {
  const key = resultKey(result);
  const download = useCreateUI((s) => s.downloads[key]);
  const analysis = useCreateUI((s) => s.analyzing[key]);
  const asset = useStore((s) => (s.project ? findAssetForResult(s.project.assets, result) : null))
    || (download && download.assetId ? { id: download.assetId } : null);
  const downloading = !!download && download.status === 'running';
  const analyzing = !!analysis && analysis.status === 'running';
  const assigned = !!asset && asset.id === shotAssetId;

  return (
    <div className="cr-ref-card">
      <ResultThumb result={result} />
      <div className="cr-ref-info">
        <div className="cr-ref-title selectable" title={result.title}>{result.title}</div>
        <div className="cr-ref-meta">
          <span>{SOURCE_LABELS[result.source] || result.source}</span>
          {result.author && <span className="ellipsis" title={result.author}>{result.author}</span>}
        </div>
        {result.license && <Chip kind={isRestricted(result.license) ? 'warn' : 'ok'} title={result.license}><span className="cr-chip-text">{result.license}</span></Chip>}

        {downloading && <TaskProgress label="下载中" task={download} onCancel={() => cancelDownload(result)} />}
        {analyzing && <TaskProgress label="拆片中" task={analysis} onCancel={() => cancelAnalyze(result)} />}
        {download && download.status === 'error' && <div className="cr-ref-error selectable">{download.error}</div>}
        {analysis && analysis.status === 'error' && <div className="cr-ref-error selectable">{analysis.error}</div>}

        <div className="cr-ref-actions">
          <Button size="sm" variant="ghost" icon="external" onClick={() => openExternal(result.url)}>打开原网页</Button>
          {asset ? (
            <Button size="sm" icon={assigned ? 'check' : 'plus'} active={assigned} disabled={assigned} onClick={() => assignAsset(shotId, asset.id)}>
              {assigned ? '已是本镜素材' : '设为本镜素材'}
            </Button>
          ) : (
            <Button size="sm" icon="download" disabled={downloading} onClick={() => downloadReference(result)}>下载到素材</Button>
          )}
          {analysis && analysis.status === 'done'
            ? <Chip kind="ok">已入拆片库</Chip>
            : <Button size="sm" variant="ai" icon="layers" disabled={analyzing} onClick={() => analyzeReference(result)}>下载并拆片学习</Button>}
        </div>
      </div>
    </div>
  );
}

export default function ReferenceResults({ shotId }) {
  const shot = useStore((s) => (s.project ? s.project.storyboard.find((x) => x.id === shotId) : null));
  const results = useStore((s) => s.project && s.project.references && s.project.references[shotId]) || NO_RESULTS;
  const status = useCreateUI((s) => s.refStatus[shotId]);
  const ytdlp = useCreateUI((s) => s.ytdlp);
  const [query, setQuery] = useState('');
  const close = () => setUI({ drawerShotId: null });

  useEffect(() => {
    if (!shot) return;
    const { zh, en } = shotQueries(shot);
    setQuery(zh || en);
    // 只在切换分镜时重置搜索词，用户正在改的词不被覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotId]);

  useEffect(() => {
    // 弹窗开着时 Esc 属于弹窗
    const onKey = (e) => {
      const ui = useCreateUI.getState();
      if (e.key === 'Escape' && !ui.editorShotId && !ui.pickerShotId && !ui.refineShotId && !ui.confirm) setUI({ drawerShotId: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!shot) return null;
  const loading = !!(status && status.loading);
  const errors = (status && status.errors) || [];
  const submit = (e) => {
    e.preventDefault();
    findReferences(shotId, { query: query.trim() || undefined });
  };

  return (
    <aside className="cr-drawer" aria-label="参考视频">
      <header className="panel-head">
        <Icon name="globe" size={15} />
        <span className="panel-title grow ellipsis">参考视频 · 第 {shot.index} 镜 {shot.title}</span>
        <Button variant="ghost" size="sm" icon="close" title="关闭" onClick={close} />
      </header>

      <form className="cr-drawer-search" onSubmit={submit}>
        <input type="search" className="input" value={query} placeholder="换个词搜索…" onChange={(e) => setQuery(e.target.value)} />
        <Button size="sm" icon="search" type="submit" disabled={loading}>搜索</Button>
      </form>

      <div className="cr-drawer-body">
        {ytdlp && !ytdlp.installed && (
          <div className="callout warn cr-drawer-note">
            当前只搜免版权素材库。安装 yt-dlp 后可以搜 B站 和 YouTube 上的同类视频。
            <Button size="sm" variant="ghost" onClick={() => useStore.getState().openDialog('settings', 'media')}>打开设置</Button>
          </div>
        )}
        {results.some((r) => isRestricted(r.license)) && (
          <div className="callout cr-drawer-note">视频站内容版权归原作者，适合学习参考。公开发布请用免版权素材或自己拍摄。</div>
        )}
        {errors.map((err) => (
          <div key={`${err.source}:${err.error}`} className="cr-ref-error selectable">{SOURCE_LABELS[err.source] || err.source}：{err.error}</div>
        ))}

        {loading && <div className="cr-drawer-loading"><Spinner /><span>正在联网搜索…</span></div>}
        {!loading && !results.length && (
          <Empty icon="search" title={status ? '没有找到合适的视频' : '还没有搜索'}>
            {status ? '换个更通用的词试试，比如只保留主体和动作。' : '点「搜索」联网查找这一镜的同类视频。'}
          </Empty>
        )}
        {results.map((result) => (
          <ResultCard key={resultKey(result)} result={result} shotId={shotId} shotAssetId={shot.assetId} />
        ))}
      </div>
    </aside>
  );
}
