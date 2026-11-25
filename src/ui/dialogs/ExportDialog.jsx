// Export Dialog: configuration -> live rendering progress -> completion preview.
// Includes preflight checks (offline assets / gaps / previz), license validation, AI badge, and credits export.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import useStore from '../store.js';
import api from '../api.js';
import { DICTS, t, useLocale, useT } from '../i18n.js';
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
  { value: 'high', titleKey: 'export.quality.high', descKey: 'export.quality.highDesc' },
  { value: 'standard', titleKey: 'export.quality.standard', descKey: 'export.quality.standardDesc' },
  { value: 'small', titleKey: 'export.quality.small', descKey: 'export.quality.smallDesc' },
];

function even(n) { return Math.max(2, Math.round(n / 2) * 2); }

/** 720p tier = dimensions * 2/3 rounded to even. */
export function exportSize(settings, resolution) {
  const w = (settings && settings.width) || 1920;
  const h = (settings && settings.height) || 1080;
  return resolution === '720p' ? { width: even((w * 2) / 3), height: even((h * 2) / 3) } : { width: even(w), height: even(h) };
}

function safeFileName(name, fallback) {
  return String(name || fallback).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 80) || fallback;
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

/** Default output path: <Documents>/<projectName>.mp4. */
function defaultOutPath(name, settings, appInfo) {
  const folder = settings && settings.export && settings.export.folder;
  const root = appInfo && appInfo.dataRoot;
  const docs = root && !(settings && settings.dataRoot) ? dirnameOf(root) : '';
  return joinPath(folder || docs, `${safeFileName(name, t('app.untitledProject'))}.mp4`);
}

function fmtApproxSizeLoc(bytes, locale, tr) {
  if (locale === 'zh-CN') return fmtApproxSize(bytes);
  const b = Number(bytes);
  if (!(b > 0)) return '';
  const KB = 1024; const MB = KB * 1024; const GB = MB * 1024;
  let val;
  if (b < MB) val = `${Math.max(1, Math.round(b / KB))} KB`;
  else if (b < 10 * MB) val = `${(b / MB).toFixed(1)} MB`;
  else if (b < GB) val = `${Math.round(b / MB)} MB`;
  else val = `${(b / GB).toFixed(1)} GB`;
  return tr('export.size.approx', { val });
}

function fmtEtaLoc(sec, phase, locale, tr) {
  if (locale === 'zh-CN') return fmtEta(sec, phase);
  if (phase === 'encode') return tr('export.eta.almostDone');
  if (!Number.isFinite(sec) || sec < 0) return tr('export.eta.calculating');
  if (sec < 1) return tr('export.eta.under1s');
  const s = Math.ceil(sec);
  if (s < 60) return tr('export.eta.sec', { s });
  const m = Math.floor(s / 60);
  if (m < 60) return tr('export.eta.minSec', { m, s: s % 60 });
  return tr('export.eta.hrMin', { h: Math.floor(m / 60), m: m % 60 });
}

function fmtElapsedLoc(sec, locale, tr) {
  if (locale === 'zh-CN') return fmtElapsed(sec);
  if (!Number.isFinite(sec) || sec < 0) return '—';
  return fmtEtaLoc(sec, undefined, locale, tr);
}

function shortListLoc(names, locale, tr, max = 3) {
  if (locale === 'zh-CN') return shortList(names, max);
  const arr = (Array.isArray(names) ? names : []).filter(Boolean).map(String);
  if (!arr.length) return '';
  const head = arr.slice(0, max).map((n) => `"${n}"`).join(', ');
  return arr.length > max ? tr('export.shortListMore', { head, count: arr.length }) : head;
}

function presetLabel(p, tr) {
  const k = `export.preset.${p.id}.label`;
  return Object.prototype.hasOwnProperty.call(DICTS['zh-CN'], k) ? tr(k) : p.label;
}

function presetDesc(p, tr) {
  const k = `export.preset.${p.id}.desc`;
  return Object.prototype.hasOwnProperty.call(DICTS['zh-CN'], k) ? tr(k) : p.desc;
}

