// 时间线 · 标尺：只渲染可见区域的自适应刻度。点击/拖动移动播放头，Shift+拖动框选范围（由 Timeline 处理）。
import React, { memo } from 'react';
import { chooseTickStep, ticksInView, formatRulerTime } from './timelineUtils.js';

function isMultiple(t, step) {
  const q = t / step;
  return Math.abs(q - Math.round(q)) < 1e-6;
}

function TimelineRuler({ pps, viewStart, viewEnd, width, height, onPointerDown, duration, visibleRight = Infinity }) {
  const { major, minor } = chooseTickStep(pps);
  const a = Math.max(0, viewStart);
  const b = Math.max(a, viewEnd);
  const majors = ticksInView(a, b, major);
  const minors = minor ? ticksInView(a, b, minor).filter((t) => !isMultiple(t, major)) : [];
  const endX = Math.max(0, duration) * pps;
  return (
    <div
      className="tl-ruler"
      style={{ width, height }}
      onPointerDown={onPointerDown}
      title="点击或拖动移动播放头；按住 Shift 拖动框选一段"
    >
      {duration > 0 && <div className="tl-ruler-content" style={{ width: endX }} />}
      {minors.map((t) => <span key={'m' + t} className="tl-tick minor" style={{ left: t * pps }} />)}
      {majors.map((t) => (
        <span key={'M' + t} className="tl-tick major" style={{ left: t * pps }}>
          {t * pps + 44 <= Math.min(width, visibleRight) && <span className="tl-tick-label mono">{formatRulerTime(t, major)}</span>}
        </span>
      ))}
    </div>
  );
}

export default memo(TimelineRuler);
