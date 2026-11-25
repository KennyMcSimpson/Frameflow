// 设置对话框用的纯函数与常量（不依赖 React / store，便于单测）。
// 草稿 ⇄ 设置补丁的换算、AI 视频服务商列表合并、即梦（火山方舟）相关的提示文字都在这里。

export const SECRET_KEYS = ['openaiKey', 'pexelsKey', 'pixabayKey'];
/** 与 electron/lib/settings.cjs 的 VIDEOGEN_SECRETS 保持一致（加密保存，不写进 settings.json） */
export const VG_SECRETS = ['arkKey', 'klingAk', 'klingSk', 'minimaxKey', 'runwayKey', 'geminiKey', 'soraKey', 'lumaKey', 'falKey', 'jimengAk', 'jimengSk'];
/** 默认展示顺序：即梦排第一 */
export const VG_IDS = ['seedance', 'kling', 'minimax', 'runway', 'veo', 'sora', 'luma', 'fal', 'mock'];
/** 只有主进程报告了才展示的服务商（对应的后端可能还没合入） */
export const VG_OPTIONAL_IDS = ['jimeng-visual'];

export const ARK_CONSOLE_URL = 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey';
export const ARK_IMAGE_MODEL = 'doubao-seedream-4-0-250828';
export const ARK_VIDEO_MODEL = 'doubao-seedance-1-0-pro-250528';

// 渲染端兜底元数据（主进程 videogen:providers 不可用时）
export const VG_FALLBACK = {
  seedance: { label: '即梦（火山方舟）', vendor: '字节跳动', needs: ['key'], keyFields: { key: 'arkKey' }, priceHint: '约 ¥1.5–3.7 / 5 秒', keyUrl: ARK_CONSOLE_URL, defaultModel: ARK_VIDEO_MODEL },
  'jimeng-visual': { label: '即梦AI（火山引擎视觉服务）', vendor: '字节跳动', needs: ['ak', 'sk'], keyFields: { ak: 'jimengAk', sk: 'jimengSk' }, priceHint: '按火山引擎价格计费', keyUrl: 'https://console.volcengine.com/iam/keymanage/' },
  kling: { label: '可灵 Kling', vendor: '快手', needs: ['ak', 'sk'], keyFields: { ak: 'klingAk', sk: 'klingSk' }, priceHint: '约 ¥1–3.5 / 5 秒', keyUrl: 'https://app.klingai.com/cn/dev/console/application' },
  minimax: { label: '海螺 Hailuo（MiniMax）', vendor: 'MiniMax', needs: ['key'], keyFields: { key: 'minimaxKey' }, priceHint: '约 ¥2–3.5 / 6 秒', keyUrl: 'https://platform.minimaxi.com/' },
  runway: { label: 'Runway Gen-4', vendor: 'Runway', needs: ['key'], keyFields: { key: 'runwayKey' }, priceHint: '约 $0.25–0.5 / 5 秒', keyUrl: 'https://dev.runwayml.com/' },
  veo: { label: 'Google Veo', vendor: 'Google', needs: ['key'], keyFields: { key: 'geminiKey' }, priceHint: '约 $0.15–0.4 / 秒', keyUrl: 'https://aistudio.google.com/apikey' },
  sora: { label: 'OpenAI Sora 2', vendor: 'OpenAI', needs: ['key'], keyFields: { key: 'soraKey', fallback: 'openaiKey' }, priceHint: '约 $0.1 / 秒', keyUrl: 'https://platform.openai.com/api-keys' },
  luma: { label: 'Luma Ray 2', vendor: 'Luma AI', needs: ['key'], keyFields: { key: 'lumaKey' }, priceHint: '约 $0.4–1.6 / 5 秒', keyUrl: 'https://lumalabs.ai/dream-machine/api/keys' },
  fal: { label: 'fal.ai 聚合', vendor: 'fal.ai', needs: ['key'], keyFields: { key: 'falKey' }, priceHint: '按所选模型计价', keyUrl: 'https://fal.ai/dashboard/keys' },
  mock: { label: '演示模式', vendor: '镜流', needs: [], keyFields: {}, priceHint: '免费 · 仅演示', isMock: true },
};
export const FIELD_LABEL = { key: 'API Key', ak: 'AccessKey', sk: 'SecretKey' };

