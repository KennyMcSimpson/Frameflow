// 快捷键注册表（纯数据 + 纯函数，node 可测；不依赖 React / store）。
// 统一使用 KeyboardEvent.code（物理键位），中文输入法下字母键依然可用；isComposing（正在拼字）时一律不触发。
// combo 写法：'Ctrl+Shift+KeyZ'，修饰键顺序固定 Ctrl→Alt→Shift。Ctrl 同时匹配 macOS 的 Cmd。
// scope：'refine' 由精修模式的 useShortcuts 分发；'global' 由外壳 App.jsx 分发（任何页面都生效）。
//   例外：help（?）在精修模式打开时间线的快捷键面板，其它页面由 App.jsx 打开「帮助 → 快捷键」。
// 条目字段：repeat 按住连发；allowInInput 光标在输入框里也生效（只对 Ctrl 组合键和 F 键生效，见 firesInInput）；
//   fixed 不允许自定义。帮助页、快捷键面板、工具条提示全部由这张表生成，不要在别处手写按键说明。
// 自定义按键：settings.shortcuts.overrides = { [id]: string[] }，[] 表示这个功能不设按键。
//   本模块保存「当前生效的自定义」并负责合并、校验与冲突处理；读写设置在 shortcuts/customKeys.js。

export const SHORTCUT_GROUPS = ['播放', '剪辑', '选择与剪贴板', '时间线视图', '通用'];

/** 每个功能最多几个按键 */
export const MAX_KEYS_PER_ACTION = 3;

