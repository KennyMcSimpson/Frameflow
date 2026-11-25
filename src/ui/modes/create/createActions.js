// 创作模式的业务动作：AI 导演、分镜生成与编辑、预演、联网参考、一键初剪。
// 约定：异步流程开始时记下 projectId / token，回来后先核对，避免把结果写进已切换的项目。
// 撤销是整份项目快照，所以聊天记录一律先 update 再 commit，撤销分镜时 AI 的那条回复不会一起消失。
import useStore from '../../store.js';
import api from '../../api.js';
import { uid } from '../../../engine/ids.js';
import { createAsset, createBrief } from '../../../engine/model.js';
import { applyOps } from '../../../engine/ops.js';
import { buildFirstCut, makePrevizAsset } from '../../../engine/firstcut.js';
import { BUILTIN_TECHNIQUES } from '../../../engine/builtinTechniques.js';
import {
  buildFootageQueriesLLM, pickFootage, pickVariant, footageCredit, footageAuthors, usedFootageIds, autoFootageSources, FREE_STOCK_SOURCES, shotMediaPick,
} from '../../../engine/stockFootage.js';
import { searchTechniques } from '../../../engine/techniques.js';
import { runAI, isNoAI } from '../../../ai/client.js';
import {
  buildDirectorRequest, parseDirectorResponse, buildStoryboardRequest, parseStoryboardResponse,
  buildShotRefineRequest, parseShotRefineResponse,
} from '../../../ai/director.js';
import { localDirectorReply, localStoryboard } from '../../../ai/localDirector.js';
import { addAssets, importFilesDialog } from '../../assetActions.js';
import { withConsent, isConsentDeclined } from '../../consent.js';
import { getUI, setUI, patchChat, patchBoard, patchBatch, setKeyed, patchKeyed, askConfirm } from './createState.js';
import {
  normalizeShot, normalizeShots, withShotPatch, withReferences, linkPreviz, moveShotBy, moveShotTo, duplicateShot,
  insertShotAfter, removeShot, cleanBriefPatch, baseBrief, applyStoryboard, pickSources, buildSearchPlan, mergeResults,
  resultKey, guessCategory, imageSizeForAspect, buildImagePrompt, summarizeReport, isNoAIError, shotSource, timelineMatchesBoard,
} from './createUtils.js';

const DIRECTOR_TIMEOUT_MS = 180000;
const STORYBOARD_TIMEOUT_MS = 300000;
const REFINE_TIMEOUT_MS = 120000;
const SEARCH_TIMEOUT_MS = 60000;
const YTDLP_CHECK_TTL_MS = 60000;
const MAX_HISTORY = 30;
const MAX_PROMPT_TECHNIQUES = 10;
const MIN_PROMPT_TECHNIQUES = 4;
const BATCH_STEP_DELAY_MS = 90;

const S = () => useStore.getState();
// 第 4 参数 opts（key / action）透传给 store.toast；不支持扩展参数时会忽略它
const toast = (message, kind, ms, opts) => S().toast(message, kind, ms, opts);
// ai-core 的 isNoAI 之外再按文案兜底：任务通道丢了错误码时也能退回本地规则
const noAI = (e) => { try { if (isNoAI(e)) return true; } catch { /* 旧实现不认的情况交给下面 */ } return isNoAIError(e); };
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const sameProject = (id) => !!S().project && S().project.id === id;

let tokenSeq = 1;
const nextToken = () => { tokenSeq += 1; return tokenSeq; };

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function findShot(shotId) {
  const { project } = S();
  return project ? project.storyboard.find((s) => s.id === shotId) || null : null;
}

function reportCommit(result, fallback) {
  if (!result.ok) toast(`${fallback}：${(result.errors || []).join('；') || '操作无效'}`, 'error');
  return result.ok;
}

// ---------- AI 上下文 ----------

/** 用户在拆片库沉淀的技法卡。失败时只用内置卡，不打扰用户。 */
export async function loadUserTechniques() {
  try {
    const list = await api.call('library:techniques', {});
    setUI({ userTechniques: Array.isArray(list) ? list : [] });
  } catch { /* 拆片库不可用时只用内置卡 */ }
}

export function allTechniques() {
  return [...BUILTIN_TECHNIQUES, ...getUI().userTechniques];
}

function pickTechniques(query) {
  const all = allTechniques();
  const found = searchTechniques(all, query, { limit: MAX_PROMPT_TECHNIQUES }) || [];
  if (found.length >= MIN_PROMPT_TECHNIQUES) return found;
  const ids = new Set(found.map((t) => t.id));
  return [...found, ...all.filter((t) => !ids.has(t.id))].slice(0, MAX_PROMPT_TECHNIQUES);
}

function assetDigest(project) {
  return Object.values(project.assets || {})
    .filter((a) => a.kind !== 'previz')
    .map((a) => ({ id: a.id, name: a.name, kind: a.kind, duration: a.duration, tags: a.tags || [], description: a.description || '' }));
}

function directorHistory(project, beforeId) {
  const all = (project.chats && project.chats.director) || [];
  const i = beforeId ? all.findIndex((m) => m.id === beforeId) : -1;
  return (i >= 0 ? all.slice(0, i) : all).slice(-MAX_HISTORY);
}

function appendDirectorMessage(projectId, message) {
  S().update((p) => (p.id !== projectId ? p : {
    ...p,
    chats: { ...p.chats, director: [...((p.chats && p.chats.director) || []), message] },
  }));
}

function makeMessage(role, text, extra) {
  return { id: uid('msg'), role, text, at: new Date().toISOString(), ...extra };
}

// ---------- 简报 ----------

/** 画幅用 setProject op 同步到项目设置，和简报字段合成一步撤销 */
function withAspect(project, aspect) {
  if (!aspect || aspect === project.settings.aspect) return project;
  const op = { type: 'setProject', target: { mode: 'none', indices: [], ids: [] }, settings: { aspect } };
  const r = applyOps(project, [op], { selectedClipIds: [], range: null, playhead: 0 });
  if (!r.ok) throw new Error((r.errors || []).join('；') || '修改画幅失败');
  return r.project;
}

function withBrief(project, patch) {
  return { ...withAspect(project, patch.aspect), brief: createBrief({ ...baseBrief(project), ...patch }) };
}

export function updateBrief(patch, label = '修改创意简报') {
  reportCommit(S().commit((p) => withBrief(p, patch), label), '简报未保存');
}

export function updateStyleGuide(text) {
  reportCommit(S().commit((p) => ({ ...p, memory: { ...p.memory, styleGuide: text } }), '修改风格指南'), '风格指南未保存');
}

// ---------- AI 导演对话 ----------

function applyDirectorResult(projectId, parsed, provider) {
  const r = parsed || {};
  const patch = cleanBriefPatch(r.briefPatch);
  const shots = Array.isArray(r.storyboard) && r.storyboard.length ? normalizeShots(r.storyboard) : null;
  appendDirectorMessage(projectId, makeMessage('assistant', r.reply || '好的，我记下了。', {
    questions: Array.isArray(r.questions) ? r.questions.filter(Boolean) : [],
    provider,
    readyForStoryboard: !!r.readyForStoryboard && !shots,
  }));
  if (!shots && !Object.keys(patch).length) return;
  const label = shots ? 'AI 导演生成分镜' : 'AI 导演更新简报';
  const ok = reportCommit(S().commit((p) => {
    const next = withBrief(p, patch);
    return shots ? applyStoryboard(next, shots) : next;
  }, label), 'AI 导演的修改未应用');
  if (ok && shots) toast(`已生成 ${shots.length} 个分镜，可撤销`, 'ok');
}

