// 拆片库状态与动作：分析列表、当前分析、技法卡、串行任务队列、yt-dlp 安装、播放跳转请求。
// 拆片库在没有打开项目时也能使用，因此不依赖 useStore().project（只有「应用技法」需要）。
import { create } from 'zustand';
import api from '../../api.js';
import useStore from '../../store.js';
import { runAI, isNoAI } from '../../../ai/client.js';
import { buildAnalyzeRequest, mergeAnalyzeResponse } from '../../../ai/analyze.js';
import { localAnalyzeTechniques } from '../../../ai/localDirector.js';
import { techniqueToOps } from '../../../engine/techniques.js';
import { uid } from '../../../engine/ids.js';
import { withConsent, isConsentDeclined } from '../../consent.js';
import {
  normalizeAnalysis, attachTechniqueToAnalysis, sanitizeTechnique, mergeIds, detectPlatform,
} from './libraryUtils.js';

// 提示类型只有 info/success/warn/error；旧代码里的 'ok' 统一映射为 success
const toast = (msg, kind) => useStore.getState().toast(msg, kind === 'ok' ? 'success' : kind);

export const QUEUE_ACTIVE = ['running', 'ai', 'saving'];

let pumping = false;
let selectToken = 0;

export const useLibrary = create((set, get) => ({
  // 列表
  analyses: [],
  listLoading: false,
  listError: null,
  listLoaded: false,
  // 当前分析
  selectedId: null,
  current: null,
  currentLoading: false,
  currentError: null,
  // 当前分析中选中的镜头（供「手动新建技法卡」关联来源）
  focusShot: null, // { index, start, end }
  // 技法卡（用户 / 拆片生成）
  techniques: [],
  techLoading: false,
  techError: null,
  // 队列
  queue: [],
  // 添加选项（「添加拆片」与「主题学习」共用）
  options: { category: 'film', useAI: true, maxSeconds: 600 },
  // yt-dlp
  ytdlp: { checked: false, installed: false, version: '', path: '' },
  ytdlpInstall: { running: false, progress: 0, message: '', error: null, jobId: null },
  // 播放跳转请求（技法卡来源时间段 → 详情播放器）
  seekReq: null, // { analysisId, t, end, play, nonce }

  setOptions(patch) { set({ options: { ...get().options, ...patch } }); },
  setFocusShot(focusShot) {
    const cur = get().focusShot;
    if (cur && focusShot && cur.index === focusShot.index && cur.start === focusShot.start) return;
    set({ focusShot });
  },

  // ================= 初始化 =================
  async init() {
    await Promise.all([get().loadAnalyses(), get().loadTechniques(), get().checkYtdlp()]);
    const { selectedId, analyses } = get();
    if (!selectedId && analyses.length) get().selectAnalysis(analyses[0].id);
  },

  // ================= 分析列表 / 详情 =================
  async loadAnalyses() {
    set({ listLoading: true, listError: null });
    try {
      const list = await api.call('analysis:list');
      set({ analyses: Array.isArray(list) ? list : [], listLoading: false, listLoaded: true });
    } catch (e) {
      set({ listLoading: false, listLoaded: true, listError: '读取拆片列表失败：' + e.message });
    }
  },

  async selectAnalysis(id) {
    const token = ++selectToken;
    if (!id) { set({ selectedId: null, current: null, currentError: null, currentLoading: false, focusShot: null }); return null; }
    set({ selectedId: id, currentLoading: true, currentError: null, focusShot: null });
    try {
      const raw = await api.call('analysis:get', { id });
      if (token !== selectToken) return null;
      const current = normalizeAnalysis(raw);
      if (!current) throw new Error('分析数据为空');
      const paths = [current.assetPath, ...current.shots.flatMap((s) => [s.thumb, ...(s.keyframes || [])])].filter(Boolean);
      if (paths.length) await api.call('media:register', { paths }).catch(() => {});
      if (token !== selectToken) return null;
      set({ current, currentLoading: false });
      return current;
    } catch (e) {
      if (token !== selectToken) return null;
      set({ current: null, currentLoading: false, currentError: '打开分析失败：' + e.message });
      return null;
    }
  },

  async reloadCurrent() {
    const { selectedId } = get();
    if (selectedId) await get().selectAnalysis(selectedId);
  },

  async deleteAnalysis(id) {
    try {
      await api.call('analysis:delete', { id });
      const analyses = get().analyses.filter((a) => a.id !== id);
      set({ analyses });
      get().loadTechniques(); // 技法卡保留，但已断开与这条视频的链接
      if (get().selectedId === id) {
        const next = analyses[0];
        get().selectAnalysis(next ? next.id : null);
      }
      toast('已删除这条拆片记录', 'ok');
      return true;
    } catch (e) {
      toast('删除失败：' + e.message, 'error');
      return false;
    }
  },

  /** 本地更新当前分析并保存到库（用于手动关联技法等） */
  async saveCurrentAnalysis(patchFn) {
    const cur = get().current;
    if (!cur) return null;
    const next = patchFn(cur);
    if (!next) return null;
    try {
      const saved = await api.call('analysis:update', { analysis: next });
      const norm = normalizeAnalysis(saved || next);
      if (get().selectedId === cur.id) set({ current: norm });
      return norm;
    } catch (e) {
      toast('保存分析失败：' + e.message, 'error');
      return null;
    }
  },

  // ================= 技法卡 =================
  async loadTechniques() {
    set({ techLoading: true, techError: null });
    try {
      const list = await api.call('library:techniques', {});
      set({ techniques: Array.isArray(list) ? list.filter(Boolean) : [], techLoading: false });
    } catch (e) {
      set({ techLoading: false, techError: '读取技法卡失败：' + e.message });
    }
  },

  async saveTechnique(draft) {
    const technique = sanitizeTechnique(draft);
    try {
      const saved = (await api.call('library:saveTechnique', { technique })) || technique;
      const list = get().techniques;
      const idx = list.findIndex((t) => t.id === saved.id);
      const next = idx >= 0 ? list.map((t, i) => (i === idx ? saved : t)) : [saved, ...list];
      set({ techniques: next });
      // 关联到当前视频的新卡：写入 analysis.techniqueIds
      const cur = get().current;
      if (cur && saved.source && saved.source.analysisId === cur.id && !cur.techniqueIds.includes(saved.id)) {
        await get().saveCurrentAnalysis((a) => ({ ...a, techniqueIds: mergeIds(a.techniqueIds, [saved.id]) }));
        get().loadAnalyses();
      }
      toast(idx >= 0 ? '技法卡已更新' : '技法卡已保存', 'ok');
      return saved;
    } catch (e) {
      toast('保存技法卡失败：' + e.message, 'error');
      return null;
    }
  },

  async deleteTechnique(id) {
    try {
      await api.call('library:deleteTechnique', { id });
      set({ techniques: get().techniques.filter((t) => t.id !== id) });
      const cur = get().current;
      if (cur && cur.techniqueIds.includes(id)) {
        await get().saveCurrentAnalysis((a) => ({ ...a, techniqueIds: a.techniqueIds.filter((x) => x !== id) }));
      }
      get().loadAnalyses();
      toast('技法卡已删除', 'ok');
      return true;
    } catch (e) {
      toast('删除技法卡失败：' + e.message, 'error');
      return false;
    }
  },

  // ================= 播放跳转 =================
  requestSeek(analysisId, t, { end = null, play = true } = {}) {
    if (!analysisId) return;
    const req = { analysisId, t: Math.max(0, Number(t) || 0), end: Number.isFinite(Number(end)) ? Number(end) : null, play, nonce: Date.now() + Math.random() };
    set({ seekReq: req });
    if (get().selectedId !== analysisId) get().selectAnalysis(analysisId);
  },
  clearSeek(nonce) { if (get().seekReq && get().seekReq.nonce === nonce) set({ seekReq: null }); },

  // ================= yt-dlp =================
  async checkYtdlp() {
    try {
      const st = await api.call('web:ytdlpStatus');
      set({ ytdlp: { checked: true, installed: !!(st && st.installed), version: (st && st.version) || '', path: (st && st.path) || '' } });
    } catch {
      set({ ytdlp: { ...get().ytdlp, checked: true, installed: false } });
    }
    return get().ytdlp;
  },

  async installYtdlp() {
    if (get().ytdlpInstall.running) return false;
    set({ ytdlpInstall: { running: true, progress: 0, message: '正在连接下载服务器…', error: null, jobId: null } });
    try {
      const st = await api.job('web:ytdlpInstall', {}, (p) => {
        set({ ytdlpInstall: { ...get().ytdlpInstall, progress: p.progress || 0, message: p.message || p.stage || '下载中…' } });
      }, (jobId) => set({ ytdlpInstall: { ...get().ytdlpInstall, jobId } }));
      set({
        ytdlp: { checked: true, installed: !!(st && st.installed !== false), version: (st && st.version) || '', path: (st && st.path) || '' },
        ytdlpInstall: { running: false, progress: 1, message: '安装完成', error: null, jobId: null },
      });
      toast('下载组件 yt-dlp 已安装', 'ok');
      // 之前因缺少 yt-dlp 失败的任务自动重新排队
      const queue = get().queue.map((q) => (q.status === 'error' && q.needsYtdlp ? resetItem(q) : q));
      set({ queue });
      pump();
      return true;
    } catch (e) {
      const msg = e.cancelled ? '已取消安装' : '安装失败：' + e.message + '（请检查网络，或稍后重试）';
      set({ ytdlpInstall: { running: false, progress: 0, message: '', error: msg, jobId: null } });
      if (!e.cancelled) toast(msg, 'error');
      return false;
    }
  },

  cancelYtdlpInstall() {
    const { jobId } = get().ytdlpInstall;
    if (jobId) api.cancel(jobId);
  },

  // ================= 队列 =================
  /** 加入队列。items: [{ kind:'url'|'file', url?, path?, title?, category?, useAI?, maxSeconds? }] */
  enqueue(items) {
    const opts = get().options;
    const existing = new Set(get().queue.filter((q) => !['done', 'cancelled', 'error'].includes(q.status)).map((q) => q.url || q.path));
    const added = [];
    for (const it of items || []) {
      const key = it.url || it.path;
      if (!key || existing.has(key)) continue;
      existing.add(key);
      added.push({
        id: uid('lq'),
        kind: it.url ? 'url' : 'file',
        url: it.url || null,
        path: it.path || null,
        platform: it.url ? detectPlatform(it.url) : 'local',
        title: it.title || (it.path ? baseName(it.path) : it.url),
        titleHint: it.title || null,
        category: it.category || opts.category,
        useAI: it.useAI != null ? !!it.useAI : opts.useAI,
        maxSeconds: Number(it.maxSeconds) > 0 ? Number(it.maxSeconds) : opts.maxSeconds,
        status: 'waiting',
        stage: '排队中',
        progress: 0,
        message: '',
        error: null,
        notice: null,
        jobId: null,
        aiJobId: null,
        analysisId: null,
        cancelRequested: false,
        skipAIRequested: false,
        needsYtdlp: false,
        addedAt: Date.now(),
      });
    }
    if (added.length) {
      set({ queue: [...get().queue, ...added] });
      pump();
    }
    return added.length;
  },

  cancelItem(id) {
    const q = getItem(id);
    if (!q) return;
    if (q.status === 'waiting') { patchItem(id, { status: 'cancelled', stage: '已取消' }); return; }
    if (q.status === 'running') {
      patchItem(id, { cancelRequested: true, stage: '正在取消…' });
      if (q.jobId) api.cancel(q.jobId);
      return;
    }
    if (q.status === 'ai') {
      // AI 阶段「取消」= 跳过 AI，改用本地统计（分析本身已保存）
      patchItem(id, { skipAIRequested: true, stage: '正在跳过 AI…' });
      if (q.aiJobId) api.cancel(q.aiJobId);
    }
  },

  retryItem(id) {
    const q = getItem(id);
    if (!q || !['error', 'cancelled'].includes(q.status)) return;
    set({ queue: get().queue.map((x) => (x.id === id ? resetItem(x) : x)) });
    pump();
  },

  removeItem(id) {
    const q = getItem(id);
    if (!q || QUEUE_ACTIVE.includes(q.status)) return;
    set({ queue: get().queue.filter((x) => x.id !== id) });
  },

  clearFinished() {
    set({ queue: get().queue.filter((q) => !['done', 'cancelled'].includes(q.status)) });
  },
}));

