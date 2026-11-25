// 全局状态（zustand）。所有 UI 模块通过 useStore 读取/修改。SPEC §8。
// 规则：
//  - 时间线/素材等「可撤销」修改：store.commit(ops | (project)=>newProject, label)
//  - 不需要撤销的修改（聊天记录、分镜参考结果、简报文字等也可撤销，按需）：store.update(fn)
//  - 每次修改后自动保存（800ms 防抖）
import { create } from 'zustand';
import api from './api.js';
import { applyOps, describeOp } from '../engine/ops.js';
import { normalizeProject } from '../engine/model.js';
import { migrateShotCaptions } from '../engine/firstcut.js';
import { loadProject } from '../engine/migrations.js';
import { applyShortcutSettings } from './shortcuts/customKeys.js';

const HISTORY_LIMIT = 100;
let saveTimer = null;
let toastSeq = 1;
let uiPersistTimer = null;
let saveRetry = 0;
let saveRetryTimer = null;
let inFlightSave = null;
let inFlightProject = null;
let appEventsBound = false;
let lastApply = { key: null, at: 0 };
const SAVE_BACKOFF = [2000, 5000, 15000];
const MERGE_WINDOW = 600;

/** 在 Node 测试环境下释放定时器引用，避免进程挂起等待 */
function unref(t) {
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

function applyUiScale(settings) {
  const raw = Number(settings && settings.ui && settings.ui.scale);
  const scale = Number.isFinite(raw) && raw >= 0.75 && raw <= 1.5 ? raw : 1;
  if (typeof window !== 'undefined' && window.ff && typeof window.ff.setZoomFactor === 'function') {
    try { window.ff.setZoomFactor(scale); } catch {}
  }
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.style.zoom = '';
    document.documentElement.style.setProperty('--ui-scale', String(scale));
  }
}

function applySettingsSideEffects(settings) {
  try { applyShortcutSettings(settings); } catch {}
  try { applyUiScale(settings); } catch {}
}

// ---- 不进撤销历史的数据 ----
// 这些字段由 update() 写入（AI 对话、项目名、风格指南与记忆、分镜参考结果、素材的离线标记和色彩统计、
// AI 视频生成进度）。撤销/重做还原的是整份工程快照，如果原样还原，会把它们一起退回旧值，
// 撤销后再编辑一步就永久丢失。所以还原时保留当前值，只有被撤销的那一步自己改过的字段才跟着还原。
const KEEP_PATHS = [['name'], ['chats'], ['memory', 'styleGuide'], ['memory', 'decisions'], ['memory', 'colorBaseline'], ['references']];
const KEEP_ASSET_KEYS = ['offline', 'missing', 'stats'];
const getPath = (obj, path) => path.reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), obj);
function setPath(obj, path, value) {
  const [head, ...rest] = path;
  const base = obj && typeof obj === 'object' ? obj : {};
  return { ...base, [head]: rest.length ? setPath(base[head], rest, value) : value };
}

/** 一次可撤销提交改动了哪些「不进历史」的字段（撤销这一步时，这些字段要跟着还原） */
export function touchedKeepPaths(before, after) {
  if (!before || !after) return [];
  const out = KEEP_PATHS.filter((p) => getPath(before, p) !== getPath(after, p)).map((p) => p.join('.'));
  if (before.storyboard !== after.storyboard) out.push('storyboard');
  return out;
}

/**
 * 撤销/重做时把快照 target 还原出来，但「不进历史」的字段沿用 current 的值。
 * touched：被撤销/重做的那一步自己改过的字段（touchedKeepPaths 的结果），这些按快照还原。
 * 素材只同步标记，不把快照里没有的素材加回来（撤销「导入素材」仍然会移除素材）。
 */
