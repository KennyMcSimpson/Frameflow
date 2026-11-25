// 技法面板：搜索内置与拆片沉淀的技法卡，一键应用到所选镜头。
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import useStore from '../../store.js';
import { Button, Chip, Empty, Icon, Spinner, fmtTime } from '../../components/ui.jsx';
import { TECHNIQUE_CATEGORIES, TECHNIQUE_CATEGORY_LABELS } from '../../../engine/model.js';
import { searchTechniques, techniqueToOps } from '../../../engine/techniques.js';
import { builtinTechniques, loadUserTechniques } from './SideData.js';

const SOURCES = [
  { value: 'all', label: '全部' },
  { value: 'builtin', label: '内置' },
  { value: 'mine', label: '我的拆片库' },
];
const MAX_SHOWN = 120;

function safeOps(t) {
  try {
    const ops = techniqueToOps(t);
    return Array.isArray(ops) ? ops : [];
  } catch { return []; }
}

/** 把技法步骤追加到所选镜头备注（一步历史） */
function appendNotes(t, ids) {
  const steps = (t.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n');
  const block = `【技法：${t.title}】\n${steps || t.summary || ''}`.trim();
  const set = new Set(ids);
  return useStore.getState().commit((p) => ({
    ...p,
    tracks: {
      ...p.tracks,
      video: p.tracks.video.map((c) => {
        if (!set.has(c.id)) return c;
        if ((c.notes || '').includes(`【技法：${t.title}】`)) return c; // 不重复追加
        return { ...c, notes: c.notes ? `${c.notes}\n\n${block}` : block };
      }),
    },
  }), '技法备注：' + t.title);
}

export default function TechniquePanel() {
  const selectedCount = useStore((s) => s.selection.clipIds.length);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [source, setSource] = useState('all');
  const [mine, setMine] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState(null);

  const refresh = useCallback(async (force) => {
    setLoading(true);
    const list = await loadUserTechniques(force);
    setMine(list);
    setLoading(false);
  }, []);
  useEffect(() => { refresh(false); }, [refresh]);

  const pool = useMemo(() => {
    const builtin = builtinTechniques();
    if (source === 'builtin') return builtin;
    if (source === 'mine') return mine;
    const seen = new Set(); const out = [];
    for (const t of [...mine, ...builtin]) if (t && t.id && !seen.has(t.id)) { seen.add(t.id); out.push(t); }
    return out;
  }, [mine, source]);

  const list = useMemo(() => {
    const q = query.trim();
    if (!q) return (category ? pool.filter((t) => t.category === category) : pool).slice(0, MAX_SHOWN);
    try {
      return searchTechniques(pool, q, { category: category || undefined, limit: MAX_SHOWN }) || [];
    } catch {
      const low = q.toLowerCase();
      return pool.filter((t) => (!category || t.category === category) && `${t.title} ${t.summary} ${(t.tags || []).join(' ')}`.toLowerCase().includes(low));
    }
  }, [pool, query, category]);

  const usedCategories = useMemo(() => {
    const set = new Set(pool.map((t) => t.category));
    return TECHNIQUE_CATEGORIES.filter((c) => set.has(c));
  }, [pool]);

  const apply = (t) => {
    const st = useStore.getState();
    const ids = st.selection.clipIds;
    const ops = safeOps(t);
    const needsClips = !ops.length || ops.some((op) => !op.target || op.target.mode !== 'none');
    if (needsClips && !ids.length) { st.toast('请先在时间线上选择要应用的镜头', 'warn'); return; }
    if (!ops.length) {
      const r = appendNotes(t, ids);
      if (r.ok) st.toast('此技法需要拍摄时实现，已加入备注', 'ok');
      return;
    }
    const r = st.commit(ops, '应用技法：' + t.title);
    if (r.ok) st.toast(`已应用技法「${t.title}」`, 'ok');
  };

  const openLibrary = () => useStore.getState().setMode('library');

  return (
    <div className="tq-root">
      <div className="tq-head">
        <div className="mp-search">
          <Icon name="search" size={14} />
          <input type="search" className="mp-search-input" placeholder="搜索技法，如：转场、逆光、产品特写" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
          {query && <button type="button" className="mp-search-clear" title="清空" onClick={() => setQuery('')}><Icon name="close" size={12} /></button>}
        </div>
        <div className="tq-row">
          <div className="mp-seg">
            {SOURCES.map((s) => (
              <button key={s.value} type="button" className={'mp-seg-btn' + (source === s.value ? ' active' : '')} onClick={() => setSource(s.value)}>{s.label}</button>
            ))}
          </div>
          <span className="grow" />
          {loading ? <Spinner /> : <Button size="sm" variant="ghost" icon="refresh" title="刷新我的拆片库" onClick={() => refresh(true)} />}
        </div>
        <div className="tq-cats">
          <button type="button" className={'tq-cat' + (!category ? ' active' : '')} onClick={() => setCategory('')}>全部</button>
          {usedCategories.map((c) => (
            <button key={c} type="button" className={'tq-cat' + (category === c ? ' active' : '')} onClick={() => setCategory(category === c ? '' : c)}>{TECHNIQUE_CATEGORY_LABELS[c] || c}</button>
          ))}
        </div>
        <div className="xs muted tq-target">
          {selectedCount ? `将应用到所选 ${selectedCount} 个镜头` : '未选择镜头：先在时间线上点选镜头，再应用技法'}
        </div>
      </div>

      <div className="tq-list">
        {!list.length ? (
          source === 'mine' && !mine.length && !loading ? (
            <Empty icon="book" title="拆片库还没有技法" action={<Button size="sm" onClick={openLibrary}>去拆片库</Button>}>
              把喜欢的视频丢进拆片库，分析后的手法会沉淀成技法卡，出现在这里。
            </Empty>
          ) : <Empty icon="search" title="没有匹配的技法">换个关键词，或切换类别和来源。</Empty>
        ) : list.map((t) => (
          <TechniqueCard key={t.id} t={t} open={openId === t.id} onToggle={() => setOpenId(openId === t.id ? null : t.id)} onApply={() => apply(t)} onOpenLibrary={openLibrary} canApply={selectedCount > 0} />
        ))}
      </div>
    </div>
  );
}

function TechniqueCard({ t, open, onToggle, onApply, onOpenLibrary, canApply }) {
  const ops = useMemo(() => safeOps(t), [t]);
  const hasOps = ops.length > 0;
  const src = t.source;
  return (
    <article className={'tq-card' + (open ? ' open' : '')}>
      <header className="tq-card-head" onClick={onToggle} role="button" tabIndex={0} aria-expanded={open} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="tq-card-title">{t.title}</div>
          <div className="tq-card-summary">{t.summary}</div>
        </div>
      </header>
      <div className="tq-card-meta">
        <Chip>{TECHNIQUE_CATEGORY_LABELS[t.category] || t.category || '其他'}</Chip>
        {t.builtin ? <Chip>内置</Chip> : <Chip kind="ai">拆片</Chip>}
        {!hasOps && <Chip kind="warn" title="需要在拍摄阶段实现，应用时写入镜头备注">拍摄技法</Chip>}
        <span className="grow" />
        <Button size="sm" variant={hasOps ? 'primary' : undefined} onClick={onApply} title={canApply ? undefined : '先在时间线上选择镜头'}>
          {hasOps ? '应用到所选镜头' : '加入备注'}
        </Button>
      </div>
      {open && (
        <div className="tq-card-body selectable">
          {Array.isArray(t.steps) && t.steps.length > 0 && (
            <>
              <div className="tq-sub">步骤</div>
              <ol className="tq-steps">{t.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
            </>
          )}
          {t.whenToUse && (<><div className="tq-sub">适用场景</div><p>{t.whenToUse}</p></>)}
          {t.apply && t.apply.note && (<><div className="tq-sub">说明</div><p>{t.apply.note}</p></>)}
          {!hasOps && <div className="hint">此技法需要拍摄时实现，点「加入备注」会把步骤写进所选镜头的备注。</div>}
          {Array.isArray(t.tags) && t.tags.length > 0 && <div className="mp-tags">{t.tags.slice(0, 8).map((g) => <span key={g} className="mp-tag">{g}</span>)}</div>}
          {src && (
            <div className="tq-source">
              <span className="grow ellipsis">
                来源：{src.title || '拆片分析'}
                {Number.isFinite(src.start) ? `（${fmtTime(src.start, false)}${Number.isFinite(src.end) ? '–' + fmtTime(src.end, false) : ''}）` : ''}
              </span>
              <Button size="sm" variant="ghost" icon="external" onClick={onOpenLibrary}>在拆片库查看</Button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
