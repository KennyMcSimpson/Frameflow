// AI 操作预检（ROADMAP P0-10 S1）：执行前在工程副本上逐条试运行，找出会失败的操作。
// - 每条诊断带 opIndex（传入 ops 的下标，从 0 开始）和中文原因；
// - 能做的照常做，做不了的列出来（部分应用），不再因为一条出错整批作废；
// - 可修的错误（编号越界、素材不存在、参数不对、没有作用对象）可以交给模型定向修复 1 次；
//   锁定、上限、前置条件不满足这类问题不交给模型，直接告诉用户怎么处理。
// 思路参考 NarratoAI（MIT License，https://github.com/linyqh/NarratoAI）的
// short_drama_narration_validation.py 与 script_repair.py：先做确定性校验，只把出错的部分连同局部上下文交给模型修。
// 本文件为独立实现，未复制其代码。
import { applyOps } from '../engine/ops.js';
import { layoutVideo, itemsInRange, projectDuration } from '../engine/timeline.js';

/** 诊断类别 → 中文 */
export const LINT_CODES = Object.freeze({
  out_of_range: '编号或时间超出范围',
  locked: '片段或轨道已锁定',
  missing_asset: '素材不存在',
  missing_item: '要改的对象不存在',
  no_target: '没有作用对象',
  limit: '超出上限',
  precondition: '缺少前提条件',
  invalid: '参数不对',
  dependency: '前一步没有执行',
  unknown: '无法执行',
});

/** 可以交给模型定向修复的类别 */
const REPAIRABLE = new Set(['out_of_range', 'missing_asset', 'missing_item', 'no_target', 'invalid']);

/** 会改变主轨片段数量或顺序的操作：它们失败后，后面按编号定位的操作可能会对不上 */
const STRUCTURAL = new Set(['delete', 'rippleDelete', 'split', 'duplicate', 'move', 'insertAsset', 'freezeFrame']);

/** 引擎提示统一成时间线上的叫法（片段） */
export function friendlyMessage(msg) {
  return String(msg || '')
    .replace(/第\s*(\d+)\s*镜/g, '第 $1 个片段')
    .replace(/共\s*(\d+)\s*镜/g, '共 $1 个片段')
    .replace(/第一镜/g, '第一个片段')
    .replace(/镜头/g, '片段');
}

/** 按引擎的中文报错归类 */
export function classifyOpError(message) {
  const m = String(message || '');
  if (/锁定/.test(m)) return 'locked';
  if (/主轨最多|总时长不能超过/.test(m)) return 'limit';
  if (/请先添加|请先分析|没有可用的|没有可以|时间线上还没有/.test(m)) return 'precondition';
  if (/素材/.test(m) && /(找不到|不存在|缺少素材|还没有加入)/.test(m)) return 'missing_asset';
  if (/请先选中|还没有框选|范围内没有|需要指定/.test(m)) return 'no_target';
  if (/第\s*\d+\s*(镜|个片段)不存在|编号|超出了成片/.test(m)) return 'out_of_range';
  if (/找不到|不存在|已被删除/.test(m)) return 'missing_item';
  if (/^操作执行失败/.test(m)) return 'unknown';
  if (/必须|不能|不支持|格式|不正确|只能|至少|没有要修改|不合法|无效/.test(m)) return 'invalid';
  return 'unknown';
}

function diag(opIndex, op, message, code) {
  const c = code || classifyOpError(message);
  return {
    opIndex,
    type: op && typeof op === 'object' && typeof op.type === 'string' ? op.type : '',
    code: c,
    message: friendlyMessage(message) || LINT_CODES[c] || '无法执行',
    repairable: REPAIRABLE.has(c),
  };
}

function videoIds(project) {
  const v = project && project.tracks && Array.isArray(project.tracks.video) ? project.tracks.video : [];
  return v.map((c) => c.id);
}

/** 框选范围在批次开始时包含的片段 id（与引擎 applyOps 的约定一致） */
function stableRangeIds(project, ctx) {
  const r = ctx && ctx.range;
  if (!r || !(Number(r.end) > Number(r.start))) return null;
  try { return itemsInRange(layoutVideo(project), r.start, r.end).map((it) => it.clip.id); } catch { return []; }
}

/** 这条操作是否按编号/位置定位（前面的结构修改没执行时可能会改错地方） */
function positional(op) {
  const t = op && op.target;
  if (t && t.mode === 'index') return true;
  if (op && op.type === 'insertAsset' && op.atIndex != null) return true;
  return false;
}

