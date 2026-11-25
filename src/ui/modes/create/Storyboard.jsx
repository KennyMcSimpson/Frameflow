// 中栏「分镜板」：工具条、批量进度、分镜卡网格/列表、参考抽屉。
// 主色跟状态走（一屏只有一个主按钮）：还缺画面时主按钮是「生成全部画面」；画面齐了它变成次级的「重新配画面」，主色交给节奏条上的「下一步：进入剪辑」。
import React, { useCallback, useMemo, useRef, useState } from 'react';
import useStore from '../../store.js';
import { Button, Empty, Icon, ProgressBar, Spinner } from '../../components/ui.jsx';
import { useCreateUI, setUI } from './createState.js';
import * as actions from './createActions.js';
import { boardStats, mediaLayout, allShotsReady, hasRealFootage, isLocalOnlyAI } from './createUtils.js';
import ShotCard, { DND_SHOT, act } from './ShotCard.jsx';
import ReferenceResults from './ReferenceResults.jsx';
import PacingBar from './PacingBar.jsx';
import { useElapsed, CrSplitButton, CrSegmented, PopoverMenu } from './bits.jsx';

const NO_SHOTS = [];
const VIEW_OPTIONS = [
  { value: 'grid', icon: 'grid', title: '网格视图' },
  { value: 'list', icon: 'list', title: '列表视图' },
];
const BATCH_TITLES = { previz: '正在生成示意', references: '正在查找参考', footage: '正在配实拍素材', videogen: '正在 AI 生成视频' };

export const fillAll = () => act('fillAllFootage', actions.findAllFootage);
const genAllVideos = () => act('generateAllVideos', () => useStore.getState().toast?.('AI 视频生成需要先在设置里配置视频模型（可灵 / 即梦 / Runway 等）', 'warn'));

/** 打开简报抽屉：优先用全局 store.drawer（W1），否则用本模式状态 */
export function openBrief(open = true) {
  const st = useStore.getState();
  if ('drawer' in st) {
    if (typeof st.setDrawer === 'function') st.setDrawer(open ? 'brief' : null);
    else useStore.setState({ drawer: open ? 'brief' : null });
  } else setUI({ briefOpen: open });
}

function Toolbar({ stats, blocked, ready, readyCount }) {
  const view = useCreateUI((s) => s.view);
  const generating = useCreateUI((s) => s.board.busy);
  const hasShots = stats.count > 0;
  const [moreAnchor, setMoreAnchor] = useState(null);
  const moreRef = useRef(null);
  const closeMore = useCallback(() => setMoreAnchor(null), []);

  const genItems = [
    { icon: 'film', label: ready ? '换一批实拍素材' : '实拍素材（默认 · 免费可商用）', disabled: !hasShots || blocked, onClick: fillAll },
    { icon: 'sparkles', label: 'AI 生成真人视频', disabled: !hasShots || blocked, onClick: genAllVideos },
    'sep',
    { icon: 'wand', label: 'AI 预演（示意动画，非成品）', disabled: !hasShots || blocked, onClick: actions.generateAllPreviz },
    { icon: 'globe', label: '为全部镜头查找参考', disabled: !hasShots || blocked, onClick: actions.findAllReferences },
  ];
  const moreItems = [
    { icon: 'refresh', label: hasShots ? '重新生成分镜' : '让 AI 生成分镜', disabled: generating || blocked, onClick: () => actions.generateStoryboard() },
    { icon: 'bolt', label: '用本地模板快速生成', disabled: generating || blocked, onClick: actions.quickLocalStoryboard },
    'sep',
    { icon: 'plus', label: '添加一镜', onClick: () => actions.addShotAfter(null) },
  ];

  return (
    <header className="cr-board-bar">
      <div className="cr-board-title">
        <span className="cr-board-name">分镜板</span>
        {hasShots && (
          <span className="cr-board-stats" title={`分镜合计 ${stats.total.toFixed(1)} 秒${stats.target ? `，目标 ${stats.target} 秒` : ''}`}>
            {stats.count} 个镜头
            <span className={readyCount === stats.count ? 'cr-ready ok' : 'cr-ready'}> · 已有画面 {readyCount}/{stats.count}</span>
          </span>
        )}
      </div>
      <div className="cr-board-tools">
        {/* 画面齐了：降为次级的「重新配画面」，点了会先确认，只换实拍镜头 */}
        <CrSplitButton
          data-tour="create-generate"
          icon={ready ? 'refresh' : 'sparkles'}
          label={ready ? '重新配画面' : '生成全部画面'}
          variant={ready ? 'secondary' : 'primary'}
          disabled={!hasShots || blocked}
          onClick={fillAll}
          items={genItems}
          menuWidth={272}
        />
        <Button icon="book" onClick={() => openBrief(true)}>简报</Button>
        <span className="grow" />
        <CrSegmented size="sm" options={VIEW_OPTIONS} value={view} onChange={(v) => setUI({ view: v })} />
        <span ref={moreRef}>
          <button type="button" className="cr-icon-btn" title="更多" aria-label="更多" onClick={() => setMoreAnchor(moreAnchor ? null : moreRef.current)}><Icon name="dots" size={16} /></button>
        </span>
      </div>
      {moreAnchor && <PopoverMenu anchor={moreAnchor} items={moreItems} onClose={closeMore} />}
    </header>
  );
}