async function runDirector(text, messageId, { forceLocal = false } = {}) {
  const { project } = S();
  if (!project) return;
  const projectId = project.id;
  const token = nextToken();
  patchChat({ busy: true, token, jobId: null, startedAt: Date.now(), stage: '', cancelling: false, failed: null });
  const current = () => getUI().chat.token === token && sameProject(projectId);
  const { brief } = project;
  const history = directorHistory(project, messageId);
  const replyLocally = () => ({ parsed: localDirectorReply({ brief, messages: history, userText: text }), provider: 'local' });
  const fail = (e) => patchChat({
    busy: false,
    jobId: null,
    cancelling: false,
    failed: { text, messageId, cancelled: !!e.cancelled, message: e.cancelled ? '已取消这次回复' : e.message || 'AI 导演没有回应' },
  });

  let out;
  try {
    if (forceLocal) {
      out = replyLocally();
    } else {
      const techniques = pickTechniques(`${text} ${(brief && brief.style) || ''} ${(brief && brief.title) || ''}`);
      const validTechniqueIds = allTechniques().map((t) => t.id);
      const request = buildDirectorRequest({
        brief,
        messages: history,
        userText: text,
        techniques,
        assets: assetDigest(project),
      });
      const r = await runAI({ ...request, timeoutMs: DIRECTOR_TIMEOUT_MS }, {
        onStart: (jobId) => {
          if (!current()) return;
          patchChat({ jobId });
          if (getUI().chat.cancelling) api.cancel(jobId).catch(() => {});
        },
        // 优先显示阶段文字（phase），缺省时回退到 message
        onProgress: (p) => { const stage = p && (p.phase || p.message); if (current() && stage) patchChat({ stage }); },
      });
      out = { parsed: parseDirectorResponse(r.data, { brief, validTechniqueIds }), provider: r.provider };
    }
  } catch (e) {
    if (!current()) return;
    // 没连 AI 不算失败：直接用本地规则回复，不出错误条
    if (!noAI(e)) { fail(e); return; }
    try { out = replyLocally(); } catch (localError) { fail(localError); return; }
  }
  if (!current()) return;
  patchChat({ busy: false, jobId: null, cancelling: false, stage: '' });
  applyDirectorResult(projectId, out.parsed, out.provider);
}

export function sendDirector(rawText) {
  const text = String(rawText == null ? '' : rawText).trim();
  const { project } = S();
  if (!text || !project || getUI().chat.busy) return false;
  const message = makeMessage('user', text);
  appendDirectorMessage(project.id, message);
  setUI({ chatDraft: '' });
  runDirector(text, message.id);
  return true;
}

export function retryDirector({ local = false } = {}) {
  const { chat } = getUI();
  if (chat.busy || !chat.failed) return;
  runDirector(chat.failed.text, chat.failed.messageId, { forceLocal: local });
}

export function dismissDirectorError() {
  patchChat({ failed: null });
}

export function cancelDirector() {
  const { chat } = getUI();
  if (!chat.busy) return;
  patchChat({ cancelling: true });
  if (chat.jobId) api.cancel(chat.jobId).catch(() => {});
}

// ---------- 生成分镜 ----------

function commitStoryboard(projectId, { shots, styleGuide, reply }, provider) {
  const list = normalizeShots(shots);
  if (!list.length) throw new Error('没有生成出可用的分镜，请再试一次');
  appendDirectorMessage(projectId, makeMessage('assistant', reply || `分镜写好了，一共 ${list.length} 个镜头，都放在中间的分镜板上。`, { provider }));
  const ok = reportCommit(S().commit((p) => applyStoryboard(p, list, { styleGuide }), '生成分镜'), '分镜未写入');
  if (ok) toast(`已生成 ${list.length} 个分镜，可撤销`, 'ok');
}

async function confirmReplaceBoard() {
  const { project } = S();
  if (!project || !project.storyboard.length) return true;
  return askConfirm({
    title: '替换当前分镜？',
    body: `现有 ${project.storyboard.length} 个分镜和它们的参考结果会被新分镜替换，已下载的素材和预演资产保留在素材箱。之后可以用撤销恢复。`,
    confirmLabel: '替换分镜',
  });
}

export async function generateStoryboard() {
  if (getUI().board.busy || !S().project) return;
  if (!(await confirmReplaceBoard())) return;
  const { project } = S();
  if (!project || getUI().board.busy) return;
  const projectId = project.id;
  const token = nextToken();
  patchBoard({ busy: true, token, jobId: null, startedAt: Date.now(), cancelling: false, error: null });
  const current = () => getUI().board.token === token && sameProject(projectId);
  const brief = baseBrief(project);
  try {
    let result;
    let provider = 'local';
    try {
      const messages = directorHistory(project);
      const techniques = pickTechniques(`${brief.title} ${brief.style} ${brief.goal} ${brief.mood}`);
      const validTechniqueIds = allTechniques().map((t) => t.id);
      const request = buildStoryboardRequest({
        brief,
        messages,
        techniques,
        assets: assetDigest(project),
        project,
      });
      const r = await runAI({ ...request, timeoutMs: STORYBOARD_TIMEOUT_MS }, {
        onStart: (jobId) => {
          if (!current()) return;
          patchBoard({ jobId });
          if (getUI().board.cancelling) api.cancel(jobId).catch(() => {});
        },
      });
      result = parseStoryboardResponse(r.data, { brief, validTechniqueIds });
      provider = r.provider;
    } catch (e) {
      if (!noAI(e)) throw e;
      result = localStoryboard(brief);
    }
    if (!current()) return;
    patchBoard({ busy: false, jobId: null, cancelling: false });
    commitStoryboard(projectId, result, provider);
  } catch (e) {
    if (!current()) return;
    patchBoard({ busy: false, jobId: null, cancelling: false, error: e.cancelled ? null : e.message || '生成分镜失败' });
    if (e.cancelled) toast('已取消生成分镜');
  }
}

export function cancelStoryboard() {
  const { board } = getUI();
  if (!board.busy) return;
  patchBoard({ cancelling: true });
  if (board.jobId) api.cancel(board.jobId).catch(() => {});
}

/** 不用 AI，按当前简报套本地模板 */
export async function quickLocalStoryboard() {
  if (getUI().board.busy || !S().project) return;
  if (!(await confirmReplaceBoard())) return;
  const { project } = S();
  if (!project) return;
  patchBoard({ error: null });
  try {
    commitStoryboard(project.id, localStoryboard(baseBrief(project)), 'local');
  } catch (e) {
    toast(`本地模板生成失败：${e.message}`, 'error');
  }
}

// ---------- 分镜增删改 ----------

export function saveShot(shotId, draft) {
  const shot = findShot(shotId);
  if (!shot) return false;
  // 素材和预演的关联不由编辑器管：编辑期间后台任务可能刚更新过它们，不能用打开时的旧值盖回去
  const { assetId, previzAssetId, footageAssetId, footageTried, aiVideoAssetId, aiVideoTask, mediaSource, status, ...next } = normalizeShot({ ...draft, id: shotId }, shot.index);
  return reportCommit(S().commit((p) => withShotPatch(p, shotId, next), `编辑第 ${shot.index} 镜`), '分镜未保存');
}

export function moveShot(shotId, delta) {
  S().commit((p) => ({ ...p, storyboard: moveShotBy(p.storyboard, shotId, delta) }), '调整分镜顺序');
}

export function reorderShot(shotId, toIndex) {
  S().commit((p) => ({ ...p, storyboard: moveShotTo(p.storyboard, shotId, toIndex) }), '调整分镜顺序');
}

export function copyShot(shotId) {
  S().commit((p) => {
    const r = duplicateShot(p.storyboard, shotId);
    return r ? { ...p, storyboard: r.shots } : null;
  }, '复制分镜');
}

export function addShotAfter(afterId) {
  let created = null;
  const r = S().commit((p) => {
    const out = insertShotAfter(p.storyboard, afterId);
    created = out.shotId;
    return { ...p, storyboard: out.shots };
  }, '插入分镜');
  if (r.ok && created) setUI({ editorShotId: created });
}

