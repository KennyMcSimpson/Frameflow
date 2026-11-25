// 单张分镜卡（v3 精简版）：画面 + 标题 + 台词 + 一行镜头语言。只在异常时显示状态。
import React, { memo, useCallback, useMemo, useRef, useState } from 'react';
import useStore from '../../store.js';
import api from '../../api.js';
import { Icon } from '../../components/ui.jsx';
import { PrevizCanvas, SourceDot } from '../../components/media.jsx';
import { SHOT_SIZE_LABELS, ANGLE_LABELS, SHOT_MOVEMENT_LABELS } from '../../../engine/model.js';
import { setUI, useCreateUI } from './createState.js';
import * as actions from './createActions.js';
import { frameSize, normalizeShot, shotSource, shotMetaLine, shotIssue } from './createUtils.js';
import { CrSplitButton, PopoverMenu, ProgressRing } from './bits.jsx';

export const DND_SHOT = 'application/x-ff-shot';

const FILL = { width: '100%', height: '100%' };
const UP = { transform: 'rotate(180deg)' };
const META_LABELS = { size: SHOT_SIZE_LABELS, angle: ANGLE_LABELS, movement: SHOT_MOVEMENT_LABELS };

/** 调用 createActions 中可能尚未提供的动作（W3/W4 提供），缺失时用 fallback */
export function act(name, fallback, ...args) {
  const fn = actions[name];
  if (typeof fn === 'function') return fn(...args);
  if (typeof fallback === 'function') return fallback(...args);
  return undefined;
}

export const fillShot = (id) => act('fillShotFootage', (sid) => actions.findShotFootage(sid, { replace: true }), id);
export const genShotVideo = (id) => act('generateShotVideo', () => useStore.getState().toast?.('AI 视频生成需要在设置里配置视频模型', 'warn'), id);

/** 视频画面：静止显示首帧，悬停静音循环播放 */
function ShotVideo({ asset, playing }) {
  const ref = useRef(null);
  React.useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (playing) { const p = v.play(); if (p && p.catch) p.catch(() => {}); } else v.pause();
  }, [playing]);
  return (
    <video
      ref={ref}
      className="cr-shot-video"
      src={api.mediaUrl(asset.path)}
      poster={asset.thumb ? api.mediaUrl(asset.thumb) : undefined}
      muted
      loop
      playsInline
      preload="metadata"
      onLoadedMetadata={(e) => { try { if (!asset.thumb) e.currentTarget.currentTime = Math.min(1, (e.currentTarget.duration || 0) / 3); } catch { /* 忽略 */ } }}
      style={FILL}
    />
  );
}

function Picture({ shot, source, aspect, hover }) {
  const { kind, asset } = source;
  if (asset && asset.path && !asset.missing && (asset.kind === 'video')) return <ShotVideo asset={asset} playing={hover} />;
  if (asset && (asset.thumb || ((asset.kind === 'image' || asset.kind === 'generated-image') && asset.path))) {
    return <img className="cr-shot-video" src={api.mediaUrl(asset.thumb || asset.path)} alt="" draggable={false} loading="lazy" style={FILL} />;
  }
  if (kind === 'previz') {
    const spec = (asset && asset.previz) || shot.previz;
    const size = frameSize(aspect, 240);
    if (spec) {
      return (
        <PrevizCanvas spec={spec} width={size.width} height={size.height} playing={hover} duration={shot.duration}
          shotSize={shot.shotSize} movement={shot.movement} watermark={false} style={FILL} />
      );
    }
  }
  return (
    <div className="cr-shot-empty">
      <Icon name="film" size={22} />
    </div>
  );
}

