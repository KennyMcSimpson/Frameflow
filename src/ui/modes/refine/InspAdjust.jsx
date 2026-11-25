// 属性 · 调节：滤镜（风格 + 强度）、基础调色（可打关键帧）、色彩匹配、特效。
import React, { useMemo, useState } from 'react';
import useStore from '../../store.js';
import { Button, Select } from '../../components/ui.jsx';
import { LOOKS, LOOK_LABELS, FX_KEYS, FX_LABELS, COLOR_KEYS, COLOR_LABELS } from '../../../engine/model.js';
import { InspSection, InspRow, Param, ChoiceGrid, patchItem, useEdit, T_IDS, FMT } from './InspCommon.jsx';
import { ensureAssetStats } from './SideData.js';

const ZERO_COLOR = { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0, vignette: 0 };
const ZERO_FX = Object.fromEntries((FX_KEYS || []).map((k) => [k, 0]));
const NO_STATS = new Set(['previz', 'audio']);
const LOOK_SWATCH = {
  none: 'linear-gradient(135deg,#6b6f78,#2a2c31)',
  cinematic: 'linear-gradient(135deg,#17505e,#d98b4a)',
  'film-warm': 'linear-gradient(135deg,#e8a35a,#7a3f22)',
  'film-cool': 'linear-gradient(135deg,#7fa6c9,#253a52)',
  bw: 'linear-gradient(135deg,#f0f0f0,#1c1c1c)',
  noir: 'linear-gradient(135deg,#8a8a8a,#050505)',
  vintage: 'linear-gradient(135deg,#d6bf8f,#6d5a3d)',
  'cool-night': 'linear-gradient(135deg,#3b5b9a,#0b1430)',
  vivid: 'linear-gradient(135deg,#ff5a5f,#ffc93c 50%,#2ec4b6)',
  'soft-pastel': 'linear-gradient(135deg,#f6c6d9,#c9e4f6)',
  'high-contrast': 'linear-gradient(135deg,#ffffff,#000000 55%)',
  moody: 'linear-gradient(135deg,#4a4f45,#16181a)',
  'golden-hour': 'linear-gradient(135deg,#ffcf6b,#c2552c)',
  cyberpunk: 'linear-gradient(135deg,#ff2bd6,#2b6bff)',
};

export default function InspAdjust({ clips, disabled }) {
  const project = useStore((s) => s.project);
  const ids = clips.map((c) => c.id);
  const { bind, now } = useEdit(ids.join(','));
  const [working, setWorking] = useState(null);
  const c0 = clips[0];
  const tgt = T_IDS(ids);
  const each = (fn) => (p) => ids.reduce((acc, id) => patchItem('clip', id, fn)(acc), p);
  const single = clips.length === 1;
  const color = { ...ZERO_COLOR, ...(c0.color || {}) };
  const fx = { ...ZERO_FX, ...(c0.fx || {}) };

  const setColor = (patch) => ({ ops: [{ type: 'setColor', target: tgt, color: patch, relative: false }], fb: each((c) => ({ ...c, color: { ...c.color, ...patch } })) });
  const setLook = (look, lookStrength) => ({ ops: [{ type: 'setLook', target: tgt, look, lookStrength }], fb: each((c) => ({ ...c, color: { ...c.color, look, lookStrength } })) });
  const setFx = (patch) => ({ ops: [{ type: 'setFx', target: tgt, fx: patch, relative: false }], fb: each((c) => ({ ...c, fx: { ...c.fx, ...patch } })) });

  const refOpts = useMemo(() => [{ value: '', label: '与某个片段保持一致…' }, ...project.tracks.video
    .map((c, i) => ({ c, i })).filter(({ c }) => !ids.includes(c.id))
    .map(({ c, i }) => { const a = project.assets[c.assetId]; return { value: String(i), label: `第${i + 1}段 · ${(a && a.name) || '素材'}` }; })],
  [project.tracks.video, project.assets, ids.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  async function matchTo(v) {
    if (v === '') return;
    const st = useStore.getState();
    const ref = st.project.tracks.video[Number(v)];
    const refAsset = ref && st.project.assets[ref.assetId];
    if (!refAsset || NO_STATS.has(refAsset.kind) || !refAsset.path) { st.toast('参考片段没有真实画面，无法匹配色彩', 'warn'); return; }
    setWorking('match');
    try {
      await ensureAssetStats([refAsset.id, ...clips.map((c) => c.assetId)]);
      const r2 = useStore.getState().project.assets[refAsset.id];
      if (!r2 || !r2.stats) { st.toast('读取参考片段色彩失败', 'error'); return; }
      const r = useStore.getState().commit([{ type: 'matchColor', target: tgt, reference: r2.stats, strength: 0.8 }], `匹配色彩到第${Number(v) + 1}段`);
      if (r.ok) st.toast('已匹配色彩', 'ok');
    } finally { setWorking(null); }
  }

  return (
    <>
      <InspSection id="j-look" title="滤镜" icon="palette" badge={color.look && color.look !== 'none' ? LOOK_LABELS[color.look] : null}>
        <ChoiceGrid cols={4} disabled={disabled} value={color.look || 'none'}
          options={LOOKS.map((l) => ({ value: l, label: LOOK_LABELS[l] || l, preview: <span className="insp-swatch" style={{ background: LOOK_SWATCH[l] || 'linear-gradient(135deg,#556,#223)' }} /> }))}
          onPick={(look) => now(setLook(look, color.look === 'none' ? 1 : color.lookStrength), '滤镜：' + (LOOK_LABELS[look] || look))} />
        <Param label="滤镜强度" min={0} max={1} step={0.01} value={color.lookStrength == null ? 1 : color.lookStrength} resetValue={1} format={FMT.pct}
          disabled={disabled || !color.look || color.look === 'none'} {...bind((v) => setLook(color.look, v), '滤镜强度')} />
      </InspSection>

      <InspSection id="j-color" title="调色" icon="sun"
        actions={<Button size="sm" variant="ghost" disabled={disabled} onClick={() => now(setColor({ ...ZERO_COLOR }), '复位调色')}>复位</Button>}>
        {COLOR_KEYS.map((k) => (
          <Param key={k} label={COLOR_LABELS[k]} min={k === 'vignette' ? 0 : -1} max={1} step={0.01} value={color[k] || 0} resetValue={0}
            format={k === 'vignette' ? FMT.pct : FMT.signed} disabled={disabled}
            kf={single ? { target: 'clip', item: c0, path: 'color.' + k, value: color[k] || 0, label: COLOR_LABELS[k] } : undefined}
            {...bind((v) => setColor({ [k]: v }), COLOR_LABELS[k])} />
        ))}
        <InspRow label="色彩匹配">
          <Select value="" options={refOpts} disabled={disabled || !!working || refOpts.length <= 1} onChange={matchTo} />
        </InspRow>
      </InspSection>

      <InspSection id="j-fx" title="画面特效" icon="sparkles" defaultOpen={false}
        badge={FX_KEYS.filter((k) => fx[k] > 0).length ? `${FX_KEYS.filter((k) => fx[k] > 0).length} 项` : null}
        actions={<Button size="sm" variant="ghost" disabled={disabled} onClick={() => now(setFx({ ...ZERO_FX }), '清除特效')}>清除</Button>}>
        {FX_KEYS.map((k) => (
          <Param key={k} label={FX_LABELS[k]} min={0} max={1} step={0.01} value={fx[k] || 0} resetValue={0} format={FMT.pct} disabled={disabled}
            {...bind((v) => setFx({ [k]: v }), FX_LABELS[k])} />
        ))}
      </InspSection>
    </>
  );
}
