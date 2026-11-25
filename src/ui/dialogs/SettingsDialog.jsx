// 设置：左侧分类导航 + 右侧内容。分类：常规 / 外观 / 素材 / AI 视频和图片 / AI 助手 / 语音识别 / 剪辑 / 导出 / 存储与缓存 / 隐私与联网 / 关于
// 草稿换算、API 预设、服务商列表合并与排查提示为纯函数，放在 settingsDialogUtils.js（有单测）。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import useStore from '../store.js';
import api from '../api.js';
import { setLocale, useLocale, useT } from '../i18n.js';
import { Modal, Button, Field, Select, Segmented, Switch, Spinner, ProgressBar, Chip, Icon, ICON_NAMES } from '../components/ui.jsx';
import { hasConsentLocal, requestConsent } from '../consent.js';
import {
  SUPPORTED_LOCALES, AI_API_PRESETS, CLI_AGENTS, FIELD_LABEL, IMAGE_PROVIDERS, FREE_SOURCES,
  ARK_CONSOLE_URL, ARK_IMAGE_MODEL, ARK_VIDEO_MODEL,
  mergeApiPresets, applyApiPreset, aiModeOf, providerForAiMode, apiRequiresKey, detectActivePreset, aiProviderLabel,
  cliStatusOf, toDraft, validate, toPatch, ovOf, mergeVgProviders, applyArkKey, describeImageSource, arkTroubleshoot,
  stockTestResult, keyReady, providerReady,
} from './settingsDialogUtils.js';

export { cliStatusOf };

// 图标未注册时退回到兜底图标
const iconOr = (name, fallback) => (Array.isArray(ICON_NAMES) && ICON_NAMES.includes(name) ? name : fallback);

const NAV = [
  { value: 'general', labelKey: 'settings.nav.general', icon: 'settings' },
  { value: 'appearance', labelKey: 'settings.nav.appearance', icon: 'palette' },
  { value: 'media', labelKey: 'settings.nav.media', icon: 'film' },
  { value: 'videogen', labelKey: 'settings.nav.videogen', icon: 'sparkles', ai: true },
  { value: 'ai', labelKey: 'settings.nav.ai', icon: 'brain' },
  { value: 'asr', labelKey: 'settings.nav.asr', icon: 'captions' },
  { value: 'editing', labelKey: 'settings.nav.editing', icon: 'scissors' },
  { value: 'export', labelKey: 'settings.nav.export', icon: 'export' },
  { value: 'cache', labelKey: 'settings.nav.cache', icon: 'folder' },
  { value: 'privacy', labelKey: 'settings.nav.privacy', icon: iconOr('shield', 'lock') },
  { value: 'about', labelKey: 'settings.nav.about', icon: 'info' },
];
// 旧入口兼容（initialTab='web'/'storage'），以及其他界面可能用到的叫法
const TAB_ALIAS = {
  web: 'media', storage: 'cache', stock: 'media', pexels: 'media', sources: 'media', network: 'privacy', consent: 'privacy',
  jimeng: 'videogen', ark: 'videogen', seedance: 'videogen', seedream: 'videogen', image: 'videogen', video: 'videogen',
};
// 视频站使用须知的同意项
const CONSENT_KEY = 'videoSites';
// 免 Key 来源各自支持的类型不同，测试时按它支持的类型搜
const FREE_TEST_KIND = { openverse: 'image' };

// 隐私页：哪些功能会联网、连到哪里、发送什么（按代码实际行为如实写，改功能时同步更新）
const NET_USES = [
  {
    key: 'ai',
    icon: 'brain',
    title: 'AI 助手',
    titleEn: 'AI Assistant',
    to: '你配置的在线/本地 API（如 OpenAI、DeepSeek、Claude、Gemini、OpenRouter、火山方舟，或本机离线 Ollama / LM Studio）或按需启用的本机 Agent CLI（Claude Code / Codex CLI / Gemini CLI）',
    toEn: 'Your configured cloud or local API (OpenAI, DeepSeek, Claude, Gemini, OpenRouter, Volcengine Ark, or offline Ollama / LM Studio) or an opt-in local Agent CLI (Claude Code / Codex CLI / Gemini CLI)',
    what: '你的指令，以及完成任务需要的项目文字（分镜、字幕、素材说明）；看画面的功能会附带截图。使用本机 Ollama / LM Studio 时数据不出本机。',
    whatEn: 'Your prompts and only the project text needed for the task (storyboards, captions, asset notes), plus screenshots for vision features. Local Ollama / LM Studio keeps all data on your machine.',
    when: '连接了 AI 并使用 AI 功能时',
    whenEn: 'When AI is connected and you use AI features',
  },
  {
    key: 'videogen',
    icon: 'sparkles',
    title: 'AI 视频和图片',
    titleEn: 'AI Video & Image',
    to: '你选择的图片或视频服务商（如 OpenAI、Runway、Luma、Google Veo、可灵、海螺、火山方舟、fal.ai 等）',
    toEn: 'Your chosen image or video provider (OpenAI, Runway, Luma, Google Veo, Kling, Hailuo, Volcengine Ark, fal.ai, etc.)',
    what: '镜头的画面描述；用参考图生成时还会发送参考图。',
    whatEn: 'Shot visual descriptions, plus reference images when image-guided generation is used.',
    when: '点「生成」时，费用由对应服务商直接收取',
    whenEn: 'When you click Generate; billed directly by the provider',
  },
  {
    key: 'stock',
    icon: 'search',
    title: '免费素材搜索',
    titleEn: 'Free Stock Search',
    to: '维基共享资源、Openverse、互联网档案馆、NASA 影像库；填了 Key 时还有 Pexels、Pixabay',
    toEn: 'Wikimedia Commons, Openverse, Internet Archive, NASA Image Library; plus Pexels and Pixabay if keys are provided',
    what: '只发送搜索关键词，选中后下载素材文件。',
    whatEn: 'Search keywords only; selected media files are downloaded locally.',
    when: '搜索和添加素材时',
    whenEn: 'When searching or adding stock media',
  },
  {
    key: 'videoSites',
    icon: iconOr('globe', 'external'),
    title: '视频站解析',
    titleEn: 'Video Site Parsing',
    to: '你粘贴链接或搜索的视频网站（如 B 站）',
    toEn: 'Video sites you paste links from or search (e.g., YouTube, Bilibili)',
    what: '视频链接或搜索词，由开源工具 yt-dlp 读取公开信息。',
    whatEn: 'Video URLs or search queries fetched as public metadata via open-source yt-dlp.',
    when: '第一次使用前需要阅读并同意使用须知',
    whenEn: 'Requires accepting the terms notice before first use',
  },
  {
    key: 'asr',
    icon: 'captions',
    title: '语音识别',
    titleEn: 'Speech to Text',
    to: '默认在本机识别，不联网',
    toEn: 'Runs locally by default (no network access)',
    what: '只连接了 OpenAI、还没安装本机模型时，会把音频发到 OpenAI 接口转写。',
    whatEn: 'Only when OpenAI is configured and the local model is not installed is audio sent to your OpenAI endpoint for transcription.',
    when: '识别字幕时',
    whenEn: 'When transcribing captions',
  },
  {
    key: 'downloads',
    icon: 'download',
    title: '组件下载',
    titleEn: 'Component Downloads',
    to: 'GitHub（yt-dlp、识别程序）、Hugging Face（识别模型）',
    toEn: 'GitHub (yt-dlp, speech binary) and Hugging Face (speech model)',
    what: '只下载文件，不上传你的内容。',
    whatEn: 'Download-only; none of your files or data are uploaded.',
    when: '点「安装」或「更新」时',
    whenEn: 'When clicking Install or Update',
  },
];

const AI_MODES = [
  {
    value: 'auto',
    title: '自动（API 优先）',
    titleEn: 'Auto (API First)',
    desc: '优先使用已配置的在线或本机 API；未配置时尝试已启用的本机 Agent CLI，均不可用时退回本地规则。',
    descEn: 'Uses your configured cloud or local API first, falls back to an enabled local Agent CLI, and finally to local rules.',
  },
  {
    value: 'api',
    title: '在线与本地 API',
    titleEn: 'Cloud & Local API',
    desc: '支持 OpenAI 兼容接口、Anthropic Claude 原生接口，以及免 Key 的 Ollama / LM Studio 本机模型。',
    descEn: 'Supports OpenAI-compatible APIs, native Anthropic Claude API, and keyless local Ollama / LM Studio models.',
  },
  {
    value: 'cli',
    title: '本地 Agent CLI',
    titleEn: 'Local Agent CLI',
    desc: '平等按需调用本机已登录的 Claude Code、Codex CLI 或 Gemini CLI。',
    descEn: 'Runs your locally signed-in Claude Code, Codex CLI, or Gemini CLI on demand.',
  },
  {
    value: 'local',
    title: '仅本地规则',
    titleEn: 'Local Rules Only',
    desc: '完全离线，不联网调用 AI：中文指令解析、模板分镜、统计拆片仍可用。',
    descEn: 'Completely offline with zero AI network calls: built-in command parsing, template storyboards, and statistical breakdown.',
  },
];

const EXTERNAL_AGENT_SNIPPET = [
  '# CLI（无头编辑 / 导出 / 预览）',
  'node bin/frameflow.mjs --help',
  '# 或：npx frameflow --help',
  '',
  '# Agent Skill（适用于 Claude Code / Antigravity / Codex / Gemini CLI / Cursor）',
  'skills/frameflow/SKILL.md',
  '',
  '# 可选 MCP Server（按需挂载）',
  'node bin/frameflow-mcp.mjs',
].join('\n');

const EXTERNAL_AGENT_SNIPPET_EN = [
  '# CLI (headless edit / export / preview)',
  'node bin/frameflow.mjs --help',
  '# or: npx frameflow --help',
  '',
  '# Agent Skill (for Claude Code / Antigravity / Codex / Gemini CLI / Cursor)',
  'skills/frameflow/SKILL.md',
  '',
  '# Optional MCP Server (mount on demand)',
  'node bin/frameflow-mcp.mjs',
].join('\n');

const FREE_SOURCE_EN = {
  commons: { name: 'Wikimedia Commons', sub: 'Free media repository', kinds: 'Video · Image', license: 'CC0 / Public Domain / CC BY / CC BY-SA' },
  openverse: { name: 'Openverse', sub: 'WordPress open media search', kinds: 'Image · Audio', license: 'CC0 / Public Domain / CC BY & more' },
  archive: { name: 'Internet Archive', sub: 'Non-profit digital archive', kinds: 'Video', license: 'Public Domain / Creative Commons' },
  nasa: { name: 'NASA Image & Video Library', sub: 'NASA public media library', kinds: 'Video · Image', license: 'Public Domain' },
};

const VG_EN = {
  seedance: { label: 'Seedance (Volcengine Ark)', vendor: 'Volcengine Ark / ByteDance', priceHint: '~¥1.5–3.7 / 5s' },
  'jimeng-visual': { label: 'Jimeng AI (Volcengine Visual)', vendor: 'ByteDance', priceHint: 'Billed by Volcengine' },
  kling: { label: 'Kling', vendor: 'Kuaishou', priceHint: '~¥1–3.5 / 5s' },
  minimax: { label: 'Hailuo (MiniMax)', vendor: 'MiniMax', priceHint: '~¥2–3.5 / 6s' },
  runway: { label: 'Runway Gen-4', vendor: 'Runway', priceHint: '~$0.25–0.5 / 5s' },
  veo: { label: 'Google Veo (Gemini)', vendor: 'Google', priceHint: '~$0.15–0.4 / s' },
  sora: { label: 'OpenAI Sora 2', vendor: 'OpenAI', priceHint: '~$0.1 / s' },
  luma: { label: 'Luma Ray 2', vendor: 'Luma AI', priceHint: '~$0.4–1.6 / 5s' },
  fal: { label: 'fal.ai Hub', vendor: 'fal.ai', priceHint: 'Varies by model' },
  mock: { label: 'Demo Mode', vendor: 'Frameflow', priceHint: 'Free · Demo only' },
};

const IMAGE_PROVIDER_EN = {
  auto: 'Auto',
  openai: 'OpenAI-Compatible API',
  ark: 'Volcengine Ark (Seedream)',
};

const VALIDATION_EN = {
  'Base URL 需要以 http:// 或 https:// 开头': 'Base URL must start with http:// or https://',
  '接口地址需要以 http:// 或 https:// 开头': 'Endpoint URL must start with http:// or https://',
  '密钥中间不能有空格或换行，请重新复制完整的一串': 'API keys cannot contain spaces or line breaks — please copy the full key again',
  '最长下载时长需要在 10 到 3600 秒之间': 'Max download duration must be between 10 and 3600 seconds',
  '图片默认时长需在 0.5–60 秒之间': 'Default image duration must be between 0.5 and 60 seconds',
  '转场时长需在 0.1–2 秒之间': 'Transition duration must be between 0.1 and 2 seconds',
};

const STOCK_RESULT_EN = {
  '可以搜到素材': 'Stock results available',
  '没有搜到结果，请检查 Key 是否填对': 'No results found — please verify your API key',
  '没有搜到结果，可能是网络没连上：检查网络或代理后再试': 'No results found — check your network connection or proxy and try again',
};