function formatLabel(f, tr) {
  const k = `export.format.${f.id}`;
  return Object.prototype.hasOwnProperty.call(DICTS['zh-CN'], k) ? tr(k) : f.label;
}

function Stat({ label, value, title }) {
  return (
    <div className="ex-stat" title={title}>
      <span className="ex-stat-label">{label}</span>
      <span className="ex-stat-value mono">{value}</span>
    </div>
  );
}

const iconOr = (name, fallback) => (Array.isArray(ICON_NAMES) && ICON_NAMES.includes(name) ? name : fallback);
const PRESET_FALLBACK_ICON = { custom: 'sliders', 'audio-mp3': 'music', gif: 'image' };
const iconOf = (p) => iconOr((p && p.icon) || PRESET_FALLBACK_ICON[p && p.id] || 'film', PRESET_FALLBACK_ICON[p && p.id] || 'film');

/** Start-truncated path keeping the trailing folder names visible. */
function TruncStart({ text, className = '' }) {
  return (
    <span className={'ex-trunc-start ' + className} title={text}>
      <span className="ex-trunc-inner">{text}</span>
    </span>
  );
}

/** Sync taskbar progress / flash / system notification when supported by main process. */
function taskbar(payload) {
  try {
    const p = api.call('app:taskbar', payload);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* ignore */ }
}

/** Platform preset card with aspect indicator and mismatch warning. */
function PresetCard({ p, active, onPick, projSettings, compact }) {
  const tr = useT();
  const pw = Number(projSettings.width) > 0 ? Number(projSettings.width) : 1920;
  const ph = Number(projSettings.height) > 0 ? Number(projSettings.height) : 1080;
  const projLand = pw >= ph;
  const mismatch = !!p.aspect && (p.aspect === '9:16') === projLand;
  const label = presetLabel(p, tr);
  let desc = presetDesc(p, tr);
  if (mismatch) {
    const r = resolveExportOptions(p.id, projSettings);
    desc = tr('export.preset.mismatchDesc', { w: r.w, h: r.h });
  }
  const wantOrient = p.aspect === '9:16' ? tr('export.orient.vertical') : tr('export.orient.horizontal');
  const haveOrient = projLand ? tr('export.orient.horizontal') : tr('export.orient.vertical');
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      data-preset={p.id}
      className={'ex-card' + (active ? ' active' : '') + (compact ? ' compact' : '')}
      onClick={onPick}
      title={mismatch ? tr('export.preset.mismatchTitle', { label, want: wantOrient, have: haveOrient }) : undefined}
    >
      <span className="ex-card-ico"><Icon name={iconOf(p)} size={compact ? 15 : 18} /></span>
      <span className="ex-card-text">
        <span className="ex-card-title">{label}</span>
        <span className={'ex-card-desc' + (mismatch ? ' note' : '')}>{desc}</span>
      </span>
      {!compact && p.aspect && <span className={'ex-aspect ' + (p.aspect === '9:16' ? 'v' : 'h')} aria-hidden="true" />}
    </button>
  );
}

/** Export preflight checks: offline assets, timeline gaps, and animated previz placeholders. */
export function preflight(project, localeOverride = null) {
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
    if (!a) offline.add(t('export.preflight.deletedAsset', null, localeOverride));
    else if (a.missing || a.offline || a.status === 'missing') offline.add(a.name || id);
  }
  if (offline.size) {
    const sep = t('export.preflight.listSep', null, localeOverride);
    const names = [...offline].slice(0, 3).join(sep);
    const more = offline.size > 3 ? t('export.preflight.moreSuffix', null, localeOverride) : '';
    issues.push({ level: 'danger', text: t('export.preflight.offline', { count: offline.size, names, more }, localeOverride) });
  }
  let layout = [];
  try { layout = layoutVideo(project); } catch { layout = []; }
  let gaps = 0;
  for (let i = 1; i < layout.length; i += 1) if (layout[i].start - layout[i - 1].end > 0.04) gaps += 1;
  if (layout.length && layout[0].start > 0.04) gaps += 1;
  if (gaps) issues.push({ level: 'warn', text: t('export.preflight.gaps', { count: gaps }, localeOverride) });
  const previz = ((project.tracks && project.tracks.video) || []).filter((c) => {
    const a = assets[c.assetId];
    return a && (a.kind === 'previz' || a.source === 'previz');
  }).length;
  if (previz) issues.push({ level: 'warn', text: t('export.preflight.previz', { count: previz }, localeOverride) });
  return issues;
}

