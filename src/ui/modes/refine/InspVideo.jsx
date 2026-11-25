// 属性 · 画面：基础变换、裁剪/比例、背景画布、蒙版、混合/不透明度（主轨片段与画中画共用）。
import React from 'react';
import useStore from '../../store.js';
import { Button, Icon, Select, Switch } from '../../components/ui.jsx';
import { useTfUi } from './TransformOverlay.jsx';
import { InspSection, InspRow, ColorField, Param, ChoiceGrid, patchItem, useEdit, T_IDS, FMT } from './InspCommon.jsx';

const TF0 = { scale: 1, x: 0, y: 0, rotation: 0, flipH: false };
export const FIT_OPTS = [
  { value: 'cover', label: '填充（裁边）' },
  { value: 'contain', label: '适应（留边）' },
  { value: 'fill', label: '拉伸铺满' },
];
const CANVAS_OPTS = [
  { value: 'none', label: '无' },
  { value: 'blur', label: '模糊背景' },
  { value: 'color', label: '纯色' },
];
const BLEND_OPTS = [
  ['normal', '正常'], ['multiply', '正片叠底'], ['screen', '滤色'], ['overlay', '叠加'], ['darken', '变暗'], ['lighten', '变亮'], ['add', '线性减淡'],
].map(([value, label]) => ({ value, label }));
const MASKS = [
  { value: 'none', label: '无', preview: <svg viewBox="0 0 24 24"><path d="M5 5l14 14" /></svg> },
  { value: 'linear', label: '线性', preview: <svg viewBox="0 0 24 24"><path d="M3 12h18" /></svg> },
  { value: 'mirror', label: '镜面', preview: <svg viewBox="0 0 24 24"><path d="M3 9h18M3 15h18" /></svg> },
  { value: 'circle', label: '圆形', preview: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" /></svg> },
  { value: 'rect', label: '矩形', preview: <svg viewBox="0 0 24 24"><rect x="5" y="7" width="14" height="10" rx="1" /></svg> },
];
const MASK0 = { cx: 0.5, cy: 0.5, w: 0.6, h: 0.6, rot: 0, feather: 0.1, invert: false };
const RATIOS = [
  { value: 'free', label: '自由' }, { value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }, { value: '1:1', label: '1:1' }, { value: '4:3', label: '4:3' }, { value: '2.35:1', label: '2.35' },
];

/** 生成「改属性」的 ops + 兜底函数 */
export function makeEditors(target, items) {
  const ids = items.map((x) => x.id);
  const mergeTf = (x, tf) => ({ ...x, transform: { ...TF0, ...(x.transform || {}), ...tf } });
  const each = (fn) => (p) => ids.reduce((acc, id) => patchItem(target, id, fn)(acc), p);
  return {
    tf: (tf) => ({
      ops: target === 'overlay'
        ? items.map((x) => ({ type: 'updateOverlay', id: x.id, patch: { transform: { ...TF0, ...(x.transform || {}), ...tf } } }))
        : [{ type: 'setTransform', target: T_IDS(ids), transform: tf }],
      fb: each((x) => mergeTf(x, tf)),
    }),
    props: (patch) => ({
      ops: items.map((x) => (target === 'overlay' ? { type: 'updateOverlay', id: x.id, patch } : { type: 'setClipProps', id: x.id, patch })),
      fb: each((x) => ({ ...x, ...patch })),
    }),
  };
}

export default function InspVideo({ items, target = 'clip', disabled }) {
  const key = items.map((x) => x.id).join(',') + target;
  const { bind, now } = useEdit(key);
  const x0 = items[0];
  const E = makeEditors(target, items);
  const tf = { ...TF0, ...(x0.transform || {}) };
  const crop = { l: 0, t: 0, r: 0, b: 0, ...(x0.crop || {}) };
  const canvas = x0.canvas || { type: 'none', value: '#000000' };
  const mask = x0.mask || null;
  const mirror = x0.mirror || { h: !!tf.flipH, v: false };
  const opacity = x0.opacity == null ? 1 : x0.opacity;
  const dis = disabled;
  const single = items.length === 1;
  const kf = (path, value, label) => (single ? { target, item: x0, path, value, label } : undefined);
  const cropMode = useTfUi((s) => s.crop);

  const toggleCropOnCanvas = () => {
    useTfUi.setState({ crop: !useTfUi.getState().crop });
  };

  return (
    <>
      <InspSection id="v-basic" title="基础" icon="image"
        actions={<Button size="sm" variant="ghost" disabled={dis} onClick={() => now(E.tf({ ...TF0 }), '复位画面')}>复位</Button>}>
        <Param label="缩放" min={0.1} max={4} step={0.01} value={tf.scale} resetValue={1} format={FMT.pct} disabled={dis}
          kf={kf('transform.scale', tf.scale, '缩放')} {...bind((v) => E.tf({ scale: v }), '缩放')} />
        <Param label="位置 X" min={-1} max={1} step={0.005} value={tf.x} resetValue={0} format={FMT.signed} disabled={dis}
          kf={kf('transform.x', tf.x, '位置 X')} {...bind((v) => E.tf({ x: v }), '位置')} />
        <Param label="位置 Y" min={-1} max={1} step={0.005} value={tf.y} resetValue={0} format={FMT.signed} disabled={dis}
          kf={kf('transform.y', tf.y, '位置 Y')} {...bind((v) => E.tf({ y: v }), '位置')} />
        <Param label="旋转" min={-180} max={180} step={1} value={tf.rotation} resetValue={0} format={FMT.deg} disabled={dis}
          kf={kf('transform.rotate', tf.rotation, '旋转')} {...bind((v) => E.tf({ rotation: v }), '旋转')} />
        <Param label="不透明度" min={0} max={1} step={0.01} value={opacity} resetValue={1} format={FMT.pct} disabled={dis}
          kf={kf('opacity', opacity, '不透明度')} {...bind((v) => E.props({ opacity: v }), '不透明度')} />
        <InspRow label="镜像">
          <div className="insp-btnrow">
            <Button size="sm" active={!!mirror.h} disabled={dis} onClick={() => {
              const h = !mirror.h;
              const a = E.props({ mirror: { ...mirror, h } }); const b = E.tf({ flipH: h });
              now({ ops: [...a.ops, ...b.ops], fb: (p) => b.fb(a.fb(p)) }, h ? '水平镜像' : '取消水平镜像');
            }}>水平</Button>
            <Button size="sm" active={!!mirror.v} disabled={dis} onClick={() => now(E.props({ mirror: { ...mirror, v: !mirror.v } }), '垂直镜像')}>垂直</Button>
          </div>
        </InspRow>
        <InspRow label="混合">
          <Select value={x0.blend || 'normal'} disabled={dis} options={BLEND_OPTS} onChange={(blend) => now(E.props({ blend }), '混合模式')} />
        </InspRow>
      </InspSection>

      <InspSection id="v-crop" title="裁剪与比例" icon="grid" badge={crop.l + crop.t + crop.r + crop.b > 0.001 ? '已裁剪' : null}
        actions={<Button size="sm" variant="ghost" disabled={dis} onClick={() => now(E.props({ crop: { l: 0, t: 0, r: 0, b: 0 } }), '清除裁剪')}>清除</Button>}>
        <InspRow label="填充方式">
          <Select value={x0.fit || 'cover'} disabled={dis} options={FIT_OPTS} onChange={(fit) => now(E.props({ fit }), '填充方式')} />
        </InspRow>
        <InspRow label="比例">
          <Select value="free" disabled={dis} options={RATIOS} onChange={(r) => {
            if (r === 'free') return;
            const [a, b] = r.split(':').map(Number); const st = useStore.getState().project.settings;
            const frame = (st.width || 16) / (st.height || 9); const want = a / b;
            const c = want < frame ? { l: Math.min(0.45, (1 - want / frame) / 2), r: Math.min(0.45, (1 - want / frame) / 2), t: 0, b: 0 }
              : { t: Math.min(0.45, (1 - frame / want) / 2), b: Math.min(0.45, (1 - frame / want) / 2), l: 0, r: 0 };
            now(E.props({ crop: c }), '按比例裁剪 ' + r);
          }} />
        </InspRow>
        <div className="insp-grid2">
          {[['l', '左'], ['r', '右'], ['t', '上'], ['b', '下']].map(([k, label]) => (
            <Param key={k} label={'裁剪' + label} min={0} max={0.45} step={0.005} value={crop[k]} resetValue={0} format={FMT.pct} disabled={dis}
              {...bind((v) => E.props({ crop: { ...crop, [k]: v } }), '裁剪')} />
          ))}
        </div>
        <Button size="sm" variant="secondary" className="insp-wide" icon="grid" disabled={dis || !single} onClick={toggleCropOnCanvas} active={!!cropMode}>在画面上拖动裁剪框</Button>
      </InspSection>

      <InspSection id="v-canvas" title="背景画布" icon="layers" defaultOpen={false} badge={canvas.type !== 'none' ? (CANVAS_OPTS.find((o) => o.value === canvas.type) || {}).label : null}>
        <div className="hint">画面没有铺满（缩小、适应、竖屏横拍）时，空白处如何填充。</div>
        <InspRow label="类型">
          <Select value={canvas.type} disabled={dis} options={CANVAS_OPTS} onChange={(type) => now(E.props({ canvas: { type, value: type === 'color' ? (canvas.value && canvas.value[0] === '#' ? canvas.value : '#000000') : canvas.value } }), '背景画布')} />
        </InspRow>
        {canvas.type === 'color' && (
          <InspRow label="颜色">
            <ColorField value={canvas.value} disabled={dis} onCommit={(value) => now(E.props({ canvas: { type: 'color', value } }), '背景颜色')} />
          </InspRow>
        )}
        {canvas.type === 'blur' && (
          <Param label="模糊程度" min={0.1} max={1} step={0.01} value={Number(canvas.value) || 0.5} resetValue={0.5} format={FMT.pct} disabled={dis}
            {...bind((v) => E.props({ canvas: { type: 'blur', value: v } }), '背景模糊')} />
        )}
      </InspSection>

      <InspSection id="v-mask" title="蒙版" icon="focus" defaultOpen={false} badge={mask ? (MASKS.find((m) => m.value === mask.shape) || {}).label : null}>
        <ChoiceGrid cols={5} options={MASKS} value={mask ? mask.shape : 'none'} disabled={dis}
          onPick={(shape) => now(E.props({ mask: shape === 'none' ? null : { ...MASK0, ...(mask || {}), shape } }), shape === 'none' ? '移除蒙版' : '蒙版')} />
        {mask && (
          <>
            <Param label="羽化" min={0} max={1} step={0.01} value={mask.feather || 0} resetValue={0.1} format={FMT.pct} disabled={dis}
              {...bind((v) => E.props({ mask: { ...mask, feather: v } }), '蒙版羽化')} />
            <Param label="大小" min={0.05} max={1.5} step={0.01} value={mask.w || 0.6} resetValue={0.6} format={FMT.pct} disabled={dis}
              {...bind((v) => E.props({ mask: { ...mask, w: v, h: v * ((mask.h || 0.6) / (mask.w || 0.6)) } }), '蒙版大小')} />
            <Param label="旋转" min={-180} max={180} step={1} value={mask.rot || 0} resetValue={0} format={FMT.deg} disabled={dis}
              {...bind((v) => E.props({ mask: { ...mask, rot: v } }), '蒙版旋转')} />
            <InspRow label="反转">
              <Switch checked={!!mask.invert} disabled={dis} onChange={(invert) => now(E.props({ mask: { ...mask, invert } }), '反转蒙版')} />
            </InspRow>
          </>
        )}
      </InspSection>
    </>
  );
}

/** 「一键替换为实拍」：调用创作模式的实拍补全，若不可用则引导到素材区联网实拍 */
export function ReplaceFootageButton({ clip, disabled }) {
  const project = useStore((s) => s.project);
  const asset = clip && project.assets[clip.assetId];
  const isFake = !asset || asset.kind === 'previz' || asset.source === 'previz' || asset.kind === 'generated-image';
  const [busy, setBusy] = React.useState(false);
  const go = async () => {
    const st = useStore.getState();
    setBusy(true);
    try {
      const CA = await import('../create/createActions.js');
      const shotId = clip.shotId || (st.project.shots || []).find((s) => s.assetId === clip.assetId || s.footageAssetId === clip.assetId || s.previzAssetId === clip.assetId)?.id;
      const fn = CA.fillShotFootage || CA.findShotFootage;
      if (shotId && fn) { await fn(shotId, { replace: true }); return; }
      window.dispatchEvent(new CustomEvent('ff:open-media', { detail: { tab: 'web', query: (clip.label || (asset && asset.name) || '').slice(0, 40) } }));
      st.toast('已打开素材区「联网实拍」，选一段真人实拍拖到此片段上即可替换', 'info');
    } catch (e) {
      st.toast('替换实拍失败：' + (e && e.message ? e.message : '未知原因'), 'error');
    } finally { setBusy(false); }
  };
  return (
    <button type="button" className={'insp-replace' + (isFake ? ' hot' : '')} disabled={disabled || busy} onClick={go}>
      <Icon name="camera" size={14} />
      <span className="grow">{busy ? '正在寻找实拍素材…' : isFake ? '一键替换为真人实拍' : '换一段实拍素材'}</span>
      {isFake && <span className="insp-replace-tag">示意画面</span>}
    </button>
  );
}