function localizeVgProvider(p, isEn) {
  if (!isEn || !p) return p;
  const ov = VG_EN[p.id];
  return ov ? { ...p, ...ov } : p;
}

function presetKeyPlaceholder(preset, isEn) {
  if (!preset) return 'sk-…';
  if (!isEn) return preset.keyPlaceholder || 'sk-…';
  if (preset.id === 'ark') return 'Volcengine Ark API Key';
  if (preset.id === 'ollama') return 'No API key needed for local Ollama';
  if (preset.id === 'lmstudio') return 'No API key needed for local LM Studio';
  return preset.keyPlaceholder || 'sk-…';
}

function localizeImageSourceText(imgSrc, { imageProvider, hasArk, hasOpenai, hasOpenaiKey }, isEn) {
  if (!isEn) return imgSrc.text;
  const openaiMissing = hasOpenaiKey && !hasOpenai
    ? 'No image model is set for the OpenAI-compatible API'
    : 'No API key is set for the OpenAI-compatible API';
  if (imageProvider === 'ark') {
    return hasArk
      ? 'Images will be generated with Volcengine Ark (Seedream).'
      : 'No Volcengine Ark API key is configured yet — shots will use placeholder previz. Select "Seedance (Volcengine Ark)" below to add your key.';
  }
  if (imageProvider === 'openai') {
    return hasOpenai
      ? 'Images will be generated with the OpenAI-compatible API in AI Assistant (requires an image-capable model).'
      : `${openaiMissing} — shots will use placeholder previz. Configure it in AI Assistant or choose another provider.`;
  }
  if (hasArk) return 'Volcengine Ark API key configured — images will be generated with Seedream.';
  if (hasOpenai) return 'Images will be generated with the OpenAI-compatible API in AI Assistant.';
  return 'No image generation provider is configured yet — shots will use placeholder previz. Set an OpenAI-compatible image model in AI Assistant or add a Volcengine Ark key below.';
}

function localizeArkSteps(detail, zhSteps, isEn) {
  if (!isEn) return zhSteps;
  const t = String(detail == null ? '' : detail);
  if (!t.trim()) return [];
  const KEY_STEPS = [
    'Your API key may be invalid or incomplete: copy the full key from API Key Management in the console and paste it again.',
    'Make sure you are using a Volcengine Ark API Key, not a Jimeng app password or IAM AccessKey / SecretKey.',
  ];
  const MODEL_STEPS = [
    'The model ID may be incorrect or not yet activated: clear the Image Model and Video Model fields to retry with defaults.',
    'If defaults still fail, confirm Seedream and Seedance are activated under Model Activation in the console.',
    'If using a custom endpoint, enter its ep-... endpoint ID from the console.',
  ];
  if (/尚未填写|未填写|没有填写|NO_KEY/i.test(t)) return ['Paste your Volcengine Ark API key above, then click "Test Connection".'];
  if (/超时|timeout|timed out|fetch failed|网络连接失败|network|ENOTFOUND|ECONN|EAI_AGAIN|连不上|无法连接/i.test(t)) {
    return [
      'Could not reach Volcengine Ark: check your internet connection, or disable/switch your proxy.',
      'Leave "Endpoint URL" blank unless you use a custom proxy.',
    ];
  }
  if (/\b429\b|限流|频繁|rate ?limit|繁忙|暂时不可用|\b5\d\d\b/i.test(t)) {
    return [
      'Provider is temporarily busy or rate-limiting requests: wait a minute or two and retry.',
      'If this persists, check whether your free quota in the Volcengine console is exhausted.',
    ];
  }
  if (/额度|余额|欠费|用量上限|安全体验|quota|balance|overdue|SetLimitExceeded|\b402\b/i.test(t)) {
    return ['Free quota exhausted, spending cap reached, or insufficient balance: top up in the Volcengine console or raise the usage limit under Model Activation.'];
  }
  if (/找不到这个模型|InvalidEndpointOrModel|不支持当前的画面尺寸|\b404\b|NotFound/i.test(t)) return MODEL_STEPS;
  if (/\b401\b|Unauthorized|InvalidApiKey|AuthenticationError|Key 无效|Key 不对|已失效/i.test(t)) return KEY_STEPS;
  if (/未开通|开通管理|ModelNotOpen|not (been )?activated|没有权限|无权限|\b403\b/i.test(t)) {
    return [
      'Model not activated yet: open the Volcengine Ark console and activate Seedream (image) and Seedance (video) under Model Activation.',
      'Verify that the API key belongs to the same account where the models were activated.',
    ];
  }
  if (/无效|api ?key/i.test(t)) return KEY_STEPS;
  if (/模型|model|接入点|endpoint/i.test(t)) return MODEL_STEPS;
  return ['Check three things: (1) the full API key was copied cleanly, (2) Seedream and Seedance are activated in the console, and (3) your account has available quota.'];
}

function localizeStockResult(res, isEn) {
  if (!isEn || !res) return res;
  return {
    ...res,
    detail: res.detail ? (STOCK_RESULT_EN[res.detail] || res.detail) : res.detail,
    error: res.error ? (STOCK_RESULT_EN[res.error] || res.error) : res.error,
  };
}

const openUrl = (url, toast, isEn) => api.call('shell:openExternal', { url }).catch((e) => toast && toast((isEn ? 'Failed to open URL: ' : '打开网页失败：') + e.message, 'error'));

// ---------------------------------------------------------------------------
// 小组件
// ---------------------------------------------------------------------------
function SecretField({ label, hint, placeholder, value, saved, cleared, onChange, onClear, onUndoClear }) {
  const [show, setShow] = useState(false);
  const isEn = useLocale() === 'en-US';
  const L = (zh, en) => (isEn ? en : zh);
  return (
    <Field label={label} hint={hint}>
      <div className="row">
        <input className="input grow mono" type={show ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={value}
          placeholder={saved && !cleared ? L('已保存，留空表示不修改', 'Saved — leave blank to keep current') : (placeholder || L('粘贴密钥', 'Paste key'))} onChange={(e) => onChange(e.target.value)} />
        <Button variant="ghost" icon={show ? 'eyeOff' : 'eye'} title={show ? L('隐藏', 'Hide') : L('显示', 'Show')} onClick={() => setShow(!show)} />
        {saved && !cleared && <Chip kind="ok" dot>{L('已保存', 'Saved')}</Chip>}
        {saved && !cleared && <Button size="sm" variant="ghost" onClick={onClear}>{L('清除', 'Clear')}</Button>}
        {cleared && <Chip kind="warn">{L('保存后清除', 'Will clear on save')}</Chip>}
        {cleared && <Button size="sm" onClick={onUndoClear}>{L('撤销', 'Undo')}</Button>}
      </div>
    </Field>
  );
}

/** 测试结果的一行。brief：不在这一行里带出详情（下面另有完整说明时用） */
function TestResult({ state, waitingText, okText, failText, brief }) {
  const isEn = useLocale() === 'en-US';
  const L = (zh, en) => (isEn ? en : zh);
  if (!state) return null;
  if (state.running) return <span className="st-test running" role="status"><Spinner ai /> {waitingText || L('测试中…', 'Testing…')}</span>;
  const detailText = state.detail && isEn ? (STOCK_RESULT_EN[state.detail] || state.detail) : state.detail;
  return (
    <span className={'st-test ' + (state.ok ? 'ok' : 'bad')} title={brief ? undefined : detailText} role="status">
      <Icon name={state.ok ? 'check' : 'close'} size={14} stroke={2.2} />
      {state.ok ? (okText || L('连接成功', 'Connected')) : (failText || L('连接失败', 'Connection failed'))}
      {Number.isFinite(state.ms) && state.ms > 0 && <span className="mono">{(state.ms / 1000).toFixed(1)}{L(' 秒', 's')}</span>}
      {!brief && detailText && <span className="st-test-detail ellipsis">{detailText}</span>}
    </span>
  );
}

/** 测试失败后的完整说明：原始报错（可选中复制）+ 下一步怎么办 */
function FailHelp({ detail, steps }) {
  const isEn = useLocale() === 'en-US';
  const L = (zh, en) => (isEn ? en : zh);
  const list = Array.isArray(steps) ? steps : [];
  if (!detail && !list.length) return null;
  return (
    <div className="callout warn sx-fix" role="alert">
      {detail && <div className="sx-fix-detail selectable">{detail}</div>}
      {list.length > 0 && (
        <>
          <b>{L('可以这样处理', 'How to fix')}</b>
          <ul>{list.map((s) => <li key={s}>{s}</li>)}</ul>
        </>
      )}
    </div>
  );
}

/** 行内文字链接（打开外部网页）：能用键盘聚焦，回车打开 */
function TextLink({ onClick, children }) {
  return <a role="link" tabIndex={0} onClick={onClick} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onClick(); } }}>{children}</a>;
}

function StatusLine({ label, value, mono }) {
  return (
    <div className="st-kv">
      <span className="st-k">{label}</span>
      <span className={'st-v selectable ellipsis' + (mono ? ' mono' : '')} title={typeof value === 'string' ? value : undefined}>{value}</span>
    </div>
  );
}

function Row({ title, desc, children }) {
  return (
    <div className="sx-row">
      <div className="sx-row-text"><b>{title}</b>{desc && <span>{desc}</span>}</div>
      <div className="sx-row-ctl">{children}</div>
    </div>
  );
}

function PaneHead({ icon, title, desc }) {
  return (
    <header className="sx-head">
      <span className="sx-head-icon"><Icon name={icon} size={20} /></span>
      <div><h3>{title}</h3>{desc && <p>{desc}</p>}</div>
    </header>
  );
}

