'use strict';
// 后台任务：进度、取消、结果推送。
// 每个任务的开始/完成/失败/取消和耗时都写进日志（log.cjs），方便排查用户反馈。
const crypto = require('node:crypto');
const log = require('./log.cjs');

class CancelledError extends Error {
  constructor() { super('已取消'); this.code = 'CANCELLED'; }
}

function createJobs(send) {
  const jobs = new Map();

  function start(kind, fn, meta = {}) {
    const jobId = 'job_' + crypto.randomBytes(6).toString('hex');
    const controller = new AbortController();
    const startedAt = Date.now();
    const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    const job = {
      id: jobId,
      kind,
      meta,
      startedAt,
      signal: controller.signal,
      cancelled: false,
      progress(stage, progress = 0, message = '') {
        if (job.cancelled) return;
        send('job:progress', { jobId, kind, stage, progress: Math.max(0, Math.min(1, Number(progress) || 0)), message, meta });
      },
      throwIfCancelled() {
        if (job.cancelled || controller.signal.aborted) throw new CancelledError();
      },
      cancel() {
        job.cancelled = true;
        controller.abort();
      },
    };
    jobs.set(jobId, job);
    log.info(`[job ${kind}] 开始`, jobId);
    // 延迟一拍，保证渲染端先拿到 jobId 再收事件
    setImmediate(async () => {
      try {
        const result = await fn(job);
        if (job.cancelled) throw new CancelledError();
        log.info(`[job ${kind}] 完成`, jobId, elapsed());
        send('job:done', { jobId, kind, result, meta });
      } catch (err) {
        const cancelled = job.cancelled || (err && err.code === 'CANCELLED');
        if (cancelled) log.info(`[job ${kind}] 已取消`, jobId, elapsed());
        else log.error(`[job ${kind}] 失败`, jobId, elapsed(), err);
        const rawErr = (err && err.message) ? String(err.message) : String(err);
        send('job:error', { jobId, kind, error: cancelled ? '已取消' : log.redact(rawErr), code: err && err.code, cancelled, meta });
      } finally {
        jobs.delete(jobId);
      }
    });
    return { jobId };
  }

  function cancel(jobId) {
    const job = jobs.get(jobId);
    if (job) job.cancel();
    return !!job;
  }

  function get(jobId) { return jobs.get(jobId) || null; }

  /** 还在进行（没被取消）的任务：[{ id, kind, meta, startedAt }]，关窗前提醒用 */
  function list() {
    return [...jobs.values()].filter((j) => !j.cancelled).map((j) => ({ id: j.id, kind: j.kind, meta: j.meta, startedAt: j.startedAt }));
  }

  /** 取消全部任务（退出时调用），返回取消的个数 */
  function cancelAll() {
    let n = 0;
    for (const job of jobs.values()) {
      if (job.cancelled) continue;
      try { job.cancel(); n++; } catch {}
    }
    if (n) log.info(`[job] 退出前取消了 ${n} 个任务`);
    return n;
  }

  return { start, cancel, get, list, cancelAll, CancelledError };
}

module.exports = { createJobs, CancelledError };
