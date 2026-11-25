// 应用外壳：启动、首页/模式路由、全局快捷键、拖放提示、错误边界、对话框与通知挂载。
import React, { Component, Suspense, lazy, useEffect, useRef, useState } from 'react';
import '../styles/shell.css';
// App 负责引入全部模块样式（新增的 css 文件自动包含）
import.meta.glob('../styles/*.css', { eager: true });
import useStore from './store.js';
import api from './api.js';
import { getLocale, setLocale, t, useLocale, useT } from './i18n.js';
import { Button, Icon, ProgressBar } from './components/ui.jsx';
import { DND_ASSET, importFilesDialog, importPaths } from './assetActions.js';
import TopBar, { Logo, goHome } from './components/TopBar.jsx';
import StartPage from './components/StartPage.jsx';
import Toasts from './components/Toasts.jsx';
import StatusBar from './components/StatusBar.jsx';
import Coachmark from './components/Coachmark.jsx';
import ConsentHost from './dialogs/ConsentDialog.jsx';
import { comboFromEvent, firesInInput, isTypingTarget, keymapFor, shortcutById } from './shortcuts/customKeys.js';

// 按需加载：三个模式与各对话框拆成独立 chunk，首屏只加载外壳
const SettingsDialog = lazy(() => import('./dialogs/SettingsDialog.jsx'));
const ExportDialog = lazy(() => import('./dialogs/ExportDialog.jsx'));
const HelpDialog = lazy(() => import('./dialogs/HelpDialog.jsx'));
const NewProjectDialog = lazy(() => import('./dialogs/NewProjectDialog.jsx'));
const ShortcutsDialog = lazy(() => import('./dialogs/ShortcutsDialog.jsx'));
const CreateMode = lazy(() => import('./modes/create/CreateMode.jsx'));
const RefineMode = lazy(() => import('./modes/refine/RefineMode.jsx'));
const LibraryMode = lazy(() => import('./modes/library/LibraryMode.jsx'));

/** 空闲时预取各模式代码，切换时无白屏 */
function prefetchModes() {
  const run = () => {
    import('./modes/create/CreateMode.jsx').catch(() => {});
    import('./modes/refine/RefineMode.jsx').catch(() => {});
    import('./modes/library/LibraryMode.jsx').catch(() => {});
  };
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 4000 }); else setTimeout(run, 1500);
}

function ModeLoading() {
  const tr = useT();
  return <div className="mode-loading"><span className="spinner" /><span>{tr('app.loading')}</span></div>;
}

// ---------------------------------------------------------------------------
// 错误边界：先保存，再给出恢复入口
// ---------------------------------------------------------------------------
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, stack: '', saved: 'saving' };
    this.reset = this.reset.bind(this);
    this.reload = this.reload.bind(this);
    this.home = this.home.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ui] 界面崩溃', error, info && info.componentStack);
    this.setState({ stack: (info && info.componentStack) || '', saved: 'saving' });
    this.save();
  }

  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.reset();
  }

  async save() {
    const st = useStore.getState();
    if (!st.project) { this.setState({ saved: 'none' }); return 'none'; }
    let saved = 'failed';
    try {
      await st.saveNow();
      if (useStore.getState().saveState !== 'error') saved = 'ok';
    } catch { /* 保持 failed */ }
    this.setState({ saved });
    return saved;
  }

  reset() {
    this.setState({ error: null, stack: '', saved: 'saving' });
  }

  async reload() {
    // 保存失败时不刷新：内存里的项目是唯一副本
    if ((await this.save()) !== 'failed') window.location.reload();
  }

  async home() {
    await goHome();
    this.reset();
  }

  render() {
    const { error, stack, saved } = this.state;
    if (!error) return this.props.children;
    const isEn = (this.props.locale || getLocale()) === 'en-US';
    const L = (zh, en) => (isEn ? en : zh);
    const savedText = {
      saving: L('正在保存项目…', 'Saving project…'),
      ok: L('项目已保存，数据没有丢失。', 'Project saved — no data was lost.'),
      none: L('当前没有打开的项目，无需保存。', 'No open project to save.'),
      failed: L(
        '项目保存失败。修改还在内存里，请先点「重新加载界面」回到编辑，再按 Ctrl+S 保存。',
        'Failed to save project. Your changes are still in memory — click "Reload View" to return to editing, then press Ctrl+S to save.',
      ),
    }[saved];
    return (
      <div className="err-screen" role="alert">
        <div className="err-card">
          <div className="err-mark"><Icon name="bolt" size={22} /></div>
          <h2>{L('这部分界面出了点问题', 'Something went wrong in this view')}</h2>
          <p className={'err-saved ' + saved}>{savedText}</p>
          <pre className="err-message selectable">{String((error && error.message) || error)}</pre>
          {stack && (
            <details className="err-details">
              <summary>{L('技术详情', 'Technical details')}</summary>
              <pre className="selectable">{stack.trim()}</pre>
            </details>
          )}
          <div className="err-actions">
            <Button variant="primary" icon="refresh" onClick={this.reset} disabled={saved === 'saving'}>{L('重新加载界面', 'Reload View')}</Button>
            {this.props.allowHome && useStore.getState().project && <Button icon="home" onClick={this.home} disabled={saved === 'saving'}>{L('返回首页', 'Back to Home')}</Button>}
            <Button variant="ghost" onClick={this.reload} disabled={saved === 'saving'}>{L('重启应用界面', 'Restart App UI')}</Button>
          </div>
        </div>
      </div>
    );
  }
}

