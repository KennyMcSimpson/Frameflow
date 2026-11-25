// 精修 · 属性面板：没有页签，按当前选中对象自动切换内容。
//   视频片段/画中画 → 画面·变速·动画·调节·音频；文字 → 文本·动画；字幕 → 字幕面板；音频 → 基础·处理；未选中 → 项目。
import React, { useMemo } from 'react';
import useStore from '../../store.js';
import { Button, Empty, Icon, fmtTime } from '../../components/ui.jsx';
import { MARKER_COLORS, LIMITS } from '../../../engine/model.js';
import { InspSection, InspRow, TextDraft, ColorField, NumField, runOp } from './InspCommon.jsx';
import { seek, pause } from './usePlayback.js';
import InspClip from './InspClip.jsx';
import { InspText, InspAudioTrack } from './InspTextAudio.jsx';
import InspProject from './InspProject.jsx';
import CaptionPanel from './CaptionPanel.jsx';

function InspMarker({ marker }) {
  const color = marker.color || MARKER_COLORS[0];
  const update = (patch, label) => runOp(
    { type: 'updateMarker', id: marker.id, patch },
    label,
    {
      fallback: (p) => ({
        ...p,
        markers: (p.markers || []).map((m) => (m.id === marker.id ? { ...m, ...patch } : m)).sort((a, b) => a.t - b.t),
      }),
    },
  );
  const remove = () => {
    const r = runOp(
      { type: 'removeMarker', id: marker.id },
      '删除标记',
      { fallback: (p) => ({ ...p, markers: (p.markers || []).filter((m) => m.id !== marker.id) }) },
    );
    if (r && r.ok) useStore.getState().clearSelection();
  };
  return (
    <div className="insp">
      <div className="insp-head">
        <div className="insp-head-icon"><Icon name="marker" size={18} style={{ color }} /></div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="insp-head-title ellipsis">标记 · {marker.label || '未命名'}</div>
          <div className="xs muted mono">{fmtTime(marker.t)}</div>
        </div>
        <Button size="sm" variant="ghost" icon="trash" title="删除标记" onClick={remove} />
      </div>
      <InspSection id="mk-basic" title="标记属性" icon="marker">
        <InspRow label="名称">
          <TextDraft
            value={marker.label || ''}
            multiline={false}
            maxLength={60}
            placeholder="输入标记名称（如：副歌、卡点）"
            onCommit={(label) => update({ label }, '修改标记名称')}
          />
        </InspRow>
        <InspRow label="颜色">
          <ColorField
            value={color}
            swatches={MARKER_COLORS}
            label="标记颜色"
            onCommit={(nextColor) => update({ color: nextColor }, '修改标记颜色')}
          />
        </InspRow>
        <InspRow label="时间">
          <NumField
            value={marker.t}
            min={0}
            max={LIMITS.maxDuration}
            step={0.1}
            suffix="秒"
            label="标记时间"
            onCommit={(t) => update({ t }, '移动标记')}
          />
        </InspRow>
        <Button size="sm" variant="ghost" className="insp-wide" icon="skipBack" onClick={() => { pause(); seek(Number(marker.t) || 0); }}>
          播放头跳到此处
        </Button>
        <Button size="sm" variant="danger" className="insp-wide" icon="trash" onClick={remove}>
          删除标记
        </Button>
      </InspSection>
    </div>
  );
}

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
  if (kind === 'marker' && selId) {
    const m = (project.markers || []).find((x) => x.id === selId);
    if (m) return { kind: 'marker', item: m };
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
  else if (r.kind === 'marker') body = <InspMarker key={'m:' + r.item.id} marker={r.item} />;
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
