// 创作模式入口：左 AI 导演（可收起为图标条），中分镜板，选中镜头时右侧镜头属性面板；简报为抽屉。
import React, { useCallback, useEffect } from 'react';
import '../../../styles/create.css';
import useStore from '../../store.js';
import { Icon } from '../../components/ui.jsx';
import { useCreateUI, setUI } from './createState.js';
import { loadUserTechniques } from './createActions.js';
import DirectorChat from './DirectorChat.jsx';
import Storyboard, { openBrief } from './Storyboard.jsx';
import BriefPanel from './BriefPanel.jsx';
import ShotEditor from './ShotEditor.jsx';
import { AssetPicker, RefinePrompt, ConfirmHost } from './ShotDialogs.jsx';

/** store.layout.createChatCollapsed（W1 持久化到 settings.ui）；未就绪时退回本模式状态 */
function useChatCollapsed() {
  const fromStore = useStore((s) => (s.layout ? s.layout.createChatCollapsed : undefined));
  const local = useCreateUI((s) => s.chatCollapsed);
  const collapsed = fromStore !== undefined ? !!fromStore : !!local;
  const setCollapsed = useCallback((v) => {
    const st = useStore.getState();
    if (typeof st.setLayout === 'function') st.setLayout({ createChatCollapsed: v });
    else if (st.layout) useStore.setState({ layout: { ...st.layout, createChatCollapsed: v } });
    else setUI({ chatCollapsed: v });
  }, []);
  return [collapsed, setCollapsed];
}

function ChatRail({ onExpand }) {
  const busy = useCreateUI((s) => s.chat.busy);
  return (
    <nav className="cr-rail" aria-label="AI 导演（已收起）" data-tour="create-chat">
      <button type="button" className={'cr-rail-btn ai' + (busy ? ' busy' : '')} title="展开 AI 导演" onClick={onExpand}><Icon name="sparkles" size={18} /></button>
      <button type="button" className="cr-rail-btn" title="创意简报" onClick={() => openBrief(true)}><Icon name="book" size={18} /></button>
      <span className="grow" />
      <button type="button" className="cr-rail-btn" title="展开" onClick={onExpand}><Icon name="chevronRight" size={16} /></button>
    </nav>
  );
}

function Dialogs() {
  const pickerShotId = useCreateUI((s) => s.pickerShotId);
  const refineShotId = useCreateUI((s) => s.refineShotId);
  const closePicker = useCallback(() => setUI({ pickerShotId: null }), []);
  const closeRefine = useCallback(() => setUI({ refineShotId: null }), []);
  return (
    <>
      {pickerShotId && <AssetPicker shotId={pickerShotId} onClose={closePicker} />}
      {refineShotId && <RefinePrompt shotId={refineShotId} onClose={closeRefine} />}
      <BriefPanel />
      <ConfirmHost />
    </>
  );
}

export default function CreateMode() {
  const projectId = useStore((s) => (s.project ? s.project.id : null));
  const selectedShotId = useStore((s) => s.selection.shotId);
  const shotExists = useStore((s) => !!(s.project && selectedShotId && s.project.storyboard.some((x) => x.id === selectedShotId)));
  const [collapsed, setCollapsed] = useChatCollapsed();
  const closeEditor = useCallback(() => useStore.getState().selectShot(null), []);

  useEffect(() => { if (projectId) loadUserTechniques(); }, [projectId]);
  // 旧入口（editorShotId）兼容：转成选中镜头
  const legacyEditor = useCreateUI((s) => s.editorShotId);
  useEffect(() => { if (legacyEditor) { useStore.getState().selectShot(legacyEditor); setUI({ editorShotId: null }); } }, [legacyEditor]);

  if (!projectId) return null;
  const inspector = shotExists;
  return (
    <div className={'cr-root' + (collapsed ? ' chat-collapsed' : '') + (inspector ? ' with-insp' : '')}>
      {collapsed ? <ChatRail onExpand={() => setCollapsed(false)} /> : <DirectorChat onCollapse={() => setCollapsed(true)} />}
      <Storyboard />
      {inspector && <ShotEditor key={selectedShotId} shotId={selectedShotId} onClose={closeEditor} />}
      <Dialogs />
    </div>
  );
}
