// 「创意简报」抽屉：基本信息默认展开，风格 / 约束 / 技法折叠。
import React, { useCallback, useMemo, useRef, useState } from 'react';
import useStore from '../../store.js';
import { Button, Chip, Field, Icon, Select } from '../../components/ui.jsx';
import { ASPECTS, LOOKS, LOOK_LABELS, TECHNIQUE_CATEGORY_LABELS, createBrief } from '../../../engine/model.js';
import { BUILTIN_TECHNIQUES } from '../../../engine/builtinTechniques.js';
import { searchTechniques } from '../../../engine/techniques.js';
import { updateBrief, updateStyleGuide } from './createActions.js';
import { LOOK_SWATCHES, PACING_LABELS, PLATFORMS } from './createLabels.js';
import { DraftInput, DraftTextarea, LookSwatch, PopoverMenu, TagInput, CrDrawer, CrGroup } from './bits.jsx';
import { useCreateUI } from './createState.js';
import { openBrief } from './Storyboard.jsx';

const TECHNIQUE_COUNT = 6;
const ASPECT_OPTIONS = Object.entries(ASPECTS).map(([value, a]) => ({ value, label: a.label }));
const PACING_OPTIONS = Object.entries(PACING_LABELS).map(([value, label]) => ({ value, label }));
const MIN_DURATION = 3;
const MAX_DURATION = 600;

function normalizeDuration(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, n));
}

function LookPicker({ value, onChange }) {
  const [anchor, setAnchor] = useState(null);
  const buttonRef = useRef(null);
  const close = useCallback(() => setAnchor(null), []);
  const items = LOOKS.map((look) => ({
    label: LOOK_LABELS[look],
    swatch: LOOK_SWATCHES[look],
    active: look === value,
    onClick: () => onChange(look),
  }));
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="select cr-look-button"
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        onClick={() => setAnchor(anchor ? null : buttonRef.current)}
      >
        <LookSwatch colors={LOOK_SWATCHES[value] || LOOK_SWATCHES.none} />
        <span className="ellipsis">{LOOK_LABELS[value] || LOOK_LABELS.none}</span>
      </button>
      {anchor && <PopoverMenu anchor={anchor} items={items} onClose={close} width={190} />}
    </>
  );
}

function TechniqueItem({ technique }) {
  const [open, setOpen] = useState(false);
  const steps = Array.isArray(technique.steps) ? technique.steps : [];
  return (
    <div className={'cr-tech' + (open ? ' open' : '')}>
      <button type="button" className="cr-tech-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        <span className="grow ellipsis">{technique.title}</span>
        <Chip>{TECHNIQUE_CATEGORY_LABELS[technique.category] || '技法'}</Chip>
      </button>
      {open && (
        <div className="cr-tech-body selectable">
          {technique.summary && <p>{technique.summary}</p>}
          {steps.length > 0 && <ol>{steps.map((step, i) => <li key={i}>{step}</li>)}</ol>}
          {technique.whenToUse && <p className="muted">适用：{technique.whenToUse}</p>}
        </div>
      )}
    </div>
  );
}

function TechniqueList({ brief }) {
  const query = [brief.style, brief.mood, brief.title, brief.goal].filter(Boolean).join(' ');
  const list = useMemo(() => {
    const found = query ? searchTechniques(BUILTIN_TECHNIQUES, query, { limit: TECHNIQUE_COUNT }) : [];
    return found && found.length ? found : BUILTIN_TECHNIQUES.slice(0, TECHNIQUE_COUNT);
  }, [query]);
  return <div className="cr-tech-list">{list.map((t) => <TechniqueItem key={t.id} technique={t} />)}</div>;
}

export default function BriefPanel() {
  const storeOpen = useStore((s) => s.drawer === 'brief');
  const localOpen = useCreateUI((s) => !!s.briefOpen);
  const open = storeOpen || localOpen;
  const stored = useStore((s) => s.project && s.project.brief);
  const aspect = useStore((s) => (s.project ? s.project.settings.aspect : '16:9'));
  const styleGuide = useStore((s) => (s.project && s.project.memory && s.project.memory.styleGuide) || '');
  const brief = useMemo(() => createBrief({ aspect, ...stored }), [stored, aspect]);
  const close = useCallback(() => openBrief(false), []);
  if (!open) return null;
  const platforms = PLATFORMS.includes(brief.platform) ? PLATFORMS : [brief.platform, ...PLATFORMS];
  const set = (key) => (value) => updateBrief({ [key]: value });

  return (
    <CrDrawer open title="创意简报" width={400} onClose={close}>
      {!stored && <div className="callout ai cr-brief-tip">和 AI 导演聊几句，这里会自动填好；也可以直接手动填写。</div>}

      <CrGroup title="基本信息">
        <Field label="标题"><DraftInput value={brief.title} placeholder="这条视频叫什么" onCommit={set('title')} /></Field>
        <Field label="目标"><DraftTextarea rows={2} value={brief.goal} placeholder="看完希望观众做什么" onCommit={set('goal')} /></Field>
        <Field label="受众"><DraftInput value={brief.audience} placeholder="拍给谁看" onCommit={set('audience')} /></Field>
        <div className="cr-form-2">
          <Field label="平台"><Select value={brief.platform} options={platforms} onChange={set('platform')} /></Field>
          <Field label="时长（秒）">
            <DraftInput type="number" min={MIN_DURATION} max={MAX_DURATION} value={brief.duration} normalize={normalizeDuration} onCommit={set('duration')} />
          </Field>
          <Field label="画幅"><Select value={aspect} options={ASPECT_OPTIONS} onChange={(value) => updateBrief({ aspect: value }, '修改画幅')} /></Field>
          <Field label="节奏"><Select value={brief.pacing} options={PACING_OPTIONS} onChange={set('pacing')} /></Field>
        </div>
        <Field label="核心信息"><DraftTextarea rows={2} value={brief.keyMessage} placeholder="观众最该记住的一句话" onCommit={set('keyMessage')} /></Field>
      </CrGroup>

      <CrGroup title="风格" defaultOpen={false}>
        <Field label="色调"><LookPicker value={brief.look} onChange={set('look')} /></Field>
        <div className="cr-form-2">
          <Field label="风格"><DraftInput value={brief.style} placeholder="如：清新日系" onCommit={set('style')} /></Field>
          <Field label="情绪"><DraftInput value={brief.mood} placeholder="如：温暖放松" onCommit={set('mood')} /></Field>
        </div>
        <Field label="音乐"><DraftInput value={brief.music} placeholder="如：轻快木吉他" onCommit={set('music')} /></Field>
        <Field label="风格指南" hint="全片记忆：精修时 AI 会按这里保持风格一致。">
          <DraftTextarea rows={4} value={styleGuide} placeholder="比如：全片暖色，固定机位为主，字幕用白色细字" onCommit={updateStyleGuide} />
        </Field>
      </CrGroup>

      <CrGroup title="约束" defaultOpen={false}>
        <Field label="必须有"><TagInput value={brief.mustHave} placeholder="输入后按 Enter" onChange={set('mustHave')} /></Field>
        <Field label="避免"><TagInput value={brief.avoid} placeholder="输入后按 Enter" onChange={set('avoid')} /></Field>
      </CrGroup>

      <CrGroup title="推荐技法" defaultOpen={false} extra={<span className="cr-section-link xs" role="link" onClick={(e) => { e.stopPropagation(); close(); useStore.getState().setMode('library'); }}>去拆片库</span>}>
        <TechniqueList brief={brief} />
      </CrGroup>
    </CrDrawer>
  );
}