// 「添加拆片」卡：URL（支持分享文本）/ 本地视频、分类、AI 开关、最长秒数；以及 yt-dlp 安装提示。
import React, { useMemo, useState } from 'react';
import api from '../../api.js';
import useStore from '../../store.js';
import { Button, Select, Switch, ProgressBar, Icon, Chip } from '../../components/ui.jsx';
import { ANALYSIS_CATEGORIES, ANALYSIS_CATEGORY_LABELS } from '../../../engine/model.js';
import useLibrary from './libraryActions.js';
import { extractUrls, PLATFORM_LABELS } from './libraryUtils.js';

export const CATEGORY_OPTIONS = ANALYSIS_CATEGORIES.map((c) => ({ value: c, label: ANALYSIS_CATEGORY_LABELS[c] || c }));
export const MAX_SECONDS_OPTIONS = [
  { value: '60', label: '前 1 分钟' },
  { value: '180', label: '前 3 分钟' },
  { value: '300', label: '前 5 分钟' },
  { value: '600', label: '前 10 分钟（推荐）' },
  { value: '1200', label: '前 20 分钟' },
  { value: '1800', label: '前 30 分钟' },
];

const VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'wmv', 'flv', 'ts', 'mts', 'm2ts', '3gp'];

/** AI 是否可用于标注 */
export function useAIReady() {
  const ai = useStore((s) => s.aiStatus);
  return { known: !!ai, ready: !!(ai && ai.ready && ai.provider !== 'local'), detail: ai && ai.detail };
}

/** yt-dlp 未安装时的提示 + 一键安装 */
export function YtdlpNotice({ compact = false }) {
  const yt = useLibrary((s) => s.ytdlp);
  const inst = useLibrary((s) => s.ytdlpInstall);
  if (!yt.checked || yt.installed) return null;
  return (
    <div className="callout warn lib-ytdlp">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <Icon name="download" size={14} style={{ marginTop: 2, color: 'var(--warn)' }} />
        <div className="grow">
          <b>需要下载组件 yt-dlp</b>
          {!compact && <div>从网页链接拆片、联网搜索视频都依赖它（约 15 MB，只需安装一次）。</div>}
        </div>
      </div>
      {inst.running ? (
        <div style={{ marginTop: 8 }}>
          <ProgressBar value={inst.progress} indeterminate={!inst.progress} />
          <div className="row" style={{ marginTop: 6 }}>
            <span className="xs muted grow ellipsis">{inst.message || '下载中…'} {inst.progress ? `${Math.round(inst.progress * 100)}%` : ''}</span>
            <Button size="sm" variant="ghost" onClick={() => useLibrary.getState().cancelYtdlpInstall()}>取消</Button>
          </div>
        </div>
      ) : (
        <div className="row" style={{ marginTop: 8 }}>
          <Button size="sm" variant="primary" icon="download" onClick={() => useLibrary.getState().installYtdlp()}>一键安装</Button>
          {inst.error && <span className="xs grow" style={{ color: 'var(--danger)' }}>{inst.error}</span>}
        </div>
      )}
    </div>
  );
}

/** 选择本地视频（可多选）并加入拆片队列，返回加入数量 */
export async function pickLocalVideos() {
  const toast = useStore.getState().toast;
  try {
    const paths = await api.call('dialog:openFiles', {
      title: '选择要拆片的视频（可多选）',
      multi: true,
      filters: [{ name: '视频文件', extensions: VIDEO_EXTS }],
    });
    if (!paths || !paths.length) return 0;
    const n = useLibrary.getState().enqueue(paths.map((p) => ({ path: p })));
    if (n) toast(`已加入 ${n} 个本地视频`, 'ok');
    else toast('这些视频已经在队列中', 'info');
    return n;
  } catch (e) {
    toast('选择文件失败：' + e.message, 'error');
    return 0;
  }
}

export default function AddPanel({ onDone }) {
  const options = useLibrary((s) => s.options);
  const yt = useLibrary((s) => s.ytdlp);
  const ai = useAIReady();
  const [text, setText] = useState('');
  const [picking, setPicking] = useState(false);
  const parsed = useMemo(() => extractUrls(text), [text]);
  const setOptions = useLibrary.getState().setOptions;
  const toast = useStore.getState().toast;

  const startUrls = () => {
    if (!parsed.length) {
      toast(text.trim() ? '没有识别到视频链接，请粘贴完整的网址或分享文本' : '请先粘贴视频链接', 'warn');
      return;
    }
    const n = useLibrary.getState().enqueue(parsed.map((p) => ({ url: p.url, title: p.title || undefined })));
    if (n) {
      setText('');
      if (onDone) onDone();
      toast(`已加入 ${n} 个拆片任务${yt.checked && !yt.installed ? '，请先安装下载组件' : ''}`, 'ok');
    } else {
      toast('这些链接已经在队列中', 'info');
    }
  };

  const pickFiles = async () => {
    setPicking(true);
    const n = await pickLocalVideos();
    setPicking(false);
    if (n && onDone) onDone();
  };

  return (
    <div className="lib-add">
      <div className="field">
        <label>视频链接（每行一个，可直接粘贴分享文本）</label>
        <textarea
          className="textarea lib-url-input"
          rows={3}
          placeholder={'https://www.bilibili.com/video/BV…\nhttps://youtu.be/…\n或抖音 / B站 的「复制链接」分享文本'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); startUrls(); } }}
          spellCheck={false}
        />
        {text.trim() && (
          <div className="lib-parsed">
            {parsed.length ? (
              <>
                <span className="xs muted">识别到 {parsed.length} 个链接：</span>
                {parsed.slice(0, 6).map((p) => (
                  <Chip key={p.url} kind="info" title={p.url}>{PLATFORM_LABELS[p.platform] || '网页'}{p.title ? ` · ${p.title.slice(0, 14)}` : ''}</Chip>
                ))}
                {parsed.length > 6 && <span className="xs muted">等</span>}
              </>
            ) : <span className="xs" style={{ color: 'var(--warn)' }}>没有识别到链接</span>}
          </div>
        )}
      </div>

      <div className="lib-add-grid">
        <div className="field">
          <label>视频类型</label>
          <Select value={options.category} onChange={(v) => setOptions({ category: v })} options={CATEGORY_OPTIONS} />
        </div>
        <div className="field">
          <label>最长分析</label>
          <Select value={String(options.maxSeconds)} onChange={(v) => setOptions({ maxSeconds: Number(v) })} options={MAX_SECONDS_OPTIONS} />
        </div>
      </div>

      <div className="lib-ai-toggle">
        <Switch checked={options.useAI} onChange={(v) => setOptions({ useAI: v })} title="用 AI 看关键帧标注" />
        <div className="grow">
          <div className="small">用 AI 看关键帧标注</div>
          <div className="xs muted">
            {!options.useAI
              ? '只做本地统计（镜头、节奏、色彩、响度），技法卡由统计推断'
              : ai.ready ? '标注景别、角度、运镜、光线、转场与用途' : 'AI 未就绪，将用本地统计生成技法卡'}
          </div>
        </div>
      </div>

      {parsed.length > 0 && <YtdlpNotice compact />}

      <div className="row" style={{ marginTop: 10 }}>
        <Button variant="primary" icon="scissors" data-tour="library-start" className="grow" onClick={startUrls} disabled={!text.trim()} title="开始拆片（Ctrl+Enter）">开始拆片</Button>
        <Button icon="folder" onClick={pickFiles} disabled={picking}>{picking ? '选择中…' : '选择本地视频'}</Button>
      </div>
    </div>
  );
}