export const SHORTCUTS = [
  { id: 'playPause', label: '播放 / 暂停', group: '播放', keys: ['Space'] },
  { id: 'shuttleBack', label: '倒放，连按加速（1×→2×→4×）', group: '播放', keys: ['KeyJ'] },
  { id: 'shuttleStop', label: '停下（结束倒放或加速播放）', group: '播放', keys: ['KeyK'] },
  { id: 'shuttleFwd', label: '播放，连按加速（1×→2×→4×）', group: '播放', keys: ['KeyL'] },
  { id: 'frameBack', label: '后退一帧', group: '播放', keys: ['ArrowLeft'], repeat: true },
  { id: 'frameFwd', label: '前进一帧', group: '播放', keys: ['ArrowRight'], repeat: true },
  { id: 'secBack', label: '后退 1 秒', group: '播放', keys: ['Shift+ArrowLeft'], repeat: true },
  { id: 'secFwd', label: '前进 1 秒', group: '播放', keys: ['Shift+ArrowRight'], repeat: true },
  { id: 'prevEdit', label: '跳到上一个片段交界', group: '播放', keys: ['ArrowUp'], repeat: true },
  { id: 'nextEdit', label: '跳到下一个片段交界', group: '播放', keys: ['ArrowDown'], repeat: true },
  { id: 'goStart', label: '跳到开头', group: '播放', keys: ['Home'] },
  { id: 'goEnd', label: '跳到结尾', group: '播放', keys: ['End'] },

  { id: 'undo', label: '撤销', group: '剪辑', keys: ['Ctrl+KeyZ'], scope: 'global', repeat: true },
  { id: 'redo', label: '重做', group: '剪辑', keys: ['Ctrl+Shift+KeyZ', 'Ctrl+KeyY'], scope: 'global', repeat: true },
  { id: 'split', label: '在播放头分割', group: '剪辑', keys: ['Ctrl+KeyB', 'KeyS'] },
  { id: 'rippleDelete', label: '删除所选（后面的片段自动补上空位）', group: '剪辑', keys: ['Delete', 'Backspace'] },
  { id: 'trimLeft', label: '向左裁剪（删掉播放头左边的部分）', group: '剪辑', keys: ['KeyQ'] },
  { id: 'trimRight', label: '向右裁剪（删掉播放头右边的部分）', group: '剪辑', keys: ['KeyW'] },
  { id: 'markIn', label: '设为框选起点', group: '剪辑', keys: ['KeyI'] },
  { id: 'markOut', label: '设为框选终点', group: '剪辑', keys: ['KeyO'] },
  { id: 'addMarker', label: '在播放头添加标记', group: '剪辑', keys: ['KeyM'] },
  { id: 'addText', label: '在播放头添加文字', group: '剪辑', keys: ['KeyT'] },

  { id: 'selectAll', label: '全选片段', group: '选择与剪贴板', keys: ['Ctrl+KeyA'] },
  { id: 'copy', label: '复制', group: '选择与剪贴板', keys: ['Ctrl+KeyC'] },
  { id: 'paste', label: '粘贴到播放头', group: '选择与剪贴板', keys: ['Ctrl+KeyV'] },
  { id: 'duplicate', label: '创建副本', group: '选择与剪贴板', keys: ['Ctrl+KeyD'] },
  { id: 'escape', label: '取消选择 / 退出聚焦', group: '选择与剪贴板', keys: ['Escape'], fixed: true },

  { id: 'zoomIn', label: '放大时间线', group: '时间线视图', keys: ['Equal', 'Shift+Equal', 'NumpadAdd'], repeat: true },
  { id: 'zoomOut', label: '缩小时间线', group: '时间线视图', keys: ['Minus', 'NumpadSubtract'], repeat: true },
  { id: 'zoomFit', label: '缩放到显示全片', group: '时间线视图', keys: ['Shift+KeyZ', 'Backslash'] },
  { id: 'toggleSnap', label: '开 / 关吸附对齐', group: '时间线视图', keys: ['KeyN'] },

  { id: 'helpCenter', label: '打开帮助', group: '通用', keys: ['F1'], scope: 'global', allowInInput: true },
  { id: 'help', label: '查看全部快捷键', group: '通用', keys: ['Shift+Slash'] },
  { id: 'save', label: '保存', group: '通用', keys: ['Ctrl+KeyS'], scope: 'global', allowInInput: true },
  { id: 'export', label: '导出视频', group: '通用', keys: ['Ctrl+KeyE'], scope: 'global' },
  { id: 'settings', label: '打开设置', group: '通用', keys: ['Ctrl+Comma'], scope: 'global' },
  { id: 'modeCreate', label: '切换到创作', group: '通用', keys: ['Ctrl+Digit1'], scope: 'global' },
  { id: 'modeRefine', label: '切换到精修', group: '通用', keys: ['Ctrl+Digit2'], scope: 'global' },
  { id: 'modeLibrary', label: '切换到拆片库', group: '通用', keys: ['Ctrl+Digit3'], scope: 'global' },
];

const MOD_ORDER = ['Ctrl', 'Alt', 'Shift'];
const MODIFIER_CODE = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;

/** 'Shift+Ctrl+KeyZ' → { ctrl, alt, shift, code } */
export function parseCombo(combo) {
  const parts = String(combo || '').split('+').map((s) => s.trim()).filter(Boolean);
  const out = { ctrl: false, alt: false, shift: false, code: '' };
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === 'ctrl' || l === 'cmd' || l === 'meta' || l === 'mod') out.ctrl = true;
    else if (l === 'alt' || l === 'option') out.alt = true;
    else if (l === 'shift') out.shift = true;
    else out.code = p;
  }
  return out;
}

/** 规范化 combo 字符串（修饰键排序） */
export function normalizeCombo(combo) {
  const c = parseCombo(combo);
  const mods = MOD_ORDER.filter((m) => c[m.toLowerCase()]);
  return [...mods, c.code].join('+');
}

/** 键盘事件 → 规范 combo；只按修饰键时返回 ''。输入法拼字时 key 是 'Process'，但 code 仍是物理键位 */
export function comboFromEvent(e) {
  const code = e && e.code;
  if (!code || MODIFIER_CODE.test(code)) return '';
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return [...mods, code].join('+');
}