export function deleteShot(shotId) {
  const shot = findShot(shotId);
  if (!shot) return;
  const r = S().commit((p) => removeShot(p, shotId), `删除第 ${shot.index} 镜`);
  if (r.ok) {
    if (getUI().drawerShotId === shotId) setUI({ drawerShotId: null });
    toast(`已删除第 ${shot.index} 镜`, 'info', undefined, {
      key: 'create-delete-shot',
      action: { label: '撤销', run: () => { try { S().undo(); } catch { /* 撤销不可用时忽略 */ } } },
    });
  }
}

export function assignAsset(shotId, assetId) {
  const shot = findShot(shotId);
  if (!shot) return false;
  const label = assetId ? `为第 ${shot.index} 镜指定素材` : `移除第 ${shot.index} 镜的素材`;
  return reportCommit(S().commit((p) => withShotPatch(p, shotId, { assetId: assetId || null }), label), '指定素材失败');
}

/** 导入新文件。只选了一个文件时直接指定给该镜，返回是否已指定。 */
export async function importForShot(shotId) {
  let assets = [];
  try {
    assets = await importFilesDialog();
  } catch (e) {
    toast(`导入失败：${e.message}`, 'error');
    return false;
  }
  const usable = assets.filter((a) => a.kind !== 'audio');
  return usable.length === 1 ? assignAsset(shotId, usable[0].id) : false;
}

// ---------- 预演 ----------

/** 已有预演时沿用资产 id，时间线上引用它的镜头跟着更新 */
function buildPrevizAsset(shot, project) {
  const asset = makePrevizAsset(shot, project);
  const existing = shot.previzAssetId && project.assets[shot.previzAssetId];
  return existing ? { ...asset, id: existing.id } : asset;
}

export function generatePreviz(shotId) {
  const shot = findShot(shotId);
  if (!shot) return;
  const refreshed = !!shot.previzAssetId;
  try {
    const asset = buildPrevizAsset(shot, S().project);
    const ok = reportCommit(S().commit((p) => linkPreviz(p, shotId, asset), `生成第 ${shot.index} 镜预演`), '预演未生成');
    if (ok) toast(refreshed ? `第 ${shot.index} 镜的预演已更新` : `第 ${shot.index} 镜的预演已加入素材箱`, 'ok');
  } catch (e) {
    toast(`预演生成失败：${e.message}`, 'error');
  }
}

function startBatch(kind, total) {
  const token = nextToken();
  setUI({ batch: { kind, token, done: 0, total, label: '', cancelled: false } });
  return token;
}

const batchAlive = (token) => { const { batch } = getUI(); return !!batch && batch.token === token; };
const batchCancelled = (token) => { const { batch } = getUI(); return !batch || batch.token !== token || batch.cancelled; };

export function cancelBatch() {
  patchBatch({ cancelled: true });
}

/** 逐镜生成，只提交一次：一步撤销，取消时已完成的部分保留 */
export async function generateAllPreviz() {
  const { project } = S();
  if (!project || getUI().batch || !project.storyboard.length) return;
  const missing = project.storyboard.filter((s) => !(s.previzAssetId && project.assets[s.previzAssetId]));
  const targets = missing.length ? missing : project.storyboard;
  const token = startBatch('previz', targets.length);
  const made = [];
  let failed = 0;
  for (let i = 0; i < targets.length; i += 1) {
    if (batchCancelled(token)) break;
    const shot = targets[i];
    patchBatch({ done: i, label: `第 ${shot.index} 镜：${shot.title}` });
    await sleep(BATCH_STEP_DELAY_MS);
    if (batchCancelled(token)) break;
    try {
      made.push({ shotId: shot.id, asset: buildPrevizAsset(shot, project) });
    } catch { failed += 1; }
  }
  if (!batchAlive(token)) return;
  const { cancelled } = getUI().batch;
  setUI({ batch: null });
  if (made.length) {
    const r = S().commit((p) => made.reduce((next, m) => linkPreviz(next, m.shotId, m.asset) || next, p), `生成 ${made.length} 个预演`);
    if (!reportCommit(r, '预演未生成')) return;
  }
  if (cancelled) toast(`已取消，完成 ${made.length}/${targets.length} 个预演`);
  else if (failed) toast(`生成了 ${made.length} 个预演，${failed} 个失败`, 'error');
  else toast(`已生成 ${made.length} 个预演`, 'ok');
}

// ---------- 实拍参考素材（Pexels / Pixabay / Wikimedia Commons） ----------

const FOOTAGE_SEARCH_LIMIT = 15;
const LLM_QUERY_TIMEOUT_MS = 25000;

function aspectOrientation(aspect) {
  const [w, h] = String(aspect || '16:9').split(':').map(Number);
  if (!(w > 0 && h > 0)) return 'landscape';
  return w / h > 1.15 ? 'landscape' : w / h < 0.87 ? 'portrait' : 'square';
}

async function footageQueries(shot, project) {
  const { settings } = S();
  const useAI = !(settings && settings.web && settings.web.aiFootageQueries === false);
  const run = useAI ? (req) => runAI(req).then((r) => r.data) : null;
  const out = await buildFootageQueriesLLM(shot, { brief: project.brief, run, timeoutMs: LLM_QUERY_TIMEOUT_MS });
  return out.queries;
}

/** 搜索并挑出一条最合适的素材（还没下载）。先 Pexels/Pixabay，挑不到再退回 Commons；B站/YouTube 不参与。 */
async function searchFootage(shot, project, excludeIds, preferAuthors = []) {
  const queries = await footageQueries(shot, project);
  if (!queries.length) throw new Error('这一镜缺少可搜索的画面描述，请先填写主体或场景');
  const all = autoFootageSources(S().settings);
  // 免 Key 这一档只点名维基共享资源：它没有合适结果时，后台会自己再搜 NASA 和互联网档案馆
  const stock = all.filter((s) => !FREE_STOCK_SOURCES.includes(s));
  const tiers = stock.length ? [stock, ['commons']] : [['commons']];
  const opts = { aspect: project.settings.aspect, duration: shot.duration, excludeIds, preferAuthors };
  const orientation = aspectOrientation(project.settings.aspect);
  const errors = [];
  for (const sources of tiers) {
    for (const query of queries) {
      let out;
      try {
        out = await withTimeout(api.call('web:search', { query, sources, kind: 'video', limit: FOOTAGE_SEARCH_LIMIT, auto: true, orientation, size: 'medium' }), SEARCH_TIMEOUT_MS, '素材搜索超时，请检查网络');
      } catch (e) { errors.push(e.message); continue; }
      for (const err of out.errors || []) errors.push(err.error);
      const pick = pickFootage(out.results, opts);
      if (pick) {
        const variant = pickVariant(pick.variants);
        return { result: variant ? { ...pick, downloadUrl: variant.url, width: variant.width, height: variant.height } : pick, query };
      }
    }
  }
  const why = [...new Set(errors)].slice(0, 2).join('；');
  throw new Error(why ? `没有找到合适的实拍素材（${why}）` : '没有找到合适的实拍素材，可以改写这一镜的主体/场景后再试');
}

async function fetchFootageAsset(shot, project, excludeIds, onJob, preferAuthors) {
  const { result, query } = await searchFootage(shot, project, excludeIds, preferAuthors);
  const out = await S().trackJob(
    'web:download',
    { result, target: 'project', projectId: project.id, maxSeconds: 60, withSubs: false, query },
    `实拍素材：第 ${shot.index} 镜`,
    (p) => onJob && onJob(p),
  );
  if (!out || !out.asset) throw new Error('下载完成但没有拿到素材');
  const prev = out.asset.source && typeof out.asset.source === 'object' ? out.asset.source : {};
  const stock = { ...prev, platform: prev.platform || result.source, author: prev.author || result.author || '', license: prev.license || result.license || '', resultId: result.id, query, page: result.url };
  const asset = {
    ...out.asset,
    name: `实拍 · ${String(result.title || shot.title).slice(0, 60)}`,
    tags: [...new Set(['实拍', '参考素材', ...(out.asset.tags || [])])],
    source: 'stock',
    stock,
    stockForShot: shot.id,
  };
  asset.credit = footageCredit(asset);
  return { asset, resultId: result.id };
}

