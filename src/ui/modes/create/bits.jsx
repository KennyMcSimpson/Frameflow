// 创作模式内部共用的小组件与 hook：草稿输入、标签输入、markdown、浮层菜单。
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../components/ui.jsx';
import { parseMarkdownLite } from './createUtils.js';

/** 中文输入法选字时的 Enter 不算提交 */
export const isComposing = (e) => e.nativeEvent.isComposing || e.keyCode === 229;

/** active 期间每秒刷新一次，返回已过去的秒数 */
export function useElapsed(active, startedAt) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return active ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
}

/** 失焦时才提交的文本框：打字不产生撤销步骤。Enter 提交，Esc 还原。 */
function useDraft(value, onCommit, normalize) {
  const external = value == null ? '' : value;
  const [draft, setDraft] = useState(external);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(external); }, [external]);
  return {
    value: draft,
    onChange: (e) => setDraft(e.target.value),
    onFocus: () => { focused.current = true; },
    onBlur: () => {
      focused.current = false;
      const next = normalize ? normalize(draft) : draft;
      setDraft(next);
      if (String(next) !== String(external)) onCommit(next);
    },
    revert: () => setDraft(external),
  };
}

export function DraftInput({ value, onCommit, normalize, className = 'input', ...rest }) {
  const { revert, ...draft } = useDraft(value, onCommit, normalize);
  return (
    <input
      className={className}
      {...rest}
      {...draft}
      onKeyDown={(e) => {
        if (isComposing(e)) return;
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') { revert(); e.stopPropagation(); }
      }}
    />
  );
}

export function DraftTextarea({ value, onCommit, className = 'textarea', ...rest }) {
  const { revert, ...draft } = useDraft(value, onCommit);
  return (
    <textarea
      className={className}
      {...rest}
      {...draft}
      onKeyDown={(e) => { if (e.key === 'Escape') { revert(); e.stopPropagation(); } }}
    />
  );
}

