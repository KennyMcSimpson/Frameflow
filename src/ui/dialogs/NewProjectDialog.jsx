// 新建项目：名称 + 画幅选择（附适用平台说明）+ 画面素材来源说明（真人实拍优先，PLAN-v3 §7）。
import React, { useEffect, useRef, useState } from 'react';
import useStore from '../store.js';
import { Modal, Button, Field, Segmented, Spinner, Icon } from '../components/ui.jsx';

export const ASPECT_CHOICES = [
  { value: '16:9', title: '横屏 16:9', size: '1920 × 1080', platforms: 'B站、YouTube、西瓜视频', note: '电脑和电视观看的标准画幅，适合教程、Vlog、宣传片。' },
  { value: '9:16', title: '竖屏 9:16', size: '1080 × 1920', platforms: '抖音、快手、视频号、小红书', note: '手机全屏竖看，适合短视频、口播、探店。' },
  { value: '1:1', title: '方形 1:1', size: '1080 × 1080', platforms: '朋友圈、微博、Instagram 帖子', note: '信息流里占位大，横竖屏都不吃亏。' },
  { value: '4:3', title: '经典 4:3', size: '1440 × 1080', platforms: '课程录屏、平板展示', note: '画面更方正，带一点复古质感。' },
  { value: '21:9', title: '宽银幕 21:9', size: '2560 × 1080', platforms: '电影感短片、片头、预告', note: '超宽电影画幅，氛围感强，适合叙事和风光。' },
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
  return `新项目 ${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const FPS_CHOICES = [24, 25, 30, 50, 60];

export default function NewProjectDialog({ onClose }) {
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
    const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60) || '未命名项目';
    busyRef.current = true;
    setBusy(true);
    try {
      await newProject({ name: n, aspect: asp, fps });
      setMode('create');
      // 没连接 AI 时不要说「和 AI 导演聊聊」：给出能马上做的事，并提供连接入口
      const ai = useStore.getState().aiStatus;
      const aiReady = !!(ai && ai.ready && (ai.provider === 'codex' || ai.provider === 'openai'));
      if (aiReady) {
        toast(`已创建项目「${n}」，先和 AI 导演聊聊你想拍什么吧`, 'success');
      } else {
        toast(`已创建项目「${n}」。还没连接 AI，可以先导入素材自己剪；连接后 AI 导演能帮你写分镜`, 'info', undefined, {
          key: 'new-project-ai',
          action: { label: '连接 AI', run: () => useStore.getState().openDialog('settings', 'ai') },
        });
      }
      if (onClose) onClose();
    } catch (e) {
      toast('创建项目失败：' + e.message, 'error');
      busyRef.current = false;
      setBusy(false);
    }
  };

  const current = ASPECT_CHOICES.find((c) => c.value === aspect) || ASPECT_CHOICES[0];

  return (
    <Modal
      title="新建项目"
      onClose={busy ? undefined : onClose}
      wide
      className="np-modal"
      footer={(
        <>
          <span className="grow hint">画幅决定 AI 分镜、预演构图和导出尺寸，建议一开始就选好。</span>
          <Button onClick={onClose} disabled={busy}>取消</Button>
          <Button variant="primary" icon={busy ? undefined : 'plus'} onClick={() => create()} disabled={busy}>
            {busy ? <><Spinner /> 正在创建…</> : '创建项目'}
          </Button>
        </>
      )}
    >
      <Field label="项目名称">
        <input
          ref={inputRef}
          className="input np-name"
          value={name}
          maxLength={60}
          placeholder="例如：咖啡店开业宣传"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } }}
        />
      </Field>
      <div className="field">
        <label>画幅比例</label>
        <div className="np-aspects" role="radiogroup" aria-label="画幅比例">
          {ASPECT_CHOICES.map((c) => (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={aspect === c.value}
              className={'np-aspect' + (aspect === c.value ? ' active' : '')}
              onClick={() => setAspect(c.value)}
              onDoubleClick={() => { setAspect(c.value); create(c.value); }}
              title="单击选择，双击直接创建"
              disabled={busy}
            >
              <AspectGlyph aspect={c.value} />
              <span className="np-aspect-title">{c.title}</span>
              <span className="np-aspect-size mono">{c.size}</span>
              <span className="np-aspect-platforms">{c.platforms}</span>
              {aspect === c.value && <span className="np-check" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      </div>
      <div className="callout np-note">
        <b>{current.title}</b>：{current.note} 常用于 {current.platforms}。
      </div>
      <Field label="帧率">
        <Segmented
          value={fps}
          onChange={setFps}
          options={FPS_CHOICES.map((f) => ({ value: f, label: `${f} fps` }))}
          label="帧率"
        />
      </Field>
      <div className="np-source">
        <div className="np-source-head"><Icon name="camera" size={15} /><b>画面从哪里来？</b></div>
        <ol className="np-source-list">
          <li><span className="np-src-tag">1</span><span><b>你自己拍的视频</b>：导入后自动对应到分镜，效果最好。</span></li>
          <li><span className="np-src-tag">2</span><span><b>真人实拍素材库</b>：没拍的镜头自动从 Pexels / Pixabay 搜索可商用实拍视频。</span></li>
          <li><span className="np-src-tag ai">3</span><span><b>AI 视频生成</b>：配置视频生成服务后，可按分镜生成写实画面。</span></li>
        </ol>
        <div className="np-source-foot hint">
          动画预演只用于占位，导出时会带「示意」水印。实拍素材来自免费的公共素材库，不用填任何 Key。
          <button type="button" className="np-link" onClick={() => useStore.getState().openDialog('settings', 'media')}>去设置</button>
        </div>
      </div>
    </Modal>
  );
}
