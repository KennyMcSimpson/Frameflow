// 底部状态栏（24px）：AI 后端状态 · 后台任务（点击弹出 JobsTray） · Live Watch 实时协作 · 工程时长/画幅/帧率。
import React, { useMemo, useRef } from 'react';
import useStore from '../store.js';
import { useLocale, useT } from '../i18n.js';
import { Icon, fmtTime } from './ui.jsx';
import JobsTray, { isRunning } from './JobsTray.jsx';
import { layoutVideo, projectDuration } from '../../engine/timeline.js';

function fmtClock(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

async function copyTextToClipboard(text) {
  if (!text) return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    if (typeof document !== 'undefined' && document.body) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    }
  } catch {}
  return false;
}

const PRESET_ID_LABELS = {
  openai: { zh: 'OpenAI', en: 'OpenAI' },
  deepseek: { zh: 'DeepSeek', en: 'DeepSeek' },
  anthropic: { zh: 'Anthropic Claude', en: 'Anthropic Claude' },
  gemini: { zh: 'Google Gemini', en: 'Google Gemini' },
  openrouter: { zh: 'OpenRouter', en: 'OpenRouter' },
  ark: { zh: '火山方舟', en: 'Volcengine Ark' },
  ollama: { zh: 'Ollama 本地', en: 'Ollama (Local)' },
  lmstudio: { zh: 'LM Studio', en: 'LM Studio' },
};

const EN_PRESET_LABELS = {
  '火山方舟': 'Volcengine Ark',
  'Ollama 本地': 'Ollama (Local)',
  'LM Studio 本地': 'LM Studio',
  '离线规则': 'Local Rules',
  '本地规则': 'Local Rules',
  'API 已连接': 'API Connected',
  'AI 服务': 'AI Service',
  'OpenAI 兼容接口': 'OpenAI-Compatible API',
  'OpenAI 兼容 API': 'OpenAI-Compatible API',
};

function presetIdDisplayName(presetId, isEn) {
  const key = String(presetId || '').trim().toLowerCase();
  if (!key) return '';
  const hit = PRESET_ID_LABELS[key];
  return hit ? (isEn ? hit.en : hit.zh) : '';
}

function localizePresetLabel(label, isEn) {
  if (!label || !isEn) return label;
  return EN_PRESET_LABELS[label] || label;
}

function backendDisplayName(ai, isEn) {
  const L = (zh, en) => (isEn ? en : zh);
  if (!ai) return L('离线规则', 'Local Rules');
  const raw = String(ai.provider || '').trim().toLowerCase();
  const presetLabel = ai.presetLabel || ai.presetName || ai.label || '';
  const presetId = ai.preset || (ai.api && ai.api.preset) || '';
  if (raw === 'claude' || raw === 'claude-code' || raw === 'claude_code') return 'Claude Code';
  if (raw === 'codex' || raw === 'codex-cli' || raw === 'codex_cli') return 'Codex CLI';
  if (raw === 'gemini' || raw === 'gemini-cli' || raw === 'gemini_cli') return 'Gemini CLI';
  if (raw === 'anthropic') return 'Anthropic Claude';
  if (raw === 'ollama') return L('Ollama 本地', 'Ollama (Local)');
  if (raw === 'lmstudio') return 'LM Studio';
  if (raw === 'local' || raw === 'offline' || raw === 'rules' || raw === 'none' || !raw) return L('离线规则', 'Local Rules');
  if (presetLabel) return localizePresetLabel(presetLabel, isEn);
  if (raw === 'openai' || raw === 'api' || raw === 'openai-compatible') {
    const mapped = presetIdDisplayName(presetId, isEn);
    if (mapped) return mapped;
    return presetId ? `${presetId} API` : L('API 已连接', 'API Connected');
  }
  return localizePresetLabel(ai.providerLabel || ai.provider || L('AI 服务', 'AI Service'), isEn);
}

