// 检查器 · 无选择时：项目设置、全片一致性检查、风格指南与 AI 记忆。
import React, { useMemo, useState } from 'react';
import useStore from '../../store.js';
import { Button, Chip, Icon, Select, fmtTime } from '../../components/ui.jsx';
import { ASPECTS, isCaptionText } from '../../../engine/model.js';
import { layoutVideo, projectDuration } from '../../../engine/timeline.js';
import { consistencyReport, harmonizeOps } from '../../../engine/consistency.js';
import { InspSection, InspRow, TextDraft, ColorField, ChoiceGrid, useLiveEdit, T_NONE, PRESETS } from './InspCommon.jsx';

const FALLBACK_PRESETS = [
  { id: 'douyin', label: '抖音/快手 1080×1920 30fps', w: 1080, h: 1920, fps: 30 },
  { id: 'bilibili', label: 'B站 1080p60', w: 1920, h: 1080, fps: 60 },
  { id: 'shipinhao', label: '视频号 1080×1350', w: 1080, h: 1350, fps: 30 },
  { id: 'youtube4k', label: 'YouTube 4K', w: 3840, h: 2160, fps: 30 },
  { id: 'custom', label: '自定义' },
];
const ratioKey = (w, h) => { const r = w / h; const all = Object.entries(ASPECTS); let best = null; let bd = 9; for (const [k, a] of all) { const ar = (a.width || 16) / (a.height || 9); if (Math.abs(ar - r) < bd) { bd = Math.abs(ar - r); best = k; } } return bd < 0.03 ? best : null; };
import { ensureAssetStats } from './SideData.js';

const FPS_OPTIONS = [24, 25, 30, 50, 60].map((v) => ({ value: String(v), label: `${v} 帧/秒` }));
const STAT_KINDS = new Set(['video', 'image', 'generated-image']);

