// 素材面板 · 媒体（项目素材）：筛选下拉、网格、拖到时间线 / 画中画轨、右键菜单、导入、离线重新链接。
import React, { useCallback, useMemo, useState } from 'react';
import useStore from '../../store.js';
import api from '../../api.js';
import { Button, Empty, Icon, Select } from '../../components/ui.jsx';
import { AssetThumb } from '../../components/media.jsx';
import { insertAssets, addAudioTrack, setDragAssets, importFilesDialog, relinkAsset, isAssetOffline, addAssetToOverlay as addToOverlay } from '../../assetActions.js';
import { PopupMenu, insertionIndexAtPlayhead, assetUsage } from './MediaShared.jsx';
import { fmtDur, KIND_LABELS, assetSourceType, isAIAsset, isRealAsset, displayAssetName } from './SideData.js';

export const KIND_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'video', label: '视频' },
  { value: 'image', label: '图片' },
  { value: 'audio', label: '音频' },
  { value: 'real', label: '实拍' },
  { value: 'ai', label: 'AI' },
];

function matchKind(asset, filter) {
  if (filter === 'all') return true;
  if (filter === 'ai') return isAIAsset(asset);
  if (filter === 'real') return isRealAsset(asset);
  if (filter === 'image') return asset.kind === 'image' || asset.kind === 'generated-image';
  return asset.kind === filter;
}

