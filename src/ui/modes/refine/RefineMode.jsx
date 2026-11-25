// 精修模式入口：剪映式四区 —— 左「素材」、中「播放器」、右「属性」、下「时间线」。
// 三条分隔条可拖动，尺寸写入 store.layout（持久化到 settings.ui）。AI 助手收进右侧抽屉，按需打开。
import React, { Component, useCallback, useEffect, useRef, useState } from 'react';
import '../../../styles/refine-side.css';
import { useStore, DEFAULT_LAYOUT } from '../../store.js';
import * as UI from '../../components/ui.jsx';
import MediaPanel from './MediaPanel.jsx';
import Preview from './Preview.jsx';
import Inspector from './Inspector.jsx';
import Timeline from './Timeline.jsx';
import AIEditPanel from './AIEditPanel.jsx';
import useShortcuts from './useShortcuts.js';
import { startDrag } from './timelineUtils.js';

const { Button, Icon } = UI;
const Empty = UI.EmptyState || UI.Empty;
const SPLIT = 6;
const LIMITS = { left: [240, 560], right: [260, 520], timeline: [170, 720] };
const MIN_CENTER = 360;
const MIN_TOP = 240;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** 用户未拖动过（与默认值相同）时按比例：左 26% / 右 26% / 时间线 38% */
function resolveSizes(layout, box) {
  const L = layout || DEFAULT_LAYOUT || {};
  const D = DEFAULT_LAYOUT || {};
  const pct = (v, dv, p, total) => (v == null || v === dv) && total > 0 ? Math.round(total * p) : v;
  let left = pct(L.refineLeft, D.refineLeft, 0.26, box.w) || 300;
  let right = pct(L.refineRight, D.refineRight, 0.26, box.w) || 320;
  let timeline = pct(L.timelineH, D.timelineH, 0.38, box.h) || 280;
  left = clamp(left, ...LIMITS.left); right = clamp(right, ...LIMITS.right); timeline = clamp(timeline, ...LIMITS.timeline);
  if (box.w > 0) {
    const room = box.w - MIN_CENTER - SPLIT * 2;
    if (left + right > room) {
      const k = Math.max(0, room) / (left + right);
      left = Math.max(200, Math.floor(left * k));
      right = Math.max(220, Math.floor(right * k));
    }
  }
  if (box.h > 0) timeline = Math.max(140, Math.min(timeline, box.h - MIN_TOP - SPLIT));
  return { left, right, timeline };
}

/** 面板级错误边界：某个面板出错时不拖垮整个精修界面 */
class PaneBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error(`[refine] ${this.props.name}出错`, error, info && info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="rf-pane-error">
        <Empty icon="help" title={`${this.props.name}暂时无法显示`} desc={`${String((this.state.error && this.state.error.message) || '未知错误')}。项目数据没有受影响。`}
          action={<Button size="sm" icon="refresh" onClick={() => this.setState({ error: null })}>重试</Button>} />
      </div>
    );
  }
}

