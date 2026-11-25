// 拆片详情（右栏）：标题区 + 播放器舞台（常驻）+ 四个 Tab：概览 · 镜头 · 图表 · 技法。
// 未选中视频时显示「内置精选技法」，没有任何拆片记录时附带 6 宫格首次引导。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api.js';
import useStore from '../../store.js';
import { Icon, Button, Chip, Empty, Spinner, Tabs } from '../../components/ui.jsx';
import { ANALYSIS_CATEGORY_LABELS, TECHNIQUE_CATEGORY_LABELS } from '../../../engine/model.js';
import { BUILTIN_TECHNIQUES } from '../../../engine/builtinTechniques.js';
import useLibrary from './libraryActions.js';
import { RhythmChart, CurvesChart, ColorTimeline, PaletteSwatches } from './Charts.jsx';
import { ShotStrip, ShotDetail } from './ShotPanels.jsx';
import TechniqueColumn from './TechniqueColumn.jsx';
import {
  shotIndexAt, transcriptIndexAt, describeTone, describeRhythm, fmtSec, fmtClock, fmtDate, PLATFORM_LABELS, detectPlatform,
  techniquesForAnalysis, buildAnalysisReport, reportFileName,
} from './libraryUtils.js';

const BUILTIN_COUNT = Array.isArray(BUILTIN_TECHNIQUES) ? BUILTIN_TECHNIQUES.length : 0;

export default function AnalysisDetail({ onAdd }) {
  const current = useLibrary((s) => s.current);
  const loading = useLibrary((s) => s.currentLoading);
  const error = useLibrary((s) => s.currentError);
  const selectedId = useLibrary((s) => s.selectedId);
  const analysesCount = useLibrary((s) => s.analyses.length);
  const listLoaded = useLibrary((s) => s.listLoaded);
  const myCount = useLibrary((s) => s.techniques.length);

  if (loading && (!current || current.id !== selectedId)) {
    return <div className="lib-state"><Spinner /> <span>正在打开分析…</span></div>;
  }
  if (error) {
    return (
      <div className="lib-state">
        <Empty icon="film" title="打不开这条分析" action={<Button icon="refresh" onClick={() => useLibrary.getState().reloadCurrent()}>重试</Button>}>
          {error}
        </Empty>
      </div>
    );
  }
  if (!current) return <LibraryHome analysesCount={analysesCount} myCount={myCount} listLoaded={listLoaded} onAdd={onAdd} />;
  return <DetailView key={current.id} analysis={current} />;
}

// ------------------------------------------------------------------
// 未选中视频：首次引导（6 宫格）+ 内置精选技法
// ------------------------------------------------------------------
const FEATURES = [
  { icon: 'scissors', title: '镜头切分', text: '自动找出每一次剪切，抽取关键帧，算出每镜时长与剪辑节奏。' },
  { icon: 'palette', title: '色彩与光线', text: '统计亮度、对比、饱和、冷暖与主色板，看懂整片的调色思路。' },
  { icon: 'bolt', title: '运动与响度', text: '画面运动强度和声音起伏曲线，找到情绪高点与卡点位置。' },
  { icon: 'text', title: '台词字幕', text: '有字幕的视频会把台词按时间整理出来，点一下就跳到那句话。' },
  { icon: 'sparkles', title: 'AI 看关键帧', text: '标注景别、角度、运镜、光线、构图、转场与镜头用途。' },
  { icon: 'book', title: '沉淀技法卡', text: '把学到的手法存成技法卡，一键应用到你自己的时间线。' },
];

