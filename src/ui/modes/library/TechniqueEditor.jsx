// 技法卡编辑对话框：新建 / 编辑 / 内置卡另存为我的。
import React, { useState } from 'react';
import { Modal, Button, Select, Field, Switch } from '../../components/ui.jsx';
import { TECHNIQUE_CATEGORIES, TECHNIQUE_CATEGORY_LABELS } from '../../../engine/model.js';
import useLibrary from './libraryActions.js';
import { parseLines, parseTags, fmtClock } from './libraryUtils.js';

export const TECH_CATEGORY_OPTIONS = TECHNIQUE_CATEGORIES.map((c) => ({ value: c, label: TECHNIQUE_CATEGORY_LABELS[c] || c }));

/**
 * @param {{ draft: object, isNew: boolean, onClose: ()=>void, onSaved?: (t)=>void }} props
 * draft 为 Technique（或部分字段）；isNew=true 时保存为新卡。
 */
export default function TechniqueEditor({ draft, isNew, onClose, onSaved }) {
  const current = useLibrary((s) => s.current);
  const focusShot = useLibrary((s) => s.focusShot);
  const [title, setTitle] = useState(draft.title || '');
  const [category, setCategory] = useState(TECHNIQUE_CATEGORIES.includes(draft.category) ? draft.category : 'camera');
  const [summary, setSummary] = useState(draft.summary || '');
  const [steps, setSteps] = useState((draft.steps || []).join('\n'));
  const [whenToUse, setWhenToUse] = useState(draft.whenToUse || '');
  const [tags, setTags] = useState((draft.tags || []).join('，'));
  const [keepSource, setKeepSource] = useState(!!draft.source);
  const canLink = !draft.source && current && focusShot;
  const [linkShot, setLinkShot] = useState(!!(isNew && canLink));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    if (!title.trim()) { setErr('请填写技法名称'); return; }
    const stepList = parseLines(steps);
    if (!summary.trim() && !stepList.length) { setErr('请至少填写一句摘要或一个步骤'); return; }
    setErr('');
    const t = {
      ...draft,
      id: isNew ? null : draft.id,
      builtin: false,
      title: title.trim(),
      category,
      summary: summary.trim(),
      steps: stepList,
      whenToUse: whenToUse.trim(),
      tags: parseTags(tags),
    };
    if (draft.source && !keepSource) delete t.source;
    if (!draft.source && linkShot && canLink) {
      t.source = { analysisId: current.id, title: current.title, start: focusShot.start, end: focusShot.end };
    }
    setSaving(true);
    const saved = await useLibrary.getState().saveTechnique(t);
    setSaving(false);
    if (saved) { if (onSaved) onSaved(saved); onClose(); }
  };

  return (
    <Modal
      title={isNew ? (draft.title ? '另存为我的技法卡' : '新建技法卡') : '编辑技法卡'}
      onClose={() => !saving && onClose()}
      footer={(
        <>
          {err && <span className="xs grow" style={{ color: 'var(--danger)' }}>{err}</span>}
          <Button onClick={onClose} disabled={saving}>取消</Button>
          <Button variant="primary" icon="check" onClick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
        </>
      )}
    >
      <div className="lib-editor">
        <div className="lib-add-grid wide-first">
          <Field label="技法名称">
            <input className="input" value={title} maxLength={80} placeholder="例如：窗光侧逆光拍产品" onChange={(e) => setTitle(e.target.value)} autoFocus />
          </Field>
          <Field label="类别">
            <Select value={category} onChange={setCategory} options={TECH_CATEGORY_OPTIONS} />
          </Field>
        </div>
        <Field label="一句话摘要">
          <textarea className="textarea" rows={2} value={summary} maxLength={600} placeholder="这个技法是什么、能带来什么效果" onChange={(e) => setSummary(e.target.value)} />
        </Field>
        <Field label="操作步骤（每行一步）" hint="写给小白看的具体做法：机位、焦段、时长、参数等">
          <textarea className="textarea" rows={6} value={steps} placeholder={'1. 把产品放在窗边，窗在产品斜后方\n2. 手机曝光降低 0.7 档\n3. 用白卡在正面补一点光'} onChange={(e) => setSteps(e.target.value)} />
        </Field>
        <Field label="适用场景">
          <input className="input" value={whenToUse} maxLength={400} placeholder="什么时候用它" onChange={(e) => setWhenToUse(e.target.value)} />
        </Field>
        <Field label="标签（用逗号或空格分隔）">
          <input className="input" value={tags} placeholder="产品，逆光，质感" onChange={(e) => setTags(e.target.value)} />
        </Field>
        {draft.source && (
          <div className="lib-editor-link">
            <Switch checked={keepSource} onChange={setKeepSource} />
            <span className="small grow">
              保留来源：{draft.source.title || '拆片视频'} {fmtClock(draft.source.start)}–{fmtClock(draft.source.end)}
            </span>
          </div>
        )}
        {canLink && (
          <div className="lib-editor-link">
            <Switch checked={linkShot} onChange={setLinkShot} />
            <span className="small grow">
              关联到当前视频「{current.title}」的第 {focusShot.index + 1} 镜（{fmtClock(focusShot.start)}–{fmtClock(focusShot.end)}）
            </span>
          </div>
        )}
        {draft.apply && Array.isArray(draft.apply.ops) && draft.apply.ops.length > 0 && (
          <div className="hint">这张卡包含 {draft.apply.ops.length} 个可自动执行的操作，保存后仍可「应用到精修所选镜头」。</div>
        )}
      </div>
    </Modal>
  );
}
