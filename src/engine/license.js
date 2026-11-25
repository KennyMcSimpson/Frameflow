// 素材来源与许可（契约 C3）：纯函数，不依赖 ui。
// 统一读取新旧两套写法：
//   新：asset.source = { kind, provider, id, url, pageUrl, author, authorUrl, title }，asset.license = { id, name, url } 或字符串 id
//   旧：asset.source = 'stock' | 'previz' | 'videogen' | 'sample'（字符串）+ asset.stock = { platform, license, author, url }
//       asset.source = { type: 'local'|'stock'|'web'|'library', platform, license: 许可文字, url, author }
// 输出：规范化许可、受限用法检查（禁止商用 / 禁止改编 / 仅供参考 / 来源不明）、导出用署名文字。

/** 许可表：commercial / derivatives 为 null 表示不确定 */
export const LICENSES = {
  own: { id: 'own', name: '自有素材', short: '自有', commercial: true, derivatives: true, attribution: false, url: '' },
  pexels: { id: 'pexels', name: 'Pexels 许可', short: '可商用', commercial: true, derivatives: true, attribution: false, url: 'https://www.pexels.com/zh-cn/license/' },
  pixabay: { id: 'pixabay', name: 'Pixabay 许可', short: '可商用', commercial: true, derivatives: true, attribution: false, url: 'https://pixabay.com/zh/service/license-summary/' },
  mixkit: { id: 'mixkit', name: 'Mixkit 免费许可', short: '可商用', commercial: true, derivatives: true, attribution: false, url: 'https://mixkit.co/license/' },
  cc0: { id: 'cc0', name: 'CC0 公共领域', short: '可商用', commercial: true, derivatives: true, attribution: false, url: 'https://creativecommons.org/publicdomain/zero/1.0/deed.zh-hans' },
  pdm: { id: 'pdm', name: '公共领域', short: '可商用', commercial: true, derivatives: true, attribution: false, url: 'https://creativecommons.org/publicdomain/mark/1.0/deed.zh-hans' },
  'cc-by': { id: 'cc-by', name: 'CC BY 署名', short: '需署名', commercial: true, derivatives: true, attribution: true, url: 'https://creativecommons.org/licenses/by/4.0/deed.zh-hans' },
  'cc-by-sa': { id: 'cc-by-sa', name: 'CC BY-SA 署名-相同方式共享', short: '需署名', commercial: true, derivatives: true, attribution: true, url: 'https://creativecommons.org/licenses/by-sa/4.0/deed.zh-hans' },
  'cc-by-nd': { id: 'cc-by-nd', name: 'CC BY-ND 署名-禁止演绎', short: '不可改编', commercial: true, derivatives: false, attribution: true, url: 'https://creativecommons.org/licenses/by-nd/4.0/deed.zh-hans' },
  'cc-by-nc': { id: 'cc-by-nc', name: 'CC BY-NC 署名-非商业性使用', short: '禁止商用', commercial: false, derivatives: true, attribution: true, url: 'https://creativecommons.org/licenses/by-nc/4.0/deed.zh-hans' },
  'cc-by-nc-sa': { id: 'cc-by-nc-sa', name: 'CC BY-NC-SA 署名-非商业性使用-相同方式共享', short: '禁止商用', commercial: false, derivatives: true, attribution: true, url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans' },
  'cc-by-nc-nd': { id: 'cc-by-nc-nd', name: 'CC BY-NC-ND 署名-非商业性使用-禁止演绎', short: '禁止商用', commercial: false, derivatives: false, attribution: true, url: 'https://creativecommons.org/licenses/by-nc-nd/4.0/deed.zh-hans' },
  gfdl: { id: 'gfdl', name: 'GNU 自由文档许可', short: '需署名', commercial: true, derivatives: true, attribution: true, url: 'https://www.gnu.org/licenses/fdl-1.3.html' },
  ai: { id: 'ai', name: 'AI 生成', short: 'AI 生成', commercial: true, derivatives: true, attribution: false, url: '' },
  builtin: { id: 'builtin', name: '内置素材', short: '可商用', commercial: true, derivatives: true, attribution: false, url: '' },
  reference: { id: 'reference', name: '仅供学习参考', short: '仅供学习', commercial: false, derivatives: false, attribution: true, url: '' },
  unknown: { id: 'unknown', name: '来源不明', short: '来源不明', commercial: null, derivatives: null, attribution: false, url: '' },
};

/** 来源站点的中文名 */
export const PROVIDER_LABELS = {
  pexels: 'Pexels',
  pixabay: 'Pixabay',
  commons: '维基共享资源',
  openverse: 'Openverse',
  archive: '互联网档案馆',
  nasa: 'NASA 影像库',
  mixkit: 'Mixkit',
  bilibili: '哔哩哔哩',
  youtube: 'YouTube',
  douyin: '抖音',
  kuaishou: '快手',
  xiaohongshu: '小红书',
  vimeo: 'Vimeo',
  tiktok: 'TikTok',
  twitter: 'X（推特）',
  kling: '可灵',
  jimeng: '即梦',
  codex: 'Codex',
};

/** 视频站：从这些站点解析下载的素材一律「仅供学习参考」 */
export const VIDEO_SITE_PROVIDERS = ['bilibili', 'youtube', 'douyin', 'kuaishou', 'xiaohongshu', 'vimeo', 'tiktok', 'twitter'];

/** 免版权图库（不需要同意框，可直接用） */
const STOCK_PROVIDERS = ['pexels', 'pixabay', 'commons', 'openverse', 'archive', 'nasa', 'mixkit'];

const CC_CODES = ['by', 'by-sa', 'by-nd', 'by-nc', 'by-nc-sa', 'by-nc-nd'];

function str(v) {
  return v == null ? '' : String(v).trim();
}

export function providerLabel(provider) {
  const p = str(provider).toLowerCase();
  return PROVIDER_LABELS[p] || str(provider);
}

export function isVideoSite(provider) {
  return VIDEO_SITE_PROVIDERS.includes(str(provider).toLowerCase());
}

/** 从许可文字 / 链接 / 代号里认出许可 id；认不出返回 '' */
export function licenseIdFromText(text) {
  const raw = str(text);
  if (!raw) return '';
  const t = raw.toLowerCase().replace(/[_　]+/g, ' ').replace(/\s+/g, ' ');
  if (LICENSES[t]) return t;
  // 链接形式：creativecommons.org/licenses/by-sa/4.0/、/publicdomain/zero/1.0/
  if (/creativecommons\.org\/publicdomain\/zero/.test(t)) return 'cc0';
  if (/creativecommons\.org\/publicdomain\/mark/.test(t)) return 'pdm';
  const url = t.match(/creativecommons\.org\/licenses\/((?:by)(?:-(?:nc|nd|sa))*)(?:\/|$|\s|\?|#)/);
  if (url) return ccId(url[1]);
  // 视频站下载的默认说明
  if (/仅供(学习|参考)|仅限学习|learning only|reference only/.test(t)) return 'reference';
  if (/^own$|自有|自己拍|原创素材/.test(t)) return 'own';
  if (/pexels/.test(t)) return 'pexels';
  if (/pixabay/.test(t)) return 'pixabay';
  if (/mixkit/.test(t)) return 'mixkit';
  if (/\bcc0\b|cc-zero|creative commons zero|publicdomain\/zero/.test(t)) return 'cc0';
  if (/public ?domain|^pdm$|^pd\b|pd-old|pd-us|pd-self|公有领域|公共领域/.test(t)) return 'pdm';
  // Openverse 的代号：by、by-sa、by-nc-nd…
  if (CC_CODES.includes(t)) return 'cc-' + t;
  // 文字形式：CC BY-SA 4.0、CC-BY-NC-ND-3.0、Creative Commons Attribution-ShareAlike
  const cc = t.match(/\bcc[\s-]*by((?:[\s-]*(?:nc|nd|sa)\b)*)/);
  if (cc) return ccId('by' + cc[1].replace(/\s+/g, '-').replace(/-+/g, '-'));
  if (/attribution/.test(t)) {
    const parts = ['by'];
    if (/non-?commercial/.test(t)) parts.push('nc');
    if (/no-?deriv/.test(t)) parts.push('nd');
    else if (/share-?alike/.test(t)) parts.push('sa');
    return ccId(parts.join('-'));
  }
  if (/gfdl|gnu free documentation/.test(t)) return 'gfdl';
  return '';
}

function ccId(code) {
  const parts = String(code).toLowerCase().split('-').filter(Boolean);
  const out = ['by'];
  if (parts.includes('nc')) out.push('nc');
  if (parts.includes('nd')) out.push('nd');
  else if (parts.includes('sa')) out.push('sa');
  const id = 'cc-' + out.join('-');
  return LICENSES[id] ? id : 'cc-by';
}

/**
 * 规范化许可：接受 { id, name?, url? }、字符串 id、或任意许可文字（如 "CC BY-SA 4.0"）。
 * 返回 { id, name, short, commercial, derivatives, attribution, url }，认不出时 id 为 'unknown'。
 */
export function normalizeLicense(raw) {
  if (raw == null || raw === '') return { ...LICENSES.unknown };
  if (typeof raw === 'object') {
    const byId = str(raw.id).toLowerCase();
    const id = (byId && LICENSES[byId] && byId) || licenseIdFromText(byId) || licenseIdFromText(raw.url) || licenseIdFromText(raw.name);
    if (!id) {
      const name = str(raw.name);
      return { ...LICENSES.unknown, ...(name ? { name, text: name } : {}), url: str(raw.url) };
    }
    const base = LICENSES[id];
    return { ...base, name: str(raw.name) || base.name, url: str(raw.url) || base.url };
  }
  const text = str(raw);
  const id = licenseIdFromText(text);
  if (!id) return { ...LICENSES.unknown, text };
  const base = LICENSES[id];
  // 原文更具体（例如带版本号的 "CC BY-SA 4.0"）时保留原文作为名称
  const name = /^cc[\s-]/i.test(text) && text.length <= 40 ? text : base.name;
  return { ...base, name };
}

/**
 * 读取素材来源，统一成 { kind, provider, id, url, pageUrl, author, authorUrl, title, licenseText }。
 * kind：local | stock | web | videosite | ai | builtin | sample | library | unknown
 */
export function describeSource(asset) {
  const a = asset || {};
  const s = a.source;
  const stock = a.stock && typeof a.stock === 'object' ? a.stock : null;
  const out = { kind: 'unknown', provider: '', id: '', url: '', pageUrl: '', author: '', authorUrl: '', title: '', licenseText: '' };
  if (typeof s === 'string') {
    const k = s.toLowerCase();
    if (k === 'stock') {
      out.kind = stock && stock.sample ? 'sample' : 'stock';
      out.provider = str(stock && stock.platform).toLowerCase();
    } else if (k === 'videogen') {
      out.kind = 'ai';
      out.provider = str(a.meta && a.meta.videogen && a.meta.videogen.provider).toLowerCase();
    } else if (k === 'previz') {
      // 画面预演图：本机生成的示意画面，除非带了 ai 字段
      out.kind = a.ai ? 'ai' : 'local';
    } else if (k === 'sample') {
      out.kind = 'sample';
      out.provider = str(stock && stock.platform).toLowerCase();
    } else if (['local', 'web', 'videosite', 'ai', 'builtin', 'library'].includes(k)) {
      out.kind = k;
    }
    if (stock) {
      out.url = str(stock.url);
      out.pageUrl = str(stock.pageUrl || stock.url);
      out.author = str(stock.author);
      out.licenseText = str(stock.license);
      out.id = str(stock.resultId || stock.id);
    }
  } else if (s && typeof s === 'object') {
    const kind = str(s.kind || s.type).toLowerCase();
    const provider = str(s.provider || s.platform).toLowerCase();
    out.provider = provider;
    out.id = str(s.id);
    out.url = str(s.url);
    out.pageUrl = str(s.pageUrl || s.url);
    out.author = str(s.author);
    out.authorUrl = str(s.authorUrl);
    out.title = str(s.title);
    out.licenseText = typeof s.license === 'string' ? s.license : str(s.license && (s.license.id || s.license.name));
    if (kind) out.kind = kind;
    else if (provider) out.kind = 'web';
    // 旧写法：type 为 web 但来自视频站 → 视频站
    if ((out.kind === 'web' || out.kind === 'stock') && isVideoSite(provider)) out.kind = 'videosite';
    if (out.kind === 'web' && STOCK_PROVIDERS.includes(provider)) out.kind = 'stock';
    if (!['local', 'stock', 'web', 'videosite', 'ai', 'builtin', 'sample', 'library'].includes(out.kind)) out.kind = 'unknown';
  } else if (stock) {
    out.kind = stock.sample ? 'sample' : 'stock';
    out.provider = str(stock.platform).toLowerCase();
    out.url = str(stock.url);
    out.pageUrl = out.url;
    out.author = str(stock.author);
    out.licenseText = str(stock.license);
  } else {
    out.kind = 'local';
  }
  // 旧版 stock 字段补齐作者 / 链接
  if (stock) {
    if (!out.author) out.author = str(stock.author);
    if (!out.pageUrl) out.pageUrl = str(stock.pageUrl || stock.url);
    if (!out.licenseText) out.licenseText = str(stock.license);
    if (!out.provider) out.provider = str(stock.platform).toLowerCase();
  }
  return out;
}

export function isAiAsset(asset) {
  if (!asset) return false;
  if (asset.ai || asset.kind === 'generated-image') return true;
  const s = asset.source;
  if (typeof s === 'string') {
    const k = s.toLowerCase();
    if (k === 'videogen' || k === 'ai') return true;
  } else if (s && typeof s === 'object') {
    const k = str(s.kind).toLowerCase();
    const t = str(s.type).toLowerCase();
    if (k === 'ai' || t === 'ai' || k === 'videogen' || t === 'videogen') return true;
  }
  if (asset.meta && typeof asset.meta === 'object' && asset.meta.videogen) return true;
  return false;
}

export function isReferenceAsset(asset) {
  if (!asset) return false;
  if (asset.reference) return true;
  const src = describeSource(asset);
  if (src.kind === 'videosite') return true;
  const own = asset.license != null ? licenseIdFromText(typeof asset.license === 'object' ? asset.license.id || asset.license.name : asset.license) : '';
  if (own === 'reference') return true;
  return !own && licenseIdFromText(src.licenseText) === 'reference';
}

/** 素材的许可：写了 license 就用它；否则按来源推断 */
export function assetLicense(asset) {
  if (!asset) return { ...LICENSES.unknown };
  if (asset.license != null && asset.license !== '') {
    const lic = normalizeLicense(asset.license);
    if (lic.id !== 'unknown') return lic;
  }
  if (isReferenceAsset(asset)) return { ...LICENSES.reference };
  if (isAiAsset(asset)) return { ...LICENSES.ai };
  const src = describeSource(asset);
  if (src.provider === 'pexels') return { ...LICENSES.pexels };
  if (src.provider === 'pixabay') return { ...LICENSES.pixabay };
  if (src.provider === 'mixkit') return { ...LICENSES.mixkit };
  const fromText = src.licenseText ? normalizeLicense(src.licenseText) : null;
  if (fromText && fromText.id !== 'unknown') return fromText;
  switch (src.kind) {
    case 'local': return { ...LICENSES.own };
    // 素材库：用户自己收藏的素材，没有许可文字时按自有处理（视频站来的会带「仅供学习参考」）
    case 'library': return { ...LICENSES.own };
    case 'builtin': return { ...LICENSES.builtin };
    case 'sample': return { ...LICENSES.mixkit };
    case 'ai': return { ...LICENSES.ai };
    case 'videosite': return { ...LICENSES.reference };
    default: return fromText ? { ...fromText } : { ...LICENSES.unknown };
  }
}

/** 素材在界面上显示的标题 */
function assetTitle(asset) {
  const src = describeSource(asset);
  return str(src.title) || str(asset && asset.name) || '未命名素材';
}

export function usedAssetIds(project) {
  const ids = new Set();
  const t = (project && project.tracks) || {};
  for (const c of t.video || []) {
    if (c && c.assetId) ids.add(c.assetId);
    if (c && c.canvas && c.canvas.type === 'image' && typeof c.canvas.value === 'string' && c.canvas.value) ids.add(c.canvas.value);
  }
  for (const c of t.audio || []) if (c && c.assetId) ids.add(c.assetId);
  for (const o of (project && project.overlays) || []) if (o && o.assetId) ids.add(o.assetId);
  return ids;
}

/**
 * 单个素材的使用限制；没有限制返回 null。
 * 返回 { level: 'block' | 'warn', reason, licenseId }
 */
export function assetRestriction(asset, { commercial = true } = {}) {
  if (!asset) return null;
  const lic = assetLicense(asset);
  if (lic.id === 'reference') {
    return {
      level: commercial ? 'block' : 'warn',
      reason: '来自视频站，仅供学习参考。版权归原作者，未经授权不能公开发布或商用',
      licenseId: lic.id,
    };
  }
  const reasons = [];
  let level = null;
  if (lic.commercial === false && commercial) {
    level = 'block';
    reasons.push(`许可是「${lic.name}」，禁止商用`);
  }
  if (lic.derivatives === false) {
    level = level || 'warn';
    reasons.push(`许可是「${lic.name}」，不允许改编（剪辑、加字幕、调色都算改编）`);
  }
  if (lic.id === 'unknown') {
    level = level || 'warn';
    reasons.push('来源不明，发布前请确认你有使用权');
  }
  return level ? { level, reason: reasons.join('；'), licenseId: lic.id } : null;
}

/** 工程里有使用限制的素材：block 在前 */
export function findRestrictedUsage(project, { commercial = true } = {}) {
  const assets = (project && project.assets) || {};
  const out = [];
  for (const id of usedAssetIds(project)) {
    const asset = assets[id];
    if (!asset) continue;
    const r = assetRestriction(asset, { commercial });
    if (r) out.push({ assetId: id, title: assetTitle(asset), reason: r.reason, level: r.level, licenseId: r.licenseId });
  }
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'block' ? -1 : 1));
}

/** 单个素材的署名行；不需要署名时返回 '' */
export function creditLine(asset) {
  if (!asset) return '';
  const lic = assetLicense(asset);
  if (!lic.attribution) return '';
  const src = describeSource(asset);
  const parts = [`「${assetTitle(asset)}」`];
  parts.push(src.author ? `作者：${src.author}` : '作者：未署名');
  parts.push(`许可：${lic.name}`);
  const site = providerLabel(src.provider);
  if (site) parts.push(`来源：${site}`);
  const link = src.pageUrl || src.url;
  if (link) parts.push(link);
  return parts.join('，');
}

/** 导出用的署名文字；没有需要署名的素材时返回空串 */
export function creditsText(project) {
  const assets = (project && project.assets) || {};
  const lines = [];
  const seen = new Set();
  for (const id of usedAssetIds(project)) {
    const line = creditLine(assets[id]);
    if (line && !seen.has(line)) { seen.add(line); lines.push(line); }
  }
  if (!lines.length) return '';
  return ['素材来源与署名', ...lines.map((l) => `· ${l}`)].join('\n');
}

export function projectUsesAi(project) {
  const assets = (project && project.assets) || {};
  for (const id of usedAssetIds(project)) if (isAiAsset(assets[id])) return true;
  return false;
}

/** 搜索结果 / 素材卡片上的简短许可标签：{ text, tone: 'ok'|'info'|'warn'|'danger', title } */
export function licenseBadge(licOrRaw) {
  const lic = licOrRaw && typeof licOrRaw === 'object' && 'commercial' in licOrRaw ? licOrRaw : normalizeLicense(licOrRaw);
  if (lic.id === 'reference') return { text: '仅供学习', tone: 'danger', title: '版权归原作者。未经授权，不得用于公开发布或商用。' };
  if (lic.id === 'unknown') return { text: '来源不明', tone: 'warn', title: '没有找到许可信息，使用前请到原页面确认' };
  if (lic.commercial === false) return { text: '禁止商用', tone: 'danger', title: `${lic.name}：只能用于非商业用途，并需署名` };
  if (lic.derivatives === false) return { text: '不可改编', tone: 'warn', title: `${lic.name}：只能原样使用，不能剪辑改编` };
  if (lic.attribution) return { text: '需署名', tone: 'info', title: `${lic.name}：可商用，导出时会自动生成署名文字` };
  return { text: lic.short || '可商用', tone: 'ok', title: `${lic.name}：可免费商用，无需署名` };
}