/** 正按着的修饰键（录制新按键时显示「Ctrl + …」） */
export function heldModifiers(e) {
  if (!e) return [];
  return [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
}

/** 冲突检测：同一 combo 被多个快捷键使用 → [{ combo, ids }]。不分 scope：全局快捷键在精修模式里同样生效 */
export function findConflicts(list = effective) {
  const map = new Map();
  for (const s of list) {
    for (const k of s.keys || []) {
      const c = normalizeCombo(k);
      if (!map.has(c)) map.set(c, []);
      if (!map.get(c).includes(s.id)) map.get(c).push(s.id);
    }
  }
  return Array.from(map.entries()).filter(([, ids]) => ids.length > 1).map(([combo, ids]) => ({ combo, ids }));
}

/** 构建 combo → 快捷键 的查找表（只含指定 scope）。省略 list 时用当前生效的按键（含自定义） */
export function buildKeymap(list = effective, scope = 'refine') {
  const map = new Map();
  for (const s of list) {
    if ((s.scope || 'refine') !== scope) continue;
    for (const k of s.keys || []) { const c = normalizeCombo(k); if (!map.has(c)) map.set(c, s); }
  }
  return map;
}

/** 根据事件找到快捷键定义；正在用输入法拼字（isComposing）时不匹配 */
export function matchShortcut(e, keymap) {
  if (!e || e.isComposing) return null;
  const c = comboFromEvent(e);
  return c ? keymap.get(c) || null : null;
}

// ---------------------------------------------------------------------------
// 输入框里的规则（外壳与精修共用）
// ---------------------------------------------------------------------------
const NON_TEXT_INPUTS = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image']);

/** 焦点是否在可以打字的控件里（输入框、文本域、下拉框、可编辑区域）；滑块、勾选框不算 */
export function isTypingTarget(el) {
  if (!el || typeof el !== 'object') return false;
  if (typeof document !== 'undefined' && el === document.body) return false;
  const tag = String(el.tagName || '').toLowerCase();
  if (tag === 'input') return !NON_TEXT_INPUTS.has(String(el.type || 'text').toLowerCase());
  if (tag === 'textarea' || tag === 'select') return true;
  if (el.isContentEditable) return true;
  return !!(typeof el.closest === 'function' && el.closest('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]'));
}

// 输入框自己要用的组合键（编辑文字、提交）：即使快捷键标了 allowInInput 也让给输入框
const INPUT_NATIVE = new Set([
  'Ctrl+KeyA', 'Ctrl+KeyC', 'Ctrl+KeyV', 'Ctrl+KeyX', 'Ctrl+KeyZ', 'Ctrl+KeyY', 'Ctrl+Shift+KeyZ', 'Ctrl+Shift+KeyV',
  'Ctrl+Backspace', 'Ctrl+Delete', 'Ctrl+ArrowLeft', 'Ctrl+ArrowRight', 'Ctrl+Shift+ArrowLeft', 'Ctrl+Shift+ArrowRight',
  'Ctrl+Home', 'Ctrl+End', 'Ctrl+Shift+Home', 'Ctrl+Shift+End', 'Ctrl+Enter',
]);

/** 光标在输入框里时这个按键是否仍然触发：快捷键标了 allowInInput，按键带 Ctrl/Alt 或是 F 键，且不是文字编辑键 */
export function firesInInput(def, combo) {
  if (!def || !def.allowInInput) return false;
  const c = parseCombo(combo);
  if (!c.code || INPUT_NATIVE.has(normalizeCombo(combo))) return false;
  return c.ctrl || c.alt || /^F\d{1,2}$/.test(c.code);
}

// 留给系统、焦点切换和对话框的按键，不能分配给功能
const RESERVED = new Set(['Tab', 'Shift+Tab', 'Escape', 'Alt+F4', 'Alt+Tab', 'Alt+Space', 'Ctrl+Alt+Delete', 'PrintScreen'].map(normalizeCombo));

export function isReservedCombo(combo) {
  return RESERVED.has(normalizeCombo(combo));
}

/** 是否是一个完整的按键（有具体按键，不能只有 Ctrl / Shift / Alt） */
export function isValidCombo(combo) {
  const c = parseCombo(combo);
  return !!c.code && c.code !== 'Unidentified' && !MODIFIER_CODE.test(c.code) && /^[A-Za-z][A-Za-z0-9]*$/.test(c.code);
}

// ---------------------------------------------------------------------------
// 自定义按键：overrides = { [id]: string[] }，[] 表示不设按键。
// 运行时状态只有这一份；customKeys.js 负责从设置读写并调用 setShortcutOverrides。
// ---------------------------------------------------------------------------
const BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s]));
let overridesState = {};
let effective = SHORTCUTS;
let version = 0;
const keymapCache = new Map();
const listeners = new Set();

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const defaultKeys = (s) => (s.keys || []).map(normalizeCombo);