function describeAIForStatusBar(ai, t, isEn) {
  const L = (zh, en) => (isEn ? en : zh);
  if (!ai) {
    return {
      kind: '',
      label: t('status.aiChecking'),
      title: L('正在检测可用的 AI 后端', 'Detecting available AI backends'),
    };
  }
  const detail = ai.detail ? `\n${ai.detail}` : '';
  const raw = String(ai.provider || '').trim().toLowerCase();
  const isOffline = !raw || raw === 'local' || raw === 'offline' || raw === 'rules' || raw === 'none';
  if (ai.ready && !isOffline) {
    const name = backendDisplayName(ai, isEn);
    return {
      kind: 'ai',
      label: name,
      title: isEn
        ? `AI Backend: ${name}${ai.model ? ` (${ai.model})` : ''}${detail}\nClick to open AI settings`
        : `AI 后端：${name}${ai.model ? `（${ai.model}）` : ''}${detail}\n点击打开 AI 设置`,
    };
  }
  if (!isOffline) {
    const name = backendDisplayName(ai, isEn);
    const shortName = name === 'API 已连接' || name === 'API Connected' ? 'API' : name;
    return {
      kind: 'warn',
      label: isEn ? `${shortName} Not Ready` : `${shortName} 未就绪`,
      title: isEn
        ? `${shortName} is currently unavailable; using local rules${detail}\nClick to open AI settings`
        : `${shortName} 暂不可用，当前使用离线规则${detail}\n点击打开 AI 设置`,
    };
  }
  return {
    kind: 'warn',
    label: L('离线规则', t('status.aiLocal')),
    title: isEn
      ? `No external AI connected; using local rules (command parsing, template storyboards, statistical breakdown)${detail}\nClick to open AI settings (API presets, Claude Code, Codex CLI, Gemini CLI)`
      : `未连接外部 AI，当前使用离线规则（本地指令解析、模板分镜、统计拆片）${detail}\n点击打开 AI 设置（支持 API 预设、Claude Code、Codex CLI、Gemini CLI）`,
  };
}

function AIStatus() {
  const ai = useStore((s) => s.aiStatus);
  const openDialog = useStore((s) => s.openDialog);
  const t = useT();
  const locale = useLocale();
  const isEn = locale === 'en-US';
  const d = describeAIForStatusBar(ai, t, isEn);
  return (
    <button type="button" className={'sb-item sb-ai ' + d.kind} title={d.title} onClick={() => openDialog('settings', 'ai')}>
      <span className="sb-dot" />
      <span>{d.label}</span>
    </button>
  );
}

function JobsButton() {
  const jobs = useStore((s) => s.jobs);
  const open = useStore((s) => s.jobsOpen);
  const setJobsOpen = useStore((s) => s.setJobsOpen);
  const t = useT();
  const ref = useRef(null);
  const list = Object.values(jobs || {}).filter(Boolean);
  const running = list.filter(isRunning);
  const failed = list.filter((j) => j.status === 'error').length;
  const avg = running.length ? running.reduce((s, j) => s + (Number.isFinite(j.progress) ? j.progress : 0), 0) / running.length : 0;
  let text = t('status.noJobs');
  if (running.length) text = `${t('status.jobsRunning', { count: running.length })}${avg > 0 ? ` · ${Math.round(avg * 100)}%` : ''}`;
  else if (failed) text = t('status.jobsFailed', { count: failed });
  else if (list.length) text = t('status.jobsDone');
  return (
    <div className="sb-jobs-wrap">
      <button type="button" ref={ref} className={'sb-item sb-jobs' + (open ? ' open' : '') + (running.length ? ' busy' : '') + (failed ? ' failed' : '')} onClick={() => setJobsOpen(!open)} title={t('status.viewJobs')}>
        {running.length ? <span className="spinner sb-spin" /> : <Icon name={failed ? 'alert' : 'clock'} size={12} />}
        <span>{text}</span>
        <Icon name="chevronUp" size={11} />
      </button>
      <JobsTray anchorRef={ref} />
    </div>
  );
}

