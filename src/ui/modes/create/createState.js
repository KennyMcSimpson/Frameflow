// 创作模式的临时 UI 状态（不写入项目文件）。
// 放在模块级 store 而不是组件 state：切到精修再切回来时，进行中的 AI 回复、批量任务、下载进度都还在。
import { create } from 'zustand';
import useStore from '../../store.js';
import api from '../../api.js';
import { setSampleResources } from '../../../engine/sample.js';

// 示例项目的实拍素材目录：appInfo.resources（system.cjs 提供 {root, sampleMedia, sampleMediaOk}）
const syncSampleResources = (info) => { if (info && info.resources) setSampleResources(info.resources); };
syncSampleResources(useStore.getState().appInfo);
useStore.subscribe((s, prev) => { if (s.appInfo !== prev.appInfo) syncSampleResources(s.appInfo); });

const idleChat = () => ({ busy: false, token: 0, jobId: null, startedAt: 0, stage: '', cancelling: false, failed: null });
const idleBoard = () => ({ busy: false, token: 0, jobId: null, startedAt: 0, cancelling: false, error: null });

const projectState = () => ({
  chat: idleChat(),
  chatDraft: '',
  board: idleBoard(),
  batch: null,      // { kind:'previz'|'references'|'footage'|'videogen', token, done, total, label, cancelled }
  shotBusy: {},     // shotId → { kind, label, jobId, cancelling }
  refStatus: {},    // shotId → { loading, errors, query, sources }
  downloads: {},    // resultKey → { status:'running'|'done'|'error', progress, jobId, assetId, error }
  analyzing: {},    // resultKey → { status:'running'|'done'|'error', progress, jobId, error }
  drawerShotId: null,
  editorShotId: null,
  pickerShotId: null,
  refineShotId: null,
  confirm: null,    // { title, body, confirmLabel, danger }
});

export const useCreateUI = create(() => ({
  ...projectState(),
  view: 'grid',
  userTechniques: [],
  ytdlp: null,      // { installed, checkedAt }
}));

export const getUI = () => useCreateUI.getState();
export const setUI = (patch) => useCreateUI.setState(patch);
export const patchChat = (patch) => setUI({ chat: { ...getUI().chat, ...patch } });
export const patchBoard = (patch) => setUI({ board: { ...getUI().board, ...patch } });
export const patchBatch = (patch) => { const { batch } = getUI(); if (batch) setUI({ batch: { ...batch, ...patch } }); };

/** 写字典型字段（shotBusy/refStatus/downloads/analyzing）；value 为 null 时删除该键 */
export function setKeyed(field, key, value) {
  const next = { ...getUI()[field] };
  if (value == null) delete next[key]; else next[key] = value;
  setUI({ [field]: next });
}

export function patchKeyed(field, key, patch) {
  const cur = getUI()[field][key];
  if (cur) setKeyed(field, key, { ...cur, ...patch });
}

// ---------- 确认框（Promise 风格，由 ConfirmHost 渲染） ----------

let confirmResolve = null;

/**
 * 弹确认框。默认 resolve 布尔值；给了 altLabel 时多一个次要选项，选它 resolve 'alt'（取消仍是 false）。
 */
export function askConfirm({ title, body, confirmLabel = '确定', danger = false, altLabel = '' }) {
  if (confirmResolve) confirmResolve(false);
  setUI({ confirm: { title, body, confirmLabel, danger, altLabel } });
  return new Promise((resolve) => { confirmResolve = resolve; });
}

export function answerConfirm(value) {
  const resolve = confirmResolve;
  confirmResolve = null;
  setUI({ confirm: null });
  if (resolve) resolve(value === 'alt' ? 'alt' : !!value);
}

// ---------- 切换项目时清场 ----------

function cancelRunningJobs(ui) {
  const ids = [
    ui.chat.jobId,
    ui.board.jobId,
    ...Object.values(ui.shotBusy).map((b) => b.jobId),
    ...Object.values(ui.downloads).filter((d) => d.status === 'running').map((d) => d.jobId),
  ].filter(Boolean);
  ids.forEach((id) => api.cancel(id).catch(() => {}));
}

useStore.subscribe((state, prev) => {
  const id = state.project && state.project.id;
  const prevId = prev.project && prev.project.id;
  if (id === prevId) return;
  cancelRunningJobs(getUI());
  if (confirmResolve) answerConfirm(false);
  setUI(projectState());
});
