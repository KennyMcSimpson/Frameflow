// 首次引导（PLAN-v3 §6）：遮罩高亮 data-tour 目标 + 一句话说明 + 下一步/跳过。
// 用法：<Coachmark mode="refine" steps={[{ target: '[data-tour=refine-media]', title, desc }]} />
// 完成或跳过后写入 store.onboarding[mode]（持久化到 settings.ui），帮助里可「重新引导」。
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import useStore from '../store.js';
import { Button } from './ui.jsx';

/** 各模式默认引导步骤（App 统一挂载；目标不存在的步骤自动跳过） */
export const DEFAULT_TOURS = {
  create: [
    { target: '[data-tour=create-chat]', title: '先和 AI 导演聊想法', desc: '用一句话描述你想拍的视频，AI 会帮你拆成分镜，并匹配真人实拍素材。' },
    { target: '[data-tour=create-generate]', title: '一键生成全部画面', desc: '分镜确定后点这里，为每个镜头找实拍素材或调用 AI 视频生成。' },
    { target: '[data-tour=create-go-refine]', title: '进入剪辑', desc: '画面就绪后点这里进入剪辑，在时间线上调整片段、加字幕和音乐。' },
  ],
  refine: [
    { target: '[data-tour=refine-media]', title: '素材区', desc: '导入的视频、图片、音乐都在这里，拖到下方时间线即可使用。' },
    { target: '[data-tour=refine-timeline]', title: '时间线', desc: '空格播放，S 分割，Q/W 修剪到播放头，Delete 删除；拖动边缘调整长度。' },
    { target: '[data-tour=refine-inspector]', title: '属性区', desc: '选中片段后在这里调画面、变速、调色、音量，◆ 按钮可打关键帧。' },
    { target: '[data-tour=export]', title: '完成后导出', desc: '选择抖音、B站等预设，一键导出成片。' },
  ],
  library: [
    { target: '[data-tour=library-add]', title: '添加一个要学习的视频', desc: '粘贴链接或导入本地视频，AI 会拆解镜头、节奏和技法，供创作时复用。' },
  ],
};

function findTarget(sel) {
  if (!sel || typeof document === 'undefined') return null;
  try {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return el;
  } catch { return null; }
}

const PAD = 6;
const CARD_W = 300;
const EMPTY_STEPS = [];

export default function Coachmark({ mode, steps, force = false, onDone }) {
  const done = useStore((s) => !!(s.onboarding && s.onboarding[mode]));
  const anyDialog = useStore((s) => Object.values(s.dialogs || {}).some(Boolean));
  const setOnboarding = useStore((s) => s.setOnboarding);
  const list = steps || DEFAULT_TOURS[mode] || EMPTY_STEPS;
  const [idx, setIdx] = useState(0);
  const [rect, setRect] = useState(null);
  const [ready, setReady] = useState(false);
  const cardRef = useRef(null);
  const [cardH, setCardH] = useState(140);

  const active = (force || !done) && list.length > 0 && !anyDialog;

  useEffect(() => { setIdx(0); setReady(false); }, [mode]);

  // 等待界面渲染出目标（模式是懒加载的），最长 6 秒
  useEffect(() => {
    if (!active) return undefined;
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      if (list.some((s) => findTarget(s.target)) || n > 30) { setReady(true); clearInterval(timer); }
    }, 200);
    return () => clearInterval(timer);
  }, [active, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const finish = useCallback(() => {
    setOnboarding(mode, true);
    if (onDone) onDone();
  }, [mode, onDone, setOnboarding]);

  // 当前步骤目标缺失则跳到下一个存在的
  const step = list[idx];
  useLayoutEffect(() => {
    if (!active || !ready) return undefined;
    const measure = () => {
      const el = step && findTarget(step.target);
      if (!el) { setRect(null); return; }
      const r = el.getBoundingClientRect();
      setRect({ x: r.left, y: r.top, w: r.width, h: r.height });
    };
    if (step && !findTarget(step.target)) {
      const next = list.findIndex((s, i) => i > idx && findTarget(s.target));
      if (next >= 0) setIdx(next);
      else if (!list.some((s) => findTarget(s.target))) { setRect(null); }
      else setRect(null);
    }
    measure();
    window.addEventListener('resize', measure);
    const t = setInterval(measure, 500);
    return () => { window.removeEventListener('resize', measure); clearInterval(t); };
  }, [active, ready, idx, step]); // eslint-disable-line react-hooks/exhaustive-deps

  const next = useCallback(() => {
    const after = list.findIndex((s, i) => i > idx && findTarget(s.target));
    if (after >= 0) setIdx(after); else finish();
  }, [list, idx, finish]);

  useLayoutEffect(() => {
    if (cardRef.current) {
      const h = cardRef.current.offsetHeight;
      if (h) setCardH((prev) => (prev === h ? prev : h));
    }
  }, [active, ready, idx, step]);

  useEffect(() => {
    if (!active || !ready) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(); }
      if (e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); next(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, ready, finish, next]);

  const visible = list.map((s, i) => ({ s, i })).filter(({ s }) => findTarget(s.target));
  const pos = visible.findIndex((v) => v.i === idx);

  if (!active || !ready || typeof document === 'undefined') return null;
  if (!visible.length) return null; // 目标都不在：不打扰，下次再显示
  if (!step) return null;

  const vw = window.innerWidth; const vh = window.innerHeight;
  let cardStyle;
  if (rect) {
    const below = rect.y + rect.h + PAD + 12;
    const above = rect.y - PAD - 12 - cardH;
    const right = rect.x + rect.w + PAD + 12;
    let left; let top;
    if (below + cardH < vh - 8) { top = below; left = rect.x + rect.w / 2 - CARD_W / 2; }
    else if (above > 8) { top = above; left = rect.x + rect.w / 2 - CARD_W / 2; }
    else if (right + CARD_W < vw - 8) { left = right; top = rect.y + rect.h / 2 - cardH / 2; }
    else { left = rect.x - PAD - 12 - CARD_W; top = rect.y + rect.h / 2 - cardH / 2; }
    cardStyle = { left: Math.max(8, Math.min(vw - CARD_W - 8, left)), top: Math.max(8, Math.min(vh - cardH - 8, top)), width: CARD_W };
  } else {
    cardStyle = { left: vw / 2 - CARD_W / 2, top: vh / 2 - cardH / 2, width: CARD_W };
  }
  const isLast = pos === visible.length - 1;

  return createPortal(
    <div className="coach-root" data-coach={mode}>
      {rect
        ? <div className="coach-spot" style={{ left: rect.x - PAD, top: rect.y - PAD, width: rect.w + PAD * 2, height: rect.h + PAD * 2 }} />
        : <div className="coach-dim" />}
      <div className="coach-block" onMouseDown={(e) => e.preventDefault()} />
      <div className="coach-card" ref={cardRef} style={cardStyle} role="dialog" aria-label={step.title}>
        <div className="coach-step mono">{pos + 1} / {visible.length}</div>
        <h4>{step.title}</h4>
        {step.desc && <p>{step.desc}</p>}
        <div className="coach-actions">
          <Button variant="ghost" size="sm" onClick={finish} className="coach-skip">跳过引导</Button>
          <span className="grow" />
          <Button variant="secondary" size="sm" onClick={next} className="coach-next" autoFocus>{isLast ? '开始使用' : '下一步'}</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
