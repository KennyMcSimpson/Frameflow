// 属性 · 动画：片段 = 入场转场 + 运镜；文字 = 入场 / 出场 / 循环。
import React from 'react';
import { Select } from '../../components/ui.jsx';
import { MOTIONS, MOTION_LABELS, TRANSITIONS, TRANSITION_LABELS, LIMITS } from '../../../engine/model.js';
import { InspSection, InspRow, Param, ChoiceGrid, patchItem, useEdit, T_IDS, T_NONE, FMT } from './InspCommon.jsx';
import { Seg } from './InspSpeed.jsx';
import { usePage } from './InspCommon.jsx';

const FIRST_TRANSITIONS = ['cut', 'crossfade', 'dip-black', 'dip-white'];
const FIRST_LABELS = { cut: '硬切', crossfade: '从黑淡入', 'dip-black': '黑场淡入', 'dip-white': '白场淡入' };

export const TEXT_ANIMS = {
  in: [['none', '无'], ['fade', '渐显'], ['pop', '弹入'], ['slide-up', '上滑'], ['slide-left', '左滑'], ['zoom', '放大'], ['typewriter', '打字机'], ['blur', '模糊渐清'], ['bounce', '弹跳']],
  out: [['none', '无'], ['fade', '渐隐'], ['pop', '缩小'], ['slide-down', '下滑'], ['slide-right', '右滑'], ['zoom', '放大消失'], ['blur', '模糊消失']],
  loop: [['none', '无'], ['breathe', '呼吸'], ['shake', '抖动'], ['wave', '波浪'], ['blink', '闪烁'], ['swing', '摇摆']],
};

/** 片段动画 */
export function ClipAnimation({ clips, indices = [], disabled }) {
  const { bind, now } = useEdit(clips.map((c) => c.id).join(','));
  const c0 = clips[0];
  const ids = clips.map((c) => c.id);
  const tgt = T_IDS(ids);
  const each = (fn) => (p) => ids.reduce((acc, id) => patchItem('clip', id, fn)(acc), p);
  const first = indices.includes(0);
  const list = first ? FIRST_TRANSITIONS : TRANSITIONS;
  const tr = c0.transitionIn || { type: 'cut', duration: 0.5 };
  const mo = c0.motion || { preset: 'none', intensity: 0.5 };
  const setTr = (t) => ({ ops: [{ type: 'setTransition', target: tgt, transition: t }], fb: each((c) => ({ ...c, transitionIn: { ...c.transitionIn, ...t } })) });
  const setMo = (m) => ({ ops: [{ type: 'setMotion', target: tgt, ...m }], fb: each((c) => ({ ...c, motion: { ...c.motion, ...m } })) });
  return (
    <>
      <InspSection id="a-in" title="入场转场" icon="transition">
        <ChoiceGrid cols={3} disabled={disabled} value={list.includes(tr.type) ? tr.type : 'cut'}
          options={list.map((t) => ({ value: t, label: first ? FIRST_LABELS[t] : (TRANSITION_LABELS[t] || t) }))}
          onPick={(type) => now(setTr({ type, duration: tr.duration }), '转场：' + (TRANSITION_LABELS[type] || type))} />
        <Param label="转场时长" min={LIMITS.minTransition} max={LIMITS.maxTransition} step={0.05} value={tr.duration} resetValue={0.5} format={FMT.sec}
          disabled={disabled || tr.type === 'cut'} {...bind((v) => setTr({ type: tr.type, duration: v }), '转场时长')} />
        <div className="hint">{first ? '第一个片段前面没有画面，只能硬切或淡入。' : '转场作用于本片段开头，与上一片段交叠。'}</div>
      </InspSection>
      <InspSection id="a-motion" title="运镜动画" icon="camera">
        <InspRow label="预设">
          <Select value={mo.preset} disabled={disabled} options={MOTIONS.map((m) => ({ value: m, label: MOTION_LABELS[m] || m }))}
            onChange={(preset) => now(setMo({ preset, intensity: mo.intensity }), '运镜：' + (MOTION_LABELS[preset] || preset))} />
        </InspRow>
        <Param label="强度" min={0} max={1} step={0.01} value={mo.intensity} resetValue={0.5} format={FMT.pct} disabled={disabled || mo.preset === 'none'}
          {...bind((v) => setMo({ preset: mo.preset, intensity: v }), '运镜强度')} />
        <div className="hint">需要更精细的运动？在「画面」页给缩放/位置打关键帧。</div>
      </InspSection>
    </>
  );
}

/** 文字动画（入场 / 出场 / 循环） */
export function TextAnimation({ text, disabled }) {
  const { bind, now } = useEdit(text.id);
  const [slot, setSlot] = usePage('textanim', 'in');
  const field = slot === 'in' ? 'animIn' : slot === 'out' ? 'animOut' : 'animLoop';
  const legacyIn = slot === 'in' && !text.animIn && text.animation ? { type: text.animation, dur: 0.5 } : null;
  const cur = text[field] || legacyIn || { type: 'none', dur: slot === 'loop' ? 1.2 : 0.5 };
  const set = (patch) => {
    const v = { ...cur, ...patch };
    const extra = slot === 'in' && ['fade', 'pop', 'slide-up', 'typewriter', 'none'].includes(v.type) ? { animation: v.type } : {};
    return { ops: [{ type: 'updateText', target: T_NONE, textId: text.id, text: { [field]: v, ...extra } }], fb: patchItem('text', text.id, { [field]: v, ...extra }) };
  };
  return (
    <InspSection id="t-anim" title="文字动画" icon="sparkles">
      <Seg options={[{ value: 'in', label: '入场' }, { value: 'out', label: '出场' }, { value: 'loop', label: '循环' }]} value={slot} onChange={setSlot} />
      <ChoiceGrid cols={3} disabled={disabled} value={cur.type} options={TEXT_ANIMS[slot].map(([value, label]) => ({ value, label }))}
        onPick={(type) => now(set({ type }), '文字动画')} />
      <Param label={slot === 'loop' ? '周期' : '时长'} min={0.1} max={slot === 'loop' ? 4 : 3} step={0.05} value={cur.dur || 0.5} resetValue={slot === 'loop' ? 1.2 : 0.5}
        format={FMT.sec} disabled={disabled || cur.type === 'none'} {...bind((dur) => set({ dur }), '动画时长')} />
    </InspSection>
  );
}

export default ClipAnimation;