function BatchBar({ batch }) {
  const value = batch.total ? batch.done / batch.total : 0;
  return (
    <div className="cr-banner">
      <div className="row">
        <Spinner />
        <span className="grow ellipsis">{batch.cancelled ? '正在停止…' : `${BATCH_TITLES[batch.kind] || '处理中'} ${Math.min(batch.total, batch.done + 1)}/${batch.total}`}<span className="muted">　{batch.label}</span></span>
        <Button size="sm" variant="ghost" disabled={batch.cancelled} onClick={actions.cancelBatch}>取消</Button>
      </div>
      <ProgressBar value={value} />
    </div>
  );
}

function GeneratingBar({ board }) {
  const seconds = useElapsed(board.busy, board.startedAt);
  return (
    <div className="cr-banner ai">
      <div className="row">
        <Spinner ai />
        <span className="grow">{board.cancelling ? '正在取消…' : 'AI 导演正在写分镜，通常要一两分钟…'}</span>
        <span className="xs mono muted">{seconds}s</span>
        <Button size="sm" variant="ghost" disabled={board.cancelling} onClick={actions.cancelStoryboard}>取消</Button>
      </div>
      <ProgressBar ai indeterminate />
    </div>
  );
}

function BoardError({ message }) {
  return (
    <div className="cr-banner error" role="alert">
      <div className="selectable">分镜生成失败：{message}</div>
      <div className="row">
        <Button size="sm" icon="refresh" onClick={() => actions.generateStoryboard()}>重试</Button>
        <Button size="sm" variant="ghost" onClick={actions.quickLocalStoryboard}>用本地模板</Button>
      </div>
    </div>
  );
}

