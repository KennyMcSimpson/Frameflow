// 技法卡面板（分析详情「技法」Tab，或未选中视频时的「内置精选技法」）：搜索、展开、编辑、删除、应用到精修。
import React, { useMemo, useState } from 'react';
import useStore from '../../store.js';
import { Button, Tabs, Select, Icon, Chip, Modal, Empty, Spinner } from '../../components/ui.jsx';
import { TECHNIQUE_CATEGORY_LABELS } from '../../../engine/model.js';
import { BUILTIN_TECHNIQUES } from '../../../engine/builtinTechniques.js';
import { searchTechniques } from '../../../engine/techniques.js';
import useLibrary, { applyTechnique, techniqueOps } from './libraryActions.js';
import TechniqueEditor, { TECH_CATEGORY_OPTIONS } from './TechniqueEditor.jsx';
import { techniquesForAnalysis, simpleFilterTechniques, copyTechniqueDraft, fmtClock } from './libraryUtils.js';

const BUILTINS = Array.isArray(BUILTIN_TECHNIQUES) ? BUILTIN_TECHNIQUES : [];
const CAT_FILTER = [{ value: '', label: '全部类别' }, ...TECH_CATEGORY_OPTIONS];

function filterList(list, query, category) {
  const q = String(query || '').trim();
  if (!q) return category ? list.filter((t) => t.category === category) : list;
  try {
    const r = searchTechniques(list, q, { category: category || undefined, limit: 300 });
    return Array.isArray(r) ? r : simpleFilterTechniques(list, q, category);
  } catch {
    return simpleFilterTechniques(list, q, category);
  }
}

export default function TechniqueColumn({ initialTab, title }) {
  const current = useLibrary((s) => s.current);
  const techniques = useLibrary((s) => s.techniques);
  const techLoading = useLibrary((s) => s.techLoading);
  const techError = useLibrary((s) => s.techError);
  const hasProject = useStore((s) => !!s.project);
  const selCount = useStore((s) => (s.selection && s.selection.clipIds ? s.selection.clipIds.length : 0));
  const [tabState, setTab] = useState(initialTab || 'video');
  const tab = !current && tabState === 'video' ? 'builtin' : tabState;
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [openId, setOpenId] = useState(null);
  const [editor, setEditor] = useState(null); // { draft, isNew }
  const [confirmDel, setConfirmDel] = useState(null);

  const fromVideo = useMemo(() => techniquesForAnalysis(techniques, current), [techniques, current]);
  const base = tab === 'video' ? fromVideo : tab === 'mine' ? techniques : BUILTINS;
  const list = useMemo(() => filterList(base, query, category), [base, query, category]);

  const applyHint = !hasProject ? '先打开项目，在精修中选中镜头' : !selCount ? '先在精修中选中镜头' : `应用到精修中已选的 ${selCount} 个镜头`;

  const seekSource = (t) => {
    const s = t.source;
    if (!s || !s.analysisId) return;
    useLibrary.getState().requestSeek(s.analysisId, s.start, { end: s.end > s.start ? s.end : null, play: true });
  };

  return (
    <div className="lib-tech">
      <div className="lib-tech-head">
        {title && <div className="lib-tech-title">{title}</div>}
        <Tabs
          value={tab}
          onChange={(v) => { setTab(v); setOpenId(null); }}
          items={[
            ...(current ? [{ value: 'video', label: '来自此视频', badge: fromVideo.length }] : []),
            { value: 'mine', label: '我的全部', badge: techniques.length },
            { value: 'builtin', label: '内置精选', badge: BUILTINS.length },
          ]}
        />
      </div>
      <div className="lib-tech-tools">
        <div className="lib-search grow">
          <Icon name="search" size={13} />
          <input className="input" placeholder="搜索技法，如：逆光、转场、开头" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Select value={category} onChange={setCategory} options={CAT_FILTER} style={{ width: 96 }} />
      </div>
      <div className="lib-tech-tools">
        <Button size="sm" icon="plus" className="grow" onClick={() => setEditor({ draft: { category: 'camera', steps: [], tags: [] }, isNew: true })}>手动新建技法卡</Button>
        <Chip kind={hasProject && selCount ? 'accent' : undefined} title={applyHint}>
          {hasProject ? (selCount ? `精修已选 ${selCount} 镜` : '精修未选镜头') : '未打开项目'}
        </Chip>
      </div>

      <div className="lib-tech-list">
        {techLoading && !techniques.length && tab !== 'builtin' && <div className="lib-center-state"><Spinner /></div>}
        {techError && tab !== 'builtin' && (
          <div className="callout warn" style={{ margin: 8 }}>
            {techError}
            <div style={{ marginTop: 6 }}><Button size="sm" onClick={() => useLibrary.getState().loadTechniques()}>重试</Button></div>
          </div>
        )}
        {tab === 'video' && !current && (
          <Empty icon="book" title="还没有选择视频">在左侧选择一条拆片记录，这里会显示从它学到的技法。</Empty>
        )}
        {tab === 'video' && current && !fromVideo.length && !query && !category && (
          <Empty icon="book" title="这个视频还没有技法卡">
            可以点「手动新建技法卡」，把你从当前镜头学到的东西记下来。
          </Empty>
        )}
        {tab === 'mine' && !techniques.length && !techLoading && !techError && (
          <Empty icon="book" title="还没有我的技法卡">拆片完成后会自动生成技法卡，也可以手动新建，或把内置卡另存为自己的版本。</Empty>
        )}
        {base.length > 0 && !list.length && <div className="hint" style={{ padding: 12 }}>没有匹配的技法卡</div>}
        {list.map((t) => (
          <TechniqueCard
            key={t.id}
            t={t}
            open={openId === t.id}
            onToggle={() => setOpenId(openId === t.id ? null : t.id)}
            onEdit={() => setEditor({ draft: t, isNew: false })}
            onCopy={() => setEditor({ draft: copyTechniqueDraft(t), isNew: true })}
            onDelete={() => setConfirmDel(t)}
            onSeek={() => seekSource(t)}
            applyHint={applyHint}
          />
        ))}
      </div>

      {editor && (
        <TechniqueEditor
          draft={editor.draft}
          isNew={editor.isNew}
          onClose={() => setEditor(null)}
          onSaved={(saved) => { setOpenId(saved.id); if (editor.isNew && tab === 'builtin') setTab('mine'); }}
        />
      )}
      {confirmDel && (
        <Modal
          title="删除技法卡"
          onClose={() => setConfirmDel(null)}
          footer={(
            <>
              <Button onClick={() => setConfirmDel(null)}>取消</Button>
              <Button variant="danger" icon="trash" onClick={async () => { const t = confirmDel; setConfirmDel(null); await useLibrary.getState().deleteTechnique(t.id); }}>删除</Button>
            </>
          )}
        >
          <p style={{ margin: 0 }}>确定删除技法卡「<b>{confirmDel.title}</b>」吗？删除后无法恢复。</p>
        </Modal>
      )}
    </div>
  );
}

