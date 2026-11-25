// 拆片数据可视化：纯 SVG 手绘（不引第三方库）。
// RhythmChart 节奏图、CurvesChart 亮度/运动/响度曲线、ColorTimeline 色彩时间线、PaletteSwatches 主色板。
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { fmtClock, motionLevel, MOTION_LEVEL_LABELS, niceTicks, pct, shotIndexAt, timeStep, validHex, fmtSec } from './libraryUtils.js';

/** 监听容器宽度 */
export function useElementWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setWidth(Math.floor(el.clientWidth));
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0] ? Math.floor(entries[0].contentRect.width) : el.clientWidth;
      setWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ------------------------------------------------------------------
// 节奏图：每镜时长柱状，颜色按运动强度，平均线；点击柱跳转
// ------------------------------------------------------------------
export const RhythmChart = React.memo(function RhythmChart({ shots, avg, activeIndex = -1, onPick, height = 150 }) {
  const [ref, width] = useElementWidth();
  const [hover, setHover] = useState(-1);
  const list = shots || [];
  const PAD = { l: 34, r: 10, t: 10, b: 20 };
  const innerW = Math.max(10, width - PAD.l - PAD.r);
  const innerH = height - PAD.t - PAD.b;
  const maxDur = Math.max(0.5, ...list.map((s) => s.duration || 0), avg || 0) * 1.08;
  const ticks = niceTicks(maxDur, 4).filter((v) => v <= maxDur);
  const y = (v) => PAD.t + innerH - (clamp(v, 0, maxDur) / maxDur) * innerH;
  const slot = list.length ? innerW / list.length : innerW;
  const gap = slot > 6 ? Math.min(3, slot * 0.18) : 0;
  const labelEvery = Math.max(1, Math.ceil(26 / Math.max(1, slot)));
  const hv = hover >= 0 ? list[hover] : null;

  return (
    <div className="lib-chart" ref={ref}>
      <div className="lib-chart-head">
        <span className="lib-chart-title">节奏图</span>
        <span className="lib-chart-sub">每根柱子 = 一个镜头的时长</span>
        <span className="grow" />
        <span className="lib-legend"><i className="lv0" />{MOTION_LEVEL_LABELS[0]}</span>
        <span className="lib-legend"><i className="lv1" />{MOTION_LEVEL_LABELS[1]}</span>
        <span className="lib-legend"><i className="lv2" />{MOTION_LEVEL_LABELS[2]}</span>
      </div>
      <div className="lib-chart-readout">
        {hv ? `第 ${hover + 1} 镜 · ${fmtClock(hv.start)}–${fmtClock(hv.end)} · ${fmtSec(hv.duration)} · 运动 ${pct(hv.motion)}` : '把鼠标移到柱子上查看详情，点击跳到该镜头'}
      </div>
      {width > 0 && (
        <svg width={width} height={height} className="lib-svg" onMouseLeave={() => setHover(-1)}>
          {ticks.map((v) => (
            <g key={v}>
              <line className="grid" x1={PAD.l} x2={PAD.l + innerW} y1={y(v)} y2={y(v)} />
              <text className="axis" x={PAD.l - 6} y={y(v) + 3} textAnchor="end">{v}s</text>
            </g>
          ))}
          {list.map((s, i) => {
            const x = PAD.l + i * slot + gap / 2;
            const w = Math.max(1, slot - gap);
            const top = y(s.duration || 0);
            const cls = `bar lv${motionLevel(s.motion)}${i === activeIndex ? ' active' : ''}${i === hover ? ' hover' : ''}`;
            return (
              <g key={i} onMouseEnter={() => setHover(i)} onClick={() => onPick && onPick(i)} className="hit">
                <rect x={PAD.l + i * slot} y={PAD.t} width={slot} height={innerH} className="bar-hit" />
                <rect x={x} y={top} width={w} height={Math.max(1, PAD.t + innerH - top)} rx={Math.min(2, w / 3)} className={cls} />
                {i % labelEvery === 0 && <text className="axis" x={x + w / 2} y={height - 6} textAnchor="middle">{i + 1}</text>}
              </g>
            );
          })}
          {avg > 0 && (
            <g className="avg">
              <line x1={PAD.l} x2={PAD.l + innerW} y1={y(avg)} y2={y(avg)} />
              <text x={PAD.l + innerW - 2} y={y(avg) - 4} textAnchor="end">平均 {avg.toFixed(1)}s</text>
            </g>
          )}
          <line className="baseline" x1={PAD.l} x2={PAD.l + innerW} y1={PAD.t + innerH} y2={PAD.t + innerH} />
        </svg>
      )}
    </div>
  );
});

