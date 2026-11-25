// 属性 · 文字（文本 / 动画）与音频轨（基础 / 处理，含踩点）。
import React, { useState } from 'react';
import useStore from '../../store.js';
import * as apiMod from '../../api.js';
import { Button, Icon, Select, Switch, fmtTime } from '../../components/ui.jsx';
import { TEXT_PRESETS, LIMITS } from '../../../engine/model.js';
import {
  InspSection, InspRow, NumField, TextDraft, ColorField, Param, ChoiceGrid, SubPages, usePage, patchItem, useEdit, runOp, T_NONE, FMT,
} from './InspCommon.jsx';
import { TextAnimation } from './InspAnimation.jsx';
import { fmtSecs, sizeToPt, ptToSize, ptRange, beatInfo, describeBeats, movedCuts, normalizeBeats } from './inspValue.js';

const api = apiMod.api || apiMod.default || null;

/** 文字常用色（内容颜色，不是界面配色）：白、黑、明黄、正红、青、天蓝、紫、草绿 */
const TEXT_SWATCHES = ['#FFFFFF', '#000000', '#FFD400', '#FF4D4F', '#36CFC9', '#40A9FF', '#9254DE', '#73D13D'];
/** 描边 / 背景常用色 */
const EDGE_SWATCHES = ['#000000', '#FFFFFF', '#1F1F1F', '#FFD400', '#FF4D4F', '#40A9FF'];

const TEXT_PRESET_LABELS = {
  title: '大标题', subtitle: '字幕', 'lower-third': '人名条', 'caption-box': '字幕框', 'big-bold': '粗体大字', handwrite: '手写', neon: '霓虹',
};
export const FONTS = [
  { value: '', label: '默认（思源黑体）' },
  { value: '"Microsoft YaHei UI", sans-serif', label: '微软雅黑' },
  { value: '"SimHei", sans-serif', label: '黑体' },
  { value: '"SimSun", serif', label: '宋体' },
  { value: '"KaiTi", serif', label: '楷体' },
  { value: '"FangSong", serif', label: '仿宋' },
  { value: 'Impact, sans-serif', label: 'Impact' },
  { value: 'Georgia, serif', label: 'Georgia' },
];
const AUDIO_ROLES = [
  { value: 'music', label: '背景音乐' },
  { value: 'sfx', label: '音效' },
  { value: 'voice', label: '配音 / 人声' },
];

// ================= 文字 =================
export function InspText({ text }) {
  const [page, setPage] = usePage('text', 'text');
  const dis = !!text.locked;
  const remove = () => {
    const r = useStore.getState().commit([{ type: 'removeText', target: T_NONE, textId: text.id }], '删除文字');
    if (r.ok) useStore.getState().clearSelection();
  };
  return (
    <div className="insp">
      <div className="insp-head">
        <div className="insp-head-icon text"><Icon name="text" size={18} /></div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="insp-head-title ellipsis">文字 · {text.text || '（空）'}</div>
          <div className="xs muted">{fmtTime(text.start)} 开始 · 持续 {Number(text.duration).toFixed(1)} 秒</div>
        </div>
        <Button size="sm" variant="ghost" icon="trash" title="删除文字" onClick={remove} disabled={dis} />
      </div>
      {dis && <div className="insp-locked"><span className="grow">此文字已锁定，无法修改。</span></div>}
      <SubPages pages={[{ id: 'text', label: '文本', icon: 'text' }, { id: 'anim', label: '动画', icon: 'sparkles' }]} value={page} onChange={setPage} />
      <div className="insp-page-body" key={page}>
        {page === 'text' ? <TextStyle text={text} disabled={dis} /> : <TextAnimation text={text} disabled={dis} />}
      </div>
    </div>
  );
}

