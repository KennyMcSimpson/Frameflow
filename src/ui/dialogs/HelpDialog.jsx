// 帮助：快速上手、快捷键、AI 说明、诚实声明、关于。
import React, { useState } from 'react';
import useStore from '../store.js';
import api from '../api.js';
import { Modal, Button, Tabs, Icon } from '../components/ui.jsx';
import { ShortcutsPanel } from './ShortcutsDialog.jsx';

const TABS = [
  { value: 'start', label: '快速上手', icon: 'bolt' },
  { value: 'keys', label: '快捷键', icon: 'grid' },
  { value: 'ai', label: 'AI 说明', icon: 'brain' },
  { value: 'about', label: '关于', icon: 'help' },
];

const MODE_GUIDE = [
  {
    icon: 'sparkles',
    title: '创作：从想法到分镜',
    steps: [
      '在左侧用大白话告诉 AI 导演你想拍什么，它会追问受众、平台、时长和风格。',
      '信息够了就生成分镜。每个镜头都写清楚景别、运镜、光线和手机拍摄要点。',
      '点「生成全部画面」，每个镜头自动匹配真人实拍素材，或调用 AI 视频生成写实画面；动画预演只作临时占位。',
      '拍好后为分镜指定素材，点「一键初剪」就能进入精修。没拍的镜头会先用预演占位。',
    ],
  },
  {
    icon: 'sliders',
    title: '精修：一句话改片',
    steps: [
      '左侧素材区导入或搜索实拍素材，拖到时间线；拖动排序，拖边缘裁剪，按 S 在播放头分割。',
      '在「AI 精修」里直接说：「第二段暖一点」「全片节奏快一点」「结尾加黑场」。',
      '想单独修一段？在时间线上框选，点「聚焦此段」。AI 仍然记得全片风格，改完不会跑调。',
      '喜欢动手就用「检查器」调参数，或在「技法」里把技法卡一键用到所选镜头。',
    ],
  },
  {
    icon: 'book',
    title: '拆片库：跟好片子学',
    steps: [
      '粘贴视频链接或选择本地视频，选好分类后开始拆片。',
      '工作站会切分镜头、提取关键帧、统计节奏、色彩、运动和响度，并读取台词字幕。',
      '有 AI 时还会标注景别、运镜、光线和用途，沉淀成可复用的技法卡。',
      '技法卡可以一键应用到时间线，创作和精修时 AI 也会参考它们。内置技法卡离线可用。',
    ],
  },
];

function About() {
  const appInfo = useStore((s) => s.appInfo);
  const toast = useStore((s) => s.toast);
  const openPath = (p) => {
    if (!p) return;
    api.call('shell:openPath', { path: p }).catch((e) => toast('打开目录失败：' + e.message, 'error'));
  };
  const openLogs = () => {
    api.call('app:openLogs').catch(() => openPath(appInfo && appInfo.logsDir));
  };
  const v = (x) => x || '未知';
  return (
    <div className="hp-about">
      <dl className="hp-dl">
        <dt>产品</dt><dd>镜流 Frameflow Studio</dd>
        <dt>版本</dt><dd className="mono">{v(appInfo && appInfo.version)}</dd>
        <dt>运行环境</dt>
        <dd className="mono">Electron {v(appInfo && appInfo.electron)} · Chromium {v(appInfo && appInfo.chrome)} · Node {v(appInfo && appInfo.node)}{appInfo && appInfo.platform ? ` · ${appInfo.platform}-${appInfo.arch || ''}` : ''}</dd>
        <dt>数据目录</dt>
        <dd className="hp-path">
          <span className="mono selectable ellipsis" title={(appInfo && appInfo.dataRoot) || ''}>{v(appInfo && appInfo.dataRoot)}</span>
          <Button size="sm" variant="ghost" icon="folder" onClick={() => openPath(appInfo && appInfo.dataRoot)} disabled={!appInfo || !appInfo.dataRoot}>打开</Button>
        </dd>
        <dt>日志</dt>
        <dd className="hp-path">
          <span className="mono selectable ellipsis" title={(appInfo && appInfo.logsDir) || ''}>{v(appInfo && appInfo.logsDir)}</span>
          <Button size="sm" variant="ghost" icon="log" onClick={openLogs}>打开日志目录</Button>
        </dd>
      </dl>
      <div className="divider" />
      <h3 className="hp-sub">开源许可</h3>
      <ul className="hp-licenses hint">
        <li><b>FFmpeg</b>：随附 LGPL v3 共享库构建（位于安装目录 <code className="mono">resources/ffmpeg</code>），以独立程序和动态库形式动态调用，未修改其源代码；许可全文与源代码获取方式见 <code className="mono">resources/licenses/ffmpeg</code>，你也可以自行替换为兼容版本。</li>
        <li><b>Electron / Chromium</b>：MIT 及 BSD 等许可。</li>
        <li><b>React、zustand、Vite</b>：MIT 许可。</li>
        <li><b>图标</b>：参照 Lucide（ISC 许可）风格绘制。</li>
        <li><b>实拍素材</b>：来自 Wikimedia Commons / Openverse / Internet Archive / NASA / Pexels / Pixabay 等平台的素材遵循其各自许可，作者署名记录在素材信息中。</li>
      </ul>
      <div className="row wrap" style={{ marginTop: 10 }}>
        <Button size="sm" variant="ghost" icon="external" onClick={() => openPath(appInfo && appInfo.licensesPath)} disabled={!appInfo || !appInfo.licensesPath}>查看第三方开源许可</Button>
        <Button size="sm" variant="ghost" icon="external" onClick={() => openPath(appInfo && appInfo.privacyPath)} disabled={!appInfo || !appInfo.privacyPath}>查看隐私说明</Button>
      </div>
      <div className="divider" />
      <p className="hint">你的项目和素材都保存在本机。导入视频时不会复制原文件，请不要移动或删除它们。从网络下载的视频版权归原作者所有，仅供学习和参考，公开发布前请确认授权。</p>
    </div>
  );
}