export function carryNonHistory(target, current, touched = []) {
  if (!target || !current || target === current) return target;
  const skip = new Set(touched || []);
  let out = target;
  for (const path of KEEP_PATHS) {
    if (skip.has(path.join('.'))) continue;
    const v = getPath(current, path);
    if (getPath(out, path) !== v) out = setPath(out, path, v);
  }
  const ta = out.assets || {};
  const ca = current.assets || {};
  let assets = null;
  for (const id of Object.keys(ta)) {
    const a = ta[id];
    const c = ca[id];
    if (!a || !c || a === c) continue;
    let na = null;
    for (const k of KEEP_ASSET_KEYS) {
      if (a[k] === c[k]) continue;
      na = na || { ...a };
      if (c[k] === undefined) delete na[k]; else na[k] = c[k];
    }
    if (na) { assets = assets || { ...ta }; assets[id] = na; }
  }
  if (assets) out = { ...out, assets };
  if (!skip.has('storyboard') && Array.isArray(out.storyboard) && Array.isArray(current.storyboard) && out.storyboard !== current.storyboard) {
    const cur = new Map(current.storyboard.map((s) => [s && s.id, s]));
    let changed = false;
    const storyboard = out.storyboard.map((s) => {
      const c = s && cur.get(s.id);
      if (!c || c.aiVideoTask === s.aiVideoTask) return s;
      changed = true;
      return { ...s, aiVideoTask: c.aiVideoTask === undefined ? null : c.aiVideoTask };
    });
    if (changed) out = { ...out, storyboard };
  }
  return out;
}

export const DEFAULT_ONBOARDING = { create: false, refine: false, library: false };
export const DEFAULT_LAYOUT = { refineLeft: 300, refineRight: 320, timelineH: 280, createChatCollapsed: false };
const EMPTY_SEL = { clipIds: [], textId: null, audioId: null, shotId: null, kind: null, id: null };

/** 去掉选择里已经不存在的对象（被 AI、联动删除、波纹删除或撤销移除的镜头/文字/音频/画中画/标记） */
function liveSelection(sel, project) {
  const s = sel || EMPTY_SEL;
  const tracks = (project && project.tracks) || {};
  const has = (list, id) => Array.isArray(list) && list.some((x) => x && x.id === id);
  const clipIds = (s.clipIds || []).filter((id) => has(tracks.video, id));
  let { textId, audioId, shotId, kind, id } = s;
  if (textId && !has(tracks.text, textId)) textId = null;
  if (audioId && !has(tracks.audio, audioId)) audioId = null;
  if (shotId && !has(project && project.storyboard, shotId)) shotId = null;
  if (id) {
    const alive = kind === 'text' || kind === 'caption' ? has(tracks.text, id)
      : kind === 'audio' ? has(tracks.audio, id)
        : kind === 'overlay' ? has(project && project.overlays, id)
          : kind === 'marker' ? has(project && project.markers, id)
            : kind === 'shot' ? has(project && project.storyboard, id)
              : true;
    if (!alive) { id = null; kind = null; }
  }
  if (kind === 'clip' && !clipIds.length) kind = null;
  const same = clipIds.length === (s.clipIds || []).length && textId === s.textId && audioId === s.audioId && shotId === s.shotId && kind === s.kind && id === s.id;
  return same ? s : { ...s, clipIds, textId, audioId, shotId, kind, id };
}

/** 从 settings.ui 读取界面持久化字段（容错：字段缺省或类型不对时回落默认值） */
function readUi(settings) {
  const ui = (settings && settings.ui) || {};
  const ob = ui.onboarding && typeof ui.onboarding === 'object'
    ? ui.onboarding
    : (ui.onboarded === true ? { create: true, refine: true, library: true } : {}); // 旧版已完成引导的用户不再打扰
  const ly = ui.layout && typeof ui.layout === 'object' ? ui.layout : {};
  const layout = { ...DEFAULT_LAYOUT };
  for (const k of Object.keys(DEFAULT_LAYOUT)) {
    if (typeof DEFAULT_LAYOUT[k] === 'number' && Number.isFinite(ly[k])) layout[k] = ly[k];
    if (typeof DEFAULT_LAYOUT[k] === 'boolean' && typeof ly[k] === 'boolean') layout[k] = ly[k];
  }
  return {
    onboarding: { create: !!ob.create, refine: !!ob.refine, library: !!ob.library },
    layout,
    drawer: ui.drawer === 'ai' || ui.drawer === 'brief' ? ui.drawer : null,
  };
}

