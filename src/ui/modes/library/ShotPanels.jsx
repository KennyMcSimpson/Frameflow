// 镜头条（横向关键帧缩略图）与镜头详情卡（关键帧大图 + AI 标注 + 统计 + 色板）。
import React, { useEffect, useRef, useState } from 'react';
import api from '../../api.js';
import { Icon, Chip } from '../../components/ui.jsx';
import {
  SHOT_SIZE_LABELS, ANGLE_LABELS, SHOT_MOVEMENT_LABELS, TRANSITION_LABELS,
} from '../../../engine/model.js';
import { Meter, PaletteSwatches } from './Charts.jsx';
import { fmtClock, fmtSec, pct } from './libraryUtils.js';

// ------------------------------------------------------------------
// 镜头条
// ------------------------------------------------------------------
export const ShotStrip = React.memo(function ShotStrip({ shots, selIdx, currentIdx, playing, onPick }) {
  const boxRef = useRef(null);
  useEffect(() => {
    const box = boxRef.current;
    if (!box || selIdx < 0) return;
    const el = box.querySelector(`[data-shot="${selIdx}"]`);
    if (!el) return;
    const left = el.offsetLeft; const right = left + el.offsetWidth;
    if (left < box.scrollLeft + 8 || right > box.scrollLeft + box.clientWidth - 8) {
      box.scrollTo({ left: Math.max(0, left - box.clientWidth / 2 + el.offsetWidth / 2), behavior: 'smooth' });
    }
  }, [selIdx]);

  if (!shots.length) {
    return <div className="lib-strip-empty">没有检测到镜头切换（可能是一镜到底，或视频过短）</div>;
  }
  return (
    <div className="lib-strip" ref={boxRef}>
      {shots.map((s, i) => (
        <button
          key={i}
          type="button"
          data-shot={i}
          className={'lib-strip-item' + (i === selIdx ? ' selected' : '') + (i === currentIdx && playing ? ' playing' : '')}
          onClick={() => onPick(i)}
          title={`第 ${i + 1} 镜 · ${fmtClock(s.start)}–${fmtClock(s.end)}${s.ai && s.ai.purpose ? ' · ' + s.ai.purpose : ''}`}
        >
          <span className="lib-strip-img">
            {s.thumb ? <img src={api.mediaUrl(s.thumb)} alt="" loading="lazy" draggable={false} /> : <Icon name="film" size={18} />}
            <span className="lib-strip-no">{i + 1}</span>
            <span className="lib-strip-dur mono">{s.duration.toFixed(1)}s</span>
            {i === currentIdx && playing && <span className="lib-strip-live" />}
          </span>
        </button>
      ))}
    </div>
  );
});

// ------------------------------------------------------------------
// 镜头详情卡
// ------------------------------------------------------------------
function label(map, v) {
  if (v == null || v === '') return '';
  return map[v] || String(v);
}

function AiField({ name, value }) {
  if (!value) return null;
  return (
    <div className="lib-aifield">
      <span className="k">{name}</span>
      <span className="v selectable">{value}</span>
    </div>
  );
}

export const ShotDetail = React.memo(function ShotDetail({ shot, index, total, onSeek, onPrev, onNext }) {
  const [kf, setKf] = useState(0);
  useEffect(() => { setKf(0); }, [shot]);
  if (!shot) {
    return <div className="lib-shotcard card"><div className="lib-strip-empty">选择一个镜头查看详情</div></div>;
  }
  const frames = shot.keyframes.length ? shot.keyframes : (shot.thumb ? [shot.thumb] : []);
  const big = frames[Math.min(kf, frames.length - 1)];
  const ai = shot.ai;
  const st = shot.stats;
  const warm = st ? st.warmth : 0;

  return (
    <div className="lib-shotcard card">
      <div className="lib-shotcard-head">
        <span className="lib-shotcard-no">第 {index + 1} 镜</span>
        <span className="xs muted mono">{fmtClock(shot.start)}–{fmtClock(shot.end)} · {fmtSec(shot.duration)}</span>
        <span className="grow" />
        <button type="button" className="btn ghost sm icon" title="上一镜" disabled={index <= 0} onClick={onPrev}><Icon name="chevronLeft" size={14} /></button>
        <button type="button" className="btn ghost sm icon" title="下一镜" disabled={index >= total - 1} onClick={onNext}><Icon name="chevronRight" size={14} /></button>
        <button type="button" className="btn sm" title="从这一镜开始播放" onClick={() => onSeek(shot.start, true)}><Icon name="play" size={12} />播放</button>
      </div>

      <div className="lib-shotcard-frame">
        {big ? <img src={api.mediaUrl(big)} alt={`第 ${index + 1} 镜关键帧`} draggable={false} /> : <div className="lib-noframe"><Icon name="image" size={26} />没有关键帧</div>}
      </div>
      {frames.length > 1 && (
        <div className="lib-kf-row">
          {frames.map((f, i) => (
            <button key={i} type="button" className={'lib-kf' + (i === kf ? ' active' : '')} onClick={() => setKf(i)} title={`关键帧 ${i + 1}`}>
              <img src={api.mediaUrl(f)} alt="" draggable={false} loading="lazy" />
            </button>
          ))}
        </div>
      )}

      <div className="lib-shotcard-sec">
        <div className="lib-sec-title"><Icon name="sparkles" size={12} />AI 标注</div>
        {ai ? (
          <>
            <div className="lib-chiprow">
              {ai.shotSize && <Chip kind="ai">{label(SHOT_SIZE_LABELS, ai.shotSize)}</Chip>}
              {ai.angle && <Chip kind="ai">{label(ANGLE_LABELS, ai.angle)}</Chip>}
              {ai.movement && <Chip kind="ai">{label(SHOT_MOVEMENT_LABELS, ai.movement)}</Chip>}
              {ai.transitionIn && <Chip>入场：{label(TRANSITION_LABELS, ai.transitionIn)}</Chip>}
            </div>
            <AiField name="光线" value={ai.lighting} />
            <AiField name="构图" value={ai.composition} />
            <AiField name="主体" value={ai.subject} />
            <AiField name="作用" value={ai.purpose} />
            <AiField name="笔记" value={ai.notes} />
          </>
        ) : (
          <div className="hint">这个镜头没有 AI 标注。下方是根据画面像素统计得到的客观数据。</div>
        )}
      </div>

      <div className="lib-shotcard-sec">
        <div className="lib-sec-title"><Icon name="sliders" size={12} />画面统计</div>
        {st ? (
          <>
            <Meter label="亮度" value={st.luma} kind="accent" />
            <Meter label="对比" value={st.contrast} kind="accent" />
            <Meter label="饱和" value={st.saturation} kind="violet" />
            <Meter label="冷暖" value={warm} bipolar kind={warm >= 0 ? 'warm' : 'cool'} display={Math.abs(warm) < 0.06 ? '中性' : (warm > 0 ? '暖 ' : '冷 ') + pct(Math.abs(warm))} />
          </>
        ) : <div className="hint">没有色彩统计</div>}
        <Meter label="运动" value={shot.motion} kind="info" />
        <Meter label="响度" value={shot.loudness} kind="ok" />
        {st && st.palette.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <PaletteSwatches palette={st.palette} size="s" />
          </div>
        )}
      </div>
    </div>
  );
});
