// AI 精修面板：白话指令 → 本地理解立即生效 / 交给 AI（执行前逐条检查，必要时自动修正一次）
// → 小改动直接生效、大改动先确认（附改动对比）→ 消息记录、撤销、缺素材自动找。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import useStore from '../../store.js';
import api from '../../api.js';
import { getLocale, useLocale } from '../../i18n.js';
import { uid } from '../../../engine/ids.js';
import { parseCommand } from '../../../engine/localnlp.js';
import { layoutVideo, itemsInRange } from '../../../engine/timeline.js';
import { searchTechniques } from '../../../engine/techniques.js';
import { runAI, isNoAI, isCancelled } from '../../../ai/client.js';
import { runEditPipeline, applyEditPlan, pickLibraryCandidates, describeEditOp } from '../../../ai/editor.js';
import { addMemory, ruleFromCommand } from '../../../ai/memory.js';
import { Button, Icon, Segmented, Spinner, Chip, ProgressBar } from '../../components/ui.jsx';
import SideMaterialCard from './SideMaterialCard.jsx';
import { allTechniques, queryLibraryAssets, fmtRange, readPref, writePref } from './SideData.js';

const QUICK = ['整体暖一点', '节奏快一点', '统一全片色调', '第一个片段加标题', '转场都改成叠化', '加点颗粒感'];
const QUICK_EN = ['Warmer overall', 'Faster pacing', 'Match color across clips', 'Add title to first clip', 'Use cross-dissolves', 'Add subtle film grain'];
const EXAMPLES = ['第2个片段暖一点、对比度高一点', '所有转场改成叠化', '第一个片段加标题“春日咖啡”', '第3段慢放到0.5倍', '最后一段加电影黑边', '以后都不要用转场'];
const EXAMPLES_EN = ['Make clip 2 warmer with higher contrast', 'Change all transitions to dissolve', 'Add title "Morning Coffee" to clip 1', 'Slow clip 3 to 0.5x', 'Add cinema bars to the last clip', 'Never use transitions from now on'];
const PRESET_LABEL = {
  openai: { zh: 'OpenAI', en: 'OpenAI' },
  deepseek: { zh: 'DeepSeek', en: 'DeepSeek' },
  anthropic: { zh: 'Anthropic Claude', en: 'Anthropic Claude' },
  gemini: { zh: 'Google Gemini', en: 'Google Gemini' },
  openrouter: { zh: 'OpenRouter', en: 'OpenRouter' },
  ark: { zh: '火山方舟', en: 'Volcengine Ark' },
  ollama: { zh: 'Ollama 本地', en: 'Ollama (Local)' },
  lmstudio: { zh: 'LM Studio', en: 'LM Studio' },
};
const PRESET_CHIP = {
  openai: { zh: 'OpenAI', en: 'OpenAI' },
  deepseek: { zh: 'DeepSeek', en: 'DeepSeek' },
  anthropic: { zh: 'Anthropic Claude', en: 'Anthropic Claude' },
  gemini: { zh: 'Gemini', en: 'Gemini' },
  openrouter: { zh: 'OpenRouter', en: 'OpenRouter' },
  ark: { zh: '火山方舟', en: 'Volcengine Ark' },
  ollama: { zh: 'Ollama', en: 'Ollama' },
  lmstudio: { zh: 'LM Studio', en: 'LM Studio' },
};
const PROVIDER_CHIP = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  gemini: 'Gemini CLI',
  anthropic: 'Anthropic Claude',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
};
const MAX_MESSAGES = 200;
const SLOW_AFTER_MS = 90000;
/** 流程阶段（runEditPipeline 的 onPhase）→ 给人看的说法 */
const STEP_TEXT = {
  整理上下文: '正在整理全片上下文',
  理解指令: 'AI 正在理解你的要求',
  检查修改: '正在检查每一步能不能执行',
  修正细节: '有几步需要调整，AI 正在修正',
};
const STEP_TEXT_EN = {
  整理上下文: 'Gathering project context',
  理解指令: 'Understanding your request',
  检查修改: 'Validating each edit step',
  修正细节: 'Refining edit steps',
};

// 局部样式仅使用设计令牌
const STYLE = `
.aie-msg .aie-reason { display: block; color: var(--text-2); font-size: var(--fs-xs); line-height: 1.45; }
.aie-confirm { display: flex; align-items: flex-start; gap: 6px; padding: 6px 8px; border: 1px solid color-mix(in srgb, var(--warn) 35%, transparent); border-radius: var(--radius-s); background: var(--warn-soft); color: var(--text-0); font-size: var(--fs-xs); line-height: 1.5; }
.aie-confirm > .icon { flex: none; margin-top: 2px; color: var(--warn); }
.aie-confirm b { font-weight: 600; }
.aie-diff, .aie-skip, .aie-unsup { padding: 5px 7px; border-radius: var(--radius-s); background: var(--bg-1); }
.aie-diff ul, .aie-skip ul { margin: 0; padding-left: 16px; color: var(--text-1); font-size: var(--fs-xs); line-height: 1.6; }
.aie-skip { border-left: 2px solid var(--warn); }
.aie-unsup { display: flex; flex-direction: column; gap: 5px; color: var(--text-1); font-size: var(--fs-xs); line-height: 1.5; }
.aie-unsup-item { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; }
.aie-unsup-item b { color: var(--text-0); font-weight: 600; }
.aie-plan { color: var(--text-1); font-size: var(--fs-xs); }
.aie-plan > summary { color: var(--text-2); cursor: pointer; }
.aie-plan > summary:hover { color: var(--text-0); }
.aie-plan ol { margin: 4px 0 0; padding-left: 18px; line-height: 1.6; }
.aie-plan-assume { margin-top: 3px; color: var(--text-2); }
.aie-note { display: flex; align-items: flex-start; gap: 4px; color: var(--text-2); font-size: var(--fs-xs); line-height: 1.45; }
.aie-note > .icon { flex: none; margin-top: 2px; }
.aie-elapsed { flex: none; color: var(--text-2); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }
.aie-slow { display: flex; align-items: center; gap: 5px; margin-top: 2px; color: var(--warn); font-size: var(--fs-xs); line-height: 1.45; }
.aie-slow > .icon { flex: none; }
.aie-compose .aie-preview-toggle { flex-wrap: wrap; row-gap: 4px; }
`;

