// New Project Dialog: project name, aspect ratio presets, frame rate, and media source overview.
import React, { useEffect, useRef, useState } from 'react';
import useStore from '../store.js';
import { t, useLocale, useT } from '../i18n.js';
import { Modal, Button, Field, Segmented, Spinner, Icon } from '../components/ui.jsx';

export const ASPECT_CHOICES = [
  { value: '16:9', key: '16_9', title: '横屏 16:9', size: '1920 × 1080', platforms: 'B站、YouTube、西瓜视频', note: '电脑和电视观看的标准画幅，适合教程、Vlog、宣传片。' },
  { value: '9:16', key: '9_16', title: '竖屏 9:16', size: '1080 × 1920', platforms: '抖音、快手、视频号、小红书', note: '手机全屏竖看，适合短视频、口播、探店。' },
  { value: '1:1', key: '1_1', title: '方形 1:1', size: '1080 × 1080', platforms: '朋友圈、微博、Instagram 帖子', note: '信息流里占位大，横竖屏都不吃亏。' },
  { value: '4:3', key: '4_3', title: '经典 4:3', size: '1440 × 1080', platforms: '课程录屏、平板展示', note: '画面更方正，带一点复古质感。' },
  { value: '21:9', key: '21_9', title: '宽银幕 21:9', size: '2560 × 1080', platforms: '电影感短片、片头、预告', note: '超宽电影画幅，氛围感强，适合叙事和风光。' },
];

function AspectGlyph({ aspect }) {
  const [a, b] = aspect.split(':').map(Number);
  const box = 44;
  const k = box / Math.max(a, b);
  const w = Math.round(a * k);
  const h = Math.round(b * k);
  return (
    <span className="np-glyph" style={{ width: box, height: box }}>
      <span className="np-glyph-frame" style={{ width: w, height: h }} />
    </span>
  );
}

function defaultName() {
  const d = new Date();
  return t('newProject.defaultName', {
    month: d.getMonth() + 1,
    day: d.getDate(),
    hh: String(d.getHours()).padStart(2, '0'),
    mm: String(d.getMinutes()).padStart(2, '0'),
  });
}

const FPS_CHOICES = [24, 25, 30, 50, 60];

export default function NewProjectDialog({ onClose }) {
  const locale = useLocale();
  const tr = useT();
  const settings = useStore((s) => s.settings);
  const newProject = useStore((s) => s.newProject);
  const toast = useStore((s) => s.toast);
  const setMode = useStore((s) => s.setMode);
  const [name, setName] = useState(defaultName);
  const [aspect, setAspect] = useState(() => {
    const a = settings && settings.editing && settings.editing.aspect;
    return ASPECT_CHOICES.some((c) => c.value === a) ? a : '16:9';
  });
  const [fps, setFps] = useState(() => {
    const f = Number(settings && settings.editing && settings.editing.fps);
    return Number.isFinite(f) && f >= 12 && f <= 60 ? f : 30;
  });
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { if (inputRef.current) { inputRef.current.focus(); inputRef.current.select(); } }, []);

  const busyRef = useRef(false);
  const create = async (chosen) => {
    if (busyRef.current) return;
    const asp = typeof chosen === 'string' ? chosen : aspect;
    const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60) || tr('app.untitledProject');
    busyRef.current = true;
    setBusy(true);
    try {
      await newProject({ name: n, aspect: asp, fps });
      setMode('create');
      const ai = useStore.getState().aiStatus;
      const provider = String((ai && ai.provider) || '').toLowerCase();
      const aiReady = !!(ai && ai.ready && provider && provider !== 'local' && provider !== 'none');
      if (aiReady) {
        toast(tr('newProject.toastCreatedAi', { name: n }), 'success');
      } else {
        toast(tr('newProject.toastCreatedLocal', { name: n }), 'info', undefined, {
          key: 'new-project-ai',
          action: { label: tr('newProject.connectAi'), run: () => useStore.getState().openDialog('settings', 'ai') },
        });
      }
      if (onClose) onClose();
    } catch (e) {
      toast(tr('newProject.toastFailed', { error: e.message }), 'error');
      busyRef.current = false;
      setBusy(false);
    }
  };

  const current = ASPECT_CHOICES.find((c) => c.value === aspect) || ASPECT_CHOICES[0];
  const curTitle = tr(`newProject.aspect.${current.key}.title`);
  const curPlatforms = tr(`newProject.aspect.${current.key}.platforms`);
  const curNote = tr(`newProject.aspect.${current.key}.note`);

  return (
    <Modal
      title={tr('newProject.title')}
      onClose={busy ? undefined : onClose}
      wide
      className="np-modal"
      footer={(
        <>
          <span className="grow hint">{tr('newProject.footerHint')}</span>
          <Button onClick={onClose} disabled={busy}>{tr('app.cancel')}</Button>
          <Button variant="primary" icon={busy ? undefined : 'plus'} onClick={() => create()} disabled={busy}>
            {busy ? <><Spinner /> {tr('newProject.creating')}</> : tr('newProject.createBtn')}
          </Button>
        </>
      )}
    >
      <Field label={tr('newProject.nameLabel')}>
        <input
          ref={inputRef}
          className="input np-name"
          value={name}
          maxLength={60}
          placeholder={tr('newProject.namePlaceholder')}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } }}
        />
      </Field>
      <div className="field">
        <label>{tr('newProject.aspectLabel')}</label>
        <div className="np-aspects" role="radiogroup" aria-label={tr('newProject.aspectLabel')}>
          {ASPECT_CHOICES.map((c) => (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={aspect === c.value}
              className={'np-aspect' + (aspect === c.value ? ' active' : '')}
              onClick={() => setAspect(c.value)}
              onDoubleClick={() => { setAspect(c.value); create(c.value); }}
              title={tr('newProject.aspectCardTitle')}
              disabled={busy}
            >
              <AspectGlyph aspect={c.value} />
              <span className="np-aspect-title">{tr(`newProject.aspect.${c.key}.title`)}</span>
              <span className="np-aspect-size mono">{c.size}</span>
              <span className="np-aspect-platforms">{tr(`newProject.aspect.${c.key}.platforms`)}</span>
              {aspect === c.value && <span className="np-check" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      </div>
      <div className="callout np-note">
        <b>{curTitle}</b>{locale === 'zh-CN' ? '：' : ': '}{tr('newProject.aspectNote', { note: curNote, platforms: curPlatforms })}
      </div>
      <Field label={tr('newProject.fpsLabel')}>
        <Segmented
          value={fps}
          onChange={setFps}
          options={FPS_CHOICES.map((f) => ({ value: f, label: `${f} fps` }))}
          label={tr('newProject.fpsLabel')}
        />
      </Field>
      <div className="np-source">
        <div className="np-source-head"><Icon name="camera" size={15} /><b>{tr('newProject.sourceTitle')}</b></div>
        <ol className="np-source-list">
          <li><span className="np-src-tag">1</span><span><b>{tr('newProject.source1Title')}</b>{tr('newProject.source1Desc')}</span></li>
          <li><span className="np-src-tag">2</span><span><b>{tr('newProject.source2Title')}</b>{tr('newProject.source2Desc')}</span></li>
          <li><span className="np-src-tag ai">3</span><span><b>{tr('newProject.source3Title')}</b>{tr('newProject.source3Desc')}</span></li>
        </ol>
        <div className="np-source-foot hint">
          {tr('newProject.sourceFoot')}
          <button type="button" className="np-link" onClick={() => useStore.getState().openDialog('settings', 'media')}>{tr('newProject.goSettings')}</button>
        </div>
      </div>
    </Modal>
  );
}