// 局部样式（设置对话框专用；颜色全部取自设计令牌）
const STYLE = `
.sx-modal.modal{width:min(1040px,94vw);max-width:none;height:min(720px,90vh);display:flex;flex-direction:column}
.sx-modal .modal-body{padding:0;flex:1;min-height:0;overflow:hidden}
.sx-layout{display:grid;grid-template-columns:208px 1fr;height:100%;min-height:0}
.sx-nav{border-right:1px solid var(--line,#2a2d33);padding:12px 8px;display:flex;flex-direction:column;gap:2px;overflow:auto;background:var(--bg-1,#15171a)}
.sx-nav button{all:unset;cursor:pointer;display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:var(--radius-sm,8px);color:var(--text-1,#c9ccd1);font-size:var(--fs-13,13px)}
.sx-nav button:hover{background:var(--bg-2,#1d2024);color:var(--text-0,#fff)}
.sx-nav button.active{background:var(--bg-3,#262a2f);color:var(--text-0,#fff);box-shadow:inset 2px 0 0 var(--accent,#c8e250)}
.sx-nav button.ai svg{color:var(--ai,#9d8cff)}
.sx-nav .sx-nav-dot{margin-left:auto;width:6px;height:6px;border-radius:50%;background:var(--ok,#5bd18b)}
.sx-nav-sep{height:1px;background:var(--line,#2a2d33);margin:8px 6px}
.sx-pane{overflow:auto;padding:24px 32px 32px;min-height:0}
.sx-head{display:flex;gap:12px;align-items:flex-start;margin-bottom:20px}
.sx-head h3{margin:0;font-size:var(--fs-18,18px);font-weight:600;color:var(--text-0,#fff)}
.sx-head p{margin:4px 0 0;color:var(--text-2,#8b9098);font-size:var(--fs-13,13px);line-height:1.6}
.sx-head-icon{width:36px;height:36px;border-radius:var(--radius-md,12px);display:grid;place-items:center;background:var(--bg-2,#1d2024);color:var(--accent,#c8e250);flex:none}
.sx-card{border:1px solid var(--line,#2a2d33);border-radius:var(--radius-md,12px);background:var(--bg-1,#15171a);padding:16px 20px;margin-bottom:16px}
.sx-card>h4{margin:0 0 12px;font-size:var(--fs-13,13px);font-weight:600;color:var(--text-0,#fff);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sx-row{display:flex;align-items:center;gap:16px;padding:12px 0;border-top:1px solid var(--line,#2a2d33)}
.sx-card>.sx-row:first-of-type,.sx-card>h4+.sx-row{border-top:0;padding-top:4px}
.sx-row-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.sx-row-text b{font-weight:500;font-size:var(--fs-13,13px);color:var(--text-0,#fff)}
.sx-row-text span{font-size:var(--fs-12,12px);color:var(--text-2,#8b9098);line-height:1.5}
.sx-row-ctl{flex:none;display:flex;align-items:center;gap:8px}
.sx-row-ctl .input{width:120px}
.sx-providers{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px;margin-bottom:16px}
.sx-prov{all:unset;cursor:pointer;border:1px solid var(--line,#2a2d33);border-radius:var(--radius-md,12px);padding:12px 14px;background:var(--bg-1,#15171a);display:flex;flex-direction:column;gap:6px;position:relative;transition:border-color .15s,background .15s}
.sx-prov:hover{border-color:var(--line-strong,#3a3e45)}
.sx-prov.active{border-color:var(--ai,#9d8cff);background:color-mix(in srgb,var(--ai,#9d8cff) 10%,var(--bg-1,#15171a))}
.sx-prov-top{display:flex;align-items:center;gap:8px;padding-right:64px}
.sx-prov-radio{width:14px;height:14px;border-radius:50%;border:1.5px solid var(--text-3,#5b6068);flex:none}
.sx-prov.active .sx-prov-radio{border-color:var(--ai,#9d8cff);box-shadow:inset 0 0 0 3px var(--bg-1,#15171a);background:var(--ai,#9d8cff)}
.sx-prov b{font-size:var(--fs-13,13px);font-weight:600;color:var(--text-0,#fff)}
.sx-prov small{font-size:var(--fs-11,11px);color:var(--text-2,#8b9098)}
.sx-prov .sx-prov-status{position:absolute;top:12px;right:12px}
.sx-presets{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
.sx-preset{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:6px 11px;border-radius:var(--radius-sm,8px);border:1px solid var(--line,#2a2d33);background:var(--bg-2,#1d2024);color:var(--text-1,#c9ccd1);font-size:var(--fs-12,12px);font-weight:500;transition:border-color .15s,background .15s,color .15s}
.sx-preset:hover{border-color:var(--line-strong,#3a3e45);color:var(--text-0,#fff)}
.sx-preset.active{border-color:var(--ai,#9d8cff);background:color-mix(in srgb,var(--ai,#9d8cff) 14%,var(--bg-2,#1d2024));color:var(--text-0,#fff)}
.sx-preset:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.sx-preset-tag{font-size:10px;padding:1px 5px;border-radius:999px;background:var(--bg-3,#262a2f);color:var(--text-2,#8b9098)}
.sx-codeblock{margin:10px 0 0;padding:10px 12px;border-radius:var(--radius-s,8px);border:1px solid var(--line,#2a2d33);background:var(--bg-0,#0f1114);color:var(--text-1,#c9ccd1);font-size:var(--fs-12,12px);line-height:1.6;overflow:auto;white-space:pre-wrap;word-break:break-word}
.sx-price{font-size:var(--fs-12,12px);color:var(--text-1,#c9ccd1)}
.sx-note{font-size:var(--fs-12,12px);color:var(--text-2,#8b9098);line-height:1.6;margin:8px 0 0}
.sx-note a{color:var(--accent,#c8e250);cursor:pointer}
.sx-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:12px}
.sx-grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.sx-grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.sx-about{display:flex;gap:16px;align-items:center}
.sx-logo{width:56px;height:56px;border-radius:16px;background:linear-gradient(135deg,var(--accent,#c8e250),var(--ai,#9d8cff));display:grid;place-items:center;color:var(--accent-ink);font-weight:700;font-size:22px}
.sx-badge{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:999px;font-size:var(--fs-11,11px);background:var(--bg-2,#1d2024);color:var(--text-1,#c9ccd1)}
.sx-nav button:focus-visible,.sx-prov:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.sx-guide{display:flex;gap:10px;align-items:flex-start;margin-bottom:16px}
.sx-guide>.icon{flex:none;margin-top:2px;color:var(--ai)}
.sx-guide b{color:var(--text-0);font-weight:600}
.sx-guide .sx-actions{margin-top:8px}
.sx-net{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.sx-net li{display:grid;grid-template-columns:32px minmax(0,1fr);gap:12px;padding:12px 0;border-top:1px solid var(--line)}
.sx-net li:first-child{border-top:0;padding-top:2px}
.sx-net-ico{width:32px;height:32px;border-radius:var(--radius-s);display:grid;place-items:center;background:var(--bg-2);color:var(--text-1)}
.sx-net-title{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;color:var(--text-0);font-size:var(--fs-13);font-weight:600}
.sx-net-when{color:var(--text-2);font-size:var(--fs-11);font-weight:400}
.sx-net-kv{display:grid;grid-template-columns:minmax(56px,max-content) minmax(0,1fr);gap:2px 10px;margin-top:4px;font-size:var(--fs-12);line-height:1.55}
.sx-net-kv dt{color:var(--text-2)}
.sx-net-kv dd{margin:0;color:var(--text-1)}
.sx-consent{display:flex;align-items:center;gap:12px}
.sx-links{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.sx-note a{text-decoration:underline;text-underline-offset:2px;border-radius:var(--radius-xs)}
.sx-note a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.sx-card>h4 .sx-h4-side{margin-left:auto;font-weight:400;font-size:var(--fs-12);color:var(--text-2)}
.sx-sub{margin:24px 0 4px;font-size:var(--fs-13);font-weight:600;color:var(--text-0)}
.sx-sub+.sx-note{margin:0 0 12px}
.sx-src{list-style:none;margin:0;padding:0}
.sx-src li{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,.7fr) minmax(0,1.4fr) auto;gap:12px;align-items:center;min-height:40px;padding:6px 0;border-top:1px solid var(--line);font-size:var(--fs-12);color:var(--text-1)}
.sx-src li:first-child{border-top:0}
.sx-src-name{display:flex;flex-direction:column;gap:2px;min-width:0}
.sx-src-name b{font-size:var(--fs-13);font-weight:500;color:var(--text-0)}
.sx-src-name small{font-size:var(--fs-11);color:var(--text-2)}
.sx-src-state{min-width:64px;display:flex;justify-content:flex-end}
.sx-tips{margin:12px 0 0;padding:0 0 0 18px;font-size:var(--fs-12);line-height:1.7;color:var(--text-2)}
.sx-tips b{color:var(--text-1);font-weight:500}
.sx-fix{margin-top:12px}
.sx-fix b{display:block;color:var(--text-0);font-weight:600}
.sx-fix ul{margin:4px 0 0;padding-left:18px}
.sx-fix-detail{color:var(--text-0);overflow-wrap:anywhere}
.sx-fix-detail+b{margin-top:8px}
.sx-imgtest{display:flex;align-items:flex-start;gap:12px;margin-top:8px;flex-wrap:wrap}
.sx-imgtest .sx-fix{flex:1 1 100%;margin-top:0}
.sx-thumb{width:160px;aspect-ratio:16/9;object-fit:cover;border-radius:var(--radius-s);border:1px solid var(--line);background:var(--bg-2)}
.sx-keys{display:flex;flex-direction:column;gap:4px}
.sx-keys .sx-actions{margin:0 0 12px}
`;