function linkFootage(project, shotId, asset, resultId, { show = false } = {}) {
  const shot = project.storyboard.find((s) => s.id === shotId);
  if (!shot) return null;
  const tried = [...new Set([...(Array.isArray(shot.footageTried) ? shot.footageTried : []), resultId])].slice(-30);
  const next = { ...project, assets: { ...project.assets, [asset.id]: asset } };
  const patch = { footageAssetId: asset.id, footageTried: tried, mediaSource: shot.mediaSource === 'ai' || shot.mediaSource === 'local' ? shot.mediaSource : 'stock' };
  // 用户在这一镜上点「换画面 / 配实拍」：新实拍要真的显示出来。自己的素材和 AI 视频优先级更高，
  // 所以解除这一镜对它们的引用（素材本身还在素材箱里，也可以撤销）
  if (show) Object.assign(patch, { assetId: null, aiVideoAssetId: null, mediaSource: 'stock' });
  return withShotPatch(next, shotId, patch);
}

/** 为一镜配实拍素材；replace=true 时换一条没用过的 */
export async function fillShotFootage(shotId, { replace = false } = {}) {
  const { project } = S();
  const shot = findShot(shotId);
  if (!project || !shot || getUI().shotBusy[shotId]) return;
  const projectId = project.id;
  setKeyed('shotBusy', shotId, { kind: 'footage', label: replace ? '正在换一条实拍素材…' : '正在找实拍素材…', jobId: null, cancelling: false });
  try {
    // 别的镜头用过的不重复用；换一条时再排除本镜试过的
    const exclude = [...usedFootageIds(project, { exceptShotId: shotId }), ...(replace ? shot.footageTried || [] : [])];
    const { asset, resultId } = await fetchFootageAsset(shot, project, exclude, (p) => patchKeyed('shotBusy', shotId, { jobId: p.jobId, label: '正在下载实拍素材…' }), footageAuthors(project));
    if (!sameProject(projectId)) return;
    const latest = findShot(shotId);
    const before = latest ? shotSource(latest, S().project.assets).kind : 'none';
    const r = S().commit((p) => linkFootage(p, shotId, asset, resultId, { show: true }), `第 ${shot.index} 镜配实拍素材`);
    if (reportCommit(r, '实拍素材未保存')) {
      const replaced = before === 'local' || before === 'ai';
      toast(`第 ${shot.index} 镜已${replaced ? '换成' : '配上'}实拍素材（${footageCredit(asset)}）`, 'ok', replaced ? 6000 : undefined,
        replaced ? { key: 'create-shot-footage', action: { label: '撤销', run: () => { try { S().undo(); } catch { /* 忽略 */ } } } } : undefined);
    }
  } catch (e) {
    if (e.cancelled) toast('已取消');
    else toast(`第 ${shot.index} 镜：${e.message}`, 'error', 6000);
  } finally {
    if (sameProject(projectId)) setKeyed('shotBusy', shotId, null);
  }
}

/** 不用实拍素材，恢复程序化的 AI 预演（素材仍留在素材箱） */
export function restoreAIPreviz(shotId) {
  const shot = findShot(shotId);
  if (!shot) return;
  const r = S().commit((p) => {
    let next = withShotPatch(p, shotId, { footageAssetId: null });
    if (next && !(shot.previzAssetId && next.assets[shot.previzAssetId])) next = linkPreviz(next, shotId, buildPrevizAsset(shot, next)) || next;
    return next;
  }, `第 ${shot.index} 镜恢复 AI 预演`);
  if (reportCommit(r, '操作失败')) toast(`第 ${shot.index} 镜已恢复 AI 预演`, 'ok');
}

/** 旧名保留，供现有界面调用 */
export const findShotFootage = fillShotFootage;

/**
 * 逐镜配实拍素材，最后一次提交（一步撤销）。已有画面（用户素材/AI 视频/实拍）的跳过；全部都有时整体换一遍实拍。
 * @param {{quiet?: boolean, onlyMissing?: boolean}} [opts] onlyMissing：全部都有时不再整体替换（新建/首次初剪用）
 * @returns {Promise<number>} 配上的镜头数
 */
export async function fillAllFootage({ quiet = false, onlyMissing = false } = {}) {
  const { project } = S();
  if (!project || getUI().batch || !project.storyboard.length) return 0;
  const has = (s) => !!(s.footageAssetId && project.assets[s.footageAssetId]);
  const covered = (s) => has(s) || shotMediaPick(s, project.assets).kind === 'local' || shotMediaPick(s, project.assets).kind === 'ai';
  const missing = project.storyboard.filter((s) => !covered(s));
  if (!missing.length && onlyMissing) return 0;
  const replaceAll = !missing.length;
  let targets = missing;
  if (replaceAll) {
    // 画面已齐：只换当前显示的是自动配的实拍（footageAssetId）的镜头。自己的素材、AI 画面、手动放进来的素材
    // 优先级更高，换了也看不到，所以不动；换之前先确认
    targets = project.storyboard.filter((s) => {
      const src = shotSource(s, project.assets);
      return src.kind === 'stock' && !!src.asset && src.asset.id === s.footageAssetId;
    });
    if (!targets.length) {
      if (!quiet) toast('每个镜头用的都是你自己的素材或 AI 画面，没有需要换的实拍');
      return 0;
    }
    const ok = await askConfirm({
      title: '重新配画面？',
      body: `会给 ${targets.length} 个用实拍素材的镜头各换一条新的实拍，你自己的素材和 AI 画面不动。换完不满意可以撤销。`,
      confirmLabel: '重新配画面',
    });
    if (!ok || !sameProject(project.id) || getUI().batch) return 0;
  }
  const token = startBatch('footage', targets.length);
  const made = [];
  const failures = [];
  const usedIds = new Set(replaceAll ? [] : usedFootageIds(project));
  const authors = footageAuthors(project);
  for (let i = 0; i < targets.length; i += 1) {
    if (batchCancelled(token)) break;
    const shot = targets[i];
    patchBatch({ done: i, label: `第 ${shot.index} 镜：${shot.title}` });
    try {
      // 同一条素材不给两个镜头用；同一摄影师优先，整片色调更统一
      const exclude = [...usedIds, ...(replaceAll ? shot.footageTried || [] : [])];
      const out = await fetchFootageAsset(shot, project, exclude, null, authors);
      if (!batchAlive(token)) return made.length;
      usedIds.add(String(out.resultId));
      const author = out.asset.stock && out.asset.stock.author;
      if (author && !authors.includes(author)) authors.push(author);
      made.push({ shotId: shot.id, ...out });
    } catch (e) {
      if (!batchAlive(token)) return made.length;
      if (!e.cancelled) failures.push(`第 ${shot.index} 镜`);
    }
  }
  if (!batchAlive(token)) return made.length;
  const { cancelled } = getUI().batch;
  setUI({ batch: null });
  if (!sameProject(project.id)) return 0;
  if (made.length) {
    const r = S().commit((p) => made.reduce((next, m) => linkFootage(next, m.shotId, m.asset, m.resultId) || next, p), `为 ${made.length} 个分镜配实拍素材`);
    if (!reportCommit(r, '实拍素材未保存')) return 0;
  }
  if (quiet && !failures.length && !cancelled) return made.length;
  if (cancelled) toast(`已取消，${made.length} 个镜头配好了实拍素材`);
  else if (failures.length) toast(`${made.length} 个镜头配好了实拍素材；${failures.join('、')} 没找到合适的，暂用示意画面（成片会带「示意」水印）`, made.length ? 'info' : 'error', 7000);
  else toast(replaceAll ? `已给 ${made.length} 个镜头换了新的实拍，不满意可以撤销` : `已为 ${made.length} 个镜头配上实拍素材（免费可商用，署名见卡片）`, 'ok');
  return made.length;
}

