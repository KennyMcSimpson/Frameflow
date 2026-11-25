// 左栏拆片列表：搜索（标题 / 技法 / 标签）、按视频类型与技法类别筛选、删除（确认）。
import React, { useMemo, useState } from 'react';
import api from '../../api.js';
import { Button, Select, Icon, Modal, Spinner, Chip } from '../../components/ui.jsx';
import { ANALYSIS_CATEGORY_LABELS, TECHNIQUE_CATEGORY_LABELS } from '../../../engine/model.js';
import useLibrary from './libraryActions.js';
import { CATEGORY_OPTIONS } from './AddPanel.jsx';
import { filterLibrary, techCategoryCounts, fmtClock, fmtDate } from './libraryUtils.js';

const FILTER_OPTIONS = [{ value: 'all', label: '全部类型' }, ...CATEGORY_OPTIONS];

export default function AnalysisList({ onAdd }) {
  const analyses = useLibrary((s) => s.analyses);
  const techniques = useLibrary((s) => s.techniques);
  const loading = useLibrary((s) => s.listLoading);
  const loaded = useLibrary((s) => s.listLoaded);
  const error = useLibrary((s) => s.listError);
  const selectedId = useLibrary((s) => s.selectedId);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('all');
  const [techCat, setTechCat] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const list = useMemo(() => filterLibrary(analyses, { query: q, category: cat, techCategory: techCat, techniques }), [analyses, q, cat, techCat, techniques]);
  const techCounts = useMemo(() => techCategoryCounts(techniques), [techniques]);
  const techChips = Object.keys(techCounts).sort((a, b) => techCounts[b] - techCounts[a]).slice(0, 8);
  const lib = useLibrary.getState();
  const filtered = !!(q.trim() || cat !== 'all' || techCat);

  const doDelete = async () => {
    if (!confirm) return;
    setDeleting(true);
    await lib.deleteAnalysis(confirm.id);
    setDeleting(false);
    setConfirm(null);
  };

  return (
    <div className="lib-list">
      <div className="lib-list-tools">
        <div className="lib-search">
          <Icon name="search" size={14} />
          <input className="input" placeholder="搜索标题、技法或标签" value={q} onChange={(e) => setQ(e.target.value)} />
          {q && <button type="button" className="lib-search-clear" onClick={() => setQ('')} title="清除"><Icon name="close" size={12} /></button>}
        </div>
        <div className="lib-list-filter">
          <Select value={cat} onChange={setCat} options={FILTER_OPTIONS} />
          {loading ? <Spinner /> : <Button size="sm" variant="ghost" icon="refresh" title="刷新列表" onClick={() => lib.loadAnalyses()} />}
        </div>
        {techChips.length > 0 && (
          <div className="lib-chipfilter" role="group" aria-label="按技法筛选">
            <button type="button" className={'lib-fchip' + (!techCat ? ' on' : '')} onClick={() => setTechCat('')}>全部技法</button>
            {techChips.map((k) => (
              <button key={k} type="button" className={'lib-fchip' + (techCat === k ? ' on' : '')} onClick={() => setTechCat(techCat === k ? '' : k)}>
                {TECHNIQUE_CATEGORY_LABELS[k] || k}<span>{techCounts[k]}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="lib-list-head">
        <span>{filtered ? `筛选出 ${list.length} / ${analyses.length} 条` : `全部拆片 · ${analyses.length}`}</span>
        {filtered && <button type="button" className="lib-linkbtn" onClick={() => { setQ(''); setCat('all'); setTechCat(''); }}>清除筛选</button>}
      </div>

      {error && (
        <div className="callout warn lib-list-error">
          {error}
          <div><Button size="sm" onClick={() => lib.loadAnalyses()}>重试</Button></div>
        </div>
      )}
      <div className="lib-list-items">
        {loaded && !analyses.length && !error && (
          <div className="lib-list-empty">
            <Icon name="scissors" size={22} />
            <div>还没有拆片记录</div>
            <div className="xs">粘贴一个 B站 / YouTube / 抖音链接，或选择本地视频开始。</div>
            {onAdd && <Button size="sm" icon="plus" onClick={onAdd}>添加第一个视频</Button>}
          </div>
        )}
        {analyses.length > 0 && !list.length && <div className="lib-list-none">没有符合条件的记录</div>}
        {list.map((a) => (
          <div
            key={a.id}
            role="button"
            tabIndex={0}
            className={'lib-item' + (a.id === selectedId ? ' selected' : '')}
            onClick={() => lib.selectAnalysis(a.id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); lib.selectAnalysis(a.id); } }}
          >
            <span className="lib-item-thumb">
              {a.thumb ? <img src={api.mediaUrl(a.thumb)} alt="" loading="lazy" draggable={false} /> : <Icon name="film" size={16} />}
              {Number(a.duration) > 0 && <span className="lib-item-dur">{fmtClock(a.duration)}</span>}
            </span>
            <span className="lib-item-body">
              <span className="lib-item-title" title={a.title}>{a.title || '未命名视频'}</span>
              <span className="lib-item-meta">
                <span className="lib-item-cat">{ANALYSIS_CATEGORY_LABELS[a.category] || '其他'}</span>
                <span>{Number(a.shotCount) || 0} 镜</span>
                <span>{Number(a.techniqueCount) || 0} 技法</span>
                {a.status === 'partial' && <Chip kind="warn">部分</Chip>}
              </span>
              <span className="lib-item-date">{fmtDate(a.createdAt)}</span>
            </span>
            <button
              type="button"
              className="lib-item-del"
              title="删除这条记录"
              onClick={(e) => { e.stopPropagation(); setConfirm(a); }}
            >
              <Icon name="trash" size={13} />
            </button>
          </div>
        ))}
      </div>

      {confirm && (
        <Modal
          title="删除拆片记录"
          onClose={() => !deleting && setConfirm(null)}
          footer={(
            <>
              <Button onClick={() => setConfirm(null)} disabled={deleting}>取消</Button>
              <Button variant="danger" icon="trash" onClick={doDelete} disabled={deleting}>{deleting ? '删除中…' : '删除'}</Button>
            </>
          )}
        >
          <p className="lib-modal-p">
            确定删除「<b>{confirm.title}</b>」的拆片记录吗？镜头、关键帧、图表等分析数据会被删除，无法恢复。
          </p>
          <p className="hint">从这个视频生成的技法卡会保留在「我的全部」中。</p>
        </Modal>
      )}
    </div>
  );
}
