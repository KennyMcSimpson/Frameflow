// 设置：左侧分类导航 + 右侧内容。分类：常规 / 外观 / 素材 / AI 视频和图片 / AI 助手 / 语音识别 / 剪辑 / 导出 / 存储与缓存 / 隐私与联网 / 关于
// 草稿换算、服务商列表合并、即梦（火山方舟）的排查提示都是纯函数，放在 settingsDialogUtils.js（有单测）。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import useStore from '../store.js';
import api from '../api.js';
import { Modal, Button, Field, Select, Segmented, Switch, Spinner, ProgressBar, Chip, Icon, ICON_NAMES } from '../components/ui.jsx';
import { hasConsentLocal, requestConsent } from '../consent.js';
import {
  FIELD_LABEL, IMAGE_PROVIDERS, FREE_SOURCES, ARK_CONSOLE_URL, ARK_IMAGE_MODEL, ARK_VIDEO_MODEL,
  toDraft, validate, toPatch, ovOf, mergeVgProviders, applyArkKey, describeImageSource, arkTroubleshoot,
  stockTestResult, keyReady, providerReady,
} from './settingsDialogUtils.js';

const CODEX_URL = 'https://developers.openai.com/codex';

// 新图标（契约 C2）还没合入时退回到已有图标
const iconOr = (name, fallback) => (Array.isArray(ICON_NAMES) && ICON_NAMES.includes(name) ? name : fallback);

const NAV = [
  { value: 'general', label: '常规', icon: 'settings' },
  { value: 'appearance', label: '外观', icon: 'palette' },
  { value: 'media', label: '素材', icon: 'film' },
  { value: 'videogen', label: 'AI 视频和图片', icon: 'sparkles', ai: true },
  { value: 'ai', label: 'AI 助手', icon: 'brain' },
  { value: 'asr', label: '语音识别', icon: 'captions' },
  { value: 'editing', label: '剪辑', icon: 'scissors' },
  { value: 'export', label: '导出', icon: 'export' },
  { value: 'cache', label: '存储与缓存', icon: 'folder' },
  { value: 'privacy', label: '隐私与联网', icon: iconOr('shield', 'lock') },
  { value: 'about', label: '关于', icon: 'info' },
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
  { icon: 'brain', title: 'AI 助手', to: '本机 Codex（OpenAI 账号）或你填写的 OpenAI 兼容接口', what: '你的指令，以及完成任务需要的项目文字（分镜、字幕、素材说明）；看画面的功能会附带截图。', when: '连接了 AI 并使用 AI 功能时' },
  { icon: 'sparkles', title: 'AI 视频和图片', to: '即梦（火山方舟），或你选择的其他服务商（如可灵、海螺）', what: '镜头的画面描述；用参考图生成时还会发送参考图。', when: '点「生成」时，费用由服务商直接收取' },
  { icon: 'search', title: '免费素材搜索', to: '维基共享资源、Openverse、互联网档案馆、NASA 影像库；填了 Key 时还有 Pexels、Pixabay', what: '只发送搜索关键词，选中后下载素材文件。', when: '搜索和添加素材时' },
  { icon: iconOr('globe', 'external'), title: '视频站解析', to: '你粘贴链接或搜索的视频网站（如 B 站）', what: '视频链接或搜索词，由开源工具 yt-dlp 读取公开信息。', when: '第一次使用前需要阅读并同意使用须知' },
  { icon: 'captions', title: '语音识别', to: '默认在本机识别，不联网', what: '只连接了 OpenAI、还没安装本机模型时，会把音频发到 OpenAI 接口转写。', when: '识别字幕时' },
  { icon: 'download', title: '组件下载', to: 'GitHub（yt-dlp、识别程序）、Hugging Face（识别模型）', what: '只下载文件，不上传你的内容。', when: '点「安装」或「更新」时' },
];

const AI_PROVIDERS = [
  { value: 'auto', title: '自动（推荐）', desc: '优先用本机 Codex，其次 OpenAI 兼容接口，都不可用时退回本地规则。' },
  { value: 'codex', title: 'Codex CLI', desc: '使用 ChatGPT 账号登录的本机 Codex，无需 API Key。' },
  { value: 'openai', title: 'OpenAI 兼容接口', desc: '响应更快，还能生成图片。需要自备 Base URL 和 API Key。' },
  { value: 'local', title: '仅本地规则', desc: '不联网调用 AI：中文指令解析、模板分镜、统计拆片仍可用。' },
];

const openUrl = (url, toast) => api.call('shell:openExternal', { url }).catch((e) => toast && toast('打开网页失败：' + e.message, 'error'));