/** AI 出图来源（settings ai.imageProvider） */
export const IMAGE_PROVIDERS = [
  { value: 'auto', label: '自动' },
  { value: 'openai', label: 'OpenAI 兼容接口' },
  { value: 'ark', label: '即梦' },
];
const IMAGE_PROVIDER_VALUES = IMAGE_PROVIDERS.map((p) => p.value);

/** 默认使用、不需要 Key 的免费素材来源 */
export const FREE_SOURCES = [
  { id: 'commons', name: '维基共享资源', en: 'Wikimedia Commons', kinds: '视频 · 图片', license: 'CC0 / 公有领域 / CC BY / CC BY-SA' },
  { id: 'openverse', name: 'Openverse', en: 'WordPress 开放素材搜索', kinds: '图片 · 音频', license: 'CC0 / 公有领域 / CC BY 等' },
  { id: 'archive', name: '互联网档案馆', en: 'Internet Archive', kinds: '视频', license: '公有领域 / 知识共享' },
  { id: 'nasa', name: 'NASA 影像库', en: 'NASA Image and Video Library', kinds: '视频 · 图片', license: '公有领域' },
];

const emptyOv = () => ({ baseUrl: '', model: '' });
const str = (v) => String(v == null ? '' : v);

/** 某个服务商的覆盖项（草稿里没有时给空值，保证输入框始终受控） */
export function ovOf(draft, id) {
  const o = draft && draft.vgOverrides && draft.vgOverrides[id];
  return { baseUrl: str(o && o.baseUrl), model: str(o && o.model) };
}

/** 设置 → 对话框草稿 */
export function toDraft(s) {
  const ai = (s && s.ai) || {};
  const web = (s && s.web) || {};
  const ex = (s && s.export) || {};
  const ui = (s && s.ui) || {};
  const g = (s && s.general) || {};
  const ed = (s && s.editing) || {};
  const vg = (s && s.videogen) || {};
  const ov = (vg.overrides && typeof vg.overrides === 'object') ? vg.overrides : {};
  const ids = [...new Set([...VG_IDS, ...VG_OPTIONAL_IDS, ...Object.keys(ov)])];
  const d = {
    provider: ai.provider || 'auto',
    codexPath: ai.codexPath || '',
    codexModel: ai.codexModel || '',
    openaiBaseUrl: ai.openaiBaseUrl || 'https://api.openai.com/v1',
    openaiModel: ai.openaiModel || '',
    openaiVisionModel: ai.openaiVisionModel || '',
    openaiImageModel: ai.openaiImageModel || '',
    imageProvider: IMAGE_PROVIDER_VALUES.includes(ai.imageProvider) ? ai.imageProvider : 'auto',
    arkImageModel: str(ai.imageModels && ai.imageModels.ark),
    maxDownloadSeconds: web.maxDownloadSeconds != null ? web.maxDownloadSeconds : 180,
    dataRoot: (s && s.dataRoot) || '',
    exportQuality: ex.quality || 'high',
    exportFps: ex.fps || 30,
    exportResolution: ex.resolution || 'full',
    exportFolder: ex.folder || '',
    exportHwaccel: ex.hwaccel || 'auto',
    uiScale: Number(ui.scale) || 1,
    autosave: g.autosave !== false,
    openLastProject: g.openLastProject !== false,
    edAspect: ed.aspect || '16:9',
    edFps: ed.fps || 30,
    edImageDuration: ed.imageDuration != null ? ed.imageDuration : 3,
    edTransitionDuration: ed.transitionDuration != null ? ed.transitionDuration : 0.5,
    edPreviewQuality: ed.previewQuality || 'auto',
    vgProvider: vg.provider || 'mock',
    vgOverrides: Object.fromEntries(ids.map((id) => [id, { baseUrl: str(ov[id] && ov[id].baseUrl), model: str(ov[id] && ov[id].model) }])),
  };
  for (const k of SECRET_KEYS) d[k] = '';
  for (const k of VG_SECRETS) d[k] = '';
  return d;
}

const isHttpUrl = (u) => /^https?:\/\/\S+$/i.test(u);
/** 这几个密钥填错时跳到哪个分类（其余密钥都在「AI 视频和图片」） */
const SECRET_TAB = { openaiKey: 'ai', pexelsKey: 'media', pixabayKey: 'media' };

