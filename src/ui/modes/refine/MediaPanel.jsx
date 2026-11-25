// 精修 · 左侧素材区：竖排图标分类栏 + 内容区（剪映式）。
// 分类：媒体 / 素材库 / 联网实拍 / 音频（本地与联网、内置）/ 文字 / 贴纸 / 转场 / 滤镜 / 特效 / 技法。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import useStore from '../../store.js';
import api from '../../api.js';
import { Icon, Button, Slider, Empty, Spinner } from '../../components/ui.jsx';
import { AssetThumb } from '../../components/media.jsx';
import { TRANSITIONS, TRANSITION_LABELS, LOOKS, LOOK_LABELS, FX_KEYS, FX_LABELS } from '../../../engine/model.js';
import { applyOps } from '../../../engine/ops.js';
import { projectDuration } from '../../../engine/timeline.js';
import { setDragAssets, importPaths } from '../../assetActions.js';
import MediaProjectTab from './MediaProjectTab.jsx';
import MediaLibraryTab from './MediaLibraryTab.jsx';
import MediaWebTab from './MediaWebTab.jsx';
import TechniquePanel from './TechniquePanel.jsx';
import CaptionPanel from './CaptionPanel.jsx';
import {
  readPref, writePref, fmtDur, normalizeBuiltinList, builtinMoods, filterBuiltinAudio, findBuiltinAssetId, builtinAudioAsset,
  builtinLicenseShort, planBuiltinClip, isExternalFileDrag, droppedFilePaths, canResolveDroppedPaths,
} from './SideData.js';
import {
  STICKER_GROUPS, addSticker, TEXT_TEMPLATES, FANCY_TEXTS, addTextPreset, TRANSITION_ANIM, FX_ICONS, currentTarget,
} from './StickerData.js';
import '../../../styles/refine-side.css';

export const CATEGORIES = [
  { id: 'caption', label: '字幕', icon: 'text', title: '识别与编辑字幕' },
  { id: 'media', label: '本地', icon: 'folder', search: '搜索项目素材' },
  { id: 'library', label: '素材库', icon: 'layers', search: '搜索素材库' },
  { id: 'web', label: '实拍', icon: 'camera', search: '搜索真人实拍，回车（如：咖啡 拉花）', title: '联网实拍（Pexels / Pixabay）' },
  { id: 'audio', label: '音频', tab: '本地与联网', icon: 'music', search: '搜索音乐，回车联网搜索' },
  { id: 'builtin', label: '内置', icon: 'headphones', search: '搜索曲名、情绪或作者', title: '内置音乐与音效：可试听，一键加到音频轨' },
  { id: 'text', label: '文字', icon: 'text' },
  { id: 'sticker', label: '贴纸', icon: 'sparkles' },
  { id: 'transition', label: '转场', icon: 'transition' },
  { id: 'filter', label: '滤镜', icon: 'palette' },
  { id: 'effect', label: '特效', icon: 'wand' },
  { id: 'technique', label: '技法', icon: 'book', title: '把专业拍摄/剪辑技法应用到所选镜头' },
];

// 剪映式一级入口（4 组）；二级为顶部胶囊子标签。技法并入「效果」。
// 「内置」只在有内置音频清单时出现（见 visibleSubs）。
export const GROUPS = [
  { id: 'material', label: '素材', icon: 'folder', subs: ['media', 'library', 'web'] },
  { id: 'audio', label: '音频', icon: 'music', subs: ['audio', 'builtin'] },
  { id: 'text', label: '文字', icon: 'text', subs: ['text', 'caption', 'sticker'] },
  { id: 'effects', label: '效果', icon: 'wand', subs: ['transition', 'filter', 'effect', 'technique'] },
];

function targetHint(selected) {
  return selected ? `应用到所选 ${selected} 个片段` : '未选中片段 · 将应用到全部';
}

// ---------------- 文字 ----------------
/** 花字样例单行完整显示：算出字宽（中文 1、英文数字约 0.68），CSS 按格子宽度（cqi）自适应字号，最长的样例也不截断 */
const WIDE_CHAR = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;
function fancyUnits(text) {
  let w = 0;
  for (const ch of Array.from(String(text || ''))) w += WIDE_CHAR.test(ch) ? 1 : 0.68;
  return Math.max(2.5, Math.round(w * 100) / 100);
}

