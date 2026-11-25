// 属性 · 字幕：识别字幕（本地语音识别）、逐句编辑、合并/拆分、统一样式、导出 SRT。
import React, { useMemo, useState } from 'react';
import useStore from '../../store.js';
import api from '../../api.js';
import { Button, Icon, ProgressBar, fmtTime } from '../../components/ui.jsx';
import { InspSection, CAPTIONS, runOp, T_NONE } from './InspCommon.jsx';
import { TextStyle } from './InspTextAudio.jsx';
import { getLayout } from './usePlayback.js';
import { isCaptionText } from '../../../engine/model.js';

// 语音识别的字幕和初剪按镜头文案生成的字幕都算字幕（与引擎的 clearCaptions / updateCaptionStyle 一致）
const isCaption = isCaptionText;
const srtTime = (s) => {
  const ms = Math.max(0, Math.round(s * 1000));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
export function localSrt(texts) {
  return texts.map((t, i) => `${i + 1}\n${srtTime(t.start)} --> ${srtTime(t.start + t.duration)}\n${t.text}\n`).join('\n');
}

/** 选一个有声音的素材做识别：优先音频轨的人声，其次第一个带声音的视频片段 */
function pickSource(project) {
  const pathOf = (a) => (a && (a.originalPath || a.path)) || '';
  const voice = (project.tracks.audio || []).find((a) => a.role === 'voice' && pathOf(project.assets[a.assetId]));
  if (voice) {
    const a = project.assets[voice.assetId];
    return { assetId: voice.assetId, audioPath: pathOf(a), offset: voice.start - voice.in, name: a?.name };
  }
  for (const it of getLayout(project)) {
    const a = project.assets[it.clip.assetId];
    if (a && a.kind === 'video' && a.hasAudio !== false && pathOf(a)) {
      return { assetId: a.id, audioPath: pathOf(a), offset: it.start - it.clip.in, name: a.name };
    }
  }
  const any = (project.tracks.audio || []).find((a) => pathOf(project.assets[a.assetId]));
  if (any) {
    const a = project.assets[any.assetId];
    return { assetId: any.assetId, audioPath: pathOf(a), offset: any.start - any.in, name: a?.name };
  }
  return null;
}

export default function CaptionPanel({ focusId, active = true }) {
  const project = useStore((s) => s.project);
  const activeCapId = useStore((s) => {
    if (!active || !s.project) return null;
    const t = s.playhead;
    const list = s.project.tracks.text || [];
    for (let i = 0; i < list.length; i += 1) {
      const c = list[i];
      if (isCaption(c) && t >= c.start && t < c.start + c.duration) return c.id;
    }
    return null;
  });
  const [busy, setBusy] = useState(null); // {stage, progress, message}
  const [needModel, setNeedModel] = useState(null);
  const caps = useMemo(() => (project.tracks.text || []).filter(isCaption).sort((a, b) => a.start - b.start), [project.tracks.text]);
  const first = caps.find((c) => c.id === focusId) || caps[0];
  const st = () => useStore.getState();
  const asr = api.asr || null;

  async function recognize() {
    const src = pickSource(st().project);
    if (!src) { st().toast('时间线上没有带声音的素材，无法识别字幕', 'warn'); return; }
    if (!api.available) { st().toast('识别字幕需要在桌面版中运行', 'warn'); return; }
    const projectId = st().project.id;
    try {
      let s = null;
      try { s = asr && asr.status ? await asr.status() : await api.call('asr:status'); } catch { s = { ready: false, downloadable: false, reason: '当前版本未包含语音识别组件' }; }
      if (s && !s.ready) { setNeedModel(s); return; }
      setBusy({ progress: 0, message: '正在准备音频…' });
      if (st().saveState === 'dirty' && typeof st().saveNow === 'function') {
        await st().saveNow();
      }
      const curProj = st().project;
      if (!curProj || curProj.id !== projectId) return;
      const asset = curProj.assets && curProj.assets[src.assetId];
      const audioPath = (asset && (asset.originalPath || asset.path)) || src.audioPath || undefined;
      const payload = { projectId: curProj.id, assetId: src.assetId, lang: 'zh', ...(audioPath ? { audioPath } : {}) };
      const res = await api.job('asr:transcribe', payload, (p) => setBusy({ progress: p.progress || 0, message: p.message || '识别中…' }));
      if (!st().project || st().project.id !== projectId) return;
      const segs = ((res && res.segments) || []).map((g) => ({ ...g, start: g.start + src.offset, end: g.end + src.offset })).filter((g) => g.end > 0 && String(g.text || '').trim());
      if (!segs.length) { st().toast('没有识别到说话内容', 'warn'); return; }
      const r = runOp({ type: 'addCaptions', segments: segs, preset: 'subtitle' }, `识别字幕 ${segs.length} 句`, {
        fallback: (p) => {
          const texts = typeof CAPTIONS.segmentsToTexts === 'function'
            ? CAPTIONS.segmentsToTexts(segs, { preset: 'subtitle', aspect: p.settings.aspect })
            : segs.map((g, i) => ({ id: `cap_${Date.now().toString(36)}_${i}`, text: g.text.trim(), start: g.start, duration: Math.max(0.3, g.end - g.start), preset: 'subtitle', x: 0.5, y: 0.86, size: 1, color: '#ffffff', animation: 'none' }));
          return { ...p, tracks: { ...p.tracks, text: [...p.tracks.text.filter((t) => !isCaption(t)), ...texts.map((t) => ({ ...t, group: 'caption' }))] } };
        },
      });
      if (r && r.ok) st().toast(`已生成 ${segs.length} 句字幕`, 'ok');
    } catch (e) {
      st().toast('识别字幕失败：' + (e && e.message ? e.message : '未知原因'), 'error');
    } finally { setBusy(null); }
  }

  async function installModel() {
    try {
      setBusy({ progress: 0, message: '正在下载语音识别模型…' });
      await api.job('asr:installModel', {}, (p) => setBusy({ progress: p.progress || 0, message: p.message || '下载中…' }));
      setNeedModel(null);
      st().toast('语音识别模型已安装', 'ok');
    } catch (e) {
      st().toast('安装失败：' + (e && e.message ? e.message : '网络错误'), 'error');
    } finally { setBusy(null); }
  }

  const upd = (c, patch, label) => runOp({ type: 'updateText', target: T_NONE, textId: c.id, text: patch }, label, { mergeKey: 'cap:' + c.id });
  const merge = (i) => {
    const a = caps[i]; const b = caps[i + 1]; if (!a || !b) return;
    st().commit((p) => ({
      ...p,
      tracks: {
        ...p.tracks,
        text: p.tracks.text.filter((t) => t.id !== b.id).map((t) => (t.id === a.id ? { ...t, text: `${a.text}${a.text && b.text ? ' ' : ''}${b.text}`, duration: Math.max(0.3, b.start + b.duration - a.start) } : t)),
      },
    }), '合并字幕');
  };
  const split = (c) => {
    const s = String(c.text || '');
    const at = Math.max(1, Math.round(s.length / 2));
    const ph = st().playhead;
    const local = ph > c.start + 0.2 && ph < c.start + c.duration - 0.2 ? ph - c.start : c.duration / 2;
    const id2 = `${c.id}_b${Date.now().toString(36).slice(-4)}`;
    st().commit((p) => {
      const out = [];
      for (const t of p.tracks.text) {
        if (t.id !== c.id) { out.push(t); continue; }
        out.push({ ...t, text: s.slice(0, at).trim(), duration: local });
        out.push({ ...t, id: id2, text: s.slice(at).trim(), start: t.start + local, duration: t.duration - local });
      }
      return { ...p, tracks: { ...p.tracks, text: out } };
    }, '拆分字幕');
  };
  const remove = (c) => st().commit([{ type: 'removeText', target: T_NONE, textId: c.id }], '删除字幕');
  const clearAll = () => runOp({ type: 'clearCaptions' }, '清空字幕', { fallback: (p) => ({ ...p, tracks: { ...p.tracks, text: p.tracks.text.filter((t) => !isCaption(t)) } }) });

  const exportSrt = () => {
    if (!caps.length) return;
    const body = typeof CAPTIONS.textsToSrt === 'function' ? CAPTIONS.textsToSrt(caps) : localSrt(caps);
    const blob = new Blob(['﻿' + body], { type: 'application/x-subrip;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(project.name || '字幕').replace(/[\\/:*?"<>|]/g, '_')}.srt`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    st().toast('字幕已导出为 SRT', 'ok');
  };

  /** 统一样式：改第一句的样式时同步到所有字幕 */
  const StyleAll = first ? <UnifiedStyle sample={first} /> : null;

  return (
    <div className="insp">
      <div className="insp-head">
        <div className="insp-head-icon text"><Icon name="text" size={18} /></div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="insp-head-title">字幕</div>
          <div className="xs muted">{caps.length ? `${caps.length} 句 · 点句子跳到对应位置` : '自动识别人声，生成逐句字幕'}</div>
        </div>
        {caps.length > 0 && <Button size="sm" variant="ghost" icon="download" title="导出 SRT 字幕文件" onClick={exportSrt} />}
      </div>

      {busy ? (
        <div className="insp-busy">
          <div className="small">{busy.message}</div>
          <ProgressBar value={busy.progress} indeterminate={!busy.progress} ai />
        </div>
      ) : needModel ? (
        <div className="insp-guide">
          <Icon name="download" size={20} />
          <div className="grow">
            <b>需要安装语音识别模型</b>
            <p>首次使用需下载本地识别模型（small 约 466 MB），识别全程离线进行，不会上传你的音频。</p>
            {needModel.reason && <p className="muted">{needModel.reason}</p>}
            <div className="insp-btnrow">
              <Button size="sm" variant="secondary" icon="download" disabled={needModel.downloadable === false} onClick={installModel}>下载并安装</Button>
              <Button size="sm" variant="ghost" onClick={() => setNeedModel(null)}>稍后</Button>
            </div>
          </div>
        </div>
      ) : (
        <button type="button" className="insp-cta" onClick={recognize}>
          <Icon name="sparkles" size={16} />
          <span className="grow"><b>{caps.length ? '重新识别字幕' : '识别字幕'}</b><small>从人声/原声自动生成，识别后可逐句修改</small></span>
        </button>
      )}

      {caps.length > 0 && (
        <InspSection id="cap-list" title="逐句编辑" icon="list" badge={`${caps.length} 句`}
          actions={<Button size="sm" variant="ghost" onClick={clearAll}>清空</Button>}>
          <ol className="cap-list">
            {caps.map((c, i) => {
              const on = activeCapId === c.id;
              return (
                <li key={c.id} className={'cap-item' + (on ? ' on' : '')}>
                  <button type="button" className="cap-time mono" title="跳到这句" onClick={() => { st().setPlayhead(c.start); st().selectText && st().selectText(c.id); }}>
                    {fmtTime(c.start, false)}
                  </button>
                  <CapText cap={c} onCommit={(text) => upd(c, { text }, '修改字幕')} />
                  <span className="cap-ops">
                    <button type="button" title="拆分（在播放头或中间）" onClick={() => split(c)}><Icon name="scissors" size={12} /></button>
                    {i < caps.length - 1 && <button type="button" title="与下一句合并" onClick={() => merge(i)}><Icon name="plus" size={12} /></button>}
                    <button type="button" title="删除" onClick={() => remove(c)}><Icon name="close" size={12} /></button>
                  </span>
                  <span className="cap-dur mono">{c.duration.toFixed(1)}s</span>
                </li>
              );
            })}
          </ol>
        </InspSection>
      )}
      {StyleAll}
    </div>
  );
}

function CapText({ cap, onCommit }) {
  const [v, setV] = useState(cap.text || '');
  const [focus, setFocus] = useState(false);
  React.useEffect(() => { if (!focus) setV(cap.text || ''); }, [cap.text, focus]);
  return (
    <input className="cap-text" value={v} onFocus={() => setFocus(true)} onChange={(e) => setV(e.target.value)}
      onBlur={() => { setFocus(false); if (v !== cap.text) onCommit(v); }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setV(cap.text || ''); e.currentTarget.blur(); } }} />
  );
}

/** 统一样式：样式控件直接走 updateCaptionStyle，对全部字幕生效 */
function UnifiedStyle({ sample }) {
  const makeSet = React.useCallback((patch) => ({
    ops: [{ type: 'updateCaptionStyle', patch }],
    fb: (p) => ({ ...p, tracks: { ...p.tracks, text: p.tracks.text.map((t) => (isCaption(t) ? { ...t, ...patch } : t)) } }),
  }), []);
  return (
    <div className="cap-style">
      <div className="insp-subtitle">统一样式（应用到全部字幕）</div>
      <TextStyle text={sample} compact makeSet={makeSet} />
    </div>
  );
}