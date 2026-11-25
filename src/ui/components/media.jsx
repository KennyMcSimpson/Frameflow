// 共享媒体小组件：素材缩略图、来源圆点、预演（示意）画布。
import React, { useEffect, useRef, useState } from 'react';
import api from '../api.js';
import { Icon } from './ui.jsx';
import { drawPreviz } from '../../render/previz.js';

const KIND_ICON = { video: 'film', image: 'image', audio: 'music', previz: 'sparkles', 'generated-image': 'wand' };

/** 画面来源 → 颜色与中文名。示意(previz)只是占位，不是成品。颜色全部取自 tokens.css。 */
export const SOURCE_META = {
  stock: { label: '实拍素材', color: 'var(--ok)' },
  ai: { label: 'AI 生成', color: 'var(--ai, var(--violet))' },
  local: { label: '本地导入', color: 'var(--info)' },
  previz: { label: '示意（非成品）', color: 'var(--text-2)' },
  none: { label: '缺画面', color: 'var(--warn)' },
};

/**
 * 由素材推断来源。同时认旧写法（source 是字符串 'videogen' / 'stock' / 'previz'）
 * 和契约 C3 的对象写法（source.kind、asset.ai），示例素材和内置素材算「实拍素材」。
 * 网页/视频站下载的素材版权不明，不标成「实拍素材」，按用户自己导入的算。
 */
export function assetSourceKind(asset) {
  if (!asset) return 'none';
  const src = asset.source;
  const kind = src && typeof src === 'object' ? src.kind || src.type : src;
  if (asset.kind === 'previz' || kind === 'previz') return 'previz';
  if (asset.ai || asset.kind === 'generated-image' || kind === 'videogen' || kind === 'ai' || kind === 'ai-image') return 'ai';
  if (kind === 'stock' || kind === 'sample' || kind === 'builtin' || (asset.stock && !kind)) return 'stock';
  return 'local';
}

/** 6px 来源圆点。kind: stock | ai | local | previz | none */
export function SourceDot({ kind = 'none', size = 6, withLabel = false, className = '', style }) {
  const meta = SOURCE_META[kind] || SOURCE_META.none;
  const dot = (
    <i
      aria-hidden={withLabel ? 'true' : undefined}
      style={{ display: 'inline-block', flex: 'none', width: size, height: size, borderRadius: '50%', background: meta.color, boxShadow: '0 0 0 1.5px rgba(0,0,0,.45)' }}
    />
  );
  if (!withLabel) return <span className={'source-dot ' + className} title={meta.label} aria-label={meta.label} style={{ display: 'inline-flex', ...style }}>{dot}</span>;
  return (
    <span className={'source-dot ' + className} title={meta.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, ...style }}>
      {dot}<span>{meta.label}</span>
    </span>
  );
}

/** 视频首帧：没有缩略图文件时直接用 <video> 取第一帧。 */
function VideoFirstFrame({ asset }) {
  return (
    <video
      src={api.mediaUrl(asset.path)}
      muted
      playsInline
      preload="metadata"
      onLoadedMetadata={(e) => { try { e.currentTarget.currentTime = Math.min(0.5, (e.currentTarget.duration || 0) / 4); } catch { /* 忽略 */ } }}
      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
    />
  );
}

/** 素材缩略图。实拍/AI 视频优先显示首帧；previz 资产画示意首帧并带「示意」水印。 */
export function AssetThumb({ asset, width = 120, height = 68, className = '', style, showKind = true, playing = false }) {
  if (!asset) return <div className={'thumb ' + className} style={{ width, height, ...style }} />;
  if (asset.kind === 'previz' && asset.previz) {
    return (
      <div className={'thumb ' + className} style={{ width, height, ...style }}>
        <PrevizCanvas spec={asset.previz} width={width} height={height} playing={playing} progress={0.35} watermark={false} style={{ width: '100%', height: '100%' }} />
      </div>
    );
  }
  const src = asset.thumb ? api.mediaUrl(asset.thumb) : (asset.kind === 'image' || asset.kind === 'generated-image') && asset.path ? api.mediaUrl(asset.path) : null;
  const videoFrame = !src && asset.kind === 'video' && asset.path && !asset.missing;
  return (
    <div className={'thumb ' + className} style={{ width, height, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden', ...style }}>
      {src ? <img src={src} alt="" draggable={false} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        : videoFrame ? <VideoFirstFrame asset={asset} />
          : <Icon name={KIND_ICON[asset.kind] || 'film'} size={22} style={{ opacity: 0.5 }} />}
      {showKind && asset.kind !== 'audio' && (
        <SourceDot kind={assetSourceKind(asset)} style={{ position: 'absolute', left: 6, bottom: 6, pointerEvents: 'none' }} />
      )}
    </div>
  );
}

/** 页面不可见 / 元素滚出视口时返回 false，用于暂停动画 */
function useVisible(ref) {
  const [inView, setInView] = useState(true);
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || !document.hidden);
  useEffect(() => {
    const onVis = () => setPageVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((entries) => { const e = entries[entries.length - 1]; if (e) setInView(e.isIntersecting); });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return inView && pageVisible;
}

const HINT_STYLE = {
  position: 'absolute', right: 6, top: 6, padding: '0 5px', borderRadius: 4, fontSize: 10, lineHeight: '15px', letterSpacing: 1,
  background: 'rgba(0,0,0,.55)', color: 'rgba(255,255,255,.82)', pointerEvents: 'none', userSelect: 'none',
};

/**
 * 预演（示意）动画画布。playing=true 时循环播放（周期 = duration 秒，默认 4），否则停在 progress。
 * 滚出视口或窗口隐藏时自动暂停。hint=true 时右上角显示「示意」水印，提醒这不是成品画面。
 */
export function PrevizCanvas({ spec, width = 240, height = 135, playing = false, progress = 0.3, duration = 4, label, watermark = true, hint = true, shotSize, movement, className = '', style }) {
  const wrapRef = useRef(null);
  const ref = useRef(null);
  const visible = useVisible(wrapRef);
  const animate = playing && visible;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !spec) return undefined;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    const draw = (p) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      try { drawPreviz(ctx, spec, p, canvas.width, canvas.height, { label, watermark, shotSize, movement }); } catch (e) { /* 渲染失败时保持空白 */ }
    };
    if (!animate) { draw(progress); return undefined; }
    let raf = 0; const t0 = performance.now();
    const loop = (now) => {
      const p = (((now - t0) / 1000) % duration) / duration;
      draw(p);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [spec, width, height, animate, progress, duration, label, watermark, shotSize, movement]);
  return (
    <span ref={wrapRef} className={className} style={{ position: 'relative', display: 'block', width, height, borderRadius: 'inherit', overflow: 'hidden', ...style }}>
      <canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block', borderRadius: 'inherit' }} />
      {hint && <span style={HINT_STYLE}>示意</span>}
    </span>
  );
}