/** 校验草稿：有问题返回 { tab, message }，没问题返回 null */
export function validate(d) {
  const url = str(d.openaiBaseUrl).trim();
  if (url && !isHttpUrl(url)) return { tab: 'ai', message: 'Base URL 需要以 http:// 或 https:// 开头' };
  for (const id of Object.keys(d.vgOverrides || {})) {
    const u = ovOf(d, id).baseUrl.trim();
    if (u && !isHttpUrl(u)) return { tab: 'videogen', message: '接口地址需要以 http:// 或 https:// 开头' };
  }
  // 密钥里混进空格或换行，多半是复制时带上了别的内容
  for (const k of [...VG_SECRETS, ...SECRET_KEYS]) {
    const v = str(d[k]).trim();
    if (v && /\s/.test(v)) return { tab: SECRET_TAB[k] || 'videogen', message: '密钥中间不能有空格或换行，请重新复制完整的一串' };
  }
  const n = Number(d.maxDownloadSeconds);
  if (!Number.isFinite(n) || n < 10 || n > 3600) return { tab: 'media', message: '最长下载时长需要在 10 到 3600 秒之间' };
  const img = Number(d.edImageDuration);
  if (!(img >= 0.5 && img <= 60)) return { tab: 'editing', message: '图片默认时长需在 0.5–60 秒之间' };
  const tr = Number(d.edTransitionDuration);
  if (!(tr >= 0 && tr <= 5)) return { tab: 'editing', message: '转场时长需在 0–5 秒之间' };
  return null;
}

/** 草稿 → settings:set 的补丁。clear[k] 为 true 表示用户点了「清除」这个密钥 */
export function toPatch(d, clear = {}) {
  const keys = {};
  for (const k of VG_SECRETS) {
    const v = str(d[k]).trim();
    if (v) keys[k] = v; else if (clear[k]) keys[k] = '';
  }
  const overrides = {};
  for (const id of Object.keys(d.vgOverrides || {})) {
    const o = ovOf(d, id);
    overrides[id] = { baseUrl: o.baseUrl.trim().replace(/\/+$/, ''), model: o.model.trim() };
  }
  const patch = {
    dataRoot: str(d.dataRoot).trim(),
    ai: {
      provider: d.provider,
      codexPath: str(d.codexPath).trim(),
      codexModel: str(d.codexModel).trim(),
      openaiBaseUrl: str(d.openaiBaseUrl).trim().replace(/\/+$/, ''),
      openaiModel: str(d.openaiModel).trim(),
      openaiVisionModel: str(d.openaiVisionModel).trim(),
      openaiImageModel: str(d.openaiImageModel).trim(),
      imageProvider: IMAGE_PROVIDER_VALUES.includes(d.imageProvider) ? d.imageProvider : 'auto',
      imageModels: { ark: str(d.arkImageModel).trim() },
    },
    web: { maxDownloadSeconds: Math.round(Number(d.maxDownloadSeconds)) },
    export: { quality: d.exportQuality, fps: Number(d.exportFps) || 30, resolution: d.exportResolution, folder: d.exportFolder, hwaccel: d.exportHwaccel },
    ui: { scale: Number(d.uiScale) || 1 },
    general: { autosave: !!d.autosave, openLastProject: !!d.openLastProject },
    editing: { aspect: d.edAspect, fps: Number(d.edFps) || 30, imageDuration: Number(d.edImageDuration), transitionDuration: Number(d.edTransitionDuration), previewQuality: d.edPreviewQuality },
    videogen: { provider: d.vgProvider, overrides, ...(Object.keys(keys).length ? { keys } : {}) },
  };
  for (const k of SECRET_KEYS) {
    const v = str(d[k]).trim();
    if (v) patch[k] = v; else if (clear[k]) patch[k] = '';
  }
  return patch;
}

/**
 * 合并主进程返回的服务商列表与本地兜底元数据。
 * - 顺序：即梦第一，其余按 VG_IDS；主进程多报的服务商插在「演示模式」之前
 * - VG_OPTIONAL_IDS 里的只有主进程报告了才出现
 * - 即梦统一叫「即梦（火山方舟）」并带「推荐」标记
 */
export function mergeVgProviders(vgList) {
  const list = (Array.isArray(vgList) ? vgList : []).filter((x) => x && typeof x.id === 'string' && x.id);
  const reported = new Map(list.map((x) => [x.id, x]));
  const extra = list.map((x) => x.id).filter((id) => !VG_IDS.includes(id));
  const ids = [...VG_IDS.filter((id) => id !== 'mock'), ...new Set(extra), 'mock'];
  return ids.map((id) => {
    const fb = VG_FALLBACK[id] || { label: id, vendor: '', needs: ['key'], keyFields: {}, priceHint: '' };
    const p = { id, ...fb, ...(reported.get(id) || {}) };
    if (!p.keyFields || typeof p.keyFields !== 'object') p.keyFields = fb.keyFields || {};
    if (!Array.isArray(p.needs)) p.needs = fb.needs || [];
    if (id === 'seedance') { p.label = VG_FALLBACK.seedance.label; p.recommended = true; }
    return p;
  });
}

