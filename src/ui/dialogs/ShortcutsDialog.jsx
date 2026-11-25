// Keyboard Shortcuts Dialog & Panel: registry-driven customization, conflict detection, and reset.
// Shared between the ? shortcut modal and Help -> Shortcuts tab.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DICTS, useLocale, useT } from '../i18n.js';
import { Button, Icon, Modal } from '../components/ui.jsx';
import {
  MAX_KEYS_PER_ACTION, assignCombo, checkAssign, comboFromEvent, comboParts, effectiveShortcuts, filterGroups,
  findConflicts, firesInInput, getShortcutOverrides, groupedShortcuts, heldModifiers, keysOf,
  removeCombo, resetShortcut, shortcutById,
} from '../shortcuts/registry.js';
import { resetAllShortcuts, saveShortcutOverrides, useShortcutsVersion } from '../shortcuts/customKeys.js';
import '../shortcuts/shortcuts.css';

const NOTE_ICON = { ok: 'checkCircle', info: 'info', warn: 'alertTriangle', error: 'alert' };

const GROUP_KEYS = {
  '播放': 'shortcuts.group.playback',
  '剪辑': 'shortcuts.group.editing',
  '选择与剪贴板': 'shortcuts.group.selection',
  '时间线视图': 'shortcuts.group.timeline',
  '通用': 'shortcuts.group.general',
};

const EN_KEY_PART = {
  '空格': 'Space',
  '退格': 'Backspace',
  '回车': 'Enter',
  '菜单键': 'Menu',
  '播放/暂停键': 'Media Play/Pause',
  '下一曲键': 'Media Next',
  '上一曲键': 'Media Prev',
  '停止键': 'Media Stop',
};

function locKeyPart(part, locale) {
  if (locale === 'zh-CN') return part;
  if (EN_KEY_PART[part]) return EN_KEY_PART[part];
  return String(part || '').replace(/^小键盘\s*/, 'Num ');
}

function locComboParts(combo, locale) {
  return comboParts(combo).map((p) => locKeyPart(p, locale));
}

function locFormatCombo(combo, locale) {
  return locComboParts(combo, locale).join('+');
}

function Keycaps({ combo, locale }) {
  return locComboParts(combo, locale).map((p, i) => <kbd key={i}>{p}</kbd>);
}

function locLabelOf(id, tr) {
  const k = `shortcuts.action.${id}`;
  if (Object.prototype.hasOwnProperty.call(DICTS['zh-CN'], k)) return tr(k);
  const s = shortcutById(id);
  return s ? s.label : id;
}

function locGroupName(group, tr) {
  const k = GROUP_KEYS[group];
  return k ? tr(k) : group;
}

function defaultText(id, locale, tr) {
  const ks = keysOf(id, {});
  const joiner = ` ${tr('shortcuts.or')} `;
  return ks.length ? ks.map((c) => locFormatCombo(c, locale)).join(joiner) : tr('app.none');
}

function takenText(taken, locale, tr) {
  if (!taken || !taken.length) return '';
  const byId = new Map();
  for (const item of taken) {
    if (!byId.has(item.id)) byId.set(item.id, { id: item.id, combos: [] });
    byId.get(item.id).combos.push(locFormatCombo(item.combo, locale));
  }
  const sep = locale === 'zh-CN' ? '、' : ', ';
  const semi = tr('shortcuts.note.takenPrefix');
  return semi + Array.from(byId.values()).map((x) => tr('shortcuts.note.takenItem', {
    label: locLabelOf(x.id, tr),
    combos: x.combos.join(sep),
  })).join(semi);
}

function inInputHint(list, locale, tr) {
  const out = [];
  for (const s of list) {
    if (!s.allowInInput) continue;
    const k = (s.keys || []).find((c) => firesInInput(s, c));
    if (k) out.push(`${locFormatCombo(k, locale)} ${locLabelOf(s.id, tr)}`);
  }
  return out.join(locale === 'zh-CN' ? '、' : ', ');
}