// ------------------------------------------------------------------
// 队列内部
// ------------------------------------------------------------------
function baseName(p) {
  const s = String(p || '').split(/[\\/]/).pop() || '';
  return s.replace(/\.[^.]+$/, '') || s;
}

function getItem(id) { return useLibrary.getState().queue.find((q) => q.id === id) || null; }

function patchItem(id, patch) {
  useLibrary.setState((s) => ({ queue: s.queue.map((q) => (q.id === id ? { ...q, ...patch } : q)) }));
}

function resetItem(q) {
  return {
    ...q, status: 'waiting', stage: '排队中', progress: 0, message: '', error: null, notice: null, jobId: null, aiJobId: null,
    cancelRequested: false, skipAIRequested: false, needsYtdlp: false,
  };
}

/** 串行执行：一次只跑一个，避免机器过载 */
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const next = useLibrary.getState().queue.find((q) => q.status === 'waiting');
      if (!next) break;
      try {
        await runItem(next.id);
      } catch (e) {
        patchItem(next.id, { status: 'error', stage: '失败', error: e.message || String(e) });
      }
    }
  } finally {
    pumping = false;
  }
}

const STAGE_LABELS = {
  download: '下载视频', downloading: '下载视频', probe: '读取信息', proxy: '生成预览', scan: '逐帧找切点', scenes: '镜头切分', shots: '镜头切分',
  keyframes: '导出关键帧', stats: '色彩与运动统计', color: '色彩统计', audio: '声音与节拍', subtitles: '字幕', transcript: '字幕',
  contact: '生成联系表', sheets: '生成联系表', save: '保存', done: '完成',
};