/** 时间类参数的确定性检查：不能落在成片之外（避免在片尾后面凭空拖出一大段空白） */
function timeIssue(draft, op) {
  let t = null; let what = '';
  if (op.type === 'addText' && op.text) { t = op.text.start; what = '文字出现时间'; }
  else if (op.type === 'addAudio' && op.audio) { t = op.audio.start; what = '音乐开始时间'; }
  else if (op.type === 'addMarker') { t = op.t; what = '标记时间'; }
  else if (op.type === 'freezeFrame' || op.type === 'split') { t = op.at; what = op.type === 'split' ? '分割时间' : '定格时间'; }
  if (!Number.isFinite(t)) return null;
  let total = 0;
  try { total = projectDuration(draft); } catch { total = 0; }
  if (total > 0 && t > total + 0.5) return `${what} ${Math.round(t * 10) / 10} 秒超出了成片长度（共 ${Math.round(total * 10) / 10} 秒）`;
  return null;
}

/**
 * 在工程副本上逐条预检 AI 操作。
 * range 目标会在批次开始时固定成片段 id，保证逐条执行和整批执行结果一致。
 * @param {object} project
 * @param {object[]} ops 已规范化的 Op
 * @param {{selectedClipIds?:string[], range?:{start,end}|null, playhead?:number}} [ctx]
 * @returns {{ok:boolean, project:object, ops:object[], passIndex:number[], applied:string[], diagnostics:object[]}}
 *   project：只应用通过项后的工程（没有通过项时是原对象）；ops：通过项（range 已固定为 ids）；
 *   passIndex：通过项在原 ops 中的下标；diagnostics：[{opIndex, type, code, message, repairable}]
 */
export function lintOps(project, ops, ctx = {}) {
  const list = Array.isArray(ops) ? ops : [];
  if (!project || typeof project !== 'object') {
    return { ok: !list.length, project, ops: [], passIndex: [], applied: [], diagnostics: list.map((op, i) => diag(i, op, '没有打开的项目', 'precondition')) };
  }
  const c = ctx || {};
  const stable = stableRangeIds(project, c);
  const diagnostics = [];
  const passOps = [];
  const passIndex = [];
  let draft = project;
  let structuralBroken = false;

  list.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') {
      diagnostics.push(diag(i, raw, '操作格式不正确', 'invalid'));
      return;
    }
    const fail = (message, code) => {
      diagnostics.push(diag(i, raw, message, code));
      if (STRUCTURAL.has(raw.type)) structuralBroken = true;
    };
    if (structuralBroken && positional(raw)) {
      fail('前面增删或移动片段的那一步没有执行，这条按编号定位的修改可能会改错片段，已跳过', 'dependency');
      return;
    }
    let op = raw;
    if (raw.target && raw.target.mode === 'range' && stable) {
      const present = new Set(videoIds(draft));
      const ids = stable.filter((id) => present.has(id));
      if (!ids.length) { fail('框选范围内没有片段', 'no_target'); return; }
      op = { ...raw, target: { mode: 'ids', indices: [], ids } };
    }
    const issue = timeIssue(draft, op);
    if (issue) { fail(issue, 'out_of_range'); return; }
    let r;
    try { r = applyOps(draft, [op], c); } catch (e) { r = { ok: false, errors: [`操作执行失败：${e && e.message ? e.message : e}`] }; }
    if (r && r.ok) {
      draft = r.project;
      passOps.push(op);
      passIndex.push(i);
    } else {
      fail((r && r.errors && r.errors[0]) || '无法执行');
    }
  });

  // 通过项整批原子执行一次，结果与 commit 时一致
  let result = project;
  let applied = [];
  if (passOps.length) {
    let r;
    try { r = applyOps(project, passOps, c); } catch (e) { r = { ok: false, errors: [`操作执行失败：${e && e.message ? e.message : e}`] }; }
    if (r && r.ok) {
      result = r.project;
      applied = (r.applied || []).map(friendlyMessage);
    } else {
      // 罕见：逐条都能做，合在一起超出上限
      const msg = (r && r.errors && r.errors[0]) || '这些修改合在一起无法执行';
      for (const i of passIndex) diagnostics.push(diag(i, list[i], msg));
      passOps.length = 0;
      passIndex.length = 0;
    }
  }
  diagnostics.sort((a, b) => a.opIndex - b.opIndex);
  return { ok: diagnostics.length === 0, project: result, ops: passOps, passIndex, applied, diagnostics };
}

/** 可以交给模型定向修复的诊断 */
export function repairableDiagnostics(diagnostics) {
  return (Array.isArray(diagnostics) ? diagnostics : []).filter((d) => d && d.repairable);
}

/** 给用户看的跳过说明：「第 3 步（调色）：第 9 个片段不存在（当前共 5 个片段）」 */
export function skippedLines(diagnostics, describe) {
  return (Array.isArray(diagnostics) ? diagnostics : []).map((d) => {
    const what = typeof describe === 'function' ? describe(d) : '';
    return `${what ? `${what}：` : ''}${d.message}`;
  });
}