/** 旧名保留 */
export const findAllFootage = () => fillAllFootage();

// ---------- AI 真人视频生成（api.videogen） ----------

const VIDEOGEN_SECONDS = 5;
const RUNNING_STATES = new Set(['queued', 'running', 'pending', 'submitted']);
const videogenJobs = new Map(); // shotId → jobId（用于取消）

function videogenSettings() {
  const { settings } = S();
  const vg = (settings && settings.videogen) || {};
  return { provider: vg.provider || vg.defaultProvider || null, res: vg.res || '720p' };
}

function videogenPrompt(shot, project) {
  const brief = project.brief || {};
  const parts = [
    'Photorealistic live-action cinematic footage, real people, natural skin texture, shot on a cinema camera, no cartoon, no illustration.',
    shot.subject && `Subject: ${shot.subject}.`,
    shot.action && `Action: ${shot.action}.`,
    shot.location && `Location: ${shot.location}.`,
    shot.lighting && `Lighting: ${shot.lighting}.`,
    shot.shotSize && `Shot size: ${shot.shotSize}.`,
    shot.movement && `Camera movement: ${shot.movement}.`,
    brief.style && `Style: ${brief.style}.`,
    brief.mood && `Mood: ${brief.mood}.`,
  ].filter(Boolean);
  return parts.join(' ').slice(0, 1800);
}

function setVideoTask(projectId, shotId, task, label) {
  const patch = { aiVideoTask: task };
  // 进度写入不进撤销历史（update），只有最终结果走 commit
  if (label) return S().commit((p) => (p.id !== projectId ? p : withShotPatch(p, shotId, patch)), label);
  S().update((p) => (p.id !== projectId || !p.storyboard.some((s) => s.id === shotId) ? p : withShotPatch(p, shotId, patch)));
  return { ok: true };
}

async function providerOrHint() {
  let list = [];
  try { list = (await api.videogen.providers()) || []; } catch { list = []; }
  const ready = list.filter((p) => p && p.configured);
  const want = videogenSettings().provider;
  const pick = ready.find((p) => p.id === want) || ready[0] || null;
  if (!pick) {
    toast('还没有配置 AI 视频生成服务（可灵 / 即梦 / Runway 等），请先在设置里填写 API Key。', 'info', 7000);
    try { S().openDialog && S().openDialog('settings', 'videogen'); } catch { /* ignore */ }
  }
  return { provider: pick, providers: list };
}

function finishVideo(projectId, shotId, asset, provider, taskId) {
  if (!sameProject(projectId) || !asset) return false;
  const vg = { ...((asset.meta && asset.meta.videogen) || {}), provider, taskId };
  // source 保留旧字符串 'videogen'（多处按它判断），同时补齐 ai 标记与许可字段
  const aiMark = asset.ai || { provider: provider || 'unknown', createdAt: new Date().toISOString() };
  if (!asset.ai && vg.model) aiMark.model = vg.model;
  if (!asset.ai && vg.prompt) aiMark.prompt = String(vg.prompt).slice(0, 1000);
  const next = { ...asset, source: 'videogen', ai: aiMark, license: asset.license || { id: 'ai' }, meta: { ...(asset.meta || {}), videogen: vg } };
  const shot = findShot(shotId);
  const r = S().commit((p) => {
    if (p.id !== projectId || !p.storyboard.some((s) => s.id === shotId)) return p;
    const withAsset = { ...p, assets: { ...p.assets, [next.id]: next } };
    const cur = withAsset.storyboard.find((s) => s.id === shotId);
    return withShotPatch(withAsset, shotId, {
      aiVideoAssetId: next.id,
      aiVideoTask: { provider, taskId: taskId || null, state: 'done', progress: 1, error: null },
      mediaSource: cur && cur.mediaSource === 'local' ? 'local' : 'ai',
    });
  }, `第 ${shot ? shot.index : ''} 镜 AI 视频`);
  if (next.path) api.call('media:register', { paths: [next.path] }).catch(() => {});
  return reportCommit(r, 'AI 视频未保存');
}

async function runShotVideo(project, shot, provider) {
  const projectId = project.id;
  const shotId = shot.id;
  setKeyed('shotBusy', shotId, { kind: 'videogen', label: '正在排队生成 AI 视频…', jobId: null, cancelling: false });
  setVideoTask(projectId, shotId, { provider: provider.id, taskId: null, state: 'queued', progress: 0, error: null });
  const imageAssetId = (shot.assetId && project.assets[shot.assetId] && /image/.test(project.assets[shot.assetId].kind)) ? shot.assetId : undefined;
  try {
    const out = await S().trackJob(
      'videogen:generate',
      {
        projectId, shotId, provider: provider.id, prompt: videogenPrompt(shot, project),
        negative: 'cartoon, anime, illustration, 3d render, cgi, low quality, watermark, text, distorted faces, extra fingers',
        imageAssetId, duration: VIDEOGEN_SECONDS, ratio: project.settings.aspect, res: videogenSettings().res,
      },
      `AI 视频：第 ${shot.index} 镜`,
      (p) => {
        if (p.jobId) videogenJobs.set(shotId, p.jobId);
        patchKeyed('shotBusy', shotId, {
          jobId: p.jobId,
          progress: typeof p.progress === 'number' ? p.progress : null,
          label: p.message || `AI 视频生成中 ${Math.round((p.progress || 0) * 100)}%`,
        });
        if (sameProject(projectId)) {
          const curShot = findShot(shotId);
          const prevTaskId = curShot && curShot.aiVideoTask && curShot.aiVideoTask.taskId;
          const taskId = (p.meta && p.meta.taskId) || p.taskId || (p.data && p.data.taskId) || prevTaskId || null;
          setVideoTask(projectId, shotId, { provider: provider.id, taskId, state: 'running', progress: p.progress || 0, error: null });
        }
      },
    );
    if (!out || !out.asset) throw new Error('生成完成但没有拿到视频');
    return finishVideo(projectId, shotId, out.asset, provider.id, out.taskId || (out.asset.meta && out.asset.meta.videogen && out.asset.meta.videogen.taskId));
  } catch (e) {
    if (sameProject(projectId)) {
      setVideoTask(projectId, shotId, { provider: provider.id, taskId: null, state: e.cancelled ? 'cancelled' : 'error', progress: 0, error: e.cancelled ? null : e.message });
    }
    if (!e.cancelled) toast(`第 ${shot.index} 镜 AI 视频失败：${e.message}`, 'error', 7000);
    return false;
  } finally {
    videogenJobs.delete(shotId);
    if (sameProject(projectId)) setKeyed('shotBusy', shotId, null);
  }
}

function costLine(provider, n) {
  const hint = provider && provider.priceHint ? `，参考价 ${provider.priceHint}` : '';
  return `${n} 段 × ${VIDEOGEN_SECONDS} 秒，使用「${(provider && provider.label) || '视频生成服务'}」${hint}。费用由服务商按其价格从你的账户扣除。`;
}

/** 为一镜生成 AI 真人视频（单镜也确认费用） */
export async function generateShotVideo(shotId, { confirm = true } = {}) {
  const { project } = S();
  const shot = findShot(shotId);
  if (!project || !shot || getUI().shotBusy[shotId]) return false;
  const { provider } = await providerOrHint();
  if (!provider) return false;
  if (confirm) {
    const ok = await askConfirm({ title: `生成第 ${shot.index} 镜 AI 视频？`, body: `${costLine(provider, 1)}\n生成通常需要 1–5 分钟，可以继续做别的事。`, confirmLabel: '开始生成' });
    if (!ok) return false;
  }
  const latest = S().project;
  if (!latest || latest.id !== project.id) return false;
  const ok = await runShotVideo(latest, findShot(shotId) || shot, provider);
  if (ok) toast(`第 ${shot.index} 镜 AI 视频已生成，初剪会优先使用它`, 'ok');
  return ok;
}

