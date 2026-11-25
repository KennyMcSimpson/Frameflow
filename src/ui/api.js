// 渲染端 IPC 包装。所有模块通过它访问主进程（SPEC §2）。
const ff = typeof window !== 'undefined' ? window.ff : null;

const waiters = new Map(); // jobId -> {resolve, reject, onProgress}
const early = new Map();   // 在拿到 jobId 之前就到达的完成/失败事件
const listeners = new Set(); // 全局任务监听（任务面板用）

function makeError(d) {
  const e = new Error(d.error || '任务失败');
  e.code = d.code || (d.cancelled ? 'CANCELLED' : null);
  e.cancelled = !!d.cancelled;
  return e;
}

function stash(type, d) {
  early.set(d.jobId, { type, d });
  const t = setTimeout(() => early.delete(d.jobId), 60000);
  if (t && typeof t.unref === 'function') t.unref();
}

if (ff) {
  ff.on('job:progress', (d) => {
    const w = waiters.get(d.jobId);
    if (w && w.onProgress) w.onProgress(d);
    listeners.forEach((l) => l('progress', d));
  });
  ff.on('job:done', (d) => {
    const w = waiters.get(d.jobId);
    if (w) { waiters.delete(d.jobId); w.resolve(d.result); } else stash('done', d);
    listeners.forEach((l) => l('done', d));
  });
  ff.on('job:error', (d) => {
    const w = waiters.get(d.jobId);
    if (w) { waiters.delete(d.jobId); w.reject(makeError(d)); } else stash('error', d);
    listeners.forEach((l) => l('error', d));
  });
}

export const api = {
  available: !!ff,

  /** 普通调用 */
  call(channel, payload) {
    if (!ff) return Promise.reject(new Error('不在桌面环境中运行'));
    return ff.invoke(channel, payload);
  },

  /**
   * 启动后台任务并等待结果。
   * @param {string} channel
   * @param {object} payload
   * @param {(p:{jobId,stage,progress,message})=>void} [onProgress]
   * @param {(jobId:string)=>void} [onStart] 拿到 jobId 时回调（用于取消）
   */
  async job(channel, payload, onProgress, onStart) {
    if (!ff) throw new Error('不在桌面环境中运行');
    const { jobId } = await ff.invoke(channel, payload);
    if (onStart) onStart(jobId);
    return new Promise((resolve, reject) => {
      const e = early.get(jobId);
      if (e) {
        early.delete(jobId);
        if (e.type === 'done') resolve(e.d.result); else reject(makeError(e.d));
        return;
      }
      waiters.set(jobId, { resolve, reject, onProgress });
    });
  },

  cancel(jobId) {
    if (!ff || !jobId) return Promise.resolve(false);
    return ff.invoke('job:cancel', { jobId });
  },

  /** 订阅所有任务事件：cb(type:'progress'|'done'|'error', data) */
  onJobs(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },

  mediaUrl(p) {
    if (!p) return '';
    if (/^(https?:|data:|blob:|ffmedia:)/.test(p)) return p;
    return ff ? ff.mediaUrl(p) : p;
  },

  /**
   * 主进程要求立即保存时调用 cb（关窗、关机前）。cb 返回 false 或抛错表示没保存成功，
   * 主进程会据此询问用户要不要直接关闭（契约 C14）；返回其它值都算成功。
   */
  onFlush(cb) {
    if (!ff) return () => {};
    return ff.on('app:flush', async (payload) => {
      let ok = true;
      let error;
      try {
        const r = await cb(payload);
        if (r === false) ok = false;
      } catch (e) {
        ok = false;
        error = (e && e.message) || String(e);
      } finally {
        try { ff.flushed({ ok, id: payload && payload.id, error }); } catch {}
      }
    });
  },

  /**
   * 订阅系统事件（契约 C13），返回取消订阅函数：
   * - 'app:openFile'       { path }：双击 .ffproj 或从命令行打开工程
   * - 'app:crashRecovered' { at, kind:'app'|'renderer', reason? }：上次没正常退出 / 界面刚从崩溃中恢复
   * 页面刚载入时就到达的事件会暂存，订阅后补发。
   */
  onAppEvent(name, cb) {
    if (!ff || typeof cb !== 'function') return () => {};
    try { return ff.on(name, cb) || (() => {}); } catch { return () => {}; }
  },

  /** 拖进来的文件 → 本机绝对路径，取不到时为 '' */
  pathForFile(file) {
    if (!ff || !file || typeof ff.pathForFile !== 'function') return '';
    try { return ff.pathForFile(file) || ''; } catch { return ''; }
  },

  /** 任务栏进度、闪烁和系统通知（契约 C19）：{ progress?:0–1 或 -1 清除, mode?, flash?, notify?:{title, body} } */
  taskbar(opts) {
    if (!ff) return Promise.resolve(false);
    return ff.invoke('app:taskbar', opts || {}).catch(() => false);
  },
};

// ---- PLAN-v3 §4：AI 真人视频生成 / 语音识别 / 导出单帧 ----
api.videogen = {
  /** -> [{id,label,vendor,caps,configured,priceHint,needs,keyUrl,defaultModel,isMock}] */
  providers: () => api.call('videogen:providers'),
  /** -> {ok, error?, ms?} */
  test: (provider) => api.call('videogen:test', { provider }),
  /**
   * 生成并等待结果 -> {asset, taskId, provider, shotId}
   * payload: {projectId, shotId?, provider, prompt, negative?, imageAssetId?, duration, ratio, res}
   * onProgress 的 meta.taskId 在提交后出现，可写入 shot.aiVideoTask 以便重启后 resume
   */
  generate: (payload, onProgress, onStart) => api.job('videogen:generate', payload, onProgress, onStart),
  /** 只启动任务，返回 {jobId}（结果通过 job 事件 / onJobs 获取） */
  start: (payload) => api.call('videogen:generate', payload),
  /** {projectId, tasks:[{shotId,provider,taskId,prompt}]} -> [{shotId,taskId,jobId|error}] */
  resume: (payload) => api.call('videogen:resume', payload),
};

api.asr = {
  /** -> {ready, engine, model, downloadable} */
  status: () => api.call('asr:status'),
  /** -> {segments:[{start,end,text,words?}]} */
  transcribe: (payload, onProgress, onStart) => api.job('asr:transcribe', payload, onProgress, onStart),
  installModel: (onProgress, onStart) => api.job('asr:installModel', {}, onProgress, onStart),
};

/** { projectId, t, data, outPath? } -> png 路径 */
api.exportFrame = (payload) => api.call('export:frame', payload);

export const videogen = api.videogen;
export const asr = api.asr;
export const exportFrame = api.exportFrame;

export default api;