/** 标签输入：Enter 或逗号添加，退格删除最后一个，失焦时把没回车的内容也收进去 */
export function TagInput({ value, onChange, placeholder }) {
  const tags = Array.isArray(value) ? value : [];
  const [text, setText] = useState('');
  const flush = () => {
    const items = text.split(/[,，、]/).map((t) => t.trim()).filter((t) => t && !tags.includes(t));
    setText('');
    if (items.length) onChange([...tags, ...items]);
  };
  return (
    <div className="cr-tags">
      {tags.map((tag) => (
        <span key={tag} className="cr-tag">
          {tag}
          <button type="button" title={`移除「${tag}」`} aria-label={`移除「${tag}」`} onClick={() => onChange(tags.filter((t) => t !== tag))}>
            <Icon name="close" size={10} stroke={2.4} />
          </button>
        </span>
      ))}
      <input
        type="text"
        value={text}
        placeholder={tags.length ? '' : placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={flush}
        onKeyDown={(e) => {
          if (isComposing(e)) return;
          if (e.key === 'Enter' || e.key === ',' || e.key === '，') { e.preventDefault(); flush(); }
          else if (e.key === 'Backspace' && !text && tags.length) onChange(tags.slice(0, -1));
        }}
      />
    </div>
  );
}

function Inline({ parts }) {
  return parts.map((part, i) => {
    if (part.type === 'bold') return <strong key={i}>{part.text}</strong>;
    if (part.type === 'code') return <code key={i}>{part.text}</code>;
    return <React.Fragment key={i}>{part.text}</React.Fragment>;
  });
}

/** 轻量 markdown。走 React 节点而不是 innerHTML，AI 文本里的 HTML 不会被执行。 */
export function Markdown({ text }) {
  const blocks = useMemo(() => parseMarkdownLite(text), [text]);
  return (
    <div className="cr-md selectable">
      {blocks.map((block, i) => {
        if (block.type === 'h') return <h4 key={i}><Inline parts={block.inline} /></h4>;
        if (block.type === 'p') {
          return (
            <p key={i}>
              {block.lines.map((line, j) => (
                <React.Fragment key={j}>
                  {j > 0 && <br />}
                  <Inline parts={line} />
                </React.Fragment>
              ))}
            </p>
          );
        }
        const List = block.type === 'ol' ? 'ol' : 'ul';
        return <List key={i}>{block.items.map((item, j) => <li key={j}><Inline parts={item} /></li>)}</List>;
      })}
    </div>
  );
}

/**
 * 浮层菜单。挂到 body：卡片在滚动容器里，且悬停位移会改变 fixed 的定位基准。
 * items: [{ icon, iconStyle, label, onClick, disabled, danger, swatch } | 'sep']
 */
export function PopoverMenu({ anchor, items, onClose, width = 200 }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const box = ref.current.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(rect.right - box.width, window.innerWidth - box.width - margin));
    const below = rect.bottom + 4;
    const top = below + box.height > window.innerHeight - margin ? Math.max(margin, rect.top - box.height - 4) : below;
    setPos({ left, top });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target) && !anchor.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const onScroll = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      className="cr-menu"
      role="menu"
      style={{ width, left: pos ? pos.left : 0, top: pos ? pos.top : 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      {items.map((item, i) => {
        if (item === 'sep') return <div key={`sep-${i}`} className="cr-menu-sep" />;
        return (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={'cr-menu-item' + (item.danger ? ' danger' : '') + (item.active ? ' active' : '')}
            disabled={item.disabled}
            onClick={() => { onClose(); item.onClick(); }}
          >
            {item.swatch && <LookSwatch colors={item.swatch} />}
            {item.icon && <Icon name={item.icon} size={14} style={item.iconStyle} />}
            <span className="grow ellipsis">{item.label}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

export function LookSwatch({ colors }) {
  return (
    <span className="cr-swatch" aria-hidden="true">
      {colors.map((color, i) => <i key={i} style={{ background: color }} />)}
    </span>
  );
}

// ---------- 创作模式通用小组件 ----------

/** 主按钮 + 下拉。items: [{ id, label, icon, desc, onClick, disabled }] */
export function CrSplitButton({ label, icon, onClick, items = [], disabled, variant = 'primary', size = 'md', className = '', menuWidth = 248, ...rest }) {
  const [anchor, setAnchor] = useState(null);
  const caretRef = useRef(null);
  const close = React.useCallback(() => setAnchor(null), []);
  return (
    <span className={`cr-split ${variant} ${size} ${className}`} {...rest}>
      <button type="button" className="cr-split-main" disabled={disabled} onClick={onClick}>
        {icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
        <span>{label}</span>
      </button>
      {items.length > 0 && (
        <button
          ref={caretRef}
          type="button"
          className="cr-split-caret"
          aria-label="更多选项"
          aria-haspopup="menu"
          aria-expanded={!!anchor}
          disabled={disabled}
          onClick={(e) => { e.stopPropagation(); setAnchor(anchor ? null : caretRef.current); }}
        >
          <Icon name="chevronDown" size={14} />
        </button>
      )}
      {anchor && <PopoverMenu anchor={anchor} items={items} onClose={close} width={menuWidth} />}
    </span>
  );
}

/** 分段选择器。options: [{ value, label, icon }] */
export function CrSegmented({ options, value, onChange, size = 'md', className = '' }) {
  return (
    <div className={`cr-seg ${size} ${className}`} role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title || o.label}
          className={o.value === value ? 'on' : ''}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <Icon name={o.icon} size={14} />}
          {o.label && <span>{o.label}</span>}
        </button>
      ))}
    </div>
  );
}

/** 抽屉：从一侧滑出，Esc / 点遮罩关闭 */
export function CrDrawer({ open, side = 'right', width = 400, title, onClose, children, footer }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose && onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="cr-drawer-layer">
      <div className="cr-drawer-mask" onMouseDown={onClose} />
      <aside className={`cr-sheet ${side}`} style={{ width }} role="dialog" aria-label={title}>
        <header className="cr-sheet-head">
          <span className="cr-sheet-title">{title}</span>
          <button type="button" className="cr-icon-btn" aria-label="关闭" title="关闭 (Esc)" onClick={onClose}><Icon name="close" size={16} /></button>
        </header>
        <div className="cr-sheet-body">{children}</div>
        {footer && <footer className="cr-sheet-foot">{footer}</footer>}
      </aside>
    </div>,
    document.body,
  );
}

/** 可折叠分组 */
export function CrGroup({ title, defaultOpen = true, children, extra }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={'cr-group' + (open ? ' open' : '')}>
      <div className="cr-group-head" style={{ cursor: 'default' }}>
        <button
          type="button"
          className="cr-group-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, height: '100%',
            padding: 0, border: 0, background: 'transparent', color: 'inherit', textAlign: 'left', cursor: 'pointer',
          }}
        >
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
          <span className="grow">{title}</span>
        </button>
        {extra}
      </div>
      {open && <div className="cr-group-body">{children}</div>}
    </section>
  );
}

/** 进度环。value 0..1，null 为不确定进度（旋转） */
export function ProgressRing({ value = null, size = 34, stroke = 3 }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const known = typeof value === 'number';
  return (
    <svg className={'cr-ring' + (known ? '' : ' spin')} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,.18)" strokeWidth={stroke} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={known ? c * (1 - Math.max(0, Math.min(1, value))) : c * 0.7}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}