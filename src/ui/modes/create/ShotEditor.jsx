// 右侧「镜头属性」面板：选中分镜后出现。修改先进草稿，点保存一次提交（一步撤销）。
import React, { useEffect, useMemo, useState } from 'react';
import useStore from '../../store.js';
import api from '../../api.js';
import { Button, Field, Icon, Select } from '../../components/ui.jsx';
import { PrevizCanvas, SourceDot, SOURCE_META } from '../../components/media.jsx';
import { deepClone } from '../../../engine/ids.js';
import { BUILTIN_TECHNIQUES } from '../../../engine/builtinTechniques.js';
import {
  SHOT_SIZES, SHOT_SIZE_LABELS, ANGLES, ANGLE_LABELS, SHOT_MOVEMENTS, SHOT_MOVEMENT_LABELS, TRANSITIONS, TRANSITION_LABELS,
  LOOKS, LOOK_LABELS, PREVIZ_SETTINGS, PREVIZ_SUBJECTS, PREVIZ_ACTIONS,
} from '../../../engine/model.js';
import { saveShot, findReferences } from './createActions.js';
import { setUI, useCreateUI } from './createState.js';
import {
  SETTING_LABELS, TIME_OF_DAY, TIME_LABELS, SUBJECT_LABELS, ACTION_LABELS, LIGHT_DIRECTIONS, LIGHT_DIRECTION_LABELS,
  LIGHT_KEYS, LIGHT_KEY_LABELS, LIGHT_MOODS, LIGHT_MOOD_LABELS, toOptions,
} from './createLabels.js';
import { MAX_SUBJECTS, MAX_SHOT_SECONDS, MIN_SHOT_SECONDS, frameSize, normalizeShot, shotSource } from './createUtils.js';
import { TagInput, CrSegmented, CrGroup } from './bits.jsx';
import { fillShot, genShotVideo } from './ShotCard.jsx';

const SHOT_SIZE_OPTIONS = toOptions(SHOT_SIZES, SHOT_SIZE_LABELS);
const ANGLE_OPTIONS = toOptions(ANGLES, ANGLE_LABELS);
const MOVEMENT_OPTIONS = toOptions(SHOT_MOVEMENTS, SHOT_MOVEMENT_LABELS);
const TRANSITION_OPTIONS = toOptions(TRANSITIONS, TRANSITION_LABELS);
const LOOK_OPTIONS = toOptions(LOOKS, LOOK_LABELS);
const SETTING_OPTIONS = toOptions(PREVIZ_SETTINGS, SETTING_LABELS);
const TIME_OPTIONS = toOptions(TIME_OF_DAY, TIME_LABELS);
const SUBJECT_OPTIONS = toOptions(PREVIZ_SUBJECTS, SUBJECT_LABELS);
const ACTION_OPTIONS = toOptions(PREVIZ_ACTIONS, ACTION_LABELS);
const LIGHT_DIRECTION_OPTIONS = toOptions(LIGHT_DIRECTIONS, LIGHT_DIRECTION_LABELS);
const LIGHT_KEY_OPTIONS = toOptions(LIGHT_KEYS, LIGHT_KEY_LABELS);
const LIGHT_MOOD_OPTIONS = toOptions(LIGHT_MOODS, LIGHT_MOOD_LABELS);

const SOURCE_OPTIONS = [
  { value: 'stock', label: '实拍素材', icon: 'film' },
  { value: 'ai', label: 'AI 生成', icon: 'sparkles' },
  { value: 'local', label: '本地导入', icon: 'folder' },
];

function SelectField({ label, value, options, onChange }) {
  return <Field label={label}><Select value={value} options={options} onChange={onChange} /></Field>;
}