/** 重试失败的 AI 视频 */
export function retryShotVideo(shotId) {
  return generateShotVideo(shotId, { confirm: false });
}

/** 取消一镜的 AI 视频 */
export function cancelShotVideo(shotId) {
  const jobId = videogenJobs.get(shotId) || (getUI().shotBusy[shotId] && getUI().shotBusy[shotId].jobId);
  if (!jobId) return;
  const cur = getUI().shotBusy[shotId];
  setKeyed('shotBusy', shotId, { ...(cur || { kind: 'videogen', jobId }), cancelling: true, label: '正在取消…' });
  api.cancel(jobId).catch(() => {});
}

/** 批量生成 AI 视频：先确认「N 段×5秒，预计费用」，最多 2 路并发 */
export async function generateAllVideos({ onlyMissing = true } = {}) {
  const { project } = S();
  if (!project || getUI().batch || !project.storyboard.length) return 0;
  const pending = project.storyboard.filter((s) => !(onlyMissing && s.aiVideoAssetId && project.assets[s.aiVideoAssetId]) && !getUI().shotBusy[s.id]);
  if (!pending.length) { toast('所有分镜都已有 AI 视频'); return 0; }
  const { provider } = await providerOrHint();
  if (!provider) return 0;
  const ok = await askConfirm({
    title: `为 ${pending.length} 个分镜生成 AI 真人视频？`,
    body: `${costLine(provider, pending.length)}\n生成在后台进行，关闭项目后再打开会继续查询结果。`,
    confirmLabel: `生成 ${pending.length} 段`,
  });
  if (!ok || !sameProject(project.id)) return 0;
  const token = startBatch('videogen', pending.length);
  let done = 0;
  let success = 0;
  const queue = pending.slice();
  const worker = async () => {
    while (queue.length) {
      if (batchCancelled(token)) return;
      const shot = queue.shift();
      patchBatch({ label: `第 ${shot.index} 镜：${shot.title}` });
      const cur = S().project;
      if (!cur || cur.id !== project.id) return;
      if (await runShotVideo(cur, findShot(shot.id) || shot, provider)) success += 1;
      done += 1;
      patchBatch({ done });
    }
  };
  const watchCancel = setInterval(() => {
    if (batchCancelled(token)) for (const shotId of videogenJobs.keys()) cancelShotVideo(shotId);
  }, 500);
  try { await Promise.all([worker(), worker()]); } finally { clearInterval(watchCancel); }
  if (!batchAlive(token)) return success;
  const { cancelled } = getUI().batch;
  setUI({ batch: null });
  if (cancelled) toast(`已取消，${success} 段 AI 视频已生成`);
  else if (success < pending.length) toast(`${success}/${pending.length} 段 AI 视频生成成功，失败的可在卡片上重试`, success ? 'info' : 'error', 7000);
  else toast(`${success} 段 AI 视频已生成，初剪会优先使用它们`, 'ok');
  return success;
}

/** 项目打开时：对未完成的 AI 视频任务恢复轮询，结果通过任务事件回写 */
let resumeUnsub = null;
const resumedProjects = new Set();
export async function resumeVideoTasks() {
  const { project } = S();
  if (!project || !api.videogen || typeof api.videogen.resume !== 'function') return;
  if (resumedProjects.has(project.id)) return;
  resumedProjects.add(project.id);
  const tasks = project.storyboard
    .filter((s) => s.aiVideoTask && s.aiVideoTask.taskId && RUNNING_STATES.has(s.aiVideoTask.state))
    .map((s) => ({ shotId: s.id, provider: s.aiVideoTask.provider, taskId: s.aiVideoTask.taskId }));
  if (!tasks.length) return;
  const projectId = project.id;
  const settled = new Set();
  if (resumeUnsub) resumeUnsub();
  resumeUnsub = api.onJobs ? api.onJobs((type, data) => {
    const result = data && data.result;
    const meta = data && data.meta;
    if (meta && meta.projectId && meta.projectId !== projectId) return;
    const shotId = (result && result.shotId) || (meta && meta.shotId) || (data && data.shotId);
    if (!shotId) return;
    const task = tasks.find((t) => t.shotId === shotId);
    if (!task) return;
    const taskId = (meta && meta.taskId) || (data && data.taskId) || (data && data.data && data.data.taskId) || task.taskId;
    if (type === 'done') {
      settled.add(shotId);
      videogenJobs.delete(shotId);
      if (sameProject(projectId)) setKeyed('shotBusy', shotId, null);
      if (result && result.asset) finishVideo(projectId, shotId, result.asset, task.provider, result.taskId || taskId);
    } else if (type === 'error') {
      settled.add(shotId);
      videogenJobs.delete(shotId);
      if (sameProject(projectId)) {
        setKeyed('shotBusy', shotId, null);
        const cancelled = !!(data && data.cancelled);
        const errMsg = (data && (data.error || data.message)) || '生成失败';
        setVideoTask(projectId, shotId, {
          provider: task.provider,
          taskId: cancelled ? null : taskId,
          state: cancelled ? 'cancelled' : 'error',
          progress: 0,
          error: cancelled ? null : errMsg,
        });
      }
    } else if (type === 'progress') {
      if (data && data.jobId && !settled.has(shotId)) videogenJobs.set(shotId, data.jobId);
      if (sameProject(projectId)) {
        const prog = (data && data.progress) || 0;
        const curBusy = getUI().shotBusy[shotId];
        const jobId = (data && data.jobId) || (curBusy && curBusy.jobId) || videogenJobs.get(shotId) || null;
        setKeyed('shotBusy', shotId, {
          kind: 'videogen',
          jobId,
          progress: typeof (data && data.progress) === 'number' ? data.progress : (curBusy ? curBusy.progress : null),
          cancelling: !!(curBusy && curBusy.cancelling),
          label: curBusy && curBusy.cancelling ? '正在取消…' : ((data && data.message) || `AI 视频生成中 ${Math.round(prog * 100)}%`),
        });
        setVideoTask(projectId, shotId, { provider: task.provider, taskId, state: 'running', progress: prog, error: null });
      }
    }
  }) : null;
  try {
    const resumed = await api.videogen.resume({ projectId, tasks });
    let startedCount = 0;
    for (const r of Array.isArray(resumed) ? resumed : []) {
      if (!r || !r.shotId || settled.has(r.shotId)) continue;
      const task = tasks.find((t) => t.shotId === r.shotId);
      if (r.jobId) {
        startedCount += 1;
        videogenJobs.set(r.shotId, r.jobId);
        if (sameProject(projectId)) {
          const curBusy = getUI().shotBusy[r.shotId];
          setKeyed('shotBusy', r.shotId, {
            kind: 'videogen',
            jobId: r.jobId,
            progress: curBusy ? curBusy.progress : null,
            cancelling: !!(curBusy && curBusy.cancelling),
            label: (curBusy && curBusy.label) || '正在恢复 AI 视频任务…',
          });
        }
      } else if (r.error && task && sameProject(projectId)) {
        setVideoTask(projectId, r.shotId, { provider: task.provider, taskId: task.taskId, state: 'error', progress: 0, error: r.error });
      }
    }
    if (startedCount) toast(`正在继续查询 ${startedCount} 段 AI 视频的生成结果`, 'info');
    else if (!Array.isArray(resumed)) toast(`正在继续查询 ${tasks.length} 段 AI 视频的生成结果`, 'info');
  } catch (e) {
    toast(`AI 视频任务恢复失败：${e.message}`, 'error');
  }
}

