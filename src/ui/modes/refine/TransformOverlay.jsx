// 预览画面上的直接操作层：拖动位移、角点缩放、旋转手柄、裁剪框；安全框。
// 拖动中实时预览（不进历史），松手提交一步（mergeKey 合并连续微调）。
// 控制框的大小和位置与 compositor 的绘制规则一致：画中画默认「完整显示」(contain)，贴纸按字形实际大小（STICKER_BASE）。
import React, { useRef } from 'react';
import { create } from 'zustand';
import useStore from '../../store.js';
import { getLayout } from './usePlayback.js';
import { overlayDuration } from '../../../engine/timeline.js';
import { useLiveEdit, runOps } from './InspCommon.jsx';
import { makeEditors } from './InspVideo.jsx';
import { stickerSize } from '../../../render/compositor.js';

/** 操作层的界面状态（不进项目） */
export const useTfUi = create(() => ({ crop: false, safe: false }));

const DEG = Math.PI / 180;
const TF0 = { scale: 1, x: 0, y: 0, rotation: 0, flipH: false };
/** 画中画（非贴纸）缺字段时的默认 transform，与 compositor 的 drawOverlays 一致 */
const OVERLAY_TF0 = { scale: 0.42, x: 0.22, y: -0.2 };

function activeTarget(project, sel, t) {
  if (!project) return null;
  if (sel.kind === 'overlay' && (sel.id || sel.overlayId)) {
    const o = (project.overlays || []).find((x) => x.id === (sel.id || sel.overlayId));
    if (o) {
      const start = Number(o.start) || 0;
      const end = start + overlayDuration(o);
      if (t >= start - 1e-3 && t <= end + 1e-3) return { target: 'overlay', item: o };
    }
  }
  const ids = sel.clipIds || [];
  if (ids.length !== 1) return null;
  const it = getLayout(project).find((x) => x.clip.id === ids[0]);
  if (!it) return null;
  if (t < it.start - 1e-3 || t > it.end + 1e-3) return null;
  return { target: 'clip', item: it.clip };
}

/** 派生成字符串：只有「可操作目标」变化时才重渲染，播放头每帧走动不会 */
function targetKey(project, sel, t) {
  const act = activeTarget(project, sel || {}, t);
  return act ? `${act.target}\u0000${act.item.id}` : '';
}

function resolveTarget(project, key) {
  if (!project || !key) return null;
  const [target, id] = key.split('\u0000');
  if (target === 'overlay') {
    const o = (project.overlays || []).find((x) => x.id === id);
    return o ? { target, item: o } : null;
  }
  const it = getLayout(project).find((x) => x.clip.id === id);
  return it ? { target: 'clip', item: it.clip } : null;
}

function isSticker(item, asset) {
  return (item && item.kind === 'sticker') || (asset && asset.kind === 'sticker');
}

function sourceBox(asset, fit, W, H, item) {
  // 贴纸没有像素尺寸：按字形墨迹的实际大小（与 drawSticker 同一套归一化）
  if (isSticker(item, asset)) return stickerSize(asset, W, H);
  const sw = Number(asset && (asset.width || (asset.meta && asset.meta.width))) || W;
  const sh = Number(asset && (asset.height || (asset.meta && asset.meta.height))) || H;
  if (fit === 'fill') return { w: W, h: H };
  const k = fit === 'contain' ? Math.min(W / sw, H / sh) : Math.max(W / sw, H / sh);
  return { w: sw * k, h: sh * k };
}