/** 已用时：12 秒 / 1 分 05 秒 */
function fmtElapsed(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`;
}

async function runItem(id) {
  const item = getItem(id);
  if (!item) return;
  patchItem(id, { status: 'running', stage: '准备中', progress: 0, error: null, notice: null, startedAt: Date.now() });

  // 重试：视频分析已成功（只是技法保存失败），直接读取已有结果，避免重复分析产生两条记录
  if (item.analysisId) {
    let existing = null;
    try {
      existing = normalizeAnalysis(await api.call('analysis:get', { id: item.analysisId }));
    } catch {
      existing = null;
    }
    if (existing && existing.id) {
      patchItem(id, { stage: '读取已有分析', progress: 1 });
      await finishItem(id, item, existing);
      return;
    }
    patchItem(id, { analysisId: null }); // 记录已被删除：重新完整分析
  }

  // URL 方式需要 yt-dlp
  if (item.kind === 'url') {
    let yt = useLibrary.getState().ytdlp;
    if (!yt.checked || !yt.installed) yt = await useLibrary.getState().checkYtdlp();
    if (!yt.installed) {
      patchItem(id, { status: 'error', stage: '缺少下载组件', error: '尚未安装视频下载组件 yt-dlp。请点击「一键安装」，安装完成后会自动继续。', needsYtdlp: true });
      return;
    }
  }

  const payload = {
    category: item.category,
    useAI: item.useAI,
    maxSeconds: item.maxSeconds,
  };
  const title = item.titleHint || (item.kind === 'file' ? item.title : null);
  if (title) payload.title = title;
  if (item.kind === 'url') payload.url = item.url; else payload.path = item.path;

  let analysis;
  try {
    const start = () => api.job('analysis:start', payload, (p) => {
      const cur = getItem(id);
      if (!cur || cur.cancelRequested) return;
      const stage = STAGE_LABELS[p.stage] || p.stage || '分析中';
      patchItem(id, { stage, progress: Number(p.progress) || 0, message: p.message || '' });
    }, (jobId) => {
      patchItem(id, { jobId });
      const cur = getItem(id);
      if (cur && cur.cancelRequested) api.cancel(jobId);
    });
    // 视频站链接先过同意框（主进程报 NEED_CONSENT 时弹出，同意后自动重试）
    const raw = item.kind === 'url' ? await withConsent(start, 'videoSites') : await start();
    analysis = normalizeAnalysis(raw);
    if (!analysis || !analysis.id) throw new Error('分析结果为空');
  } catch (e) {
    const cur = getItem(id);
    if (isConsentDeclined(e)) {
      patchItem(id, { status: 'cancelled', stage: '未同意使用条款', jobId: null, progress: 0 });
    } else if (e.cancelled || (cur && cur.cancelRequested)) {
      patchItem(id, { status: 'cancelled', stage: '已取消', jobId: null, progress: 0 });
    } else {
      patchItem(id, { status: 'error', stage: '失败', error: e.message || '分析失败', jobId: null });
    }
    return;
  }
  patchItem(id, { analysisId: analysis.id, title: analysis.title || item.title, jobId: null });

  // 先刷新列表，让用户尽快看到
  useLibrary.getState().loadAnalyses();
  await finishItem(id, item, analysis);
}

/** 分析完成后的后半程：AI 标注 / 技法卡生成 / 保存 / 刷新 */
async function finishItem(id, item, analysis) {
  let finalAnalysis = analysis;
  let notice = null;
  try {
    const r = await annotate(id, analysis, item.useAI);
    finalAnalysis = r.analysis;
    notice = r.notice;
  } catch (e) {
    patchItem(id, { status: 'error', stage: '保存技法失败', error: e.message || '保存失败', analysisId: analysis.id });
    useLibrary.getState().loadAnalyses();
    return;
  }

  patchItem(id, { status: 'done', stage: '完成', progress: 1, notice, aiJobId: null });
  const lib = useLibrary.getState();
  await Promise.all([lib.loadAnalyses(), lib.loadTechniques()]);
  const st = useLibrary.getState();
  if (!st.selectedId || st.selectedId === finalAnalysis.id) st.selectAnalysis(finalAnalysis.id);
  toast(`拆片完成：${finalAnalysis.title}`, 'ok');
}

/**
 * AI 标注（可选）→ 技法卡生成 → 保存。返回 { analysis, notice }。
 * AI 不可用 / 失败 / 被跳过 → 本地统计生成技法卡，并在 analysis.errors 记录原因。
 */
async function annotate(id, analysis, useAI) {
  let merged = analysis;
  let techniques = [];
  let notice = null;
  let aiOk = false;

  if (useAI) {
    const aiStatus = useStore.getState().aiStatus;
    if (aiStatus && aiStatus.provider === 'local') {
      notice = 'AI 未连接，已基于统计生成技法';
    } else {
      patchItem(id, { status: 'ai', stage: 'AI 看关键帧标注', progress: 0, message: '' });
      try {
        const req = buildAnalyzeRequest({ analysis });
        const res = await runAI({ timeoutMs: 300000, ...req }, {
          onProgress: (p) => {
            const cur = getItem(id);
            if (!cur || cur.skipAIRequested) return;
            // 显示阶段 + 已用时；明显变慢时提示可以跳过
            const phase = (p && (p.phase || p.message)) || 'AI 正在观察关键帧';
            const took = p && Number(p.elapsedMs) > 0 ? ` · 已用时 ${fmtElapsed(p.elapsedMs)}` : '';
            const slow = p && p.slow ? '（比平时慢，可点「跳过 AI」改用本地统计）' : '';
            patchItem(id, { progress: Number(p && p.progress) || 0, message: phase + took + slow });
          },
          onStart: (jobId) => {
            patchItem(id, { aiJobId: jobId });
            const cur = getItem(id);
            if (cur && cur.skipAIRequested) api.cancel(jobId);
          },
        });
        const out = mergeAnalyzeResponse(analysis, res && res.data);
        merged = normalizeAnalysis(out && out.analysis) || analysis;
        techniques = (out && Array.isArray(out.techniques)) ? out.techniques.filter(Boolean) : [];
        aiOk = true;
      } catch (e) {
        const cur = getItem(id);
        if (isNoAI(e)) notice = 'AI 未连接，已基于统计生成技法';
        else if (e && (e.cancelled || (cur && cur.skipAIRequested))) notice = '已跳过 AI 标注，已基于统计生成技法';
        else notice = `AI 标注失败（${(e && e.message) || '未知错误'}），已基于统计生成技法`;
      }
    }
  }

  // 技法卡：AI 没给出 → 本地统计兜底（未开 AI 且主进程已生成过卡则不重复）
  if (!techniques.length) {
    const already = !useAI && merged.techniqueIds && merged.techniqueIds.length;
    if (!already) {
      try {
        techniques = (localAnalyzeTechniques(merged) || []).filter(Boolean);
      } catch (e) {
        techniques = [];
        notice = (notice ? notice + '；' : '') + '本地技法生成失败：' + e.message;
      }
    }
  }
  if (!aiOk && useAI && notice) {
    merged = { ...merged, errors: mergeIds(merged.errors || [], [notice]) };
  }

  patchItem(id, { status: 'saving', stage: '保存技法卡', progress: 0, message: '' });
  const savedIds = [];
  const failures = [];
  for (let i = 0; i < techniques.length; i++) {
    const t = attachTechniqueToAnalysis(techniques[i], merged);
    try {
      const saved = await api.call('library:saveTechnique', { technique: t });
      savedIds.push((saved && saved.id) || t.id);
    } catch (e) {
      failures.push(`「${t.title}」${e.message}`);
    }
    patchItem(id, { progress: (i + 1) / Math.max(1, techniques.length) });
  }
  if (failures.length && !savedIds.length && techniques.length) throw new Error('技法卡保存失败：' + failures.join('；'));
  if (failures.length) merged = { ...merged, errors: mergeIds(merged.errors || [], [`${failures.length} 张技法卡保存失败`]) };

  merged = { ...merged, techniqueIds: mergeIds(merged.techniqueIds || [], savedIds) };
  const saved = await api.call('analysis:update', { analysis: merged });
  return { analysis: normalizeAnalysis(saved || merged) || merged, notice };
}

// ------------------------------------------------------------------
// 应用技法到精修
// ------------------------------------------------------------------
/** 是否可以把技法应用到时间线（返回 null 表示可以，否则返回原因） */
export function applyBlocker() {
  const st = useStore.getState();
  if (!st.project) return '先打开项目，在精修里选中要套用的片段';
  if (!st.selection || !st.selection.clipIds || !st.selection.clipIds.length) return '先在精修的时间线上选中要套用的片段';
  return null;
}

export function techniqueOps(t) {
  try { return techniqueToOps(t) || []; } catch { return []; }
}

export function applyTechnique(t) {
  const ops = techniqueOps(t);
  if (!ops.length) {
    toast('这张技法卡没有可自动执行的操作，请按步骤手动完成', 'warn');
    return false;
  }
  const blocker = applyBlocker();
  if (blocker) { toast(blocker, 'warn'); return false; }
  const st = useStore.getState();
  const n = st.selection.clipIds.length;
  const r = st.commit(ops, '应用技法：' + t.title);
  if (r.ok) toast(`已把「${t.title}」应用到 ${n} 个片段，可在精修中撤销`, 'ok');
  return r.ok;
}

export default useLibrary;
