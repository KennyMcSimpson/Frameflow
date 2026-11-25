// 属性 · 变速：常规（0.1–10x）/ 曲线（6 个预设）/ 倒放 / 定格。
import React from 'react';
import useStore from '../../store.js';
import { Button, Icon, Switch, fmtTime } from '../../components/ui.jsx';
import { InspSection, InspRow, NumField, Param, ChoiceGrid, patchItem, useEdit, usePage, runOp, T_IDS, FMT } from './InspCommon.jsx';

export const SPEED_CURVES = {
  montage: { label: '蒙太奇', hint: '快—慢—快交替，节奏感强', curve: [[0, 1], [0.25, 3], [0.5, 0.5], [0.75, 3], [1, 1]] },
  hero: { label: '英雄时刻', hint: '中段骤然慢放，突出高光动作', curve: [[0, 2], [0.4, 2], [0.5, 0.3], [0.65, 0.3], [0.75, 2], [1, 2]] },
  bullet: { label: '子弹时间', hint: '两端快、中间极慢', curve: [[0, 3], [0.35, 0.2], [0.65, 0.2], [1, 3]] },
  jump: { label: '跳接', hint: '中段快进，跳过冗余过程', curve: [[0, 1], [0.3, 1], [0.35, 5], [0.65, 5], [0.7, 1], [1, 1]] },
  flashIn: { label: '闪进', hint: '开头快速冲入，然后正常', curve: [[0, 5], [0.4, 1], [1, 1]] },
  flashOut: { label: '闪出', hint: '正常播放后快速冲出', curve: [[0, 1], [0.6, 1], [1, 5]] },
};
const toCurve = (pts) => pts.map(([t, v]) => ({ t, v }));
const SPEED_MIN = 0.1;
const SPEED_MAX = 10;
// 速度滑杆用对数刻度：0..1 ↔ 0.1..10
const toPos = (v) => Math.log10(Math.max(SPEED_MIN, v)) / 2 + 0.5;
const fromPos = (p) => Math.round(10 ** ((p - 0.5) * 2) * 100) / 100;