/**
 * 用户在「即梦（火山方舟）」里填了 Key：视频服务商还停在「演示模式」时顺手切到即梦，
 * 否则填完 Key 生成的仍是演示片段，用户会以为 Key 没生效。已选了别家就不动。
 */
export function applyArkKey(draft, value) {
  const v = str(value);
  const next = { ...draft, arkKey: v };
  if (v.trim() && (!draft.vgProvider || draft.vgProvider === 'mock')) next.vgProvider = 'seedance';
  return next;
}

/**
 * 现在点「生成画面」实际会走哪条路。
 * hasArk：有火山方舟 Key；hasOpenai：OpenAI 兼容接口能出图（Key 和图片模型都填了）；
 * hasOpenaiKey：只是填了 Key（用来把「缺 Key」和「缺图片模型」说清楚）。
 * @returns {{ source: 'ark'|'openai'|'none', text: string, warn: boolean }}
 */
export function describeImageSource({ imageProvider = 'auto', hasArk = false, hasOpenai = false, hasOpenaiKey = false } = {}) {
  const openaiMissing = hasOpenaiKey && !hasOpenai ? 'OpenAI 兼容接口还没有填写图片模型' : '还没有填写 OpenAI 兼容接口的 Key';
  if (imageProvider === 'ark') {
    return hasArk
      ? { source: 'ark', text: '画面由即梦（Seedream）生成。', warn: false }
      : { source: 'none', text: '还没有填写火山方舟 API Key，现在生成不了画面，镜头会先用示意画面占位。请在上方「即梦（火山方舟）」里填写。', warn: true };
  }
  if (imageProvider === 'openai') {
    return hasOpenai
      ? { source: 'openai', text: '画面由「AI 助手」里的 OpenAI 兼容接口生成（需要该接口支持图片模型）。', warn: false }
      : { source: 'none', text: openaiMissing + '，现在生成不了画面，镜头会先用示意画面占位。请到「AI 助手」里填写，或改选「即梦」。', warn: true };
  }
  if (hasArk) return { source: 'ark', text: '已填写火山方舟 API Key，画面由即梦（Seedream）生成。', warn: false };
  if (hasOpenai) return { source: 'openai', text: '没有填写火山方舟 API Key，画面由「AI 助手」里的 OpenAI 兼容接口生成。', warn: false };
  return { source: 'none', text: '还没有可用的出图服务，镜头会先用示意画面占位。在上方填写火山方舟 API Key 后即可用即梦出图。', warn: true };
}

/**
 * 即梦（火山方舟）测试连接失败后，按报错内容给出「下一步怎么办」。
 * @param {string} detail 主进程返回的错误文字
 * @returns {string[]} 1–3 条建议，每条一句话
 */
