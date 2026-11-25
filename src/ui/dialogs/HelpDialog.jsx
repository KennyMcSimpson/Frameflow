// Help Center: Quick Start, Keyboard Shortcuts, AI & Agents, Honesty Pledge, and About.
import React, { useState } from 'react';
import useStore from '../store.js';
import api from '../api.js';
import { useLocale, useT } from '../i18n.js';
import { Modal, Button, Tabs, Icon } from '../components/ui.jsx';
import { ShortcutsPanel } from './ShortcutsDialog.jsx';

const MODE_GUIDE_SPEC = [
  {
    key: 'create',
    icon: 'sparkles',
    titleKey: 'help.guide.create.title',
    stepKeys: ['help.guide.create.s1', 'help.guide.create.s2', 'help.guide.create.s3', 'help.guide.create.s4'],
  },
  {
    key: 'refine',
    icon: 'sliders',
    titleKey: 'help.guide.refine.title',
    stepKeys: ['help.guide.refine.s1', 'help.guide.refine.s2', 'help.guide.refine.s3', 'help.guide.refine.s4'],
  },
  {
    key: 'library',
    icon: 'book',
    titleKey: 'help.guide.library.title',
    stepKeys: ['help.guide.library.s1', 'help.guide.library.s2', 'help.guide.library.s3', 'help.guide.library.s4'],
  },
];

function About() {
  const locale = useLocale();
  const tr = useT();
  const colon = locale === 'zh-CN' ? '：' : ': ';
  const appInfo = useStore((s) => s.appInfo);
  const toast = useStore((s) => s.toast);
  const openPath = (p) => {
    if (!p) return;
    api.call('shell:openPath', { path: p }).catch((e) => toast(tr('help.about.openPathFailed', { error: e.message }), 'error'));
  };
  const openLogs = () => {
    api.call('app:openLogs').catch(() => openPath(appInfo && appInfo.logsDir));
  };
  const v = (x) => x || tr('app.unknown');
  return (
    <div className="hp-about">
      <dl className="hp-dl">
        <dt>{tr('help.about.product')}</dt><dd>{tr('app.brandStudio')}</dd>
        <dt>{tr('help.about.version')}</dt><dd className="mono">{v(appInfo && appInfo.version)}</dd>
        <dt>{tr('help.about.runtime')}</dt>
        <dd className="mono">Electron {v(appInfo && appInfo.electron)} · Chromium {v(appInfo && appInfo.chrome)} · Node {v(appInfo && appInfo.node)}{appInfo && appInfo.platform ? ` · ${appInfo.platform}-${appInfo.arch || ''}` : ''}</dd>
        <dt>{tr('help.about.dataDir')}</dt>
        <dd className="hp-path">
          <span className="mono selectable ellipsis" title={(appInfo && appInfo.dataRoot) || ''}>{v(appInfo && appInfo.dataRoot)}</span>
          <Button size="sm" variant="ghost" icon="folder" onClick={() => openPath(appInfo && appInfo.dataRoot)} disabled={!appInfo || !appInfo.dataRoot}>{tr('app.open')}</Button>
        </dd>
        <dt>{tr('help.about.logs')}</dt>
        <dd className="hp-path">
          <span className="mono selectable ellipsis" title={(appInfo && appInfo.logsDir) || ''}>{v(appInfo && appInfo.logsDir)}</span>
          <Button size="sm" variant="ghost" icon="log" onClick={openLogs}>{tr('help.about.openLogs')}</Button>
        </dd>
      </dl>
      <div className="divider" />
      <h3 className="hp-sub">{tr('help.about.licensesTitle')}</h3>
      <ul className="hp-licenses hint">
        <li>
          <b>FFmpeg</b>{colon}{tr('help.about.licFfmpeg1')}<code className="mono">resources/ffmpeg</code>{tr('help.about.licFfmpeg2')}<code className="mono">resources/licenses/ffmpeg</code>{tr('help.about.licFfmpeg3')}
        </li>
        <li><b>Electron / Chromium</b>{colon}{tr('help.about.licElectron')}</li>
        <li><b>React / zustand / Vite</b>{colon}{tr('help.about.licFrontend')}</li>
        <li><b>{tr('help.about.licIconsLabel')}</b>{colon}{tr('help.about.licIcons')}</li>
        <li><b>{tr('help.about.licStockLabel')}</b>{colon}{tr('help.about.licStock')}</li>
        <li><b>{tr('help.about.licAiLabel')}</b>{colon}{tr('help.about.licAi')}</li>
      </ul>
      <div className="row wrap" style={{ marginTop: 10 }}>
        <Button size="sm" variant="ghost" icon="external" onClick={() => openPath(appInfo && appInfo.licensesPath)} disabled={!appInfo || !appInfo.licensesPath}>{tr('help.about.viewLicenses')}</Button>
        <Button size="sm" variant="ghost" icon="external" onClick={() => openPath(appInfo && appInfo.privacyPath)} disabled={!appInfo || !appInfo.privacyPath}>{tr('help.about.viewPrivacy')}</Button>
      </div>
      <div className="divider" />
      <p className="hint">{tr('help.about.footerNote')}</p>
    </div>
  );
}