function fmtWhen(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function InspProject() {
  const project = useStore((s) => s.project);
  const live = useLiveEdit(project.id);
  const [working, setWorking] = useState(null);
  const settings = project.settings;
  const video = project.tracks.video;
  const memory = project.memory || { styleGuide: '', decisions: [], colorBaseline: null };
  const decisions = Array.isArray(memory.decisions) ? memory.decisions : [];

  const layout = useMemo(() => { try { return layoutVideo(project) || []; } catch { return []; } }, [project.tracks.video]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = useMemo(() => { try { return projectDuration(project, layout) || 0; } catch { return 0; } }, [project.tracks, layout]); // eslint-disable-line react-hooks/exhaustive-deps
  const report = useMemo(() => {
    try { return consistencyReport(project) || []; } catch { return []; }
  }, [project.tracks.video, project.assets]); // eslint-disable-line react-hooks/exhaustive-deps
  const missingStats = useMemo(() => {
    const seen = new Set();
    for (const c of video) {
      const a = project.assets[c.assetId];
      if (a && !a.stats && a.path && STAT_KINDS.has(a.kind)) seen.add(a.id);
    }
    return seen.size;
  }, [video, project.assets]);

  const setBackground = (background) => (p) => ({ ...p, settings: { ...p.settings, background } });

  const jumpTo = (index) => {
    const st = useStore.getState();
    const clip = st.project.tracks.video[index];
    if (!clip) return;
    st.select([clip.id]);
    const item = layout[index];
    if (item) st.setPlayhead(item.start);
  };

  async function analyze() {
    setWorking('analyze');
    try {
      const r = await ensureAssetStats();
      const st = useStore.getState();
      if (r.filled) st.toast(`已补全 ${r.filled} 个素材的色彩分析`, 'ok');
      else if (r.missing) st.toast('色彩分析失败，请确认素材文件还在', 'error');
    } finally { setWorking(null); }
  }

  async function harmonizeAll() {
    setWorking('harmonize');
    try {
      await ensureAssetStats();
      const st = useStore.getState();
      let ops = [];
      try { ops = harmonizeOps(st.project, undefined, 0.6) || []; } catch (e) { st.toast('统一色调失败：' + e.message, 'error'); return; }
      if (!ops.length) { st.toast('没有可调整的镜头：需要带色彩统计的真实素材（AI 预演镜头不参与）', 'warn'); return; }
      const r = st.commit(ops, '一键统一全片色调');
      if (r.ok) st.toast('已统一全片色调，可以用 Ctrl+Z 撤销', 'ok');
    } finally { setWorking(null); }
  }

  const removeDecision = (i) => {
    useStore.getState().update((p) => {
      const mem = p.memory || {};
      return { ...p, memory: { ...mem, decisions: (mem.decisions || []).filter((_, k) => k !== i) } };
    });
  };

  const palette = memory.colorBaseline && Array.isArray(memory.colorBaseline.palette) ? memory.colorBaseline.palette : [];

  return (
    <div className="insp">
      <div className="insp-head">
        <div className="insp-head-icon"><Icon name="settings" size={18} /></div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="insp-head-title ellipsis">项目设置</div>
          <div className="xs muted">未选中任何内容 · 点选时间线上的片段、文字或音频查看它的属性</div>
        </div>
      </div>

      <InspSection id="project-settings" title="画面" icon="film">
        <InspRow label="画幅">
          <Select
            value={settings.aspect}
            options={Object.entries(ASPECTS).map(([value, a]) => ({ value, label: a.label }))}
            onChange={(aspect) => live.commit([{ type: 'setProject', target: T_NONE, settings: { aspect } }], '修改画幅')}
          />
        </InspRow>
        <InspRow label="背景色" hint="画面未填满时露出的颜色">
          <ColorField value={settings.background} onPreview={(c) => live.preview(setBackground(c))} onCommit={(c) => live.commit(setBackground(c), '修改背景色')} />
        </InspRow>
        <InspRow label="帧率">
          <Select
            value={String(settings.fps)}
            options={FPS_OPTIONS.some((o) => o.value === String(settings.fps)) ? FPS_OPTIONS : [{ value: String(settings.fps), label: `${settings.fps} 帧/秒` }, ...FPS_OPTIONS]}
            onChange={(v) => live.commit((p) => ({ ...p, settings: { ...p.settings, fps: Number(v) } }), '修改帧率')}
          />
        </InspRow>
        <div className="insp-kv">
          <span>输出尺寸</span><span className="mono">{settings.width} × {settings.height}</span>
          <span>总时长</span><span className="mono">{fmtTime(total)}</span>
          <span>轨道内容</span><span>{video.length} 镜 · {project.tracks.text.length} 文字 · {project.tracks.audio.length} 音频</span>
        </div>
      </InspSection>

      <button type="button" className="insp-cta" onClick={() => { const st = useStore.getState(); useStore.setState({ selection: { ...st.selection, clipIds: [], textId: null, audioId: null, kind: 'caption', id: null } }); }}>
        <Icon name="text" size={16} />
        <span className="grow"><b>字幕</b><small>{project.tracks.text.filter(isCaptionText).length ? `已有 ${project.tracks.text.filter(isCaptionText).length} 句 · 编辑 / 导出 SRT` : '自动识别人声生成字幕'}</small></span>
        <Icon name="chevronRight" size={14} />
      </button>

      <InspSection id="project-export" title="导出预设" icon="upload" badge={project.exportPreset ? null : '未设置'}>
        <ChoiceGrid cols={2}
          value={project.exportPreset || ''}
          options={(PRESETS.EXPORT_PRESETS || FALLBACK_PRESETS).filter((p) => p.id !== 'audio-mp3' && p.id !== 'gif').map((p) => ({ value: p.id, label: p.label || p.id }))}
          onPick={(id) => {
            const pr = (PRESETS.EXPORT_PRESETS || FALLBACK_PRESETS).find((p) => p.id === id) || {};
            const aspect = pr.w && pr.h ? ratioKey(pr.w, pr.h) : null;
            live.commit((p) => {
              const aspectObj = aspect && ASPECTS[aspect] ? ASPECTS[aspect] : null;
              return {
                ...p,
                exportPreset: id,
                settings: {
                  ...p.settings,
                  ...(pr.fps ? { fps: pr.fps } : {}),
                  ...(aspectObj ? { aspect, width: aspectObj.width, height: aspectObj.height } : {}),
                },
              };
            }, '导出预设：' + (pr.label || id));
          }} />
        <div className="hint">选择发布平台后会同步画幅与帧率；导出时默认使用此预设。</div>
      </InspSection>

      <InspSection
        id="project-consistency"
        title="全片一致性检查"
        icon="eye"
        badge={report.length ? `${report.length} 项` : null}
      >
        {!video.length ? (
          <div className="hint">时间线上还没有镜头。</div>
        ) : (
          <>
            {missingStats > 0 && (
              <div className="insp-note">
                <span className="grow">{missingStats} 个素材还没有色彩分析，检查结果可能不完整。</span>
                <Button size="sm" onClick={analyze} disabled={!!working}>{working === 'analyze' ? '分析中…' : '补全分析'}</Button>
              </div>
            )}
            {report.length === 0 ? (
              <div className="insp-allgood"><Icon name="check" size={13} />没有发现明显的色彩或亮度跳变。</div>
            ) : (
              <ul className="insp-report">
                {report.map((r, i) => (
                  <li key={i}>
                    <button type="button" className="insp-report-item" onClick={() => jumpTo(r.index)} title="跳到这一镜并选中">
                      <Chip kind={r.severity === 'warn' ? 'warn' : 'info'}>第{r.index + 1}镜</Chip>
                      <span className="grow">{r.issue}</span>
                      <Icon name="chevronRight" size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <Button size="sm" variant="ai" className="insp-wide" icon="wand" onClick={harmonizeAll} disabled={!!working}>
              {working === 'harmonize' ? '正在统一…' : '一键统一色调'}
            </Button>
          </>
        )}
      </InspSection>

      <InspSection id="project-memory" title="风格指南与 AI 记忆" icon="brain" badge={decisions.length ? `${decisions.length} 条` : null}>
        <div className="insp-subtitle first">风格指南</div>
        <TextDraft
          value={memory.styleGuide}
          rows={4}
          maxLength={4000}
          placeholder="比如：温暖胶片感、节奏舒缓、字幕用白色小字。AI 每次修改都会遵守这里的约定。"
          onCommit={(styleGuide) => useStore.getState().update((p) => ({ ...p, memory: { ...(p.memory || {}), styleGuide } }))}
        />
        {palette.length > 0 && (
          <>
            <div className="insp-subtitle">全片色彩基准</div>
            <div className="insp-palette">{palette.map((c, i) => <span key={i} style={{ background: c }} title={c} />)}</div>
          </>
        )}
        <div className="insp-subtitle">AI 记住的决定</div>
        {!decisions.length ? (
          <div className="hint">还没有记录。AI 做出影响全片的决定时会记在这里，之后的修改都会参考。</div>
        ) : (
          <ul className="insp-decisions">
            {decisions.map((d, i) => (
              <li key={i}>
                <div className="grow selectable">
                  <div className="small">{(d && d.text) || String(d)}</div>
                  {d && d.at && <div className="xs muted">{fmtWhen(d.at)}</div>}
                </div>
                <Button size="sm" variant="ghost" icon="close" title="删除这条记忆" onClick={() => removeDecision(i)} />
              </li>
            ))}
          </ul>
        )}
      </InspSection>
    </div>
  );
}