// 消息 id → { entry: 提交时的历史栈顶条目, memUndo: 该步写入的记忆回滚信息 }；用于判断「是否仍是最近一步」
const undoAnchors = new Map();
let undoAnchorsProjectId = null;

function setUndoAnchor(msgId, entry) {
  const pid = useStore.getState().project?.id || null;
  if (undoAnchorsProjectId !== pid) {
    undoAnchors.clear();
    undoAnchorsProjectId = pid;
  }
  undoAnchors.set(msgId, { entry, memUndo: null });
}

// ---------------- 消息读写（不进撤销历史） ----------------
function pushMsg(msg) {
  useStore.getState().update((p) => {
    const chats = p.chats || {};
    return { ...p, chats: { ...chats, editor: [...(chats.editor || []), msg].slice(-MAX_MESSAGES) } };
  });
}
function patchMsg(id, patch) {
  useStore.getState().update((p) => {
    const chats = p.chats || {};
    return { ...p, chats: { ...chats, editor: (chats.editor || []).map((m) => (m.id === id ? { ...m, ...patch } : m)) } };
  });
}

function shortLabel(text, n = 18) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function safeDescribe(op, project) {
  try { return describeEditOp(op, project) || op.type; } catch { return op && op.type ? `操作：${op.type}` : '未知操作'; }
}

/** [1,2,3] → 「第 1–3 个片段」；[1,3,5] → 「第 1、3、5 个片段」；太多 → 「N 个片段」 */
function describeClipIndices(nums, isEn = false) {
  const arr = Array.from(new Set((nums || []).filter((n) => Number.isFinite(n)))).sort((a, b) => a - b);
  if (!arr.length) return '';
  if (isEn) {
    if (arr.length === 1) return `Clip ${arr[0]}`;
    const contiguous = arr.every((n, i) => i === 0 || n === arr[i - 1] + 1);
    if (contiguous) return `Clips ${arr[0]}–${arr[arr.length - 1]}`;
    if (arr.length <= 5) return `Clips ${arr.join(', ')}`;
    return `${arr.length} clips`;
  }
  if (arr.length === 1) return `第 ${arr[0]} 个片段`;
  const contiguous = arr.every((n, i) => i === 0 || n === arr[i - 1] + 1);
  if (contiguous) return `第 ${arr[0]}–${arr[arr.length - 1]} 个片段`;
  if (arr.length <= 5) return `第 ${arr.join('、')} 个片段`;
  return `${arr.length} 个片段`;
}