function LiveWatchStatus() {
  const liveWatch = useStore((s) => s.liveWatch);
  const toast = useStore((s) => s.toast);
  const t = useT();
  const locale = useLocale();
  const isEn = locale === 'en-US';
  const L = (zh, en) => (isEn ? en : zh);
  if (!liveWatch || !liveWatch.active) return null;

  const syncTime = fmtClock(liveWatch.lastSyncAt);
  const agentTag = liveWatch.lastAgent ? (isEn ? ` (${liveWatch.lastAgent})` : `（${liveWatch.lastAgent}）`) : '';
  const tooltipLines = [
    L('Live Watch 实时监听中', t('status.liveWatchActive')),
    liveWatch.filePath
      ? L(`监听路径：${liveWatch.filePath}`, `Watching: ${liveWatch.filePath}`)
      : L('等待工程路径', 'Waiting for project path'),
    syncTime
      ? L(`最近外部 Agent 同步：${syncTime}${agentTag}`, `Last external agent sync: ${syncTime}${agentTag}`)
      : L('尚未收到外部 Agent 同步', 'No external agent sync yet'),
    L(
      '点击复制工程路径，可直接粘贴到 Claude Code / Antigravity / Codex 实时协作',
      'Click to copy project path for live collaboration in Claude Code / Antigravity / Codex',
    ),
  ];

  const handleCopy = async () => {
    if (!liveWatch.filePath) {
      toast(L('当前没有可复制的监听工程路径', 'No watched project path available to copy'), 'warn', 2200, { key: 'live-watch-copy' });
      return;
    }
    const ok = await copyTextToClipboard(liveWatch.filePath);
    if (ok) {
      toast(
        L(
          '已复制工程路径，可直接粘贴到 Claude Code / Antigravity / Codex 实时协作',
          'Project path copied — paste it into Claude Code / Antigravity / Codex for live collaboration',
        ),
        'ok',
        2800,
        { key: 'live-watch-copy' },
      );
    } else {
      toast(
        L('复制工程路径失败，请手动查看提示路径', 'Failed to copy project path — hover to view it manually'),
        'warn',
        2600,
        { key: 'live-watch-copy' },
      );
    }
  };

  return (
    <>
      <style>{`
        @keyframes sb-live-pulse {
          0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(76, 195, 138, 0.55); }
          50% { opacity: 0.72; box-shadow: 0 0 0 3px var(--ok-soft); }
        }
        @media (prefers-reduced-motion: reduce) {
          .sb-live-dot { animation: none !important; }
        }
      `}</style>
      <span className="sb-sep" />
      <button
        type="button"
        className="sb-item sb-live"
        title={tooltipLines.join('\n')}
        onClick={handleCopy}
        style={{
          height: 18,
          padding: '0 7px',
          borderRadius: 999,
          background: 'var(--ok-soft)',
          border: '1px solid var(--ok-line)',
          color: 'var(--ok)',
          fontWeight: 600,
          gap: 5,
        }}
      >
        <span
          className="sb-dot sb-live-dot"
          style={{
            background: 'var(--ok)',
            animation: 'sb-live-pulse 2s ease-in-out infinite',
          }}
        />
        <span>Live Watch</span>
      </button>
    </>
  );
}

function ProjectFacts() {
  const project = useStore((s) => s.project);
  const t = useT();
  const locale = useLocale();
  const isEn = locale === 'en-US';
  const info = useMemo(() => {
    if (!project) return null;
    let dur = 0;
    try { dur = projectDuration(project, layoutVideo(project)) || 0; } catch { dur = 0; }
    const st = project.settings || {};
    return { dur, aspect: st.aspect || '16:9', size: st.width && st.height ? `${st.width}×${st.height}` : '', fps: st.fps || 30, clips: (project.tracks && project.tracks.video && project.tracks.video.length) || 0 };
  }, [project]);
  if (!info) return null;
  const clipText = isEn && info.clips === 1 ? '1 clip' : t('status.clipCount', { count: info.clips });
  return (
    <div className="sb-facts">
      <span className="sb-item static" title={t('status.totalDurationTitle')}><Icon name="clock" size={12} />{t('status.totalDuration', { time: fmtTime(info.dur) })}</span>
      <span className="sb-item static" title={t('status.clipCountTitle')}><Icon name="film" size={12} />{clipText}</span>
      <span className="sb-item static" title={t('status.projectSpecsTitle')}>{info.aspect}{info.size ? ` · ${info.size}` : ''} · {info.fps}fps</span>
    </div>
  );
}

export default function StatusBar() {
  const version = useStore((s) => (s.appInfo && s.appInfo.version) || '');
  return (
    <footer className="statusbar" role="status">
      <AIStatus />
      <span className="sb-sep" />
      <JobsButton />
      <LiveWatchStatus />
      <span className="grow" />
      <ProjectFacts />
      {version && <span className="sb-item static sb-ver">v{version}</span>}
    </footer>
  );
}
