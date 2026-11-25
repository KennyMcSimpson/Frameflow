// 拆片库模式入口（两栏）：
//   左：「+ 拆片」/ 批量导入 / 搜索 + 筛选 / 任务队列 / 拆片列表
//   右：选中视频 → 分析详情（概览 · 镜头 · 图表 · 技法）；未选中 → 内置精选技法（首次使用附 6 宫格引导）
// 「添加拆片」与「主题学习」合并在一个弹窗的两个 Tab 中。
import React, { useEffect, useState } from 'react';
import { Tabs, Modal, Button, Icon } from '../../components/ui.jsx';
import useLibrary from './libraryActions.js';
import AddPanel, { pickLocalVideos } from './AddPanel.jsx';
import TopicLearn from './TopicLearn.jsx';
import TaskQueue from './TaskQueue.jsx';
import AnalysisList from './AnalysisList.jsx';
import AnalysisDetail from './AnalysisDetail.jsx';
import '../../../styles/library.css';

export default function LibraryMode() {
  const [addOpen, setAddOpen] = useState(null); // null | 'add' | 'topic'
  useEffect(() => { useLibrary.getState().init(); }, []);
  const openAdd = (tab = 'add') => setAddOpen(tab);

  return (
    <div className="lib-root">
      <aside className="lib-left">
        <div className="lib-left-head">
          <div className="lib-left-title">
            <Icon name="film" size={16} />
            <span>拆片库</span>
          </div>
          <div className="lib-left-actions">
            <Button className="lib-add-btn" icon="plus" data-tour="library-add" onClick={() => openAdd('add')} title="粘贴链接或选择本地视频进行拆片">拆片</Button>
            <Button variant="ghost" icon="folder" onClick={() => pickLocalVideos()} title="一次选择多个本地视频批量拆片">批量导入</Button>
            <Button variant="ghost" icon="globe" onClick={() => openAdd('topic')} title="输入主题，让镜流帮你找视频学习" />
          </div>
        </div>
        <div className="lib-left-body">
          <TaskQueue />
          <AnalysisList onAdd={() => openAdd('add')} />
        </div>
      </aside>

      <main className="lib-main">
        <AnalysisDetail onAdd={openAdd} />
      </main>

      {addOpen && (
        <Modal title="添加拆片" wide className="lib-add-modal" onClose={() => setAddOpen(null)}>
          <Tabs
            className="lib-add-tabs"
            value={addOpen}
            onChange={setAddOpen}
            items={[
              { value: 'add', label: '链接 / 本地视频', icon: 'plus' },
              { value: 'topic', label: '按主题找视频', icon: 'globe' },
            ]}
          />
          <div className="lib-add-modal-body">
            {addOpen === 'add' ? <AddPanel onDone={() => setAddOpen(null)} /> : <TopicLearn />}
          </div>
        </Modal>
      )}
    </div>
  );
}