function EmptyBoard({ busy }) {
  const localOnly = isLocalOnlyAI(useStore((s) => s.aiStatus));
  if (localOnly) {
    return (
      <Empty
        icon="film"
        title="还没有分镜"
        action={(
          <div className="row wrap cr-empty-actions">
            <Button variant="primary" icon="bolt" disabled={busy} onClick={actions.quickLocalStoryboard}>用本地模板出分镜</Button>
            <Button variant="ghost" icon="plus" disabled={busy} onClick={() => actions.addShotAfter(null)}>手动添加</Button>
            <Button variant="ghost" icon="settings" onClick={() => { try { useStore.getState().openDialog('settings', 'ai'); } catch { /* ignore */ } }}>去连接 AI</Button>
          </div>
        )}
      >
        现在没有连接 AI：可以先在左边说说想拍什么，或者直接按创意简报用本地模板出一版分镜。连上 AI 后，分镜会更贴合你的想法。
      </Empty>
    );
  }
  return (
    <Empty
      icon="film"
      title="还没有分镜"
      action={(
        <div className="row wrap cr-empty-actions">
          <Button variant="ai" icon="sparkles" disabled={busy} onClick={() => actions.generateStoryboard()}>让 AI 生成分镜</Button>
          <Button disabled={busy} onClick={actions.quickLocalStoryboard}>用本地模板</Button>
          <Button variant="ghost" icon="plus" disabled={busy} onClick={() => actions.addShotAfter(null)}>手动添加</Button>
        </div>
      )}
    >
      先和左边的 AI 导演聊聊想拍什么，它会写好每个镜头和拍法，再一键配上实拍画面。
    </Empty>
  );
}

export default function Storyboard() {
  const shots = useStore((s) => s.project && s.project.storyboard) || NO_SHOTS;
  const brief = useStore((s) => s.project && s.project.brief);
  const assets = useStore((s) => s.project && s.project.assets);
  const aspect = useStore((s) => (s.project ? s.project.settings.aspect : '16:9'));
  const selectedShotId = useStore((s) => s.selection.shotId);
  const view = useCreateUI((s) => s.view);
  const batch = useCreateUI((s) => s.batch);
  const board = useCreateUI((s) => s.board);
  const drawerShotId = useCreateUI((s) => s.drawerShotId);

  const layout = useMemo(() => {
    const l = mediaLayout(aspect);
    return { ...l, cardMin: aspect === '16:9' ? 224 : l.cardMin - 16 };
  }, [aspect]);
  const stats = boardStats(shots, brief);
  const ready = allShotsReady(shots, assets);
  const readyCount = shots.filter((s) => hasRealFootage(s, assets)).length;

  const onDrop = (e) => {
    const shotId = e.dataTransfer.getData(DND_SHOT);
    const card = e.target.closest && e.target.closest('[data-shot-id]');
    if (!shotId || !card) return;
    e.preventDefault();
    const toIndex = shots.findIndex((s) => s.id === card.dataset.shotId);
    if (toIndex >= 0 && card.dataset.shotId !== shotId) actions.reorderShot(shotId, toIndex);
  };

  const gridStyle = { '--cr-card-min': `${layout.cardMin}px`, '--cr-box-ratio': layout.boxRatio, '--cr-frame-ratio': layout.frameRatio };

  return (
    <section className="cr-board" aria-label="分镜板">
      <Toolbar stats={stats} blocked={!!batch || board.busy} ready={ready} readyCount={readyCount} />
      {batch && <BatchBar batch={batch} />}
      {board.busy && <GeneratingBar board={board} />}
      {board.error && !board.busy && <BoardError message={board.error} />}

      <div className="cr-board-scroll" onClick={(e) => { if (e.target === e.currentTarget) useStore.getState().selectShot(null); }}>
        {shots.length ? (
          <div className={'cr-grid' + (view === 'list' ? ' list' : '')} style={gridStyle} onDrop={onDrop}>
            {shots.map((shot) => (
              <ShotCard
                key={shot.id}
                shot={shot}
                total={shots.length}
                view={view}
                aspect={aspect}
                layout={layout}
                selected={shot.id === selectedShotId}
              />
            ))}
            <button type="button" className="cr-add-shot" onClick={() => actions.addShotAfter(null)}>
              <Icon name="plus" size={18} />
              <span>添加一镜</span>
            </button>
          </div>
        ) : <EmptyBoard busy={board.busy} />}
      </div>

      <PacingBar shots={shots} assets={assets} target={stats.target} busy={!!batch || board.busy} selectedId={selectedShotId} onSelect={(id) => useStore.getState().selectShot(id)} />

      {drawerShotId && <ReferenceResults key={drawerShotId} shotId={drawerShotId} />}
    </section>
  );
}
