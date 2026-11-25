// 轨道头（宽 120px）：图标 + 名称 + 锁定 / 隐藏 / 静音。状态读 project.tracks 上的 v3 轨道属性，改动经 setTrack op。
import React, { memo } from 'react';
import { setTrackProp } from './timelineActions.js';

const ICONS = {
  video: 'M3 6h13v12H3zM16 10l5-3v10l-5-3',
  overlay: 'M4 4h12v12H4zM8 8h12v12H8z',
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
  caption: 'M3 6h18v12H3zM7 11h4M13 11h4M7 14h10',
  audio: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  marker: 'M6 3h12v13l-6 5-6-5V3Z',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  unlock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 7.5-2',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.8M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 4.4-1',
  vol: 'M11 5 6 9H2v6h4l5 4V5ZM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14',
  mute: 'M11 5 6 9H2v6h4l5 4V5ZM22 9l-6 6M16 9l6 6',
  plus: 'M12 5v14M5 12h14',
};

function Ico({ d, size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
  );
}

function HeadBtn({ on, icon, offIcon, label, onClick }) {
  return (
    <button type="button" className={'tl-hbtn' + (on ? ' on' : '')} aria-pressed={!!on} aria-label={label} data-tip={label} onClick={onClick}>
      <Ico d={ICONS[on && offIcon ? offIcon : icon]} size={13} />
    </button>
  );
}

/**
 * @param kind  'video' | 'overlay' | 'text' | 'audio' | 'marker'
 * @param track 轨道键（setTrack 的 track 参数）：'video' / 'overlay:1' / 'text' / 'audio'
 * @param state { locked, hidden, muted }
 */
function TrackHeader({ kind, track, name, meta, height, state = {}, canHide = true, canMute = false, onAdd, addLabel }) {
  const s = state || {};
  const color = kind === 'marker' ? 'var(--accent, #c8e250)' : `var(--track-${kind === 'caption' ? 'text' : kind}, ${FALLBACK[kind] || '#888'})`;
  return (
    <div className={'tl-th k-' + kind + (s.locked ? ' locked' : '') + (s.hidden ? ' hidden' : '')} style={{ height, '--th-color': color }}>
      <span className="tl-th-bar" />
      <span className="tl-th-icon"><Ico d={ICONS[kind] || ICONS.video} /></span>
      <span className="tl-th-name" title={name}>{name}{meta ? <em>{meta}</em> : null}</span>
      {(s.locked || s.hidden || s.muted) && (
        <span className="tl-th-state" aria-hidden="true">
          {s.locked && <Ico d={ICONS.lock} size={11} />}
          {s.hidden && <Ico d={ICONS.eyeOff} size={11} />}
          {s.muted && <Ico d={ICONS.mute} size={11} />}
        </span>
      )}
      {kind !== 'marker' && (
        <span className="tl-th-btns">
          {onAdd && <button type="button" className="tl-hbtn" aria-label={addLabel} data-tip={addLabel} onClick={onAdd}><Ico d={ICONS.plus} size={13} /></button>}
          <HeadBtn on={s.locked} icon="unlock" offIcon="lock" label={s.locked ? '解锁轨道' : '锁定轨道'} onClick={() => setTrackProp(track, { locked: !s.locked })} />
          {canHide && <HeadBtn on={s.hidden} icon="eye" offIcon="eyeOff" label={s.hidden ? '显示轨道' : '隐藏轨道'} onClick={() => setTrackProp(track, { hidden: !s.hidden })} />}
          {canMute && <HeadBtn on={s.muted} icon="vol" offIcon="mute" label={s.muted ? '取消静音' : '静音轨道'} onClick={() => setTrackProp(track, { muted: !s.muted })} />}
        </span>
      )}
    </div>
  );
}

const FALLBACK = { video: '#5aa9ff', overlay: '#b07cff', text: '#f0b450', caption: '#ff8a5c', audio: '#3ecf8e' };

export default memo(TrackHeader);
