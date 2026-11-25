// Video Site Parsing Terms & Consent Dialog. Mounted once via <ConsentHost /> in App.jsx.
import React, { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n.js';
import { Button, Icon, Modal } from '../components/ui.jsx';
import { answerConsent, subscribeConsent } from '../consent.js';

const POINTS = [
  { icon: 'download', key: 'consent.point1' },
  { icon: 'info', key: 'consent.point2' },
  { icon: 'lock', key: 'consent.point3' },
  { icon: 'alert', key: 'consent.point4' },
];

const S = {
  lead: { margin: '0 0 var(--space-3, 12px)', color: 'var(--text-1)', lineHeight: 1.6 },
  list: { display: 'flex', flexDirection: 'column', gap: 10, margin: 0, padding: 0, listStyle: 'none' },
  item: { display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 'var(--radius-s)', background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-0)', lineHeight: 1.6 },
  icon: { flex: 'none', marginTop: 2, color: 'var(--accent)' },
  check: { display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 14, padding: '10px 12px', borderRadius: 'var(--radius-s)', border: '1px solid var(--accent-line)', background: 'var(--accent-soft)', color: 'var(--text-0)', cursor: 'pointer', lineHeight: 1.5 },
  box: { flex: 'none', width: 16, height: 16, marginTop: 2, accentColor: 'var(--accent)', cursor: 'pointer' },
  foot: { display: 'flex', alignItems: 'center', gap: 8, width: '100%' },
  hint: { flex: 1, color: 'var(--text-2)', fontSize: 'var(--fs-xs)' },
};

function ConsentDialog({ onAnswer }) {
  const tr = useT();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef(null);
  useEffect(() => { boxRef.current?.focus(); }, []);

  const answer = async (agreed) => {
    if (busy) return;
    if (agreed && !checked) return;
    setBusy(true);
    try { await onAnswer(agreed); } finally { setBusy(false); }
  };

  return (
    <Modal
      title={tr('consent.title')}
      onClose={() => answer(false)}
      className="consent-dialog"
      footer={(
        <div style={S.foot}>
          <span style={S.hint}>{checked ? tr('consent.hintChecked') : tr('consent.hintUnchecked')}</span>
          <Button onClick={() => answer(false)} disabled={busy}>{tr('app.cancel')}</Button>
          <Button variant="primary" onClick={() => answer(true)} disabled={!checked || busy}>{busy ? tr('consent.saving') : tr('consent.accept')}</Button>
        </div>
      )}
    >
      <p style={S.lead}>{tr('consent.lead')}</p>
      <ol style={S.list}>
        {POINTS.map((p) => (
          <li key={p.key} style={S.item}>
            <span style={S.icon}><Icon name={p.icon} size={15} /></span>
            <span>{tr(p.key)}</span>
          </li>
        ))}
      </ol>
      <label style={S.check}>
        <input
          ref={boxRef}
          type="checkbox"
          style={S.box}
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          onKeyDown={(e) => { if (e.key === 'Enter' && checked) answer(true); }}
        />
        <span>{tr('consent.checkbox')}</span>
      </label>
    </Modal>
  );
}

export function ConsentHost() {
  const [req, setReq] = useState(null);
  useEffect(() => subscribeConsent(setReq), []);
  if (!req) return null;
  return <ConsentDialog key={req.key} onAnswer={answerConsent} />;
}

export default ConsentHost;