// ------------------------------------------------------------------
// 曲线：亮度 / 运动 / 响度，时间轴对齐，带当前播放位置竖线
// ------------------------------------------------------------------
function stepPath(shots, valueOf, x, y) {
  if (!shots.length) return '';
  let d = '';
  shots.forEach((s, i) => {
    const v = valueOf(s);
    const x0 = x(s.start); const x1 = x(s.end); const yy = y(v);
    d += i === 0 ? `M${x0.toFixed(1)},${yy.toFixed(1)}` : `L${x0.toFixed(1)},${yy.toFixed(1)}`;
    d += `L${x1.toFixed(1)},${yy.toFixed(1)}`;
  });
  return d;
}

function curvePath(values, step, x, y, maxPoints) {
  if (!values.length) return { line: '', area: '' };
  const bucket = Math.max(1, Math.ceil(values.length / Math.max(10, maxPoints)));
  const pts = [];
  for (let i = 0; i < values.length; i += bucket) {
    let m = 0;
    for (let j = i; j < Math.min(values.length, i + bucket); j++) m = Math.max(m, values[j] || 0);
    pts.push([x((i + bucket / 2) * step), y(m)]);
  }
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const base = y(0);
  const area = `${line}L${pts[pts.length - 1][0].toFixed(1)},${base.toFixed(1)}L${pts[0][0].toFixed(1)},${base.toFixed(1)}Z`;
  return { line, area };
}

