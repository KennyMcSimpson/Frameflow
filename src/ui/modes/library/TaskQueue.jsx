// 拆片任务队列：串行执行，每项显示阶段 / 进度 / 取消 / 失败重试。
import React from 'react';
import { Button, ProgressBar, Icon, Spinner } from '../../components/ui.jsx';
import { ANALYSIS_CATEGORY_LABELS } from '../../../engine/model.js';
import useLibrary, { QUEUE_ACTIVE } from './libraryActions.js';
import { YtdlpNotice } from './AddPanel.jsx';
import { PLATFORM_LABELS } from './libraryUtils.js';

const STATUS_TEXT = {
  waiting: '排队中', running: '分析中', ai: 'AI 标注中', saving: '保存中', done: '完成', error: '失败', cancelled: '已取消',
};

function QueueItem({ q, position }) {
  const lib = useLibrary.getState();
  const active = QUEUE_ACTIVE.includes(q.status);
  const icon = q.status === 'done' ? 'check' : q.status === 'error' ? 'close' : q.status === 'cancelled' ? 'stop' : q.kind === 'url' ? 'globe' : 'film';
  return (
    <div className={'lib-q-item ' + q.status}>
      <div className="row" style={{ gap: 6 }}>
        {active ? <Spinner ai={q.status === 'ai'} /> : <Icon name={icon} size={13} className="lib-q-icon" />}
        <span className="lib-q-title grow ellipsis" title={q.url || q.path || q.title}>{q.title}</span>
        {(q.status === 'running' || q.status === 'ai') && (
          <Button size="sm" variant="ghost" disabled={q.cancelRequested || q.skipAIRequested} onClick={() => lib.cancelItem(q.id)} title={q.status === 'ai' ? '停止 AI 标注，改用本地统计生成技法卡' : '取消这个任务'}>
            {q.status === 'ai' ? '跳过 AI' : '取消'}
          </Button>
        )}
        {q.status === 'waiting' && <Button size="sm" variant="ghost" icon="close" title="移出队列" onClick={() => lib.removeItem(q.id)} />}
        {(q.status === 'error' || q.status === 'cancelled') && (
          <>
            {!q.needsYtdlp && <Button size="sm" variant="ghost" icon="refresh" title="重试" onClick={() => lib.retryItem(q.id)} />}
            <Button size="sm" variant="ghost" icon="close" title="移除" onClick={() => lib.removeItem(q.id)} />
          </>
        )}
        {q.status === 'done' && q.analysisId && (
          <Button size="sm" variant="ghost" title="查看分析结果" onClick={() => lib.selectAnalysis(q.analysisId)}>查看</Button>
        )}
      </div>
      <div className="lib-q-meta xs muted">
        <span>{q.kind === 'url' ? (PLATFORM_LABELS[q.platform] || '网页') : '本地'}</span>
        <span>·</span>
        <span>{ANALYSIS_CATEGORY_LABELS[q.category] || '其他'}</span>
        {q.useAI && <><span>·</span><span>AI 标注</span></>}
        <span className="grow" />
        <span className={'lib-q-stage ' + q.status}>
          {q.status === 'waiting' ? `排队第 ${position} 位` : (active ? q.stage || STATUS_TEXT[q.status] : STATUS_TEXT[q.status])}
        </span>
      </div>
      {active && (
        <>
          {/* AI 阶段没有可靠的百分比：用不定进度条 + 「已用时」文字 */}
          <ProgressBar value={q.progress} ai={q.status === 'ai'} indeterminate={q.status === 'ai' || !q.progress} />
          {q.message && <div className="lib-q-msg xs muted ellipsis" title={q.message}>{q.message}</div>}
        </>
      )}
      {q.status === 'error' && q.error && <div className="lib-q-err xs selectable">{q.error}</div>}
      {q.status === 'done' && q.notice && <div className="lib-q-notice xs">{q.notice}</div>}
    </div>
  );
}

export default function TaskQueue() {
  const queue = useLibrary((s) => s.queue);
  if (!queue.length) return null;
  const waiting = queue.filter((q) => q.status === 'waiting');
  const activeCount = queue.filter((q) => QUEUE_ACTIVE.includes(q.status)).length;
  const finished = queue.filter((q) => q.status === 'done' || q.status === 'cancelled').length;
  const needsYtdlp = queue.some((q) => q.needsYtdlp && q.status === 'error');
  return (
    <div className="lib-queue">
      <div className="lib-section-head">
        <span className="lib-section-title">任务队列</span>
        <span className="xs muted">{activeCount ? '进行中 1 个' : '空闲'}{waiting.length ? ` · 等待 ${waiting.length} 个` : ''}</span>
        <span className="grow" />
        {finished > 0 && <Button size="sm" variant="ghost" onClick={() => useLibrary.getState().clearFinished()}>清除已完成</Button>}
      </div>
      <div className="hint" style={{ marginBottom: 6 }}>一次只分析一个视频，避免电脑卡顿；可以继续添加，会自动排队。</div>
      {needsYtdlp && <YtdlpNotice />}
      <div className="lib-q-list">
        {queue.map((q) => <QueueItem key={q.id} q={q} position={waiting.indexOf(q) + 1} />)}
      </div>
    </div>
  );
}