function TechniqueCard({ t, open, onToggle, onEdit, onCopy, onDelete, onSeek, applyHint }) {
  const ops = useMemo(() => techniqueOps(t), [t]);
  const src = t.source && t.source.analysisId ? t.source : null;
  const steps = Array.isArray(t.steps) ? t.steps : [];
  const tags = Array.isArray(t.tags) ? t.tags : [];
  return (
    <div className={'lib-tcard' + (open ? ' open' : '')}>
      <button type="button" className="lib-tcard-head" onClick={onToggle} aria-expanded={open}>
        <span className={'lib-tcat c-' + (t.category || 'narrative')}>{TECHNIQUE_CATEGORY_LABELS[t.category] || '技法'}</span>
        <span className="lib-tcard-title grow">{t.title}</span>
        {ops.length > 0 && <Icon name="wand" size={12} className="lib-tcard-apply-ico" />}
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} className="muted" />
      </button>
      {t.summary && <div className={'lib-tcard-sum selectable' + (open ? '' : ' clamp')}>{t.summary}</div>}
      {!open && src && (
        <button type="button" className="lib-tsrc mini" onClick={onSeek} title="跳到来源片段播放">
          <Icon name="play" size={9} />{fmtClock(src.start)}–{fmtClock(src.end)}
        </button>
      )}
      {open && (
        <div className="lib-tcard-body">
          {steps.length > 0 && (
            <ol className="lib-tsteps selectable">
              {steps.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
          )}
          {t.whenToUse && <div className="lib-aifield"><span className="k">适用</span><span className="v selectable">{t.whenToUse}</span></div>}
          {tags.length > 0 && <div className="lib-chiprow">{tags.map((g) => <Chip key={g}>{g}</Chip>)}</div>}
          {src && (
            <button type="button" className="lib-tsrc" onClick={onSeek} title="跳到这一段并播放">
              <Icon name="play" size={10} />
              <span className="ellipsis">来源：{src.title || '拆片视频'}</span>
              <span className="mono">{fmtClock(src.start)}–{fmtClock(src.end)}</span>
            </button>
          )}
          {t.apply && t.apply.note && <div className="hint">{t.apply.note}</div>}
          <div className="lib-tcard-actions">
            <Button
              size="sm"
              variant={ops.length ? 'primary' : undefined}
              icon="wand"
              disabled={!ops.length}
              title={ops.length ? applyHint : '这张卡没有可自动执行的操作，请按步骤手动完成'}
              onClick={() => applyTechnique(t)}
            >
              应用到精修所选镜头
            </Button>
            <span className="grow" />
            {t.builtin ? (
              <Button size="sm" variant="ghost" icon="copy" title="复制为我的技法卡，可自由修改" onClick={onCopy}>另存为我的</Button>
            ) : (
              <>
                <Button size="sm" variant="ghost" icon="settings" title="编辑" onClick={onEdit}>编辑</Button>
                <Button size="sm" variant="ghost" icon="trash" title="删除" onClick={onDelete} />
              </>
            )}
          </div>
          {t.builtin && <div className="xs muted">内置精选卡 · 离线可用</div>}
        </div>
      )}
    </div>
  );
}
