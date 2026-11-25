// 时间线工具条：图标按钮 + 悬停提示（含快捷键），不可用时置灰。全部编辑动作经 timelineActions → store.apply。
import React, { memo } from 'react';
import { useStore } from '../../store.js';
import { kbdOf } from '../../shortcuts/registry.js';
import { useShortcutsVersion } from '../../shortcuts/customKeys.js';
import { zoomToSlider, sliderToZoom } from './timelineUtils.js';
import {
  splitAtPlayhead, rippleDeleteSelection, trimLeftAtPlayhead, trimRightAtPlayhead, freezeAtPlayhead,
  toggleReverse, toggleMirror, openInspectorTab, addMarkerAtPlayhead, useTimelineUI, zoomBy,
} from './timelineActions.js';

// 1.5px 描边线性图标（Lucide 风格），工具条专用
const P = {
  undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'm15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  split: 'M12 3v18M8 7l-3 5 3 5M16 7l3 5-3 5',
  ripple: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v6M14 10v6',
  trimL: 'M9 4v16M4 12h1M13 7l-4 5 4 5M15 6h5v12h-5',
  trimR: 'M15 4v16M20 12h-1M11 7l4 5-4 5M9 6H4v12h5',
  freeze: 'M12 2v20M4.9 4.9l14.2 14.2M2 12h20M4.9 19.1 19.1 4.9',
  reverse: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M10 9l-3 3 3 3M7 12h8',
  mirror: 'M12 3v18M8 7 3 12l5 5V7ZM16 7l5 5-5 5V7Z',
  crop: 'M6 2v14a2 2 0 0 0 2 2h14M18 22V8a2 2 0 0 0-2-2H2',
  speed: 'M12 14l4-4M3.3 19a10 10 0 1 1 17.4 0',
  marker: 'M6 3h12v13l-6 5-6-5V3Z',
  magnet: 'M6 15a6 6 0 0 0 12 0V4h-4v11a2 2 0 0 1-4 0V4H6v11ZM6 8h4M14 8h4',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  zoomIn: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM21 21l-5-5M11 8v6M8 11h6',
  zoomOut: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM21 21l-5-5M8 11h6',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5M8 12h8',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
};

export function TlIcon({ name, size = 16 }) {
  return (
    <svg className="tl-ico" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name] || ''} />
    </svg>
  );
}

export function ToolBtn({ icon, label, kbd, disabled, active, onClick, why }) {
  const tip = disabled && why ? `${label}（${why}）` : label;
  return (
    <button
      type="button"
      className={'tl-tbtn' + (active ? ' on' : '')}
      disabled={disabled}
      aria-label={tip}
      aria-pressed={active == null ? undefined : !!active}
      data-tip={tip}
      data-kbd={kbd || undefined}
      onClick={onClick}
    >
      <TlIcon name={icon} />
    </button>
  );
}

