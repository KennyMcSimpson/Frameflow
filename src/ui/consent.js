// 视频站使用须知的同意（渲染端）。
// withConsent(fn)：先执行 fn；主进程报 NEED_CONSENT 时弹同意框，用户同意后记录（consent:grant）并重试一次；
// 用户拒绝时抛 code='CONSENT_DECLINED' 的错误，调用方静默忽略即可（isConsentDeclined）。
// 同意框由 dialogs/ConsentDialog.jsx 的 <ConsentHost /> 渲染；没挂载时退回系统确认框，保证功能可用。
import api from './api.js';
import useStore from './store.js';

export const CONSENT_VERSION = 1;

const listeners = new Set();
let pending = null; // { key, promise, resolve }

function snapshot() {
  return pending ? { key: pending.key } : null;
}

function emit() {
  const s = snapshot();
  listeners.forEach((fn) => { try { fn(s); } catch {} });
}

/** ConsentHost 订阅当前待确认的同意请求（null 表示没有） */
export function subscribeConsent(fn) {
  listeners.add(fn);
  fn(snapshot());
  return () => { listeners.delete(fn); };
}

/** 渲染端缓存的设置里是否已同意（主进程仍会再校验） */
export function hasConsentLocal(key = 'videoSites') {
  const s = useStore.getState().settings;
  const c = s && s.consent && s.consent[key];
  return !!(c && Number(c.version) >= CONSENT_VERSION);
}

async function grant(key) {
  try {
    await api.call('consent:grant', { key });
  } catch (e) {
    useStore.getState().toast?.('没能记录你的同意：' + ((e && e.message) || '未知原因'), 'error');
    return false;
  }
  try { await useStore.getState().refreshSettings?.(); } catch {}
  return true;
}

const FALLBACK_TEXT = [
  '使用"视频站解析"前，请阅读并同意：',
  '1. 视频站功能使用开源工具 yt-dlp，只用于你本人的学习与分析。',
  '2. 视频版权归原作者或平台所有。你需要已获授权或属于合理使用，并遵守网站的用户协议。',
  '3. 本软件不会绕过付费、会员、地区限制或版权保护，也不会去水印。',
  '4. 下载的内容会标记为「仅供学习」。公开发布、商用或二次传播的法律责任由你自己承担。',
  '',
  '点「确定」表示你已阅读并理解以上说明，承诺只在合法授权的范围内使用。',
].join('\n');

/** 弹出同意框；同意并记录成功返回 true，取消返回 false */
export function requestConsent(key = 'videoSites') {
  if (pending && pending.key === key) return pending.promise;
  if (!listeners.size) {
    // 同意框还没挂载：退回系统确认框
    const ok = typeof window !== 'undefined' && typeof window.confirm === 'function' && window.confirm(FALLBACK_TEXT);
    return ok ? grant(key) : Promise.resolve(false);
  }
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  pending = { key, promise, resolve };
  emit();
  return promise;
}

/** ConsentHost 调用：用户点了「同意并继续」(true) 或「取消」(false) */
export async function answerConsent(agreed) {
  const cur = pending;
  if (!cur) return false;
  const ok = agreed ? await grant(cur.key) : false;
  if (pending === cur) pending = null;
  emit();
  cur.resolve(ok);
  return ok;
}

function declinedError() {
  const e = new Error('你没有同意视频站使用须知，已取消');
  e.code = 'CONSENT_DECLINED';
  return e;
}

export function isConsentDeclined(e) {
  return !!(e && e.code === 'CONSENT_DECLINED');
}

/** 事先确认：本地已同意直接返回 true，否则弹框 */
export async function ensureConsent(key = 'videoSites') {
  if (hasConsentLocal(key)) return true;
  return requestConsent(key);
}

/** 执行 fn；遇到 NEED_CONSENT 弹同意框，同意后重试一次 */
export async function withConsent(fn, key = 'videoSites') {
  try {
    return await fn();
  } catch (e) {
    if (!e || e.code !== 'NEED_CONSENT') throw e;
    const ok = await requestConsent(e.consentKey || key);
    if (!ok) throw declinedError();
    return fn();
  }
}
