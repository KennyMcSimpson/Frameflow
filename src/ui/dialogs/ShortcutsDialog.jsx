// 快捷键面板：完全由注册表生成，可以改按键、去掉按键、恢复默认（自定义按键见契约 C11）。
// 精修模式按 ? 打开 ShortcutsDialog；「帮助 → 快捷键」嵌入同一个 ShortcutsPanel，两处始终一致。
// 录新按键时在 window 捕获阶段拦下所有按键，对话框、精修和全局快捷键都收不到，录完再交还。
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Icon, Modal } from '../components/ui.jsx';
import {
  MAX_KEYS_PER_ACTION, assignCombo, checkAssign, comboFromEvent, comboParts, effectiveShortcuts, filterGroups,
  findConflicts, firesInInput, formatCombo, getShortcutOverrides, groupedShortcuts, heldModifiers, keysOf,
  removeCombo, resetShortcut, shortcutById,
} from '../shortcuts/registry.js';
import { resetAllShortcuts, saveShortcutOverrides, useShortcutsVersion } from '../shortcuts/customKeys.js';
import '../shortcuts/shortcuts.css';

const NOTE_ICON = { ok: 'checkCircle', info: 'info', warn: 'alertTriangle', error: 'alert' };

function Keycaps({ combo }) {
  return comboParts(combo).map((p, i) => <kbd key={i}>{p}</kbd>);
}

function labelOf(id) {
  const s = shortcutById(id);
  return s ? s.label : id;
}

/** 默认按键的文字，例如「Ctrl+B 或 S」；没有默认按键时为「无」 */
function defaultText(id) {
  const ks = keysOf(id, {});
  return ks.length ? ks.map(formatCombo).join(' 或 ') : '无';
}

/** 「被改走」的按键说明：；「添加文字」不再使用 T */
function takenText(taken) {
  if (!taken || !taken.length) return '';
  const byId = new Map();
  for (const t of taken) {
    if (!byId.has(t.id)) byId.set(t.id, { label: t.label, combos: [] });
    byId.get(t.id).combos.push(formatCombo(t.combo));
  }
  return '；' + Array.from(byId.values()).map((x) => `「${x.label}」不再使用 ${x.combos.join('、')}`).join('；');
}

/** 光标在输入框里也生效的按键，例如「Ctrl+S 保存、F1 打开帮助」 */
function inInputHint(list) {
  const out = [];
  for (const s of list) {
    if (!s.allowInInput) continue;
    const k = (s.keys || []).find((c) => firesInInput(s, c));
    if (k) out.push(`${formatCombo(k)} ${s.label}`);
  }
  return out.join('、');
}

/** 录完按键后把这个键松开的事件也吞掉，免得落到刚拿回焦点的按钮上 */
function swallowKeyUp(code) {
  if (typeof window === 'undefined' || !code) return;
  let timer = 0;
  const onUp = (e) => {
    if (e.code !== code) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    off();
  };
  function off() { window.removeEventListener('keyup', onUp, true); clearTimeout(timer); }
  window.addEventListener('keyup', onUp, true);
  timer = setTimeout(off, 1500);
}

function focusQuiet(el) {
  if (!el || !el.isConnected) return false;
  try { el.focus({ preventScroll: true }); } catch { return false; }
  return true;
}