function TimelineToolbar({ layout, duration, pps, hasSelection, onFit }) {
  useShortcutsVersion();
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const playheadKey = useStore((s) => {
    const t = s.playhead;
    let u = '';
    let a = '';
    for (let i = 0; i < layout.length; i += 1) {
      const it = layout[i];
      if (!u && t > it.start && t < it.end) u = it.clip.id;
      if (!a && t >= it.start && t < it.end) a = it.clip.id;
      if (u && a) break;
    }
    return u + '|' + a;
  });
  const clipIds = useStore((s) => s.selection.clipIds);
  const snap = useTimelineUI((s) => s.snap);
  const link = useTimelineUI((s) => s.link);
  const ui = useTimelineUI.getState();

  const has = layout.length > 0;
  const [underId, atId] = playheadKey.split('|');
  const under = underId ? layout.find((it) => it.clip.id === underId) || null : null;
  const sel = layout.find((it) => (clipIds || []).includes(it.clip.id)) || (atId ? layout.find((it) => it.clip.id === atId) || null : null);
  const noClip = '先选中镜头或把播放头放在镜头上';

  return (
    <div className="tl-toolbar" role="toolbar" aria-label="时间线工具">
      <div className="tl-tool-group">
        <ToolBtn icon="undo" label="撤销" kbd={kbdOf('undo')} disabled={!canUndo} why="没有可撤销的操作" onClick={() => useStore.getState().undo()} />
        <ToolBtn icon="redo" label="重做" kbd={kbdOf('redo')} disabled={!canRedo} why="没有可重做的操作" onClick={() => useStore.getState().redo()} />
      </div>
      <span className="tl-tool-sep" />
      <div className="tl-tool-group">
        <ToolBtn icon="split" label="分割" kbd={kbdOf('split')} disabled={!under} why="播放头需在镜头内部" onClick={() => splitAtPlayhead()} />
        <ToolBtn icon="ripple" label="删除（波纹）" kbd={kbdOf('rippleDelete')} disabled={!hasSelection} why="先选中片段" onClick={() => rippleDeleteSelection()} />
        <ToolBtn icon="trimL" label="向左裁剪" kbd={kbdOf('trimLeft')} disabled={!under} why="播放头需在镜头内部" onClick={() => trimLeftAtPlayhead()} />
        <ToolBtn icon="trimR" label="向右裁剪" kbd={kbdOf('trimRight')} disabled={!under} why="播放头需在镜头内部" onClick={() => trimRightAtPlayhead()} />
      </div>
      <span className="tl-tool-sep" />
      <div className="tl-tool-group">
        <ToolBtn icon="freeze" label="定格（插入 2 秒静帧）" disabled={!under} why="播放头需在镜头内部" onClick={() => freezeAtPlayhead(2)} />
        <ToolBtn icon="reverse" label="倒放" active={!!(sel && sel.clip.reverse)} disabled={!sel} why={noClip} onClick={() => toggleReverse()} />
        <ToolBtn icon="mirror" label="镜像" active={!!(sel && sel.clip.mirror && sel.clip.mirror.h)} disabled={!sel} why={noClip} onClick={() => toggleMirror()} />
        <ToolBtn icon="crop" label="裁剪画面" disabled={!sel} why={noClip} onClick={() => openInspectorTab('crop')} />
        <ToolBtn icon="speed" label="变速" disabled={!sel} why={noClip} onClick={() => openInspectorTab('speed')} />
        <ToolBtn icon="marker" label="添加标记" kbd={kbdOf('addMarker')} disabled={!has && !(duration > 0)} why="时间线为空" onClick={() => addMarkerAtPlayhead()} />
      </div>
      <div className="grow" />
      <div className="tl-tool-group">
        <ToolBtn icon="magnet" label={snap ? '吸附：开' : '吸附：关'} kbd={kbdOf('toggleSnap')} active={snap} onClick={() => ui.setSnap(!snap)} />
        <ToolBtn icon="link" label={link ? '音画联动：开（移动镜头时字幕/配音跟随）' : '音画联动：关'} active={link} onClick={() => ui.setLink(!link)} />
      </div>
      <span className="tl-tool-sep" />
      <div className="tl-tool-group tl-zoom">
        <ToolBtn icon="zoomOut" label="缩小" kbd={kbdOf('zoomOut')} onClick={() => zoomBy(1 / 1.4)} />
        <input
          type="range" className="slider tl-zoom-slider" min={0} max={100} step={0.5}
          value={zoomToSlider(pps)}
          onChange={(e) => useStore.getState().setTimelineZoom(sliderToZoom(Number(e.target.value)))}
          aria-label="时间线缩放"
          title={`缩放：${Math.round(pps)} 像素/秒（Ctrl+滚轮）`}
        />
        <ToolBtn icon="zoomIn" label="放大" kbd={kbdOf('zoomIn')} onClick={() => zoomBy(1.4)} />
        <ToolBtn icon="fit" label="适配全片" kbd={kbdOf('zoomFit')} disabled={!(duration > 0)} why="时间线为空" onClick={onFit} />
        <ToolBtn icon="keyboard" label="快捷键" kbd={kbdOf('help')} onClick={() => useStore.getState().openDialog('shortcuts')} />
      </div>
    </div>
  );
}

export default memo(TimelineToolbar);