// ---------------------------------------------------------------------------
// 小组件
// ---------------------------------------------------------------------------
function SecretField({ label, hint, placeholder, value, saved, cleared, onChange, onClear, onUndoClear }) {
  const [show, setShow] = useState(false);
  return (
    <Field label={label} hint={hint}>
      <div className="row">
        <input className="input grow mono" type={show ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={value}
          placeholder={saved && !cleared ? '已保存，留空表示不修改' : (placeholder || '粘贴密钥')} onChange={(e) => onChange(e.target.value)} />
        <Button variant="ghost" icon={show ? 'eyeOff' : 'eye'} title={show ? '隐藏' : '显示'} onClick={() => setShow(!show)} />
        {saved && !cleared && <Chip kind="ok" dot>已保存</Chip>}
        {saved && !cleared && <Button size="sm" variant="ghost" onClick={onClear}>清除</Button>}
        {cleared && <Chip kind="warn">保存后清除</Chip>}
        {cleared && <Button size="sm" onClick={onUndoClear}>撤销</Button>}
      </div>
    </Field>
  );
}

/** 测试结果的一行。brief：不在这一行里带出详情（下面另有完整说明时用） */
function TestResult({ state, waitingText, okText, failText, brief }) {
  if (!state) return null;
  if (state.running) return <span className="st-test running" role="status"><Spinner ai /> {waitingText || '测试中…'}</span>;
  return (
    <span className={'st-test ' + (state.ok ? 'ok' : 'bad')} title={brief ? undefined : state.detail} role="status">
      <Icon name={state.ok ? 'check' : 'close'} size={14} stroke={2.2} />
      {state.ok ? (okText || '连接成功') : (failText || '连接失败')}
      {Number.isFinite(state.ms) && state.ms > 0 && <span className="mono">{(state.ms / 1000).toFixed(1)} 秒</span>}
      {!brief && state.detail && <span className="st-test-detail ellipsis">{state.detail}</span>}
    </span>
  );
}

/** 测试失败后的完整说明：原始报错（可选中复制）+ 下一步怎么办 */
function FailHelp({ detail, steps }) {
  const list = Array.isArray(steps) ? steps : [];
  if (!detail && !list.length) return null;
  return (
    <div className="callout warn sx-fix" role="alert">
      {detail && <div className="sx-fix-detail selectable">{detail}</div>}
      {list.length > 0 && (
        <>
          <b>可以这样处理</b>
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
.sx-card>h4{margin:0 0 12px;font-size:var(--fs-13,13px);font-weight:600;color:var(--text-0,#fff);display:flex;align-items:center;gap:8px}
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
.sx-net-kv{display:grid;grid-template-columns:56px minmax(0,1fr);gap:2px 8px;margin-top:4px;font-size:var(--fs-12);line-height:1.55}
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
  const toast = useStore((s) => s.toast);

  const init = TAB_ALIAS[initialTab] || initialTab;
  const [tab, setTab] = useState(NAV.some((t) => t.value === init) ? init : 'general');
  const [draft, setDraft] = useState(() => toDraft(settings));
  const [baseline, setBaseline] = useState(() => JSON.stringify(toDraft(settings)));
  const [clear, setClear] = useState({});
  const [saving, setSaving] = useState(false);
  const [tests, setTests] = useState({});
  const [ytdlp, setYtdlp] = useState(null);
  const [ytInstall, setYtInstall] = useState(null);
  const [vgList, setVgList] = useState(null);
  const [asr, setAsr] = useState(null);
  const [asrInstall, setAsrInstall] = useState(null);
  const [freeTest, setFreeTest] = useState(null);
  const mounted = useRef(true);

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
    loadVg();
    loadAsr();
    return () => { mounted.current = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshAppInfo = async () => { try { useStore.setState({ appInfo: await api.call('app:info') }); } catch { /* 保留旧值 */ } };

  const persist = async () => {
    const bad = validate(draft);
    if (bad) { setTab(bad.tab); toast(bad.message, 'warn'); return null; }
    const prevRoot = (settings && settings.dataRoot) || '';
    const patch = toPatch(draft, clear);
    const next = await api.call('settings:set', patch);
    const st = useStore.getState();
    if (st.refreshSettings) await st.refreshSettings();
    if (st.refreshAI) await st.refreshAI();
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
      if (r) { toast('设置已保存', 'ok'); if (onClose) onClose(); }
    } catch (e) { toast('保存设置失败：' + e.message, 'error'); } finally { if (mounted.current) setSaving(false); }
  };

  /** 先保存再测试，确保测的就是界面上填写的内容 */
  const runTest = async (key, fn) => {
    setTests((t) => ({ ...t, [key]: { running: true } }));
    try {
      const saved = await persist();
      if (!saved) { if (mounted.current) setTests((t) => ({ ...t, [key]: null })); return; }
      const t0 = Date.now();
      const r = await fn();
      if (mounted.current) setTests((t) => ({ ...t, [key]: { ok: !!(r && r.ok), ms: (r && r.ms) || Date.now() - t0, detail: (r && (r.detail || r.error)) || '', path: (r && r.path) || '' } }));
    } catch (e) {
      if (mounted.current) setTests((t) => ({ ...t, [key]: { ok: false, detail: (e && e.message) || String(e) } }));
    }
  };
  const testing = (key) => !!(tests[key] && tests[key].running);
  const testAi = (provider) => runTest(provider, () => api.call('ai:test', { provider }));
  const testVg = (provider) => runTest('vg:' + provider, () => (api.videogen ? api.videogen.test(provider) : api.call('videogen:test', { provider })));
  const testStock = (source) => runTest('stock:' + source, async () => stockTestResult(
    await api.call('web:search', { query: 'ocean', kind: 'video', sources: [source], limit: 1 }), source,
  ));
  /** 真的用即梦出一张图（会用掉一张图的额度），用来确认 Seedream 已经开通 */
  const testArkImage = () => runTest('img:ark', async () => {
    try {
      return await api.call('ai:imageTest', { provider: 'ark' });
    } catch (e) {
      if (/No handler registered|未知的通道|unknown channel/i.test((e && e.message) || '')) return { ok: false, error: '这个版本还不支持在这里试生成，请到创作模式里点「生成画面」试试。' };
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
    try { await requestConsent(CONSENT_KEY); } catch (e) { toast('没能打开使用须知：' + ((e && e.message) || '未知原因'), 'error'); }
  };

  const installYtdlp = async () => {
    if (ytInstall) return;
    setYtInstall({ progress: 0, message: '正在连接…' });
    try {
      const status = await useStore.getState().trackJob('web:ytdlpInstall', {}, ytdlp && ytdlp.installed ? '更新 yt-dlp' : '安装 yt-dlp', (p) => {
        if (mounted.current) setYtInstall({ progress: p.progress || 0, message: p.message || p.stage || '正在下载…' });
      });
      if (mounted.current && status) setYtdlp(status);
      toast(ytdlp && ytdlp.installed ? 'yt-dlp 更新完成' : 'yt-dlp 安装完成', 'ok');
      await refreshAppInfo();
    } catch (e) { if (!e.cancelled) toast('安装 yt-dlp 失败：' + e.message, 'error'); } finally { if (mounted.current) setYtInstall(null); }
  };

  const installAsr = async () => {
    if (asrInstall) return;
    setAsrInstall({ progress: 0, message: '正在连接…' });
    try {
      const onP = (p) => { if (mounted.current) setAsrInstall({ progress: p.progress || 0, message: p.message || p.stage || '正在下载模型…' }); };
      const st = useStore.getState();
      if (st.trackJob) await st.trackJob('asr:installModel', {}, '安装语音识别模型', onP);
      else await api.asr.installModel(onP);
      toast('语音识别模型安装完成', 'ok');
      loadAsr();
    } catch (e) { if (!e.cancelled) toast('安装失败：' + e.message, 'error'); } finally { if (mounted.current) setAsrInstall(null); }
  };

  const pickFolder = async (field) => {
    try { const dir = await api.call('dialog:openFolder'); if (dir) set({ [field]: dir }); } catch (e) { toast('选择文件夹失败：' + e.message, 'error'); }
  };
  const openPath = (p) => { if (p) api.call('shell:openPath', { path: p }).catch((e) => toast('打开目录失败：' + e.message, 'error')); };

  const codex = (appInfo && appInfo.codex) || (aiStatus && aiStatus.codex) || null;
  const currentRoot = (appInfo && appInfo.dataRoot) || '';
  const has = (k) => !!(settings && settings['has' + k[0].toUpperCase() + k.slice(1)]);
  const hasVg = (k) => !!(settings && settings.videogen && settings.videogen.hasKeys && settings.videogen.hasKeys[k]);
  const rootChanged = (draft.dataRoot || '') !== ((settings && settings.dataRoot) || '');

  const secretProps = (k, saved) => ({
    value: draft[k], saved, cleared: !!clear[k],
    onChange: (v) => set({ [k]: v }),
    onClear: () => setClear((c) => ({ ...c, [k]: true })),
    onUndoClear: () => setClear((c) => ({ ...c, [k]: false })),
  });

  const vgProviders = useMemo(() => mergeVgProviders(vgList), [vgList]);
  const vgCur = vgProviders.find((p) => p.id === draft.vgProvider) || vgProviders[vgProviders.length - 1];
  const vgReady = (p) => providerReady(p, { draft, clear, hasKey: hasVg });
  const vgConfigured = vgProviders.some(vgReady);

  // 即梦（火山方舟）：一个 Key 同时用于出图和出视频
  const arkReady = keyReady(draft, clear, 'arkKey', hasVg('arkKey'));
  const arkSaved = hasVg('arkKey') && !clear.arkKey && !draft.arkKey.trim();
  const arkVideoModel = (vgProviders.find((p) => p.id === 'seedance') || {}).defaultModel || ARK_VIDEO_MODEL;
  const arkTest = tests['vg:seedance'];
  const arkImgTest = tests['img:ark'];
  // 现在点「生成画面」会走哪条路（跟着输入框即时变化）
  const openaiKeyReady = keyReady(draft, clear, 'openaiKey', has('openaiKey'));
  const imgSrc = describeImageSource({
    imageProvider: draft.imageProvider,
    hasArk: arkReady,
    hasOpenai: openaiKeyReady && !!draft.openaiBaseUrl.trim() && !!draft.openaiImageModel.trim(),
    hasOpenaiKey: openaiKeyReady,
  });
  const freeFailed = !!(freeTest && freeTest.results && Object.values(freeTest.results).some((r) => !r.ok));

  // AI 是否已连上（Codex 或 OpenAI 兼容接口）；没连上时在 AI 页顶部给出两条路
  const aiConnected = !!(aiStatus && aiStatus.ready && (aiStatus.provider === 'codex' || aiStatus.provider === 'openai'));
  // 语音识别走哪条路：本机 whisper 不上传；只有 OpenAI Key 时在线转写，会上传音频（如实告知）
  const asrEngine = asr && asr.ready ? asr.engine : null;
  const asrPrivacy = asrEngine === 'whisper'
    ? '识别在本机完成，不上传音频。'
    : asrEngine === 'openai'
      ? '现在用的是 OpenAI 在线识别，音频会上传到你填写的 OpenAI 接口。安装本机模型后改为离线识别，不再上传。'
      : '安装本机模型后，识别在本机完成，不上传音频。';
  const asrEngineLabel = asrEngine === 'whisper' ? '本机识别（whisper.cpp）' : asrEngine === 'openai' ? 'OpenAI 在线识别' : (asr && asr.engine) || '—';
  // 视频站使用须知：以设置里记录的同意时间为准
  const consentRec = settings && settings.consent && settings.consent[CONSENT_KEY];
  const consentOk = hasConsentLocal(CONSENT_KEY);
  const consentAt = consentRec && consentRec.at ? new Date(consentRec.at) : null;
  const consentDate = consentAt && !Number.isNaN(consentAt.getTime()) ? `${consentAt.getFullYear()}年${consentAt.getMonth() + 1}月${consentAt.getDate()}日` : '';
  const licensesPath = (appInfo && appInfo.licensesPath) || '';
  const privacyPath = (appInfo && appInfo.privacyPath) || '';

  const requestClose = () => {
    if (saving) return;
    if (dirty) { toast('有未保存的修改，请点「保存」或「放弃修改」', 'warn'); return; }
    if (onClose) onClose();
  };

  return (
    <Modal title="设置" onClose={requestClose} wide className="st-modal sx-modal"
      footer={(
        <>
          <span className="grow hint">{dirty ? '有尚未保存的修改' : '修改后点击「保存」生效'}</span>
          <Button onClick={onClose} disabled={saving}>{dirty ? '放弃修改' : '关闭'}</Button>
          <Button variant="primary" onClick={save} disabled={saving || !dirty}>{saving ? <><Spinner /> 保存中…</> : '保存'}</Button>
        </>
      )}
    >
      <style>{STYLE}</style>
      <div className="sx-layout">
        <nav className="sx-nav" aria-label="设置分类">
          {NAV.map((n, i) => (
            <React.Fragment key={n.value}>
              {(i === 3 || i === 6 || i === 8) && <div className="sx-nav-sep" />}
              <button type="button" data-tab={n.value} className={(tab === n.value ? 'active ' : '') + (n.ai ? 'ai' : '')} onClick={() => setTab(n.value)}>
                <Icon name={n.icon} size={16} />
                {n.label}
                {n.value === 'videogen' && vgConfigured && <span className="sx-nav-dot" title="已填写密钥" />}
              </button>
            </React.Fragment>
          ))}
        </nav>

        <div className="sx-pane" data-pane={tab}>
          {tab === 'general' && (
            <>
              <PaneHead icon="settings" title="常规" desc="项目保存与启动行为。" />
              <div className="sx-card">
                <Row title="自动保存" desc="编辑时每隔几秒自动保存项目，关闭窗口前也会保存。"><Switch checked={draft.autosave} onChange={(v) => set({ autosave: v })} /></Row>
                <Row title="启动时打开上次的项目" desc="关闭后启动将停在首页。"><Switch checked={draft.openLastProject} onChange={(v) => set({ openLastProject: v })} /></Row>
              </div>
            </>
          )}

          {tab === 'appearance' && (
            <>
              <PaneHead icon="palette" title="外观" desc="调整界面大小，适配高分屏或小屏笔记本。" />
              <div className="sx-card">
                <Row title="界面缩放" desc="影响全部文字与控件大小。">
                  <Segmented value={draft.uiScale} onChange={(v) => set({ uiScale: v })} options={[{ value: 0.9, label: '90%' }, { value: 1, label: '100%' }, { value: 1.1, label: '110%' }, { value: 1.25, label: '125%' }]} />
                </Row>
              </div>
            </>
          )}

          {tab === 'media' && (
            <>
              <PaneHead icon="film" title="素材" desc="「为全部分镜配实拍素材」和素材搜索，默认从下面这些免费素材库里找画面，不需要填任何 Key。" />
              <div className="sx-card" data-card="free-sources">
                <h4>免费素材来源 <Chip kind="ok" dot>无需 Key</Chip></h4>
                <ul className="sx-src">
                  {FREE_SOURCES.map((s) => {
                    const r = freeTest && freeTest.results ? freeTest.results[s.id] : null;
                    return (
                      <li key={s.id} data-source={s.id}>
                        <span className="sx-src-name"><b>{s.name}</b><small>{s.en}</small></span>
                        <span>{s.kinds}</span>
                        <span>{s.license}</span>
                        <span className="sx-src-state">
                          {freeTest && freeTest.running && <Spinner />}
                          {r && (r.ok ? <Chip kind="ok" dot>可用</Chip> : <Chip kind="warn" dot title={r.error}>没搜到</Chip>)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <p className="sx-note">这些来源的素材都可以商用，或者属于公有领域。需要署名的素材，导出时会自动生成一份署名清单（和视频放在一起的 .credits.txt 文件）。</p>
                <div className="sx-actions">
                  <Button size="sm" icon="search" onClick={testFree} disabled={!!(freeTest && freeTest.running)}>试着搜一下</Button>
                  {freeTest && freeTest.running && <span className="st-test running" role="status">正在逐个搜索，最多要等半分钟…</span>}
                </div>
                {freeFailed && (
                  <FailHelp
                    detail={FREE_SOURCES.filter((s) => freeTest.results[s.id] && !freeTest.results[s.id].ok).map((s) => `${s.name}：${freeTest.results[s.id].error}`).join('；')}
                    steps={['检查网络是否正常；开了代理的话，换个节点或关掉代理再试。', '只有个别来源没搜到不要紧，镜流会自动用其余来源。']}
                  />
                )}
              </div>
              <div className="sx-card" data-card="stock-keys">
                <h4>可选：已有 Pexels / Pixabay Key 可以填在这里</h4>
                <p className="sx-note" style={{ marginTop: 0 }}>不填也能正常使用。Pexels 已经暂停发放新的 Key；如果你以前申请过，填上后搜索素材时会多出这两个来源。</p>
                <div className="sx-keys st-gap">
                  <SecretField label="Pexels API Key（可选）" {...secretProps('pexelsKey', has('pexelsKey'))} />
                  {keyReady(draft, clear, 'pexelsKey', has('pexelsKey')) && (
                    <div className="sx-actions">
                      <Button size="sm" icon="bolt" onClick={() => testStock('pexels')} disabled={saving || testing('stock:pexels')}>测试 Pexels</Button>
                      <TestResult state={tests['stock:pexels']} />
                    </div>
                  )}
                  <SecretField label="Pixabay API Key（可选）" {...secretProps('pixabayKey', has('pixabayKey'))} />
                  {keyReady(draft, clear, 'pixabayKey', has('pixabayKey')) && (
                    <div className="sx-actions">
                      <Button size="sm" icon="bolt" onClick={() => testStock('pixabay')} disabled={saving || testing('stock:pixabay')}>测试 Pixabay</Button>
                      <TestResult state={tests['stock:pixabay']} />
                    </div>
                  )}
                </div>
              </div>
              <div className="sx-card">
                <h4>视频站下载（yt-dlp）{!ytdlp ? <Chip>检测中…</Chip> : ytdlp.installed ? <Chip kind="ok" dot>已安装</Chip> : <Chip kind="warn" dot>未安装</Chip>}</h4>
                <p className="sx-note" style={{ marginTop: 0 }}>用于从 B站、YouTube 等下载参考视频到拆片库学习。</p>
                {ytdlp && ytdlp.installed && <StatusLine label="版本" value={ytdlp.version || '—'} mono />}
                <Row title="最长下载时长" desc="超过时只下载开头部分。">
                  <input className="input st-num" type="number" min={10} max={3600} step={10} value={draft.maxDownloadSeconds} onChange={(e) => set({ maxDownloadSeconds: e.target.value })} /> 秒
                </Row>
                <div className="sx-actions">
                  <Button size="sm" icon={ytInstall ? undefined : 'download'} onClick={installYtdlp} disabled={!!ytInstall || !ytdlp}>
                    {ytInstall ? <><Spinner /> 下载中…</> : ytdlp && ytdlp.installed ? '更新到最新版' : '一键安装'}
                  </Button>
                </div>
                {ytInstall && <div className="st-progress"><ProgressBar value={ytInstall.progress} indeterminate={!(ytInstall.progress > 0)} /><div className="xs muted ellipsis">{ytInstall.message}</div></div>}
              </div>
            </>
          )}

          {tab === 'videogen' && (
            <>
              <PaneHead icon="sparkles" title="AI 视频和图片" desc="让 AI 按分镜生成画面和视频镜头，生成后自动放进项目。推荐用即梦：填一个 API Key，图片和视频都能用。" />
              <div className="sx-card" data-card="ark">
                <h4>
                  即梦（火山方舟）<Chip kind="accent">推荐</Chip>
                  {arkSaved ? <Chip kind="ok" dot>已填写</Chip> : arkReady ? <Chip kind="warn" dot>保存后生效</Chip> : <Chip dot>还没填写</Chip>}
                </h4>
                <p className="sx-note" style={{ marginTop: 0 }}>一个火山方舟 API Key，同时用于即梦图片（Seedream）和即梦视频（Seedance）。</p>
                <div className="st-gap">
                  <SecretField label="API Key" placeholder="粘贴火山方舟 API Key" {...secretProps('arkKey', hasVg('arkKey'))} onChange={(v) => setDraft((d) => applyArkKey(d, v))} />
                </div>
                <div className="sx-grid2">
                  <Field label="图片模型名（可选）" hint={`留空使用 ${ARK_IMAGE_MODEL}`}>
                    <input className="input mono" spellCheck={false} value={draft.arkImageModel} placeholder={ARK_IMAGE_MODEL} onChange={(e) => set({ arkImageModel: e.target.value })} />
                  </Field>
                  <Field label="视频模型名（可选）" hint={`留空使用 ${arkVideoModel}`}>
                    <input className="input mono" spellCheck={false} value={ovOf(draft, 'seedance').model} placeholder={arkVideoModel} onChange={(e) => setOv('seedance', { model: e.target.value })} />
                  </Field>
                </div>
                <div className="sx-actions">
                  <Button size="sm" icon="bolt" onClick={() => testVg('seedance')} disabled={saving || testing('vg:seedance')}>测试连接</Button>
                  <Button size="sm" variant="ghost" icon="external" onClick={() => openUrl(ARK_CONSOLE_URL, toast)}>打开火山方舟控制台</Button>
                  <TestResult state={arkTest} okText="连接成功，Key 可以用" brief={!!arkTest && !arkTest.running && !arkTest.ok} />
                </div>
                {arkTest && !arkTest.running && !arkTest.ok && <FailHelp detail={arkTest.detail} steps={arkTroubleshoot(arkTest.detail)} />}
                <ul className="sx-tips">
                  <li>即梦 App 的会员积分<b>不能</b>用于 API。API 按火山引擎的价格计费，新用户通常有免费额度。</li>
                  <li>要先在控制台的「开通管理」里开通 <b>Seedream</b>（图片）和 <b>Seedance</b>（视频）模型，否则会提示模型未开通。</li>
                  <li>「测试连接」只检查 Key 能不能用，不花钱。</li>
                </ul>
                <Row title="试生成一张图" desc="真的让即梦画一张图，确认 Seedream 已经开通。会用掉一张图的额度，一般 10–60 秒出结果。">
                  <Button size="sm" icon={iconOr('image', 'sparkles')} onClick={testArkImage} disabled={!arkReady || saving || testing('img:ark')} title={arkReady ? undefined : '先填写 API Key'}>试生成</Button>
                </Row>
                {arkImgTest && (
                  <div className="sx-imgtest">
                    <TestResult state={arkImgTest} waitingText="即梦正在出图，请稍等…" okText="出图成功" failText="出图失败" brief />
                    {!arkImgTest.running && arkImgTest.ok && arkImgTest.path && (
                      <img className="sx-thumb" src={api.mediaUrl(arkImgTest.path)} alt="即梦试生成的图片" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                    )}
                    {!arkImgTest.running && !arkImgTest.ok && <FailHelp detail={arkImgTest.detail} steps={arkTroubleshoot(arkImgTest.detail)} />}
                  </div>
                )}
              </div>

              <div className="sx-card" data-card="image-source">
                <h4>AI 出图来源</h4>
                <Row title="生成画面时用哪个服务" desc="选「自动」时优先用即梦；没有填火山方舟 Key，就用「AI 助手」里的 OpenAI 兼容接口。">
                  <Segmented value={draft.imageProvider} onChange={(v) => set({ imageProvider: v })} options={IMAGE_PROVIDERS} label="AI 出图来源" />
                </Row>
                <div className={'callout st-gap ' + (imgSrc.warn ? 'warn' : 'ok')} role="status" data-image-source={imgSrc.source}>{imgSrc.text}</div>
              </div>

              <h4 className="sx-sub">AI 视频服务商</h4>
              <p className="sx-note">生成视频镜头时用哪一家。选即梦以外的服务商，需要另外填写它自己的密钥。</p>
              <div className="sx-providers" role="radiogroup" aria-label="AI 视频服务商">
                {vgProviders.map((p) => (
                  <button key={p.id} type="button" role="radio" aria-checked={draft.vgProvider === p.id} data-provider={p.id} className={'sx-prov' + (draft.vgProvider === p.id ? ' active' : '')} onClick={() => set({ vgProvider: p.id })}>
                    <span className="sx-prov-top"><span className="sx-prov-radio" /><b>{p.label}</b></span>
                    <small>{p.vendor}{p.recommended && vgReady(p) ? ' · 推荐' : ''}</small>
                    <span className="sx-price">{p.priceHint}</span>
                    <span className="sx-prov-status">{p.isMock ? <span className="sx-badge">免密钥</span> : vgReady(p) ? <Chip kind="ok" dot>已填写</Chip> : p.recommended ? <Chip kind="accent">推荐</Chip> : null}</span>
                  </button>
                ))}
              </div>
              <div className="sx-card" data-card="provider">
                <h4>{vgCur.label} {vgCur.isMock ? <span className="sx-badge">演示</span> : vgReady(vgCur) ? <Chip kind="ok" dot>已填写</Chip> : <Chip kind="warn" dot>还没填写密钥</Chip>}</h4>
                {vgCur.isMock ? (
                  <p className="sx-note" style={{ marginTop: 0 }}>演示模式不联网、不收费：返回内置的实拍样例片段，用来体验「AI 生成 → 自动放进分镜」的流程。正式使用请选择上方任一服务商。</p>
                ) : vgCur.id === 'seedance' ? (
                  <>
                    <p className="sx-note" style={{ marginTop: 0 }}>即梦的 API Key 和模型名在本页最上面的「即梦（火山方舟）」里填写和测试。</p>
                    <div className="st-gap">
                      <Field label="接口地址（可选）" hint="一般留空。使用代理时填写，图片和视频共用这个地址">
                        <input className="input mono" spellCheck={false} value={ovOf(draft, 'seedance').baseUrl} placeholder={vgCur.defaultBaseUrl || ''} onChange={(e) => setOv('seedance', { baseUrl: e.target.value })} />
                      </Field>
                    </div>
                    <p className="sx-note"><Icon name="info" size={12} /> 视频参考价格 {vgCur.priceHint}，<b>费用由火山引擎直接收取</b>，镜流不加价。</p>
                  </>
                ) : (
                  <>
                    {(vgCur.needs || ['key']).map((f) => {
                      const secret = vgCur.keyFields && vgCur.keyFields[f];
                      if (!secret) return null;
                      const fb = f === 'key' && vgCur.keyFields.fallback;
                      return <SecretField key={f} label={FIELD_LABEL[f] || f} hint={fb ? '留空时使用「AI 助手」中的 OpenAI API Key' : undefined} {...secretProps(secret, hasVg(secret))} />;
                    })}
                    <div className="sx-grid2">
                      <Field label="模型名（可选）" hint={vgCur.defaultModel ? `留空使用 ${vgCur.defaultModel}` : undefined}>
                        <input className="input mono" spellCheck={false} value={ovOf(draft, vgCur.id).model} placeholder={vgCur.defaultModel || ''} onChange={(e) => setOv(vgCur.id, { model: e.target.value })} />
                      </Field>
                      <Field label="接口地址（可选）" hint="使用代理或海外节点时填写">
                        <input className="input mono" spellCheck={false} value={ovOf(draft, vgCur.id).baseUrl} placeholder={vgCur.defaultBaseUrl || ''} onChange={(e) => setOv(vgCur.id, { baseUrl: e.target.value })} />
                      </Field>
                    </div>
                    <p className="sx-note">
                      <Icon name="info" size={12} /> 参考价格 {vgCur.priceHint}，<b>费用由服务商直接收取</b>，镜流不加价。
                      {vgCur.keyUrl && <> <TextLink onClick={() => openUrl(vgCur.keyUrl, toast)}>去获取密钥 →</TextLink></>}
                    </p>
                  </>
                )}
                {vgCur.id !== 'seedance' && (
                  <>
                    <div className="sx-actions">
                      <Button size="sm" icon="bolt" onClick={() => testVg(vgCur.id)} disabled={saving || testing('vg:' + vgCur.id)}>测试连接</Button>
                      <TestResult state={tests['vg:' + vgCur.id]} brief={!!tests['vg:' + vgCur.id] && !tests['vg:' + vgCur.id].running && !tests['vg:' + vgCur.id].ok} />
                    </div>
                    {tests['vg:' + vgCur.id] && !tests['vg:' + vgCur.id].running && !tests['vg:' + vgCur.id].ok && <FailHelp detail={tests['vg:' + vgCur.id].detail} />}
                  </>
                )}
              </div>
              <p className="sx-note">所有密钥都用系统加密保存在这台电脑上，不会写进项目文件。每家服务商同时最多运行 2 个任务，其余自动排队。</p>
            </>
          )}

          {tab === 'ai' && (
            <>
              <PaneHead icon="brain" title="AI 助手" desc="写分镜、改剪辑、拆片分析所用的语言模型。" />
              {!aiConnected && (
                <div className="callout ai sx-guide">
                  <Icon name="sparkles" size={16} />
                  <div>
                    <b>还没有连接 AI。</b>有两种方式，任选一种：
                    <br />1. 安装 Codex，用 ChatGPT 账号登录，不需要 API Key（推荐）；
                    <br />2. 在下方「OpenAI 兼容接口」里填写地址和 Key。
                    <br />没连接时，镜流会用本地规则帮你拆分镜、做剪辑，能做的事会少一些。
                    <div className="sx-actions">
                      <Button size="sm" icon="external" onClick={() => openUrl(CODEX_URL, toast)}>查看 Codex 安装说明</Button>
                    </div>
                  </div>
                </div>
              )}
              <div className="sx-card">
                <h4>提供方</h4>
                <div className="st-radios" role="radiogroup" aria-label="AI 提供方">
                  {AI_PROVIDERS.map((p) => (
                    <button key={p.value} type="button" role="radio" aria-checked={draft.provider === p.value} className={'st-radio' + (draft.provider === p.value ? ' active' : '')} onClick={() => set({ provider: p.value })}>
                      <span className="st-radio-dot" />
                      <span className="st-radio-text"><b>{p.title}</b><span>{p.desc}</span></span>
                    </button>
                  ))}
                </div>
                {aiStatus && (
                  <div className="st-current">当前生效：<b>{aiStatus.provider === 'codex' ? 'Codex CLI' : aiStatus.provider === 'openai' ? 'OpenAI 兼容接口' : '本地规则'}</b>{aiStatus.model ? <span className="mono"> · {aiStatus.model}</span> : null}</div>
                )}
              </div>
              <div className="sx-card">
                <h4>Codex CLI {codex ? (codex.ok ? (codex.loggedIn ? <Chip kind="ok" dot>已登录</Chip> : <Chip kind="warn" dot>未登录</Chip>) : <Chip kind="warn" dot>未检测到</Chip>) : <Chip dot>状态未知</Chip>}</h4>
                {codex && codex.ok ? (
                  <>
                    <StatusLine label="路径" value={codex.path || '—'} mono />
                    <StatusLine label="版本" value={codex.version || '—'} mono />
                    {!codex.loggedIn && <div className="callout warn st-gap">打开终端运行 <kbd>codex login</kbd>，登录后回到这里点「测试」。</div>}
                  </>
                ) : (
                  <p className="sx-note" style={{ marginTop: 0 }}>没有检测到 Codex。安装后无需 API Key 即可使用全部 AI 功能。<TextLink onClick={() => openUrl(CODEX_URL, toast)}>查看安装说明 →</TextLink></p>
                )}
                <div className="sx-grid2 st-gap">
                  <Field label="自定义 codex 路径（可选）"><input className="input mono" value={draft.codexPath} spellCheck={false} placeholder="留空自动探测" onChange={(e) => set({ codexPath: e.target.value })} /></Field>
                  <Field label="Codex 模型（可选）"><input className="input mono" value={draft.codexModel} spellCheck={false} placeholder="默认" onChange={(e) => set({ codexModel: e.target.value })} /></Field>
                </div>
                <div className="sx-actions">
                  <Button size="sm" icon="bolt" onClick={() => testAi('codex')} disabled={!!(tests.codex && tests.codex.running) || saving}>测试 Codex</Button>
                  <TestResult state={tests.codex} waitingText="Codex 首次响应可能要 10–30 秒…" />
                </div>
              </div>
              <div className="sx-card">
                <h4>OpenAI 兼容接口 {aiStatus && aiStatus.openai && aiStatus.openai.configured ? <Chip kind="ok" dot>已配置</Chip> : <Chip dot>未配置</Chip>}</h4>
                <Field label="Base URL"><input className="input mono" value={draft.openaiBaseUrl} spellCheck={false} placeholder="https://api.openai.com/v1" onChange={(e) => set({ openaiBaseUrl: e.target.value })} /></Field>
                <SecretField label="API Key" placeholder="sk-…" {...secretProps('openaiKey', has('openaiKey'))} />
                <div className="sx-grid3">
                  <Field label="文本模型"><input className="input mono" value={draft.openaiModel} spellCheck={false} placeholder="gpt-4.1-mini" onChange={(e) => set({ openaiModel: e.target.value })} /></Field>
                  <Field label="视觉模型（可选）"><input className="input mono" value={draft.openaiVisionModel} spellCheck={false} onChange={(e) => set({ openaiVisionModel: e.target.value })} /></Field>
                  <Field label="图片模型（可选）"><input className="input mono" value={draft.openaiImageModel} spellCheck={false} onChange={(e) => set({ openaiImageModel: e.target.value })} /></Field>
                </div>
                <div className="sx-actions">
                  <Button size="sm" icon="bolt" onClick={() => testAi('openai')} disabled={!!(tests.openai && tests.openai.running) || saving}>测试接口</Button>
                  <TestResult state={tests.openai} />
                </div>
              </div>
            </>
          )}

          {tab === 'asr' && (
            <>
              <PaneHead icon="captions" title="语音识别" desc={'把视频里的人声转成字幕，支持一键识别字幕、按字幕剪辑。' + asrPrivacy} />
              <div className="sx-card">
                <h4>识别引擎 {!asr ? <Chip>检测中…</Chip> : asr.ready ? <Chip kind="ok" dot>可用</Chip> : asr.unavailable ? <Chip dot>暂不可用</Chip> : <Chip kind="warn" dot>需安装模型</Chip>}</h4>
                {asr && asr.ready && (<><StatusLine label="引擎" value={asrEngineLabel} /><StatusLine label="模型" value={asr.model || '—'} mono /></>)}
                {asrEngine === 'openai' && <div className="callout warn st-gap">现在识别字幕时，音频会上传到你填写的 OpenAI 接口。点下面的「安装模型」后改为在本机识别，不再上传。</div>}
                {asr && !asr.ready && !asr.unavailable && <p className="sx-note" style={{ marginTop: 0 }}>首次使用需要下载中文识别模型（约 150MB），下载一次后可离线使用。</p>}
                {asr && asr.unavailable && <p className="sx-note" style={{ marginTop: 0 }}>当前版本未包含语音识别组件{asr.error ? `（${asr.error}）` : ''}。</p>}
                <div className="sx-actions">
                  <Button size="sm" icon={asrInstall ? undefined : 'download'} onClick={installAsr} disabled={!!asrInstall || !asr || asr.unavailable || (asr.ready && !asr.downloadable)}>
                    {asrInstall ? <><Spinner /> 安装中…</> : asr && asr.ready ? '重新安装模型' : '安装模型'}
                  </Button>
                  <Button size="sm" variant="ghost" icon="refresh" onClick={loadAsr}>重新检测</Button>
                </div>
                {asrInstall && <div className="st-progress"><ProgressBar value={asrInstall.progress} indeterminate={!(asrInstall.progress > 0)} /><div className="xs muted ellipsis">{asrInstall.message}</div></div>}
              </div>
            </>
          )}

          {tab === 'editing' && (
            <>
              <PaneHead icon="scissors" title="剪辑" desc="新建项目和添加素材时使用的默认值。" />
              <div className="sx-card">
                <Row title="默认画幅" desc="新建项目时预选。">
                  <Segmented value={draft.edAspect} onChange={(v) => set({ edAspect: v })} options={[{ value: '16:9', label: '16:9 横屏' }, { value: '9:16', label: '9:16 竖屏' }, { value: '1:1', label: '1:1' }, { value: '4:3', label: '4:3' }]} />
                </Row>
                <Row title="默认帧率">
                  <Select value={String(draft.edFps)} onChange={(v) => set({ edFps: Number(v) })} options={['24', '25', '30', '50', '60'].map((f) => ({ value: f, label: `${f} 帧/秒` }))} />
                </Row>
                <Row title="图片默认时长" desc="图片放上时间线时的长度。">
                  <input className="input st-num" type="number" min={0.5} max={60} step={0.5} value={draft.edImageDuration} onChange={(e) => set({ edImageDuration: e.target.value })} /> 秒
                </Row>
                <Row title="转场默认时长">
                  <input className="input st-num" type="number" min={0} max={5} step={0.1} value={draft.edTransitionDuration} onChange={(e) => set({ edTransitionDuration: e.target.value })} /> 秒
                </Row>
                <Row title="预览质量" desc="电脑较慢时选「流畅」，预览更顺滑，不影响导出画质。">
                  <Segmented value={draft.edPreviewQuality} onChange={(v) => set({ edPreviewQuality: v })} options={[{ value: 'auto', label: '自动' }, { value: 'full', label: '高清' }, { value: 'half', label: '流畅' }]} />
                </Row>
              </div>
            </>
          )}

          {tab === 'export' && (
            <>
              <PaneHead icon="export" title="导出" desc="打开导出窗口时预选这些选项，导出时仍可临时修改。" />
              <div className="sx-card">
                <Row title="分辨率"><Select value={draft.exportResolution} onChange={(v) => set({ exportResolution: v })} options={[{ value: 'full', label: '原始尺寸' }, { value: '720p', label: '720p（更快更小）' }]} /></Row>
                <Row title="帧率"><Select value={String(draft.exportFps)} onChange={(v) => set({ exportFps: Number(v) })} options={['24', '25', '30', '60'].map((f) => ({ value: f, label: `${f} 帧/秒` }))} /></Row>
                <Row title="画质"><Segmented value={draft.exportQuality} onChange={(v) => set({ exportQuality: v })} options={[{ value: 'high', label: '高' }, { value: 'standard', label: '标准' }, { value: 'small', label: '小文件' }]} /></Row>
                <Row title="硬件加速" desc="使用显卡编码，导出更快；遇到花屏或失败时请关闭。">
                  <Segmented value={draft.exportHwaccel} onChange={(v) => set({ exportHwaccel: v })} options={[{ value: 'auto', label: '自动' }, { value: 'off', label: '关闭' }]} />
                </Row>
                <Row title="默认保存位置" desc={draft.exportFolder || '文档文件夹'}>
                  <Button size="sm" icon="folder" onClick={() => pickFolder('exportFolder')}>选择…</Button>
                  {draft.exportFolder && <Button size="sm" variant="ghost" onClick={() => set({ exportFolder: '' })}>恢复默认</Button>}
                </Row>
              </div>
            </>
          )}

          {tab === 'cache' && (
            <>
              <PaneHead icon="folder" title="存储与缓存" desc="项目、拆片库、AI 生成的视频、代理文件和缓存都放在数据目录。" />
              <div className="sx-card">
                <h4>数据目录</h4>
                <div className="st-path">
                  <Icon name="folder" size={16} />
                  <span className="selectable mono ellipsis" title={draft.dataRoot || currentRoot}>{draft.dataRoot || (rootChanged ? '默认位置（文档\\Frameflow）' : currentRoot) || '默认位置（文档\\Frameflow）'}</span>
                </div>
                <div className="sx-actions">
                  <Button size="sm" icon="folder" onClick={() => pickFolder('dataRoot')}>选择文件夹…</Button>
                  <Button size="sm" icon="external" onClick={() => openPath(currentRoot)} disabled={!currentRoot}>打开当前目录</Button>
                  {draft.dataRoot && <Button size="sm" variant="ghost" onClick={() => set({ dataRoot: '' })}>恢复默认位置</Button>}
                </div>
                {rootChanged && <div className="callout warn st-gap">保存后新的项目会放到新位置。已有数据不会自动搬移，需要时请把旧目录下的 <kbd>projects</kbd> 和 <kbd>library</kbd> 文件夹手动复制过去。</div>}
              </div>
              <div className="sx-card">
                <h4>缓存</h4>
                <Row title="缓存文件夹" desc="缩略图、波形、代理文件。删除后会在需要时自动重新生成。">
                  <Button size="sm" icon="external" onClick={() => openPath(currentRoot ? currentRoot + '\\cache' : '')} disabled={!currentRoot}>打开</Button>
                </Row>
                <Row title="运行日志" desc="遇到问题时可以把日志发给我们。">
                  <Button size="sm" icon="log" onClick={() => api.call('app:openLogs').catch((e) => toast('打开日志失败：' + e.message, 'error'))}>打开日志</Button>
                </Row>
              </div>
            </>
          )}

          {tab === 'about' && (
            <>
              <PaneHead icon="info" title="关于" />
              <div className="sx-card">
                <div className="sx-about">
                  <div className="sx-logo">镜</div>
                  <div>
                    <h4 style={{ margin: 0 }}>镜流 Frameflow</h4>
                    <p className="sx-note" style={{ margin: '4px 0 0' }}>AI 视频工作站 · 创作 / 精修 / 拆片库</p>
                    <div className="sx-actions" style={{ marginTop: 8 }}>
                      <span className="sx-badge">版本 {(appInfo && (appInfo.version || appInfo.appVersion)) || '—'}</span>
                      {appInfo && appInfo.ffmpeg && <span className="sx-badge">FFmpeg 已就绪</span>}
                    </div>
                  </div>
                </div>
              </div>
              <div className="sx-card">
                <h4>素材与第三方服务</h4>
                <p className="sx-note" style={{ marginTop: 0 }}>实拍素材来自 Pexels / Pixabay / Wikimedia Commons，遵循各自许可。AI 视频由你选择的服务商生成，费用与内容政策以服务商为准。</p>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
