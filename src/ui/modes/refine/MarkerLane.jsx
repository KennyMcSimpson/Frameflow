// 时间线 · 标记行：project.markers 的小旗。单击跳转并选中，拖动改时间，右键删除（名称在属性区修改）。
import React, { memo, useState } from 'react';
import { useStore } from '../../store.js';
import { startDrag, round3 } from './timelineUtils.js';
import { applyOp, removeMarker, selectMarker } from './timelineActions.js';
import { seek, pause } from './usePlayback.js';

function MarkerLane({ markers, pps, height, tools, selectedId }) {
  const [draft, setDraft] = useState(null); // { id, t }
  const list = Array.isArray(markers) ? markers : [];

  const onDown = (e, m) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    selectMarker(m.id);
    let t1 = m.t;
    startDrag(e, {
      threshold: 3,
      cursor: 'ew-resize',
      onMove: (dx, dy, ev) => { t1 = round3(Math.max(0, tools.snap(m.t + dx / pps, [m.t]))); setDraft({ id: m.id, t: t1 }); tools.edgeScroll(ev.clientX); },
      onEnd: (dx, dy, ev, moved, cancelled) => {
        setDraft(null);
        if (!moved) { pause(); seek(m.t); return; }
        if (cancelled || Math.abs(t1 - m.t) < 1e-3) return;
        applyOp({ type: 'updateMarker', id: m.id, patch: { t: t1 } }, '移动标记');
      },
    });
  };

  return (
    <div className="tl-lane tl-lane-marker" data-lane="marker" style={{ height }}>
      {!list.length && <div className="tl-lane-ph small">标记：按 M 在播放头处打点，用于对齐节拍或备注</div>}
      {list.map((m) => {
        const t = draft && draft.id === m.id ? draft.t : m.t;
        return (
          <button
            key={m.id}
            type="button"
            className={'tl-marker' + (selectedId === m.id ? ' sel' : '')}
            style={{ left: t * pps, '--mk': m.color || 'var(--accent, #c8e250)' }}
            title={`${m.label || '标记'} · ${Number(t).toFixed(2)}s\n单击跳转，拖动移动，右键删除（名称在属性区修改）`}
            onPointerDown={(e) => onDown(e, m)}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); removeMarker(m.id); useStore.getState().toast('已删除标记'); }}
          >
            <span className="tl-marker-flag" />
            {m.label && pps > 20 && <span className="tl-marker-label">{m.label}</span>}
          </button>
        );
      })}
    </div>
  );
}

export default memo(MarkerLane);