function matchQuery(asset, q) {
  if (!q) return true;
  const hay = [asset.name, asset.description, ...(asset.tags || []), KIND_LABELS[asset.kind], assetSourceType(asset), asset.source && asset.source.platform]
    .filter(Boolean).join(' ').toLowerCase();
  return q.split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

export default function MediaProjectTab({ query, fixedKind }) {
  const project = useStore((s) => s.project);
  const selectedCount = useStore((s) => s.selection.clipIds.length);
  const [kindState, setKind] = useState('all');
  const kind = fixedKind || kindState;
  const [menu, setMenu] = useState(null);
  const [importing, setImporting] = useState(false);

  const assets = useMemo(() => Object.values((project && project.assets) || {}).filter((a) => a && a.id && a.kind !== 'sticker'), [project && project.assets]);
  const usage = useMemo(() => assetUsage(project), [project && project.tracks, project && project.overlays]);
  const q = (query || '').trim().toLowerCase();
  const list = useMemo(() => assets.filter((a) => matchKind(a, kind) && matchQuery(a, q)), [assets, kind, q]);
  const counts = useMemo(() => {
    const c = {};
    for (const f of KIND_FILTERS) c[f.value] = assets.filter((a) => matchKind(a, f.value)).length;
    return c;
  }, [assets]);

  const doImport = useCallback(async () => {
    if (importing) return;
    setImporting(true);
    try { await importFilesDialog(); } catch (e) { useStore.getState().toast('导入失败：' + e.message, 'error'); } finally { setImporting(false); }
  }, [importing]);

  const addToEnd = (asset) => {
    if (asset.kind === 'audio') {
      if (addAudioTrack(asset, 0, 'music')) useStore.getState().toast(`已作为背景音乐：${asset.name}`, 'ok');
      return;
    }
    insertAssets([asset], undefined, '添加到时间线：' + asset.name);
  };

  const insertAtPlayhead = (asset) => {
    const st = useStore.getState();
    if (asset.kind === 'audio') { addAudioTrack(asset, st.playhead, 'sfx'); return; }
    const at = insertionIndexAtPlayhead(st.project, st.playhead);
    insertAssets([asset], at, `插入到第${at}镜：${asset.name}`);
  };

  const replaceSelected = (asset) => {
    const st = useStore.getState();
    if (!st.selection.clipIds.length) { st.toast('请先在时间线上选择要替换的镜头', 'warn'); return; }
    const r = st.commit([{ type: 'replaceAsset', target: { mode: 'selected', indices: [], ids: [] }, assetId: asset.id }], '替换素材：' + asset.name);
    if (r.ok) st.toast(`已替换 ${st.selection.clipIds.length} 个镜头的素材，效果参数保留`, 'ok');
  };

  const removeAsset = (asset) => {
    const st = useStore.getState();
    if ((usage.get(asset.id) || 0) > 0) { st.toast('该素材正在时间线上使用，先删除相关镜头再移除', 'warn'); return; }
    const r = st.commit((p) => {
      const nextAssets = { ...p.assets };
      delete nextAssets[asset.id];
      const storyboard = (p.storyboard || []).map((s) => (s.assetId === asset.id ? { ...s, assetId: null } : s));
      return { ...p, assets: nextAssets, storyboard };
    }, '移除素材：' + asset.name);
    if (r.ok) st.toast(`已从项目移除「${asset.name}」（原文件未删除）`);
  };

  const openMenu = (e, asset) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect ? e.currentTarget.getBoundingClientRect() : null;
    const x = e.type === 'contextmenu' ? e.clientX : (rect ? rect.right - 4 : e.clientX);
    const y = e.type === 'contextmenu' ? e.clientY : (rect ? rect.bottom + 2 : e.clientY);
    setMenu({ x, y, asset });
  };

  const menuItems = (asset) => {
    const used = usage.get(asset.id) || 0;
    const isAudio = asset.kind === 'audio';
    const canMusic = isAudio || (asset.kind === 'video' && asset.hasAudio);
    return [
      { header: asset.name },
      { label: isAudio ? '作为背景音乐（从 0 秒开始）' : '添加到时间线末尾', icon: 'plus', onClick: () => addToEnd(asset) },
      { label: isAudio ? '在播放头位置放置音效' : '插入到播放头位置', icon: 'clock', onClick: () => insertAtPlayhead(asset) },
      !isAudio && {
        label: selectedCount > 1 ? `替换所选 ${selectedCount} 个镜头的素材` : '替换所选镜头的素材',
        icon: 'refresh',
        disabled: !selectedCount,
        hint: !selectedCount ? '先在时间线上选中镜头' : '保留调色、运镜、转场等效果',
        onClick: () => replaceSelected(asset),
      },
      canMusic && !isAudio && { label: '提取声音作为背景音乐', icon: 'music', onClick: () => { if (addAudioTrack(asset, 0, 'music')) useStore.getState().toast('已添加到音频轨', 'ok'); } },
      !isAudio && { label: '添加到画中画轨（播放头处）', icon: 'layers', onClick: () => addToOverlay(asset) },
      isAssetOffline(asset) && { label: '重新链接原文件…', icon: 'refresh', onClick: () => relinkAsset(asset) },
      { divider: true },
      asset.path && { label: '在文件夹中显示', icon: 'folder', onClick: () => api.call('shell:showItem', { path: asset.originalPath || asset.path }).catch((e) => useStore.getState().toast('无法打开文件夹：' + e.message, 'error')) },
      {
        label: '从项目移除', icon: 'trash', danger: true,
        disabled: used > 0,
        hint: used > 0 ? `正在时间线上使用（${used} 处），先删除相关镜头` : undefined,
        onClick: () => removeAsset(asset),
      },
    ];
  };

  if (!project) return <Empty icon="folder" title="没有打开的项目" />;

  return (
    <div className="mp-tab">
      <div className="mp-toolbar">
        {fixedKind ? (
          <span className="mp-toolbar-title">{fixedKind === 'audio' ? `项目音频 · ${counts.audio || 0}` : `${counts[fixedKind] || 0} 个素材`}</span>
        ) : (
          <Select
            className="mp-filter-select"
            value={kind}
            onChange={setKind}
            options={KIND_FILTERS.map((f) => ({ value: f.value, label: `${f.label}（${counts[f.value] || 0}）` }))}
          />
        )}
        <span className="grow" />
        <Button size="sm" icon="upload" onClick={doImport} disabled={importing} title="导入本地视频、图片或音乐">{importing ? '导入中…' : '导入'}</Button>
      </div>

      {!assets.length || (fixedKind && !counts[fixedKind]) ? (
        <Empty icon={fixedKind === 'audio' ? 'music' : 'upload'} title={fixedKind === 'audio' ? '还没有音频' : '还没有素材'} action={<Button variant="secondary" icon="upload" onClick={doImport} disabled={importing}>导入本地素材</Button>}>
          {fixedKind === 'audio' ? '导入本地音乐，或在上方「联网音乐」里搜索免版权配乐。' : '导入手机拍的视频、图片或音乐；也可以在「联网实拍」里搜索真人实拍素材。'}
        </Empty>
      ) : !list.length ? (
        <Empty icon="search" title="没有匹配的素材">换个关键词，或切换筛选。</Empty>
      ) : (
        <div className={'mp-grid' + (fixedKind === 'audio' ? ' audio' : '')}>
          {list.map((a) => {
            const used = usage.get(a.id) || 0;
            const offline = isAssetOffline(a);
            const isStill = a.kind === 'image' || a.kind === 'generated-image';
            const name = displayAssetName(a);
            return (
              <div
                key={a.id}
                className={'mp-card' + (used ? ' used' : '') + (offline ? ' offline' : '')}
                draggable={!offline}
                onDragStart={(e) => setDragAssets(e.dataTransfer, [a])}
                onContextMenu={(e) => openMenu(e, a)}
                onDoubleClick={() => (offline ? relinkAsset(a) : addToEnd(a))}
                title={`${name}\n双击添加到时间线，拖动到主轨或画中画轨，右键查看更多`}
              >
                <div className="mp-card-media">
                  {a.kind === 'audio'
                    ? <div className="mp-audio-thumb"><Icon name="music" size={20} /></div>
                    : <AssetThumb asset={a} width={160} height={90} style={{ width: '100%', height: '100%' }} />}
                  {used > 0 && <span className="mp-used" title={`已用在时间线 ${used} 处`}><Icon name="check" size={10} stroke={2.6} /></span>}
                  {!isStill && <span className="mp-badge dur">{fmtDur(a.duration)}</span>}
                  {offline && (
                    <button type="button" className="mp-offline" onClick={(e) => { e.stopPropagation(); relinkAsset(a); }} title="原文件找不到了，点击重新链接">
                      <Icon name="refresh" size={12} />离线 · 重新链接
                    </button>
                  )}
                  {!offline && (
                    <div className="mp-card-hover">
                      <button type="button" className="mp-round primary" title={a.kind === 'audio' ? '作为背景音乐' : '添加到时间线末尾'} onClick={(e) => { e.stopPropagation(); addToEnd(a); }}>
                        <Icon name="plus" size={16} />
                      </button>
                      <button type="button" className="mp-round mp-more" title="更多操作" onClick={(e) => openMenu(e, a)}>
                        <Icon name="dots" size={14} />
                      </button>
                    </div>
                  )}
                </div>
                <div className="mp-card-name ellipsis">{name}</div>
              </div>
            );
          })}
        </div>
      )}
      {menu && <PopupMenu x={menu.x} y={menu.y} items={menuItems(menu.asset)} onClose={() => setMenu(null)} />}
    </div>
  );
}
