// 左栏「AI 导演」：对话、追问芯片、发送与取消。
import React, { useEffect, useRef } from 'react';
import useStore from '../../store.js';
import { Button, Chip, Icon, Spinner } from '../../components/ui.jsx';
import { useCreateUI, setUI } from './createState.js';
import { sendDirector, retryDirector, dismissDirectorError, cancelDirector, generateStoryboard } from './createActions.js';
import { EXAMPLE_PROMPTS, PROVIDER_LABELS } from './createLabels.js';
import { isQuestionLike, isLocalOnlyAI } from './createUtils.js';
import { Markdown, isComposing, useElapsed } from './bits.jsx';

const NO_MESSAGES = [];
const INPUT_MAX_HEIGHT = 140;

const isLocalOnly = isLocalOnlyAI;

const openAISettings = () => { try { useStore.getState().openDialog('settings', 'ai'); } catch { /* 设置框不可用时忽略 */ } };

/** 没连 AI 时在标题栏常驻一个小标签，说明现在用的是本地模板 */
function RuleChip({ status }) {
  if (!isLocalOnly(status)) return null;
  return <Chip title={status.detail || '连接 AI 后可以深入对话'}>{status.provider === 'local' ? '本地模板' : 'AI 未连接 · 本地模板'}</Chip>;
}