export function arkTroubleshoot(detail) {
  const t = str(detail);
  if (!t.trim()) return [];
  const KEY_STEPS = ['API Key 不对或没复制完整：到控制台「API Key 管理」重新复制整串再粘贴。', '注意这里要的是火山方舟的 API Key，不是即梦 App 的账号密码，也不是 AccessKey / SecretKey。'];
  const MODEL_STEPS = ['模型名可能填错了，或者这个模型还没开通：先把「图片模型名」「视频模型名」清空，用默认模型再试。', '默认模型也不行的话，到控制台「开通管理」里确认 Seedream 和 Seedance 已经开通。', '用自己的接入点时，填控制台里以 ep- 开头的接入点 ID。'];
  // 数字状态码一律带单词边界，免得被模型名里的日期（…250528）误伤
  if (/尚未填写|未填写|没有填写|NO_KEY/i.test(t)) return ['先把火山方舟 API Key 粘贴到上面的输入框，再点「测试连接」。'];
  if (/超时|timeout|timed out|fetch failed|网络连接失败|network|ENOTFOUND|ECONN|EAI_AGAIN|连不上|无法连接/i.test(t)) {
    return ['没连上火山方舟：检查网络是否正常；开了代理的话，试试关掉代理或换个节点。', '「接口地址」一般留空即可，填错也会连不上。'];
  }
  if (/\b429\b|限流|频繁|rate ?limit|繁忙|暂时不可用|\b5\d\d\b/i.test(t)) {
    return ['服务商暂时繁忙或请求太频繁：等一两分钟再试。', '一直这样的话，到火山引擎控制台看看免费额度是不是用完了。'];
  }
  // 额度 / 余额 / 用量上限：这类报错里常带「开通管理」几个字，要先于「未开通」判断
  if (/额度|余额|欠费|用量上限|安全体验|quota|balance|overdue|SetLimitExceeded|\b402\b/i.test(t)) {
    return ['免费额度用完、达到用量上限或账户余额不足：到火山引擎控制台充值，或在「开通管理」里调高用量上限、关闭安全体验模式。'];
  }
  // 找不到模型：报错里也会顺带提「开通管理」，同样要先判断
  if (/找不到这个模型|InvalidEndpointOrModel|不支持当前的画面尺寸|\b404\b|NotFound/i.test(t)) return MODEL_STEPS;
  if (/\b401\b|Unauthorized|InvalidApiKey|AuthenticationError|Key 无效|Key 不对|已失效/i.test(t)) return KEY_STEPS;
  if (/未开通|开通管理|ModelNotOpen|not (been )?activated|没有权限|无权限|\b403\b/i.test(t)) {
    return ['模型还没开通：打开火山方舟控制台，在「开通管理」里开通 Seedream（图片）和 Seedance（视频）。', '确认 API Key 和开通模型的是同一个账号。'];
  }
  if (/无效|api ?key/i.test(t)) return KEY_STEPS;
  if (/模型|model|接入点|endpoint/i.test(t)) return MODEL_STEPS;
  return ['按这三步排查：① Key 是否复制完整；② 控制台「开通管理」里是否开通了 Seedream 和 Seedance；③ 账户是否还有额度。'];
}

/**
 * 把一次「试着搜一下」（web:search，只搜一个来源）的返回值换成测试结果。
 * 主进程返回 { results, errors: [{ source, error, code? }] }；老版本直接返回数组。
 * @param {object|Array} r web:search 的返回值
 * @param {string} source 测试的来源 id
 * @param {{ needsKey?: boolean }} [opts] needsKey 为 false 表示免 Key 来源，搜不到多半是网络问题
 * @returns {{ ok: boolean, detail?: string, error?: string }}
 */
export function stockTestResult(r, source, { needsKey = true } = {}) {
  const items = Array.isArray(r) ? r : (r && (r.results || r.items)) || [];
  if (Array.isArray(items) && items.length) return { ok: true, detail: '可以搜到素材' };
  const errs = r && !Array.isArray(r) && Array.isArray(r.errors) ? r.errors : [];
  const hit = errs.find((e) => e && e.source === source) || errs[0];
  const msg = hit ? str(typeof hit === 'string' ? hit : (hit.error || hit.message)).trim() : '';
  if (msg) return { ok: false, error: msg };
  return { ok: false, error: needsKey ? '没有搜到结果，请检查 Key 是否填对' : '没有搜到结果，可能是网络没连上：检查网络或代理后再试' };
}

/**
 * 某个密钥现在算不算「有」：已保存且没点清除，或者输入框里正在填。
 * 用来让界面上的状态标记跟着输入即时变化。
 */
export function keyReady(draft, clear, key, saved) {
  return (!!saved && !(clear && clear[key])) || !!str(draft && draft[key]).trim();
}

/**
 * 某个视频服务商现在算不算「已填写密钥」（跟着输入框即时变化，不用等保存）。
 * 它需要的每个密钥都已保存或正在填，就算；主进程报告已配置（例如 Sora 借用 OpenAI 的 Key）且没点清除，也算。
 * @param {object} p mergeVgProviders 返回的一项
 * @param {{ draft?: object, clear?: object, hasKey?: (k: string) => boolean }} ctx hasKey(k) 表示这个密钥是否已保存
 */
export function providerReady(p, { draft = {}, clear = {}, hasKey = () => false } = {}) {
  if (!p || p.isMock) return false;
  const fields = (Array.isArray(p.needs) ? p.needs : []).map((f) => p.keyFields && p.keyFields[f]).filter(Boolean);
  if (!fields.length) return !!p.configured;
  if (fields.every((k) => keyReady(draft, clear, k, hasKey(k)))) return true;
  return !!p.configured && !fields.some((k) => clear && clear[k]);
}
