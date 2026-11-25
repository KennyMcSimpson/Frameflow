// 导出对话框：选项 → 真实进度 → 完成。SPEC §8。
// 导出前检查包括：离线素材 / 空隙 / 示意画面，以及素材许可（C3）、AI 生成标识（C10）、署名清单（C3/C10）。
// 导出中同步任务栏进度，完成或出错时闪烁任务栏并在窗口不在前台时弹系统通知（C19）。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import useStore from '../store.js';
import api from '../api.js';
import { Modal, Button, Field, Select, ProgressBar, Spinner, Icon, Switch, ICON_NAMES, fmtTime, fmtBytes } from '../components/ui.jsx';
import { renderProjectFrame } from '../components/TopBar.jsx';
import { exportProject } from '../../export/exporter.js';
import { projectDuration, layoutVideo } from '../../engine/timeline.js';
import { isCaptionText } from '../../engine/model.js';
import { EXPORT_PRESETS, FORMATS, resolveExportOptions, extFor } from '../../export/presets.js';
import { findRestrictedUsage, creditsText, projectUsesAi } from '../../engine/license.js';
import {
  PLATFORM_PRESET_IDS, estimateExportBytes, fmtApproxSize, splitOutPath, fmtEta, fmtElapsed, groupRestricted, shortList,
} from './exportDialogUtils.js';

const FPS_OPTIONS = [24, 25, 30, 60];
const QUALITY_OPTIONS = [
  { value: 'high', title: '高', desc: '画质最好，文件较大' },
  { value: 'standard', title: '标准', desc: '适合大多数平台' },
  { value: 'small', title: '小文件', desc: '方便发送和分享' },
];

function even(n) { return Math.max(2, Math.round(n / 2) * 2); }

/** 720p 档 = 尺寸 ×2/3 取偶数（SPEC §3.1） */
export function exportSize(settings, resolution) {
  const w = (settings && settings.width) || 1920;
  const h = (settings && settings.height) || 1080;
  return resolution === '720p' ? { width: even((w * 2) / 3), height: even((h * 2) / 3) } : { width: even(w), height: even(h) };
}

function safeFileName(name) {
  return String(name || '未命名项目').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 80) || '未命名项目';
}

function dirnameOf(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i > 0 ? s.slice(0, i) : '';
}

function basenameOf(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  return s.slice(Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/')) + 1);
}

function joinPath(dir, name) {
  return dir ? `${String(dir).replace(/[\\/]+$/, '')}\\${name}` : name;
}

/** 默认保存到 <文档>/<项目名>.mp4；默认数据目录就是 <文档>/Frameflow */
function defaultOutPath(name, settings, appInfo) {
  const folder = settings && settings.export && settings.export.folder;
  const root = appInfo && appInfo.dataRoot;
  const docs = root && !(settings && settings.dataRoot) ? dirnameOf(root) : '';
  return joinPath(folder || docs, `${safeFileName(name)}.mp4`);
}

function Stat({ label, value, title }) {
  return (
    <div className="ex-stat" title={title}>
      <span className="ex-stat-label">{label}</span>
      <span className="ex-stat-value mono">{value}</span>
    </div>
  );
}

/** 新图标（C2）还没进图标库时用旧图标兜底 */
const iconOr = (name, fallback) => (Array.isArray(ICON_NAMES) && ICON_NAMES.includes(name) ? name : fallback);
const PRESET_FALLBACK_ICON = { custom: 'sliders', 'audio-mp3': 'music', gif: 'image' };
const iconOf = (p) => iconOr((p && p.icon) || PRESET_FALLBACK_ICON[p && p.id] || 'film', PRESET_FALLBACK_ICON[p && p.id] || 'film');

/** 前截断的路径（保留末尾的文件夹名）：外层 rtl 让省略号出现在左边，内层隔离成 ltr 保证路径顺序 */
function TruncStart({ text, className = '' }) {
  return (
    <span className={'ex-trunc-start ' + className} title={text}>
      <span className="ex-trunc-inner">{text}</span>
    </span>
  );
}

/** 任务栏进度 / 闪烁 / 通知（C19）。旧版主进程没有这个接口时静默忽略 */
function taskbar(payload) {
  try {
    const p = api.call('app:taskbar', payload);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* 忽略 */ }
}

/** 平台预设卡片：图标 + 画幅小框 + 名称 + 一行说明（画幅和项目不一致时说明会按项目画幅导出） */
function PresetCard({ p, active, onPick, projSettings, compact }) {
  const pw = Number(projSettings.width) > 0 ? Number(projSettings.width) : 1920;
  const ph = Number(projSettings.height) > 0 ? Number(projSettings.height) : 1080;
  const projLand = pw >= ph;
  const mismatch = !!p.aspect && (p.aspect === '9:16') === projLand;
  let desc = p.desc;
  if (mismatch) {
    const r = resolveExportOptions(p.id, projSettings);
    desc = `按项目画幅导出 ${r.w}×${r.h}`;
  }
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      data-preset={p.id}
      className={'ex-card' + (active ? ' active' : '') + (compact ? ' compact' : '')}
      onClick={onPick}
      title={mismatch ? `${p.label}推荐${p.aspect === '9:16' ? '竖屏' : '横屏'}；你的项目是${projLand ? '横屏' : '竖屏'}，为避免拉伸会按项目画幅导出` : undefined}
    >
      <span className="ex-card-ico"><Icon name={iconOf(p)} size={compact ? 15 : 18} /></span>
      <span className="ex-card-text">
        <span className="ex-card-title">{p.label}</span>
        <span className={'ex-card-desc' + (mismatch ? ' note' : '')}>{desc}</span>
      </span>
      {!compact && p.aspect && <span className={'ex-aspect ' + (p.aspect === '9:16' ? 'v' : 'h')} aria-hidden="true" />}
    </button>
  );
}