export function TextStyle({ text, disabled: dis, compact, makeSet }) {
  const { bind, now, live } = useEdit(text.id);
  const set = makeSet || ((patch) => ({ ops: [{ type: 'updateText', target: T_NONE, textId: text.id, text: patch }], fb: patchItem('text', text.id, patch) }));
  const stroke = text.stroke || { color: '#000000', width: 0 };
  const shadow = text.shadow || null;
  const bg = text.bg || null;
  return (
    <>
      {!compact && (
        <InspSection id="t-content" title="内容" icon="text">
          <TextDraft value={text.text} rows={2} placeholder="输入文字" disabled={dis}
            onPreview={(v) => live.preview(set({ text: v }).fb)} onCommit={(v) => now(set({ text: v }), '修改文字')} />
          <ChoiceGrid cols={4} disabled={dis} value={text.preset} options={TEXT_PRESETS.map((p) => ({ value: p, label: TEXT_PRESET_LABELS[p] || p }))}
            onPick={(preset) => now(set({ preset }), '文字预设')} />
        </InspSection>
      )}
      <InspSection id="t-font" title="字体" icon="text">
        <InspRow label="字体">
          <Select value={text.font || ''} disabled={dis} options={FONTS} onChange={(font) => now(set({ font }), '字体')} />
        </InspRow>
        <InspRow label="颜色">
          <ColorField value={text.color} disabled={dis} onPreview={(color) => live.preview(set({ color }).fb)} onCommit={(color) => now(set({ color }), '文字颜色')} />
        </InspRow>
        <Param label="字号" min={0.3} max={3} step={0.05} value={text.size || 1} resetValue={1} format={FMT.times} disabled={dis} {...bind((size) => set({ size }), '字号')} />
        {!compact && (
          <>
            <Param label="水平位置" min={0} max={1} step={0.005} value={text.x == null ? 0.5 : text.x} resetValue={0.5} format={FMT.pct} disabled={dis} {...bind((x) => set({ x }), '移动文字')} />
            <Param label="垂直位置" min={0} max={1} step={0.005} value={text.y == null ? 0.5 : text.y} resetValue={0.5} format={FMT.pct} disabled={dis} {...bind((y) => set({ y }), '移动文字')} />
          </>
        )}
      </InspSection>
      <InspSection id="t-deco" title="描边 · 阴影 · 背景" icon="layers">
        <InspRow label="描边色">
          <ColorField value={stroke.color} disabled={dis} onCommit={(color) => now(set({ stroke: { ...stroke, color, width: stroke.width || 2 } }), '描边颜色')} />
        </InspRow>
        <Param label="描边粗细" min={0} max={12} step={0.5} value={stroke.width || 0} resetValue={0} format={(v) => `${v.toFixed(1)} px`} disabled={dis}
          {...bind((width) => set({ stroke: { ...stroke, width } }), '描边粗细')} />
        <InspRow label="阴影">
          <Switch checked={!!shadow} disabled={dis} onChange={(on) => now(set({ shadow: on ? { color: 'rgba(0,0,0,0.6)', blur: 8, x: 0, y: 2 } : null }), on ? '添加阴影' : '去掉阴影')} />
        </InspRow>
        {shadow && (
          <Param label="阴影模糊" min={0} max={30} step={1} value={shadow.blur || 0} resetValue={8} format={(v) => `${Math.round(v)} px`} disabled={dis}
            {...bind((blur) => set({ shadow: { ...shadow, blur } }), '阴影模糊')} />
        )}
        <InspRow label="文字背景">
          <Switch checked={!!bg} disabled={dis} onChange={(on) => now(set({ bg: on ? { color: '#000000', opacity: 0.55, radius: 6 } : null }), on ? '添加背景' : '去掉背景')} />
        </InspRow>
        {bg && (
          <>
            <InspRow label="背景色">
              <ColorField value={bg.color} disabled={dis} onCommit={(color) => now(set({ bg: { ...bg, color } }), '背景颜色')} />
            </InspRow>
            <Param label="背景不透明" min={0} max={1} step={0.01} value={bg.opacity == null ? 0.55 : bg.opacity} resetValue={0.55} format={FMT.pct} disabled={dis}
              {...bind((opacity) => set({ bg: { ...bg, opacity } }), '背景不透明度')} />
          </>
        )}
      </InspSection>
      {!compact && (
        <InspSection id="t-time" title="时间" icon="clock" defaultOpen={false}>
          <InspRow label="开始">
            <NumField value={text.start} min={0} max={LIMITS.maxDuration} step={0.1} suffix="秒" disabled={dis} onCommit={(start) => now(set({ start }), '调整文字时间')} />
          </InspRow>
          <InspRow label="时长">
            <NumField value={text.duration} min={0.2} max={LIMITS.maxDuration} step={0.1} suffix="秒" disabled={dis} onCommit={(duration) => now(set({ duration }), '调整文字时长')} />
          </InspRow>
          <Button size="sm" variant="ghost" className="insp-wide" disabled={dis} onClick={() => now(set({ start: Math.max(0, useStore.getState().playhead) }), '文字移到播放头')}>开始时间设为播放头</Button>
        </InspSection>
      )}
    </>
  );
}