function TextPane() {
  return (
    <div className="mpx-scroll">
      <div className="mpx-section-title">文字模板</div>
      <div className="mpx-grid two">
        {TEXT_TEMPLATES.map((t) => (
          <button key={t.id} type="button" className="mpx-tile" onClick={() => addTextPreset(t)} title="点击在播放头处添加">
            <div className={'mpx-text-sample ' + t.sample}>{t.label === '人名条' ? '张三' : t.label}</div>
            <span className="mpx-tile-label">{t.label}</span>
          </button>
        ))}
      </div>
      <div className="mpx-section-title">花字</div>
      <div className="mpx-grid three">
        {FANCY_TEXTS.map((t) => (
          <button key={t.id} type="button" className="mpx-tile" onClick={() => addTextPreset(t)} title={`「${t.text}」点击在播放头处添加`}>
            <div className={'mpx-fancy ' + t.sample} style={{ color: t.color }}>
              <span className="mpx-fancy-text" style={{ '--w': fancyUnits(t.text) }}>{t.text}</span>
            </div>
            <span className="mpx-tile-label">{t.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------- 贴纸 ----------------
function StickerPane() {
  return (
    <div className="mpx-scroll">
      {STICKER_GROUPS.map((g) => (
        <React.Fragment key={g.id}>
          <div className="mpx-section-title">{g.label}</div>
          <div className="mpx-stickers">
            {g.items.map((s) => (
              <button key={s} type="button" className={'mpx-sticker' + (g.id === 'shape' ? ' shape' : '')} onClick={() => addSticker(s)} title="点击添加到播放头处">{s}</button>
            ))}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

// ---------------- 转场 ----------------
function TransitionPane() {
  const selected = useStore((s) => s.selection.clipIds.length);
  const clipCount = useStore((s) => (s.project ? s.project.tracks.video.length : 0));
  const [dur, setDur] = useState(() => readPref('side.trDur', 0.5));
  const [picked, setPicked] = useState('crossfade');

  const applySel = (type) => {
    const st = useStore.getState();
    if (!clipCount) { st.toast('时间线上还没有片段', 'warn'); return; }
    const r = st.commit([{ type: 'setTransition', target: currentTarget(), transition: { type, duration: dur } }], `转场：${TRANSITION_LABELS[type] || type}`);
    if (r.ok) st.toast(`${selected ? `已给所选 ${selected} 个片段` : '已给全部片段'}设置「${TRANSITION_LABELS[type] || type}」`, 'success');
  };
  const applyAll = () => {
    const st = useStore.getState();
    if (!clipCount) { st.toast('时间线上还没有片段', 'warn'); return; }
    let r = st.commit([{ type: 'setTransitionAll', transition: { type: picked, duration: dur } }], `全部转场：${TRANSITION_LABELS[picked]}`, { silent: true });
    if (!r.ok) r = st.commit([{ type: 'setTransition', target: { mode: 'all', indices: [], ids: [] }, transition: { type: picked, duration: dur } }], `全部转场：${TRANSITION_LABELS[picked]}`);
    if (r.ok) st.toast(`已把全部转场设为「${TRANSITION_LABELS[picked]}」`, 'success');
  };

  return (
    <div className="mpx-scroll">
      <div className="mpx-applybar">
        <span className="mpx-hint">{targetHint(selected)}</span>
        <Button size="sm" variant="secondary" onClick={applyAll} title={`把「${TRANSITION_LABELS[picked]}」应用到所有片段之间`}>应用到全部</Button>
      </div>
      <div className="mpx-dur">
        <Slider label="时长" value={dur} min={0.1} max={2} step={0.1} onChange={(v) => { setDur(v); writePref('side.trDur', v); }} format={(v) => `${Number(v).toFixed(1)}s`} />
      </div>
      <div className="mpx-grid three">
        {TRANSITIONS.map((t) => (
          <button
            key={t}
            type="button"
            className={'mpx-tile mpx-tr' + (picked === t ? ' picked' : '')}
            onClick={() => { setPicked(t); applySel(t); }}
            title={`点击${selected ? '应用到所选片段' : '应用到全部片段'}`}
          >
            <div className={'mpx-tr-prev a-' + (TRANSITION_ANIM[t] || 'fade')}>
              <span className="mpx-tr-a">A</span>
              <span className="mpx-tr-b">B</span>
            </div>
            <span className="mpx-tile-label">{TRANSITION_LABELS[t] || t}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------- 滤镜 ----------------
const LOOK_CSS = {
  none: 'none', cinematic: 'contrast(1.15) saturate(.85) sepia(.12)', 'film-warm': 'sepia(.35) saturate(1.1)', 'film-cool': 'hue-rotate(-12deg) saturate(.85) brightness(1.02)',
  bw: 'grayscale(1)', noir: 'grayscale(1) contrast(1.5)', vintage: 'sepia(.55) contrast(.9)', 'cool-night': 'hue-rotate(20deg) brightness(.8) saturate(.9)',
  vivid: 'saturate(1.6)', 'soft-pastel': 'saturate(.7) brightness(1.12) contrast(.88)', 'high-contrast': 'contrast(1.6)', moody: 'brightness(.8) saturate(.7) contrast(1.1)',
  'golden-hour': 'sepia(.4) saturate(1.4) hue-rotate(-10deg)', cyberpunk: 'hue-rotate(60deg) saturate(1.6) contrast(1.1)',
};

function usePreviewAsset() {
  return useStore((s) => {
    const p = s.project;
    if (!p) return null;
    const sel = s.selection.clipIds[0];
    const clip = (sel && p.tracks.video.find((c) => c.id === sel)) || p.tracks.video[0];
    return (clip && p.assets[clip.assetId]) || null;
  });
}

function FilterPane() {
  const selected = useStore((s) => s.selection.clipIds.length);
  const asset = usePreviewAsset();
  const [strength, setStrength] = useState(() => readPref('side.lookStrength', 0.8));
  const [picked, setPicked] = useState(null);
  const apply = (look) => {
    const st = useStore.getState();
    if (!st.project || !st.project.tracks.video.length) { st.toast('时间线上还没有片段', 'warn'); return; }
    setPicked(look);
    st.commit([{ type: 'setLook', target: currentTarget(), look, lookStrength: strength }], `滤镜：${LOOK_LABELS[look] || look}`);
  };
  const changeStrength = (v) => {
    setStrength(v); writePref('side.lookStrength', v);
    if (picked && picked !== 'none') useStore.getState().commit([{ type: 'setLook', target: currentTarget(), lookStrength: v }], '滤镜强度', { mergeKey: 'look-strength', silent: true });
  };
  return (
    <div className="mpx-scroll">
      <div className="mpx-applybar"><span className="mpx-hint">{targetHint(selected)}</span></div>
      <div className="mpx-dur"><Slider label="强度" value={strength} min={0} max={1} step={0.05} onChange={changeStrength} format={(v) => `${Math.round(v * 100)}`} /></div>
      <div className="mpx-grid three">
        {LOOKS.map((l) => (
          <button key={l} type="button" className={'mpx-tile' + (picked === l ? ' picked' : '')} onClick={() => apply(l)}>
            <div className="mpx-look" style={{ filter: LOOK_CSS[l] || 'none' }}>
              {asset && asset.kind !== 'audio' ? <AssetThumb asset={asset} width={120} height={68} style={{ width: '100%', height: '100%' }} /> : <div className="mpx-look-fallback" />}
            </div>
            <span className="mpx-tile-label">{l === 'none' ? '无滤镜' : LOOK_LABELS[l] || l}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------- 特效 ----------------
function EffectPane() {
  const selected = useStore((s) => s.selection.clipIds.length);
  const firstFx = useStore((s) => {
    const p = s.project; if (!p) return null;
    const sel = s.selection.clipIds[0];
    const c = (sel && p.tracks.video.find((x) => x.id === sel)) || null;
    return c ? c.fx : null;
  });
  const apply = (k, v) => {
    const st = useStore.getState();
    if (!st.project || !st.project.tracks.video.length) { st.toast('时间线上还没有片段', 'warn'); return; }
    st.commit([{ type: 'setFx', target: currentTarget(), fx: { [k]: v } }], `${v ? '添加' : '去掉'}特效：${FX_LABELS[k]}`);
  };
  return (
    <div className="mpx-scroll">
      <div className="mpx-applybar"><span className="mpx-hint">{targetHint(selected)}</span></div>
      <div className="mpx-grid two">
        {FX_KEYS.map((k) => {
          const on = !!(firstFx && firstFx[k] > 0);
          return (
            <button key={k} type="button" className={'mpx-tile mpx-fx' + (on ? ' picked' : '')} onClick={() => apply(k, on ? 0 : 0.6)} title={on ? '再次点击去掉' : '点击添加'}>
              <div className={'mpx-fx-prev fx-' + k}><Icon name={FX_ICONS[k] || 'wand'} size={20} /></div>
              <span className="mpx-tile-label">{FX_LABELS[k]}{on && <Icon name="check" size={11} />}</span>
            </button>
          );
        })}
      </div>
      <p className="mpx-foot">特效强度可在右侧属性区精细调整。</p>
    </div>
  );
}

// ---------------- 内置音乐与音效（契约 C16） ----------------
// 清单只读一次（整个会话缓存）；接口未就绪或没有清单时为 []，「内置」子标签随之隐藏。
let builtinPromise = null;
function loadBuiltinAudio() {
  if (!builtinPromise) {
    builtinPromise = (api.available ? Promise.resolve().then(() => api.call('media:builtinAudio')) : Promise.resolve([]))
      .then((list) => normalizeBuiltinList(list))
      .catch(() => []);
  }
  return builtinPromise;
}

function useBuiltinAudio() {
  const [items, setItems] = useState(null); // null=读取中
  useEffect(() => {
    let alive = true;
    loadBuiltinAudio().then((list) => { if (alive) setItems(list); });
    return () => { alive = false; };
  }, []);
  return items;
}

/** 加到音频轨（播放头处）。同一条内置音频在项目里只建一个素材 */
async function addBuiltinToTrack(item) {
  const st = useStore.getState();
  if (!st.project) return false;
  let duration = item.duration;
  if (!(duration > 0)) {
    try { const m = await api.call('media:probe', { path: item.path }); duration = Number(m && m.duration) || 0; } catch { duration = 0; }
  }
  if (!(duration > 0)) { st.toast(`「${item.title}」无法读取，可能文件已损坏`, 'error'); return false; }
  const cur = useStore.getState();
  const asset = builtinAudioAsset({ ...item, duration }, findBuiltinAssetId(cur.project, item.id));
  let total = 0;
  try { total = projectDuration(cur.project); } catch { total = 0; }
  const plan = planBuiltinClip({ duration, at: cur.playhead, total, kind: item.kind });
  api.call('media:register', { paths: [asset.path] }).catch(() => {});
  // 走引擎的 addAudio 操作：统一校验出入点、轨道锁定与时长上限
  const r = cur.commit((p) => {
    const old = p.assets[asset.id];
    const merged = old
      ? { ...asset, ...old, path: asset.path, duration: Number(old.duration) > 0 ? old.duration : asset.duration, source: asset.source, license: asset.license }
      : asset;
    const withAsset = { ...p, assets: { ...p.assets, [asset.id]: merged } };
    const res = applyOps(withAsset, [{ type: 'addAudio', audio: { assetId: asset.id, start: plan.start, in: 0, out: plan.out, role: plan.role, fadeIn: plan.fadeIn, fadeOut: plan.fadeOut } }]);
    if (!res.ok) throw new Error((res.errors || []).join('；') || '音频轨暂时无法修改');
    return res.project;
  }, `${item.kind === 'sfx' ? '添加音效' : '添加音乐'}：${item.title}`);
  if (r.ok) {
    const where = plan.start > 0.05 ? `播放头 ${fmtDur(plan.start)} 处` : '开头';
    cur.toast(item.kind === 'sfx'
      ? `已在${where}添加音效「${item.title}」`
      : `已在${where}添加音乐「${item.title}」${plan.trimmed ? '，并按成片长度裁好、结尾淡出' : ''}`, 'success');
  } else {
    cur.toast('没有添加：' + ((r.errors || []).join('；') || '音频轨暂时无法修改'), 'error');
  }
  return r.ok;
}

const BUILTIN_KINDS = [['all', '全部'], ['music', '音乐'], ['sfx', '音效']];

function BuiltinAudioPane({ items, query, active }) {
  const [kind, setKind] = useState(() => {
    const v = readPref('side.builtinKind', 'all');
    return BUILTIN_KINDS.some(([k]) => k === v) ? v : 'all';
  });
  const [mood, setMood] = useState('');
  const [playing, setPlaying] = useState(null); // 正在试听的条目 id
  const [loadingId, setLoadingId] = useState(null);
  const [pos, setPos] = useState(0); // 试听进度 0..1
  const [adding, setAdding] = useState(null);
  const audioRef = useRef(null);
  const list = useMemo(() => filterBuiltinAudio(items || [], { kind, mood, query }), [items, kind, mood, query]);
  const moods = useMemo(() => builtinMoods(items || [], kind), [items, kind]);
  const assets = useStore((s) => (s.project ? s.project.assets : null));

  const stop = () => {
    const el = audioRef.current;
    if (el) { try { el.pause(); } catch { /* */ } }
    setPlaying(null); setLoadingId(null); setPos(0);
  };
  useEffect(() => { if (!active) stop(); }, [active]);
  useEffect(() => () => { const el = audioRef.current; if (el) { try { el.pause(); el.removeAttribute('src'); el.load(); } catch { /* */ } } }, []);
  useEffect(() => { if (mood && !moods.includes(mood)) setMood(''); }, [moods, mood]);

  const toggle = (it) => {
    const el = audioRef.current;
    if (!el) return;
    if (playing === it.id || loadingId === it.id) { stop(); return; }
    try { el.pause(); } catch { /* */ }
    setPos(0); setPlaying(null); setLoadingId(it.id);
    el.src = api.mediaUrl(it.path);
    el.currentTime = 0;
    el.play()
      .then(() => { setLoadingId((id) => (id === it.id ? null : id)); setPlaying(it.id); })
      .catch((e) => {
        if (e && e.name === 'AbortError') return; // 切到了另一首
        setLoadingId(null); setPlaying(null);
        useStore.getState().toast(`「${it.title}」暂时无法试听`, 'warn');
      });
  };

  const add = async (it) => {
    if (adding) return;
    setAdding(it.id);
    try { await addBuiltinToTrack(it); } finally { setAdding(null); }
  };

  const pickKind = (k) => { setKind(k); writePref('side.builtinKind', k); };

  if (items === null) return <div className="mp-loading"><Spinner /><span>正在读取内置音频…</span></div>;

  return (
    <div className="mpx-scroll bi-root">
      <audio
        ref={audioRef}
        preload="none"
        onTimeUpdate={(e) => { const d = e.currentTarget.duration; if (d > 0) setPos(e.currentTarget.currentTime / d); }}
        onEnded={() => { setPlaying(null); setPos(0); }}
      />
      <div className="bi-filters">
        <div className="mp-seg" role="tablist" aria-label="类别">
          {BUILTIN_KINDS.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} className={'mp-seg-btn' + (kind === k ? ' active' : '')} onClick={() => pickKind(k)}>{label}</button>
          ))}
        </div>
        {moods.length > 1 && (
          <div className="bi-moods" aria-label="按情绪筛选">
            <button type="button" className={'bi-mood' + (!mood ? ' active' : '')} aria-pressed={!mood} onClick={() => setMood('')}>全部情绪</button>
            {moods.map((m) => (
              <button key={m} type="button" className={'bi-mood' + (mood === m ? ' active' : '')} aria-pressed={mood === m} onClick={() => setMood(mood === m ? '' : m)}>{m}</button>
            ))}
          </div>
        )}
      </div>
      {!list.length ? (
        <Empty icon="search" title="没有符合条件的音频"
          action={(mood || kind !== 'all') ? <Button size="sm" variant="secondary" onClick={() => { setMood(''); pickKind('all'); }}>清除筛选</Button> : null}>
          {query ? '换个关键词试试，比如「轻快」「钢琴」「转场」。' : '换个类别或情绪看看。'}
        </Empty>
      ) : (
        <ul className="bi-list">
          {list.map((it) => {
            const on = playing === it.id;
            const wait = loadingId === it.id;
            const lic = builtinLicenseShort(it.license);
            const inProject = !!(assets && findBuiltinAssetId({ assets }, it.id));
            const sub = [it.kind === 'sfx' ? '音效' : it.mood || '音乐', it.bpm ? `${it.bpm} BPM` : '', it.duration ? fmtDur(it.duration) : ''].filter(Boolean).join(' · ');
            const licTitle = [it.license.name || it.license.id, it.author ? `作者：${it.author}` : ''].filter(Boolean).join('\n');
            return (
              <li
                key={it.id}
                className={'bi-item' + (on ? ' playing' : '')}
                draggable
                onDragStart={(e) => {
                  const st = useStore.getState();
                  setDragAssets(e.dataTransfer, [builtinAudioAsset(it, st.project ? findBuiltinAssetId(st.project, it.id) : null)]);
                }}
                title={`${it.title}\n拖到音频轨，或点右侧加号添加到播放头处`}
              >
                <button type="button" className="bi-play" aria-label={on ? `暂停试听「${it.title}」` : `试听「${it.title}」`} onClick={() => toggle(it)}>
                  {wait ? <Spinner /> : <Icon name={on ? 'pause' : 'play'} size={13} />}
                </button>
                <div className="bi-meta">
                  <div className="bi-title ellipsis">{it.title}{inProject && <Icon name="check" size={11} className="bi-used" title="项目里已经用过" />}</div>
                  <div className="bi-sub ellipsis">{sub}</div>
                  {on && <div className="bi-progress" aria-hidden="true"><i style={{ width: `${Math.round(pos * 1000) / 10}%` }} /></div>}
                </div>
                {lic && <span className="bi-license" title={licTitle}>{lic}</span>}
                <button type="button" className="mp-round bi-add" disabled={adding === it.id}
                  title={it.kind === 'sfx' ? '在播放头处添加音效' : '在播放头处添加到音频轨'} aria-label={`添加「${it.title}」`} onClick={() => add(it)}>
                  {adding === it.id ? <Spinner /> : <Icon name="plus" size={14} />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mpx-foot">作者和许可会随素材一起保存；需要署名的音频，导出时会写进「素材来源与署名」清单。</p>
    </div>
  );
}

// ---------------- 主组件 ----------------
export default function MediaPanel() {
  const assetCount = useStore((s) => (s.project ? Object.keys(s.project.assets || {}).length : 0));
  const hasProject = useStore((s) => !!s.project);
  const builtin = useBuiltinAudio();
  const hasBuiltin = Array.isArray(builtin) && builtin.length > 0;
  const visibleSubs = (g) => g.subs.filter((id) => id !== 'builtin' || hasBuiltin);
  const [group, setGroup] = useState(() => {
    const v = readPref('media.group', 'material');
    return GROUPS.some((g) => g.id === v) ? v : 'material';
  });
  const [subs, setSubs] = useState(() => {
    const saved = readPref('media.subs', {}) || {};
    const o = {};
    for (const g of GROUPS) o[g.id] = g.subs.includes(saved[g.id]) ? saved[g.id] : g.subs[0];
    return o;
  });
  const gmeta = GROUPS.find((g) => g.id === group) || GROUPS[0];
  const groupSubs = visibleSubs(gmeta);
  const cat = groupSubs.includes(subs[group]) ? subs[group] : groupSubs[0];
  const [visited, setVisited] = useState(() => ({ [cat]: true }));
  const [queries, setQueries] = useState({});
  const [nonce, setNonce] = useState({});
  const [dropOver, setDropOver] = useState(false);
  const meta = CATEGORIES.find((c) => c.id === cat) || CATEGORIES[0];

  const visit = (c) => setVisited((v) => (v[c] ? v : { ...v, [c]: true }));
  useEffect(() => { visit(cat); }, [cat]);
  const switchGroup = (g) => { setGroup(g); writePref('media.group', g); visit(subs[g]); };
  const switchCat = (c) => {
    setSubs((s) => { const n = { ...s, [group]: c }; writePref('media.subs', n); return n; });
    visit(c);
  };
  const query = queries[cat] || '';
  const setQuery = (v) => setQueries((q) => ({ ...q, [cat]: v }));
  const onKeyDown = (e) => {
    if (e.key === 'Enter' && (cat === 'web' || cat === 'audio')) { e.preventDefault(); setNonce((n) => ({ ...n, [cat]: (n[cat] || 0) + 1 })); }
    if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); setQuery(''); }
  };

  // 从资源管理器拖入文件：拿得到路径就直接导入到项目素材；拿不到时不拦截，交给外壳打开导入窗口兜底
  const onDragOver = (e) => {
    if (!hasProject || !isExternalFileDrag(e.dataTransfer) || !canResolveDroppedPaths()) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    if (!dropOver) setDropOver(true);
  };
  const onDragLeave = (e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setDropOver(false);
  };
  const onDrop = (e) => {
    setDropOver(false);
    if (!hasProject || !isExternalFileDrag(e.dataTransfer)) return;
    const paths = droppedFilePaths(e.dataTransfer);
    if (!paths.length) return;
    e.preventDefault();
    importPaths(paths).then((assets) => {
      if (!assets || !assets.length) return;
      // 导入后让用户看到新素材：音频留在音频分组，其余切到「素材 · 本地」
      const allAudio = assets.every((a) => a && a.kind === 'audio');
      if (allAudio && group === 'audio') { if (cat !== 'audio') switchCat('audio'); return; }
      if (group !== 'material') switchGroup('material');
      setSubs((s) => { const n = { ...s, material: 'media' }; writePref('media.subs', n); return n; });
      visit('media');
    });
  };

  const pane = (id, node) => (visited[id] || cat === id ? <div key={id} className={'mp-pane' + (cat === id ? '' : ' hidden')}>{node}</div> : null);

  return (
    <div className="mpx-root" data-tour="refine-media">
      <nav className="mpx-rail" aria-label="素材分类">
        {GROUPS.map((g) => (
          <button
            key={g.id}
            type="button"
            className={'mpx-rail-btn' + (group === g.id ? ' active' : '')}
            onClick={() => switchGroup(g.id)}
            title={g.label}
            aria-pressed={group === g.id}
            data-group={g.id}
          >
            <Icon name={g.icon} size={18} />
            <span>{g.label}</span>
            {g.id === 'material' && assetCount > 0 && <i className="mpx-rail-n">{assetCount > 99 ? '99+' : assetCount}</i>}
          </button>
        ))}
      </nav>
      <div className={'mpx-content' + (dropOver ? ' drop-over' : '')} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        <div className="mpx-head">
          {groupSubs.length > 1 ? (
            <div className="mpx-subtabs" role="tablist">
              {groupSubs.map((id) => {
                const c = CATEGORIES.find((x) => x.id === id);
                return (
                  <button key={id} type="button" role="tab" aria-selected={cat === id} data-sub={id}
                    className={'mpx-subtab' + (cat === id ? ' active' : '')} onClick={() => switchCat(id)} title={c.title || c.label}>
                    {c.tab || c.label}
                  </button>
                );
              })}
            </div>
          ) : <div className="mpx-title">{meta.title || meta.label}</div>}
          {meta.search && (
            <div className="mp-search">
              <Icon name="search" size={14} />
              <input
                type="search"
                className="mp-search-input"
                value={query}
                placeholder={meta.search}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                spellCheck={false}
              />
              {query && (
                <button type="button" className="mp-search-clear" title="清空" onClick={() => setQuery('')}>
                  <Icon name="close" size={12} />
                </button>
              )}
            </div>
          )}
        </div>
        <div className="mp-body">
          {pane('media', <MediaProjectTab query={queries.media} />)}
          {pane('library', <MediaLibraryTab query={queries.library} active={cat === 'library'} />)}
          {pane('web', <MediaWebTab query={queries.web} searchNonce={nonce.web || 0} active={cat === 'web'} initialKind="video" />)}
          {pane('audio', (
            <div className="mpx-audio">
              <div className="mpx-audio-local"><MediaProjectTab query={queries.audio} fixedKind="audio" /></div>
              <div className="mpx-section-title pad">联网音乐</div>
              <div className="mpx-audio-web"><MediaWebTab query={queries.audio} searchNonce={nonce.audio || 0} active={cat === 'audio'} initialKind="audio" fixedKind="audio" /></div>
            </div>
          ))}
          {hasBuiltin && pane('builtin', <BuiltinAudioPane items={builtin} query={queries.builtin} active={cat === 'builtin'} />)}
          {pane('text', <TextPane />)}
          {pane('caption', hasProject ? <div className="mpx-scroll mpx-caption"><CaptionPanel /></div> : null)}
          {pane('sticker', <StickerPane />)}
          {pane('transition', <TransitionPane />)}
          {pane('filter', <FilterPane />)}
          {pane('effect', <EffectPane />)}
          {pane('technique', <div className="mpx-tech"><TechniquePanel /></div>)}
        </div>
      </div>
    </div>
  );
}