function RestartTour({ onClose }) {
  const resetOnboarding = useStore((s) => s.resetOnboarding);
  const hasProject = useStore((s) => !!s.project);
  return (
    <div className="hp-tour callout">
      <Icon name="sparkles" size={16} />
      <span className="grow">第一次用？跟着引导看一遍每个区域是做什么的，大约 30 秒。</span>
      <Button size="sm" icon="refresh" onClick={() => { resetOnboarding(); onClose && onClose(); if (!hasProject) useStore.getState().toast('打开项目后将显示引导', 'info'); }}>重新引导</Button>
    </div>
  );
}
export default function HelpDialog({ onClose }) {
  const [tab, setTab] = useState('start');
  return (
    <Modal title="帮助" onClose={onClose} wide className="hp-modal">
      <Tabs className="hp-tabs" value={tab} onChange={setTab} items={TABS} />

      {tab === 'start' && (
        <div className="hp-pane">
          <RestartTour onClose={onClose} />
          <p className="hp-lead">镜流把做视频分成三件事，从哪一步开始都可以。</p>
          <div className="hp-modes">
            {MODE_GUIDE.map((m) => (
              <section key={m.title} className="hp-mode">
                <h3><Icon name={m.icon} size={15} /> {m.title}</h3>
                <ol>{m.steps.map((s) => <li key={s}>{s}</li>)}</ol>
              </section>
            ))}
          </div>
        </div>
      )}

      {tab === 'keys' && (
        <div className="hp-pane">
          <ShortcutsPanel />
        </div>
      )}

      {tab === 'ai' && (
        <div className="hp-pane">
          <section className="hp-block">
            <h3>Codex（推荐，无需 API Key）</h3>
            <p>安装 Codex CLI 后，打开终端运行 <kbd>codex login</kbd>，用 ChatGPT 账号登录。回到镜流，底部状态栏显示「AI 导演已连接」就可以用了。</p>
          </section>
          <section className="hp-block">
            <h3>OpenAI 兼容接口（可选）</h3>
            <p>在设置里填写 Base URL 和 API Key。响应通常更快，配置图片模型后还能为分镜生成「AI 画面」。</p>
          </section>
          <section className="hp-block">
            <h3>没有 AI 时能做什么</h3>
            <ul>
              <li>本地规则能听懂常见中文指令，比如「第二段暖一点」「全部加黑边」「节奏快一点」。</li>
              <li>按平台、时长和风格生成模板分镜，附拍法和预演动画。</li>
              <li>拆片仍会统计镜头、节奏、色彩、运动和响度，并推断基础技法卡。</li>
              <li>内置技法卡、时间线、调色、转场、特效和导出都不依赖 AI。</li>
            </ul>
          </section>
          <section className="hp-block hp-honest">
            <h3><Icon name="eye" size={15} /> 我们的诚实声明</h3>
            <ul>
              <li><b>AI 预演是动画示意，不是实拍。</b>它只用来临时占位，导出时会带「示意」水印；成片请使用实拍素材或 AI 视频生成。</li>
              <li>没有分析过的内容不会说分析过。</li>
              <li>修改失败时时间线保持原样，不会只改一半。</li>
              <li>导出进度是真实渲染进度，不是估算动画。</li>
            </ul>
          </section>
        </div>
      )}

      {tab === 'about' && <div className="hp-pane"><About /></div>}
    </Modal>
  );
}