// 打开项目时自动恢复未完成任务
useStore.subscribe((state, prev) => {
  const id = state.project && state.project.id;
  if (id && id !== (prev.project && prev.project.id)) setTimeout(() => { resumeVideoTasks().catch(() => {}); }, 0);
});

// ---------- 联网参考 ----------

async function ytdlpInstalled() {
  const { ytdlp } = getUI();
  if (ytdlp && Date.now() - ytdlp.checkedAt < YTDLP_CHECK_TTL_MS) return ytdlp.installed;
  let installed;
  try {
    installed = !!(await api.call('web:ytdlpStatus')).installed;
  } catch {
    const { appInfo } = S();
    installed = !!(appInfo && appInfo.ytdlp && appInfo.ytdlp.ok);
  }
  setUI({ ytdlp: { installed, checkedAt: Date.now() } });
  return installed;
}

async function searchShot(shot, customQuery) {
  const sources = pickSources({ ytdlpInstalled: await ytdlpInstalled(), settings: S().settings });
  const plan = buildSearchPlan(shot, sources, customQuery);
  if (!plan.length) {
    return { results: [], errors: [{ source: '搜索', error: '这一镜还没有搜索词，请先填写标题或主体' }], sources, query: '' };
  }
  const parts = await Promise.all(plan.map((step) => (
    withConsent(
      () => withTimeout(api.call('web:search', { query: step.query, sources: step.sources, kind: 'video', limit: 6 }), SEARCH_TIMEOUT_MS, '联网搜索超时，请检查网络后重试'),
      'videoSites',
    ).catch((e) => (
      isConsentDeclined(e)
        ? { results: [], errors: [], declined: true }
        : { results: [], errors: step.sources.map((source) => ({ source, error: e.message })) }
    ))
  )));
  return {
    results: mergeResults(parts.map((p) => p.results)),
    errors: parts.flatMap((p) => p.errors || []),
    declined: parts.some((p) => p.declined),
    sources,
    query: plan.map((step) => step.query).join(' / '),
  };
}

function saveReferences(projectId, shotId, results) {
  S().update((p) => (p.id === projectId && p.storyboard.some((s) => s.id === shotId) ? withReferences(p, shotId, results) : p));
}

/** 查找一镜的参考并打开抽屉。query 为用户在抽屉里改过的搜索词。 */
export async function findReferences(shotId, { query } = {}) {
  const { project } = S();
  const shot = findShot(shotId);
  if (!project || !shot) return;
  setUI({ drawerShotId: shotId });
  const status = getUI().refStatus[shotId];
  if (status && status.loading) return;
  setKeyed('refStatus', shotId, { loading: true, errors: [], query: query || '', sources: [] });
  const out = await searchShot(shot, query);
  if (!sameProject(project.id)) return;
  // 空结果不覆盖上一次的结果：网络失败时用户还能看到之前搜到的内容
  if (out.results.length) saveReferences(project.id, shotId, out.results);
  setKeyed('refStatus', shotId, { loading: false, errors: out.errors, query: out.query, sources: out.sources });
}

/** 逐镜搜索。已有参考的镜头跳过；全部都有时整体刷新一遍。 */
export async function findAllReferences() {
  const { project } = S();
  if (!project || getUI().batch || !project.storyboard.length) return;
  const missing = project.storyboard.filter((s) => !(project.references[s.id] && project.references[s.id].length));
  const targets = missing.length ? missing : project.storyboard;
  const token = startBatch('references', targets.length);
  let found = 0;
  let empty = 0;
  let processed = 0;
  for (let i = 0; i < targets.length; i += 1) {
    if (batchCancelled(token)) break;
    const shot = targets[i];
    patchBatch({ done: i, label: `第 ${shot.index} 镜：${shot.title}` });
    const out = await searchShot(shot);
    if (!batchAlive(token)) return;
    if (out.declined) { patchBatch({ cancelled: true }); break; }
    processed += 1;
    if (out.results.length) { saveReferences(project.id, shot.id, out.results); found += 1; } else empty += 1;
    setKeyed('refStatus', shot.id, { loading: false, errors: out.errors, query: out.query, sources: out.sources });
  }
  if (!batchAlive(token)) return;
  const { cancelled } = getUI().batch;
  setUI({ batch: null });
  if (cancelled) toast(`已取消，已搜索 ${processed}/${targets.length} 镜`);
  else if (empty) toast(`${found} 镜找到了参考，${empty} 镜没有结果`, found ? 'info' : 'error');
  else toast(`已为 ${found} 镜找到参考`, 'ok');
}

function maxDownloadSeconds() {
  const { settings } = S();
  return (settings && settings.web && settings.web.maxDownloadSeconds) || 180;
}

/** 下载到项目素材（Asset 由 web:download 生成，source.url 记录来源） */
export async function downloadReference(result) {
  const { project } = S();
  const key = resultKey(result);
  const cur = getUI().downloads[key];
  if (!project || (cur && cur.status === 'running')) return;
  const projectId = project.id;
  setKeyed('downloads', key, { status: 'running', progress: 0, jobId: null, assetId: null, error: '' });
  try {
    const out = await withConsent(() => S().trackJob(
      'web:download',
      { result, target: 'project', projectId, maxSeconds: maxDownloadSeconds(), withSubs: false },
      `下载素材：${result.title}`,
      (p) => patchKeyed('downloads', key, { progress: p.progress || 0, jobId: p.jobId }),
    ), 'videoSites');
    if (!sameProject(projectId)) return;
    if (!out || !out.asset) throw new Error('下载完成但没有拿到素材');
    addAssets([out.asset], '下载参考到素材');
    patchKeyed('downloads', key, { status: 'done', progress: 1, assetId: out.asset.id });
    toast(`已下载到素材箱：${result.title}`, 'ok');
  } catch (e) {
    if (!sameProject(projectId)) return;
    if (e.cancelled || isConsentDeclined(e)) { setKeyed('downloads', key, null); return; }
    patchKeyed('downloads', key, { status: 'error', error: e.message });
    toast(`下载失败：${e.message}`, 'error');
  }
}

export function cancelDownload(result) {
  const cur = getUI().downloads[resultKey(result)];
  if (cur && cur.jobId) api.cancel(cur.jobId).catch(() => {});
}

/** 下载并送进拆片库。分析结果存在库里，不依赖当前项目。 */
export async function analyzeReference(result) {
  const key = resultKey(result);
  const cur = getUI().analyzing[key];
  if (cur && cur.status === 'running') return;
  setKeyed('analyzing', key, { status: 'running', progress: 0, jobId: null, error: '' });
  try {
    await withConsent(() => S().trackJob(
      'analysis:start',
      { url: result.downloadUrl || result.url, title: result.title, category: guessCategory(result), useAI: true },
      `拆片学习：${result.title}`,
      (p) => patchKeyed('analyzing', key, { progress: p.progress || 0, jobId: p.jobId }),
    ), 'videoSites');
    patchKeyed('analyzing', key, { status: 'done', progress: 1 });
    toast(`拆片完成，可到拆片库查看：${result.title}`, 'ok');
  } catch (e) {
    if (e.cancelled || isConsentDeclined(e)) { setKeyed('analyzing', key, null); return; }
    patchKeyed('analyzing', key, { status: 'error', error: e.message });
    toast(`拆片失败：${e.message}`, 'error');
  }
}

export function cancelAnalyze(result) {
  const cur = getUI().analyzing[resultKey(result)];
  if (cur && cur.jobId) api.cancel(cur.jobId).catch(() => {});
}

export function openExternal(url) {
  if (!url) return;
  api.call('shell:openExternal', { url }).catch((e) => toast(`无法打开网页：${e.message}`, 'error'));
}

// ---------- AI 画面 / AI 修改此镜 ----------