function fmtElapsed(ms, isEn = false) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (isEn) return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`;
}

/** 写进项目记忆（不进撤销历史）：规矩永久保留，普通记录过多时自动合并；返回回滚信息 */
function remember(entries) {
  const list = (entries || []).filter((e) => e && typeof e.text === 'string' && e.text.trim());
  if (!list.length) return null;
  const st = useStore.getState();
  const prevDecisions = Array.isArray(st.project && st.project.memory && st.project.memory.decisions)
    ? st.project.memory.decisions
    : [];
  const prevIds = new Set(prevDecisions.map((d) => d && d.id).filter(Boolean));
  let afterDecisions = prevDecisions;
  st.update((p) => {
    const mem = p.memory || { styleGuide: '', decisions: [], colorBaseline: null };
    let decisions = Array.isArray(mem.decisions) ? mem.decisions : [];
    for (const e of list) decisions = addMemory(decisions, e);
    afterDecisions = decisions;
    return { ...p, memory: { ...mem, decisions } };
  });
  const afterIds = new Set(afterDecisions.map((d) => d && d.id).filter(Boolean));
  const addedIds = afterDecisions.filter((d) => d && d.id && !prevIds.has(d.id)).map((d) => d.id);
  const compacted = prevDecisions.some((d) => d && d.id && !afterIds.has(d.id));
  return { addedIds, prevDecisions, compacted };
}

function normalizeLocal(r, text) {
  if (!r || typeof r !== 'object') return { ops: [], understood: [], unknown: [text] };
  return {
    ops: Array.isArray(r.ops) ? r.ops.filter(Boolean) : [],
    understood: Array.isArray(r.understood) ? r.understood.filter(Boolean) : [],
    unknown: Array.isArray(r.unknown) ? r.unknown.filter((u) => String(u || '').trim()) : [],
  };
}

/** 提交并记录撤销锚点 */
function commitWithAnchor(ops, label, msgId, ctx) {
  const st = useStore.getState();
  const r = st.commit(ops, label, { silent: true, ctx });
  if (r.ok) {
    const past = useStore.getState().past;
    if (past.length) setUndoAnchor(msgId, past[past.length - 1]);
  }
  return r;
}

/**
 * 在当前工程上执行 AI 方案：需要的素材库素材并入工程 + 能做的操作，合成一步撤销。
 * 应用前会按当前工程重新检查一遍（等 AI 期间时间线可能又改过），做不了的跳过并列出来。
 * @returns {{ok:boolean, errors:string[], result:object|null}}
 */
function commitPlan(plan, label, msgId, ctx) {
  const st = useStore.getState();
  let result = null;
  const r = st.commit((cur) => {
    result = applyEditPlan(cur, plan, ctx);
    if (!result.ok) {
      const first = result.diagnostics && result.diagnostics[0];
      throw new Error(first ? first.message : '这些修改现在都无法执行');
    }
    return result.project;
  }, label, { silent: true });
  if (r.ok) {
    const past = useStore.getState().past;
    if (past.length) setUndoAnchor(msgId, past[past.length - 1]);
    const paths = ((result && result.assetsAdded) || []).map((a) => a && a.path).filter(Boolean);
    if (paths.length) api.call('media:register', { paths }).catch(() => {});
  }
  return { ok: !!r.ok, errors: r.errors || [], result };
}

/** commitPlan 的结果 → 消息上的状态字段（应用后不再保留素材副本，避免项目文件变大） */
function appliedPatch(r) {
  if (!r.ok) return { status: 'error', errors: r.errors.length ? r.errors : ['这些修改现在都无法执行'], assetsToAdd: undefined };
  const late = ((r.result && r.result.diagnostics) || []).map((g) => ({ label: '', message: g.message, code: g.code }));
  return {
    status: 'applied',
    applied: (r.result && r.result.applied) || [],
    errors: [],
    assetsToAdd: undefined,
    skippedAtApply: late.length ? late.slice(0, 12) : undefined,
  };
}

// ---------------- 上下文 ----------------
function useScope(isEn) {
  const project = useStore((s) => s.project);
  const clipIds = useStore((s) => s.selection.clipIds);
  const focus = useStore((s) => s.focus);
  const range = useStore((s) => s.range);
  return useMemo(() => {
    if (!project) return { kind: 'none', label: isEn ? 'No project open' : '没有打开的项目' };
    const video = project.tracks.video;
    if (clipIds.length) {
      const idx = clipIds.map((id) => video.findIndex((c) => c.id === id)).filter((i) => i >= 0).map((i) => i + 1);
      if (idx.length) return { kind: 'selection', label: isEn ? `Selected: ${describeClipIndices(idx, true)}` : '选中' + describeClipIndices(idx, false) };
    }
    const span = focus || range;
    if (span) {
      let items = [];
      try { items = itemsInRange(layoutVideo(project), span.start, span.end) || []; } catch { items = []; }
      const idx = items.map((it) => it.index + 1);
      if (isEn) {
        return { kind: focus ? 'focus' : 'range', label: `${focus ? 'Focus' : 'Range'} ${fmtRange(span)}${idx.length ? ` (${describeClipIndices(idx, true)})` : ''}` };
      }
      return { kind: focus ? 'focus' : 'range', label: `${focus ? '聚焦' : '范围'} ${fmtRange(span)}${idx.length ? `（${describeClipIndices(idx, false)}）` : ''}` };
    }
    if (isEn) {
      return { kind: 'all', label: video.length ? `Full timeline (${video.length} ${video.length === 1 ? 'clip' : 'clips'})` : 'Full timeline (empty)' };
    }
    return { kind: 'all', label: video.length ? `全片（${video.length} 个片段）` : '全片（时间线为空）' };
  }, [project, clipIds, focus, range, isEn]);
}

function providerDisplayLabel(provider, isEn, preset = '') {
  const p = String(provider || '').trim().toLowerCase();
  const pr = String(preset || '').trim().toLowerCase();
  if ((p === 'openai' || p === 'api') && pr && PRESET_LABEL[pr]) {
    return isEn ? PRESET_LABEL[pr].en : PRESET_LABEL[pr].zh;
  }
  switch (p) {
    case 'claude': return 'Claude Code';
    case 'codex': return 'Codex CLI';
    case 'gemini': return 'Gemini CLI';
    case 'anthropic': return 'Anthropic Claude';
    case 'openai':
    case 'api':
      return isEn ? 'OpenAI-Compatible API' : 'OpenAI 兼容 API';
    case 'ollama': return isEn ? 'Ollama (Local)' : 'Ollama 本地';
    case 'lmstudio': return 'LM Studio';
    case 'local':
    case 'none':
      return isEn ? 'Local Rules' : '本地规则';
    default:
      return provider ? String(provider) : 'AI';
  }
}

export function aiChip(aiStatus, locale = 'zh-CN') {
  const isEn = locale === 'en-US';
  const L = (zh, en) => (isEn ? en : zh);
  if (!aiStatus) return { kind: '', text: L('AI 检测中…', 'Checking AI…'), title: '' };
  const p = String(aiStatus.provider || '').trim().toLowerCase();
  if (aiStatus.ready && p && p !== 'local' && p !== 'none') {
    const preset = String(aiStatus.preset || (aiStatus.api && aiStatus.api.preset) || '').trim().toLowerCase();
    const label = providerDisplayLabel(p, isEn, preset);
    let text;
    if ((p === 'openai' || p === 'api') && preset && PRESET_CHIP[preset]) {
      text = isEn ? PRESET_CHIP[preset].en : PRESET_CHIP[preset].zh;
    } else if (p === 'openai' || p === 'api') {
      text = L('API 已就绪', 'API Ready');
    } else if (PROVIDER_CHIP[p]) {
      text = PROVIDER_CHIP[p];
    } else {
      text = L('AI 已就绪', 'AI Ready');
    }
    const title = [label, aiStatus.model, aiStatus.detail].filter(Boolean).join(' · ');
    return { kind: 'ai', text, title };
  }
  return {
    kind: 'warn',
    text: L('本地规则', 'Local Rules'),
    title: isEn
      ? `${aiStatus.detail || 'AI not connected'}: simple commands still work via local rules; connect a cloud/local API or local Agent CLI in Settings`
      : `${aiStatus.detail || '未连接 AI'}：简单指令仍可本地理解；可在设置中连接在线/本地 API 或本机 Agent CLI`,
  };
}

// ---------------- 组件 ----------------
export default function AIEditPanel() {
  const locale = useLocale();
  const isEn = locale === 'en-US';
  const L = (zh, en) => (isEn ? en : zh);
  const project = useStore((s) => s.project);
  const aiStatus = useStore((s) => s.aiStatus);
  const past = useStore((s) => s.past);
  const messages = (project && project.chats && project.chats.editor) || [];
  const scope = useScope(isEn);
  const chip = aiChip(aiStatus, locale);

  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(null); // { step, phase, startedAt, slow }
  const [confirmClear, setConfirmClear] = useState(false);
  // 关闭（默认）：小改动直接生效、大改动先确认；打开：AI 的每次修改都先确认
  const [confirmAll, setConfirmAll] = useState(() => readPref('ai.confirmAll', false) === true);
  const runRef = useRef(0);
  const jobRef = useRef(null);
  const abortRef = useRef(null);
  const listRef = useRef(null);
  const inputRef = useRef(null);

  const projectId = project ? project.id : null;
  useEffect(() => {
    if (undoAnchorsProjectId !== projectId) {
      undoAnchors.clear();
      undoAnchorsProjectId = projectId;
    }
    setConfirmClear(false);
  }, [projectId]);

  useEffect(() => () => {
    runRef.current += 1;
    if (abortRef.current) {
      try { abortRef.current.abort(); } catch { /* 已结束 */ }
      abortRef.current = null;
    } else if (jobRef.current) {
      api.cancel(jobRef.current).catch(() => {});
      jobRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!confirmClear) return undefined;
    if (!messages.length || busy) { setConfirmClear(false); return undefined; }
    const timer = setTimeout(() => setConfirmClear(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmClear, messages.length, busy]);

  useEffect(() => writePref('ai.confirmAll', confirmAll), [confirmAll]);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, busy && busy.step]);

  const topEntry = past.length ? past[past.length - 1] : null;

  async function askAI(text, local, ctx, projectId) {
    const runId = ++runRef.current;
    const stale = () => runId !== runRef.current;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    abortRef.current = ctrl;
    setBusy({ step: '整理上下文', phase: '', startedAt: Date.now(), slow: false });
    let provider = 'ai';
    try {
      const [techniques, library] = await Promise.all([
        allTechniques().then((all) => { try { return (searchTechniques(all, text, { limit: 12 }) || []).slice(0, 12); } catch { return []; } }).catch(() => []),
        queryLibraryAssets('').catch(() => []),
      ]);
      if (stale()) return;
      const st = useStore.getState();
      if (!st.project || st.project.id !== projectId) return;
      // 素材库候选：按这次指令检索前 30 条 + 最新 10 条（P0-5 R1），已在项目里的不重复列
      const libraryAssets = pickLibraryCandidates(library, text, { exclude: st.project.assets });
      const call = async (request) => {
        if (stale()) throw Object.assign(new Error('已取消'), { cancelled: true, code: 'CANCELLED' });
        const res = await runAI(request, {
          signal: ctrl ? ctrl.signal : undefined,
          onStart: (jobId) => { jobRef.current = jobId; },
          onProgress: (p) => {
            if (stale() || !p) return;
            setBusy((b) => (b ? { ...b, phase: typeof p.phase === 'string' ? p.phase : b.phase, slow: p.slow === true } : b));
          },
        });
        if (res && res.provider) provider = res.provider;
        return res && res.data;
      };
      const result = await runEditPipeline({
        project: st.project, command: text, selection: ctx.selectedClipIds, range: ctx.range, focus: st.focus, playhead: ctx.playhead,
        techniques, libraryAssets, call, confirmAll,
        onPhase: (step) => { if (!stale()) setBusy((b) => (b ? { ...b, step, phase: '', slow: false } : b)); },
      });
      if (stale()) return;
      const cur = useStore.getState().project;
      if (!cur || cur.id !== projectId) return;
      const parsed = result.parsed;
      // 规矩马上记住（用户自己说的规矩在 send 里已经记下）；普通记录等修改真正生效后再记
      if (parsed.memoryNote && parsed.memoryKind === 'rule' && !ruleFromCommand(text)) remember([{ text: parsed.memoryNote, kind: 'rule', source: 'ai' }]);
      const note = parsed.memoryNote && parsed.memoryKind !== 'rule' ? parsed.memoryNote : '';

      const ops = result.lint.ops;
      const nothingPassed = parsed.ops.length > 0 && !ops.length;
      const id = uid('msg');
      const base = {
        id, role: 'assistant', at: new Date().toISOString(), provider, command: text,
        text: parsed.reply + (nothingPassed ? '\n这些修改都没能执行，原因见下面。' : ''),
        plan: parsed.plan,
        ops,
        reasons: result.passIndex.map((i) => result.reasons[i] || ''),
        assetsToAdd: result.assetsToAdd,
        summary: ops.length ? result.summary : [],
        confirmReasons: result.confirm.need ? result.confirm.reasons : [],
        skipped: result.skipped.map((s) => ({ label: s.label || '', message: s.message, code: s.code })).slice(0, 12),
        unsupported: parsed.unsupported,
        materialRequests: parsed.materialRequests,
        repair: result.repair.tried ? { fixed: result.repair.fixed, dropped: result.repair.dropped, notes: result.repair.notes.slice(0, 2), failed: !!result.repair.error } : null,
        memoryNote: note,
        ctx: result.ctx,
      };
      if (!ops.length) { pushMsg({ ...base, assetsToAdd: undefined, memoryNote: '' }); return; }
      if (result.confirm.need) { pushMsg({ ...base, status: 'proposed' }); return; }
      const r = commitPlan({ ops, assetsToAdd: result.assetsToAdd }, 'AI：' + shortLabel(text), id, result.ctx);
      pushMsg({ ...base, ...appliedPatch(r), memoryNote: '' });
      if (r.ok && note) {
        const memUndo = remember([{ text: note, kind: 'note', source: 'ai' }]);
        const anchor = undoAnchors.get(id);
        if (anchor && memUndo) anchor.memUndo = memUndo;
      }
    } catch (e) {
      if (stale()) return;
      if (isCancelled(e)) { pushMsg({ id: uid('msg'), role: 'assistant', at: new Date().toISOString(), text: '已取消本次 AI 请求，时间线没有改动。' }); return; }
      if (isNoAI(e)) {
        const unknown = local.unknown.length ? local.unknown : [text];
        const hasLocal = local.ops.length > 0;
        pushMsg({
          id: uid('msg'), role: 'assistant', at: new Date().toISOString(), provider: 'local', command: text,
          text: `未连接 AI，以下部分本地无法理解：「${unknown.join('」「')}」。${hasLocal ? '能理解的部分如下，确认后可以先应用。' : '可以换成下面这种写法，或在设置里连接在线/本地 API 或本机 Agent CLI。'}`,
          ops: hasLocal ? local.ops : [], status: hasLocal ? 'proposed' : undefined, ctx, examples: true,
        });
        return;
      }
      const why = String((e && e.message) || '未知原因').replace(/[。.\s]+$/, '');
      pushMsg({ id: uid('msg'), role: 'assistant', at: new Date().toISOString(), status: 'error', retry: true, command: text, text: `这次没能完成：${why}。时间线没有改动，可以点「重试」，或换个说法。` });
    } finally {
      if (!stale()) { setBusy(null); jobRef.current = null; abortRef.current = null; }
    }
  }

  function send(raw) {
    const text = String(raw || '').trim();
    if (!text || busy) return;
    const st = useStore.getState();
    if (!st.project) return;
    setInput('');
    const projectId = st.project.id;
    pushMsg({ id: uid('msg'), role: 'user', text, at: new Date().toISOString() });
    // 「以后都不要用转场」这类长期规矩：不管本地还是 AI 处理，都记进项目记忆，之后每次请求都会带上
    const rule = ruleFromCommand(text);
    if (rule) remember([{ text: rule, kind: 'rule', source: 'user' }]);
    const span = st.focus || st.range || null;
    const ctx = { selectedClipIds: [...st.selection.clipIds], range: span, playhead: st.playhead };
    let local = { ops: [], understood: [], unknown: [text] };
    try {
      local = normalizeLocal(parseCommand(text, { project: useStore.getState().project, selectedClipIds: ctx.selectedClipIds, range: span, playhead: st.playhead }), text);
    } catch { local = { ops: [], understood: [], unknown: [text] }; }

    if (local.ops.length && !local.unknown.length) {
      const id = uid('msg');
      const r = commitWithAnchor(local.ops, '指令：' + shortLabel(text), id, ctx);
      pushMsg({
        id, role: 'assistant', at: new Date().toISOString(), provider: 'local', local: true, command: text, ctx,
        ops: local.ops, applied: r.applied, errors: r.errors, status: r.ok ? 'applied' : 'error',
        text: r.ok ? `本地理解，立即生效。${local.understood.length ? '理解为：' + local.understood.join('；') : ''}` : `没有修改时间线：${(r.errors || []).join('；') || '操作无效'}`,
      });
      return;
    }
    askAI(text, local, ctx, projectId);
  }

  function cancelAI() {
    runRef.current += 1;
    // runAI 收到 abort 会通知主进程取消任务；任务还没建好时由它在 onStart 里补取消
    if (abortRef.current) { try { abortRef.current.abort(); } catch { /* 已结束 */ } }
    else if (jobRef.current) api.cancel(jobRef.current).catch(() => {});
    abortRef.current = null;
    jobRef.current = null;
    setBusy(null);
    pushMsg({ id: uid('msg'), role: 'assistant', at: new Date().toISOString(), text: '已取消本次 AI 请求，时间线没有改动。' });
  }

  function applyProposed(msg) {
    const st = useStore.getState();
    const ctx = msg.ctx || {};
    const r = commitPlan({ ops: msg.ops || [], assetsToAdd: msg.assetsToAdd || [] }, 'AI：' + shortLabel(msg.command || msg.text), msg.id, {
      selectedClipIds: Array.isArray(ctx.selectedClipIds) ? ctx.selectedClipIds : st.selection.clipIds,
      range: ctx.range === undefined ? st.range : ctx.range,
      playhead: Number.isFinite(ctx.playhead) ? ctx.playhead : st.playhead,
    });
    patchMsg(msg.id, { ...appliedPatch(r), memoryNote: '' });
    if (!r.ok) { st.toast(`没有应用：${r.errors[0] || '这些修改现在都无法执行'}`, 'error'); return; }
    if (msg.memoryNote) {
      const memUndo = remember([{ text: msg.memoryNote, kind: 'note', source: 'ai' }]);
      const anchor = undoAnchors.get(msg.id);
      if (anchor && memUndo) anchor.memUndo = memUndo;
    }
    const done = r.result.passIndex.length;
    const late = r.result.diagnostics.length;
    st.toast(late ? `已应用 ${done} 项修改，另有 ${late} 项现在没法执行` : `已应用 ${done} 项修改`, late ? 'warn' : 'success');
  }

  function rejectProposed(msg) { patchMsg(msg.id, { status: 'rejected', assetsToAdd: undefined, memoryNote: '' }); }

  function retry(msg) { if (msg && msg.command) send(msg.command); }

  function undoMsg(msg) {
    const st = useStore.getState();
    const anchor = undoAnchors.get(msg.id);
    const top = st.past.length ? st.past[st.past.length - 1] : null;
    if (!anchor || anchor.entry !== top) {
      st.toast('这一步之后还有其它修改，请用顶栏的撤销（Ctrl+Z）按顺序撤销', 'warn');
      return;
    }
    const curMem = st.project.memory || { styleGuide: '', decisions: [], colorBaseline: null };
    let nextMemory = curMem;
    if (anchor.memUndo) {
      const { addedIds, prevDecisions, compacted } = anchor.memUndo;
      if (compacted) {
        nextMemory = { ...curMem, decisions: prevDecisions };
      } else if (addedIds && addedIds.length) {
        const drop = new Set(addedIds);
        nextMemory = { ...curMem, decisions: (curMem.decisions || []).filter((d) => !d || !drop.has(d.id)) };
      }
    }
    const keepChats = st.project.chats;
    if (!st.undo()) return;
    undoAnchors.delete(msg.id);
    useStore.getState().update((p) => ({
      ...p,
      memory: nextMemory,
      chats: { ...keepChats, editor: ((keepChats && keepChats.editor) || []).map((m) => (m.id === msg.id ? { ...m, undone: true } : m)) },
    }));
  }

  function doClearChat() {
    setConfirmClear(false);
    if (!messages.length) return;
    useStore.getState().update((p) => ({ ...p, chats: { ...(p.chats || {}), editor: [] } }));
    useStore.getState().toast(getLocale() === 'en-US' ? 'AI Refine chat history cleared (timeline and undo history unchanged)' : '已清空 AI 精修对话记录（不影响时间线和撤销历史）');
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent && e.nativeEvent.isComposing)) { e.preventDefault(); send(input); }
  };

  if (!project) return <div className="aie-root"><div className="empty"><p>{L('打开项目后可以用白话精修视频。', 'Open a project to refine your video in plain language.')}</p></div></div>;

  const scopeIcon = scope.kind === 'selection' ? 'layers' : scope.kind === 'focus' ? 'focus' : scope.kind === 'range' ? 'clock' : 'film';
  const quickList = isEn ? QUICK_EN : QUICK;

  return (
    <div className="aie-root">
      <style>{STYLE}</style>
      <div className="aie-context">
        <div className="aie-scope" title={L('AI 修改的作用对象。选中片段或在时间线上框选「聚焦此段」可以缩小范围；AI 仍会参考全片风格。', 'Target scope for AI edits. Select clips or focus a timeline range to narrow edits while keeping full-project style consistency.')}>
          <Icon name={scopeIcon} size={13} />
          <span className="ellipsis">{scope.label}</span>
        </div>
        <Chip kind={chip.kind} dot title={chip.title}>{chip.text}</Chip>
        {confirmClear ? (
          <span className="aie-actions">
            <Button size="sm" variant="danger" onClick={doClearChat} title={L('仅清空对话记录，不影响时间线和撤销历史', 'Clears chat history only; timeline and undo history stay intact')}>{L('确认清空', 'Confirm Clear')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmClear(false)}>{L('取消', 'Cancel')}</Button>
          </span>
        ) : (
          <Button size="sm" variant="ghost" icon="trash" title={L('清空对话（不影响时间线和撤销历史）', 'Clear chat (does not affect timeline or undo history)')} onClick={() => setConfirmClear(true)} disabled={!messages.length || !!busy} />
        )}
      </div>

      <div className="aie-list" ref={listRef}>
        {!messages.length && (
          <div className="aie-welcome">
            <div className="aie-welcome-title"><Icon name="sparkles" size={16} />{L('用白话告诉我想怎么改', 'Describe how you want to edit')}</div>
            <p>{L(
              '简单的调整（调色、转场、速度、字幕、特效）本地立即生效；复杂的要求交给 AI，它记得全片的风格和你定下的规矩（比如「以后都不要用转场」）。大改动会先让你确认，每次修改都能撤销；缺素材时会自动去素材库和网上找。',
              'Simple edits (color, transitions, speed, titles, effects) apply immediately via local rules; complex requests go to AI while keeping your project style and preferences. Major changes ask for confirmation first, and every edit can be undone.',
            )}</p>
          </div>
        )}
        {messages.map((m) => (
          <MessageItem
            key={m.id}
            msg={m}
            project={project}
            canUndo={!!(undoAnchors.get(m.id) && undoAnchors.get(m.id).entry === topEntry)}
            busy={!!busy}
            isEn={isEn}
            onApply={() => applyProposed(m)}
            onReject={() => rejectProposed(m)}
            onUndo={() => undoMsg(m)}
            onRetry={() => retry(m)}
            onExample={(ex) => { setInput(ex); inputRef.current && inputRef.current.focus(); }}
          />
        ))}
        {busy && <BusyRow busy={busy} isEn={isEn} onCancel={cancelAI} />}
      </div>

      <div className="aie-compose">
        <div className="aie-quick">
          {quickList.map((q) => (
            <button key={q} type="button" className="aie-chip" disabled={!!busy} onClick={() => send(q)}>{q}</button>
          ))}
        </div>
        <div className="aie-input-wrap">
          <textarea
            ref={inputRef}
            className="aie-input"
            rows={2}
            value={input}
            placeholder={scope.kind === 'all'
              ? L('例如：开头更抓人一点，整体色调统一成暖色胶片', 'e.g. Make the opening punchier and give the whole edit a warm film look')
              : L(`对${scope.label}说点什么，例如：暖一点、慢放、加标题`, `Describe an edit for ${scope.label}, e.g. warmer tone, slow motion, add title`)}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={!!busy}
            aria-label={L('告诉 AI 想怎么改', 'Tell AI how to edit')}
          />
          <Button variant="ai" icon="send" title={L('发送（Enter）', 'Send (Enter)')} onClick={() => send(input)} disabled={!input.trim() || !!busy} />
        </div>
        <div className="aie-preview-toggle">
          <span>{L('AI 修改', 'AI Edits')}</span>
          <Segmented
            size="sm"
            label={L('AI 的修改什么时候先确认', 'When to confirm AI edits')}
            value={confirmAll ? 'all' : 'big'}
            onChange={(v) => setConfirmAll(v === 'all')}
            options={[
              { value: 'big', label: L('大改动才确认', 'Confirm Major'), title: L('小改动直接生效（随时可以撤销）；删除多个片段、改全片调色或转场、改画幅、总时长变化较大时，先让你确认', 'Small edits apply immediately (undoable anytime); major changes ask for confirmation first') },
              { value: 'all', label: L('每次都确认', 'Always Confirm'), title: L('AI 的每次修改都先列出来，确认后才应用；本地能理解的简单指令总是立即生效', 'Preview and confirm every AI edit before applying; simple local commands still apply immediately') },
            ]}
          />
          <span className="grow" />
          <span className="xs muted">{L('Enter 发送 · Shift+Enter 换行', 'Enter to send · Shift+Enter for newline')}</span>
        </div>
      </div>
    </div>
  );
}

/** 等待 AI 时的进度行：阶段 + 已用时；超过 90 秒提示可以取消。自己每秒刷新，不带着整个面板重绘 */
function BusyRow({ busy, isEn, onCancel }) {
  const L = (zh, en) => (isEn ? en : zh);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = Math.max(0, now - (busy.startedAt || now));
  const slow = busy.slow || elapsed >= SLOW_AFTER_MS;
  const step = (isEn ? STEP_TEXT_EN[busy.step] : STEP_TEXT[busy.step]) || busy.step || L('AI 正在处理', 'AI is working');
  return (
    <div className="aie-msg assistant pending">
      <div className="aie-msg-head">
        <Spinner ai />
        <span className="grow ellipsis" role="status" aria-live="polite">{step}{busy.phase ? ` · ${busy.phase}` : '…'}</span>
        <span className="aie-elapsed" title={L('已用时间', 'Elapsed time')}>{fmtElapsed(elapsed, isEn)}</span>
        <Button size="sm" variant="ghost" onClick={onCancel}>{L('取消', 'Cancel')}</Button>
      </div>
      <ProgressBar ai indeterminate />
      {slow && (
        <div className="aie-slow" role="note">
          <Icon name="clock" size={12} />
          <span>{L('AI 响应比平时慢，可以继续等待，也可以取消后换个简单点的说法。', 'AI is taking longer than usual — you can keep waiting, or cancel and try a simpler request.')}</span>
        </div>
      )}
    </div>
  );
}

function StatusChip({ msg, isEn }) {
  const L = (zh, en) => (isEn ? en : zh);
  if (msg.undone) return <Chip>{L('已撤销', 'Undone')}</Chip>;
  if (msg.status === 'applied') return <Chip kind="ok">{L('已应用', 'Applied')}</Chip>;
  if (msg.status === 'proposed') return <Chip kind="warn">{L('待确认', 'Pending')}</Chip>;
  if (msg.status === 'rejected') return <Chip>{L('已放弃', 'Dismissed')}</Chip>;
  if (msg.status === 'error') return <Chip kind="danger">{L('失败', 'Failed')}</Chip>;
  return null;
}

function strings(v) {
  return Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()) : [];
}

function MessageItem({ msg, project, canUndo, busy, isEn, onApply, onReject, onUndo, onRetry, onExample }) {
  const L = (zh, en) => (isEn ? en : zh);
  if (msg.role === 'user') {
    return <div className="aie-msg user"><div className="aie-msg-text selectable">{msg.text}</div></div>;
  }
  const ops = Array.isArray(msg.ops) ? msg.ops : [];
  const reasons = Array.isArray(msg.reasons) ? msg.reasons : [];
  const errors = Array.isArray(msg.errors) ? msg.errors.filter(Boolean) : [];
  const provider = msg.local ? L('本地理解', 'Local Rules') : providerDisplayLabel(msg.provider, isEn, msg.preset);
  const proposed = msg.status === 'proposed';
  const dim = msg.status === 'rejected' || msg.undone;
  const plan = msg.plan && typeof msg.plan === 'object' ? msg.plan : null;
  const planSteps = strings(plan && plan.steps);
  const assumptions = strings(plan && plan.assumptions);
  const summary = strings(msg.summary);
  const confirmReasons = proposed ? strings(msg.confirmReasons) : [];
  const skipped = [...(Array.isArray(msg.skipped) ? msg.skipped : []), ...(Array.isArray(msg.skippedAtApply) ? msg.skippedAtApply : [])]
    .filter((s) => s && s.message);
  const unsupported = (Array.isArray(msg.unsupported) ? msg.unsupported : []).filter((u) => u && u.request);
  const repair = msg.repair && typeof msg.repair === 'object' ? msg.repair : null;
  const examplesList = isEn ? EXAMPLES_EN : EXAMPLES;
  return (
    <div className={'aie-msg assistant' + (msg.status === 'error' ? ' error' : '')}>
      <div className="aie-msg-head">
        <Icon name={msg.local || msg.provider === 'local' ? 'bolt' : 'sparkles'} size={12} />
        <span className="aie-provider">{provider}</span>
        <span className="grow" />
        <StatusChip msg={msg} isEn={isEn} />
      </div>
      {msg.text && <div className="aie-msg-text selectable">{msg.text}</div>}
      {confirmReasons.length > 0 && (
        <div className="aie-confirm" role="note">
          <Icon name="alertTriangle" size={13} />
          <div><b>{L('改动较大，确认后才会应用：', 'Major edit — confirm before applying: ')}</b>{confirmReasons.join(L('；', '; '))}</div>
        </div>
      )}
      {summary.length > 0 && !dim && (proposed || msg.status === 'applied') && (
        <div className="aie-diff">
          <div className="aie-ops-title">{proposed ? L('应用后的变化', 'Changes on Apply') : L('改动概览', 'Summary')}</div>
          <ul>{summary.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </div>
      )}
      {ops.length > 0 && (
        <div className={'aie-ops' + (dim ? ' dim' : '')}>
          <div className="aie-ops-title">{proposed ? L('将执行的操作', 'Planned Operations') : L('执行的操作', 'Applied Operations')}{isEn ? ` (${ops.length})` : `（${ops.length}）`}</div>
          <ol>
            {ops.map((op, i) => (
              <li key={i}>
                {safeDescribe(op, project)}
                {typeof reasons[i] === 'string' && reasons[i] && <span className="aie-reason">{reasons[i]}</span>}
              </li>
            ))}
          </ol>
        </div>
      )}
      {skipped.length > 0 && !dim && (
        <div className="aie-skip">
          <div className="aie-ops-title">{L(`没有执行的部分（${skipped.length}）`, `Skipped (${skipped.length})`)}</div>
          <ul>{skipped.map((s, i) => <li key={i}>{s.label ? `${s.label}${L('：', ': ')}` : ''}{s.message}</li>)}</ul>
        </div>
      )}
      {unsupported.length > 0 && (
        <div className="aie-unsup">
          <div className="aie-ops-title">{L('暂时做不到', 'Not Supported Yet')}</div>
          {unsupported.map((u, i) => (
            <div key={i} className="aie-unsup-item">
              <div><b>{u.request}</b>{u.why ? `${L('：', ': ')}${u.why}` : ''}</div>
              {u.alternative && (
                <button type="button" className="aie-example" title={L('填到输入框里，可以改一改再发送', 'Fill into input so you can tweak and send')} onClick={() => onExample(u.alternative)}>
                  {L('换个做法：', 'Try instead: ')}{u.alternative}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {(planSteps.length > 0 || assumptions.length > 0) && (
        <details className="aie-plan">
          <summary>{L('AI 的思路', 'AI Plan')}{plan && plan.goal ? `${L('：', ': ')}${plan.goal}` : ''}</summary>
          {planSteps.length > 0 && <ol>{planSteps.map((s, i) => <li key={i}>{s}</li>)}</ol>}
          {assumptions.length > 0 && <div className="aie-plan-assume">{L('我的理解：', 'Assumptions: ')}{assumptions.join(L('；', '; '))}</div>}
        </details>
      )}
      {repair && (repair.fixed > 0 || repair.dropped > 0) && (
        <div className="aie-note">
          <Icon name="refresh" size={12} />
          <span>
            {repair.fixed > 0 ? L(`有 ${repair.fixed} 步一开始没法执行，已自动修正。`, `Auto-fixed ${repair.fixed} step(s) that could not run as drafted. `) : ''}
            {repair.dropped > 0
              ? L(
                  `${repair.dropped} 步修不好，已放弃${strings(repair.notes).length ? `：${strings(repair.notes).join('；')}` : '。'}`,
                  `Dropped ${repair.dropped} unfixable step(s)${strings(repair.notes).length ? `: ${strings(repair.notes).join('; ')}` : '.'}`,
                )
              : ''}
          </span>
        </div>
      )}
      {errors.length > 0 && msg.status === 'error' && <div className="aie-err xs">{errors.join(L('；', '; '))}</div>}
      {proposed && (
        <div className="aie-actions">
          <Button size="sm" variant="primary" icon="check" onClick={onApply} disabled={busy}>{L('应用', 'Apply')}</Button>
          <Button size="sm" variant="ghost" onClick={onReject}>{L('放弃', 'Dismiss')}</Button>
        </div>
      )}
      {msg.status === 'applied' && !msg.undone && (
        <div className="aie-actions">
          <Button
            size="sm"
            variant="ghost"
            icon="undo"
            className={canUndo ? '' : 'aie-undo-stale'}
            title={canUndo ? L('撤销这次修改', 'Undo this edit') : L('之后还有其它修改，请用撤销历史（Ctrl+Z）', 'Later edits exist — use global Undo (Ctrl+Z)')}
            onClick={onUndo}
          >{L('撤销', 'Undo')}</Button>
        </div>
      )}
      {msg.status === 'error' && msg.retry && msg.command && (
        <div className="aie-actions">
          <Button size="sm" variant="ghost" icon="refresh" onClick={onRetry} disabled={busy}>{L('重试', 'Retry')}</Button>
        </div>
      )}
      {msg.examples && (
        <div className="aie-examples">
          {examplesList.map((ex) => <button key={ex} type="button" className="aie-example" onClick={() => onExample(ex)}>{ex}</button>)}
        </div>
      )}
      {Array.isArray(msg.materialRequests) && msg.materialRequests.map((req, i) => (
        <SideMaterialCard key={i} msgId={msg.id} index={i} request={req} />
      ))}
    </div>
  );
}