export function CurvesChart({ shots, audioCurve, duration, time = 0, onSeek }) {
  const [ref, width] = useElementWidth();
  const [hoverT, setHoverT] = useState(null);
  const list = shots || [];
  const total = Math.max(0.1, duration || (list.length ? list[list.length - 1].end : 0));
  const LANE_H = 44; const LANE_GAP = 10; const AXIS_H = 18;
  const PAD = { l: 44, r: 10, t: 6 };
  const innerW = Math.max(10, width - PAD.l - PAD.r);
  const height = PAD.t + 3 * LANE_H + 2 * LANE_GAP + AXIS_H;
  const x = (t) => PAD.l + (clamp(t, 0, total) / total) * innerW;
  const curve = Array.isArray(audioCurve) ? audioCurve : [];

  const lanes = useMemo(() => {
    if (!width) return [];
    const mk = (i) => { const top = PAD.t + i * (LANE_H + LANE_GAP); return { top, y: (v) => top + LANE_H - clamp(v, 0, 1) * (LANE_H - 4) }; };
    const l0 = mk(0); const l1 = mk(1); const l2 = mk(2);
    const loud = curve.length
      ? curvePath(curve, 0.5, x, l2.y, innerW / 2)
      : { line: stepPath(list, (s) => s.loudness, x, l2.y), area: '' };
    return [
      { key: 'luma', label: '亮度', top: l0.top, line: stepPath(list, (s) => (s.stats ? s.stats.luma : 0), x, l0.y), area: '' },
      { key: 'motion', label: '运动', top: l1.top, line: stepPath(list, (s) => s.motion, x, l1.y), area: '' },
      { key: 'loud', label: '响度', top: l2.top, ...loud },
    ];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, list, curve, total]);

  const step = timeStep(total, innerW);
  const tTicks = [];
  for (let t = 0; t <= total + 1e-6 && tTicks.length < 200; t += step) tTicks.push(t);

  const tFromEvent = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return clamp(((e.clientX - rect.left - PAD.l) / innerW) * total, 0, total);
  };
  const readT = hoverT != null ? hoverT : time;
  const idx = shotIndexAt(list, readT);
  const shot = idx >= 0 ? list[idx] : null;
  const loudAt = curve.length ? curve[clamp(Math.floor(readT / 0.5), 0, curve.length - 1)] : (shot ? shot.loudness : 0);

  return (
    <div className="lib-chart" ref={ref}>
      <div className="lib-chart-head">
        <span className="lib-chart-title">亮度 · 运动 · 响度</span>
        <span className="lib-chart-sub">随时间变化，点击任意位置跳转</span>
      </div>
      <div className="lib-chart-readout mono">
        {fmtClock(readT)}{shot ? ` · 第 ${idx + 1} 镜` : ''} · 亮度 {pct(shot && shot.stats ? shot.stats.luma : 0)} · 运动 {pct(shot ? shot.motion : 0)} · 响度 {pct(loudAt)}
      </div>
      {width > 0 && (
        <svg
          width={width} height={height} className="lib-svg hit"
          onMouseMove={(e) => setHoverT(tFromEvent(e))}
          onMouseLeave={() => setHoverT(null)}
          onClick={(e) => onSeek && onSeek(tFromEvent(e))}
        >
          {list.map((s, i) => (i > 0 ? <line key={'b' + i} className="shot-edge" x1={x(s.start)} x2={x(s.start)} y1={PAD.t} y2={height - AXIS_H} /> : null))}
          {lanes.map((ln) => (
            <g key={ln.key} className={'lane ' + ln.key}>
              <rect className="lane-bg" x={PAD.l} y={ln.top} width={innerW} height={LANE_H} rx="3" />
              <line className="grid" x1={PAD.l} x2={PAD.l + innerW} y1={ln.top + LANE_H / 2} y2={ln.top + LANE_H / 2} />
              <text className="lane-label" x={PAD.l - 8} y={ln.top + LANE_H / 2 + 4} textAnchor="end">{ln.label}</text>
              {ln.area && <path className="area" d={ln.area} />}
              {ln.line && <path className="line" d={ln.line} />}
            </g>
          ))}
          {tTicks.map((t) => (
            <text key={t} className="axis" x={x(t)} y={height - 5} textAnchor={t === 0 ? 'start' : 'middle'}>{fmtClock(t)}</text>
          ))}
          {hoverT != null && <line className="hover-line" x1={x(hoverT)} x2={x(hoverT)} y1={PAD.t} y2={height - AXIS_H} />}
          <line className="playhead" x1={x(time)} x2={x(time)} y1={PAD.t - 2} y2={height - AXIS_H + 2} />
        </svg>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// 色板：全片主色 + 每镜色条「色彩时间线」
// ------------------------------------------------------------------
export function PaletteSwatches({ palette, size = 'm' }) {
  const list = (palette || []).filter(validHex);
  if (!list.length) return <span className="xs muted">暂无色板</span>;
  return (
    <div className={'lib-swatches ' + size}>
      {list.map((c, i) => (
        <div key={i} className="lib-swatch" title={c}>
          <span style={{ background: c }} />
          {size !== 's' && <em className="mono">{c.toUpperCase()}</em>}
        </div>
      ))}
    </div>
  );
}

export function ColorTimeline({ shots, duration, time = 0, activeIndex = -1, onPick, height = 44 }) {
  const [ref, width] = useElementWidth();
  const list = shots || [];
  const total = Math.max(0.1, duration || (list.length ? list[list.length - 1].end : 0));
  const PAD = { l: 0, r: 0 };
  const innerW = Math.max(10, width - PAD.l - PAD.r);
  const x = (t) => PAD.l + (clamp(t, 0, total) / total) * innerW;
  return (
    <div className="lib-colortl" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height + 8} className="lib-svg hit">
          {list.map((s, i) => {
            const pal = s.stats && s.stats.palette && s.stats.palette.length ? s.stats.palette : [];
            const x0 = x(s.start); const w = Math.max(1, x(s.end) - x0);
            const band = height / Math.max(1, pal.length || 1);
            return (
              <g key={i} onClick={() => onPick && onPick(i)}>
                <title>{`第 ${i + 1} 镜 · ${fmtClock(s.start)}–${fmtClock(s.end)}${pal.length ? ' · ' + pal.join(' ') : ''}`}</title>
                {pal.length
                  ? pal.map((c, k) => <rect key={k} x={x0} y={k * band} width={w} height={band + 0.5} fill={c} />)
                  : <rect x={x0} y={0} width={w} height={height} className="ct-empty" />}
                {i === activeIndex && <rect x={x0 + 0.5} y={0.5} width={Math.max(0, w - 1)} height={height - 1} className="ct-active" />}
              </g>
            );
          })}
          <line className="playhead" x1={x(time)} x2={x(time)} y1={0} y2={height + 6} />
        </svg>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// 小型指标条（镜头详情卡用）
// ------------------------------------------------------------------
export function Meter({ label, value, display, kind = 'accent', bipolar = false }) {
  const v = Number(value) || 0;
  const left = bipolar ? (v < 0 ? 50 + v * 50 : 50) : 0;
  const w = bipolar ? Math.abs(v) * 50 : clamp(v, 0, 1) * 100;
  return (
    <div className="lib-meter">
      <span className="lib-meter-label">{label}</span>
      <span className={'lib-meter-track' + (bipolar ? ' bipolar' : '')}>
        <span className={'lib-meter-fill ' + kind} style={{ left: `${left}%`, width: `${w}%` }} />
      </span>
      <span className="lib-meter-val mono">{display != null ? display : pct(v)}</span>
    </div>
  );
}