export default function RefineMode() {
  const project = useStore((s) => s.project);
  const active = useStore((s) => s.mode === 'refine');
  const layout = useStore((s) => s.layout);
  const drawer = useStore((s) => s.drawer);
  const hasProject = !!project;
  useShortcuts(active && hasProject);

  const rootRef = useRef(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [live, setLive] = useState(null); // 拖动中的临时尺寸
  const [dragging, setDragging] = useState(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const update = () => setBox((b) => (b.w === el.clientWidth && b.h === el.clientHeight ? b : { w: el.clientWidth, h: el.clientHeight }));
    update();
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(update); ro.observe(el); }
    window.addEventListener('resize', update);
    return () => { if (ro) ro.disconnect(); window.removeEventListener('resize', update); };
  }, [hasProject]);

  const eff = live || resolveSizes(layout, box);

  const beginResize = useCallback((which) => (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = { ...resolveSizes(useStore.getState().layout, box) };
    let latest = start;
    setDragging(which);
    startDrag(e, {
      threshold: 0,
      cursor: which === 'timeline' ? 'row-resize' : 'col-resize',
      onMove: (dx, dy) => {
        const next = { ...start };
        if (which === 'left') next.left = clamp(start.left + dx, LIMITS.left[0], Math.min(LIMITS.left[1], box.w - start.right - MIN_CENTER - SPLIT * 2));
        if (which === 'right') next.right = clamp(start.right - dx, LIMITS.right[0], Math.min(LIMITS.right[1], box.w - start.left - MIN_CENTER - SPLIT * 2));
        if (which === 'timeline') next.timeline = clamp(start.timeline - dy, LIMITS.timeline[0], Math.min(LIMITS.timeline[1], box.h - MIN_TOP - SPLIT));
        latest = next;
        setLive(next);
      },
      onEnd: (dx, dy, ev, moved, cancelled) => {
        setDragging(null);
        setLive(null);
        if (cancelled || !moved) return;
        const st = useStore.getState();
        const patch = which === 'left' ? { refineLeft: latest.left } : which === 'right' ? { refineRight: latest.right } : { timelineH: latest.timeline };
        if (st.setLayout) st.setLayout(patch); else useStore.setState({ layout: { ...(st.layout || {}), ...patch } });
      },
    });
  }, [box]);

  const resetSize = useCallback((which) => () => {
    const st = useStore.getState();
    const key = which === 'left' ? 'refineLeft' : which === 'right' ? 'refineRight' : 'timelineH';
    const patch = { [key]: (DEFAULT_LAYOUT || {})[key] };
    if (st.setLayout) st.setLayout(patch); else useStore.setState({ layout: { ...(st.layout || {}), ...patch } });
  }, []);

  const toggleAI = () => {
    const st = useStore.getState();
    if (st.setDrawer) st.setDrawer('ai'); else useStore.setState({ drawer: st.drawer === 'ai' ? null : 'ai' });
  };
  const closeDrawer = () => {
    const st = useStore.getState();
    if (st.drawer !== 'ai') return;
    if (st.setDrawer) st.setDrawer('ai'); else useStore.setState({ drawer: null });
  };

  if (!project) {
    return (
      <div className="refine-empty">
        <Empty icon="film" title="还没有打开项目" desc="在启动页新建或打开一个项目后，就可以在这里精修剪辑。" />
      </div>
    );
  }

  const Drawer = UI.Drawer;
  const aiOpen = drawer === 'ai';

  return (
    <div
      className={'rf-grid' + (dragging ? ' resizing' : '')}
      ref={rootRef}
      style={{
        gridTemplateColumns: `${eff.left}px ${SPLIT}px minmax(0, 1fr) ${SPLIT}px ${eff.right}px`,
        gridTemplateRows: `minmax(0, 1fr) ${SPLIT}px ${eff.timeline}px`,
      }}
    >
      <section className="rf-media rf-cell" aria-label="素材" style={{ gridArea: '1 / 1 / 2 / 2' }}>
        <PaneBoundary name="素材区"><MediaPanel /></PaneBoundary>
      </section>
      <div
        className={'rf-gsplit v' + (dragging === 'left' ? ' active' : '')}
        style={{ gridArea: '1 / 2 / 2 / 3' }}
        onPointerDown={beginResize('left')}
        onDoubleClick={resetSize('left')}
        role="separator" aria-orientation="vertical" title="拖动调整素材区宽度，双击恢复默认"
      />
      <section className="rf-preview rf-cell" aria-label="播放器" style={{ gridArea: '1 / 3 / 2 / 4' }}>
        <PaneBoundary name="播放器"><Preview /></PaneBoundary>
        <button
          type="button"
          className={'rf-ai-fab' + (aiOpen ? ' on' : '')}
          onClick={toggleAI}
          title="AI 助手：用一句话修改视频"
          aria-pressed={aiOpen}
        >
          <Icon name="sparkles" size={16} /><span>AI 助手</span>
        </button>
      </section>
      <div
        className={'rf-gsplit v' + (dragging === 'right' ? ' active' : '')}
        style={{ gridArea: '1 / 4 / 2 / 5' }}
        onPointerDown={beginResize('right')}
        onDoubleClick={resetSize('right')}
        role="separator" aria-orientation="vertical" title="拖动调整属性区宽度，双击恢复默认"
      />
      <aside className="rf-inspector rf-cell" aria-label="属性" data-tour="refine-inspector" style={{ gridArea: '1 / 5 / 2 / 6' }}>
        <PaneBoundary name="属性区"><Inspector /></PaneBoundary>
      </aside>
      <div
        className={'rf-gsplit h' + (dragging === 'timeline' ? ' active' : '')}
        style={{ gridArea: '2 / 1 / 3 / 6' }}
        onPointerDown={beginResize('timeline')}
        onDoubleClick={resetSize('timeline')}
        role="separator" aria-orientation="horizontal" title="拖动调整时间线高度，双击恢复默认"
      />
      <section className="rf-timeline rf-cell" aria-label="时间线" data-tour="refine-timeline" style={{ gridArea: '3 / 1 / 4 / 6' }}>
        <PaneBoundary name="时间线"><Timeline /></PaneBoundary>
      </section>

      {Drawer ? (
        <Drawer open={aiOpen} side="right" width={380} title="AI 助手" icon="sparkles" onClose={closeDrawer} className="rf-ai-drawer">
          <PaneBoundary name="AI 助手"><AIEditPanel /></PaneBoundary>
        </Drawer>
      ) : aiOpen && (
        <div className="rf-ai-drawer-fallback">
          <div className="rf-ai-drawer-head"><Icon name="sparkles" size={14} /><b>AI 助手</b><span className="grow" /><Button size="sm" variant="ghost" icon="close" onClick={closeDrawer} /></div>
          <PaneBoundary name="AI 助手"><AIEditPanel /></PaneBoundary>
        </div>
      )}
    </div>
  );
}