// ================= 音频轨 =================
export function InspAudioTrack({ audio }) {
  const project = useStore((s) => s.project);
  const asset = project.assets[audio.assetId];
  const [page, setPage] = usePage('audiotrack', 'basic');
  const { bind, now } = useEdit(audio.id);
  const set = (patch) => ({ ops: [{ type: 'updateAudio', target: T_NONE, audioId: audio.id, audio: patch }], fb: patchItem('audio', audio.id, patch) });
  const dis = !!audio.locked;
  const len = Math.max(0, audio.out - audio.in);
  const srcMax = asset && Number(asset.duration) > 0 ? Number(asset.duration) : LIMITS.maxDuration;
  const st = () => useStore.getState();
  const remove = () => { const r = st().commit([{ type: 'removeAudio', target: T_NONE, audioId: audio.id }], '删除音频'); if (r.ok) st().clearSelection(); };
  const duck = () => { const r = runOp({ type: 'autoDuck', amount: 0.25 }, '自动闪避'); if (r && r.ok) st().toast('已在人声/原声出现处自动压低背景音乐', 'ok'); };
  const beats = () => {
    if (!asset || !Array.isArray(asset.beats) || !asset.beats.length) { st().toast('这段音乐还没有分析出节拍（导入时自动分析，稍后再试）', 'warn'); return; }
    const r = runOp({ type: 'snapCutsToBeats', assetId: asset.id }, '剪辑点对齐节拍');
    if (r && r.ok) st().toast(`已把剪辑点对齐到 ${asset.beats.length} 个节拍附近`, 'ok');
  };
  const vkeys = Array.isArray(audio.volumeKeys) ? audio.volumeKeys : [];

  return (
    <div className="insp">
      <div className="insp-head">
        <div className="insp-head-icon audio"><Icon name="music" size={18} /></div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="insp-head-title ellipsis">{(asset && asset.name) || '音频'}</div>
          <div className="xs muted">{fmtTime(audio.start)} 开始 · 长度 {fmtSecs(len)}</div>
        </div>
        <Button size="sm" variant="ghost" icon="trash" title="删除音频" onClick={remove} disabled={dis} />
      </div>
      {dis && <div className="insp-locked"><span className="grow">此音频已锁定，无法修改。</span></div>}
      <SubPages pages={[{ id: 'basic', label: '基础', icon: 'volume' }, { id: 'tools', label: '处理', icon: 'wand' }]} value={page} onChange={setPage} />
      <div className="insp-page-body" key={page}>
        {page === 'basic' ? (
          <>
            <InspSection id="au-vol" title="音量" icon="volume" badge={vkeys.length ? `${vkeys.length} 个包络点` : null}>
              <InspRow label="用途">
                <Select value={audio.role} disabled={dis} options={AUDIO_ROLES} onChange={(role) => now(set({ role }), '音频用途')} />
              </InspRow>
              <Param label="音量" min={0} max={2} step={0.01} value={audio.volume} resetValue={1} format={FMT.pct} disabled={dis}
                kf={{ target: 'audio', item: audio, path: 'volume', value: audio.volume, label: '音量包络' }} {...bind((volume) => set({ volume }), '音量')} />
              <Param label="淡入" min={0} max={5} step={0.05} value={audio.fadeIn || 0} resetValue={0.5} format={FMT.sec} disabled={dis} {...bind((fadeIn) => set({ fadeIn }), '淡入')} />
              <Param label="淡出" min={0} max={5} step={0.05} value={audio.fadeOut || 0} resetValue={0.8} format={FMT.sec} disabled={dis} {...bind((fadeOut) => set({ fadeOut }), '淡出')} />
              {vkeys.length > 0 && <Button size="sm" variant="ghost" className="insp-wide" disabled={dis} onClick={() => now(set({ volumeKeys: [] }), '清除音量包络')}>清除音量包络</Button>}
            </InspSection>
            <InspSection id="au-time" title="时间与裁剪" icon="scissors" defaultOpen={false}>
              <InspRow label="开始"><NumField value={audio.start} min={0} max={LIMITS.maxDuration} step={0.1} suffix="秒" disabled={dis} onCommit={(start) => now(set({ start }), '移动音频')} /></InspRow>
              <InspRow label="源入点"><NumField value={audio.in} min={0} max={Math.max(0, audio.out - LIMITS.minClip)} step={0.1} suffix="秒" disabled={dis} onCommit={(v) => now(set({ in: v }), '裁剪音频')} /></InspRow>
              <InspRow label="源出点"><NumField value={audio.out} min={audio.in + LIMITS.minClip} max={srcMax} step={0.1} suffix="秒" disabled={dis} onCommit={(v) => now(set({ out: v }), '裁剪音频')} /></InspRow>
            </InspSection>
          </>
        ) : (
          <InspSection id="au-tools" title="智能处理" icon="wand">
            <InspRow label="降噪" hint="去除底噪、风声和电流声">
              <Switch checked={!!audio.denoise} disabled={dis} onChange={(denoise) => now(set({ denoise }), denoise ? '开启降噪' : '关闭降噪')} />
            </InspRow>
            <button type="button" className="insp-action" disabled={dis} onClick={duck}>
              <Icon name="volume" size={16} />
              <span className="grow"><b>自动闪避</b><small>有人声或原声时自动压低这段音乐</small></span>
            </button>
            <button type="button" className="insp-action" disabled={dis} onClick={beats}>
              <Icon name="bolt" size={16} />
              <span className="grow"><b>踩点</b><small>把视频剪辑点吸附到音乐节拍{asset && asset.beats ? `（${asset.beats.length} 拍）` : ''}</small></span>
            </button>
          </InspSection>
        )}
      </div>
    </div>
  );
}

/** 兼容旧名 */
export const InspAudio = InspAudioTrack;