// ---------------------------------------------------------------------------
// 主对话框
// ---------------------------------------------------------------------------
export default function SettingsDialog({ onClose, initialTab }) {
  const settings = useStore((s) => s.settings);
  const appInfo = useStore((s) => s.appInfo);
  const aiStatus = useStore((s) => s.aiStatus);
  const settingsDialog = useStore((s) => s.dialogs && s.dialogs.settings);
  const toast = useStore((s) => s.toast);
  const t = useT();
  const rawLocale = useLocale();
  const activeLocale = typeof rawLocale === 'string'
    ? rawLocale
    : (rawLocale && typeof rawLocale.locale === 'string' ? rawLocale.locale : 'zh-CN');
  const isEn = activeLocale === 'en-US';
  const L = (zh, en) => (isEn ? en : zh);

  const resolveTab = (v) => {
    if (typeof v !== 'string' || !v) return null;
    const mapped = TAB_ALIAS[v] || v;
    return NAV.some((n) => n.value === mapped) ? mapped : null;
  };
  const requestedTab = initialTab || (typeof settingsDialog === 'string' ? settingsDialog : undefined);
  const [tab, setTab] = useState(() => resolveTab(requestedTab) || 'general');
  useEffect(() => {
    const next = resolveTab(requestedTab);
    if (next) setTab(next);
  }, [requestedTab]);
  const [draft, setDraft] = useState(() => toDraft(settings));
  const [baseline, setBaseline] = useState(() => JSON.stringify(toDraft(settings)));
  const [clear, setClear] = useState({});
  const [saving, setSaving] = useState(false);
  const [tests, setTests] = useState({});
  const [ytdlp, setYtdlp] = useState(null);
  const [ytInstall, setYtInstall] = useState(null);
  const [vgList, setVgList] = useState(null);
  const [remotePresets, setRemotePresets] = useState(null);
  const [probedAiStatus, setProbedAiStatus] = useState(null);
  const [asr, setAsr] = useState(null);
  const [asrInstall, setAsrInstall] = useState(null);
  const [freeTest, setFreeTest] = useState(null);
  const [consentBusy, setConsentBusy] = useState(false);
  const [copiedAgent, setCopiedAgent] = useState(false);
  const mounted = useRef(true);
  const copyTimer = useRef(null);

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const setOv = (id, patch) => setDraft((d) => ({ ...d, vgOverrides: { ...d.vgOverrides, [id]: { ...ovOf(d, id), ...patch } } }));
  const dirty = useMemo(() => JSON.stringify(draft) !== baseline || Object.values(clear).some(Boolean), [draft, baseline, clear]);

  const loadVg = () => (api.videogen ? api.videogen.providers() : api.call('videogen:providers'))
    .then((l) => { if (mounted.current && Array.isArray(l)) setVgList(l); }).catch(() => { if (mounted.current) setVgList([]); });
  const loadAsr = () => (api.asr ? api.asr.status() : api.call('asr:status'))
    .then((s) => { if (mounted.current) setAsr(s || { ready: false }); }).catch((e) => { if (mounted.current) setAsr({ ready: false, unavailable: true, error: e.message }); });

  useEffect(() => {
    mounted.current = true;
    if (!settings) {
      api.call('settings:get').then((s) => {
        if (!mounted.current || !s) return;
        useStore.setState({ settings: s });
        setDraft(toDraft(s)); setBaseline(JSON.stringify(toDraft(s)));
      }).catch(() => {});
    }
    api.call('web:ytdlpStatus').then((s) => { if (mounted.current) setYtdlp(s); }).catch(() => { if (mounted.current) setYtdlp({ installed: false, path: '', version: '' }); });
    api.call('ai:presets').then((r) => { if (mounted.current && r) setRemotePresets(r); }).catch(() => {});
    loadVg();
    loadAsr();
    return () => {
      mounted.current = false;
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab !== 'ai') return undefined;
    let active = true;
    api.call('ai:status', { probeClis: true })
      .then((res) => {
        if (!active || !mounted.current || !res || typeof res !== 'object') return;
        setProbedAiStatus(res);
        useStore.setState({ aiStatus: res });
      })
      .catch(() => {});
    return () => { active = false; };
  }, [tab]);

  const refreshAppInfo = async () => { try { useStore.setState({ appInfo: await api.call('app:info') }); } catch { /* 保留旧值 */ } };

  const persist = async () => {
    const bad = validate(draft);
    if (bad) {
      setTab(bad.tab);
      toast(isEn ? (VALIDATION_EN[bad.message] || bad.message) : bad.message, 'warn');
      return null;
    }
    const prevRoot = (settings && settings.dataRoot) || '';
    const patch = toPatch(draft, clear);
    const next = await api.call('settings:set', patch);
    setLocale(patch.ui.locale);
    const st = useStore.getState();
    if (st.refreshSettings) await st.refreshSettings();
    if (tab === 'ai') {
      try {
        const probed = await api.call('ai:status', { probeClis: true, refresh: true });
        if (mounted.current && probed && typeof probed === 'object') {
          setProbedAiStatus(probed);
          useStore.setState({ aiStatus: probed });
        }
      } catch {
        if (st.refreshAI) await st.refreshAI();
      }
    } else {
      if (mounted.current) setProbedAiStatus(null);
      if (st.refreshAI) await st.refreshAI();
    }
    await refreshAppInfo();
    if (patch.dataRoot !== prevRoot && st.refreshProjects) await st.refreshProjects();
    loadVg();
    if (mounted.current) {
      const nd = toDraft(next || useStore.getState().settings);
      setDraft(nd); setBaseline(JSON.stringify(nd)); setClear({});
    }
    return next || true;
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const r = await persist();
      if (r) { toast(t('settings.saved'), 'ok'); if (onClose) onClose(); }
    } catch (e) { toast(t('settings.saveFailed', { error: e.message }), 'error'); } finally { if (mounted.current) setSaving(false); }
  };

  /** 先保存再测试，确保测的就是界面上填写的内容 */
  const runTest = async (key, fn) => {
    setTests((ts) => ({ ...ts, [key]: { running: true } }));
    try {
      const saved = await persist();
      if (!saved) { if (mounted.current) setTests((ts) => ({ ...ts, [key]: null })); return; }
      const t0 = Date.now();
      const r = await fn();
      if (mounted.current) setTests((ts) => ({ ...ts, [key]: { ok: !!(r && r.ok), ms: (r && r.ms) || Date.now() - t0, detail: (r && (r.detail || r.error)) || '', path: (r && r.path) || '' } }));
    } catch (e) {
      if (mounted.current) setTests((ts) => ({ ...ts, [key]: { ok: false, detail: (e && e.message) || String(e) } }));
    }
  };
  const testing = (key) => !!(tests[key] && tests[key].running);
  const testAi = (provider) => runTest('ai:' + provider, () => api.call('ai:test', { provider }));
  const testVg = (provider) => runTest('vg:' + provider, () => (api.videogen ? api.videogen.test(provider) : api.call('videogen:test', { provider })));
  const testStock = (source) => runTest('stock:' + source, async () => stockTestResult(
    await api.call('web:search', { query: 'ocean', kind: 'video', sources: [source], limit: 1 }), source,
  ));
  /** 试生成一张火山方舟 Seedream 图片（会消耗一张图额度），用于确认模型已开通 */
  const testArkImage = () => runTest('img:ark', async () => {
    try {
      return await api.call('ai:imageTest', { provider: 'ark' });
    } catch (e) {
      if (/No handler registered|未知的通道|unknown channel/i.test((e && e.message) || '')) {
        return {
          ok: false,
          error: L(
            '这个版本还不支持在这里试生成，请到创作模式里点「生成画面」试试。',
            'Test image generation is not supported in this build — try "Generate Visuals" in Create mode.',
          ),
        };
      }
      throw e;
    }
  });
  /** 免 Key 来源逐个搜一下（不改设置，所以不用先保存） */
  const testFree = async () => {
    if (freeTest && freeTest.running) return;
    setFreeTest({ running: true });
    const one = async (s) => {
      try {
        const r = await api.call('web:search', { query: 'ocean', kind: FREE_TEST_KIND[s.id] || 'video', sources: [s.id], limit: 1 });
        return [s.id, stockTestResult(r, s.id, { needsKey: false })];
      } catch (e) {
        return [s.id, { ok: false, error: (e && e.message) || String(e) }];
      }
    };
    const entries = await Promise.all(FREE_SOURCES.map(one));
    if (mounted.current) setFreeTest({ results: Object.fromEntries(entries) });
  };
  /** 提前阅读并同意视频站使用须知（同意后设置会刷新，状态跟着变） */
  const readConsent = async () => {
    if (consentBusy) return;
    setConsentBusy(true);
    try {
      await requestConsent(CONSENT_KEY);
    } catch (e) {
      toast(L('没能打开使用须知：', 'Failed to open terms notice: ') + ((e && e.message) || L('未知原因', 'Unknown error')), 'error');
    } finally {
      if (mounted.current) setConsentBusy(false);
    }
  };
  /** 撤回视频站使用须知的同意（优先走 web:consent，兼容 consent:revoke / settings:set） */
  const revokeConsentAction = async () => {
    if (consentBusy) return;
    setConsentBusy(true);
    try {
      const channels = [
        ['web:consent', { key: CONSENT_KEY, action: 'revoke', granted: false, revoke: true }],
        ['consent:revoke', { key: CONSENT_KEY }],
        ['settings:set', { consent: { [CONSENT_KEY]: { version: 0, at: new Date().toISOString() } } }],
      ];
      let done = false;
      for (const [ch, payload] of channels) {
        try {
          await api.call(ch, payload);
          done = true;
          break;
        } catch (e) {
          if (!/No handler registered|未知的通道|unknown channel/i.test((e && e.message) || '')) throw e;
        }
      }
      if (done) {
        await useStore.getState().refreshSettings?.();
        if (hasConsentLocal(CONSENT_KEY)) {
          toast(L('当前版本暂不支持在此撤回同意状态', 'Revoking consent from Settings is not supported in this build'), 'warn');
        } else {
          toast(L('已撤回视频站使用须知同意，下次使用时将重新确认', 'Video site consent revoked — you will be asked again next time'), 'ok');
        }
      }
    } catch (e) {
      toast(L('撤回同意失败：', 'Failed to revoke consent: ') + ((e && e.message) || L('未知原因', 'Unknown error')), 'error');
    } finally {
      if (mounted.current) setConsentBusy(false);
    }
  };

  const installYtdlp = async () => {
    if (ytInstall) return;
    const isUpdate = !!(ytdlp && ytdlp.installed);
    setYtInstall({ progress: 0, message: L('正在连接…', 'Connecting…') });
    try {
      const status = await useStore.getState().trackJob(
        'web:ytdlpInstall',
        { latest: isUpdate },
        isUpdate ? L('更新 yt-dlp', 'Update yt-dlp') : L('安装 yt-dlp', 'Install yt-dlp'),
        (p) => {
          if (mounted.current) setYtInstall({ progress: p.progress || 0, message: p.message || p.stage || L('正在下载…', 'Downloading…') });
        },
      );
      if (mounted.current && status) setYtdlp(status);
      toast(isUpdate ? L('yt-dlp 更新完成', 'yt-dlp updated') : L('yt-dlp 安装完成', 'yt-dlp installed'), 'ok');
      await refreshAppInfo();
    } catch (e) { if (!e.cancelled) toast(L('安装 yt-dlp 失败：', 'Failed to install yt-dlp: ') + e.message, 'error'); } finally { if (mounted.current) setYtInstall(null); }
  };

  const installAsr = async () => {
    if (asrInstall) return;
    setAsrInstall({ progress: 0, message: L('正在连接…', 'Connecting…') });
    try {
      const onP = (p) => { if (mounted.current) setAsrInstall({ progress: p.progress || 0, message: p.message || p.stage || L('正在下载模型…', 'Downloading model…') }); };
      const st = useStore.getState();
      if (st.trackJob) await st.trackJob('asr:installModel', {}, L('安装语音识别模型', 'Install speech recognition model'), onP);
      else await api.asr.installModel(onP);
      toast(L('语音识别模型安装完成', 'Speech recognition model installed'), 'ok');
      loadAsr();
    } catch (e) { if (!e.cancelled) toast(L('安装失败：', 'Installation failed: ') + e.message, 'error'); } finally { if (mounted.current) setAsrInstall(null); }
  };

  const pickFolder = async (field) => {
    try { const dir = await api.call('dialog:openFolder'); if (dir) set({ [field]: dir }); } catch (e) { toast(L('选择文件夹失败：', 'Failed to choose folder: ') + e.message, 'error'); }
  };
  const openPath = (p) => { if (p) api.call('shell:openPath', { path: p }).catch((e) => toast(L('打开目录失败：', 'Failed to open folder: ') + e.message, 'error')); };

  const agentSnippet = isEn ? EXTERNAL_AGENT_SNIPPET_EN : EXTERNAL_AGENT_SNIPPET;

  const copyAgentSnippet = async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(agentSnippet);
      } else {
        throw new Error('clipboard unavailable');
      }
      setCopiedAgent(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => { if (mounted.current) setCopiedAgent(false); }, 2000);
      toast(L('已复制外部 Agent 接入命令', 'External agent setup commands copied'), 'ok');
    } catch {
      toast(L('无法自动复制，请直接选中上方命令手动复制', 'Auto-copy unavailable — please select and copy the commands above manually'), 'warn');
    }
  };

  const currentRoot = (appInfo && appInfo.dataRoot) || '';
  const has = (k) => !!(settings && settings['has' + k[0].toUpperCase() + k.slice(1)]);
  const hasVg = (k) => !!(settings && settings.videogen && settings.videogen.hasKeys && settings.videogen.hasKeys[k]);
  const rootChanged = (draft.dataRoot || '') !== ((settings && settings.dataRoot) || '');
  const savedLocale = (settings && settings.ui && settings.ui.locale) || 'zh-CN';

  const secretProps = (k, saved) => ({
    value: draft[k], saved, cleared: !!clear[k],
    onChange: (v) => set({ [k]: v }),
    onClear: () => setClear((c) => ({ ...c, [k]: true })),
    onUndoClear: () => setClear((c) => ({ ...c, [k]: false })),
  });

  // API 预设与本地 Agent CLI 状态
  const effectiveAiStatus = useMemo(() => {
    if (!probedAiStatus) return aiStatus;
    if (!aiStatus) return probedAiStatus;
    return {
      ...probedAiStatus,
      ...aiStatus,
      clis: probedAiStatus.clis || aiStatus.clis,
    };
  }, [aiStatus, probedAiStatus]);
  const apiPresets = useMemo(() => mergeApiPresets(remotePresets), [remotePresets]);
  const activePresetId = detectActivePreset(draft, apiPresets);
  const activePreset = apiPresets.find((p) => p.id === activePresetId) || null;
  const needsApiKey = apiRequiresKey(draft, apiPresets);
  const aiMode = aiModeOf(draft.provider);
  const activeCli = CLI_AGENTS.find((a) => a.id === draft.cliAgent) || CLI_AGENTS[0];
  const cliInfo = cliStatusOf(activeCli.id, effectiveAiStatus, probedAiStatus && probedAiStatus.clis ? null : appInfo);
  const cliFound = !!(cliInfo && (cliInfo.ok || cliInfo.installed || cliInfo.available || cliInfo.path));
  const cliLoggedIn = !!(cliInfo && (cliInfo.loggedIn ?? cliInfo.authenticated ?? cliInfo.ready ?? cliFound));
  const apiTestProvider = draft.apiProtocol === 'anthropic' ? 'anthropic' : 'openai';
  const apiTestState = tests['ai:' + apiTestProvider];
  const cliTestState = tests['ai:' + activeCli.id];

  const apiConfigured = !!(
    (effectiveAiStatus && effectiveAiStatus.api && effectiveAiStatus.api.configured)
    || (effectiveAiStatus && effectiveAiStatus.openai && effectiveAiStatus.openai.configured)
    || (effectiveAiStatus && effectiveAiStatus.anthropic && effectiveAiStatus.anthropic.configured)
    || (effectiveAiStatus && effectiveAiStatus.ready && (effectiveAiStatus.provider === 'api' || effectiveAiStatus.provider === 'openai' || effectiveAiStatus.provider === 'anthropic'))
  );

  // 视频与图片服务商
  const vgProviders = useMemo(() => mergeVgProviders(vgList), [vgList]);
  const vgCur = vgProviders.find((p) => p.id === draft.vgProvider) || vgProviders[vgProviders.length - 1];
  const vgCurDisp = localizeVgProvider(vgCur, isEn);
  const vgReady = (p) => providerReady(p, { draft, clear, hasKey: hasVg });
  const vgConfigured = vgProviders.some(vgReady);

  const arkReady = keyReady(draft, clear, 'arkKey', hasVg('arkKey'));
  const arkVideoModel = (vgProviders.find((p) => p.id === 'seedance') || {}).defaultModel || ARK_VIDEO_MODEL;
  const arkTest = tests['vg:seedance'];
  const arkImgTest = tests['img:ark'];
  const openaiKeyReady = keyReady(draft, clear, 'openaiKey', has('openaiKey'));
  const openaiImageReady = openaiKeyReady && !!draft.openaiBaseUrl.trim() && !!draft.openaiImageModel.trim();
  const imgSrcCtx = {
    imageProvider: draft.imageProvider,
    hasArk: arkReady,
    hasOpenai: openaiImageReady,
    hasOpenaiKey: openaiKeyReady,
  };
  const imgSrc = describeImageSource(imgSrcCtx);
  const imgSrcText = localizeImageSourceText(imgSrc, imgSrcCtx, isEn);
  const imageProviderOptions = useMemo(
    () => IMAGE_PROVIDERS.map((p) => ({ value: p.value, label: isEn ? (IMAGE_PROVIDER_EN[p.value] || p.label) : p.label })),
    [isEn],
  );
  const freeFailed = !!(freeTest && freeTest.results && Object.values(freeTest.results).some((r) => !r.ok));

  // AI 是否已连上（任意在线/本地 API 或任意本机 Agent CLI）
  const aiConnected = !!(effectiveAiStatus && effectiveAiStatus.ready && effectiveAiStatus.provider && effectiveAiStatus.provider !== 'local' && effectiveAiStatus.provider !== 'none');
  // 语音识别走哪条路：本机 whisper 不上传；只有 OpenAI Key 时在线转写，会上传音频（如实告知）
  const asrEngine = asr && asr.ready ? asr.engine : null;
  const asrPrivacy = asrEngine === 'whisper'
    ? L('识别在本机完成，不上传音频。', 'Transcription runs locally on your machine—no audio is uploaded.')
    : asrEngine === 'openai'
      ? L(
          '现在用的是 OpenAI 在线识别，音频会上传到你填写的 OpenAI 接口。安装本机模型后改为离线识别，不再上传。',
          'Currently using OpenAI online transcription (audio is sent to your configured OpenAI endpoint). Install the local model to transcribe offline.',
        )
      : L('安装本机模型后，识别在本机完成，不上传音频。', 'Once the local model is installed, transcription runs fully offline.');
  const asrEngineLabel = asrEngine === 'whisper'
    ? L('本机识别（whisper.cpp）', 'Local (whisper.cpp)')
    : asrEngine === 'openai'
      ? L('OpenAI 在线识别', 'OpenAI Online')
      : (asr && asr.engine) || '—';
  // 视频站使用须知：以设置里记录的同意时间为准
  const consentRec = settings && settings.consent && settings.consent[CONSENT_KEY];
  const consentOk = hasConsentLocal(CONSENT_KEY);
  const consentAt = consentRec && consentRec.at ? new Date(consentRec.at) : null;
  const consentDate = consentAt && !Number.isNaN(consentAt.getTime())
    ? (isEn
        ? `${consentAt.getFullYear()}-${String(consentAt.getMonth() + 1).padStart(2, '0')}-${String(consentAt.getDate()).padStart(2, '0')}`
        : `${consentAt.getFullYear()}年${consentAt.getMonth() + 1}月${consentAt.getDate()}日`)
    : '';
  const licensesPath = (appInfo && appInfo.licensesPath) || '';
  const privacyPath = (appInfo && appInfo.privacyPath) || '';

  const discardAndClose = () => {
    if (draft.locale !== savedLocale) setLocale(savedLocale);
    if (onClose) onClose();
  };

  const requestClose = () => {
    if (saving) return;
    if (dirty) { toast(t('settings.unsavedWarning'), 'warn'); return; }
    discardAndClose();
  };

  return (
    <Modal title={t('settings.title')} onClose={requestClose} wide className="st-modal sx-modal"
      footer={(
        <>
          <span className="grow hint">{dirty ? t('settings.dirtyHint') : t('settings.cleanHint')}</span>
          <Button onClick={discardAndClose} disabled={saving}>{dirty ? t('settings.discard') : t('app.close')}</Button>
          <Button variant="primary" onClick={save} disabled={saving || !dirty}>{saving ? <><Spinner /> {t('app.saving')}</> : t('app.save')}</Button>
        </>
      )}
    >
      <style>{STYLE}</style>
      <div className="sx-layout">
        <nav className="sx-nav" aria-label={t('settings.navAria')}>
          {NAV.map((n, i) => (
            <React.Fragment key={n.value}>
              {(i === 3 || i === 6 || i === 8) && <div className="sx-nav-sep" />}
              <button type="button" data-tab={n.value} className={(tab === n.value ? 'active ' : '') + (n.ai ? 'ai' : '')} onClick={() => setTab(n.value)}>
                <Icon name={n.icon} size={16} />
                {t(n.labelKey)}
                {n.value === 'videogen' && vgConfigured && <span className="sx-nav-dot" title={L('已填写密钥', 'API key configured')} />}
              </button>
            </React.Fragment>
          ))}
        </nav>

        <div className="sx-pane" data-pane={tab}>
          {tab === 'general' && (
            <>
              <PaneHead icon="settings" title={t('settings.general.title')} desc={t('settings.general.desc')} />
              <div className="sx-card">
                <Row title={t('settings.general.autosave')} desc={t('settings.general.autosaveDesc')}><Switch checked={draft.autosave} onChange={(v) => set({ autosave: v })} /></Row>
                <Row title={t('settings.general.openLast')} desc={t('settings.general.openLastDesc')}><Switch checked={draft.openLastProject} onChange={(v) => set({ openLastProject: v })} /></Row>
              </div>
            </>
          )}

          {tab === 'appearance' && (
            <>
              <PaneHead icon="palette" title={t('settings.appearance.title')} desc={L('切换界面语言与缩放比例，适配不同语言习惯与屏幕分辨率。', t('settings.appearance.desc'))} />
              <div className="sx-card">
                <Row title={L('界面语言 / Interface Language', 'Interface Language')} desc={L('立即生效，保存后持久化到本地设置。', 'Takes effect immediately; click Save to persist across launches.')}>
                  <Segmented
                    value={draft.locale}
                    onChange={(v) => { set({ locale: v }); setLocale(v); }}
                    options={SUPPORTED_LOCALES}
                    label={L('界面语言 / Interface Language', 'Interface Language')}
                  />
                </Row>
                <Row title={t('settings.appearance.scale')} desc={t('settings.appearance.scaleDesc')}>
                  <Segmented value={draft.uiScale} onChange={(v) => set({ uiScale: v })} options={[{ value: 0.9, label: '90%' }, { value: 1, label: '100%' }, { value: 1.1, label: '110%' }, { value: 1.25, label: '125%' }]} />
                </Row>
              </div>
            </>
          )}

          {tab === 'media' && (
            <>
              <PaneHead
                icon="film"
                title={t('settings.nav.media')}
                desc={L(
                  '「为全部分镜配实拍素材」和素材搜索，默认从下面这些免费素材库里找画面，不需要填任何 Key。',
                  'Auto-matching stock footage and media search pull from these free public libraries by default—no API key required.',
                )}
              />
              <div className="sx-card" data-card="free-sources">
                <h4>{L('免费素材来源', 'Free Stock Sources')} <Chip kind="ok" dot>{L('无需 Key', 'No Key Needed')}</Chip></h4>
                <ul className="sx-src">
                  {FREE_SOURCES.map((s) => {
                    const enSrc = FREE_SOURCE_EN[s.id];
                    const r = freeTest && freeTest.results ? localizeStockResult(freeTest.results[s.id], isEn) : null;
                    return (
                      <li key={s.id} data-source={s.id}>
                        <span className="sx-src-name">
                          <b>{isEn && enSrc ? enSrc.name : s.name}</b>
                          <small>{isEn && enSrc ? enSrc.sub : s.en}</small>
                        </span>
                        <span>{isEn && enSrc ? enSrc.kinds : s.kinds}</span>
                        <span>{isEn && enSrc ? enSrc.license : s.license}</span>
                        <span className="sx-src-state">
                          {freeTest && freeTest.running && <Spinner />}
                          {r && (r.ok ? <Chip kind="ok" dot>{L('可用', 'Available')}</Chip> : <Chip kind="warn" dot title={r.error}>{L('没搜到', 'No results')}</Chip>)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <p className="sx-note">{L(
                  '这些来源的素材都可以商用，或者属于公有领域。需要署名的素材，导出时会自动生成一份署名清单（和视频放在一起的 .credits.txt 文件）。',
                  'Assets from these libraries are public domain or commercial-safe. When attribution is required, Frameflow automatically generates a .credits.txt file alongside your exported video.',
                )}</p>
                <div className="sx-actions">
                  <Button size="sm" icon="search" onClick={testFree} disabled={!!(freeTest && freeTest.running)}>{L('试着搜一下', 'Test Free Sources')}</Button>
                  {freeTest && freeTest.running && <span className="st-test running" role="status">{L('正在逐个搜索，最多要等半分钟…', 'Testing each source—this may take up to 30 seconds…')}</span>}
                </div>
                {freeFailed && (
                  <FailHelp
                    detail={FREE_SOURCES
                      .filter((s) => freeTest.results[s.id] && !freeTest.results[s.id].ok)
                      .map((s) => {
                        const enSrc = FREE_SOURCE_EN[s.id];
                        const r = localizeStockResult(freeTest.results[s.id], isEn);
                        return `${isEn && enSrc ? enSrc.name : s.name}${L('：', ': ')}${r.error}`;
                      })
                      .join(L('；', '; '))}
                    steps={isEn
                      ? [
                          'Check your internet connection; if using a proxy, try switching nodes or turning it off.',
                          'It is fine if one source is unreachable—Frameflow automatically uses the remaining sources.',
                        ]
                      : [
                          '检查网络是否正常；开了代理的话，换个节点或关掉代理再试。',
                          '只有个别来源没搜到不要紧，镜流会自动用其余来源。',
                        ]}
                  />
                )}
              </div>
              <div className="sx-card" data-card="stock-keys">
                <h4>{L('可选：已有 Pexels / Pixabay Key 可以填在这里', 'Optional: Pexels / Pixabay API Keys')}</h4>
                <p className="sx-note" style={{ marginTop: 0 }}>{L(
                  '不填也能正常使用。Pexels 已经暂停发放新的 Key；如果你以前申请过，填上后搜索素材时会多出这两个来源。',
                  'Completely optional. Pexels has paused issuing new keys, but if you already have keys, adding them unlocks both libraries in media search.',
                )}</p>
                <div className="sx-keys st-gap">
                  <SecretField label={L('Pexels API Key（可选）', 'Pexels API Key (Optional)')} {...secretProps('pexelsKey', has('pexelsKey'))} />
                  {keyReady(draft, clear, 'pexelsKey', has('pexelsKey')) && (
                    <div className="sx-actions">
                      <Button size="sm" icon="bolt" onClick={() => testStock('pexels')} disabled={saving || testing('stock:pexels')}>{L('测试 Pexels', 'Test Pexels')}</Button>
                      <TestResult state={tests['stock:pexels']} />
                    </div>
                  )}
                  <SecretField label={L('Pixabay API Key（可选）', 'Pixabay API Key (Optional)')} {...secretProps('pixabayKey', has('pixabayKey'))} />
                  {keyReady(draft, clear, 'pixabayKey', has('pixabayKey')) && (
                    <div className="sx-actions">
                      <Button size="sm" icon="bolt" onClick={() => testStock('pixabay')} disabled={saving || testing('stock:pixabay')}>{L('测试 Pixabay', 'Test Pixabay')}</Button>
                      <TestResult state={tests['stock:pixabay']} />
                    </div>
                  )}
                </div>
              </div>
              <div className="sx-card">
                <h4>
                  {L('视频站下载（yt-dlp）', 'Online Video Downloader (yt-dlp)')}
                  {!ytdlp ? <Chip>{L('检测中…', 'Checking…')}</Chip> : ytdlp.installed ? <Chip kind="ok" dot>{L('已安装', 'Installed')}</Chip> : <Chip kind="warn" dot>{L('未安装', 'Not Installed')}</Chip>}
                </h4>
                <p className="sx-note" style={{ marginTop: 0 }}>{L('用于从 B站、YouTube 等下载参考视频到拆片库学习。', 'Downloads reference videos from YouTube, Bilibili, and other sites into the Breakdown Library for study.')}</p>
                {ytdlp && ytdlp.installed && <StatusLine label={L('版本', 'Version')} value={ytdlp.version || '—'} mono />}
                <Row title={L('最长下载时长', 'Max Download Duration')} desc={L('超过时只下载开头部分。', 'Longer videos are clipped to this duration from the start.')}>
                  <input className="input st-num" type="number" min={10} max={3600} step={10} value={draft.maxDownloadSeconds} onChange={(e) => set({ maxDownloadSeconds: e.target.value })} />{L(' 秒', ' s')}
                </Row>
                <div className="sx-actions">
                  <Button size="sm" icon={ytInstall ? undefined : 'download'} onClick={installYtdlp} disabled={!!ytInstall || !ytdlp}>
                    {ytInstall ? <><Spinner /> {L('下载中…', 'Downloading…')}</> : ytdlp && ytdlp.installed ? L('更新到最新版', 'Update to Latest') : L('一键安装', 'Install Now')}
                  </Button>
                </div>
                {ytInstall && <div className="st-progress"><ProgressBar value={ytInstall.progress} indeterminate={!(ytInstall.progress > 0)} /><div className="xs muted ellipsis">{ytInstall.message}</div></div>}
              </div>
            </>
          )}

          {tab === 'videogen' && (
            <>
              <PaneHead
                icon="sparkles"
                title={t('settings.nav.videogen')}
                desc={L(
                  '让 AI 按分镜生成参考画面与视频镜头，生成后自动导入当前项目。支持 OpenAI、Runway、Luma、Google Veo (Gemini)、可灵、海螺、火山方舟（即梦）与 fal.ai 等多家服务商。',
                  'Generate storyboard frames and AI video clips directly into your project. Supports OpenAI, Runway, Luma, Google Veo (Gemini), Kling, Hailuo, Volcengine Ark (Seedance), fal.ai, and more.',
                )}
              />
              <div className="sx-card" data-card="image-source">
                <h4>{L('AI 出图来源', 'AI Image Generation Source')}</h4>
                <Row
                  title={L('生成画面时用哪个服务', 'Image Provider')}
                  desc={L(
                    '选「自动」时自动选用已配置的出图服务（火山方舟 Seedream 或「AI 助手」里的 OpenAI 兼容图片模型）。',
                    'Auto selects whichever image service is configured (Volcengine Ark Seedream or the OpenAI-compatible image model in AI Assistant).',
                  )}
                >
                  <Segmented value={draft.imageProvider} onChange={(v) => set({ imageProvider: v })} options={imageProviderOptions} label={L('AI 出图来源', 'AI Image Generation Source')} />
                </Row>
                <div className={'callout st-gap ' + (imgSrc.warn ? 'warn' : 'ok')} role="status" data-image-source={imgSrc.source}>{imgSrcText}</div>
                {imgSrc.warn && (
                  <div className="sx-actions">
                    <Button size="sm" variant="ghost" onClick={() => setTab('ai')}>{L('前往「AI 助手」配置图片模型', 'Configure Image Model in AI Assistant')}</Button>
                    {draft.vgProvider !== 'seedance' && <Button size="sm" variant="ghost" onClick={() => set({ vgProvider: 'seedance' })}>{L('配置火山方舟密钥', 'Configure Volcengine Ark Key')}</Button>}
                  </div>
                )}
              </div>

              <h4 className="sx-sub">{L('AI 视频服务商', 'AI Video Providers')}</h4>
              <p className="sx-note">{L(
                '平等支持多家主流 AI 视频生成服务商，按需选择一家并配置对应密钥，或使用免密钥的演示模式体验完整流程。',
                'Choose any supported AI video provider and add its API key, or use keyless Demo Mode to preview the full workflow.',
              )}</p>
              <div className="sx-providers" role="radiogroup" aria-label={L('AI 视频服务商', 'AI Video Providers')}>
                {vgProviders.map((p) => {
                  const pd = localizeVgProvider(p, isEn);
                  return (
                    <button key={p.id} type="button" role="radio" aria-checked={draft.vgProvider === p.id} data-provider={p.id} className={'sx-prov' + (draft.vgProvider === p.id ? ' active' : '')} onClick={() => set({ vgProvider: p.id })}>
                      <span className="sx-prov-top"><span className="sx-prov-radio" /><b>{pd.label}</b></span>
                      <small>{pd.vendor}</small>
                      <span className="sx-price">{pd.priceHint}</span>
                      <span className="sx-prov-status">{p.isMock ? <span className="sx-badge">{L('免密钥', 'No Key')}</span> : vgReady(p) ? <Chip kind="ok" dot>{L('已填写', 'Configured')}</Chip> : null}</span>
                    </button>
                  );
                })}
              </div>
              <div className="sx-card" data-card="provider">
                <h4>
                  {vgCurDisp.label}{' '}
                  {vgCur.isMock
                    ? <span className="sx-badge">{L('演示', 'Demo')}</span>
                    : vgReady(vgCur)
                      ? <Chip kind="ok" dot>{L('已填写', 'Configured')}</Chip>
                      : <Chip kind="warn" dot>{L('还没填写密钥', 'Key Required')}</Chip>}
                </h4>
                {vgCur.isMock ? (
                  <p className="sx-note" style={{ marginTop: 0 }}>{L(
                    '演示模式不联网、不收费：返回内置的实拍样例片段，用来体验「AI 生成 → 自动放进分镜」的流程。正式使用请选择上方任一服务商。',
                    'Demo Mode runs offline at no cost, returning bundled sample clips so you can preview the AI generation workflow. Pick any provider above for real generation.',
                  )}</p>
                ) : vgCur.id === 'seedance' ? (
                  <>
                    <p className="sx-note" style={{ marginTop: 0 }}>{L(
                      '同一个火山方舟 API Key 可同时用于 Seedream 图片生成与 Seedance 视频生成。',
                      'A single Volcengine Ark API key works for both Seedream image generation and Seedance video generation.',
                    )}</p>
                    <div className="st-gap">
                      <SecretField label="API Key" placeholder={L('粘贴火山方舟 API Key', 'Paste Volcengine Ark API Key')} {...secretProps('arkKey', hasVg('arkKey'))} onChange={(v) => setDraft((d) => applyArkKey(d, v))} />
                    </div>
                    <div className="sx-grid3">
                      <Field label={L('视频模型名（可选）', 'Video Model (Optional)')} hint={L(`留空使用 ${arkVideoModel}`, `Leave blank for ${arkVideoModel}`)}>
                        <input className="input mono" spellCheck={false} value={ovOf(draft, 'seedance').model} placeholder={arkVideoModel} onChange={(e) => setOv('seedance', { model: e.target.value })} />
                      </Field>
                      <Field label={L('图片模型名（可选）', 'Image Model (Optional)')} hint={L(`留空使用 ${ARK_IMAGE_MODEL}`, `Leave blank for ${ARK_IMAGE_MODEL}`)}>
                        <input className="input mono" spellCheck={false} value={draft.arkImageModel} placeholder={ARK_IMAGE_MODEL} onChange={(e) => set({ arkImageModel: e.target.value })} />
                      </Field>
                      <Field label={L('接口地址（可选）', 'Endpoint URL (Optional)')} hint={L('一般留空；使用代理时填写', 'Leave blank unless using a custom proxy')}>
                        <input className="input mono" spellCheck={false} value={ovOf(draft, 'seedance').baseUrl} placeholder={vgCur.defaultBaseUrl || ''} onChange={(e) => setOv('seedance', { baseUrl: e.target.value })} />
                      </Field>
                    </div>
                    <p className="sx-note">
                      <Icon name="info" size={12} />{' '}
                      {isEn ? (
                        <>
                          Est. {vgCurDisp.priceHint} — <b>billed directly by Volcengine</b> with zero markup from Frameflow.{' '}
                          <TextLink onClick={() => openUrl(ARK_CONSOLE_URL, toast, isEn)}>Open Volcengine Ark Console →</TextLink>
                        </>
                      ) : (
                        <>
                          参考价格 {vgCurDisp.priceHint}，<b>费用由火山引擎直接收取</b>，镜流不加价。{' '}
                          <TextLink onClick={() => openUrl(ARK_CONSOLE_URL, toast, isEn)}>打开火山方舟控制台 →</TextLink>
                        </>
                      )}
                    </p>
                    <div className="sx-actions">
                      <Button size="sm" icon="bolt" onClick={() => testVg('seedance')} disabled={saving || testing('vg:seedance')}>{L('测试连接', 'Test Connection')}</Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={iconOr('image', 'sparkles')}
                        onClick={testArkImage}
                        disabled={!arkReady || saving || testing('img:ark')}
                        title={arkReady ? L('调用一次 Seedream 验证出图（消耗一张图额度）', 'Generate one sample image with Seedream (uses 1 image credit)') : L('请先填写 API Key', 'Enter your API key first')}
                      >
                        {L('试生成一张图', 'Generate Test Image')}
                      </Button>
                      <TestResult state={arkTest} okText={L('连接成功，Key 可以用', 'Connected — key is valid')} brief={!!arkTest && !arkTest.running && !arkTest.ok} />
                    </div>
                    {arkTest && !arkTest.running && !arkTest.ok && <FailHelp detail={arkTest.detail} steps={localizeArkSteps(arkTest.detail, arkTroubleshoot(arkTest.detail), isEn)} />}
                    {arkImgTest && (
                      <div className="sx-imgtest">
                        <TestResult
                          state={arkImgTest}
                          waitingText={L('正在调用 Seedream 出图，请稍等…', 'Generating test image with Seedream…')}
                          okText={L('出图成功', 'Image generated')}
                          failText={L('出图失败', 'Generation failed')}
                          brief
                        />
                        {!arkImgTest.running && arkImgTest.ok && arkImgTest.path && (
                          <img className="sx-thumb" src={api.mediaUrl(arkImgTest.path)} alt={L('Seedream 试生成的图片', 'Seedream test image')} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                        )}
                        {!arkImgTest.running && !arkImgTest.ok && <FailHelp detail={arkImgTest.detail} steps={localizeArkSteps(arkImgTest.detail, arkTroubleshoot(arkImgTest.detail), isEn)} />}
                      </div>
                    )}
                    <ul className="sx-tips">
                      {isEn ? (
                        <>
                          <li>Activate both <b>Seedream</b> (image) and <b>Seedance</b> (video) under Model Activation in the Volcengine Ark console; Jimeng app credits do not apply to API usage.</li>
                          <li>"Test Connection" only checks key validity and costs nothing; "Generate Test Image" consumes one image credit per provider pricing.</li>
                        </>
                      ) : (
                        <>
                          <li>需在火山方舟控制台「开通管理」中开通 <b>Seedream</b>（图片）与 <b>Seedance</b>（视频）模型；即梦 App 会员积分不适用于 API。</li>
                          <li>「测试连接」仅检查 Key 有效性，不扣费；「试生成一张图」会按服务商计费标准消耗一次出图额度。</li>
                        </>
                      )}
                    </ul>
                  </>
                ) : (
                  <>
                    {(vgCur.needs || ['key']).map((f) => {
                      const secret = vgCur.keyFields && vgCur.keyFields[f];
                      if (!secret) return null;
                      const fb = f === 'key' && vgCur.keyFields.fallback;
                      return (
                        <SecretField
                          key={f}
                          label={FIELD_LABEL[f] || f}
                          hint={fb ? L('留空时使用「AI 助手」中的 OpenAI API Key', 'Leave blank to reuse the OpenAI API key from AI Assistant') : undefined}
                          {...secretProps(secret, hasVg(secret))}
                        />
                      );
                    })}
                    <div className="sx-grid2">
                      <Field label={L('模型名（可选）', 'Model (Optional)')} hint={vgCur.defaultModel ? L(`留空使用 ${vgCur.defaultModel}`, `Leave blank for ${vgCur.defaultModel}`) : undefined}>
                        <input className="input mono" spellCheck={false} value={ovOf(draft, vgCur.id).model} placeholder={vgCur.defaultModel || ''} onChange={(e) => setOv(vgCur.id, { model: e.target.value })} />
                      </Field>
                      <Field label={L('接口地址（可选）', 'Endpoint URL (Optional)')} hint={L('使用代理或自定义端点时填写', 'Set only for proxies or custom endpoints')}>
                        <input className="input mono" spellCheck={false} value={ovOf(draft, vgCur.id).baseUrl} placeholder={vgCur.defaultBaseUrl || ''} onChange={(e) => setOv(vgCur.id, { baseUrl: e.target.value })} />
                      </Field>
                    </div>
                    <p className="sx-note">
                      <Icon name="info" size={12} />{' '}
                      {isEn ? (
                        <>
                          Est. {vgCurDisp.priceHint} — <b>billed directly by the provider</b> with zero markup from Frameflow.
                          {vgCur.keyUrl && <> <TextLink onClick={() => openUrl(vgCur.keyUrl, toast, isEn)}>Get API Key →</TextLink></>}
                        </>
                      ) : (
                        <>
                          参考价格 {vgCurDisp.priceHint}，<b>费用由服务商直接收取</b>，镜流不加价。
                          {vgCur.keyUrl && <> <TextLink onClick={() => openUrl(vgCur.keyUrl, toast, isEn)}>去获取密钥 →</TextLink></>}
                        </>
                      )}
                    </p>
                    <div className="sx-actions">
                      <Button size="sm" icon="bolt" onClick={() => testVg(vgCur.id)} disabled={saving || testing('vg:' + vgCur.id)}>{L('测试连接', 'Test Connection')}</Button>
                      <TestResult state={tests['vg:' + vgCur.id]} brief={!!tests['vg:' + vgCur.id] && !tests['vg:' + vgCur.id].running && !tests['vg:' + vgCur.id].ok} />
                    </div>
                    {tests['vg:' + vgCur.id] && !tests['vg:' + vgCur.id].running && !tests['vg:' + vgCur.id].ok && <FailHelp detail={tests['vg:' + vgCur.id].detail} />}
                  </>
                )}
              </div>
              <p className="sx-note">{L(
                '所有密钥都用系统加密保存在这台电脑上，不会写进项目文件。每家服务商同时最多运行 2 个任务，其余自动排队。',
                'All API keys are encrypted locally using OS credential storage and never saved inside project files. Up to 2 concurrent jobs run per provider; additional jobs queue automatically.',
              )}</p>
            </>
          )}

          {tab === 'ai' && (
            <>
              <PaneHead
                icon="brain"
                title={t('settings.ai.title')}
                desc={L(
                  '写分镜、改剪辑、拆片分析所用的语言模型。支持主流在线 API、免 Key 本机模型与多种本机 Agent CLI。',
                  'Language models for storyboarding, natural-language editing, and breakdown analysis. Supports cloud APIs, keyless local models, and local Agent CLIs.',
                )}
              />
              {!aiConnected && (
                <div className="callout ai sx-guide">
                  <Icon name="sparkles" size={16} />
                  <div>
                    {isEn ? (
                      <>
                        <b>AI is not connected yet.</b> Choose any option below:
                        <br />1. Pick a preset under "Cloud & Local API" (OpenAI, DeepSeek, Claude, Gemini, OpenRouter, Volcengine Ark, or keyless local Ollama / LM Studio);
                        <br />2. Enable a locally signed-in CLI under "Local Agent CLI" (Claude Code, Codex CLI, or Gemini CLI);
                        <br />3. Or collaborate directly from an external agent via CLI, Agent Skill, or MCP.
                        <br />Without AI, local rules still handle basic editing commands and template storyboards.
                      </>
                    ) : (
                      <>
                        <b>尚未连接 AI。</b>可按需任选其一：
                        <br />1. 在下方「在线与本地 API」一键选用 OpenAI、DeepSeek、Claude、Gemini、OpenRouter、火山方舟，或免 Key 的 Ollama / LM Studio 本机模型；
                        <br />2. 在「本地 Agent CLI」按需启用本机已登录的 Claude Code、Codex CLI 或 Gemini CLI；
                        <br />3. 或直接通过外部 Agent（CLI / Skill / MCP）协作操作项目。
                        <br />未连接时，仍可使用本地规则完成基础指令解析与模板分镜。
                      </>
                    )}
                  </div>
                </div>
              )}

              <div className="sx-card" data-card="ai-mode">
                <h4>{L('工作模式', 'Mode')}</h4>
                <div className="st-radios" role="radiogroup" aria-label={L('AI 工作模式', 'AI Mode')}>
                  {AI_MODES.map((m) => (
                    <button
                      key={m.value}
                      type="button"
                      role="radio"
                      aria-checked={aiMode === m.value}
                      className={'st-radio' + (aiMode === m.value ? ' active' : '')}
                      onClick={() => set({ provider: providerForAiMode(m.value, draft) })}
                    >
                      <span className="st-radio-dot" />
                      <span className="st-radio-text"><b>{isEn ? m.titleEn : m.title}</b><span>{isEn ? m.descEn : m.desc}</span></span>
                    </button>
                  ))}
                </div>
                {effectiveAiStatus && (
                  <div className="st-current">
                    {L('当前生效：', 'Active engine: ')}<b>{aiProviderLabel(effectiveAiStatus.provider, activeLocale, effectiveAiStatus.preset || (effectiveAiStatus.api && effectiveAiStatus.api.preset))}</b>
                    {effectiveAiStatus.model ? <span className="mono"> · {effectiveAiStatus.model}</span> : null}
                  </div>
                )}
              </div>

              <div className="sx-card" data-card="ai-api">
                <h4>
                  {L('在线与本地 API', 'Cloud & Local API')}
                  {apiConfigured
                    ? <Chip kind="ok" dot>{t('settings.ai.configured')}</Chip>
                    : !needsApiKey
                      ? <Chip kind="ai" dot>{L('本机免 Key', 'Local · No Key')}</Chip>
                      : <Chip dot>{t('settings.ai.notConfigured')}</Chip>}
                </h4>
                <div className="sx-presets" role="group" aria-label={L('常用 API 预设', 'API Presets')}>
                  {apiPresets.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      data-preset={p.id}
                      className={'sx-preset' + (activePresetId === p.id ? ' active' : '')}
                      onClick={() => setDraft((d) => applyApiPreset(d, p.id, apiPresets))}
                    >
                      <span>{isEn && p.labelEn ? p.labelEn : p.label}</span>
                      {!p.requiresKey && <span className="sx-preset-tag">{L('免 Key', 'No Key')}</span>}
                    </button>
                  ))}
                </div>
                {activePreset && (
                  <p className="sx-note" style={{ marginTop: 0, marginBottom: 10 }}>
                    {isEn && activePreset.hintEn ? activePreset.hintEn : activePreset.hint}
                    {activePreset.keyUrl && (
                      <> · <TextLink onClick={() => openUrl(activePreset.keyUrl, toast, isEn)}>{activePreset.requiresKey ? L('获取 API Key →', 'Get API Key →') : L('查看官网 →', 'Visit Website →')}</TextLink></>
                    )}
                  </p>
                )}
                <Row
                  title={L('接口协议', 'API Protocol')}
                  desc={L(
                    '大多数服务与本机推理引擎兼容 OpenAI 协议；官方 Claude API 使用 Anthropic 协议。',
                    'Most providers and local inference engines use the OpenAI protocol; the official Claude API uses Anthropic Messages.',
                  )}
                >
                  <Segmented
                    value={draft.apiProtocol}
                    onChange={(v) => setDraft((d) => ({
                      ...d,
                      apiProtocol: v,
                      ...(aiModeOf(d.provider) === 'api' ? { provider: v } : {}),
                    }))}
                    options={[
                      { value: 'openai', label: L('OpenAI 兼容', 'OpenAI-Compatible') },
                      { value: 'anthropic', label: 'Anthropic Claude' },
                    ]}
                    label={L('接口协议', 'API Protocol')}
                  />
                </Row>
                <div className="st-gap">
                  <Field label={t('settings.ai.baseUrl')}>
                    <input
                      className="input mono"
                      value={draft.openaiBaseUrl}
                      spellCheck={false}
                      placeholder={activePreset ? activePreset.baseUrl : 'https://api.openai.com/v1'}
                      onChange={(e) => set({ openaiBaseUrl: e.target.value, apiPreset: '' })}
                    />
                  </Field>
                  {!needsApiKey && (
                    <div className="callout ok st-gap" role="note">
                      {isEn ? (
                        <>Using local inference server ({activePreset ? (activePreset.labelEn || activePreset.label) : 'localhost'}) — <b>no API key required</b>; leave it blank to connect directly.</>
                      ) : (
                        <>当前为本机推理服务（{activePreset ? activePreset.label : 'localhost'}），<b>无需填写 API Key</b>，留空即可直接连接。</>
                      )}
                    </div>
                  )}
                  <SecretField
                    label={needsApiKey ? t('settings.ai.apiKey') : L('API Key（本机服务无需填写）', 'API Key (Optional for Local Server)')}
                    hint={!needsApiKey ? L('Ollama / LM Studio 本地服务留空即可；仅在自建鉴权代理时填写', 'Leave blank for local Ollama / LM Studio; fill only if your proxy requires auth') : undefined}
                    placeholder={presetKeyPlaceholder(activePreset, isEn)}
                    {...secretProps('openaiKey', has('openaiKey') || (draft.apiProtocol === 'anthropic' && has('anthropicKey')))}
                  />
                </div>
                <div className="sx-grid3">
                  <Field label={t('settings.ai.textModel')}>
                    <input className="input mono" value={draft.openaiModel} spellCheck={false} placeholder={(activePreset && activePreset.model) || 'gpt-4.1-mini'} onChange={(e) => set({ openaiModel: e.target.value })} />
                  </Field>
                  <Field label={t('settings.ai.visionModel')}>
                    <input className="input mono" value={draft.openaiVisionModel} spellCheck={false} placeholder={(activePreset && activePreset.visionModel) || L('留空沿用文本模型', 'Defaults to text model')} onChange={(e) => set({ openaiVisionModel: e.target.value })} />
                  </Field>
                  <Field label={t('settings.ai.imageModel')}>
                    <input className="input mono" value={draft.openaiImageModel} spellCheck={false} placeholder={(activePreset && activePreset.imageModel) || L('支持出图的模型名', 'Image-capable model name')} onChange={(e) => set({ openaiImageModel: e.target.value })} />
                  </Field>
                </div>
                <div className="sx-actions">
                  <Button size="sm" icon="bolt" onClick={() => testAi(apiTestProvider)} disabled={testing('ai:' + apiTestProvider) || saving}>{L('测试接口', 'Test API')}</Button>
                  <TestResult state={apiTestState} />
                </div>
              </div>

              <div className="sx-card" data-card="ai-cli">
                <h4>
                  {L('本地 Agent CLI（可选）', 'Local Agent CLI (Optional)')}
                  {cliInfo
                    ? (cliFound
                        ? (cliLoggedIn ? <Chip kind="ok" dot>{L('已就绪', 'Ready')}</Chip> : <Chip kind="warn" dot>{t('settings.ai.cliNotLoggedIn')}</Chip>)
                        : <Chip kind="warn" dot>{t('settings.ai.cliNotDetected')}</Chip>)
                    : <Chip dot>{L('按需启用', 'On Demand')}</Chip>}
                </h4>
                <p className="sx-note" style={{ marginTop: 0, marginBottom: 12 }}>{L(
                  '平等支持本机已安装的终端编程 Agent，按需选用，不作为默认前提。切换工作模式为「本地 Agent CLI」或在「自动」模式下作为备选即可调用。',
                  'Works with locally installed terminal coding agents on demand. Switch Mode to "Local Agent CLI" or keep "Auto" to use as a fallback.',
                )}</p>
                <Row title={L('选择本机 Agent CLI', 'Select Local Agent CLI')} desc={isEn && activeCli.descEn ? activeCli.descEn : activeCli.desc}>
                  <Segmented
                    value={activeCli.id}
                    onChange={(id) => setDraft((d) => ({
                      ...d,
                      cliAgent: id,
                      ...(aiModeOf(d.provider) === 'cli' ? { provider: id } : {}),
                    }))}
                    options={CLI_AGENTS.map((a) => ({ value: a.id, label: a.label }))}
                    label={L('本机 Agent CLI', 'Local Agent CLI')}
                  />
                </Row>
                {cliFound ? (
                  <div className="st-gap">
                    <StatusLine label={L('路径', 'Path')} value={cliInfo.path || '—'} mono />
                    <StatusLine label={L('版本', 'Version')} value={cliInfo.version || '—'} mono />
                    {!cliLoggedIn && (
                      <div className="callout warn st-gap">
                        {isEn ? (
                          <>Run <kbd>{activeCli.loginHint}</kbd> in your terminal to sign in, then click "Test {activeCli.label}" below.</>
                        ) : (
                          <>打开终端运行 <kbd>{activeCli.loginHint}</kbd> 完成登录后，回到这里点击「测试 {activeCli.label}」。</>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="sx-note">
                    {isEn ? (
                      <>
                        {activeCli.label} (command <kbd>{activeCli.command}</kbd>) was not detected. Install it first or specify a custom executable path below.{' '}
                        <TextLink onClick={() => openUrl(activeCli.docsUrl, toast, isEn)}>View Docs →</TextLink>
                      </>
                    ) : (
                      <>
                        当前未检测到本机 {activeCli.label}（命令 <kbd>{activeCli.command}</kbd>）。如需使用请先安装，或在下方填写自定义可执行文件路径。{' '}
                        <TextLink onClick={() => openUrl(activeCli.docsUrl, toast, isEn)}>查看文档 →</TextLink>
                      </>
                    )}
                  </p>
                )}
                <div className="sx-grid2 st-gap">
                  <Field label={L(`自定义 ${activeCli.command} 路径（可选）`, `Custom ${activeCli.command} Path (Optional)`)}>
                    <input
                      className="input mono"
                      value={draft[activeCli.pathField] || ''}
                      spellCheck={false}
                      placeholder={L('留空自动探测 PATH', 'Leave blank to auto-detect on PATH')}
                      onChange={(e) => set({ [activeCli.pathField]: e.target.value })}
                    />
                  </Field>
                  <Field label={L(`${activeCli.label} 模型覆写（可选）`, `${activeCli.label} Model Override (Optional)`)}>
                    <input
                      className="input mono"
                      value={draft[activeCli.modelField] || ''}
                      spellCheck={false}
                      placeholder={L('留空使用 CLI 默认模型', 'Leave blank to use CLI default')}
                      onChange={(e) => set({ [activeCli.modelField]: e.target.value })}
                    />
                  </Field>
                </div>
                <div className="sx-actions">
                  <Button size="sm" icon="bolt" onClick={() => testAi(activeCli.id)} disabled={testing('ai:' + activeCli.id) || saving}>{L(`测试 ${activeCli.label}`, `Test ${activeCli.label}`)}</Button>
                  <TestResult state={cliTestState} waitingText={L(`${activeCli.label} 首次响应可能需要 10–30 秒…`, `First response from ${activeCli.label} may take 10–30s…`)} />
                </div>
              </div>

              <div className="sx-card" data-card="external-agent">
                <h4>{L('外部 Agent 协作', 'External Agent Integration')} <Chip kind="ai">CLI · Skill · MCP</Chip></h4>
                <p className="sx-note" style={{ marginTop: 0 }}>
                  {isEn ? (
                    <>Connect external agents such as <b>Claude Code, Antigravity, Codex, Gemini CLI, or Cursor</b> via headless CLI, Agent Skill, or optional MCP to inspect and edit projects directly. With <b>Live Watch</b>, external changes sync automatically to your desktop timeline and storyboard.</>
                  ) : (
                    <>支持 <b>Claude Code、Antigravity、Codex、Gemini CLI、Cursor</b> 等任意外部 Agent 通过无头 CLI、Agent Skill 或可选 MCP 直接读写工程；配合 <b>Live Watch</b> 实时监听，外部修改会自动同步到桌面端时间线与分镜。</>
                  )}
                </p>
                <pre className="sx-codeblock mono selectable">{agentSnippet}</pre>
                <div className="sx-actions">
                  <Button size="sm" icon={copiedAgent ? 'check' : 'copy'} onClick={copyAgentSnippet}>
                    {copiedAgent ? L('已复制命令', 'Copied') : L('复制接入命令', 'Copy Setup Commands')}
                  </Button>
                  <span className="xs muted">{L(
                    'Live Watch：外部工具写入项目文件后界面自动刷新，无需重启应用',
                    'Live Watch: the desktop UI refreshes automatically whenever an external tool updates the project file',
                  )}</span>
                </div>
              </div>
            </>
          )}

          {tab === 'asr' && (
            <>
              <PaneHead
                icon="captions"
                title={t('settings.nav.asr')}
                desc={L('把视频里的人声转成字幕，支持一键识别字幕、按字幕剪辑。', 'Transcribe video speech into captions for one-click subtitling and text-based editing. ') + asrPrivacy}
              />
              <div className="sx-card">
                <h4>
                  {L('识别引擎', 'Recognition Engine')}{' '}
                  {!asr ? <Chip>{L('检测中…', 'Checking…')}</Chip> : asr.ready ? <Chip kind="ok" dot>{L('可用', 'Ready')}</Chip> : asr.unavailable ? <Chip dot>{L('暂不可用', 'Unavailable')}</Chip> : <Chip kind="warn" dot>{L('需安装模型', 'Model Required')}</Chip>}
                </h4>
                {asr && asr.ready && (<><StatusLine label={L('引擎', 'Engine')} value={asrEngineLabel} /><StatusLine label={L('模型', 'Model')} value={asr.model || '—'} mono /></>)}
                {asrEngine === 'openai' && (
                  <div className="callout warn st-gap">{L(
                    '现在识别字幕时，音频会上传到你填写的 OpenAI 接口。点下面的「安装模型」后改为在本机识别，不再上传。',
                    'Audio is currently uploaded to your configured OpenAI endpoint for transcription. Click "Install Model" below to switch to offline local recognition.',
                  )}</div>
                )}
                {asr && !asr.ready && !asr.unavailable && (
                  <p className="sx-note" style={{ marginTop: 0 }}>{L(
                    '首次使用需要下载本机语音识别模型（small，约 466 MB），下载一次后可离线使用。',
                    'First-time setup downloads the local speech model (small, ~466 MB) for offline transcription.',
                  )}</p>
                )}
                {asr && asr.unavailable && (
                  <p className="sx-note" style={{ marginTop: 0 }}>
                    {L(
                      `当前版本未包含语音识别组件${asr.error ? `（${asr.error}）` : ''}。`,
                      `Speech recognition components are not included in this build${asr.error ? ` (${asr.error})` : ''}.`,
                    )}
                  </p>
                )}
                <div className="sx-actions">
                  <Button size="sm" icon={asrInstall ? undefined : 'download'} onClick={installAsr} disabled={!!asrInstall || !asr || asr.unavailable || (asr.ready && !asr.downloadable)}>
                    {asrInstall ? <><Spinner /> {L('安装中…', 'Installing…')}</> : asr && asr.ready ? L('重新安装模型', 'Reinstall Model') : L('安装模型', 'Install Model')}
                  </Button>
                  <Button size="sm" variant="ghost" icon="refresh" onClick={loadAsr}>{L('重新检测', 'Recheck')}</Button>
                </div>
                {asrInstall && <div className="st-progress"><ProgressBar value={asrInstall.progress} indeterminate={!(asrInstall.progress > 0)} /><div className="xs muted ellipsis">{asrInstall.message}</div></div>}
              </div>
            </>
          )}

          {tab === 'editing' && (
            <>
              <PaneHead icon="scissors" title={t('settings.nav.editing')} desc={L('新建项目和添加素材时使用的默认值。', 'Defaults applied when creating new projects or adding media.')} />
              <div className="sx-card">
                <Row title={L('默认画幅', 'Default Aspect Ratio')} desc={L('新建项目时预选。', 'Preselected for new projects.')}>
                  <Segmented
                    value={draft.edAspect}
                    onChange={(v) => set({ edAspect: v })}
                    options={[
                      { value: '16:9', label: L('16:9 横屏', '16:9 Landscape') },
                      { value: '9:16', label: L('9:16 竖屏', '9:16 Vertical') },
                      { value: '1:1', label: '1:1' },
                      { value: '4:3', label: '4:3' },
                    ]}
                  />
                </Row>
                <Row title={L('默认帧率', 'Default Frame Rate')}>
                  <Select value={String(draft.edFps)} onChange={(v) => set({ edFps: Number(v) })} options={['24', '25', '30', '50', '60'].map((f) => ({ value: f, label: L(`${f} 帧/秒`, `${f} fps`) }))} />
                </Row>
                <Row title={L('图片默认时长', 'Default Image Duration')} desc={L('图片放上时间线时的长度。', 'Duration used when placing images onto the timeline.')}>
                  <input className="input st-num" type="number" min={0.5} max={60} step={0.5} value={draft.edImageDuration} onChange={(e) => set({ edImageDuration: e.target.value })} />{L(' 秒', ' s')}
                </Row>
                <Row title={L('转场默认时长', 'Default Transition Duration')} desc={L('转场面板添加转场时的默认时长（0.1–2 秒）。', 'Default length when adding transitions (0.1–2s).')}>
                  <input className="input st-num" type="number" min={0.1} max={2} step={0.1} value={draft.edTransitionDuration} onChange={(e) => set({ edTransitionDuration: e.target.value })} />{L(' 秒', ' s')}
                </Row>
                <Row title={L('预览质量', 'Preview Quality')} desc={L('电脑较慢时选「流畅」，预览更顺滑，不影响导出画质。', 'Choose "Smooth" on slower hardware for fluid playback—export quality is unaffected.')}>
                  <Segmented
                    value={draft.edPreviewQuality}
                    onChange={(v) => set({ edPreviewQuality: v })}
                    options={[
                      { value: 'auto', label: L('自动', 'Auto') },
                      { value: 'full', label: L('高清', 'Full HD') },
                      { value: 'half', label: L('流畅', 'Smooth') },
                    ]}
                  />
                </Row>
              </div>
            </>
          )}

          {tab === 'export' && (
            <>
              <PaneHead icon="export" title={t('settings.nav.export')} desc={L('打开导出窗口时预选这些选项，导出时仍可临时修改。', 'Preselected defaults in the Export dialog; you can override them per export.')} />
              <div className="sx-card">
                <Row title={L('分辨率', 'Resolution')}>
                  <Select
                    value={draft.exportResolution}
                    onChange={(v) => set({ exportResolution: v })}
                    options={[
                      { value: 'full', label: L('原始尺寸', 'Original') },
                      { value: '720p', label: L('720p（更快更小）', '720p (Faster & smaller)') },
                    ]}
                  />
                </Row>
                <Row title={L('帧率', 'Frame Rate')}>
                  <Select value={String(draft.exportFps)} onChange={(v) => set({ exportFps: Number(v) })} options={['24', '25', '30', '60'].map((f) => ({ value: f, label: L(`${f} 帧/秒`, `${f} fps`) }))} />
                </Row>
                <Row title={L('画质', 'Quality')}>
                  <Segmented
                    value={draft.exportQuality}
                    onChange={(v) => set({ exportQuality: v })}
                    options={[
                      { value: 'high', label: L('高', 'High') },
                      { value: 'standard', label: L('标准', 'Standard') },
                      { value: 'small', label: L('小文件', 'Compact') },
                    ]}
                  />
                </Row>
                <Row title={L('硬件加速', 'Hardware Acceleration')} desc={L('使用显卡编码，导出更快；遇到花屏或失败时请关闭。', 'Uses GPU encoding for faster exports; turn off if you encounter artifacts or errors.')}>
                  <Segmented
                    value={draft.exportHwaccel}
                    onChange={(v) => set({ exportHwaccel: v })}
                    options={[
                      { value: 'auto', label: L('自动', 'Auto') },
                      { value: 'off', label: L('关闭', 'Off') },
                    ]}
                  />
                </Row>
                <Row title={L('默认保存位置', 'Default Output Folder')} desc={draft.exportFolder || L('文档文件夹', 'Documents folder')}>
                  <Button size="sm" icon="folder" onClick={() => pickFolder('exportFolder')}>{L('选择…', 'Browse…')}</Button>
                  {draft.exportFolder && <Button size="sm" variant="ghost" onClick={() => set({ exportFolder: '' })}>{t('app.reset')}</Button>}
                </Row>
              </div>
            </>
          )}

          {tab === 'cache' && (
            <>
              <PaneHead icon="folder" title={t('settings.nav.cache')} desc={L('项目、拆片库、AI 生成的视频、代理文件和缓存都放在数据目录。', 'Projects, Breakdown Library, AI-generated clips, proxies, and cache live in your data folder.')} />
              <div className="sx-card">
                <h4>{L('数据目录', 'Data Folder')}</h4>
                <div className="st-path">
                  <Icon name="folder" size={16} />
                  <span className="selectable mono ellipsis" title={draft.dataRoot || currentRoot}>
                    {draft.dataRoot || (rootChanged ? L('默认位置（文档\\Frameflow）', 'Default (Documents\\Frameflow)') : currentRoot) || L('默认位置（文档\\Frameflow）', 'Default (Documents\\Frameflow)')}
                  </span>
                </div>
                <div className="sx-actions">
                  <Button size="sm" icon="folder" onClick={() => pickFolder('dataRoot')}>{L('选择文件夹…', 'Choose Folder…')}</Button>
                  <Button size="sm" icon="external" onClick={() => openPath(currentRoot)} disabled={!currentRoot}>{L('打开当前目录', 'Open Current Folder')}</Button>
                  {draft.dataRoot && <Button size="sm" variant="ghost" onClick={() => set({ dataRoot: '' })}>{L('恢复默认位置', 'Reset to Default')}</Button>}
                </div>
                {rootChanged && (
                  <div className="callout warn st-gap">
                    {isEn ? (
                      <>New projects will be saved to the new folder after saving. Existing data is not moved automatically—copy <kbd>projects</kbd> and <kbd>library</kbd> from the old folder if needed.</>
                    ) : (
                      <>保存后新的项目会放到新位置。已有数据不会自动搬移，需要时请把旧目录下的 <kbd>projects</kbd> 和 <kbd>library</kbd> 文件夹手动复制过去。</>
                    )}
                  </div>
                )}
              </div>
              <div className="sx-card">
                <h4>{L('缓存', 'Cache')}</h4>
                <Row title={L('缓存文件夹', 'Cache Folder')} desc={L('缩略图、波形、代理文件。删除后会在需要时自动重新生成。', 'Thumbnails, waveforms, and proxy files—safely regenerated as needed if cleared.')}>
                  <Button size="sm" icon="external" onClick={() => openPath(currentRoot ? currentRoot + '\\cache' : '')} disabled={!currentRoot}>{t('app.open')}</Button>
                </Row>
                <Row title={L('运行日志', 'Application Logs')} desc={L('遇到问题时可以把日志发给我们。', 'Helpful diagnostic logs when troubleshooting issues.')}>
                  <Button size="sm" icon="log" onClick={() => api.call('app:openLogs').catch((e) => toast(L('打开日志失败：', 'Failed to open logs: ') + e.message, 'error'))}>{L('打开日志', 'Open Logs')}</Button>
                </Row>
              </div>
            </>
          )}

          {tab === 'privacy' && (
            <>
              <PaneHead icon={iconOr('shield', 'lock')} title={t('settings.privacy.title')} desc={t('settings.privacy.desc')} />
              <div className="sx-card">
                <h4>{t('settings.privacy.netTitle')}</h4>
                <ul className="sx-net">
                  {NET_USES.map((item) => (
                    <li key={item.key}>
                      <span className="sx-net-ico"><Icon name={item.icon} size={16} /></span>
                      <div>
                        <div className="sx-net-title">
                          <span>{isEn ? item.titleEn : item.title}</span>
                          <span className="sx-net-when">{isEn ? item.whenEn : item.when}</span>
                        </div>
                        <dl className="sx-net-kv">
                          <dt>{t('settings.privacy.to')}</dt><dd>{isEn ? item.toEn : item.to}</dd>
                          <dt>{t('settings.privacy.what')}</dt><dd>{isEn ? item.whatEn : item.what}</dd>
                        </dl>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="sx-card">
                <h4>{t('settings.privacy.consentTitle')} {consentOk ? <Chip kind="ok" dot>{t('settings.privacy.consented')}</Chip> : <Chip dot>{t('settings.privacy.notConsented')}</Chip>}</h4>
                <div className="sx-consent">
                  <div className="sx-row-text">
                    <b>
                      {consentOk
                        ? L(`已于 ${consentDate || '此前'} 同意视频站使用须知`, consentDate ? `Accepted on ${consentDate}` : 'Video site parsing notice accepted')
                        : L('尚未同意视频站使用须知', 'Video site parsing notice not yet accepted')}
                    </b>
                    <span>
                      {consentOk
                        ? L(
                            '使用 B 站、YouTube 等视频站搜索和下载参考素材时不再重复询问；随时可以撤回。',
                            'You will not be prompted again when searching or downloading reference videos from YouTube, Bilibili, and other sites; you can revoke consent anytime.',
                          )
                        : L(
                            '首次搜索或下载视频站参考素材前，需要先阅读并同意使用须知。',
                            'You must review and accept the notice before searching or downloading online reference videos.',
                          )}
                    </span>
                  </div>
                  <div className="sx-row-ctl">
                    {consentOk ? (
                      <Button size="sm" variant="ghost" onClick={revokeConsentAction} disabled={consentBusy}>{t('settings.privacy.revokeConsent')}</Button>
                    ) : (
                      <Button size="sm" onClick={readConsent} disabled={consentBusy}>{t('settings.privacy.readConsent')}</Button>
                    )}
                  </div>
                </div>
              </div>
              <div className="sx-card">
                <h4>{L('隐私说明与开源许可', 'Privacy Notice & Open-Source Licenses')}</h4>
                <p className="sx-note" style={{ marginTop: 0 }}>{L(
                  '所有密钥均通过系统加密存储在本机，不会写进项目文件。你可以随时查看完整的隐私说明和第三方开源许可清单。',
                  'All API keys are encrypted locally via OS credential storage and never written to project files. Review the full privacy notice and third-party licenses anytime.',
                )}</p>
                <div className="sx-links">
                  <Button size="sm" icon="external" onClick={() => openPath(privacyPath)} disabled={!privacyPath}>{t('settings.privacy.openPrivacy')}</Button>
                  <Button size="sm" icon="external" onClick={() => openPath(licensesPath)} disabled={!licensesPath}>{t('settings.privacy.openLicenses')}</Button>
                </div>
              </div>
            </>
          )}

          {tab === 'about' && (
            <>
              <PaneHead icon="info" title={t('settings.about.title')} />
              <div className="sx-card">
                <div className="sx-about">
                  <div className="sx-logo">{L('镜', 'F')}</div>
                  <div>
                    <h4 style={{ margin: 0 }}>{t('app.brand')}</h4>
                    <p className="sx-note" style={{ margin: '4px 0 0' }}>{t('settings.about.subtitle')}</p>
                    <div className="sx-actions" style={{ marginTop: 8 }}>
                      <span className="sx-badge">{t('settings.about.version', { version: (appInfo && (appInfo.version || appInfo.appVersion)) || '—' })}</span>
                      {appInfo && appInfo.ffmpeg && appInfo.ffmpeg.ok && <span className="sx-badge">{t('settings.about.ffmpegReady')}</span>}
                    </div>
                  </div>
                </div>
              </div>
              <div className="sx-card">
                <h4>{t('settings.about.thirdPartyTitle')}</h4>
                <p className="sx-note" style={{ marginTop: 0 }}>{L(
                  '实拍素材来自 Wikimedia Commons、Openverse、Internet Archive、NASA 影像库以及 Pexels、Pixabay，遵循各自许可。AI 文本、图片与视频由你选择的服务商或本地模型生成，费用与内容政策以对应服务商为准。',
                  t('settings.about.thirdPartyDesc'),
                )}</p>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