function RestartTour({ onClose }) {
  const tr = useT();
  const resetOnboarding = useStore((s) => s.resetOnboarding);
  const hasProject = useStore((s) => !!s.project);
  return (
    <div className="hp-tour callout">
      <Icon name="sparkles" size={16} />
      <span className="grow">{tr('help.tour.desc')}</span>
      <Button size="sm" icon="refresh" onClick={() => { resetOnboarding(); onClose && onClose(); if (!hasProject) useStore.getState().toast(tr('help.tour.openProjectToast'), 'info'); }}>{tr('help.tour.restart')}</Button>
    </div>
  );
}

export default function HelpDialog({ onClose }) {
  const tr = useT();
  const [tab, setTab] = useState('start');
  const tabs = [
    { value: 'start', label: tr('help.tab.start'), icon: 'bolt' },
    { value: 'keys', label: tr('help.tab.keys'), icon: 'grid' },
    { value: 'ai', label: tr('help.tab.ai'), icon: 'brain' },
    { value: 'about', label: tr('help.tab.about'), icon: 'help' },
  ];

  return (
    <Modal title={tr('help.title')} onClose={onClose} wide className="hp-modal">
      <Tabs className="hp-tabs" value={tab} onChange={setTab} items={tabs} />

      {tab === 'start' && (
        <div className="hp-pane">
          <RestartTour onClose={onClose} />
          <p className="hp-lead">{tr('help.start.lead')}</p>
          <div className="hp-modes">
            {MODE_GUIDE_SPEC.map((m) => (
              <section key={m.key} className="hp-mode">
                <h3><Icon name={m.icon} size={15} /> {tr(m.titleKey)}</h3>
                <ol>{m.stepKeys.map((sk) => <li key={sk}>{tr(sk)}</li>)}</ol>
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
            <h3>{tr('help.ai.apiTitle')}</h3>
            <p>{tr('help.ai.apiDesc')}</p>
          </section>
          <section className="hp-block">
            <h3>{tr('help.ai.cliTitle')}</h3>
            <p>{tr('help.ai.cliDesc')}</p>
          </section>
          <section className="hp-block">
            <h3>{tr('help.ai.offlineTitle')}</h3>
            <ul>
              <li>{tr('help.ai.offline.1')}</li>
              <li>{tr('help.ai.offline.2')}</li>
              <li>{tr('help.ai.offline.3')}</li>
              <li>{tr('help.ai.offline.4')}</li>
            </ul>
          </section>
          <section className="hp-block hp-honest">
            <h3><Icon name="eye" size={15} /> {tr('help.ai.honestTitle')}</h3>
            <ul>
              <li><b>{tr('help.ai.honest.1Lead')}</b>{tr('help.ai.honest.1Body')}</li>
              <li>{tr('help.ai.honest.2')}</li>
              <li>{tr('help.ai.honest.3')}</li>
              <li>{tr('help.ai.honest.4')}</li>
            </ul>
          </section>
        </div>
      )}

      {tab === 'about' && <div className="hp-pane"><About /></div>}
    </Modal>
  );
}
