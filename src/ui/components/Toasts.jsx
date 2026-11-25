// 右下角 Toast 堆叠。kind: info / success（旧写法 ok 同义）/ warn / error。
// 条目 { id, message, kind, key?, action? }：key 相同的由 store 原地替换，这里按 key 稳定渲染不闪动；
// action = { label, run } 渲染成按钮，点击先执行 run() 再关闭。点提示条本身或 × 也会关闭。
import React from 'react';
import useStore from '../store.js';
import { useLocale } from '../i18n.js';

const GLYPH = {
  info: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 11v6M12 7.5h.01',
  ok: 'M12 22a10 10 0 100-20 10 10 0 000 20zM7.5 12.5l3 3 6-6.5',
  warn: 'M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0zM12 9v4M12 17h.01',
  error: 'M12 22a10 10 0 100-20 10 10 0 000 20zM15 9l-6 6M9 9l6 6',
};

const LABEL = { info: '提示', ok: '成功', warn: '注意', error: '出错了' };
const LABEL_EN = { info: 'Info', ok: 'Success', warn: 'Warning', error: 'Error' };

/** 统一 kind：success 与旧的 ok 视为同一种；未知值按 info */
export function toastKind(kind) {
  if (kind === 'success' || kind === 'ok') return 'ok';
  return GLYPH[kind] ? kind : 'info';
}

/** 关闭一条提示：优先走 store 的 dismissToast（C1），没有时直接过滤 */
function dismiss(t) {
  const st = useStore.getState();
  if (typeof st.dismissToast === 'function') {
    try { st.dismissToast(t.id); return; } catch { /* 回退到直接过滤 */ }
  }
  useStore.setState({ toasts: (useStore.getState().toasts || []).filter((x) => x.id !== t.id) });
}

function ToastItem({ t }) {
  const isEn = useLocale() === 'en-US';
  const kind = toastKind(t.kind);
  const labels = isEn ? LABEL_EN : LABEL;
  const action = t.action && typeof t.action.run === 'function' && t.action.label ? t.action : null;
  const runAction = (e) => {
    e.stopPropagation();
    const errPrefix = isEn ? 'Action failed: ' : '操作没有完成：';
    try {
      const r = action.run();
      if (r && typeof r.catch === 'function') r.catch((err) => useStore.getState().toast?.(errPrefix + (err?.message || err), 'error'));
    } catch (err) {
      useStore.getState().toast?.(errPrefix + (err?.message || err), 'error');
    }
    dismiss(t);
  };
  return (
    <div
      className={'toast ' + kind + (action ? ' has-action' : '')}
      role={kind === 'error' ? 'alert' : undefined}
      onClick={() => dismiss(t)}
      title={action ? undefined : (isEn ? 'Click to dismiss' : '点击关闭')}
    >
      <svg className="toast-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={GLYPH[kind]} />
      </svg>
      <div className="toast-text">
        <span className="sr-only">{labels[kind]}{isEn ? ': ' : '：'}</span>
        {String(t.message == null ? '' : t.message)}
      </div>
      {action && (
        <button type="button" className="toast-action" onClick={runAction}>{action.label}</button>
      )}
      <button
        type="button"
        className="toast-close"
        aria-label={isEn ? 'Dismiss notification' : '关闭提示'}
        onClick={(e) => { e.stopPropagation(); dismiss(t); }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
  );
}

export default function Toasts() {
  const toasts = useStore((s) => s.toasts) || [];
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {/* 有 key 的按 key 作为 React key：原地替换内容时同一个 DOM，不会重播入场动画 */}
      {toasts.map((t) => <ToastItem key={t.key ? 'k:' + t.key : t.id} t={t} />)}
    </div>
  );
}