function TipsEditor({ tips, onChange }) {
  const setTip = (i, text) => onChange(tips.map((t, j) => (j === i ? text : t)));
  return (
    <div className="col cr-tips-editor">
      {tips.map((tip, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <div className="cr-tip-row" key={i}>
          <span className="cr-tip-no mono">{i + 1}</span>
          <textarea className="textarea" rows={2} value={tip} placeholder="比如：手机横拿，双手贴紧身体，走路时屈膝减震" onChange={(e) => setTip(i, e.target.value)} />
          <button type="button" className="cr-icon-btn" title="删除这条" onClick={() => onChange(tips.filter((_, j) => j !== i))}><Icon name="trash" size={14} /></button>
        </div>
      ))}
      <div><Button size="sm" variant="ghost" icon="plus" onClick={() => onChange([...tips, ''])}>添加拍法</Button></div>
    </div>
  );
}

function Preview({ shot, draft, aspect, source }) {
  const { asset, kind } = source;
  const size = frameSize(aspect, 320);
  const style = { aspectRatio: `${size.width} / ${size.height}` };
  let body;
  if (asset && asset.kind === 'video' && asset.path && !asset.missing) {
    body = <video key={asset.id} src={api.mediaUrl(asset.path)} poster={asset.thumb ? api.mediaUrl(asset.thumb) : undefined} muted loop autoPlay playsInline controls={false} />;
  } else if (asset && (asset.thumb || asset.kind === 'image' || asset.kind === 'generated-image')) {
    body = <img src={api.mediaUrl(asset.thumb || asset.path)} alt="" />;
  } else if (draft.previz) {
    body = (
      <PrevizCanvas spec={draft.previz} width={size.width} height={size.height} playing duration={Math.max(MIN_SHOT_SECONDS, Number(draft.duration) || 4)}
        shotSize={draft.shotSize} movement={draft.movement} watermark={false} style={{ width: '100%', height: '100%' }} />
    );
  } else body = <div className="cr-shot-empty"><Icon name="film" size={24} /></div>;
  return (
    <div className="cr-insp-preview" style={style}>
      {body}
      <span className="cr-insp-source"><SourceDot kind={kind} withLabel /></span>
      {asset && asset.source && asset.source.page && <span className="cr-insp-credit" title={asset.source.page}>{asset.credit || ''}</span>}
      {kind === 'none' && <span className="cr-insp-missing">还没有画面 · {shot.title}</span>}
    </div>
  );
}

