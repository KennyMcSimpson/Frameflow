'use strict';
// 视频站使用须知的同意状态。
// settings 里存 consent.<key> = { version, at }；版本号升级后需要重新同意。
// 主进程所有会访问视频站的入口（视频站搜索、视频站链接下载、带链接的视频分析）在联网之前调用 requireConsent。

const CONSENT_VERSION = 1;

/** 已知的同意项 */
const CONSENT_KEYS = ['videoSites'];

const NEED_CONSENT_MESSAGE = {
  videoSites: '使用视频站功能前，请先阅读并同意使用须知',
};

function hasConsent(settings, key = 'videoSites') {
  const c = settings && settings.consent && settings.consent[key];
  return !!(c && Number(c.version) >= CONSENT_VERSION);
}

/** 未同意时抛 code='NEED_CONSENT' 的错误（渲染端 withConsent 会弹同意框后重试） */
function requireConsent(settings, key = 'videoSites') {
  if (hasConsent(settings, key)) return true;
  const err = new Error(NEED_CONSENT_MESSAGE[key] || '请先阅读并同意使用须知');
  err.code = 'NEED_CONSENT';
  err.consentKey = key;
  throw err;
}

function grantConsent(settingsStore, key = 'videoSites') {
  const k = CONSENT_KEYS.includes(key) ? key : null;
  if (!k) {
    const err = new Error('未知的同意项');
    err.code = 'BAD_CONSENT_KEY';
    throw err;
  }
  const rec = { version: CONSENT_VERSION, at: new Date().toISOString() };
  if (settingsStore && typeof settingsStore.set === 'function') settingsStore.set({ consent: { [k]: rec } });
  return { key: k, ...rec };
}

/** 撤回同意（设置里可用；目前只清掉版本号） */
function revokeConsent(settingsStore, key = 'videoSites') {
  if (!CONSENT_KEYS.includes(key)) return false;
  if (settingsStore && typeof settingsStore.set === 'function') settingsStore.set({ consent: { [key]: { version: 0, at: new Date().toISOString() } } });
  return true;
}

function consentStatus(settings) {
  const out = {};
  for (const k of CONSENT_KEYS) out[k] = hasConsent(settings, k);
  return out;
}

module.exports = { CONSENT_VERSION, CONSENT_KEYS, hasConsent, requireConsent, grantConsent, revokeConsent, consentStatus };