export async function generateShotImage(shotId) {
  const { project } = S();
  const shot = findShot(shotId);
  if (!project || !shot || getUI().shotBusy[shotId]) return;
  const projectId = project.id;
  setKeyed('shotBusy', shotId, { kind: 'image', label: '正在生成 AI 画面…', jobId: null, cancelling: false });
  try {
    const aspect = project.settings.aspect;
    const size = imageSizeForAspect(aspect);
    const prompt = buildImagePrompt(shot, project.brief);
    const out = await S().trackJob(
      'ai:image',
      { prompt, aspect, size, projectId },
      `AI 画面：第 ${shot.index} 镜`,
      (p) => patchKeyed('shotBusy', shotId, { jobId: p.jobId }),
    );
    if (!sameProject(projectId)) return;
    if (!out || !out.path) throw new Error('图片服务没有返回文件');
    const [fallbackW, fallbackH] = size.split('x').map(Number);
    const width = Number(out.width) > 0 ? Number(out.width) : fallbackW;
    const height = Number(out.height) > 0 ? Number(out.height) : fallbackH;
    const aiProvider = (out && (out.provider || out.engine)) || '';
    const asset = createAsset({
      kind: 'generated-image',
      name: `AI 画面 · ${shot.title}`,
      path: out.path,
      duration: shot.duration,
      width,
      height,
      // type 兼容按类型分类的读法，kind 标识统一来源分类
      source: { kind: 'ai', type: 'ai-image', ...(aiProvider ? { provider: aiProvider } : {}) },
      tags: ['AI 画面'],
      description: [shot.subject, shot.action].filter(Boolean).join('，'),
    });
    // AI 生成标记，导出时据此加「AI 生成」角标和隐式标识
    const aiMark = { provider: aiProvider || 'unknown', createdAt: new Date().toISOString(), prompt: String(prompt || '').slice(0, 1000) };
    if (out && out.model) aiMark.model = out.model;
    asset.ai = asset.ai || aiMark;
    asset.license = asset.license || { id: 'ai' };
    api.call('media:register', { paths: [out.path] }).catch(() => {});
    const r = S().commit((p) => {
      const withAsset = { ...p, assets: { ...p.assets, [asset.id]: asset } };
      const target = withAsset.storyboard.find((s) => s.id === shotId);
      if (!target || target.assetId) return withAsset;
      return withShotPatch(withAsset, shotId, { assetId: asset.id });
    }, `生成第 ${shot.index} 镜 AI 画面`);
    if (reportCommit(r, 'AI 画面未保存')) toast(`第 ${shot.index} 镜的 AI 画面已生成`, 'ok');
  } catch (e) {
    if (e.cancelled) toast('已取消生成 AI 画面');
    else toast(`AI 画面生成失败：${e.message}`, 'error');
  } finally {
    if (sameProject(projectId)) setKeyed('shotBusy', shotId, null);
  }
}

export async function refineShot(shotId, instruction) {
  const { project } = S();
  const shot = findShot(shotId);
  const text = String(instruction == null ? '' : instruction).trim();
  if (!project || !shot || !text || getUI().shotBusy[shotId]) return;
  const projectId = project.id;
  setKeyed('shotBusy', shotId, { kind: 'refine', label: 'AI 正在修改此镜…', jobId: null, cancelling: false });
  try {
    const brief = baseBrief(project);
    const techniques = pickTechniques(`${text} ${shot.title || ''} ${shot.subject || ''} ${brief.style || ''}`);
    const validTechniqueIds = allTechniques().map((t) => t.id);
    const request = buildShotRefineRequest({ brief, shot, instruction: text, techniques });
    const r = await runAI({ ...request, timeoutMs: REFINE_TIMEOUT_MS }, {
      onStart: (jobId) => patchKeyed('shotBusy', shotId, { jobId }),
    });
    if (!sameProject(projectId)) return;
    const latest = findShot(shotId);
    if (!latest) { toast('这一镜已被删除，AI 的修改没有应用'); return; }
    const refined = parseShotRefineResponse(r.data, shot, { validTechniqueIds });
    // AI 只改内容，素材与预演资产的关联以当前分镜为准
    const next = normalizeShot({ ...refined, id: shotId, assetId: latest.assetId, previzAssetId: latest.previzAssetId, footageAssetId: latest.footageAssetId || null, footageTried: latest.footageTried }, latest.index);
    // AI 视频的关联同样以当前分镜为准（normalizeShot 可能不认识这些新字段）
    for (const k of ['aiVideoAssetId', 'aiVideoTask', 'mediaSource']) if (latest[k] !== undefined) next[k] = latest[k];
    const ok = reportCommit(S().commit((p) => withShotPatch(p, shotId, next), `AI 修改第 ${latest.index} 镜`), 'AI 的修改未应用');
    if (ok) toast(`第 ${latest.index} 镜已按你的要求修改，可撤销`, 'ok');
  } catch (e) {
    if (e.cancelled) toast('已取消修改');
    else if (noAI(e)) {
      toast('还没连接 AI，没法按一句话改这一镜。已打开编辑器，可以手动调整。', 'info', undefined, {
        key: 'create-refine-noai',
        action: { label: '去连接', run: () => { try { S().openDialog && S().openDialog('settings', 'ai'); } catch { /* ignore */ } } },
      });
      if (sameProject(projectId)) setUI({ editorShotId: shotId });
    } else toast(`AI 修改失败：${e.message}`, 'error');
  } finally {
    if (sameProject(projectId)) setKeyed('shotBusy', shotId, null);
  }
}

/** 取消按钮在拿到 jobId 后才显示 */
export function cancelShotJob(shotId) {
  const busy = getUI().shotBusy[shotId];
  if (!busy || !busy.jobId) return;
  patchKeyed('shotBusy', shotId, { cancelling: true });
  api.cancel(busy.jobId).catch(() => {});
}

// ---------- 一键初剪 ----------

export async function firstCut() {
  const { project } = S();
  if (!project) return;
  if (!project.storyboard.length) { toast('还没有分镜，先生成分镜再初剪'); return; }
  const clipCount = project.tracks.video.length;
  if (clipCount) {
    // 主轨还是按当前分镜剪的（例如示例项目）：直接去剪辑，不弹吓人的「覆盖」确认
    if (timelineMatchesBoard(project)) { S().setMode('refine'); return; }
    const answer = await askConfirm({
      title: '分镜改过了，要重新初剪吗？',
      body: `时间线主轨上已有 ${clipCount} 个片段。重新初剪会按现在的分镜重排主轨，你在剪辑里做的改动会被替换（可以撤销）；也可以保留现有剪辑直接过去。`,
      confirmLabel: '覆盖主轨重新初剪',
      altLabel: '保留现有剪辑',
    });
    if (answer === 'alt') { if (sameProject(project.id)) S().setMode('refine'); return; }
    if (!answer || !sameProject(project.id)) return;
  }
  // 新建项目首次初剪：缺画面的镜头先自动配实拍素材（优先级：用户素材 > AI 视频 > 实拍 > previz）
  if (!clipCount) {
    const missing = project.storyboard.filter((s) => !shotMediaPick(s, project.assets).kind || shotMediaPick(s, project.assets).kind === 'previz');
    if (missing.length) {
      toast(`正在为 ${missing.length} 个镜头自动配真人实拍素材…`, 'info', 4000);
      await fillAllFootage({ quiet: true, onlyMissing: true });
      if (!S().project || S().project.id !== project.id) return;
    }
  }
  let report = [];
  const r = S().commit((p) => {
    const out = buildFirstCut(p);
    report = out.report;
    return out.project;
  }, '一键初剪');
  if (!reportCommit(r, '初剪失败')) return;
  S().setPlayhead(0);
  toast(summarizeReport(report), 'ok', 6000);
  S().setMode('refine');
}

// 模块加载时项目可能已打开（切到创作模式才加载本模块）
setTimeout(() => { resumeVideoTasks().catch(() => {}); }, 0);
