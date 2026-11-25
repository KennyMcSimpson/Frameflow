// 通用撤销/重做栈。保存状态引用，要求状态本身是不可变的。
//
//   const h = createHistory();
//   h.push(prevState, '调色');                       // 修改前调用：记录旧状态，并清空重做栈
//   h.push(prevState, { label, mergeKey, selection, next }) // 带合并键：相同 mergeKey 且间隔 < 600ms 合并为一步
//   const r = h.apply(project, op, { label, mergeKey, ctx, selection }) // 执行 op 并入栈（空操作不入栈）
//   const u = h.undo(currentState, currentSelection); // → { state, label, selection } | null
//   h.undoLabel() / h.redoLabel()                    // 中文描述或 null
import { applyOps, describeOp } from './ops.js';

export const MERGE_WINDOW_MS = 600;

function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

/** 结构相等（用于空操作去重）；只在引用不同时才做 JSON 比较 */
export function sameState(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  try {
    const strip = (p) => (p && typeof p === 'object' && 'updatedAt' in p ? { ...p, updatedAt: null } : p);
    return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
  } catch {
    return false;
  }
}

export function createHistory(limit = 100, { mergeWindow = MERGE_WINDOW_MS, clock = now } = {}) {
  const max = Number.isInteger(limit) && limit > 0 ? limit : 100;
  let past = [];
  let future = [];

  function record(state, opts) {
    const o = typeof opts === 'string' ? { label: opts } : opts || {};
    const label = o.label || '修改';
    // 空操作：修改后的状态与修改前相同，不入栈也不清重做栈
    if (o.next !== undefined && sameState(state, o.next)) return 'noop';
    const t = Number.isFinite(o.time) ? o.time : clock();
    const top = past[past.length - 1];
    if (top && o.mergeKey && top.mergeKey === o.mergeKey && t - top.time < mergeWindow) {
      // 合并：保留最早的旧状态，刷新时间与标签（连续拖动滑块只算一步）
      future = [];
      past = [...past.slice(0, -1), { ...top, label, time: t }];
      return 'merged';
    }
    if (top && top.state === state) return 'same';
    future = [];
    past = [...past, { state, label, mergeKey: o.mergeKey || null, time: t, selection: o.selection ?? null }].slice(-max);
    return 'pushed';
  }

  return {
    /** 记录修改前的状态。第二参可为标签字符串或 { label, mergeKey, selection, next, time }。返回 'pushed'|'merged'|'same'|'noop' */
    push(state, opts = '修改') {
      return record(state, opts);
    },
    /**
     * 执行一条或一批 op 并记录历史。label 缺省用 describeOp 生成中文描述。
     * @returns {{ok, project, applied, errors, label, recorded}}
     */
    apply(project, opOrOps, { label, mergeKey, ctx, selection } = {}) {
      const ops = Array.isArray(opOrOps) ? opOrOps : [opOrOps];
      const r = applyOps(project, ops, ctx);
      if (!r.ok) return { ...r, label: null, recorded: 'failed' };
      const text = label || (ops.length === 1 ? describeOp(ops[0], project) : (r.applied || []).join('；')) || '修改';
      const recorded = record(project, { label: text, mergeKey, selection, next: r.project });
      return { ...r, project: recorded === 'noop' ? project : r.project, label: text, recorded };
    },
    undo(current, currentSelection = null) {
      if (!past.length) return null;
      const entry = past[past.length - 1];
      past = past.slice(0, -1);
      future = [{ state: current, label: entry.label, selection: currentSelection, mergeKey: null, time: 0 }, ...future].slice(0, max);
      return { state: entry.state, label: entry.label, selection: entry.selection };
    },
    redo(current, currentSelection = null) {
      if (!future.length) return null;
      const entry = future[0];
      future = future.slice(1);
      past = [...past, { state: current, label: entry.label, selection: currentSelection, mergeKey: null, time: 0 }].slice(-max);
      return { state: entry.state, label: entry.label, selection: entry.selection };
    },
    clear() {
      past = [];
      future = [];
    },
    /** 打断合并（例如鼠标松开时调用），下一次同 mergeKey 的修改单独成步 */
    seal() {
      const top = past[past.length - 1];
      if (top) past = [...past.slice(0, -1), { ...top, mergeKey: null }];
    },
    undoLabel() { return past.length ? past[past.length - 1].label : null; },
    redoLabel() { return future.length ? future[0].label : null; },
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    get size() { return { past: past.length, future: future.length }; },
  };
}
