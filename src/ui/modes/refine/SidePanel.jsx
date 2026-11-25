// 精修 · AI 助手面板外壳（v3 起 AI 助手在右侧抽屉中打开，由 RefineMode 挂载；此组件保留给其他入口复用）。
import React from 'react';
import AIEditPanel from './AIEditPanel.jsx';
import '../../../styles/refine-side.css';

export default function SidePanel() {
  return (
    <div className="sp-root">
      <div className="sp-body"><div className="sp-pane"><AIEditPanel /></div></div>
    </div>
  );
}
