// 精修 · 属性面板：没有页签，按当前选中对象自动切换内容。
//   视频片段/画中画 → 画面·变速·动画·调节·音频；文字 → 文本·动画；字幕 → 字幕面板；音频 → 基础·处理；未选中 → 项目。
import React, { useMemo } from 'react';
import useStore from '../../store.js';
import { Empty } from '../../components/ui.jsx';
import InspClip from './InspClip.jsx';
import { InspText, InspAudioTrack } from './InspTextAudio.jsx';
import InspProject from './InspProject.jsx';
import CaptionPanel from './CaptionPanel.jsx';

function resolve(project, sel) {
  if (!project) return { kind: 'none' };
  const kind = sel.kind;
  const selId = sel.id || sel.overlayId;

  const ids = new Set(sel.clipIds || []);
  if (ids.size) {
    const clips = []; const indices = [];
    project.tracks.video.forEach((c, i) => { if (ids.has(c.id)) { clips.push(c); indices.push(i); } });
    if (clips.length) return { kind: 'clip', clips, indices };
  }
  if (kind === 'overlay' && selId) {
    const o = (project.overlays || []).find((x) => x.id === selId);
    if (o) return { kind: 'overlay', item: o };
  }
  if (sel.textId) {
    const t = project.tracks.text.find((x) => x.id === sel.textId);
    if (t) return t.group === 'caption' ? { kind: 'caption', id: t.id } : { kind: 'text', item: t };
  }
  if (sel.audioId) {
    const a = project.tracks.audio.find((x) => x.id === sel.audioId);
    if (a) return { kind: 'audio', item: a };
  }
  if (kind === 'caption') return { kind: 'caption', id: selId };
  return { kind: 'project' };
}

export default function Inspector() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const r = useMemo(() => resolve(project, selection || {}), [project, selection]);

  let body;
  if (!project) body = <Empty icon="sliders" title="没有打开的项目" />;
  else if (r.kind === 'clip') body = <InspClip key={'c:' + r.clips.map((c) => c.id).join(',')} clips={r.clips} indices={r.indices} />;
  else if (r.kind === 'overlay') body = <InspClip key={'o:' + r.item.id} clips={[r.item]} indices={[]} target="overlay" />;
  else if (r.kind === 'text') body = <InspText key={r.item.id} text={r.item} />;
  else if (r.kind === 'caption') body = <CaptionPanel focusId={r.id} />;
  else if (r.kind === 'audio') body = <InspAudioTrack key={r.item.id} audio={r.item} />;
  else body = <InspProject />;

  return (
    <div className={'rf-insp kind-' + r.kind} data-tour="refine-inspector">
      {body}
    </div>
  );
}
