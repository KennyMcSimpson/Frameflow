// 自定义快捷键的读写（契约 C11：settings.shortcuts.overrides = { [actionId]: string[] }）。
// 合并、校验、冲突处理都在 registry.js（纯函数）；这里只管「从哪读、往哪写」和 React 订阅。
// 主进程的 settings:set 只接受 DEFAULTS 里有的顶层键：设置里还没有 shortcuts 这一项时会被丢掉，
// 所以每次保存同时在本机 localStorage 留一份，读取时设置里没有就用本机这份，保证改过的按键重启后还在。
import { useSyncExternalStore } from 'react';
import api from '../api.js';
import useStore from '../store.js';
import {
  comboFromEvent, effectiveShortcuts, findConflicts, firesInInput, getShortcutOverrides, getShortcutsVersion,
  isTypingTarget, kbdOf, keymapFor, matchShortcut, sanitizeOverrides, setShortcutOverrides, shortcutById,
  subscribeShortcuts,
} from './registry.js';

export { comboFromEvent, firesInInput, isTypingTarget, keymapFor, matchShortcut, shortcutById };

export const LOCAL_KEY = 'ff.shortcuts.overrides';

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function storage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

function readLocal() {
  const ls = storage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(LOCAL_KEY);
    return raw ? sanitizeOverrides(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeLocal(overrides) {
  const ls = storage();
  if (!ls) return false;
  try {
    if (Object.keys(overrides).length) ls.setItem(LOCAL_KEY, JSON.stringify(overrides));
    else ls.removeItem(LOCAL_KEY);
    return true;
  } catch {
    return false;
  }
}

function storedOverrides(settings) {
  const sc = settings && typeof settings === 'object' ? settings.shortcuts : null;
  const o = sc && typeof sc === 'object' ? sc.overrides : null;
  return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
}

/** 设置里的自定义按键（已清洗）；设置里没有或为空时用本机缓存 */
export function overridesFromSettings(settings) {
  const raw = storedOverrides(settings);
  const fromSettings = raw ? sanitizeOverrides(raw) : null;
  if (fromSettings && Object.keys(fromSettings).length) return fromSettings;
  const local = readLocal();
  if (local && Object.keys(local).length) return local;
  return {};
}

/** 把设置里的自定义按键应用到注册表（加载/刷新设置时调用）。对 null/空设置安全，并在变化时通知订阅者。→ 生效后的按键冲突 [{ combo, ids }] */
export function applyShortcutSettings(settings = null) {
  const next = overridesFromSettings(settings && typeof settings === 'object' ? settings : null);
  setShortcutOverrides(next);
  return findConflicts(effectiveShortcuts());
}

/**
 * 保存自定义按键：立即生效，写入设置并在本机留一份。
 * 设置是深合并，删不掉键，所以去掉的条目要显式写成 null（读取时 null 会被忽略）。
 * → { ok, settings, local }：settings 表示写设置成功；local 表示本机缓存写成功；ok 为两者之一成功
 */
export async function saveShortcutOverrides(next) {
  const clean = sanitizeOverrides(next);
  const prev = getShortcutOverrides();
  setShortcutOverrides(clean);
  const local = writeLocal(clean);

  const st = useStore.getState();
  const settings = st.settings && typeof st.settings === 'object' ? st.settings : null;
  const stored = storedOverrides(settings) || {};
  const patch = { ...clean };
  for (const id of new Set([...Object.keys(prev), ...Object.keys(stored)])) {
    if (!own(clean, id)) patch[id] = null;
  }
  // 本地设置副本同步更新，App 里「设置变化 → 重新应用」时读到的就是这一份
  if (settings) useStore.setState({ settings: { ...settings, shortcuts: { ...(settings.shortcuts || {}), overrides: clean } } });

  let saved = false;
  try {
    await api.call('settings:set', { shortcuts: { overrides: patch } });
    saved = true;
  } catch {
    saved = false;
  }
  return { ok: saved || local, settings: saved, local };
}

/** 全部恢复默认按键 */
export function resetAllShortcuts() {
  return saveShortcutOverrides({});
}

/** 自定义按键变化时让组件重新渲染；返回版本号 */
export function useShortcutsVersion() {
  return useSyncExternalStore(subscribeShortcuts, getShortcutsVersion, getShortcutsVersion);
}

/** 某个功能当前的按键文字（随自定义更新），给工具条、菜单的 kbd 提示用；没有按键时为 '' */
export function useKbd(id) {
  useShortcutsVersion();
  return kbdOf(id);
}