function LibraryHome({ analysesCount, myCount, listLoaded, onAdd }) {
  const firstTime = listLoaded && analysesCount === 0;
  return (
    <div className="lib-home">
      {firstTime ? (
        <section className="lib-intro">
          <div className="lib-intro-hero">
            <span className="lib-intro-badge"><Icon name="film" size={20} /></span>
            <div>
              <h2>把好视频「拆开」学</h2>
              <p>粘贴 B站 / YouTube / 抖音链接，或选择本地视频。镜流会分析它的镜头、节奏、色彩、声音和台词，再整理成可复用的技法卡。</p>
            </div>
            {onAdd && (
              <div className="lib-intro-cta">
                <Button icon="plus" className="lib-add-btn" onClick={() => onAdd('add')}>拆第一个视频</Button>
                <Button variant="ghost" icon="globe" onClick={() => onAdd('topic')}>按主题找视频</Button>
              </div>
            )}
          </div>
          <div className="lib-intro-grid">
            {FEATURES.map((f, i) => (
              <div key={f.title} className="lib-intro-card">
                <span className="lib-intro-num">{String(i + 1).padStart(2, '0')}</span>
                <Icon name={f.icon} size={18} />
                <div className="lib-intro-title">{f.title}</div>
                <div className="lib-intro-text">{f.text}</div>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <section className="lib-home-head">
          <div>
            <h2>内置精选技法</h2>
            <p>{BUILTIN_COUNT} 条离线可用的剪辑技法 · 我的技法卡 {myCount} 张 · 拆片记录 {analysesCount} 条。从左侧选择一条拆片查看详情。</p>
          </div>
        </section>
      )}
      <section className="lib-home-tech">
        <TechniqueColumn initialTab="builtin" title={firstTime ? '先看看内置精选技法' : null} />
      </section>
      <p className="lib-foot-note">分析的视频仅供个人学习参考，版权归原作者所有。</p>
    </div>
  );
}

// ------------------------------------------------------------------
// 播放时间跟踪：回调 ref 拿到 <video> 元素，晚挂载 / 重新挂载也能正确绑定
// ------------------------------------------------------------------
function usePlayback(videoEl, rangeEndRef) {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const v = videoEl;
    if (!v) return undefined;
    let raf = 0; let last = 0;
    setTime(v.currentTime || 0);
    setPlaying(!v.paused && !v.ended);
    const checkRange = () => {
      const end = rangeEndRef.current;
      if (end != null && v.currentTime >= end) { rangeEndRef.current = null; v.pause(); }
    };
    const tick = (now) => {
      checkRange();
      if (now - last > 66) { last = now; setTime(v.currentTime); }
      if (!v.paused && !v.ended) raf = requestAnimationFrame(tick);
    };
    const onPlay = () => { setPlaying(true); cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); };
    const onPause = () => { setPlaying(false); cancelAnimationFrame(raf); setTime(v.currentTime); };
    const onSeeked = () => setTime(v.currentTime);
    const onTime = () => { checkRange(); if (v.paused) setTime(v.currentTime); };
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onPause);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('timeupdate', onTime);
    if (!v.paused) onPlay();
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onPause);
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('timeupdate', onTime);
    };
  }, [videoEl, rangeEndRef]);
  return { time, setTime, playing };
}

/** 导出 Markdown 报告：优先走浏览器下载（Electron 会弹出保存对话框），失败则复制到剪贴板 */
function exportReport(analysis, techniques) {
  const toast = useStore.getState().toast;
  const md = buildAnalysisReport(analysis, techniques, { category: ANALYSIS_CATEGORY_LABELS, techCategory: TECHNIQUE_CATEGORY_LABELS });
  try {
    const blob = new Blob(['﻿' + md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = reportFileName(analysis);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('拆片报告已导出（Markdown）', 'ok');
  } catch (e) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(md).then(() => toast('无法保存文件，报告已复制到剪贴板', 'info'), () => toast('导出失败：' + e.message, 'error'));
    } else toast('导出失败：' + e.message, 'error');
  }
}

