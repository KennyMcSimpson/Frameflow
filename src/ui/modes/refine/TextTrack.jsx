// 时间线 · 文字轨：TextClip 块（字幕组 group='caption' 用不同色），可拖动改起点、拖边改时长；可见区虚拟化。
import React, { memo, useCallback, useRef, useState } from 'react';
import { useStore } from '../../store.js';
import { Icon } from '../../components/ui.jsx';
import { startDrag, trimTextClip, round3, spanInView, shortDur } from './timelineUtils.js';
import { updateText } from './timelineActions.js';
import { seek, pause } from './usePlayback.js';

const PRESET_LABELS = {
  title: '标题', subtitle: '字幕', 'lower-third': '人名条', 'caption-box': '字幕框', 'big-bold': '大字报', handwrite: '手写', neon: '霓虹',
};

const TextBlock = memo(function TextBlock({ text, start, duration, pps, top, height, selected, dragging, onDown, onCtx }) {
  const left = start * pps;
  const width = Math.max(4, duration * pps);
  const cls = ['tl-item', 'tl-text', text.group === 'caption' ? 'g-caption' : '', selected ? 'sel' : '', text.locked ? 'locked' : '', dragging ? 'dragging' : ''].filter(Boolean).join(' ');
  const content = String(text.text || '').replace(/\s+/g, ' ').trim() || '（空文字）';
  return (
    <div
      className={cls}
      style={{ left, width, top, height }}
      data-text-id={text.id}
      title={`${text.group === 'caption' ? '字幕' : (PRESET_LABELS[text.preset] || '文字')}：${content}\n${start.toFixed(2)}s 起 · ${duration.toFixed(2)} 秒${text.locked ? '\n已锁定' : '\n拖动改位置，拖边缘改时长，双击跳到这里'}`}
      onPointerDown={(e) => onDown(e, text.id, 'body')}
      onDoubleClick={() => { pause(); seek(start); }}
      onContextMenu={(e) => onCtx(e, text.id)}
    >
      {width > 22 && <Icon name="text" size={11} />}
      {width > 40 && <span className="tl-text-label">{content}</span>}
      {(dragging || width > 90) && <span className={'tl-clip-dur mono' + (dragging ? ' on' : '')}>{dragging ? `${duration.toFixed(2)}s` : shortDur(duration)}</span>}
      {text.locked && width > 30 && <span className="tl-mini-icon" title="已锁定"><Icon name="lock" size={10} /></span>}
      <div className={'tl-handle l' + (text.locked ? ' off' : '')} onPointerDown={(e) => onDown(e, text.id, 'left')} />
      <div className={'tl-handle r' + (text.locked ? ' off' : '')} onPointerDown={(e) => onDown(e, text.id, 'right')} />
    </div>
  );
});

function TextTrack({ project, pps, rows, rowH, height, selectedId, tools, onMenu, flags, viewStart = 0, viewEnd = Infinity }) {
  const texts = project.tracks.text || [];
  const [draft, setDraft] = useState(null); // { id, start, duration }
  const live = useRef(null);
  const trackLocked = !!(flags && flags.locked);
  live.current = { texts, pps, tools, trackLocked };

  const onDown = useCallback((e, id, part) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const { texts: list, pps: z, tools: tl, trackLocked: tLock } = live.current;
    const text = list.find((t) => t.id === id);
    if (!text) return;
    const st = useStore.getState();
    if (st.selection.textId !== id) st.selectText(id);
    const s0 = Math.max(0, Number(text.start) || 0);
    const d0 = Math.max(0.2, Number(text.duration) || 0.2);
    const exclude = [s0, s0 + d0];
    let res = null;
    startDrag(e, {
      threshold: part === 'body' ? 4 : 2,
      cursor: part === 'body' ? 'grabbing' : 'ew-resize',
      onMove: (dx, dy, ev) => {
        if (text.locked || tLock) return;
        const dt = dx / z;
        if (part === 'body') {
          const snapped = tl.snapSpan(Math.max(0, s0 + dt), d0, exclude);
          res = { start: round3(Math.max(0, snapped)), duration: d0 };
        } else if (part === 'left') {
          const target = tl.snap(s0 + dt, exclude);
          res = trimTextClip(s0, d0, 'left', target - s0);
        } else {
          const target = tl.snap(s0 + d0 + dt, exclude);
          res = trimTextClip(s0, d0, 'right', target - (s0 + d0));
        }
        setDraft({ id, ...res });
        tl.edgeScroll(ev.clientX);
      },
      onEnd: (dx, dy, ev, moved, cancelled) => {
        setDraft(null);
        if (!moved || cancelled) return;
        if (text.locked || tLock) { useStore.getState().toast(tLock ? '文字轨已锁定，先在轨道头解锁' : '这段文字已锁定，先右键解锁'); return; }
        if (!res || (Math.abs(res.start - s0) < 1e-3 && Math.abs(res.duration - d0) < 1e-3)) return;
        updateText(id, { start: res.start, duration: res.duration }, part === 'body' ? '移动文字' : '调整文字时长');
      },
    });
  }, []);

  const onCtx = useCallback((e, id) => {
    e.preventDefault();
    e.stopPropagation();
    useStore.getState().selectText(id);
    onMenu(e, 'text', id);
  }, [onMenu]);

  const sorted = texts;

  return (
    <div className={'tl-lane tl-lane-text' + (flags && flags.hidden ? ' is-hidden' : '') + (trackLocked ? ' is-locked' : '')} data-lane="text" style={{ height }}>
      {!sorted.length && <div className="tl-lane-ph">拖入文字或按 T 添加</div>}
      {sorted.map((t) => {
        const d = draft && draft.id === t.id ? draft : null;
        const st0 = d ? d.start : Math.max(0, Number(t.start) || 0);
        const du0 = d ? d.duration : Math.max(0.2, Number(t.duration) || 0.2);
        if (!d && !spanInView(st0, st0 + du0, viewStart, viewEnd, 2)) return null;
        const row = rows[t.id] || 0;
        return (
          <TextBlock
            key={t.id}
            text={t}
            start={d ? d.start : Math.max(0, Number(t.start) || 0)}
            duration={d ? d.duration : Math.max(0.2, Number(t.duration) || 0.2)}
            pps={pps}
            top={3 + row * rowH}
            height={rowH - 4}
            selected={selectedId === t.id}
            dragging={!!d}
            onDown={onDown}
            onCtx={onCtx}
          />
        );
      })}
    </div>
  );
}

export default memo(TextTrack);
