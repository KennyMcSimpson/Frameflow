// 属性 · 视频片段 / 画中画：头部信息 + 子页（画面 / 变速 / 动画 / 调节 / 音频）。
// 旧版的单文件检查器已拆成 InspVideo / InspSpeed / InspAnimation / InspAdjust / InspAudio，本文件负责组装。
import React from 'react';
import useStore from '../../store.js';
import { Button, Icon } from '../../components/ui.jsx';
import { AssetThumb } from '../../components/media.jsx';
import { SubPages, usePage, runOps, TextDraft, InspSection, T_IDS } from './InspCommon.jsx';
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
  const locked = clips.some((c) => c.locked);
  const ids = clips.map((c) => c.id);
  const pages = target === 'overlay' ? OVERLAY_PAGES : CLIP_PAGES;
  const cur = pages.some((p) => p.id === page) ? page : 'video';
  const dur = c0.still ? Math.max(0.2, c0.out - c0.in) : (c0.out - c0.in) / (c0.speed || 1);
  const isFake = asset && (asset.kind === 'previz' || asset.source === 'previz');

  const toggleLock = () => {
    const op = { type: locked ? 'unlock' : 'lock', target: T_IDS(ids) };
    runOps([op], locked ? '解锁片段' : '锁定片段');
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
        {target === 'clip' && (
          <Button size="sm" variant={locked ? 'danger' : 'ghost'} icon={locked ? 'lock' : 'unlock'} title={locked ? '解锁片段' : '锁定片段（防止误改）'} onClick={toggleLock} />
        )}
      </div>
      {!multi && <ReplaceFootageButton clip={c0} disabled={locked} />}
      {locked && (
        <div className="insp-locked">
          <Icon name="lock" size={13} /><span className="grow">片段已锁定，解锁后才能修改。</span>
          <Button size="sm" onClick={toggleLock}>解锁</Button>
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
            <TextDraft value={c0.notes} rows={2} maxLength={4000} placeholder="拍摄提醒、待办…（不会出现在成片里）"
              onCommit={(notes) => useStore.getState().commit((p) => ({ ...p, tracks: { ...p.tracks, video: p.tracks.video.map((c) => (c.id === c0.id ? { ...c, notes } : c)) } }), '修改备注')} />
          </InspSection>
        )}
      </div>
    </div>
  );
}