function CurvePreview({ pts, active }) {
  const y = (v) => 20 - (Math.log10(v) / 1.0 + 1) * 9; // 0.1→20, 1→11, 10→2
  const d = pts.map(([t, v], i) => `${i ? 'L' : 'M'}${(t * 48 + 2).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  return (
    <svg viewBox="0 0 52 22" className={'insp-curve' + (active ? ' on' : '')}>
      <line x1="2" x2="50" y1="11" y2="11" className="base" />
      <path d={d} />
    </svg>
  );
}

export function Seg({ options, value, onChange }) {
  return (
    <div className="insp-seg">
      {options.map((o) => <button key={o.value} type="button" className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </div>
  );
}

export default function InspSpeed({ clips, disabled }) {
  const key = clips.map((c) => c.id).join(',');
  const { bind, now } = useEdit(key);
  const [mode, setMode] = usePage('speed', 'normal');
  const c0 = clips[0];
  const ids = clips.map((c) => c.id);
  const each = (fn) => (p) => ids.reduce((acc, id) => patchItem('clip', id, fn)(acc), p);
  const curve = Array.isArray(c0.speedCurve) ? c0.speedCurve : null;
  const curPreset = c0.speedCurvePreset || (curve ? Object.keys(SPEED_CURVES).find((k) => JSON.stringify(toCurve(SPEED_CURVES[k].curve)) === JSON.stringify(curve)) : null);
  const srcLen = Math.max(0, (c0.out || 0) - (c0.in || 0));
  const effMode = curve ? 'curve' : mode;

  const setSpeed = (v) => ({ ops: [{ type: 'setSpeed', target: T_IDS(ids), speed: v }], fb: each((c) => ({ ...c, speed: v, speedCurve: null })) });
  const setCurve = (preset) => ({
    ops: ids.map((id) => ({ type: 'setSpeedCurve', id, curve: preset ? toCurve(SPEED_CURVES[preset].curve) : null, preset: preset || undefined })),
    fb: each((c) => ({ ...c, speedCurve: preset ? toCurve(SPEED_CURVES[preset].curve) : null, speedCurvePreset: preset || null })),
  });
  const props = (patch) => ({ ops: ids.map((id) => ({ type: 'setClipProps', id, patch })), fb: each((c) => ({ ...c, ...patch })) });

  const freeze = () => {
    const st = useStore.getState();
    const t = st.playhead;
    const r = runOp({ type: 'freezeFrame', at: t, duration: 2 }, '定格 2 秒');
    if (r && r.ok) st.toast('已在播放头处插入 2 秒定格画面', 'ok');
  };

  const dur = (c) => (c.still ? Math.max(0.2, c.out - c.in) : srcLen / (c.speed || 1));

  return (
    <>
      <InspSection id="s-speed" title="速度" icon="clock">
        <Seg options={[{ value: 'normal', label: '常规变速' }, { value: 'curve', label: '曲线变速' }]} value={effMode}
          onChange={(m) => { setMode(m); if (m === 'normal' && curve) now(setCurve(null), '取消曲线变速'); }} />
        {effMode === 'normal' ? (
          <>
            <Param label="倍速" min={0} max={1} step={0.005} value={toPos(c0.speed || 1)} resetValue={0.5} disabled={disabled}
              format={(p) => `${fromPos(p).toFixed(2)}×`} {...bind((p) => setSpeed(fromPos(p)), '变速')} />
            <div className="insp-chips">
              {[0.25, 0.5, 1, 1.5, 2, 4].map((v) => (
                <button key={v} type="button" disabled={disabled} className={'insp-chip' + (Math.abs((c0.speed || 1) - v) < 0.01 ? ' on' : '')} onClick={() => now(setSpeed(v), `${v}× 变速`)}>{v}×</button>
              ))}
            </div>
            <InspRow label="时长" hint="改变速度会改变片段时长">
              <NumField value={dur(c0)} min={0.2} max={600} step={0.1} suffix="秒" disabled={disabled}
                onCommit={(d) => now(setSpeed(Math.min(SPEED_MAX, Math.max(SPEED_MIN, srcLen / d))), '按时长变速')} />
            </InspRow>
          </>
        ) : (
          <>
            <ChoiceGrid cols={3} disabled={disabled} value={curPreset || null}
              options={Object.entries(SPEED_CURVES).map(([value, p]) => ({ value, label: p.label, hint: p.hint, preview: <CurvePreview pts={p.curve} active={curPreset === value} /> }))}
              onPick={(p) => now(setCurve(p), '曲线变速：' + SPEED_CURVES[p].label)} />
            {curve && <Button size="sm" variant="ghost" className="insp-wide" disabled={disabled} onClick={() => now(setCurve(null), '取消曲线变速')}>取消曲线变速</Button>}
            <div className="hint">曲线变速按片段时长归一化，片段总时长随曲线自动计算。</div>
          </>
        )}
        <div className="insp-kv">
          <span>源长度</span><span className="mono">{fmtTime(srcLen)}</span>
          <span>源入/出点</span><span className="mono">{fmtTime(c0.in)} – {fmtTime(c0.out)}</span>
        </div>
      </InspSection>

      <InspSection id="s-more" title="倒放与定格" icon="refresh">
        <InspRow label="倒放">
          <Switch checked={!!c0.reverse} disabled={disabled} onChange={(reverse) => now(props({ reverse }), reverse ? '倒放' : '取消倒放')} />
        </InspRow>
        <Button size="sm" variant="secondary" className="insp-wide" icon="pause" disabled={disabled} onClick={freeze}>在播放头处定格 2 秒</Button>
        {c0.still && <div className="insp-note"><Icon name="pause" size={12} /><span className="grow">这是定格片段，整段显示同一帧。</span></div>}
      </InspSection>
    </>
  );
}