export default function TransformOverlay({ width: W, height: H }) {
  const project = useStore((s) => s.project);
  const key = useStore((s) => targetKey(s.project, s.selection, s.playhead));
  const playing = useStore((s) => s.playing);
  const crop = useTfUi((s) => s.crop);
  const safe = useTfUi((s) => s.safe);
  const act = resolveTarget(project, key);
  const live = useLiveEdit(act ? act.item.id : '');
  const drag = useRef(null);
  if (!(W > 0 && H > 0)) return null;

  const safeGuides = safe && (
    <div className="tfo-safe" aria-hidden="true">
      <div className="tfo-safe-action" /><div className="tfo-safe-title" />
      <div className="tfo-safe-cross" />
    </div>
  );
  if (!act || playing || act.item.locked) return safeGuides ? <div className="tfo" style={{ width: W, height: H }}>{safeGuides}</div> : null;

  const { item, target } = act;
  const asset = project.assets[item.assetId];
  const sticker = isSticker(item, asset);
  const tf = { ...TF0, ...(target === 'overlay' && !sticker ? OVERLAY_TF0 : null), ...(item.transform || {}) };
  const cr = { l: 0, t: 0, r: 0, b: 0, ...(item.crop || {}) };
  const box = sourceBox(asset, item.fit || (target === 'overlay' ? 'contain' : 'cover'), W, H, item);
  const bw = box.w * tf.scale;
  const bh = box.h * tf.scale;
  const cx = W / 2 + tf.x * W;
  const cy = H / 2 + tf.y * H;
  const E = makeEditors(target, [item]);

  const begin = (e, kind, extra) => {
    e.preventDefault(); e.stopPropagation();
    const rect = e.currentTarget.closest('.tfo').getBoundingClientRect();
    drag.current = { kind, extra, rect, x0: e.clientX, y0: e.clientY, tf, cr, last: null };
    e.currentTarget.setPointerCapture && e.currentTarget.setPointerCapture(e.pointerId);
  };
  const compute = (e) => {
    const d = drag.current;
    const dx = e.clientX - d.x0; const dy = e.clientY - d.y0;
    const px = e.clientX - d.rect.left; const py = e.clientY - d.rect.top;
    if (d.kind === 'move') {
      let x = d.tf.x + dx / W; let y = d.tf.y + dy / H;
      if (!e.altKey) { if (Math.abs(x) < 0.012) x = 0; if (Math.abs(y) < 0.012) y = 0; } // 中心吸附
      return { tf: { x: Math.max(-2, Math.min(2, x)), y: Math.max(-2, Math.min(2, y)) } };
    }
    if (d.kind === 'scale') {
      const r0 = Math.hypot(d.x0 - d.rect.left - cx, d.y0 - d.rect.top - cy) || 1;
      const r1 = Math.hypot(px - cx, py - cy);
      return { tf: { scale: Math.max(0.1, Math.min(4, Math.round(d.tf.scale * (r1 / r0) * 1000) / 1000)) } };
    }
    if (d.kind === 'rotate') {
      let a = Math.atan2(py - cy, px - cx) / DEG + 90;
      if (a > 180) a -= 360;
      if (e.shiftKey) a = Math.round(a / 15) * 15; else { const s45 = Math.round(a / 45) * 45; if (Math.abs(a - s45) < 3) a = s45; }
      return { tf: { rotation: Math.round(a) } };
    }
    if (d.kind === 'crop') {
      // 指针位移转到片段本地坐标（去掉旋转），再换算成比例
      const c = Math.cos(-d.tf.rotation * DEG); const s = Math.sin(-d.tf.rotation * DEG);
      const lx = (dx * c - dy * s) / bw; const ly = (dx * s + dy * c) / bh;
      const n = { ...d.cr };
      const clamp = (v) => Math.max(0, Math.min(0.45, v));
      for (const side of d.extra) {
        if (side === 'l') n.l = clamp(d.cr.l + lx);
        if (side === 'r') n.r = clamp(d.cr.r - lx);
        if (side === 't') n.t = clamp(d.cr.t + ly);
        if (side === 'b') n.b = clamp(d.cr.b - ly);
      }
      return { props: { crop: n } };
    }
    return null;
  };
  const toEdit = (res) => (res.tf ? E.tf(res.tf) : E.props(res.props));
  const onMove = (e) => {
    if (!drag.current) return;
    const res = compute(e); if (!res) return;
    drag.current.last = res;
    live.preview(toEdit(res).fb);
  };
  const onUp = () => {
    const d = drag.current; drag.current = null;
    if (!d || !d.last) { live.restore(); return; }
    const ed = toEdit(d.last);
    live.restore();
    const label = { move: '拖动位置', scale: '拖动缩放', rotate: '拖动旋转', crop: '拖动裁剪' }[d.kind];
    runOps(ed.ops, label, { mergeKey: `tfo:${d.kind}:${item.id}`, fallback: ed.fb });
  };
  const handlers = { onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp };

  const corners = [['nw', -1, -1], ['ne', 1, -1], ['sw', -1, 1], ['se', 1, 1]];
  const edges = [['l', ['l']], ['r', ['r']], ['t', ['t']], ['b', ['b']], ['tl', ['t', 'l']], ['tr', ['t', 'r']], ['bl', ['b', 'l']], ['br', ['b', 'r']]];

  return (
    <div className="tfo" style={{ width: W, height: H }}>
      {safeGuides}
      <div
        className={'tfo-box' + (crop ? ' cropping' : '')}
        style={{ left: cx - bw / 2, top: cy - bh / 2, width: bw, height: bh, transform: `rotate(${tf.rotation}deg)` }}
      >
        {!crop && (
          <>
            <div className="tfo-body" title="拖动移动位置（按住 Alt 关闭中心吸附）" onPointerDown={(e) => begin(e, 'move')} {...handlers} />
            {corners.map(([k]) => <div key={k} className={'tfo-h tfo-' + k} title="拖动缩放" onPointerDown={(e) => begin(e, 'scale')} {...handlers} />)}
            <div className="tfo-rot-stem" />
            <div className="tfo-rot" title="拖动旋转（Shift 每 15° 吸附）" onPointerDown={(e) => begin(e, 'rotate')} {...handlers}>
              <svg viewBox="0 0 16 16" width="12" height="12"><path d="M12.5 6A5 5 0 1 0 13 9" /><path d="M13 3v3h-3" /></svg>
            </div>
            <span className="tfo-badge">{Math.round(tf.scale * 100)}%{tf.rotation ? ` · ${Math.round(tf.rotation)}°` : ''}</span>
          </>
        )}
        {crop && (
          <>
            <div className="tfo-crop-shade" style={{ clipPath: `polygon(0 0,100% 0,100% 100%,0 100%,0 0,${cr.l * 100}% ${cr.t * 100}%,${cr.l * 100}% ${(1 - cr.b) * 100}%,${(1 - cr.r) * 100}% ${(1 - cr.b) * 100}%,${(1 - cr.r) * 100}% ${cr.t * 100}%,${cr.l * 100}% ${cr.t * 100}%)` }} />
            <div className="tfo-crop" style={{ left: `${cr.l * 100}%`, top: `${cr.t * 100}%`, right: `${cr.r * 100}%`, bottom: `${cr.b * 100}%` }}>
              <div className="tfo-crop-grid" />
              {edges.map(([k, sides]) => <div key={k} className={'tfo-ch tfo-c-' + k} onPointerDown={(e) => begin(e, 'crop', sides)} {...handlers} />)}
            </div>
            <button type="button" className="tfo-done" onClick={() => useTfUi.setState({ crop: false })}>完成裁剪</button>
          </>
        )}
      </div>
    </div>
  );
}