// ------------------------------------------------------------------
// 详情主体
// ------------------------------------------------------------------
function DetailView({ analysis }) {
  const videoRef = useRef(null);
  const [videoEl, setVideoEl] = useState(null);
  const bindVideo = useCallback((el) => { videoRef.current = el; setVideoEl(el); }, []);
  const rangeEndRef = useRef(null);
  const pendingRef = useRef(null);
  const { time, setTime, playing } = usePlayback(videoEl, rangeEndRef);
  const [selIdx, setSelIdx] = useState(analysis.shots.length ? 0 : -1);
  const [videoError, setVideoError] = useState(null);
  const [tab, setTab] = useState('overview');
  const seekReq = useLibrary((s) => s.seekReq);
  const techniques = useLibrary((s) => s.techniques);
  const techCount = useMemo(() => techniquesForAnalysis(techniques, analysis).length, [techniques, analysis]);
  const shots = analysis.shots;
  const currentIdx = shotIndexAt(shots, time);

  const doSeek = useCallback((t, play = false, end = null) => {
    const v = videoRef.current;
    const target = Math.max(0, Number(t) || 0);
    setSelIdx(shotIndexAt(shots, target));
    if (!v) { pendingRef.current = { t: target, play, end }; return; }
    if (v.readyState < 1) { pendingRef.current = { t: target, play, end }; return; }
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : analysis.duration;
    v.currentTime = Math.min(target, Math.max(0, dur - 0.05));
    setTime(v.currentTime);
    rangeEndRef.current = end != null && end > target ? end : null;
    if (play) v.play().catch(() => {});
  }, [shots, analysis.duration, setTime]);

  useEffect(() => {
    if (!seekReq || seekReq.analysisId !== analysis.id) return;
    doSeek(seekReq.t, seekReq.play, seekReq.end);
    useLibrary.getState().clearSeek(seekReq.nonce);
  }, [seekReq, analysis.id, doSeek]);

  useEffect(() => {
    if (playing && currentIdx >= 0 && currentIdx !== selIdx) setSelIdx(currentIdx);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, currentIdx]);

  useEffect(() => {
    const s = selIdx >= 0 ? shots[selIdx] : null;
    useLibrary.getState().setFocusShot(s ? { index: selIdx, start: s.start, end: s.end } : null);
  }, [selIdx, shots]);
  useEffect(() => () => useLibrary.getState().setFocusShot(null), []);

  const onLoadedMeta = () => {
    setVideoError(null);
    const p = pendingRef.current;
    if (p) { pendingRef.current = null; doSeek(p.t, p.play, p.end); }
  };

  const pickShot = useCallback((i) => {
    const s = shots[i];
    if (!s) return;
    doSeek(s.start, false);
    setSelIdx(i);
  }, [shots, doSeek]);
  const seekOnly = useCallback((t) => doSeek(t, false), [doSeek]);
  const seekPlay = useCallback((t) => doSeek(t, true), [doSeek]);
  const seekShot = useCallback((t, play) => doSeek(t, play), [doSeek]);
  const prevShot = useCallback(() => pickShot(selIdx - 1), [pickShot, selIdx]);
  const nextShot = useCallback(() => pickShot(selIdx + 1), [pickShot, selIdx]);

  const openSource = () => {
    const src = analysis.source || {};
    if (src.url) api.call('shell:openExternal', { url: src.url }).catch((e) => useStore.getState().toast('打开网页失败：' + e.message, 'error'));
    else if (src.path || analysis.assetPath) api.call('shell:showItem', { path: src.path || analysis.assetPath }).catch((e) => useStore.getState().toast('打开文件夹失败：' + e.message, 'error'));
  };

  const srcUrl = analysis.source && analysis.source.url;
  const platform = srcUrl ? (analysis.source.platform || detectPlatform(srcUrl)) : null;
  const aiReason = analysis.errors.find((e) => /AI/.test(e));
  const aiReasonText = aiReason ? aiReason.replace(/[，,]?已基于统计生成技法/, '') : '';
  const otherErrors = analysis.errors.filter((e) => e !== aiReason);
  const sel = selIdx >= 0 ? shots[selIdx] : null;
  const lineIdx = transcriptIndexAt(analysis.transcript, time);

  return (
    <div className="lib-detail">
      <header className="lib-detail-head">
        <div className="lib-detail-titles">
          <h2 className="lib-detail-title selectable" title={analysis.title}>{analysis.title}</h2>
          <div className="lib-detail-meta">
            <Chip kind="accent">{ANALYSIS_CATEGORY_LABELS[analysis.category] || '其他'}</Chip>
            <Chip>{platform ? (PLATFORM_LABELS[platform] || platform) : '本地视频'}</Chip>
            <span className="mono">{fmtClock(analysis.duration)}</span>
            {analysis.width > 0 && <span className="mono">{analysis.width}×{analysis.height}{analysis.fps ? ` · ${Math.round(analysis.fps)}fps` : ''}</span>}
            <span>{shots.length} 个镜头</span>
            {analysis.createdAt && <span>分析于 {fmtDate(analysis.createdAt)}</span>}
            {analysis.status === 'partial' && <Chip kind="warn">部分完成</Chip>}
            {analysis.ai ? <Chip kind="ai" dot>AI 已标注</Chip> : <Chip dot>统计分析</Chip>}
          </div>
        </div>
        <div className="lib-detail-actions">
          <Button size="sm" icon="download" onClick={() => exportReport(analysis, techniques)} title="导出 Markdown 格式的拆片报告">导出报告</Button>
          {(srcUrl || (analysis.source && analysis.source.path) || analysis.assetPath) && (
            <Button size="sm" variant="ghost" icon={srcUrl ? 'external' : 'folder'} onClick={openSource}>
              {srcUrl ? '原网页' : '所在文件夹'}
            </Button>
          )}
        </div>
      </header>

      {!analysis.ai && (
        <div className="lib-callout ai">
          <Icon name="sparkles" size={14} />
          <span><b>AI 未标注，已基于统计生成技法。</b>{aiReasonText ? ` ${aiReasonText}。` : ' '}连接 AI 并开启「用 AI 看关键帧标注」后重新拆片，可获得逐镜头的景别、运镜、光线标注。</span>
        </div>
      )}
      {otherErrors.length > 0 && (
        <div className="lib-callout warn">
          <Icon name="info" size={14} />
          <span><b>{analysis.status === 'partial' ? '部分步骤未完成：' : '提示：'}</b>{otherErrors.join('；')}</span>
        </div>
      )}

      <div className="lib-stage">
        <div className="lib-player">
          {analysis.assetPath ? (
            <video
              ref={bindVideo}
              controls
              preload="metadata"
              src={api.mediaUrl(analysis.assetPath)}
              onLoadedMetadata={onLoadedMeta}
              onError={() => setVideoError('无法播放这个视频文件（可能已被移动、删除，或格式不受支持）')}
            />
          ) : <div className="lib-player-err">这条分析没有可播放的视频文件</div>}
          {videoError && <div className="lib-player-err">{videoError}</div>}
        </div>
        <ShotDetail shot={sel} index={selIdx} total={shots.length} onSeek={seekShot} onPrev={prevShot} onNext={nextShot} />
      </div>

      <div className="lib-strip-wrap">
        <ShotStrip shots={shots} selIdx={selIdx} currentIdx={currentIdx} playing={playing} onPick={pickShot} />
      </div>

      <div className="lib-tabs">
        <Tabs
          className="underline"
          value={tab}
          onChange={setTab}
          items={[
            { value: 'overview', label: '概览', icon: 'grid' },
            { value: 'shots', label: '镜头', icon: 'scissors', badge: shots.length },
            { value: 'charts', label: '图表', icon: 'bolt' },
            { value: 'tech', label: '技法', icon: 'book', badge: techCount },
          ]}
        />
      </div>

      <div className="lib-tabpane">
        {tab === 'overview' && (
          <>
            <Metrics analysis={analysis} />
            <AiInsights analysis={analysis} time={time} onSeek={seekPlay} />
            <Transcript items={analysis.transcript} activeIdx={lineIdx} isFile={!srcUrl} onSeek={seekPlay} />
          </>
        )}
        {tab === 'shots' && <ShotTable shots={shots} selIdx={selIdx} currentIdx={currentIdx} onPick={pickShot} />}
        {tab === 'charts' && (
          <>
            <div className="lib-card"><RhythmChart shots={shots} avg={analysis.rhythm.avgShot} activeIndex={selIdx} onPick={pickShot} /></div>
            <div className="lib-card"><CurvesChart shots={shots} audioCurve={analysis.audio.curve} duration={analysis.duration} time={time} onSeek={seekOnly} /></div>
            <div className="lib-card">
              <div className="lib-chart-head">
                <span className="lib-chart-title">色板</span>
                <span className="lib-chart-sub">全片主色与每个镜头的色彩时间线</span>
              </div>
              <div className="lib-palette-main">
                <span className="lib-label">全片主色</span>
                <PaletteSwatches palette={analysis.colorProfile ? analysis.colorProfile.palette : []} />
              </div>
              <div className="lib-label lib-label-gap">色彩时间线</div>
              <ColorTimeline shots={shots} duration={analysis.duration} time={time} activeIndex={selIdx} onPick={pickShot} />
            </div>
          </>
        )}
        {tab === 'tech' && (
          <div className="lib-card lib-card-flush">
            <TechniqueColumn initialTab="video" />
          </div>
        )}
      </div>

      <p className="lib-foot-note">分析内容仅供个人学习参考，视频版权归原作者所有。</p>
    </div>
  );
}

