'use strict';
// AI API 预设、本地免密钥检测与 Anthropic Messages API 请求/响应编解码。
// 纯 Node 模块，零 Electron 依赖。
const { _internals: codexInternals } = require('./codex.cjs');

const { parseJsonLoose } = codexInternals;

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;

const API_PRESETS = Object.freeze([
  Object.freeze({
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    visionModel: 'gpt-4.1-mini',
    imageModel: 'gpt-image-1',
    requiresKey: true,
  }),
  Object.freeze({
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    visionModel: '',
    imageModel: '',
    requiresKey: true,
  }),
  Object.freeze({
    id: 'anthropic',
    name: 'Anthropic Claude',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-20250514',
    visionModel: 'claude-sonnet-4-20250514',
    imageModel: '',
    requiresKey: true,
  }),
  Object.freeze({
    id: 'gemini',
    name: 'Google Gemini',
    protocol: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    visionModel: 'gemini-2.5-flash',
    imageModel: '',
    requiresKey: true,
  }),
  Object.freeze({
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4.1-mini',
    visionModel: 'openai/gpt-4.1-mini',
    imageModel: '',
    requiresKey: true,
  }),
  Object.freeze({
    id: 'ark',
    name: 'Volcengine Ark (火山方舟)',
    protocol: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-1-6-250615',
    visionModel: 'doubao-seed-1-6-250615',
    imageModel: '',
    requiresKey: true,
  }),
  Object.freeze({
    id: 'ollama',
    name: 'Ollama (Local)',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:14b',
    visionModel: '',
    imageModel: '',
    requiresKey: false,
  }),
  Object.freeze({
    id: 'lmstudio',
    name: 'LM Studio (Local)',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'local-model',
    visionModel: '',
    imageModel: '',
    requiresKey: false,
  }),
]);

const API_PRESETS_BY_ID = Object.freeze(
  API_PRESETS.reduce((acc, preset) => {
    acc[preset.id] = preset;
    return acc;
  }, Object.create(null)),
);

function getPreset(id) {
  if (typeof id !== 'string') return null;
  const key = id.trim().toLowerCase();
  if (!key) return null;
  return Object.prototype.hasOwnProperty.call(API_PRESETS_BY_ID, key) ? API_PRESETS_BY_ID[key] : null;
}

/**
 * 判断接口地址是否为本机免密钥服务（Ollama / LM Studio 等）。
 * 仅允许 http/https 协议且主机名严格为 localhost、127.0.0.1 或 ::1。
 */
function isLocalKeylessUrl(baseUrl) {
  if (typeof baseUrl !== 'string') return false;
  const s = baseUrl.trim();
  if (!s) return false;
  let u;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = String(u.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function parseImageBlock(item) {
  if (!item) return null;
  if (typeof item === 'string') {
    const m = /^data:([^;,\s]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(item.trim());
    if (!m) return null;
    const mediaType = m[1].toLowerCase();
    const data = m[2].replace(/\s+/g, '');
    if (!data) return null;
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  }
  if (typeof item === 'object') {
    if (item.type === 'image' && item.source && item.source.type === 'base64' && item.source.data) {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: String(item.source.media_type || item.source.mediaType || 'image/jpeg').toLowerCase(),
          data: String(item.source.data).replace(/\s+/g, ''),
        },
      };
    }
    const rawData = item.data || item.base64;
    if (typeof rawData === 'string' && rawData.trim()) {
      const mediaType = String(item.media_type || item.mediaType || item.mime || 'image/jpeg').toLowerCase();
      return {
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: rawData.replace(/\s+/g, '') },
      };
    }
  }
  return null;
}

function anthropicMessagesUrl(baseUrl) {
  let s = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!s) s = 'https://api.anthropic.com/v1';
  s = s.replace(/\/messages$/i, '');
  try {
    const u = new URL(s);
    if (!u.pathname || u.pathname === '/') return `${s}/v1/messages`;
  } catch {}
  return `${s}/messages`;
}

function buildAnthropicHeaders(apiKey) {
  const key = String(apiKey || '').trim();
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
  };
  if (key) headers['x-api-key'] = key;
  return headers;
}

/**
 * 构造 Anthropic Messages API（POST /v1/messages）请求体。
 * 支持文本、base64 图片块与 JSON Schema 输出约束。
 */
function buildAnthropicRequest({ model, system, prompt, schema, images, maxTokens } = {}) {
  const chosenModel = String(model || '').trim() || DEFAULT_ANTHROPIC_MODEL;
  const limitTokens = Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0
    ? Math.round(Number(maxTokens))
    : DEFAULT_ANTHROPIC_MAX_TOKENS;

  const sysParts = [];
  if (system != null && String(system).trim()) sysParts.push(String(system).trim());
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    sysParts.push(
      '请只输出一个 JSON 对象，不要输出其他文字、解释或 Markdown 代码块标记。JSON 必须严格符合以下 JSON Schema：\n'
      + JSON.stringify(schema),
    );
  }
  const systemText = sysParts.join('\n\n');

  const imageBlocks = [];
  for (const img of Array.isArray(images) ? images : []) {
    const block = parseImageBlock(img);
    if (block) imageBlocks.push(block);
  }
  const userText = String(prompt || '');
  const content = imageBlocks.length
    ? [...imageBlocks, { type: 'text', text: userText }]
    : userText;

  const body = {
    model: chosenModel,
    max_tokens: limitTokens,
    messages: [{ role: 'user', content }],
  };
  if (systemText) body.system = systemText;
  return body;
}

/**
 * 解析 Anthropic Messages API 响应 JSON：提取文本块、宽松解析 JSON 对象并汇总 token 用量。
 * @returns {{ data: object, text: string, model: string, stopReason: string|null, usage: { input: number, output: number, cached: number } }}
 */
function parseAnthropicResponse(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('Anthropic 接口返回了无效响应');
  }
  if (json.type === 'error' || json.error) {
    const errObj = json.error && typeof json.error === 'object' ? json.error : {};
    const detail = String(errObj.message || errObj.type || json.message || '').trim().slice(0, 240);
    throw new Error(detail ? `Anthropic 接口返回错误：${detail}` : 'Anthropic 接口返回错误');
  }

  let text = '';
  if (Array.isArray(json.content)) {
    text = json.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  } else if (typeof json.content === 'string') {
    text = json.content;
  }

  if (!text.trim()) {
    if (json.stop_reason === 'max_tokens') {
      throw new Error('模型输出被截断（内容过长），请缩短请求后重试');
    }
    throw new Error('Anthropic 接口没有返回内容');
  }

  let data;
  try {
    data = parseJsonLoose(text);
  } catch (e) {
    throw new Error(`模型返回内容无法解析：${e.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('模型返回的不是 JSON 对象');
  }

  const rawUsage = json.usage && typeof json.usage === 'object' ? json.usage : {};
  const usage = {
    input: num(rawUsage.input_tokens),
    output: num(rawUsage.output_tokens),
    cached: num(rawUsage.cache_read_input_tokens),
  };

  return {
    data,
    text,
    model: typeof json.model === 'string' ? json.model : '',
    stopReason: typeof json.stop_reason === 'string' ? json.stop_reason : null,
    usage,
  };
}

module.exports = {
  ANTHROPIC_VERSION,
  API_PRESETS,
  API_PRESETS_BY_ID,
  API_PRESET_MAP: API_PRESETS_BY_ID,
  getPreset,
  isLocalKeylessUrl,
  anthropicMessagesUrl,
  buildAnthropicHeaders,
  buildAnthropicRequest,
  parseAnthropicResponse,
};
