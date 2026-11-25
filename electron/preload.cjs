'use strict';
// 预加载脚本（沙箱模式）：只向页面暴露 window.ff 这一组受限接口，页面拿不到 ipcRenderer 和 Node。
const { contextBridge, ipcRenderer, webUtils, webFrame } = require('electron');

// 页面可以订阅的主进程事件
const EVENTS = new Set(['job:progress', 'job:done', 'job:error', 'app:flush', 'app:openFile', 'app:crashRecovered', 'project:externalChange']);

// 这两个事件可能在界面订阅之前就到了（页面刚载入、store 还没初始化）：先暂存，
// 有订阅者之后再补发，保证双击 .ffproj、崩溃恢复提示不会丢
const STICKY = ['app:openFile', 'app:crashRecovered'];
const stickyListeners = new Map(STICKY.map((ev) => [ev, new Set()]));
const stickyQueue = [];
let stickyTimer = null;

function dispatchSticky(event, data) {
  for (const cb of [...stickyListeners.get(event)]) {
    try { cb(data); } catch (e) { console.error(`[preload] 处理 ${event} 出错`, e); }
  }
}
function drainSticky() {
  stickyTimer = null;
  for (let i = 0; i < stickyQueue.length;) {
    const item = stickyQueue[i];
    if (stickyListeners.get(item.event).size) { stickyQueue.splice(i, 1); dispatchSticky(item.event, item.data); }
    else i++;
  }
}
for (const ev of STICKY) {
  ipcRenderer.on(ev, (_e, data) => {
    if (stickyListeners.get(ev).size) dispatchSticky(ev, data);
    else if (stickyQueue.length < 20) stickyQueue.push({ event: ev, data });
  });
}

// app:flush 的订阅数：告诉主进程界面能不能响应保存请求（没有订阅时关窗不用等）
let flushSubs = 0;

async function invoke(channel, payload) {
  if (typeof channel !== 'string' || !channel) throw new Error('无效的调用');
  const r = await ipcRenderer.invoke(channel, payload);
  if (r && r.ok) return r.data;
  const err = new Error((r && r.error) || '未知错误');
  if (r && r.code) err.code = r.code;
  throw err;
}

contextBridge.exposeInMainWorld('ff', {
  invoke,
  // AI 视频生成 / 语音识别 / 导出单帧便捷入口（渲染端统一走 src/ui/api.js）
  videogen: {
    providers: () => invoke('videogen:providers'),
    test: (provider) => invoke('videogen:test', { provider }),
    generate: (payload) => invoke('videogen:generate', payload),
    resume: (payload) => invoke('videogen:resume', payload),
  },
  asr: {
    status: () => invoke('asr:status'),
    transcribe: (payload) => invoke('asr:transcribe', payload),
    installModel: (payload) => invoke('asr:installModel', payload),
  },
  exportFrame: (payload) => invoke('export:frame', payload),
  on(event, cb) {
    if (!EVENTS.has(event)) throw new Error('不允许的事件: ' + event);
    if (typeof cb !== 'function') return () => {};
    if (stickyListeners.has(event)) {
      const set = stickyListeners.get(event);
      set.add(cb);
      if (!stickyTimer && stickyQueue.some((q) => q.event === event)) stickyTimer = setTimeout(drainSticky, 0);
      return () => { set.delete(cb); };
    }
    const listener = (_e, data) => cb(data);
    ipcRenderer.on(event, listener);
    if (event === 'app:flush' && ++flushSubs === 1) ipcRenderer.send('app:flushReady', true);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      ipcRenderer.removeListener(event, listener);
      if (event === 'app:flush' && --flushSubs === 0) ipcRenderer.send('app:flushReady', false);
    };
  },
  /** 回复主进程的保存请求：{ ok, id, error } */
  flushed(result) {
    const r = result && typeof result === 'object' ? result : {};
    const msg = { ok: r.ok !== false };
    if (Number.isFinite(r.id)) msg.id = r.id;
    if (typeof r.error === 'string' && r.error) msg.error = r.error.slice(0, 300);
    ipcRenderer.send('app:flushed', msg);
  },
  /** 拖进来的 File → 本机绝对路径，取不到时为 ''（Electron 32 起 File.path 已移除） */
  pathForFile(file) {
    try { return (webUtils && webUtils.getPathForFile(file)) || ''; } catch { return ''; }
  },
  mediaUrl(absPath) {
    if (!absPath) return '';
    return 'ffmedia://local/' + encodeURIComponent(absPath);
  },
  setZoomFactor(factor) {
    const n = Number(factor);
    if (Number.isFinite(n) && n >= 0.5 && n <= 2 && webFrame && typeof webFrame.setZoomFactor === 'function') {
      webFrame.setZoomFactor(n);
    }
  },
  platform: process.platform,
});