/**
 * 清洗自定义按键：只保留存在且允许修改的功能；按键规范化、去重，丢掉无效键和保留键；
 * 和默认完全一样的不记录；原来写了按键但全部无效的整条忽略（防止设置文件被改坏后功能没了按键）。
 */
export function sanitizeOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const id of Object.keys(raw)) {
    const s = BY_ID.get(id);
    const keys = raw[id];
    if (!s || s.fixed || !Array.isArray(keys)) continue;
    const list = [];
    for (const k of keys) {
      if (typeof k !== 'string') continue;
      const c = normalizeCombo(k);
      if (!isValidCombo(c) || isReservedCombo(c) || list.includes(c)) continue;
      list.push(c);
      if (list.length >= MAX_KEYS_PER_ACTION) break;
    }
    if (!list.length && keys.length) continue;
    if (sameList(list, defaultKeys(s))) continue;
    out[id] = list;
  }
  return out;
}

/** 把自定义按键合并到列表上（被改过的条目带 customized: true） */
export function applyOverrides(list = SHORTCUTS, overrides = {}) {
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  return list.map((s) => {
    if (s.fixed || !own(o, s.id) || !Array.isArray(o[s.id])) return s;
    return { ...s, keys: o[s.id].filter((k) => typeof k === 'string').map(normalizeCombo), customized: true };
  });
}

function overridesKey(o) {
  return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
}

/** 应用一份自定义按键（会先清洗）；有变化时通知订阅者并返回 true */
export function setShortcutOverrides(raw) {
  const clean = sanitizeOverrides(raw);
  if (overridesKey(clean) === overridesKey(overridesState)) return false;
  overridesState = clean;
  effective = applyOverrides(SHORTCUTS, clean);
  keymapCache.clear();
  version += 1;
  for (const fn of Array.from(listeners)) { try { fn(); } catch { /* 订阅者自己的问题不影响其他人 */ } }
  return true;
}