// ------------------------------------------------------------------
// 镜头表
// ------------------------------------------------------------------
const ShotTable = React.memo(function ShotTable({ shots, selIdx, currentIdx, onPick }) {
  if (!shots.length) return <div className="lib-card lib-strip-empty">没有检测到镜头切换。</div>;
  return (
    <div className="lib-card lib-card-flush">
      <div className="lib-shot-table" role="table">
        <div className="lib-shot-row head" role="row">
          <span>#</span><span>画面</span><span>入点</span><span>时长</span><span>景别</span><span>运镜</span><span>用途 / 说明</span>
        </div>
        {shots.map((s, i) => {
          const ai = s.ai || {};
          return (
            <button
              key={i}
              type="button"
              role="row"
              className={'lib-shot-row' + (i === selIdx ? ' selected' : '') + (i === currentIdx ? ' current' : '')}
              onClick={() => onPick(i)}
            >
              <span className="mono">{i + 1}</span>
              <span className="lib-shot-thumb">{s.thumb ? <img src={api.mediaUrl(s.thumb)} alt="" loading="lazy" draggable={false} /> : null}</span>
              <span className="mono">{fmtClock(s.start)}</span>
              <span className="mono">{fmtSec(s.duration)}</span>
              <span>{ai.shotSize || '—'}</span>
              <span>{ai.movement || '—'}</span>
              <span className="lib-shot-desc">{ai.purpose || ai.notes || ai.subject || '—'}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
});

function Section({ title, sub, children, right }) {
  return (
    <div className="lib-card">
      <div className="lib-chart-head">
        <span className="lib-chart-title">{title}</span>
        {sub && <span className="lib-chart-sub">{sub}</span>}
        <span className="grow" />
        {right}
      </div>
      {children}
    </div>
  );
}

// ------------------------------------------------------------------
// 关键指标卡
// ------------------------------------------------------------------
const Metrics = React.memo(function Metrics({ analysis }) {
  const r = analysis.rhythm;
  const tone = describeTone(analysis.colorProfile);
  const items = [
    { k: '平均镜头时长', v: r.avgShot > 0 ? fmtSec(r.avgShot) : '—', d: r.medianShot > 0 ? `中位数 ${fmtSec(r.medianShot)}` : '' },
    { k: '每分钟切换', v: r.cutsPerMinute > 0 ? `${r.cutsPerMinute.toFixed(1)} 次` : '—', d: describeRhythm(r.avgShot) },
    { k: '总镜头数', v: `${analysis.shots.length}`, d: `全片 ${fmtSec(analysis.duration, 0)}` },
    { k: '整体色调', v: tone, d: analysis.colorProfile ? '基于全片关键帧统计' : '', wide: true },
  ];
  return (
    <div className="lib-metrics">
      {items.map((it) => (
        <div key={it.k} className={'lib-metric' + (it.wide ? ' wide' : '')}>
          <div className="lib-metric-k">{it.k}</div>
          <div className="lib-metric-v">{it.v}</div>
          {it.d && <div className="lib-metric-d">{it.d}</div>}
        </div>
      ))}
    </div>
  );
});

// ------------------------------------------------------------------
// AI 解读：summary / style / highlights / structure
// ------------------------------------------------------------------
function AiInsights({ analysis, time, onSeek }) {
  const ai = analysis.ai;
  if (!ai) return null;
  const total = Math.max(0.1, analysis.duration);
  const structure = ai.structure.filter((s) => s.end > s.start || s.label);
  return (
    <div className="lib-card">
      <div className="lib-chart-head">
        <span className="lib-chart-title"><Icon name="sparkles" size={13} style={{ color: 'var(--ai, var(--violet))', marginRight: 4, verticalAlign: -2 }} />AI 解读</span>
        <span className="lib-chart-sub">基于关键帧与统计数据</span>
      </div>
      {ai.summary && <p className="lib-ai-summary selectable">{ai.summary}</p>}
      {ai.style && (
        <div className="lib-aifield"><span className="k">风格</span><span className="v selectable">{ai.style}</span></div>
      )}
      {ai.highlights.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="lib-label" style={{ marginBottom: 4 }}>值得学习的地方</div>
          <ul className="lib-highlights selectable">
            {ai.highlights.map((h, i) => <li key={i}>{h}</li>)}
          </ul>
        </div>
      )}
      {structure.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="lib-label" style={{ marginBottom: 6 }}>结构分段</div>
          <div className="lib-structure-bar">
            {structure.map((s, i) => {
              const left = (Math.min(s.start, total) / total) * 100;
              const width = Math.max(0.8, ((Math.min(s.end, total) - Math.min(s.start, total)) / total) * 100);
              const active = time >= s.start && time < s.end;
              return (
                <button
                  key={i} type="button"
                  className={`lib-structure-seg c${i % 3}${active ? ' active' : ''}`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${s.label}（${fmtClock(s.start)}–${fmtClock(s.end)}）${s.description ? '：' + s.description : ''}`}
                  onClick={() => onSeek(s.start)}
                >
                  <span>{s.label}</span>
                </button>
              );
            })}
            <span className="lib-structure-playhead" style={{ left: `${(Math.min(time, total) / total) * 100}%` }} />
          </div>
          <div className="lib-structure-list">
            {structure.map((s, i) => (
              <button key={i} type="button" className="lib-structure-item" onClick={() => onSeek(s.start)}>
                <span className={`lib-structure-dot c${i % 3}`} />
                <span className="lib-structure-label">{s.label || `第 ${i + 1} 段`}</span>
                <span className="xs muted mono">{fmtClock(s.start)}–{fmtClock(s.end)}</span>
                {s.description && <span className="lib-structure-desc">{s.description}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// 台词
// ------------------------------------------------------------------
const Transcript = React.memo(function Transcript({ items, activeIdx, isFile, onSeek }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const all = items.map((x, i) => ({ ...x, i }));
    return s ? all.filter((x) => x.text.toLowerCase().includes(s)) : all;
  }, [items, q]);
  return (
    <Section
      title="台词"
      sub={items.length ? `${items.length} 句，点击跳转` : ''}
      right={items.length > 8 ? <input className="input lib-mini-search" placeholder="搜索台词" value={q} onChange={(e) => setQ(e.target.value)} /> : null}
    >
      {!items.length ? (
        <div className="lib-strip-empty">
          该视频没有可用字幕。{isFile ? '本地视频暂不自动识别语音，可在画面与节奏数据中学习它的手法。' : '原视频没有提供字幕或自动字幕。'}
        </div>
      ) : (
        <div className="lib-transcript">
          {list.map((x) => (
            <button key={x.i} type="button" className={'lib-line' + (x.i === activeIdx ? ' active' : '')} onClick={() => onSeek(x.start)}>
              <span className="mono xs">{fmtClock(x.start)}</span>
              <span className="lib-line-text">{x.text}</span>
            </button>
          ))}
          {!list.length && <div className="hint">没有匹配「{q}」的台词</div>}
        </div>
      )}
    </Section>
  );
});