function ShotCard({ shot: rawShot, total, view, aspect, layout, selected }) {
  const shot = useMemo(() => normalizeShot(rawShot, rawShot.index || 1), [rawShot]);
  const assets = useStore((s) => s.project && s.project.assets);
  const busy = useCreateUI((s) => s.shotBusy[shot.id]);
  const [hover, setHover] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState(null);
  const [dropping, setDropping] = useState(false);
  const moreRef = useRef(null);
  const closeMenu = useCallback(() => setMenuAnchor(null), []);

  const source = useMemo(() => shotSource({ ...shot, aiVideoAssetId: rawShot.aiVideoAssetId, aiVideoTask: rawShot.aiVideoTask }, assets), [shot, rawShot, assets]);
  const issue = shotIssue({ ...shot, aiVideoAssetId: rawShot.aiVideoAssetId, aiVideoTask: rawShot.aiVideoTask }, assets, busy);
  const meta = shotMetaLine(shot, META_LABELS);
  const line = shot.caption || shot.voiceover;
  const isBusy = issue && issue.kind === 'busy';

  const swapItems = [
    { icon: 'film', label: source.kind === 'stock' ? '换一条实拍素材' : '配实拍素材（免费可商用）', disabled: isBusy, onClick: () => fillShot(shot.id) },
    { icon: 'sparkles', label: 'AI 生成真人视频', disabled: isBusy, onClick: () => genShotVideo(shot.id) },
    { icon: 'folder', label: '用我的素材 / 本地导入', onClick: () => setUI({ pickerShotId: shot.id }) },
    'sep',
    { icon: 'wand', label: '生成 AI 预演（示意）', disabled: isBusy, onClick: () => actions.generatePreviz(shot.id) },
    { icon: 'globe', label: '查找参考视频', onClick: () => { actions.findReferences(shot.id); setUI({ drawerShotId: shot.id }); } },
  ];

  const menuItems = [
    { icon: 'sliders', label: '编辑镜头属性', onClick: () => useStore.getState().selectShot(shot.id) },
    { icon: 'wand', label: 'AI 修改此镜', disabled: isBusy, onClick: () => setUI({ refineShotId: shot.id }) },
    'sep',
    { icon: 'chevronDown', iconStyle: UP, label: '上移', disabled: shot.index <= 1, onClick: () => actions.moveShot(shot.id, -1) },
    { icon: 'chevronDown', label: '下移', disabled: shot.index >= total, onClick: () => actions.moveShot(shot.id, 1) },
    { icon: 'copy', label: '复制', onClick: () => actions.copyShot(shot.id) },
    { icon: 'plus', label: '在后面插入新镜', onClick: () => actions.addShotAfter(shot.id) },
    'sep',
    { icon: 'trash', label: '删除', danger: true, onClick: () => actions.deleteShot(shot.id) },
  ];

  const dropProps = {
    onDragOver: (e) => {
      if (!e.dataTransfer.types.includes(DND_SHOT)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!dropping) setDropping(true);
    },
    onDragLeave: () => setDropping(false),
    onDrop: () => setDropping(false),
  };

  const stop = (e) => e.stopPropagation();

  return (
    <article
      className={['cr-shot', view === 'list' ? 'list' : '', selected ? 'selected' : '', dropping ? 'dropping' : '', menuAnchor ? 'menu-open' : ''].filter(Boolean).join(' ')}
      data-shot-id={shot.id}
      draggable
      tabIndex={0}
      onDragStart={(e) => { e.dataTransfer.setData(DND_SHOT, shot.id); e.dataTransfer.effectAllowed = 'move'; }}
      onClick={() => useStore.getState().selectShot(shot.id)}
      onKeyDown={(e) => { if (e.key === 'Enter') useStore.getState().selectShot(shot.id); }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      {...dropProps}
    >
      <div className="cr-shot-media">
        <div className={`cr-shot-frame fit-${layout.fit}`}>
          <Picture shot={shot} source={source} aspect={aspect} hover={hover && !isBusy} />
        </div>
        <span className="cr-shot-no mono">{String(shot.index).padStart(2, '0')}</span>
        <span className="cr-shot-dur mono">{shot.duration.toFixed(1)}s</span>
        {/* 来源点只在需要注意时出现：示意画面、还没有画面。有正常画面时不打扰 */}
        {(source.kind === 'previz' || source.kind === 'none') && <SourceDot kind={source.kind} className="cr-shot-dot" />}

        {!isBusy && (
          <div className="cr-shot-hover" onClick={stop}>
            <CrSplitButton size="sm" variant="glass" icon="refresh" label="换画面" onClick={() => fillShot(shot.id)} items={swapItems} />
            <span ref={moreRef}>
              <button type="button" className="cr-icon-btn glass" title="更多操作" aria-label="更多操作" onClick={() => setMenuAnchor(menuAnchor ? null : moreRef.current)}>
                <Icon name="dots" size={16} />
              </button>
            </span>
          </div>
        )}

        {isBusy && (
          <div className="cr-shot-busy" onClick={stop}>
            <ProgressRing value={issue.progress} />
            <span>{busy && busy.cancelling ? '正在取消…' : issue.label}</span>
            {(busy ? busy.jobId : rawShot.aiVideoTask) && (
              <button type="button" className="cr-link" disabled={busy && busy.cancelling} onClick={() => act('cancelShotVideo', actions.cancelShotJob, shot.id)}>取消</button>
            )}
          </div>
        )}
      </div>

      <div className="cr-shot-body">
        <h4 className="cr-shot-title ellipsis" title={shot.title}>{shot.title}</h4>
        {line && <p className="cr-shot-caption" title={line}>{line}</p>}
        <div className="cr-shot-meta">
          <span className="ellipsis">{meta}</span>
          {issue && issue.kind === 'missing' && <span className="cr-issue warn">缺画面</span>}
          {issue && issue.kind === 'error' && (
            <button type="button" className="cr-issue danger" title={issue.error} onClick={(e) => { stop(e); genShotVideo(shot.id); }}>失败 · 重试</button>
          )}
        </div>
      </div>

      {menuAnchor && <PopoverMenu anchor={menuAnchor} items={menuItems} onClose={closeMenu} />}
    </article>
  );
}

export default memo(ShotCard);