export const useStore = create((set, get) => ({
  // ---- 应用级 ----
  ready: false,
  appInfo: null,
  settings: null,
  aiStatus: null,
  projectList: [],
  dialogs: { settings: false, export: false, help: false, newProject: false, shortcuts: false },
  toasts: [],
  // 界面持久化（PLAN-v3 §6，写入 settings.ui）
  onboarding: { ...DEFAULT_ONBOARDING },
  layout: { ...DEFAULT_LAYOUT },
  drawer: null, // 'ai' | 'brief' | null
  jobsOpen: false,
  jobs: {}, // jobId -> { jobId, kind, label, stage, progress, message, status:'running'|'done'|'error' }

  // ---- 项目级 ----
  project: null,
  mode: 'create', // 'create' | 'refine' | 'library'
  selection: { ...EMPTY_SEL },
  range: null,  // 时间线框选 {start, end}
  focus: null,  // 聚焦精修 {start, end}
  playhead: 0,
  playing: false,
  timelineZoom: 60, // 像素/秒
  past: [],
  future: [],
  saveState: 'saved', // 'saved' | 'dirty' | 'saving' | 'error'
  lastSavedAt: null,

  // ================= 初始化 =================
  async init() {
    try {
      const [appInfo, settings, projectList] = await Promise.all([
        api.call('app:info').catch(() => null),
        api.call('settings:get').catch(() => null),
        api.call('project:list').catch(() => []),
      ]);
      applySettingsSideEffects(settings);
      set({ appInfo, settings, projectList, ...readUi(settings), ready: true });
      get().refreshAI();
      const lastId = settings && settings.ui && settings.ui.lastProjectId;
      if (settings && settings.general && settings.general.openLastProject && lastId && !get().project
        && Array.isArray(projectList) && projectList.some((p) => p && p.id === lastId)) {
        get().openProject(lastId).catch(() => {});
      }
    } catch (e) {
      set({ ready: true });
      get().toast('初始化失败：' + e.message, 'error');
    }
    if (!appEventsBound) {
      appEventsBound = true;
      api.onFlush(() => get().saveNow());
      if (typeof api.onAppEvent === 'function') {
        api.onAppEvent('app:openFile', async (payload) => {
          const filePath = payload && payload.path;
          if (!filePath) return;
          try {
            if (get().project && get().saveState === 'dirty') await get().saveNow();
            const imported = await api.call('project:importJson', { path: filePath });
            if (!imported) throw new Error('文件里没有可用的项目数据');
            await get().refreshProjects();
            const exists = imported.id && get().projectList.some((p) => p && p.id === imported.id);
            if (exists) await get().openProject(imported.id);
            else {
              await get().newProject({ project: imported, name: imported.name });
              const paths = Object.values(imported.assets || {}).map((a) => a && a.path).filter(Boolean);
              if (paths.length) await api.call('media:register', { paths }).catch(() => {});
            }
            get().toast(`已打开项目「${imported.name || '未命名项目'}」`, 'ok');
          } catch (e) {
            get().toast('打开项目文件失败：' + ((e && e.message) || String(e)), 'error', 6000);
          }
        });
        api.onAppEvent('app:crashRecovered', (info) => {
          const isRenderer = info && info.kind === 'renderer';
          const msg = isRenderer
            ? '界面刚从意外退出中恢复，已保留最近一次自动保存的进度'
            : '上次镜流没有正常退出，已恢复到最近一次自动保存的进度';
          get().toast(msg, 'warn', 7000, { key: 'crash-recovered' });
        });
      }
    }
  },

  async refreshAI() {
    try { set({ aiStatus: await api.call('ai:status') }); } catch { set({ aiStatus: { provider: 'local', ready: false, detail: '无法读取 AI 状态' } }); }
  },
  async refreshSettings() {
    try {
      const settings = await api.call('settings:get');
      applySettingsSideEffects(settings);
      set({ settings });
    } catch {}
  },
  async refreshProjects() {
    try { set({ projectList: await api.call('project:list') }); } catch {}
  },

  // ================= 项目打开/新建 =================
  async openProject(id) {
    const raw = await api.call('project:load', { id });
    const loaded = loadProject(raw);
    const project = migrateShotCaptions(loaded.project);
    const migrated = loaded.migrated || project !== loaded.project;
    const repairs = Array.isArray(loaded.repairs) ? loaded.repairs : [];
    const paths = Object.values(project.assets).map((a) => a.path).filter(Boolean);
    if (paths.length) await api.call('media:register', { paths }).catch(() => {});
    const lastProjectId = project.id || id;
    const curSettings = get().settings;
    const nextSettings = { ...(curSettings || {}), ui: { ...((curSettings && curSettings.ui) || {}), lastProjectId } };
    set({ project, settings: nextSettings, past: [], future: [], selection: { ...EMPTY_SEL }, range: null, focus: null, playhead: 0, playing: false, saveState: 'saved', mode: project.tracks.video.length ? 'refine' : 'create' });
    if (migrated) get().scheduleSave();
    if (repairs.length) {
      const preview = repairs.slice(0, 2).join('；') + (repairs.length > 2 ? ` 等 ${repairs.length} 项` : '');
      get().toast(`已自动修复项目中的异常数据：${preview}`, 'warn', 6000);
    }
    api.call('settings:set', { ui: { lastProjectId } }).catch(() => {});
    return project;
  },

  async newProject({ name, aspect, fps, project: seed } = {}) {
    const created = await api.call('project:create', { name: name || '未命名项目', project: seed ? { ...seed, name: name || seed.name } : undefined, aspect });
    const validFps = Number.isFinite(Number(fps)) && Number(fps) >= 12 && Number(fps) <= 60 ? Number(fps) : undefined;
    const project = normalizeProject({
      ...created,
      settings: {
        ...(created.settings || {}),
        aspect: aspect || (created.settings && created.settings.aspect),
        ...(validFps ? { fps: validFps } : {}),
      },
    });
    const lastProjectId = project.id;
    const curSettings = get().settings;
    const nextSettings = { ...(curSettings || {}), ui: { ...((curSettings && curSettings.ui) || {}), lastProjectId } };
    set({ project, settings: nextSettings, past: [], future: [], selection: { ...EMPTY_SEL }, range: null, focus: null, playhead: 0, playing: false, mode: project.tracks.video.length ? 'refine' : 'create' });
    get().scheduleSave(0);
    get().refreshProjects();
    api.call('settings:set', { ui: { lastProjectId } }).catch(() => {});
    return project;
  },

  /**
   * 保存并关闭工程（契约 C14）。保存失败时不关闭：内存里的工程是唯一副本，
   * 弹出带「仍然关闭」按钮的提示并返回 false；force 为 true 时不管成败都关闭。
   * @returns {Promise<boolean>} 是否真的关闭了
   */
  async closeProject({ force = false } = {}) {
    const ok = await get().saveNow();
    if (ok === false && !force) {
      get().toast('项目还没保存成功，先不关闭。请检查磁盘空间后按 Ctrl+S 重试；如果确定不要这些修改，可以仍然关闭', 'error', 15000, {
        key: 'close-save-failed',
        action: { label: '仍然关闭', run: () => get().closeProject({ force: true }) },
      });
      return false;
    }
    clearTimeout(saveRetryTimer);
    saveRetry = 0;
    set({ project: null, playing: false, saveState: 'saved' });
    get().refreshProjects();
    return true;
  },

  setMode(mode) { set({ mode, playing: false }); },

  // ================= 修改 =================
  /**
   * 可撤销提交。
   * @param {Array|Function} opsOrFn  Op[]（走 engine applyOps，原子）或 (project)=>newProject
   * @param {string} label 历史标签（中文）
   * @param {{ctx?:object, silent?:boolean}} [opts]
   * @returns {{ok:boolean, applied:string[], errors:string[]}}
   */
  commit(opsOrFn, label = '修改', opts = {}) {
    const { project, selection, range, playhead } = get();
    if (!project) return { ok: false, applied: [], errors: ['没有打开的项目'] };
    let next; let applied = []; let errors = [];
    if (typeof opsOrFn === 'function') {
      try { next = opsOrFn(project); } catch (e) { errors = [e.message]; }
      if (!next) return { ok: false, applied, errors: errors.length ? errors : ['修改失败'] };
      applied = [label];
    } else {
      const ctx = { selectedClipIds: selection.clipIds, range, playhead, ...(opts.ctx || {}) };
      const r = applyOps(project, opsOrFn || [], ctx);
      if (!r.ok) {
        if (!opts.silent) get().toast(`未修改：${(r.errors || []).join('；') || '操作无效'}`, 'error');
        return { ok: false, applied: [], errors: r.errors || [] };
      }
      next = r.project; applied = r.applied || [];
    }
    next = { ...next, updatedAt: new Date().toISOString() };
    const now = Date.now();
    const mergeKey = opts.mergeKey || null;
    const prevTop = get().past[get().past.length - 1];
    const merge = !!(mergeKey && prevTop && lastApply.key === mergeKey && now - lastApply.at < MERGE_WINDOW);
    lastApply = { key: mergeKey, at: now };
    const touched = touchedKeepPaths(project, next);
    const past = merge
      ? [...get().past.slice(0, -1), { ...prevTop, label, touched: Array.from(new Set([...(prevTop.touched || []), ...touched])) }]
      : [...get().past, { project, label, selection, touched }].slice(-HISTORY_LIMIT);
    set({ project: next, past, future: [], selection: liveSelection(get().selection, next) });
    get().scheduleSave();
    return { ok: true, applied, errors: [] };
  },

  /** 不进历史的修改（聊天记录、参考结果、任务产物等） */
  update(fn) {
    const { project } = get();
    if (!project) return;
    const next = fn(project);
    if (!next || next === project) return;
    set({ project: { ...next, updatedAt: new Date().toISOString() } });
    get().scheduleSave();
  },

  /**
   * 单个 op 的可撤销提交（PLAN-v3 §3）。label 缺省用 describeOp 生成中文描述；
   * 相同 mergeKey 且间隔 <600ms 的连续调用合并为一步（拖动滑杆等）。
   */
  apply(op, { label, mergeKey, ctx, silent } = {}) {
    const project = get().project;
    if (!op) return { ok: false, applied: [], errors: ['空操作'] };
    let lbl = label;
    if (!lbl) { try { lbl = describeOp(op, project); } catch { lbl = '修改'; } }
    return get().commit(Array.isArray(op) ? op : [op], lbl || '修改', { mergeKey, ctx, silent });
  },

  undoLabel() { const p = get().past; return p.length ? p[p.length - 1].label : null; },
  redoLabel() { const f = get().future; return f.length ? f[0].label : null; },

  undo() {
    const { past, project, future, selection } = get();
    if (!past.length || !project) return false;
    const prev = past[past.length - 1];
    lastApply = { key: null, at: 0 };
    const restored = carryNonHistory(prev.project, project, prev.touched);
    set({
      project: restored,
      selection: liveSelection(prev.selection ? { ...EMPTY_SEL, ...prev.selection } : selection, restored),
      past: past.slice(0, -1),
      future: [{ project, label: prev.label, selection, touched: prev.touched }, ...future].slice(0, HISTORY_LIMIT),
    });
    get().scheduleSave();
    get().toast(`已撤销：${prev.label}`);
    return true;
  },

  redo() {
    const { past, project, future, selection } = get();
    if (!future.length || !project) return false;
    const nxt = future[0];
    lastApply = { key: null, at: 0 };
    const restored = carryNonHistory(nxt.project, project, nxt.touched);
    set({
      project: restored,
      selection: liveSelection(nxt.selection ? { ...EMPTY_SEL, ...nxt.selection } : selection, restored),
      future: future.slice(1),
      past: [...past, { project, label: nxt.label, selection, touched: nxt.touched }].slice(-HISTORY_LIMIT),
    });
    get().scheduleSave();
    get().toast(`已重做：${nxt.label}`);
    return true;
  },

  // ================= 保存 =================
  scheduleSave(delay = 800) {
    set({ saveState: 'dirty' });
    clearTimeout(saveTimer);
    const s = get().settings;
    if (delay !== 0 && s && s.general && s.general.autosave === false) return;
    saveTimer = unref(setTimeout(() => get().saveNow(), delay));
  },

  /** 立即保存（契约 C14）。串行化并发保存，避免重叠写入竞态。@returns {Promise<boolean>} 已写入磁盘或没有要保存的内容为 true，保存失败为 false（不抛错） */
  async saveNow() {
    clearTimeout(saveTimer);
    if (inFlightSave) {
      const cur = get().project;
      if (!cur) return true;
      if (inFlightProject === cur) return inFlightSave;
      await inFlightSave.catch(() => false);
      return get().saveNow();
    }
    const { project } = get();
    if (!project) return true;
    clearTimeout(saveRetryTimer);
    set({ saveState: 'saving' });
    inFlightProject = project;
    const run = (async () => {
      try {
        await api.call('project:save', { project });
        if (saveRetry > 0) get().toast('已重新保存成功', 'ok', 1800);
        saveRetry = 0;
        if (get().project === project || get().project?.id === project.id) set({ saveState: get().project === project ? 'saved' : 'dirty', lastSavedAt: Date.now() });
        return true;
      } catch (e) {
        // 保存期间工程已被关掉或换成别的工程：不再改状态，也不安排重试
        if (!get().project || get().project.id !== project.id) return false;
        set({ saveState: 'error' });
        // 退避重试：2s / 5s / 15s，之后停止自动重试，等待用户 Ctrl+S
        if (saveRetry < SAVE_BACKOFF.length) {
          const wait = SAVE_BACKOFF[saveRetry];
          saveRetry += 1;
          get().toast(`保存失败：${e.message}。${Math.round(wait / 1000)} 秒后自动重试（第 ${saveRetry}/${SAVE_BACKOFF.length} 次）`, 'warn', Math.min(wait, 5000));
          saveRetryTimer = unref(setTimeout(() => { if (get().project) get().saveNow(); }, wait));
        } else {
          saveRetry = 0;
          get().toast('多次保存失败：' + e.message + '。修改仍在内存中，请检查磁盘空间后按 Ctrl+S 重试', 'error', 8000);
        }
        return false;
      } finally {
        if (inFlightSave === run) {
          inFlightSave = null;
          inFlightProject = null;
        }
      }
    })();
    inFlightSave = run;
    return run;
  },

  // ================= 界面持久化（settings.ui） =================
  persistUi(delay = 400) {
    clearTimeout(uiPersistTimer);
    uiPersistTimer = unref(setTimeout(() => {
      const { onboarding, layout, drawer, settings } = get();
      const uiPatch = { onboarding, layout, drawer };
      const ui = { ...((settings && settings.ui) || {}), ...uiPatch };
      set({ settings: { ...(settings || {}), ui } });
      api.call('settings:set', { ui: uiPatch }).catch(() => {});
    }, delay));
  },
  setOnboarding(mode, done = true) {
    set({ onboarding: { ...get().onboarding, [mode]: !!done } });
    get().persistUi(0);
  },
  resetOnboarding() {
    set({ onboarding: { ...DEFAULT_ONBOARDING } });
    get().persistUi(0);
  },
  setLayout(patch) {
    set({ layout: { ...get().layout, ...(patch || {}) } });
    get().persistUi();
  },
  setDrawer(drawer) {
    const next = drawer === get().drawer ? null : drawer;
    set({ drawer: next === 'ai' || next === 'brief' ? next : null });
    get().persistUi();
  },
  setJobsOpen(open) { set({ jobsOpen: !!open }); },

  // ================= 选择 / 播放 =================
  select(clipIds, { additive = false } = {}) {
    const cur = get().selection.clipIds;
    const ids = Array.isArray(clipIds) ? clipIds : [clipIds].filter(Boolean);
    const next = additive ? Array.from(new Set([...cur, ...ids])) : ids;
    set({ selection: { ...get().selection, clipIds: next, textId: null, audioId: null, kind: next.length ? 'clip' : null, id: null } });
  },
  selectText(textId) { set({ selection: { ...get().selection, clipIds: [], textId, audioId: null, kind: textId ? 'text' : null, id: textId || null } }); },
  selectAudio(audioId) { set({ selection: { ...get().selection, clipIds: [], textId: null, audioId, kind: audioId ? 'audio' : null, id: audioId || null } }); },
  /** 选中叠加层/字幕/标记等：kind 'overlay'|'caption'|'marker'|'text'|'audio' */
  selectItem(kind, id) {
    const base = { ...get().selection, clipIds: [], textId: null, audioId: null, kind: id ? kind : null, id: id || null };
    if (kind === 'text' || kind === 'caption') base.textId = id || null;
    if (kind === 'audio') base.audioId = id || null;
    set({ selection: base });
  },
  selectShot(shotId) { set({ selection: { ...get().selection, shotId } }); },
  clearSelection() { set({ selection: { ...EMPTY_SEL, shotId: get().selection.shotId } }); },
  setRange(range) { set({ range }); },
  setFocus(focus) { set({ focus }); },
  setPlayhead(t) { set({ playhead: Math.max(0, Number(t) || 0) }); },
  setPlaying(playing) { set({ playing: !!playing }); },
  setTimelineZoom(z) { set({ timelineZoom: Math.max(8, Math.min(400, z)) }); },

  // ================= 对话框 / Toast / 任务 =================
  openDialog(name, value = true) { set({ dialogs: { ...get().dialogs, [name]: value } }); },
  closeDialog(name) { set({ dialogs: { ...get().dialogs, [name]: false } }); },

  /** opts.key 相同的提示原地替换（不堆叠）；opts.action = { label, run } 显示成按钮 */
  toast(message, kind = 'info', ms, opts) {
    const id = toastSeq++;
    const key = opts && opts.key ? String(opts.key) : undefined;
    const action = opts && opts.action && typeof opts.action.run === 'function' && opts.action.label ? opts.action : undefined;
    const rest = key ? get().toasts.filter((t) => t.key !== key) : get().toasts;
    set({ toasts: [...rest, { id, message, kind, key, action }].slice(-5) });
    unref(setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), ms || (kind === 'error' ? 5000 : 2800)));
  },

  /** 跟踪一个后台任务（任务面板显示）。返回 api.job 的结果 */
  async trackJob(channel, payload, label, onProgress) {
    let jid = null;
    try {
      const result = await api.job(channel, payload, (p) => {
        set({ jobs: { ...get().jobs, [p.jobId]: { ...(get().jobs[p.jobId] || {}), jobId: p.jobId, kind: p.kind, label, stage: p.stage, progress: p.progress, message: p.message, status: 'running' } } });
        if (onProgress) onProgress(p);
      }, (jobId) => {
        jid = jobId;
        set({ jobs: { ...get().jobs, [jobId]: { jobId, label, stage: '开始', progress: 0, message: '', status: 'running' } } });
      });
      if (jid) set({ jobs: { ...get().jobs, [jid]: { ...get().jobs[jid], status: 'done', progress: 1 } } });
      return result;
    } catch (e) {
      if (jid) set({ jobs: { ...get().jobs, [jid]: { ...get().jobs[jid], status: e.cancelled ? 'cancelled' : 'error', message: e.message } } });
      throw e;
    } finally {
      if (jid) unref(setTimeout(() => { const j = { ...get().jobs }; delete j[jid]; set({ jobs: j }); }, 6000));
    }
  },
}));

export default useStore;