function Welcome({ disabled, localOnly }) {
  return (
    <div className="cr-welcome">
      <div className="cr-welcome-icon"><Icon name="sparkles" size={22} /></div>
      <h3>想拍点什么？</h3>
      <p>用大白话说就行。我会先问几个关键问题，再帮你写好简报和分镜，告诉你每个镜头怎么拍。</p>
      {localOnly && (
        <div className="cr-noai" role="note">
          <Icon name="info" size={14} />
          <span className="grow">当前没有连接 AI，会用本地模板帮你出分镜。连上 AI 后能聊得更深入。</span>
          <Button size="sm" onClick={openAISettings}>去连接</Button>
        </div>
      )}
      <div className="cr-examples">
        {EXAMPLE_PROMPTS.map((text) => (
          <button key={text} type="button" className="cr-example" disabled={disabled} onClick={() => sendDirector(text)}>
            <Icon name="chevronRight" size={13} />
            <span>{text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function QuickReplies({ questions, disabled, onPick }) {
  if (!questions || !questions.length) return null;
  return (
    <div className="cr-quick" role="group" aria-label="快捷回复">
      {questions.map((q) => {
        // 问句要用户自己补充答案：样式更轻，点了填进输入框；陈述句直接发送
        const ask = isQuestionLike(q);
        return (
          <button key={q} type="button" className={'cr-quick-chip' + (ask ? ' ask' : '')} disabled={disabled} title={ask ? '点一下放进输入框，补上你的回答再发送' : '点一下直接发送'} onClick={() => onPick(q)}>
            {q}
          </button>
        );
      })}
    </div>
  );
}

function Message({ message, last, busy, onPick, localOnly, answered }) {
  const isUser = message.role === 'user';
  return (
    <div className={'cr-msg ' + (isUser ? 'user' : 'ai')}>
      <div className="cr-bubble">
        {isUser ? <div className="cr-md selectable"><p>{message.text}</p></div> : <Markdown text={message.text} />}
      </div>
      {!isUser && last && answered && message.provider === 'local' && localOnly && (
        <div className="cr-msg-meta local">
          本地模板回复，连上 AI 能聊得更深入 ·{' '}
          <button type="button" className="cr-link-btn" onClick={openAISettings}>去连接</button>
        </div>
      )}
      {!isUser && last && <QuickReplies questions={message.questions} disabled={busy} onPick={onPick} />}
      {!isUser && last && message.readyForStoryboard && (
        <Button variant="ai" size="sm" icon="sparkles" className="cr-msg-cta" disabled={busy} onClick={() => generateStoryboard()}>信息够了，生成分镜</Button>
      )}
    </div>
  );
}

function Thinking({ chat }) {
  const seconds = useElapsed(chat.busy, chat.startedAt);
  return (
    <div className="cr-msg ai">
      <div className="cr-bubble cr-thinking">
        <Spinner ai />
        <span className="grow">{chat.cancelling ? '正在取消…' : chat.stage || 'AI 导演正在思考…'}</span>
        <span className="xs mono muted">{seconds}s</span>
        <Button variant="ghost" size="sm" disabled={chat.cancelling} onClick={cancelDirector}>取消</Button>
      </div>
    </div>
  );
}

function FailedNotice({ failed }) {
  return (
    <div className={'cr-msg-error' + (failed.cancelled ? ' cancelled' : '')} role="alert">
      <div className="selectable">{failed.message}</div>
      <div className="row wrap">
        <Button size="sm" icon="refresh" onClick={() => retryDirector()}>重试</Button>
        {!failed.cancelled && <Button size="sm" variant="ghost" onClick={() => retryDirector({ local: true })}>改用本地模板回复</Button>}
        <Button size="sm" variant="ghost" onClick={dismissDirectorError}>忽略</Button>
      </div>
    </div>
  );
}

export default function DirectorChat({ onCollapse }) {
  const messages = useStore((s) => s.project && s.project.chats && s.project.chats.director) || NO_MESSAGES;
  const aiStatus = useStore((s) => s.aiStatus);
  const chat = useCreateUI((s) => s.chat);
  const draft = useCreateUI((s) => s.chatDraft);
  const listRef = useRef(null);
  const inputRef = useRef(null);

  // 新消息、思考状态变化时贴底
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, chat.busy, chat.failed]);

  // 输入框随内容长高
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_HEIGHT)}px`;
  }, [draft]);

  const send = () => { sendDirector(draft); };

  // 问句要用户自己答：放进输入框等待补充。其他内容（如「发抖音」）直接发送。
  const pick = (text) => {
    if (!isQuestionLike(text)) { sendDirector(text); return; }
    setUI({ chatDraft: `${text} ` });
    const el = inputRef.current;
    if (el) el.focus();
  };

  const localOnly = isLocalOnly(aiStatus);

  return (
    <section className="cr-chat" aria-label="AI 导演" data-tour="create-chat">
      <header className="cr-chat-head">
        <span className="cr-chat-avatar"><Icon name="sparkles" size={14} /></span>
        <span className="cr-chat-title grow">AI 导演</span>
        <RuleChip status={aiStatus} />
        {onCollapse && (
          <button type="button" className="cr-icon-btn" title="收起对话" aria-label="收起对话" onClick={onCollapse}><Icon name="chevronRight" size={16} style={{ transform: 'rotate(180deg)' }} /></button>
        )}
      </header>

      <div className="cr-chat-list" ref={listRef}>
        {!messages.length && !chat.busy ? <Welcome disabled={chat.busy} localOnly={localOnly} /> : messages.map((m, i) => (
          <Message key={m.id} message={m} last={i === messages.length - 1} answered={i > 0} busy={chat.busy} onPick={pick} localOnly={localOnly} />
        ))}
        {chat.busy && <Thinking chat={chat} />}
        {chat.failed && !chat.busy && <FailedNotice failed={chat.failed} />}
      </div>

      <div className="cr-composer">
        <textarea
          ref={inputRef}
          className="textarea"
          rows={2}
          value={draft}
          placeholder="说说你想拍什么…"
          onChange={(e) => setUI({ chatDraft: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !isComposing(e)) { e.preventDefault(); send(); }
          }}
        />
        <div className="row">
          <span className="xs muted grow"><kbd>Enter</kbd> 发送　<kbd>Shift</kbd>+<kbd>Enter</kbd> 换行</span>
          <Button variant="ai" size="sm" icon="send" disabled={chat.busy || !draft.trim()} onClick={send}>发送</Button>
        </div>
      </div>
    </section>
  );
}
