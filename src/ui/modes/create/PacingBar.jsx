// 节奏条：分镜板下方按时长比例显示每镜色块（镜号+秒数，段内铺画面缩略图），总时长与节奏提示，并给出「下一步：进入剪辑」按钮。
// 主色跟状态走：还有镜头缺画面时，主按钮是工具栏的「生成全部画面」，这里降为次级；画面齐了这里才是主按钮。
import React from 'react';
import api from '../../api.js';
import { Icon } from '../../components/ui.jsx';
import * as actions from './createActions.js';
import { hasRealFootage, shotSource } from './createUtils.js';

/** 秒数统一写法，与分镜卡一致：4.0s；一分钟以上 1:05 */
export function fmtSeconds(sec) {
  const v = Math.round((Number(sec) || 0) * 10) / 10;
  if (v < 60) return `${v.toFixed(1)}s`;
  const m = Math.floor(v / 60);
  return `${m}:${String(Math.round(v - m * 60)).padStart(2, '0')}`;
}
const fmt = fmtSeconds;

/** 段内缩略图：有封面图就用，图片素材直接用原图；视频没有封面时不铺 */
function segThumb(shot, assets) {
  const { kind, asset } = shotSource(shot, assets);
  if (!asset || kind === 'previz' || kind === 'none') return '';
  const src = asset.thumb || ((asset.kind === 'image' || asset.kind === 'generated-image') ? asset.path : '');
  if (!src) return '';
  try { return api.mediaUrl(src); } catch { return ''; }
}

/** 按平均单镜时长给节奏提示 */
export function pacingHint(avg) {
  if (!(avg > 0)) return null;
  if (avg < 1.8) return { label: '偏快', tone: 'warn', tip: '单镜平均不足 2 秒，信息可能看不清' };
  if (avg <= 4.5) return { label: '适中', tone: 'ok', tip: '短视频常见节奏，观感紧凑' };
  if (avg <= 7) return { label: '舒缓', tone: 'ok', tip: '适合叙事、氛围类内容' };
  return { label: '偏慢', tone: 'warn', tip: '单镜偏长，可让 AI 导演“节奏快一点”' };
}

export default function PacingBar({ shots, assets, target, busy, onSelect, selectedId }) {
  const list = shots || [];
  if (!list.length) return null;
  const durs = list.map((s) => Math.max(0.1, Number(s.duration) || 0));
  const total = durs.reduce((a, b) => a + b, 0);
  const hint = pacingHint(total / list.length);
  const flags = list.map((s) => hasRealFootage(s, assets));
  const ready = flags.filter(Boolean).length;
  const allReady = ready === list.length;

  return (
    <section className="cr-pace" aria-label="节奏与下一步">
      <div className="cr-pace-head">
        <span className="cr-pace-title"><Icon name="clock" size={14} />节奏</span>
        <span className="cr-pace-total">分镜合计 <b>{fmt(total)}</b>{target ? <span className="muted"> / 目标 {fmt(target)}</span> : null}</span>
        {hint && <span className={'cr-pace-hint ' + hint.tone} title={hint.tip}>{hint.label}</span>}
        {hint && <span className="cr-pace-tip">{hint.tip}</span>}
      </div>
      <div className="cr-pace-bar" role="list">
        {list.map((s, i) => {
          const thumb = segThumb(s, assets);
          return (
            <button
              type="button"
              role="listitem"
              key={s.id}
              className={'cr-pace-seg' + (s.id === selectedId ? ' sel' : '') + (thumb ? ' has-thumb' : '') + (flags[i] ? '' : ' missing')}
              style={thumb ? { flexGrow: durs[i], backgroundImage: `linear-gradient(rgba(0, 0, 0, .5), rgba(0, 0, 0, .5)), url("${thumb}")` } : { flexGrow: durs[i] }}
              title={`第 ${i + 1} 镜 · ${fmt(durs[i])}${s.title ? ' · ' + s.title : ''}${flags[i] ? '' : ' · 缺画面'}`}
              aria-label={`第 ${i + 1} 镜，${fmt(durs[i])}${flags[i] ? '' : '，缺画面'}`}
              onClick={() => onSelect && onSelect(s.id)}
            >
              <span className="n">{i + 1}</span>
              <span className="d">{fmt(durs[i])}</span>
            </button>
          );
        })}
      </div>
      <div className="cr-pace-next">
        <span className="cr-pace-note">{allReady ? '所有镜头都有画面了，可以开始剪辑' : `已有画面 ${ready}/${list.length}，缺的镜头会自动配素材`}</span>
        <button type="button" className={'cr-next-btn ' + (allReady ? 'primary' : 'secondary')} data-testid="go-edit" data-tour="create-go-refine" disabled={busy} title={allReady ? '按分镜生成初剪时间线，开始剪辑' : '还有镜头没有画面，也可以先开始剪辑（缺的镜头会自动配素材）'} onClick={() => actions.firstCut()}>
          下一步：进入剪辑 <span aria-hidden="true">→</span>
        </button>
      </div>
    </section>
  );
}
