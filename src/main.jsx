import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import App from './ui/App.jsx';

window.addEventListener('error', (e) => console.error('[renderer error]', e.message, e.error?.stack));
window.addEventListener('unhandledrejection', (e) => console.error('[renderer rejection]', e.reason?.stack || e.reason));

createRoot(document.getElementById('root')).render(<App />);