export default function ExportDialog({ onClose }) {
  const locale = useLocale();
  const tr = useT();
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

  // License checks, AI disclosure badge, and media attributions
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
  const issues = useMemo(() => preflight(project, locale), [project, locale]);
  const hasCaptions = !!project && ((project.tracks && project.tracks.text) || []).some(isCaptionText);
  const ext = extFor(opts.format);
  const pathWithExt = (p) => String(p || '').replace(/\.(mp4|mov|gif|mp3|wav)$/i, '') + '.' + ext;
  const estBytes = estimateExportBytes({ duration, w: opts.w, h: opts.h, fps: opts.fps, quality, bitrate: opts.bitrate, format: opts.format, audioOnly: opts.audioOnly, gif: opts.gif });
  const estText = fmtApproxSizeLoc(estBytes, locale, tr);
  const showAiLabel = usesAi && !opts.audioOnly;
  const licenseBlocked = licenseCheck.block.length > 0;

  useEffect(() => { setOutPath((p) => pathWithExt(p)); }, [ext]); // eslint-disable-line react-hooks/exhaustive-deps

  const fileFilter = () => {
    const f = FORMATS.find((x) => x.id === opts.format) || FORMATS[0];
    return [{ name: formatLabel(f, tr), extensions: [f.ext] }];
  };

  const chooseOutput = async () => {
    try {
      const p = await api.call('dialog:saveFile', { title: tr('export.title'), defaultPath: outPath, filters: fileFilter() });
      if (p) { setOutPath(pathWithExt(p)); return true; }
      return false;
    } catch (e) {
      toast(tr('export.toast.chooseOutFailed', { error: e.message }), 'error');
      return false;
    }
  };

  const start = async () => {
    if (phase === 'running' || empty || licenseBlocked) return;
    setError('');
    let target = pathWithExt(outPath);
    if (!/[\\/]/.test(target)) {
      const p = await api.call('dialog:saveFile', { title: tr('export.title'), defaultPath: target, filters: fileFilter() }).catch((e) => { toast(tr('export.toast.chooseOutFailed', { error: e.message }), 'error'); return null; });
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
        aiLabel: showAiLabel && aiLabel ? { text: tr('export.aigc.watermarkText'), corner: 'top-right' } : false,
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
      taskbar({ progress: -1, flash: true, notify: { title: tr('export.notify.doneTitle'), body: tr('export.notify.doneBody', { file: fileName }) } });
      if (!mounted.current) return;
      setResult({ ...r, path: (r && r.path) || target, elapsed: (Date.now() - startedAt) / 1000 });
      setPhase('done');
      if (!opts.audioOnly) {
        renderProjectFrame(snapshot, { maxSide: 480 })
          .then((u) => { if (mounted.current) setThumb(u || 'none'); })
          .catch(() => { if (mounted.current) setThumb('none'); });
      }
    } catch (e) {
      controllerRef.current = null;
      const cancelled = !!(e && (e.cancelled || e.code === 'CANCELLED'));
      if (cancelled) taskbar({ progress: -1 });
      else taskbar({ progress: -1, flash: true, notify: { title: tr('export.notify.failTitle'), body: String((e && e.message) || tr('export.notify.failBodyFallback')).slice(0, 120) } });
      if (!mounted.current) return;
      setPhase('config');
      setProgress(null);
      setCancelling(false);
      setConfirmStop(false);
      if (cancelled) toast(tr('export.toast.cancelled'), 'info');
      else setError((e && e.message) || tr('export.toast.failedFallback'));
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

  const showItem = () => api.call('shell:showItem', { path: result.path }).catch((e) => toast(tr('export.toast.openFolderFailed', { error: e.message }), 'error'));
  const play = () => api.call('shell:openPath', { path: result.path }).catch((e) => toast(tr('export.toast.playFailed', { error: e.message }), 'error'));
  const openCredits = () => api.call('shell:openPath', { path: result.creditsPath }).catch((e) => toast(tr('export.toast.openCreditsFailed', { error: e.message }), 'error'));
  const copyCredits = async () => {
    try {
      await navigator.clipboard.writeText(credits);
      toast(tr('export.toast.creditsCopied'), 'success', undefined, { key: 'export-credits' });
    } catch {
      toast(tr('export.toast.creditsCopyFailed'), 'warn');
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
            ? tr('export.license.footerBlocked')
            : [estText, opts.audioOnly ? `${opts.format.toUpperCase()} · ${tr('export.stat.audioOnly')}` : `${opts.w}×${opts.h} · ${tr('export.adv.fpsUnit', { fps: opts.fps })} · ${opts.format.toUpperCase()}`].filter(Boolean).join(' · ')}
        </span>
        <Button onClick={onClose}>{tr('app.cancel')}</Button>
        <Button variant="primary" icon="download" onClick={start} disabled={empty || licenseBlocked}>{blocking ? tr('export.btn.exportAnyway') : tr('export.btn.start')}</Button>
      </>
    );
  } else if (phase === 'running') {
    footer = confirmStop ? (
      <>
        <span className="grow hint">{tr('export.confirmStopHint')}</span>
        <Button onClick={() => setConfirmStop(false)}>{tr('export.btn.keepExporting')}</Button>
        <Button variant="danger" onClick={cancel}>{tr('export.btn.cancelExport')}</Button>
      </>
    ) : (
      <Button variant="danger" icon={cancelling ? undefined : 'stop'} onClick={cancel} disabled={cancelling}>
        {cancelling ? <><Spinner /> {tr('export.btn.cancelling')}</> : tr('export.btn.cancelExport')}
      </Button>
    );
  } else {
    footer = (
      <>
        <Button variant="ghost" icon="refresh" onClick={again}>{tr('export.btn.exportAgain')}</Button>
        <span className="grow" />
        <Button icon="folder" onClick={showItem}>{tr('export.btn.openFolder')}</Button>
        {!opts.audioOnly && <Button icon="play" onClick={play}>{tr('export.btn.play')}</Button>}
        <Button variant="primary" onClick={onClose}>{tr('app.done')}</Button>
      </>
    );
  }

  const pickPreset = (id) => { setPresetId(id); setFormat(''); setBitrate(''); setFps(0); };
  const platformPresets = EXPORT_PRESETS.filter((p) => PLATFORM_PRESET_IDS.includes(p.id));
  const otherPresets = EXPORT_PRESETS.filter((p) => !PLATFORM_PRESET_IDS.includes(p.id));
  const advBrief = opts.audioOnly
    ? `${opts.format.toUpperCase()} · ${opts.format === 'wav' ? tr('export.adv.lossless') : `${Math.min(320, Math.max(64, opts.bitrate || 320))} kbps`}`
    : [
      `${opts.w}×${opts.h}`,
      tr('export.adv.fpsUnit', { fps: opts.fps }),
      opts.format.toUpperCase(),
      opts.gif ? '' : (opts.bitrate > 0 ? tr('export.adv.bitrateMbps', { val: (opts.bitrate / 1000).toFixed(opts.bitrate % 1000 ? 1 : 0) }) : tr('export.adv.bitrateAuto')),
      opts.gif ? '' : (hw ? tr('export.adv.hwOn') : tr('export.adv.hwOff')),
    ].filter(Boolean).join(' · ');

  return (
    <Modal title={tr('export.title')} onClose={requestClose} className="ex-modal" footer={footer} wide>
      {phase === 'config' && (
        <div className="ex-config">
          {empty ? (
            <div className="callout warn">
              {tr('export.emptyTimeline')}
            </div>
          ) : (
            <div className="ex-summary">
              <Stat label={tr('export.stat.duration')} value={fmtTime(duration)} />
              <Stat label={tr('export.stat.clips')} value={tr('export.stat.clipsVal', { count: clipCount })} />
              <Stat label={tr('export.stat.output')} value={opts.audioOnly ? tr('export.stat.audioOnly') : `${opts.w} × ${opts.h}`} />
              <Stat label={tr('export.stat.estSize')} value={estText || '—'} title={tr('export.stat.estSizeTitle')} />
            </div>
          )}

          <section className="ex-section" aria-labelledby="ex-sec-preset">
            <h4 className="ex-label" id="ex-sec-preset">{tr('export.publishTo')}</h4>
            <div className="ex-presets" role="radiogroup" aria-labelledby="ex-sec-preset">
              <div className="ex-grid platforms">
                {platformPresets.map((p) => (
                  <PresetCard key={p.id} p={p} active={presetId === p.id} onPick={() => pickPreset(p.id)} projSettings={projSettings} />
                ))}
              </div>
              {otherPresets.length > 0 && (
                <>
                  <span className="ex-sublabel">{tr('export.otherFormats')}</span>
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
              <h4 className="ex-label" id="ex-sec-quality">{tr('export.quality.label')}</h4>
              <div className="ex-quality" role="radiogroup" aria-labelledby="ex-sec-quality">
                {QUALITY_OPTIONS.map((q) => (
                  <button key={q.value} type="button" role="radio" aria-checked={quality === q.value} className={'ex-quality-item' + (quality === q.value ? ' active' : '')} onClick={() => setQuality(q.value)}>
                    <b>{tr(q.titleKey)}</b>
                    <span>{tr(q.descKey)}</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {!empty && (
            <section className="ex-section" aria-labelledby="ex-sec-check">
              <h4 className="ex-label" id="ex-sec-check">{tr('export.preflight.title')}</h4>
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
                      <div>{tr('export.license.blockedTitle', { count: licenseCheck.block.length })}</div>
                      <ul className="ex-check-list">
                        {licenseCheck.block.slice(0, 4).map((x) => <li key={x.assetId || x.title}><b>{x.title}</b>{x.reason ? (locale === 'zh-CN' ? `：${x.reason}` : `: ${x.reason}`) : ''}</li>)}
                        {licenseCheck.block.length > 4 && <li>{tr('export.license.blockedMore', { count: licenseCheck.block.length })}</li>}
                      </ul>
                    </div>
                  </div>
                )}
                {licenseCheck.warn.length > 0 && (
                  <div className="ex-check warn">
                    <Icon name="info" size={14} />
                    <div className="grow">
                      <div>{tr('export.license.warnTitle', { count: licenseCheck.warn.length, names: shortListLoc(licenseCheck.warn.map((x) => x.title), locale, tr) })}</div>
                      {licenseCheck.warn[0].reason && (
                        <div className="ex-check-sub">
                          {tr('export.license.warnSub', { reason: licenseCheck.warn[0].reason, more: licenseCheck.warn.length > 1 ? tr('export.preflight.moreSuffix') : '' })}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {commercialCheck.block.length > 0 && (
                  <label className="ex-check-toggle">
                    <input type="checkbox" checked={personalUse} onChange={(e) => setPersonalUse(e.target.checked)} />
                    <span>{tr('export.license.personalUse')}</span>
                  </label>
                )}
                {!issues.length && !licenseCheck.block.length && !licenseCheck.warn.length && (
                  <div className="ex-check ok"><Icon name="check" size={14} /><span>{tr('export.preflight.ok')}</span></div>
                )}
                {showAiLabel && (
                  <div className="ex-toggle-row">
                    <div className="grow">
                      <div className="ex-toggle-title">{tr('export.aigc.title')}</div>
                      <div className={'ex-toggle-desc' + (aiLabel ? '' : ' warn')}>
                        {aiLabel ? tr('export.aigc.onDesc') : tr('export.aigc.offDesc')}
                      </div>
                    </div>
                    <Switch checked={aiLabel} onChange={setAiLabel} title={tr('export.aigc.switchTitle')} />
                  </div>
                )}
                {credits && (
                  <div className="ex-toggle-row">
                    <div className="grow">
                      <div className="ex-toggle-title">{tr('export.credits.title')}</div>
                      <div className="ex-toggle-desc">
                        {tr('export.credits.desc')}
                        <button type="button" className="ex-link" onClick={copyCredits}>{tr('export.credits.copy')}</button>
                      </div>
                    </div>
                    <Switch checked={writeCredits} onChange={setWriteCredits} title={tr('export.credits.switchTitle')} />
                  </div>
                )}
              </div>
            </section>
          )}

          <details className="ex-adv">
            <summary className="ex-adv-sum">
              <Icon name="chevronRight" size={14} className="ex-adv-chev" />
              <span className="ex-adv-title">{tr('export.adv.title')}</span>
              <span className="ex-adv-brief ellipsis mono">{advBrief}</span>
            </summary>
            <div className="ex-adv-body">
              <div className="ex-row2">
                {custom && (
                  <Field label={tr('export.adv.resolution')}>
                    <Select
                      value={resolution}
                      onChange={setResolution}
                      options={[
                        { value: 'full', label: tr('export.adv.resFull', { w: exportSize(projSettings, 'full').width, h: exportSize(projSettings, 'full').height }) },
                        { value: '720p', label: tr('export.adv.res720', { w: exportSize(projSettings, '720p').width, h: exportSize(projSettings, '720p').height }) },
                      ]}
                    />
                  </Field>
                )}
                <Field label={tr('export.adv.fps')}>
                  <Select value={String(fps || 0)} onChange={(v) => setFps(Number(v))} options={[{ value: '0', label: tr('export.adv.fpsFollow', { fps: opts.fps }) }, ...FPS_OPTIONS.map((f) => ({ value: String(f), label: tr('export.adv.fpsUnit', { fps: f }) }))]} />
                </Field>
                <Field label={tr('export.adv.format')}>
                  <Select value={format || opts.format} onChange={setFormat} options={FORMATS.map((f) => ({ value: f.id, label: formatLabel(f, tr) }))} />
                </Field>
                {opts.format !== 'gif' && opts.format !== 'wav' && (
                  <Field label={opts.audioOnly ? tr('export.adv.audioBitrate') : tr('export.adv.videoBitrate')}>
                    <input className="input" type="number" min="0" step={opts.audioOnly ? 32 : 500} value={bitrate === '' ? opts.bitrate : bitrate} onChange={(e) => setBitrate(e.target.value)} />
                  </Field>
                )}
              </div>
              {!opts.audioOnly && opts.format !== 'gif' && (
                <div className="ex-toggles">
                  <div className="ex-toggle-row">
                    <div className="grow">
                      <div className="ex-toggle-title">{tr('export.adv.hwTitle')}</div>
                      <div className="ex-toggle-desc">{tr('export.adv.hwDesc')}</div>
                    </div>
                    <Switch checked={hw} onChange={setHw} title={tr('export.adv.hwTitle')} />
                  </div>
                  <div className="ex-toggle-row">
                    <div className="grow">
                      <div className="ex-toggle-title">{tr('export.adv.srtTitle')}</div>
                      <div className="ex-toggle-desc">{hasCaptions ? tr('export.adv.srtDesc') : tr('export.adv.srtNone')}</div>
                    </div>
                    <Switch checked={srt && hasCaptions} onChange={setSrt} disabled={!hasCaptions} title={tr('export.adv.srtTitle')} />
                  </div>
                </div>
              )}
            </div>
          </details>

          <section className="ex-section" aria-labelledby="ex-sec-out">
            <h4 className="ex-label" id="ex-sec-out">{tr('export.out.title')}</h4>
            <div className="ex-out">
              <div className="ex-out-box" title={outPath}>
                <Icon name="folder" size={16} />
                <div className="ex-out-text">
                  <span className="ex-out-file selectable">{outParts.file || tr('export.out.untitled')}</span>
                  {outParts.dir
                    ? <TruncStart text={outParts.dir} className="ex-out-dir" />
                    : <span className="ex-out-dir">{tr('export.out.pickLater')}</span>}
                </div>
                {estText && <span className="ex-out-size" title={tr('export.stat.estSizeTitle')}>{estText}</span>}
              </div>
              <Button onClick={chooseOutput}>{tr('export.out.change')}</Button>
            </div>
          </section>

          {error && <div className="callout ex-error" role="alert"><b>{tr('export.errorPrefix')}</b>{error}{tr('export.errorSuffix')}</div>}
        </div>
      )}

      {phase === 'running' && progress && (
        <div className="ex-running">
          <div className="ex-big">
            <span className="ex-pct mono">{Math.round(pct * 100)}<small>%</small></span>
            <span className="ex-phase">{cancelling ? tr('export.running.cancelling') : encoding ? (opts.audioOnly ? tr('export.running.mixingAudio') : tr('export.running.muxing')) : tr('export.running.rendering')}</span>
          </div>
          <ProgressBar value={pct} indeterminate={encoding && !(pct > 0)} />
          <div className="ex-stats">
            <Stat label={tr('export.running.progressLabel')} value={tr('export.running.frames', { cur: (Number(progress.frame) || 0).toLocaleString(locale), total: (Number(progress.total) || totalFrames).toLocaleString(locale) })} />
            <Stat label={tr('export.running.speedLabel')} value={progress.fps > 0 ? tr('export.adv.fpsUnit', { fps: Number(progress.fps).toFixed(1) }) : '—'} />
            <Stat label={tr('export.running.etaLabel')} value={fmtEtaLoc(progress.etaSec, progress.phase, locale, tr)} />
          </div>
          <p className="hint">{tr('export.running.hint')}</p>
        </div>
      )}

      {phase === 'done' && result && (() => {
        const done = splitOutPath(result.path);
        return (
          <div className="ex-done">
            <div className="ex-done-hero">
              {thumb && thumb !== 'none'
                ? <img className="ex-done-thumb" src={thumb} alt={tr('export.done.thumbAlt')} />
                : (
                  <div className="ex-done-thumb placeholder" aria-hidden="true">
                    {opts.audioOnly ? <Icon name="music" size={28} /> : thumb === 'none' ? <Icon name="film" size={28} /> : <Spinner />}
                  </div>
                )}
              <span className="ex-done-badge" aria-hidden="true"><Icon name="check" size={14} stroke={2.6} /></span>
            </div>
            <h3>{tr('export.done.title')}</h3>
            <p className="ex-done-file selectable" title={result.path}>{done.file}</p>
            {done.dir && (
              <p className="ex-done-dir">
                <Icon name="folder" size={12} />
                <TruncStart text={done.dir} />
              </p>
            )}
            <div className="ex-stats">
              <Stat label={tr('export.stat.duration')} value={fmtTime(Number(result.duration) || duration)} />
              <Stat label={tr('export.done.fileSize')} value={Number.isFinite(result.size) ? fmtBytes(result.size) : '—'} />
              <Stat label={tr('export.done.elapsed')} value={fmtElapsedLoc(result.elapsed, locale, tr)} />
            </div>
            {(result.encoder && result.encoder !== 'libx264') || result.srtPath || result.creditsPath || credits ? (
              <div className="ex-done-notes">
                {result.encoder && result.encoder !== 'libx264' && <p className="hint">{tr('export.done.hwUsed')}</p>}
                {result.srtPath && <p className="hint ellipsis" title={result.srtPath}>{tr('export.done.srtFile', { name: basenameOf(result.srtPath) })}</p>}
                {result.creditsPath && (
                  <p className="hint ex-done-credits">
                    <span className="ellipsis" title={result.creditsPath}>{tr('export.done.creditsFile', { name: basenameOf(result.creditsPath) })}</span>
                    <button type="button" className="ex-link" onClick={openCredits}>{tr('app.open')}</button>
                  </p>
                )}
                {credits && (
                  <p className="hint ex-done-credits">
                    <span>{tr('export.done.creditsReminder')}</span>
                    <button type="button" className="ex-link" onClick={copyCredits}>{tr('export.credits.copy')}</button>
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