// ---------------------------------------------------------------------------
// 启动画面
// ---------------------------------------------------------------------------
function Splash() {
  const locale = useLocale();
  const tr = useT();
  return (
    <div className="splash">
      <Logo size={64} />
      <div className="splash-name">{locale === 'zh-CN' ? <>镜流 <b>Frameflow</b></> : <b>Frameflow</b>}</div>
      <div className="splash-sub">{tr('app.tagline')}</div>
      <div className="splash-bar"><ProgressBar indeterminate /></div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 全局快捷键（走注册表 keymapFor('global')，支持自定义按键、e.code、输入法组合态与 ? 快捷键面板）
// ---------------------------------------------------------------------------
function anyDialogOpen(st) {
  if (Object.values(st.dialogs || {}).some(Boolean)) return true;
  return typeof document !== 'undefined' && !!document.querySelector('.modal-backdrop');
}

function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented || e.isComposing) return;
      const combo = comboFromEvent(e);
      if (!combo) return;
      let def = keymapFor('global').get(combo) || null;
      if (!def) {
        // ?（以及自定义后的 help 快捷键）在所有模式下都能打开快捷键面板
        const helpDef = shortcutById('help');
        if (helpDef && Array.isArray(helpDef.keys) && helpDef.keys.includes(combo)) def = helpDef;
      }
      if (!def) return;
      if (isTypingTarget(e.target) && !firesInInput(def, combo)) return;

      const st = useStore.getState();
      const anyDialog = anyDialogOpen(st);

      // 保存（默认 Ctrl+S）在输入框里也有效：打字时保存不会误伤内容
      if (def.id === 'save') {
        e.preventDefault();
        if (!st.project || e.repeat) return;
        st.saveNow().then(() => {
          const s = useStore.getState();
          if (s.saveState === 'saved') s.toast(t('top.save.saved'), 'ok', 1400);
        });
        return;
      }

      if (anyDialog) return;
      if (e.repeat && !def.repeat) { e.preventDefault(); return; }

      switch (def.id) {
        case 'helpCenter':
          e.preventDefault();
          st.openDialog('help');
          break;
        case 'help':
          e.preventDefault();
          st.openDialog('shortcuts');
          break;
        case 'undo':
          if (!st.project) return;
          e.preventDefault();
          st.undo();
          break;
        case 'redo':
          if (!st.project) return;
          e.preventDefault();
          st.redo();
          break;
        case 'export':
          e.preventDefault();
          if (st.project) st.openDialog('export');
          break;
        case 'settings':
          e.preventDefault();
          st.openDialog('settings');
          break;
        case 'modeCreate':
          if (!st.project) return;
          e.preventDefault();
          st.setMode('create');
          break;
        case 'modeRefine':
          if (!st.project) return;
          e.preventDefault();
          st.setMode('refine');
          break;
        case 'modeLibrary':
          if (!st.project) return;
          e.preventDefault();
          st.setMode('library');
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

// ---------------------------------------------------------------------------
// 系统文件拖入：优先通过 api.pathForFile 直接提取本机路径导入；取不到时再回退到导入窗口
// ---------------------------------------------------------------------------
function useExternalFileDrop() {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    let depth = 0;
    const isExternal = (e) => {
      const types = Array.from((e.dataTransfer && e.dataTransfer.types) || []);
      return types.includes('Files') && !types.includes(DND_ASSET);
    };
    const onEnter = (e) => {
      if (!isExternal(e)) return;
      depth += 1;
      setDragging(true);
    };
    const onLeave = (e) => {
      if (!isExternal(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onOver = (e) => {
      if (!isExternal(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (e) => {
      if (!isExternal(e)) return;
      if (e.defaultPrevented) return; // 内层模块已经处理
      e.preventDefault();
      const isEn = getLocale() === 'en-US';
      const st = useStore.getState();
      if (!st.project) {
        st.toast(isEn ? 'Create or open a project before importing media' : '请先新建或打开一个项目，再导入素材', 'warn');
        return;
      }
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      const paths = files.map((f) => api.pathForFile(f)).filter(Boolean);
      if (paths.length) {
        importPaths(paths).catch((err) => useStore.getState().toast((getLocale() === 'en-US' ? 'Import failed: ' : '导入失败：') + err.message, 'error'));
        return;
      }
      st.toast(
        isEn
          ? 'Could not read the dropped file path directly — opened the import dialog instead'
          : '拖入的文件无法直接读取路径，已打开导入窗口，请在里面选择文件',
        'info',
        4500,
      );
      importFilesDialog().catch((err) => useStore.getState().toast((getLocale() === 'en-US' ? 'Import failed: ' : '导入失败：') + err.message, 'error'));
    };
    // 捕获阶段复位提示：内层模块 stopPropagation 时冒泡阶段收不到 drop
    const onDropCapture = () => { depth = 0; setDragging(false); };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDropCapture, true);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDropCapture, true);
      window.removeEventListener('drop', onDrop);
    };
  }, []);
  return dragging;
}

function DropHint({ hasProject }) {
  const isEn = useLocale() === 'en-US';
  const L = (zh, en) => (isEn ? en : zh);
  return (
    <div className="drop-hint" aria-hidden="true">
      <div className="drop-hint-card">
        <Icon name="upload" size={26} />
        <b>{hasProject ? L('松开即可导入素材', 'Drop to Import Media') : L('请先打开一个项目', 'Open a Project First')}</b>
        <span>{hasProject ? L('视频、图片和音频会直接加入当前项目的素材箱', 'Videos, images, and audio will be added to your current project') : L('打开或新建项目后，就可以导入素材了', 'Open or create a project to import media files')}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 当前模式（条件渲染：隐藏的模式不跑渲染循环，也不会抢快捷键）
// ---------------------------------------------------------------------------
function ModeView({ mode }) {
  let view = <CreateMode />;
  if (mode === 'refine') view = <RefineMode />;
  else if (mode === 'library') view = <LibraryMode />;
  return <Suspense fallback={<ModeLoading />}>{view}</Suspense>;
}

function Dialogs() {
  const dialogs = useStore((s) => s.dialogs);
  const hasProject = useStore((s) => !!s.project);
  const closeDialog = useStore((s) => s.closeDialog);
  return (
    <Suspense fallback={null}>
      {dialogs.settings && <SettingsDialog initialTab={typeof dialogs.settings === 'string' ? dialogs.settings : undefined} onClose={() => closeDialog('settings')} />}
      {dialogs.help && <HelpDialog onClose={() => closeDialog('help')} />}
      {dialogs.shortcuts && <ShortcutsDialog onClose={() => closeDialog('shortcuts')} />}
      {dialogs.newProject && <NewProjectDialog onClose={() => closeDialog('newProject')} />}
      {dialogs.export && hasProject && <ExportDialog onClose={() => closeDialog('export')} />}
    </Suspense>
  );
}

export default function App() {
  const ready = useStore((s) => s.ready);
  const settingsLocale = useStore((s) => s.settings && s.settings.ui && s.settings.ui.locale);
  const projectId = useStore((s) => (s.project ? s.project.id : null));
  const projectName = useStore((s) => (s.project ? s.project.name : ''));
  const mode = useStore((s) => s.mode);
  const locale = useLocale();
  const tr = useT();
  const [libraryOnly, setLibraryOnly] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    useStore.getState().init();
    prefetchModes();
  }, []);

  useEffect(() => {
    if (!ready && !settingsLocale) return;
    setLocale(settingsLocale || 'zh-CN');
  }, [ready, settingsLocale]);

  useEffect(() => {
    const onOpenShortcuts = () => useStore.getState().openDialog('shortcuts');
    window.addEventListener('ff:open-shortcuts', onOpenShortcuts);
    return () => window.removeEventListener('ff:open-shortcuts', onOpenShortcuts);
  }, []);

  useEffect(() => { if (projectId) setLibraryOnly(false); }, [projectId]);
  useEffect(() => {
    const brand = tr('app.brand');
    document.title = projectId ? `${projectName || tr('app.untitledProject')} — ${brand}` : brand;
  }, [projectId, projectName, locale, tr]);

  useGlobalShortcuts();
  const dragging = useExternalFileDrop();

  if (!ready) return <Splash />;

  let body;
  if (projectId) {
    body = (
      <>
        <TopBar />
        <main className="app-main">
          <ErrorBoundary resetKey={`${projectId}:${mode}`} allowHome locale={locale}>
            <div className="mode-host" key={`${projectId}:${mode}`}><ModeView mode={mode} /></div>
          </ErrorBoundary>
        </main>
        <StatusBar />
        <Coachmark key={mode} mode={mode} />
      </>
    );
  } else if (libraryOnly) {
    body = (
      <>
        <TopBar standalone onExitStandalone={() => setLibraryOnly(false)} />
        <main className="app-main">
          <ErrorBoundary resetKey="library-only" locale={locale}>
            <div className="mode-host"><Suspense fallback={<ModeLoading />}><LibraryMode /></Suspense></div>
          </ErrorBoundary>
        </main>
        <StatusBar />
      </>
    );
  } else {
    body = <StartPage onOpenLibrary={() => setLibraryOnly(true)} />;
  }

  return (
    <ErrorBoundary resetKey="root" locale={locale}>
      <div className="app-shell">
        {body}
        <Dialogs />
        <ConsentHost />
        <div className={'shell-corner' + (projectId || libraryOnly ? ' with-status' : '') + (projectId && mode === 'create' ? ' avoid-pace' : '')}>
          <Toasts />
        </div>
        {dragging && <DropHint hasProject={!!projectId} />}
      </div>
    </ErrorBoundary>
  );
}