function locAssignError(chk, id, locale, tr) {
  const combo = locFormatCombo(chk.combo, locale);
  switch (chk.reason) {
    case 'unknown': return tr('shortcuts.err.unknown');
    case 'fixed': return tr('shortcuts.err.fixed', { label: locLabelOf(id, tr) });
    case 'invalid': return tr('shortcuts.err.invalid');
    case 'reserved': return tr('shortcuts.err.reserved', { combo });
    case 'full': return tr('shortcuts.err.full', { max: MAX_KEYS_PER_ACTION });
    case 'taken-fixed': {
      const owner = effectiveShortcuts().find((s) => s.fixed && (s.keys || []).includes(chk.combo));
      return tr('shortcuts.err.takenFixed', { combo, label: owner ? locLabelOf(owner.id, tr) : '' });
    }
    default: return chk.message || tr('shortcuts.err.invalid');
  }
}

/** Swallow the matching keyup after recording so it does not trigger the refocused button. */
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

/** Shortcut list and interactive key recorder (embeddable in Help or ShortcutsDialog). */
export function ShortcutsPanel() {
  useShortcutsVersion();
  const locale = useLocale();
  const tr = useT();
  const all = effectiveShortcuts();
  const overrides = getShortcutOverrides();
  const customCount = Object.keys(overrides).length;
  const conflicts = findConflicts(all);
  const [query, setQuery] = useState('');

  const localizedGroups = useMemo(() => groupedShortcuts(all).map((g) => ({
    ...g,
    rawGroup: g.group,
    group: locGroupName(g.group, tr),
    items: g.items.map((it) => ({
      ...it,
      label: locLabelOf(it.id, tr),
      keys: (it.combos || []).map((c) => locFormatCombo(c, locale)),
    })),
  })), [all, locale, tr]);

  const groups = filterGroups(localizedGroups, query);
  const inputHint = inInputHint(all, locale, tr);

  const [rec, setRec] = useState(null); // { id, index (-1 = add), held, error }
  const [pending, setPending] = useState(null); // { id, index, combo, conflicts }
  const [note, setNote] = useState(null); // { tone, text }
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

  const restoreFocus = useCallback((id) => {
    setTimeout(() => {
      if (!alive.current) return;
      const el = triggerRef.current;
      triggerRef.current = null;
      if (focusQuiet(el)) return;
      const row = id ? document.querySelector(`[data-sck-row="${id}"]`) : null;
      focusQuiet(row && row.querySelector('.sck-key-btn, .sck-add, .sck-reset'));
    }, 0);
  }, []);

  const persist = useCallback(async (next, okText) => {
    const res = await saveShortcutOverrides(next);
    if (!alive.current) return;
    setNote(res.ok
      ? { tone: 'ok', text: okText }
      : { tone: 'error', text: tr('shortcuts.note.saveFail', { text: okText }) });
  }, [tr]);

  const applyAssign = useCallback((id, index, combo) => {
    const before = getShortcutOverrides();
    const old = keysOf(id, before);
    const r = assignCombo(before, id, combo, index);
    if (!r.ok) { setNote({ tone: 'error', text: locAssignError({ ...r, combo }, id, locale, tr) }); return; }
    if (r.same) return;
    const fmt = locFormatCombo(combo, locale);
    const replaced = index >= 0 && index < old.length ? locFormatCombo(old[index], locale) : '';
    const label = locLabelOf(id, tr);
    const baseText = replaced
      ? tr('shortcuts.note.replaced', { label, old: replaced, combo: fmt })
      : tr('shortcuts.note.added', { label, combo: fmt });
    persist(r.overrides, baseText + takenText(r.taken, locale, tr));
  }, [persist, locale, tr]);

  const stopRec = useCallback((id) => {
    setRec(null);
    restoreFocus(id);
  }, [restoreFocus]);

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
        setRec((r) => (r ? { ...r, held: [], error: tr('shortcuts.recUnidentified') } : r));
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) { setRec((r) => (r ? { ...r, held: mods } : r)); return; }
      const chk = checkAssign(recId, combo, getShortcutOverrides(), recIndex);
      if (!chk.ok) { setRec((r) => (r ? { ...r, held: [], error: locAssignError(chk, recId, locale, tr) } : r)); return; }
      finish();
      swallowKeyUp(e.code);
      if (chk.same) {
        setNote({ tone: 'info', text: tr('shortcuts.note.same', { combo: locFormatCombo(chk.combo, locale), label: locLabelOf(recId, tr) }) });
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
  }, [recId, recIndex, stopRec, applyAssign, locale, tr]);

  const cancelPending = useCallback(() => {
    setPending((p) => {
      if (p) restoreFocus(p.id);
      return null;
    });
  }, [restoreFocus]);

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
    const msg = tr('shortcuts.note.removed', { label: locLabelOf(id, tr), combo: locFormatCombo(combo, locale) })
      + (left ? '' : tr('shortcuts.note.removedNoneLeft'));
    persist(next, msg);
    restoreFocus(id);
  };

  const resetOne = (id) => {
    clearTransient();
    const r = resetShortcut(getShortcutOverrides(), id);
    triggerRef.current = null;
    const msg = tr('shortcuts.note.resetOne', { label: locLabelOf(id, tr), keys: defaultText(id, locale, tr) })
      + takenText(r.taken, locale, tr);
    persist(r.overrides, msg);
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
      ? { tone: 'ok', text: tr('shortcuts.note.resetAllOk') }
      : { tone: 'error', text: tr('shortcuts.note.resetAllSaveFail') });
    focusQuiet(searchRef.current);
  };

  const recChip = rec && (
    <span className="sck-rec" ref={recRef} tabIndex={-1} role="status" aria-live="polite">
      <span className="sck-rec-dot" aria-hidden="true" />
      {rec.held.length ? `${rec.held.join(' + ')} + …` : tr('shortcuts.recPrompt')}
      <span className="sck-rec-esc">{tr('shortcuts.recEsc')}</span>
    </span>
  );

  const conflictSep = locale === 'zh-CN' ? '；' : '; ';
  const nameSep = locale === 'zh-CN' ? '、' : ', ';
  const wrapName = (label) => (locale === 'zh-CN' ? `「${label}」` : `"${label}"`);
  const conflictListText = conflicts.map((c) => {
    const names = c.ids.map((id) => wrapName(locLabelOf(id, tr))).join(nameSep);
    return locale === 'zh-CN'
      ? `${locFormatCombo(c.combo, locale)}（${names}）`
      : `${locFormatCombo(c.combo, locale)} (${names})`;
  }).join(conflictSep);

  return (
    <div className="sck">
      <div className="sck-head">
        <label className="sck-search">
          <Icon name="search" size={14} />
          <input
            ref={searchRef} className="input sm" type="search" value={query} spellCheck={false}
            placeholder={tr('shortcuts.searchPlaceholder')} aria-label={tr('shortcuts.searchAria')}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.preventDefault(); setQuery(''); } }}
          />
        </label>
        <span className="sck-spacer" />
        {customCount > 0 && <span className="chip accent">{tr('shortcuts.customCount', { count: customCount })}</span>}
        <Button
          size="sm" variant={confirmAll ? 'danger' : 'ghost'} icon="reset" onClick={onResetAll}
          disabled={!customCount && !confirmAll} title={tr('shortcuts.resetAllTitle')}
        >
          {confirmAll ? tr('shortcuts.resetAllConfirm') : tr('shortcuts.resetAll')}
        </Button>
      </div>

      <p className="sc-intro">
        {tr('shortcuts.intro', {
          max: MAX_KEYS_PER_ACTION,
          except: inputHint ? tr('shortcuts.introExcept', { hint: inputHint }) : '',
        })}
      </p>

      {conflicts.length > 0 && (
        <div className="sc-conflict" role="alert">
          {tr('shortcuts.conflictBanner', { list: conflictListText })}
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
        <div className="sck-empty">{tr('shortcuts.emptySearch', { query: query.trim() })}</div>
      ) : (
        <div className="sc-grid">
          {groups.map((g) => (
            <section key={g.rawGroup} className="sc-group">
              <h4>{g.group}</h4>
              {g.items.map((it) => {
                const isRec = !!rec && rec.id === it.id;
                const isPending = !!pending && pending.id === it.id;
                const adding = isRec && rec.index < 0;
                const defKeys = defaultText(it.id, locale, tr);
                return (
                  <div key={it.id} className={'sc-row sck-row' + (isRec ? ' recording' : '') + (isPending ? ' pending' : '')} data-sck-row={it.id}>
                    <span className="sc-label sck-label">
                      {it.label}
                      {it.customized && <span className="sck-badge" title={tr('shortcuts.defaultTip', { keys: defKeys })}>{tr('shortcuts.badgeCustom')}</span>}
                    </span>
                    <span className="sc-keys sck-keys">
                      {it.combos.map((combo, i) => {
                        const fmt = locFormatCombo(combo, locale);
                        return (
                          <React.Fragment key={combo}>
                            {i > 0 && <span className="sc-or">{tr('shortcuts.or')}</span>}
                            {isRec && rec.index === i ? recChip : it.fixed ? (
                              <span className="sck-key fixed" title={tr('shortcuts.fixedTitle')}><Keycaps combo={combo} locale={locale} /></span>
                            ) : (
                              <span className="sck-key">
                                <button
                                  type="button" className="sck-key-btn" title={tr('shortcuts.keyBtnTitle')}
                                  aria-label={tr('shortcuts.keyBtnAria', { label: it.label, combo: fmt })}
                                  onClick={(e) => startRec(it.id, i, e.currentTarget)}
                                >
                                  <Keycaps combo={combo} locale={locale} />
                                </button>
                                <button
                                  type="button" className="sck-key-x" title={tr('shortcuts.removeTitle')}
                                  aria-label={tr('shortcuts.removeAria', { label: it.label, combo: fmt })}
                                  onClick={() => removeKey(it.id, combo)}
                                >
                                  <Icon name="x" size={9} stroke={2.4} />
                                </button>
                              </span>
                            )}
                          </React.Fragment>
                        );
                      })}
                      {!it.combos.length && !adding && <span className="sck-none">{tr('shortcuts.unassigned')}</span>}
                      {adding && (
                        <>
                          {it.combos.length > 0 && <span className="sc-or">{tr('shortcuts.or')}</span>}
                          {recChip}
                        </>
                      )}
                      {!it.fixed && !adding && it.combos.length < MAX_KEYS_PER_ACTION && (
                        <button
                          type="button" className="sck-add" title={tr('shortcuts.addTitle')}
                          aria-label={tr('shortcuts.addAria', { label: it.label })}
                          onClick={(e) => startRec(it.id, -1, e.currentTarget)}
                        >
                          <Icon name="plus" size={12} stroke={2} />
                        </button>
                      )}
                      {it.customized && (
                        <button
                          type="button" className="sck-reset" title={tr('shortcuts.resetOneTitle', { keys: defKeys })}
                          aria-label={tr('shortcuts.resetOneAria', { label: it.label, keys: defKeys })}
                          onClick={() => resetOne(it.id)}
                        >
                          <Icon name="reset" size={13} />
                        </button>
                      )}
                      {it.fixed && <span className="sck-lock" title={tr('shortcuts.fixedTitle')}><Icon name="lock" size={12} /></span>}
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
                          {tr('shortcuts.pendingConflict', {
                            combo: locFormatCombo(pending.combo, locale),
                            names: pending.conflicts.map((c) => wrapName(locLabelOf(c.id, tr))).join(nameSep),
                            label: it.label,
                          })}
                        </span>
                        <Button size="sm" variant="primary" autoFocus onClick={confirmPending}>{tr('shortcuts.pendingReassign')}</Button>
                        <Button size="sm" onClick={cancelPending}>{tr('app.cancel')}</Button>
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
  const tr = useT();
  return (
    <Modal title={tr('shortcuts.title')} onClose={onClose} wide className="sc-dialog">
      <ShortcutsPanel />
    </Modal>
  );
}