/** 快捷键列表 + 改按键。可单独嵌入任何容器（帮助中心的「快捷键」页也用它） */
export function ShortcutsPanel() {
  useShortcutsVersion();
  const all = effectiveShortcuts();
  const overrides = getShortcutOverrides();
  const customCount = Object.keys(overrides).length;
  const conflicts = findConflicts(all);
  const [query, setQuery] = useState('');
  const groups = filterGroups(groupedShortcuts(all), query);
  const inputHint = inInputHint(all);

  const [rec, setRec] = useState(null); // 正在录：{ id, index（-1 = 新增）, held: ['Ctrl'], error }
  const [pending, setPending] = useState(null); // 等用户确认抢用：{ id, index, combo, conflicts }
  const [note, setNote] = useState(null); // { tone: ok|info|warn|error, text }
  const [confirmAll, setConfirmAll] = useState(false);
  const recRef = useRef(null);
  const triggerRef = useRef(null);
  const searchRef = useRef(null);
  const confirmTimer = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; clearTimeout(confirmTimer.current); };
  }, []);

  // 焦点还给点开录制的那个按钮；按钮已经不在了（按键被换掉）就给这一行的第一个按钮
  const restoreFocus = useCallback((id) => {
    setTimeout(() => {
      if (!alive.current) return;
      const t = triggerRef.current;
      triggerRef.current = null;
      if (focusQuiet(t)) return;
      const row = id ? document.querySelector(`[data-sck-row="${id}"]`) : null;
      focusQuiet(row && row.querySelector('.sck-key-btn, .sck-add, .sck-reset'));
    }, 0);
  }, []);

  const persist = useCallback(async (next, okText) => {
    const res = await saveShortcutOverrides(next);
    if (!alive.current) return;
    setNote(res.ok
      ? { tone: 'ok', text: okText }
      : { tone: 'error', text: `${okText}，但没能保存下来，重启应用后会恢复原来的按键` });
  }, []);

  const applyAssign = useCallback((id, index, combo) => {
    const before = getShortcutOverrides();
    const old = keysOf(id, before);
    const r = assignCombo(before, id, combo, index);
    if (!r.ok) { setNote({ tone: 'error', text: r.message }); return; }
    if (r.same) return;
    const fmt = formatCombo(combo);
    const replaced = index >= 0 && index < old.length ? formatCombo(old[index]) : '';
    const text = (replaced ? `「${labelOf(id)}」的 ${replaced} 已改为 ${fmt}` : `已为「${labelOf(id)}」加上 ${fmt}`) + takenText(r.taken);
    persist(r.overrides, text);
  }, [persist]);

  const stopRec = useCallback((id) => {
    setRec(null);
    restoreFocus(id);
  }, [restoreFocus]);

  // 录制：捕获阶段拦下按键（Esc 取消；只按修饰键时显示「Ctrl + …」）；点别处或切走窗口也取消
  const recId = rec ? rec.id : null;
  const recIndex = rec ? rec.index : -1;
  useEffect(() => {
    if (recId == null) return undefined;
    focusQuiet(recRef.current);
    let done = false;
    const finish = () => { done = true; };
    const onDown = (e) => {
      if (done) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat || e.isComposing) return;
      const mods = heldModifiers(e);
      if ((e.key === 'Escape' || e.code === 'Escape') && !mods.length) { finish(); stopRec(recId); return; }
      if (!e.code || e.code === 'Unidentified') {
        setRec((r) => (r ? { ...r, held: [], error: '这个键识别不出来，请换一个按键' } : r));
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) { setRec((r) => (r ? { ...r, held: mods } : r)); return; }
      const chk = checkAssign(recId, combo, getShortcutOverrides(), recIndex);
      if (!chk.ok) { setRec((r) => (r ? { ...r, held: [], error: chk.message } : r)); return; }
      finish();
      swallowKeyUp(e.code);
      if (chk.same) {
        setNote({ tone: 'info', text: `${formatCombo(chk.combo)} 本来就是「${labelOf(recId)}」的按键` });
        stopRec(recId);
        return;
      }
      if (chk.conflicts.length) {
        setRec(null);
        setPending({ id: recId, index: recIndex, combo: chk.combo, conflicts: chk.conflicts });
        return;
      }
      stopRec(recId);
      applyAssign(recId, recIndex, chk.combo);
    };
    const onUp = (e) => {
      if (done) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setRec((r) => (r ? { ...r, held: heldModifiers(e) } : r));
    };
    const cancelQuiet = () => { if (done) return; finish(); triggerRef.current = null; setRec(null); };
    const onMouse = (e) => { if (!recRef.current || !recRef.current.contains(e.target)) cancelQuiet(); };
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    window.addEventListener('mousedown', onMouse, true);
    window.addEventListener('blur', cancelQuiet);
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
      window.removeEventListener('mousedown', onMouse, true);
      window.removeEventListener('blur', cancelQuiet);
    };
  }, [recId, recIndex, stopRec, applyAssign]);

  const cancelPending = useCallback(() => {
    setPending((p) => {
      if (p) restoreFocus(p.id);
      return null;
    });
  }, [restoreFocus]);

  // 确认框打开时 Esc 先关确认框，不关整个对话框
  const pendingKey = pending ? `${pending.id}|${pending.index}|${pending.combo}` : '';
  useEffect(() => {
    if (!pendingKey) return undefined;
    const onKey = (e) => {
      if (!(e.key === 'Escape' || e.code === 'Escape') || e.isComposing || e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      cancelPending();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pendingKey, cancelPending]);

  const clearTransient = () => {
    setRec(null);
    setPending(null);
    setConfirmAll(false);
    clearTimeout(confirmTimer.current);
  };

  const startRec = (id, index, el) => {
    clearTransient();
    setNote(null);
    triggerRef.current = el || null;
    setRec({ id, index, held: [], error: '' });
  };

  const confirmPending = () => {
    const p = pending;
    if (!p) return;
    setPending(null);
    applyAssign(p.id, p.index, p.combo);
    restoreFocus(p.id);
  };

  const removeKey = (id, combo) => {
    clearTransient();
    const next = removeCombo(getShortcutOverrides(), id, combo);
    const left = keysOf(id, next).length;
    triggerRef.current = null;
    persist(next, `已去掉「${labelOf(id)}」的 ${formatCombo(combo)}` + (left ? '' : '，这个功能现在没有快捷键，需要时点 + 加一个'));
    restoreFocus(id);
  };

  const resetOne = (id) => {
    clearTransient();
    const r = resetShortcut(getShortcutOverrides(), id);
    triggerRef.current = null;
    persist(r.overrides, `「${labelOf(id)}」已恢复默认按键 ${defaultText(id)}` + takenText(r.taken));
    restoreFocus(id);
  };

  const onResetAll = async () => {
    setRec(null);
    setPending(null);
    clearTimeout(confirmTimer.current);
    if (!confirmAll) {
      setConfirmAll(true);
      confirmTimer.current = setTimeout(() => { if (alive.current) setConfirmAll(false); }, 4000);
      return;
    }
    setConfirmAll(false);
    const res = await resetAllShortcuts();
    if (!alive.current) return;
    setNote(res.ok
      ? { tone: 'ok', text: '已全部恢复默认按键' }
      : { tone: 'error', text: '已恢复默认按键，但没能保存下来，重启应用后会回到之前的设置' });
    focusQuiet(searchRef.current);
  };

  const recChip = rec && (
    <span className="sck-rec" ref={recRef} tabIndex={-1} role="status" aria-live="polite">
      <span className="sck-rec-dot" aria-hidden="true" />
      {rec.held.length ? `${rec.held.join(' + ')} + …` : '请按新的按键'}
      <span className="sck-rec-esc">Esc 取消</span>
    </span>
  );

  return (
    <div className="sck">
      <div className="sck-head">
        <label className="sck-search">
          <Icon name="search" size={14} />
          <input
            ref={searchRef} className="input sm" type="search" value={query} spellCheck={false}
            placeholder="搜索功能或按键，例如 分割、Ctrl+B" aria-label="搜索快捷键"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.preventDefault(); setQuery(''); } }}
          />
        </label>
        <span className="sck-spacer" />
        {customCount > 0 && <span className="chip accent">已自定义 {customCount} 项</span>}
        <Button
          size="sm" variant={confirmAll ? 'danger' : 'ghost'} icon="reset" onClick={onResetAll}
          disabled={!customCount && !confirmAll} title="所有功能恢复成默认按键"
        >
          {confirmAll ? '再点一次，确认全部恢复' : '全部恢复默认'}
        </Button>
      </div>

      <p className="sc-intro">
        按物理键位识别，中文输入法下同样可用。点按键可以换成别的键，鼠标移上去点 × 去掉，点 + 再加一个（每个功能最多 {MAX_KEYS_PER_ACTION} 个）。
        光标在输入框里时快捷键不触发{inputHint ? `（${inputHint} 除外）` : ''}。
      </p>

      {conflicts.length > 0 && (
        <div className="sc-conflict" role="alert">
          这些按键同时设给了多个功能，按下时只会触发其中一个：
          {conflicts.map((c) => `${formatCombo(c.combo)}（${c.ids.map((id) => `「${labelOf(id)}」`).join('、')}）`).join('；')}。
          点对应的按键改掉其中一个即可。
        </div>
      )}

      <div aria-live="polite">
        {note && (
          <div className={'sck-note ' + note.tone} role={note.tone === 'error' ? 'alert' : undefined}>
            <Icon name={NOTE_ICON[note.tone] || 'info'} size={14} />
            <span>{note.text}</span>
          </div>
        )}
      </div>

      {groups.length === 0 ? (
        <div className="sck-empty">没有找到和「{query.trim()}」有关的快捷键</div>
      ) : (
        <div className="sc-grid">
          {groups.map((g) => (
            <section key={g.group} className="sc-group">
              <h4>{g.group}</h4>
              {g.items.map((it) => {
                const isRec = !!rec && rec.id === it.id;
                const isPending = !!pending && pending.id === it.id;
                const adding = isRec && rec.index < 0;
                return (
                  <div key={it.id} className={'sc-row sck-row' + (isRec ? ' recording' : '') + (isPending ? ' pending' : '')} data-sck-row={it.id}>
                    <span className="sc-label sck-label">
                      {it.label}
                      {it.customized && <span className="sck-badge" title={`默认按键：${defaultText(it.id)}`}>已改</span>}
                    </span>
                    <span className="sc-keys sck-keys">
                      {it.combos.map((combo, i) => (
                        <React.Fragment key={combo}>
                          {i > 0 && <span className="sc-or">或</span>}
                          {isRec && rec.index === i ? recChip : it.fixed ? (
                            <span className="sck-key fixed" title="固定按键，不能修改"><Keycaps combo={combo} /></span>
                          ) : (
                            <span className="sck-key">
                              <button
                                type="button" className="sck-key-btn" title="点一下，再按新的按键"
                                aria-label={`「${it.label}」的按键 ${formatCombo(combo)}，点一下换成别的键`}
                                onClick={(e) => startRec(it.id, i, e.currentTarget)}
                              >
                                <Keycaps combo={combo} />
                              </button>
                              <button
                                type="button" className="sck-key-x" title="去掉这个按键"
                                aria-label={`去掉「${it.label}」的按键 ${formatCombo(combo)}`}
                                onClick={() => removeKey(it.id, combo)}
                              >
                                <Icon name="x" size={9} stroke={2.4} />
                              </button>
                            </span>
                          )}
                        </React.Fragment>
                      ))}
                      {!it.combos.length && !adding && <span className="sck-none">未设置</span>}
                      {adding && (
                        <>
                          {it.combos.length > 0 && <span className="sc-or">或</span>}
                          {recChip}
                        </>
                      )}
                      {!it.fixed && !adding && it.combos.length < MAX_KEYS_PER_ACTION && (
                        <button
                          type="button" className="sck-add" title="再加一个按键"
                          aria-label={`给「${it.label}」再加一个按键`}
                          onClick={(e) => startRec(it.id, -1, e.currentTarget)}
                        >
                          <Icon name="plus" size={12} stroke={2} />
                        </button>
                      )}
                      {it.customized && (
                        <button
                          type="button" className="sck-reset" title={`恢复默认：${defaultText(it.id)}`}
                          aria-label={`「${it.label}」恢复默认按键 ${defaultText(it.id)}`}
                          onClick={() => resetOne(it.id)}
                        >
                          <Icon name="reset" size={13} />
                        </button>
                      )}
                      {it.fixed && <span className="sck-lock" title="固定按键，不能修改"><Icon name="lock" size={12} /></span>}
                    </span>
                    {isRec && rec.error && (
                      <div className="sck-msg error" role="alert">
                        <Icon name="alert" size={14} />
                        <span className="sck-msg-text">{rec.error}</span>
                      </div>
                    )}
                    {isPending && (
                      <div className="sck-msg warn" role="alert">
                        <Icon name="alertTriangle" size={14} />
                        <span className="sck-msg-text">
                          {formatCombo(pending.combo)} 已用于{pending.conflicts.map((c) => `「${c.label}」`).join('、')}。
                          改给「{it.label}」后，那边将不再使用这个按键。
                        </span>
                        <Button size="sm" variant="primary" autoFocus onClick={confirmPending}>改用</Button>
                        <Button size="sm" onClick={cancelPending}>取消</Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ShortcutsDialog({ onClose }) {
  return (
    <Modal title="键盘快捷键" onClose={onClose} wide className="sc-dialog">
      <ShortcutsPanel />
    </Modal>
  );
}