export default function ShotEditor({ shotId, onClose }) {
  const shot = useStore((s) => (s.project ? s.project.storyboard.find((x) => x.id === shotId) : null));
  const assets = useStore((s) => s.project && s.project.assets);
  const refs = useStore((s) => s.project && s.project.references && s.project.references[shotId]);
  const aspect = useStore((s) => (s.project ? s.project.settings.aspect : '16:9'));
  const userTechniques = useCreateUI((s) => s.userTechniques);
  const [initial, setInitial] = useState(() => (shot ? normalizeShot(deepClone(shot), shot.index || 1) : null));
  const [draft, setDraft] = useState(initial);

  useEffect(() => { if (!shot) onClose(); }, [shot, onClose]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initial), [draft, initial]);
  // 外部（撤销 / AI 修改）改了分镜且本地没有未保存修改时，同步最新内容
  useEffect(() => {
    if (!shot || dirty) return;
    const fresh = normalizeShot(deepClone(shot), shot.index || 1);
    if (JSON.stringify(fresh) !== JSON.stringify(initial)) { setInitial(fresh); setDraft(fresh); }
  }, [shot]); // eslint-disable-line react-hooks/exhaustive-deps

  const techniques = useMemo(() => {
    const map = new Map([...BUILTIN_TECHNIQUES, ...(userTechniques || [])].map((t) => [t.id, t]));
    return ((draft && draft.techniqueIds) || []).map((id) => map.get(id)).filter(Boolean);
  }, [draft, userTechniques]);

  if (!shot || !draft) return null;
  const source = shotSource(shot, assets);

  const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
  const setCamera = (key, value) => setDraft((d) => ({ ...d, [key]: value, previz: { ...d.previz, camera: { ...(d.previz && d.previz.camera), [key]: value } } }));
  const setPreviz = (key, value) => setDraft((d) => ({ ...d, previz: { ...d.previz, [key]: value } }));
  const setLight = (key, value) => setDraft((d) => ({ ...d, previz: { ...d.previz, light: { ...d.previz.light, [key]: value } } }));
  const subjects = (draft.previz && draft.previz.subjects) || [];
  const setSubject = (i, patch) => setPreviz('subjects', subjects.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  const save = () => { if (saveShot(shotId, draft)) setInitial(draft); };
  const revert = () => setDraft(initial);
  const pickSource = (v) => {
    if (v === 'stock') fillShot(shotId);
    else if (v === 'ai') genShotVideo(shotId);
    else setUI({ pickerShotId: shotId });
  };
  const segValue = source.kind === 'previz' || source.kind === 'none' ? null : source.kind;

  return (
    <aside className="cr-insp" aria-label="镜头属性">
      <header className="cr-insp-head">
        <span className="cr-insp-no mono">{String(shot.index).padStart(2, '0')}</span>
        <span className="cr-insp-title grow ellipsis">镜头属性</span>
        <button type="button" className="cr-icon-btn" title="关闭" aria-label="关闭" onClick={onClose}><Icon name="close" size={16} /></button>
      </header>

      <div className="cr-insp-body">
        <Preview shot={shot} draft={draft} aspect={aspect} source={source} />

        <div className="cr-insp-section">
          <div className="cr-insp-label">画面来源</div>
          <CrSegmented options={SOURCE_OPTIONS} value={segValue} onChange={pickSource} />
          <p className="cr-insp-hint">
            {source.kind === 'previz' ? '当前只是示意动画，不会作为成片。选一个来源换成真实画面。'
              : source.kind === 'none' ? '还没有画面，选一个来源。'
                : `当前：${SOURCE_META[source.kind].label}。再点一次可换一条。`}
          </p>
        </div>

        <div className="cr-insp-section">
          <Field label="标题"><input type="text" className="input" value={draft.title} onChange={(e) => set('title', e.target.value)} /></Field>
          <Field label="台词 / 字幕"><textarea className="textarea" rows={2} value={draft.caption} onChange={(e) => set('caption', e.target.value)} /></Field>
          <Field label="旁白"><textarea className="textarea" rows={2} value={draft.voiceover} onChange={(e) => set('voiceover', e.target.value)} /></Field>
        </div>

        <CrGroup title="镜头语言">
          <div className="cr-form-2">
            <SelectField label="景别" value={draft.shotSize} options={SHOT_SIZE_OPTIONS} onChange={(v) => setCamera('shotSize', v)} />
            <SelectField label="角度" value={draft.angle} options={ANGLE_OPTIONS} onChange={(v) => setCamera('angle', v)} />
            <SelectField label="运镜" value={draft.movement} options={MOVEMENT_OPTIONS} onChange={(v) => setCamera('movement', v)} />
            <Field label={`时长（${MIN_SHOT_SECONDS}–${MAX_SHOT_SECONDS} 秒）`}>
              <input type="number" className="input" min={MIN_SHOT_SECONDS} max={MAX_SHOT_SECONDS} step={0.5} value={draft.duration} onChange={(e) => set('duration', e.target.value === '' ? '' : Number(e.target.value))} />
            </Field>
            <SelectField label="入场转场" value={draft.transitionIn} options={TRANSITION_OPTIONS} onChange={(v) => set('transitionIn', v)} />
            <SelectField label="色调" value={draft.look} options={LOOK_OPTIONS} onChange={(v) => set('look', v)} />
          </div>
          <Field label="光线"><input type="text" className="input" value={draft.lighting} placeholder="比如：侧逆光，暖色，窗光" onChange={(e) => set('lighting', e.target.value)} /></Field>
        </CrGroup>

        <CrGroup title={`拍法要点${draft.shootingTips.length ? `（${draft.shootingTips.length}）` : ''}`}>
          <TipsEditor tips={draft.shootingTips} onChange={(v) => set('shootingTips', v)} />
          {techniques.length > 0 && (
            <div className="cr-insp-techs">
              <div className="cr-insp-label">用到的技法</div>
              {techniques.map((t) => (
                <div key={t.id} className="cr-insp-tech" title={t.summary || ''}><Icon name="book" size={12} /><span className="ellipsis">{t.title}</span></div>
              ))}
            </div>
          )}
        </CrGroup>

        <CrGroup title="内容" defaultOpen={false}>
          <div className="cr-form-2">
            <Field label="地点"><input type="text" className="input" value={draft.location} onChange={(e) => set('location', e.target.value)} /></Field>
            <Field label="主体"><input type="text" className="input" value={draft.subject} onChange={(e) => set('subject', e.target.value)} /></Field>
          </div>
          <Field label="动作"><textarea className="textarea" rows={2} value={draft.action} onChange={(e) => set('action', e.target.value)} /></Field>
        </CrGroup>

        <CrGroup title={`参考视频${refs && refs.length ? `（${refs.length}）` : ''}`} defaultOpen={false}>
          <Field hint="用于「查找参考」。B站优先中文词，YouTube 优先英文词。">
            <TagInput value={draft.referenceQueries} placeholder="输入后按 Enter" onChange={(v) => set('referenceQueries', v)} />
          </Field>
          <div className="row">
            <Button size="sm" icon="globe" onClick={() => { findReferences(shotId); setUI({ drawerShotId: shotId }); }}>查找参考</Button>
            {refs && refs.length > 0 && <Button size="sm" variant="ghost" onClick={() => setUI({ drawerShotId: shotId })}>查看 {refs.length} 条</Button>}
          </div>
        </CrGroup>

        {draft.previz && (
          <CrGroup title="示意动画参数" defaultOpen={false}>
            <div className="cr-form-2">
              <SelectField label="场景" value={draft.previz.setting} options={SETTING_OPTIONS} onChange={(v) => setPreviz('setting', v)} />
              <SelectField label="时间" value={draft.previz.timeOfDay} options={TIME_OPTIONS} onChange={(v) => setPreviz('timeOfDay', v)} />
              <SelectField label="光向" value={draft.previz.light && draft.previz.light.direction} options={LIGHT_DIRECTION_OPTIONS} onChange={(v) => setLight('direction', v)} />
              <SelectField label="色温" value={draft.previz.light && draft.previz.light.key} options={LIGHT_KEY_OPTIONS} onChange={(v) => setLight('key', v)} />
              <SelectField label="氛围" value={draft.previz.light && draft.previz.light.mood} options={LIGHT_MOOD_OPTIONS} onChange={(v) => setLight('mood', v)} />
            </div>
            <div className="col cr-subjects">
              {subjects.map((subject, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <div className="cr-subject-row" key={i}>
                  <Select value={subject.kind} options={SUBJECT_OPTIONS} onChange={(kind) => setSubject(i, { kind })} />
                  <Select value={subject.action} options={ACTION_OPTIONS} onChange={(action) => setSubject(i, { action })} />
                  <button type="button" className="cr-icon-btn" title="移除主体" disabled={subjects.length <= 1} onClick={() => setPreviz('subjects', subjects.filter((_, j) => j !== i))}><Icon name="trash" size={14} /></button>
                </div>
              ))}
              <div>
                <Button size="sm" variant="ghost" icon="plus" disabled={subjects.length >= MAX_SUBJECTS}
                  onClick={() => setPreviz('subjects', [...subjects, { ...(subjects[0] || {}), kind: 'product', action: 'idle', label: '', x: 0.3 + 0.2 * subjects.length }])}>添加主体</Button>
              </div>
            </div>
          </CrGroup>
        )}
      </div>

      {dirty && (
        <footer className="cr-insp-foot">
          <span className="grow xs muted">有未保存的修改</span>
          <Button size="sm" variant="ghost" onClick={revert}>还原</Button>
          <Button size="sm" className="cr-save-btn" onClick={save}>保存</Button>
        </footer>
      )}
    </aside>
  );
}