export function getShortcutOverrides() { return overridesState; }
/** 当前生效的完整列表（默认 + 自定义） */
export function effectiveShortcuts() { return effective; }
/** 每次自定义按键变化时 +1（配合 useSyncExternalStore） */
export function getShortcutsVersion() { return version; }
export function subscribeShortcuts(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** 当前生效的查找表（带缓存，自定义按键变化时自动重建） */
export function keymapFor(scope = 'refine') {
  let m = keymapCache.get(scope);
  if (!m) { m = buildKeymap(effective, scope); keymapCache.set(scope, m); }
  return m;
}

/** 当前生效的快捷键定义 */
export function shortcutById(id) {
  return effective.find((s) => s.id === id) || null;
}

/** 某个功能在给定 overrides 下的按键（规范化的 combo 数组）；省略 overrides 时用当前生效的 */
export function keysOf(id, overrides) {
  const s = BY_ID.get(id);
  if (!s) return [];
  const o = overrides === undefined ? overridesState : (overrides || {});
  if (!s.fixed && own(o, id) && Array.isArray(o[id])) return o[id].filter((k) => typeof k === 'string').map(normalizeCombo);
  return defaultKeys(s);
}

export function isCustomized(id, overrides = overridesState) {
  return !!(overrides && own(overrides, id));
}

/** 让 id 独占 keys：其它功能用到这些按键就去掉。返回 { overrides, taken:[{ id, label, combo }] } */
function claimKeys(cur, id, keys) {
  const next = { ...cur, [id]: keys };
  const taken = [];
  for (const s of SHORTCUTS) {
    if (s.id === id || s.fixed) continue;
    const ks = keysOf(s.id, next);
    const hit = ks.filter((k) => keys.includes(k));
    if (!hit.length) continue;
    for (const combo of hit) taken.push({ id: s.id, label: s.label, combo });
    next[s.id] = ks.filter((k) => !keys.includes(k));
  }
  return { overrides: sanitizeOverrides(next), taken };
}

/**
 * 检查能不能把 combo 设给 id（replaceIndex ≥ 0 表示替换第几个按键，否则新增）。
 * → { ok, combo, same?, reason?, message?, conflicts:[{ id, label, group }] }；conflicts 非空时应先请用户确认。
 */
export function checkAssign(id, combo, overrides = overridesState, replaceIndex = -1) {
  const s = BY_ID.get(id);
  const c = normalizeCombo(combo);
  const fail = (reason, message, conflicts = []) => ({ ok: false, combo: c, reason, message, conflicts });
  if (!s) return fail('unknown', '没有找到这个功能');
  if (s.fixed) return fail('fixed', `「${s.label}」的按键是固定的，不能修改`);
  if (!isValidCombo(c)) return fail('invalid', '请按下一个具体的按键（只按 Ctrl、Shift、Alt 不算）');
  if (isReservedCombo(c)) return fail('reserved', `${formatCombo(c)} 要留给系统和对话框使用，请换一个按键`);
  const mine = keysOf(id, overrides);
  if (mine.includes(c)) return { ok: true, same: true, combo: c, conflicts: [] };
  const replacing = replaceIndex >= 0 && replaceIndex < mine.length;
  if (!replacing && mine.length >= MAX_KEYS_PER_ACTION) return fail('full', `每个功能最多设置 ${MAX_KEYS_PER_ACTION} 个按键，先删掉一个再添加`);
  const conflicts = [];
  for (const x of SHORTCUTS) {
    if (x.id === id || !keysOf(x.id, overrides).includes(c)) continue;
    if (x.fixed) return fail('taken-fixed', `${formatCombo(c)} 已固定用于「${x.label}」，请换一个按键`);
    conflicts.push({ id: x.id, label: x.label, group: x.group });
  }
  return { ok: true, combo: c, conflicts };
}

/**
 * 把 combo 设给 id；被其它功能占用时从那边去掉（界面上应先用 checkAssign 请用户确认）。
 * → { ok, overrides, taken:[{ id, label, combo }], reason?, message? }；ok 为 false 时 overrides 不变
 */
export function assignCombo(overrides, id, combo, replaceIndex = -1) {
  const cur = sanitizeOverrides(overrides);
  const chk = checkAssign(id, combo, cur, replaceIndex);
  if (!chk.ok) return { ok: false, overrides: cur, taken: [], reason: chk.reason, message: chk.message };
  if (chk.same) return { ok: true, overrides: cur, taken: [], same: true };
  const mine = keysOf(id, cur);
  if (replaceIndex >= 0 && replaceIndex < mine.length) mine[replaceIndex] = chk.combo; else mine.push(chk.combo);
  return { ok: true, ...claimKeys(cur, id, mine) };
}

/** 去掉某个功能的一个按键（去掉最后一个也可以，表示不设按键） */
export function removeCombo(overrides, id, combo) {
  const cur = sanitizeOverrides(overrides);
  const s = BY_ID.get(id);
  if (!s || s.fixed) return cur;
  const c = normalizeCombo(combo);
  return sanitizeOverrides({ ...cur, [id]: keysOf(id, cur).filter((k) => k !== c) });
}

/** 某个功能恢复默认按键；默认按键已被别的功能占用时收回来。→ { overrides, taken } */
export function resetShortcut(overrides, id) {
  const cur = sanitizeOverrides(overrides);
  const s = BY_ID.get(id);
  if (!s || s.fixed || !own(cur, id)) return { overrides: cur, taken: [] };
  const rest = { ...cur };
  delete rest[id];
  return claimKeys(rest, id, defaultKeys(s));
}

// ---------------------------------------------------------------------------
// 显示
// ---------------------------------------------------------------------------
const CODE_LABELS = {
  Space: '空格', Delete: 'Del', Backspace: '退格', Escape: 'Esc', Enter: '回车', Tab: 'Tab', Insert: 'Ins',
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn',
  Equal: '+', Minus: '-', Slash: '/', Backslash: '\\', IntlBackslash: '\\', Comma: ',', Period: '.', Semicolon: ';', Quote: "'",
  Backquote: '`', BracketLeft: '[', BracketRight: ']',
  NumpadAdd: '小键盘 +', NumpadSubtract: '小键盘 -', NumpadMultiply: '小键盘 *', NumpadDivide: '小键盘 /', NumpadDecimal: '小键盘 .',
  NumpadEnter: '小键盘 回车', ContextMenu: '菜单键', CapsLock: 'Caps Lock', PrintScreen: 'PrtSc', Pause: 'Pause', ScrollLock: 'Scroll Lock', NumLock: 'Num Lock',
  MediaPlayPause: '播放/暂停键', MediaTrackNext: '下一曲键', MediaTrackPrevious: '上一曲键', MediaStop: '停止键',
};

/** 单个物理键的显示文字：KeyZ → Z，Digit1 → 1，Numpad1 → 小键盘 1 */
export function keyLabel(code) {
  const c = String(code || '');
  if (CODE_LABELS[c]) return CODE_LABELS[c];
  return c.replace(/^Key(?=[A-Z]$)/, '').replace(/^Digit(?=\d$)/, '').replace(/^Numpad/, '小键盘 ');
}

/** 拆成一个个按键帽：'Ctrl+Shift+KeyZ' → ['Ctrl', 'Shift', 'Z']；Shift+/ 显示为 ? */
export function comboParts(combo) {
  const c = parseCombo(combo);
  if (!c.code) return [];
  if (c.shift && !c.ctrl && !c.alt && c.code === 'Slash') return ['?'];
  return [c.ctrl && 'Ctrl', c.alt && 'Alt', c.shift && 'Shift', keyLabel(c.code)].filter(Boolean);
}

/** 显示用按键文字：KeyZ → Z，Shift+Slash → ? */
export function formatCombo(combo) {
  return comboParts(combo).join('+');
}

/** 某个快捷键的首选显示文字（工具条 Tooltip 用）；没有按键时为 '' */
export function kbdOf(id, list = effective) {
  const s = list.find((x) => x.id === id);
  return s && s.keys && s.keys.length ? formatCombo(s.keys[0]) : '';
}

/** 帮助页 / 快捷键面板的分组数据（由注册表生成） */
export function groupedShortcuts(list = effective) {
  return SHORTCUT_GROUPS.map((g) => ({
    group: g,
    items: list.filter((s) => s.group === g).map((s) => ({
      id: s.id,
      label: s.label,
      scope: s.scope || 'refine',
      fixed: !!s.fixed,
      customized: !!s.customized,
      combos: (s.keys || []).map(normalizeCombo),
      keys: (s.keys || []).map(formatCombo),
      parts: (s.keys || []).map(comboParts),
    })),
  })).filter((g) => g.items.length);
}

/** 按功能名、分组名或按键筛选分组数据（搜索框用）。单个字母只匹配完全相同的按键 */
export function filterGroups(groups, query) {
  const q = String(query || '').toLowerCase().replace(/\s+/g, '');
  if (!q) return groups;
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
  const keyHit = (k) => {
    const n = norm(k);
    return n === q || (q.length > 1 && n.includes(q));
  };
  return groups
    .map((g) => ({
      ...g,
      items: norm(g.group).includes(q) ? g.items : g.items.filter((it) => norm(it.label).includes(q) || (it.keys || []).some(keyHit)),
    }))
    .filter((g) => g.items.length);
}