/** 导出前检查：离线素材、空隙、示意画面（纯函数，便于测试） */
export function preflight(project) {
  const issues = [];
  if (!project) return issues;
  const assets = project.assets || {};
  const used = [
    ...((project.tracks && project.tracks.video) || []).map((c) => c.assetId),
    ...((project.tracks && project.tracks.audio) || []).map((c) => c.assetId),
    ...(Array.isArray(project.overlays) ? project.overlays : []).map((o) => o.assetId),
  ];
  const offline = new Set();
  for (const id of used) {
    const a = assets[id];
    if (!a) offline.add('（已删除的素材）');
    else if (a.missing || a.offline || a.status === 'missing') offline.add(a.name || id);
  }
  if (offline.size) issues.push({ level: 'danger', text: `${offline.size} 个素材离线：${[...offline].slice(0, 3).join('、')}${offline.size > 3 ? ' 等' : ''}。导出时这些位置会显示占位画面，请先在素材区重新链接。` });
  let layout = [];
  try { layout = layoutVideo(project); } catch { layout = []; }
  let gaps = 0;
  for (let i = 1; i < layout.length; i += 1) if (layout[i].start - layout[i - 1].end > 0.04) gaps += 1;
  if (layout.length && layout[0].start > 0.04) gaps += 1;
  if (gaps) issues.push({ level: 'warn', text: `时间线上有 ${gaps} 处空隙，导出后会出现黑场。可在精修里使用「波纹删除」合拢。` });
  const previz = ((project.tracks && project.tracks.video) || []).filter((c) => {
    const a = assets[c.assetId];
    return a && (a.kind === 'previz' || a.source === 'previz');
  }).length;
  if (previz) issues.push({ level: 'warn', text: `${previz} 个片段仍是示意画面（带「示意」水印），建议先替换为实拍或 AI 视频。` });
  return issues;
}

