// 属性 · 片段音频：音量（关键帧）、淡入淡出、静音、分离音频、降噪。
import React from 'react';
import useStore from '../../store.js';
import { Button, Switch } from '../../components/ui.jsx';
import { InspSection, InspRow, Param, patchItem, useEdit, runOp, T_IDS, FMT } from './InspCommon.jsx';

export default function InspAudio({ items, target = 'clip', disabled }) {
  const project = useStore((s) => s.project);
  const ids = items.map((x) => x.id);
  const { bind, now } = useEdit(ids.join(',') + target);
  const x0 = items[0];
  const asset = project.assets[x0.assetId];
  const each = (fn) => (p) => ids.reduce((acc, id) => patchItem(target, id, fn)(acc), p);
  const muted = !!(x0.mute || x0.muted);
  const vol = x0.volume == null ? 1 : x0.volume;
  const noAudio = asset && (asset.kind !== 'video' || asset.hasAudio === false);

  const setVol = (patch) => {
    const ops = target === 'overlay'
      ? ids.map((id) => ({ type: 'updateOverlay', id, patch: { volume: patch.volume, muted: patch.mute } }))
      : [{ type: 'setVolume', target: T_IDS(ids), ...patch }];
    const fp = { ...patch }; if ('mute' in patch) fp.muted = patch.mute;
    return { ops, fb: each((x) => ({ ...x, ...fp })) };
  };
  const props = (patch) => ({
    ops: ids.map((id) => (target === 'overlay' ? { type: 'updateOverlay', id, patch } : { type: 'setClipProps', id, patch })),
    fb: each((x) => ({ ...x, ...patch })),
  });

  const detach = () => {
    const st = useStore.getState();
    let n = 0;
    for (const id of ids) { const r = runOp({ type: 'detachAudio', id }, '分离音频'); if (r && r.ok) n += 1; }
    if (n) st.toast(`已把 ${n} 个片段的原声分离到音频轨`, 'ok');
  };

  return (
    <>
      {noAudio && <div className="insp-note"><span className="grow">{asset.kind === 'video' ? '此素材没有声音。' : '图片/示意画面没有声音。'}可在音频轨添加音乐或配音。</span></div>}
      <InspSection id="u-basic" title="音量" icon="volume" badge={muted ? '静音' : null}>
        <InspRow label="静音">
          <Switch checked={muted} disabled={disabled} onChange={(mute) => now(setVol({ mute }), mute ? '静音' : '取消静音')} />
        </InspRow>
        <Param label="音量" min={0} max={2} step={0.01} value={vol} resetValue={1} format={FMT.pct} disabled={disabled || muted}
          kf={items.length === 1 ? { target, item: x0, path: 'volume', value: vol, label: '音量' } : undefined}
          {...bind((v) => setVol({ volume: v }), '音量')} />
        <Param label="淡入" min={0} max={3} step={0.05} value={x0.audioFadeIn || 0} resetValue={0} format={FMT.sec} disabled={disabled}
          {...bind((v) => (target === 'overlay' ? props({ audioFadeIn: v }) : setVol({ audioFadeIn: v })), '声音淡入')} />
        <Param label="淡出" min={0} max={3} step={0.05} value={x0.audioFadeOut || 0} resetValue={0} format={FMT.sec} disabled={disabled}
          {...bind((v) => (target === 'overlay' ? props({ audioFadeOut: v }) : setVol({ audioFadeOut: v })), '声音淡出')} />
      </InspSection>
      <InspSection id="u-tools" title="处理" icon="wand">
        <InspRow label="人声降噪" hint="导出时对原声做降噪（轻度）">
          <Switch checked={!!x0.denoise} disabled={disabled || noAudio} onChange={(denoise) => now(props({ denoise }), denoise ? '开启降噪' : '关闭降噪')} />
        </InspRow>
        {target === 'clip' && (
          <Button size="sm" variant="secondary" className="insp-wide" icon="music" disabled={disabled || noAudio} onClick={detach}>分离音频到音频轨</Button>
        )}
      </InspSection>
    </>
  );
}
