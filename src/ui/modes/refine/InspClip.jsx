// 属性 · 视频片段 / 画中画：头部信息 + 子页（画面 / 变速 / 动画 / 调节 / 音频）。
// 旧版的单文件检查器已拆成 InspVideo / InspSpeed / InspAnimation / InspAdjust / InspAudio，本文件负责组装。
import React, { useEffect } from 'react';
import useStore from '../../store.js';
import { Button, Icon } from '../../components/ui.jsx';
import { AssetThumb } from '../../components/media.jsx';
import { SubPages, usePage, runOps, TextDraft, InspSection, T_IDS } from './InspCommon.jsx';
import { clipDuration, trackFlags } from '../../../engine/timeline.js';
import { useTfUi } from './TransformOverlay.jsx';
import { fmtDur, KIND_LABELS } from './SideData.js';
import InspVideo, { ReplaceFootageButton } from './InspVideo.jsx';
import InspSpeed from './InspSpeed.jsx';
import { ClipAnimation } from './InspAnimation.jsx';
import InspAdjust from './InspAdjust.jsx';
import InspAudio from './InspAudio.jsx';

const CLIP_PAGES = [
  { id: 'video', label: '画面', icon: 'image' },
  { id: 'speed', label: '变速', icon: 'clock' },
  { id: 'anim', label: '动画', icon: 'sparkles' },
  { id: 'adjust', label: '调节', icon: 'palette' },
  { id: 'audio', label: '音频', icon: 'volume' },
];
const OVERLAY_PAGES = CLIP_PAGES.filter((p) => p.id === 'video' || p.id === 'audio');

export default function InspClip({ clips, indices = [], target = 'clip' }) {
  const project = useStore((s) => s.project);
  const [page, setPage] = usePage(target, 'video');
  const c0 = clips[0];
  const asset = project.assets[c0.assetId];
  const multi = clips.length > 1;
  const itemLocked = clips.some((c) => c.locked);
  const trackLocked = target === 'overlay'
    ? clips.some((c) => trackFlags(project, 'overlay', c.track || 1).locked)
    : trackFlags(project, 'video').locked;
  const locked = itemLocked || trackLocked;
  const ids = clips.map((c) => c.id);
  const pages = target === 'overlay' ? OVERLAY_PAGES : CLIP_PAGES;
  const cur = pages.some((p) => p.id === page) ? page : 'video';
  const dur = clipDuration(c0);
  const isFake = asset && (asset.kind === 'previz' || asset.source === 'previz');

  useEffect(() => {
    const applyTab = (tab) => {
      if (tab === 'speed') {
        if (target !== 'overlay') setPage('speed');
      } else if (tab === 'crop') {
        setPage('video');
        useTfUi.setState({ crop: true });
      }
      if (useStore.getState().inspectorTab === tab) useStore.setState({ inspectorTab: null });
    };
    const pending = useStore.getState().inspectorTab;
    if (pending === 'speed' || pending === 'crop') applyTab(pending);
    const onTab = (e) => {
      const tab = e && e.detail && e.detail.tab;
      if (tab === 'speed' || tab === 'crop') applyTab(tab);
    };
    window.addEventListener('ff:inspector-tab', onTab);
    return () => window.removeEventListener('ff:inspector-tab', onTab);
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleLock = () => {
    if (trackLocked) return;
    if (target === 'overlay') {
      const next = !itemLocked;
      const ops = ids.map((id) => ({ type: 'updateOverlay', id, patch: { locked: next } }));
      runOps(ops, next ? '锁定画中画' : '解锁画中画');
      return;
    }
    const op = { type: itemLocked ? 'unlock' : 'lock', target: T_IDS(ids) };
    runOps([op], itemLocked ? '解锁片段' : '锁定片段');
  };

  const title = target === 'overlay'
    ? `画中画 · 第${c0.track || 1}层`
    : multi ? `已选 ${clips.length} 个片段` : `片段 ${indices[0] + 1}`;

  return (
    <div className="insp">
      <div className="insp-head">
        <div className="insp-head-thumb">
          <AssetThumb asset={asset} width={64} height={36} showKind={false} />
          {isFake && <span className="insp-head-flag">示意</span>}
        </div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="insp-head-title ellipsis">{title}</div>
          <div className="xs muted ellipsis">
            {multi ? '修改会同时应用到全部所选片段' : `${(asset && asset.name) || '素材缺失'} · ${(asset && KIND_LABELS[asset.kind]) || ''} · ${fmtDur(dur)}`}
          </div>
        </div>
        <Button
          size="sm"
          variant={itemLocked ? 'danger' : 'ghost'}
          icon={locked ? 'lock' : 'unlock'}
          disabled={trackLocked}
          title={trackLocked ? '所在轨道已锁定，请先在轨道头解锁' : itemLocked ? (target === 'overlay' ? '解锁画中画' : '解锁片段') : (target === 'overlay' ? '锁定画中画（防止误改）' : '锁定片段（防止误改）')}
          onClick={toggleLock}
        />
      </div>
      {target !== 'overlay' && !multi && <ReplaceFootageButton clip={c0} disabled={locked} />}
      {locked && (
        <div className="insp-locked">
          <Icon name="lock" size={13} />
          <span className="grow">
            {trackLocked
              ? `${target === 'overlay' ? `画中画 ${c0.track || 1} 轨` : '主视频轨'}已锁定，请先在轨道头解锁。`
              : `${target === 'overlay' ? '画中画' : '片段'}已锁定，解锁后才能修改。`}
          </span>
          {!trackLocked && <Button size="sm" onClick={toggleLock}>解锁</Button>}
        </div>
      )}

      <SubPages pages={pages} value={cur} onChange={setPage} />
      <div className="insp-page-body" key={cur}>
        {cur === 'video' && <InspVideo items={clips} target={target} disabled={locked} />}
        {cur === 'speed' && <InspSpeed clips={clips} disabled={locked} />}
        {cur === 'anim' && <ClipAnimation clips={clips} indices={indices} disabled={locked} />}
        {cur === 'adjust' && <InspAdjust clips={clips} disabled={locked} />}
        {cur === 'audio' && <InspAudio items={clips} target={target} disabled={locked} />}
        {cur === 'video' && target === 'clip' && !multi && (
          <InspSection id="v-notes" title="备注" icon="book" defaultOpen={!!c0.notes}>
            <TextDraft value={c0.notes} rows={2} maxLength={4000} disabled={locked} placeholder="拍摄提醒、待办…（不会出现在成片里）"
              onCommit={(notes) => useStore.getState().commit((p) => ({ ...p, tracks: { ...p.tracks, video: p.tracks.video.map((c) => (c.id === c0.id ? { ...c, notes } : c)) } }), '修改备注')} />
          </InspSection>
        )}
      </div>
    </div>
  );
}