export default function ExportDialog({ onClose }) {
  const project = useStore((s) => s.project);
  const settings = useStore((s) => s.settings);
  const appInfo = useStore((s) => s.appInfo);
  const toast = useStore((s) => s.toast);

  const defaults = (settings && settings.export) || {};
  const [presetId, setPresetId] = useState(() => (project && project.exportPreset) || defaults.preset || 'custom');
  const [resolution, setResolution] = useState(defaults.resolution === '720p' ? '720p' : 'full');
  const [fps, setFps] = useState(FPS_OPTIONS.includes(Number(defaults.fps)) ? Number(defaults.fps) : 0);
  const [quality, setQuality] = useState(['high', 'standard', 'small'].includes(defaults.quality) ? defaults.quality : 'high');
  const [format, setFormat] = useState('');
  const [bitrate, setBitrate] = useState('');
  const [srt, setSrt] = useState(false);
  const [hw, setHw] = useState(defaults.hwaccel !== 'off');
  const [outPath, setOutPath] = useState(() => defaultOutPath(project && project.name, settings, appInfo));
  const [phase, setPhase] = useState('config'); // config | running | done
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [thumb, setThumb] = useState('');
  const controllerRef = useRef(null);
  const mounted = useRef(true);
  const lastTaskbarPct = useRef(-1);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (controllerRef.current) { controllerRef.current.abort(); taskbar({ progress: -1 }); }
    };
  }, []);

  // ---------- 素材许可 / AI 标识 / 署名（C3、C10）；license.js 还是占位时这些都为空，界面自动隐藏 ----------
  const usesAi = useMemo(() => { try { return !!projectUsesAi(project); } catch { return false; } }, [project]);
  const [aiLabel, setAiLabel] = useState(() => { try { return !!projectUsesAi(project); } catch { return false; } });
  const [personalUse, setPersonalUse] = useState(false);
  const commercialCheck = useMemo(() => {
    try { return groupRestricted(findRestrictedUsage(project, { commercial: true })); } catch { return { block: [], warn: [] }; }
  }, [project]);
  const personalCheck = useMemo(() => {
    if (!personalUse) return null;
    try { return groupRestricted(findRestrictedUsage(project, { commercial: false })); } catch { return { block: [], warn: [] }; }
  }, [project, personalUse]);
  const licenseCheck = personalCheck || commercialCheck;
  const credits = useMemo(() => { try { return String(creditsText(project) || ''); } catch { return ''; } }, [project]);
  const [writeCredits, setWriteCredits] = useState(true);

  const duration = useMemo(() => {
    if (!project) return 0;
    try { return projectDuration(project); } catch { return 0; }
  }, [project]);
  const clipCount = project ? project.tracks.video.length : 0;
  const empty = clipCount === 0 || !(duration > 0);
  const projSettings = (project && project.settings) || {};
  const custom = presetId === 'custom';
  const base = custom ? exportSize(projSettings, resolution) : null;
  const opts = resolveExportOptions(presetId, projSettings, {
    w: base ? base.width : undefined,
    h: base ? base.height : undefined,
    fps: fps || undefined,
    bitrate: bitrate === '' ? undefined : Number(bitrate),
    format: format || undefined,
  });
  const totalFrames = Math.max(0, Math.ceil(duration * opts.fps));
  const issues = useMemo(() => preflight(project), [project]);
  const hasCaptions = !!project && ((project.tracks && project.tracks.text) || []).some(isCaptionText);
  const ext = extFor(opts.format);
  const pathWithExt = (p) => String(p || '').replace(/\.(mp4|mov|gif|mp3|wav)$/i, '') + '.' + ext;
  const estBytes = estimateExportBytes({ duration, w: opts.w, h: opts.h, fps: opts.fps, quality, bitrate: opts.bitrate, format: opts.format, audioOnly: opts.audioOnly, gif: opts.gif });
  const estText = fmtApproxSize(estBytes);
  const showAiLabel = usesAi && !opts.audioOnly;
  const licenseBlocked = licenseCheck.block.length > 0;

  useEffect(() => { setOutPath((p) => pathWithExt(p)); }, [ext]); // eslint-disable-line react-hooks/exhaustive-deps

  const fileFilter = () => {
    const f = FORMATS.find((x) => x.id === opts.format) || FORMATS[0];
    return [{ name: f.label, extensions: [f.ext] }];
  };

  const chooseOutput = async () => {
    try {
      const p = await api.call('dialog:saveFile', { title: '导出', defaultPath: outPath, filters: fileFilter() });
      if (p) { setOutPath(pathWithExt(p)); return true; }
      return false;
    } catch (e) {
      toast('选择保存位置失败：' + e.message, 'error');
      return false;
    }
  };

  const start = async () => {
    if (phase === 'running' || empty || licenseBlocked) return;
    setError('');
    let target = pathWithExt(outPath);
    if (!/[\\/]/.test(target)) {
      const p = await api.call('dialog:saveFile', { title: '导出', defaultPath: target, filters: fileFilter() }).catch((e) => { toast('选择保存位置失败：' + e.message, 'error'); return null; });
      if (!p) return;
      target = pathWithExt(p);
      setOutPath(target);
    }
    const st = useStore.getState();
    if (st.setPlaying) st.setPlaying(false);
    if (st.saveNow) await st.saveNow();
    const snapshot = useStore.getState().project;
    if (!snapshot) return;

    const controller = new AbortController();
    controllerRef.current = controller;
    setPhase('running');
    setCancelling(false);
    setConfirmStop(false);
    setThumb('');
    setProgress({ phase: 'render', frame: 0, total: totalFrames, fps: 0, etaSec: NaN, progress: 0 });
    lastTaskbarPct.current = 0;
    taskbar({ progress: 0, mode: 'normal' });
    const startedAt = Date.now();
    const fileName = basenameOf(target);
    try {
      const r = await exportProject({
        project: snapshot,
        outPath: target,
        preset: presetId,
        format: opts.format,
        width: opts.w,
        height: opts.h,
        fps: opts.fps,
        bitrate: opts.bitrate,
        quality,
        srt: srt && hasCaptions,
        hwaccel: hw ? 'auto' : 'off',
        // C10：用到 AI 素材时默认在右上角标「AI 生成」；署名清单写到视频旁的 .credits.txt
        aiLabel: showAiLabel && aiLabel ? { text: 'AI 生成', corner: 'top-right' } : false,
        credits: credits && writeCredits ? credits : '',
        signal: controller.signal,
        onProgress: (p) => {
          if (!mounted.current) return;
          setProgress((prev) => ({ ...prev, ...p }));
          const pc = Math.round(Math.max(0, Math.min(1, Number(p && p.progress) || 0)) * 100);
          if (pc !== lastTaskbarPct.current) { lastTaskbarPct.current = pc; taskbar({ progress: pc / 100, mode: 'normal' }); }
        },
      });
      controllerRef.current = null;
      taskbar({ progress: -1, flash: true, notify: { title: '导出完成', body: `${fileName} 已保存` } });
      if (!mounted.current) return;
      setResult({ ...r, path: (r && r.path) || target, elapsed: (Date.now() - startedAt) / 1000 });
      setPhase('done');
      // 完成页的成片画面：用合成器画一帧（音频导出不需要）
      if (!opts.audioOnly) {
        renderProjectFrame(snapshot, { maxSide: 480 })
          .then((u) => { if (mounted.current) setThumb(u || 'none'); })
          .catch(() => { if (mounted.current) setThumb('none'); });
      }
    } catch (e) {
      controllerRef.current = null;
      const cancelled = !!(e && (e.cancelled || e.code === 'CANCELLED'));
      if (cancelled) taskbar({ progress: -1 });
      else taskbar({ progress: -1, flash: true, notify: { title: '导出没有完成', body: String((e && e.message) || '回到镜流查看原因').slice(0, 120) } });
      if (!mounted.current) return;
      setPhase('config');
      setProgress(null);
      setCancelling(false);
      setConfirmStop(false);
      if (cancelled) toast('已取消导出', 'info');
      else setError((e && e.message) || '导出失败');
    }
  };

  const cancel = () => {
    if (!controllerRef.current || cancelling) return;
    setCancelling(true);
    setConfirmStop(false);
    controllerRef.current.abort();
  };

  const requestClose = () => {
    if (phase === 'running') { setConfirmStop(true); return; }
    if (onClose) onClose();
  };

  const showItem = () => api.call('shell:showItem', { path: result.path }).catch((e) => toast('打开文件夹失败：' + e.message, 'error'));
  const play = () => api.call('shell:openPath', { path: result.path }).catch((e) => toast('播放失败：' + e.message, 'error'));
  const openCredits = () => api.call('shell:openPath', { path: result.creditsPath }).catch((e) => toast('打开署名文件失败：' + e.message, 'error'));
  const copyCredits = async () => {
    try {
      await navigator.clipboard.writeText(credits);
      toast('已复制署名，可以粘贴到视频简介里', 'success', undefined, { key: 'export-credits' });
    } catch {
      toast('复制没有成功，请打开署名文件手动复制', 'warn');
    }
  };
  const again = () => { setPhase('config'); setResult(null); setProgress(null); setThumb(''); };

  const pct = progress ? Math.max(0, Math.min(1, Number(progress.progress) || 0)) : 0;
  const encoding = !!progress && progress.phase === 'encode';
  const blocking = issues.some((i) => i.level === 'danger');
  const outParts = splitOutPath(outPath);

  let footer;
  if (phase === 'config') {
    footer = (
      <>
        <span className={'grow hint ex-foot-hint' + (licenseBlocked ? ' warn' : '')}>
          {licenseBlocked
            ? '有素材不能用于公开发布：替换掉它们，或勾选「仅自己看，不公开发布」'
            : [estText, opts.audioOnly ? `${opts.format.toUpperCase()} · 仅音频` : `${opts.w}×${opts.h} · ${opts.fps} 帧/秒 · ${opts.format.toUpperCase()}`].filter(Boolean).join(' · ')}
        </span>
        <Button onClick={onClose}>取消</Button>
        <Button variant="primary" icon="download" onClick={start} disabled={empty || licenseBlocked}>{blocking ? '仍然导出' : '开始导出'}</Button>
      </>
    );
  } else if (phase === 'running') {
    footer = confirmStop ? (
      <>
        <span className="grow hint">关闭窗口会取消这次导出，确定吗？</span>
        <Button onClick={() => setConfirmStop(false)}>继续导出</Button>
        <Button variant="danger" onClick={cancel}>取消导出</Button>
      </>
    ) : (
      <Button variant="danger" icon={cancelling ? undefined : 'stop'} onClick={cancel} disabled={cancelling}>
        {cancelling ? <><Spinner /> 正在取消…</> : '取消导出'}
      </Button>
    );
  } else {
    footer = (
      <>
        <Button variant="ghost" icon="refresh" onClick={again}>再导出一份</Button>
        <span className="grow" />
        <Button icon="folder" onClick={showItem}>打开所在文件夹</Button>
        {!opts.audioOnly && <Button icon="play" onClick={play}>播放</Button>}
        <Button variant="primary" onClick={onClose}>完成</Button>
      </>
    );
  }

  const pickPreset = (id) => { setPresetId(id); setFormat(''); setBitrate(''); setFps(0); };
  const platformPresets = EXPORT_PRESETS.filter((p) => PLATFORM_PRESET_IDS.includes(p.id));
  const otherPresets = EXPORT_PRESETS.filter((p) => !PLATFORM_PRESET_IDS.includes(p.id));
  const advBrief = opts.audioOnly
    ? `${opts.format.toUpperCase()} · ${opts.format === 'wav' ? '无损' : `${Math.min(320, Math.max(64, opts.bitrate || 320))} kbps`}`
    : [
      `${opts.w}×${opts.h}`,
      `${opts.fps} 帧/秒`,
      opts.format.toUpperCase(),
      opts.gif ? '' : (opts.bitrate > 0 ? `码率 ${(opts.bitrate / 1000).toFixed(opts.bitrate % 1000 ? 1 : 0)} Mbps` : '码率自动'),
      opts.gif ? '' : `显卡加速${hw ? '开' : '关'}`,
    ].filter(Boolean).join(' · ');

  return (
    <Modal title="导出" onClose={requestClose} className="ex-modal" footer={footer} wide>
      {phase === 'config' && (
        <div className="ex-config">
          {empty ? (
            <div className="callout warn">
              时间线上还没有内容，暂时无法导出。去「创作」生成画面后点「进入剪辑」，或在「精修」里把素材拖到时间线上。
            </div>
          ) : (
            <div className="ex-summary">
              <Stat label="时长" value={fmtTime(duration)} />
              <Stat label="片段" value={`${clipCount} 个`} />
              <Stat label="输出" value={opts.audioOnly ? '仅音频' : `${opts.w} × ${opts.h}`} />
              <Stat label="预计大小" value={estText || '—'} title="按时长和码率粗略估算，实际大小随画面内容变化" />
            </div>
          )}

          <section className="ex-section" aria-labelledby="ex-sec-preset">
            <h4 className="ex-label" id="ex-sec-preset">发布到</h4>
            <div className="ex-presets" role="radiogroup" aria-labelledby="ex-sec-preset">
              <div className="ex-grid platforms">
                {platformPresets.map((p) => (
                  <PresetCard key={p.id} p={p} active={presetId === p.id} onPick={() => pickPreset(p.id)} projSettings={projSettings} />
                ))}
              </div>
              {otherPresets.length > 0 && (
                <>
                  <span className="ex-sublabel">其他格式</span>
                  <div className="ex-grid others">
                    {otherPresets.map((p) => (
                      <PresetCard key={p.id} p={p} active={presetId === p.id} onPick={() => pickPreset(p.id)} projSettings={projSettings} compact />
                    ))}
                  </div>
                </>
              )}
            </div>
          </section>

          {!opts.audioOnly && (
            <section className="ex-section" aria-labelledby="ex-sec-quality">
              <h4 className="ex-label" id="ex-sec-quality">画质</h4>
              <div className="ex-quality" role="radiogroup" aria-labelledby="ex-sec-quality">
                {QUALITY_OPTIONS.map((q) => (
                  <button key={q.value} type="button" role="radio" aria-checked={quality === q.value} className={'ex-quality-item' + (quality === q.value ? ' active' : '')} onClick={() => setQuality(q.value)}>
                    <b>{q.title}</b>
                    <span>{q.desc}</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {!empty && (
            <section className="ex-section" aria-labelledby="ex-sec-check">
              <h4 className="ex-label" id="ex-sec-check">导出前检查</h4>
              <div className="ex-checks">
                {issues.map((it, i) => (
                  <div key={'issue' + i} className={'ex-check ' + (it.level === 'danger' ? 'danger' : 'warn')}>
                    <Icon name="alert" size={14} /><span>{it.text}</span>
                  </div>
                ))}
                {licenseCheck.block.length > 0 && (
                  <div className="ex-check danger" role="alert">
                    <Icon name="alert" size={14} />
                    <div className="grow">
                      <div>有 {licenseCheck.block.length} 个素材不能用于公开发布，请在时间线上替换掉：</div>
                      <ul className="ex-check-list">
                        {licenseCheck.block.slice(0, 4).map((x) => <li key={x.assetId || x.title}><b>{x.title}</b>{x.reason ? `：${x.reason}` : ''}</li>)}
                        {licenseCheck.block.length > 4 && <li>…等 {licenseCheck.block.length} 个</li>}
                      </ul>
                    </div>
                  </div>
                )}
                {licenseCheck.warn.length > 0 && (
                  <div className="ex-check warn">
                    <Icon name="info" size={14} />
                    <div className="grow">
                      <div>{licenseCheck.warn.length} 个素材的使用条件需要留意：{shortList(licenseCheck.warn.map((x) => x.title))}</div>
                      {licenseCheck.warn[0].reason && <div className="ex-check-sub">{licenseCheck.warn[0].reason}{licenseCheck.warn.length > 1 ? ' 等' : ''}。发布前请确认来源和署名要求。</div>}
                    </div>
                  </div>
                )}
                {commercialCheck.block.length > 0 && (
                  <label className="ex-check-toggle">
                    <input type="checkbox" checked={personalUse} onChange={(e) => setPersonalUse(e.target.checked)} />
                    <span>仅自己看，不公开发布（不发到抖音、B 站等平台，也不用于商业用途）</span>
                  </label>
                )}
                {!issues.length && !licenseCheck.block.length && !licenseCheck.warn.length && (
                  <div className="ex-check ok"><Icon name="check" size={14} /><span>检查通过：素材都在线，时间线没有空隙。</span></div>
                )}
                {showAiLabel && (
                  <div className="ex-toggle-row">
                    <div className="grow">
                      <div className="ex-toggle-title">在画面右上角标注「AI 生成」</div>
                      <div className={'ex-toggle-desc' + (aiLabel ? '' : ' warn')}>
                        {aiLabel
                          ? '项目里用到了 AI 生成的画面。按国家规定和各平台要求，发布 AI 生成的内容需要明显标注。'
                          : '已关闭标注。发布时请在平台上手动声明「AI 生成」，否则作品可能被限流或下架。'}
                      </div>
                    </div>
                    <Switch checked={aiLabel} onChange={setAiLabel} title="在画面上标注「AI 生成」" />
                  </div>
                )}
                {credits && (
                  <div className="ex-toggle-row">
                    <div className="grow">
                      <div className="ex-toggle-title">在视频旁保存素材署名（.credits.txt）</div>
                      <div className="ex-toggle-desc">
                        部分免版权素材要求注明作者，发布时把署名贴到视频简介里即可。
                        <button type="button" className="ex-link" onClick={copyCredits}>复制署名</button>
                      </div>
                    </div>
                    <Switch checked={writeCredits} onChange={setWriteCredits} title="导出时保存署名文件" />
                  </div>
                )}
              </div>
            </section>
          )}

          <details className="ex-adv">
            <summary className="ex-adv-sum">
              <Icon name="chevronRight" size={14} className="ex-adv-chev" />
              <span className="ex-adv-title">高级设置</span>
              <span className="ex-adv-brief ellipsis mono">{advBrief}</span>
            </summary>
            <div className="ex-adv-body">
              <div className="ex-row2">
                {custom && (
                  <Field label="分辨率">
                    <Select
                      value={resolution}
                      onChange={setResolution}
                      options={[
                        { value: 'full', label: `原始（${exportSize(projSettings, 'full').width}×${exportSize(projSettings, 'full').height}）` },
                        { value: '720p', label: `720p（${exportSize(projSettings, '720p').width}×${exportSize(projSettings, '720p').height}）` },
                      ]}
                    />
                  </Field>
                )}
                <Field label="帧率">
                  <Select value={String(fps || 0)} onChange={(v) => setFps(Number(v))} options={[{ value: '0', label: `跟随预设（${opts.fps} 帧/秒）` }, ...FPS_OPTIONS.map((f) => ({ value: String(f), label: `${f} 帧/秒` }))]} />
                </Field>
                <Field label="格式">
                  <Select value={format || opts.format} onChange={setFormat} options={FORMATS.map((f) => ({ value: f.id, label: f.label }))} />
                </Field>
                {opts.format !== 'gif' && opts.format !== 'wav' && (
                  <Field label={opts.audioOnly ? '音频码率（kbps）' : '视频码率（kbps，0 = 按画质自动）'}>
                    <input className="input" type="number" min="0" step={opts.audioOnly ? 32 : 500} value={bitrate === '' ? opts.bitrate : bitrate} onChange={(e) => setBitrate(e.target.value)} />
                  </Field>
                )}
              </div>
              {!opts.audioOnly && opts.format !== 'gif' && (
                <div className="ex-toggles">
                  <div className="ex-toggle-row">
                    <div className="grow">
                      <div className="ex-toggle-title">用显卡加速导出</div>
                      <div className="ex-toggle-desc">通常快 2–5 倍；显卡不支持时会自动改用普通方式。</div>
                    </div>
                    <Switch checked={hw} onChange={setHw} title="用显卡加速导出" />
                  </div>
                  <div className="ex-toggle-row">
                    <div className="grow">
                      <div className="ex-toggle-title">字幕另存为 .srt 文件</div>
                      <div className="ex-toggle-desc">{hasCaptions ? '字幕不烧进画面，上传平台时可以单独上传字幕文件。' : '项目里还没有字幕。'}</div>
                    </div>
                    <Switch checked={srt && hasCaptions} onChange={setSrt} disabled={!hasCaptions} title="字幕另存为 .srt 文件" />
                  </div>
                </div>
              )}
            </div>
          </details>

          <section className="ex-section" aria-labelledby="ex-sec-out">
            <h4 className="ex-label" id="ex-sec-out">保存位置</h4>
            <div className="ex-out">
              <div className="ex-out-box" title={outPath}>
                <Icon name="folder" size={16} />
                <div className="ex-out-text">
                  <span className="ex-out-file selectable">{outParts.file || '未命名'}</span>
                  {outParts.dir
                    ? <TruncStart text={outParts.dir} className="ex-out-dir" />
                    : <span className="ex-out-dir">点「开始导出」时再选择保存的文件夹</span>}
                </div>
                {estText && <span className="ex-out-size" title="按时长和码率粗略估算">{estText}</span>}
              </div>
              <Button onClick={chooseOutput}>更改…</Button>
            </div>
          </section>

          {error && <div className="callout ex-error" role="alert"><b>导出失败：</b>{error}。时间线没有被改动，可以调整后再试一次。</div>}
        </div>
      )}

      {phase === 'running' && progress && (
        <div className="ex-running">
          <div className="ex-big">
            <span className="ex-pct mono">{Math.round(pct * 100)}<small>%</small></span>
            <span className="ex-phase">{cancelling ? '正在取消…' : encoding ? (opts.audioOnly ? '正在混合声音…' : '正在合成声音，马上就好…') : '正在生成画面'}</span>
          </div>
          <ProgressBar value={pct} indeterminate={encoding && !(pct > 0)} />
          <div className="ex-stats">
            <Stat label="进度" value={`${(Number(progress.frame) || 0).toLocaleString('zh-CN')} / ${(Number(progress.total) || totalFrames).toLocaleString('zh-CN')} 帧`} />
            <Stat label="速度" value={progress.fps > 0 ? `${Number(progress.fps).toFixed(1)} 帧/秒` : '—'} />
            <Stat label="预计剩余" value={fmtEta(progress.etaSec, progress.phase)} />
          </div>
          <p className="hint">可以切到别的窗口，任务栏图标会显示进度，导出完成会提醒你。导出期间请不要关闭镜流。</p>
        </div>
      )}

      {phase === 'done' && result && (() => {
        const done = splitOutPath(result.path);
        return (
          <div className="ex-done">
            <div className="ex-done-hero">
              {thumb && thumb !== 'none'
                ? <img className="ex-done-thumb" src={thumb} alt="成片画面" />
                : (
                  <div className="ex-done-thumb placeholder" aria-hidden="true">
                    {opts.audioOnly ? <Icon name="music" size={28} /> : thumb === 'none' ? <Icon name="film" size={28} /> : <Spinner />}
                  </div>
                )}
              <span className="ex-done-badge" aria-hidden="true"><Icon name="check" size={14} stroke={2.6} /></span>
            </div>
            <h3>导出完成</h3>
            <p className="ex-done-file selectable" title={result.path}>{done.file}</p>
            {done.dir && (
              <p className="ex-done-dir">
                <Icon name="folder" size={12} />
                <TruncStart text={done.dir} />
              </p>
            )}
            <div className="ex-stats">
              <Stat label="时长" value={fmtTime(Number(result.duration) || duration)} />
              <Stat label="文件大小" value={Number.isFinite(result.size) ? fmtBytes(result.size) : '—'} />
              <Stat label="用时" value={fmtElapsed(result.elapsed)} />
            </div>
            {(result.encoder && result.encoder !== 'libx264') || result.srtPath || result.creditsPath || credits ? (
              <div className="ex-done-notes">
                {result.encoder && result.encoder !== 'libx264' && <p className="hint">已用显卡加速导出</p>}
                {result.srtPath && <p className="hint ellipsis" title={result.srtPath}>字幕文件：{basenameOf(result.srtPath)}</p>}
                {result.creditsPath && (
                  <p className="hint ex-done-credits">
                    <span className="ellipsis" title={result.creditsPath}>素材署名：{basenameOf(result.creditsPath)}</span>
                    <button type="button" className="ex-link" onClick={openCredits}>打开</button>
                  </p>
                )}
                {credits && (
                  <p className="hint ex-done-credits">
                    <span>发布时记得把素材署名贴到视频简介里</span>
                    <button type="button" className="ex-link" onClick={copyCredits}>复制署名</button>
                  </p>
                )}
              </div>
            ) : null}
          </div>
        );
      })()}
    </Modal>
  );
}