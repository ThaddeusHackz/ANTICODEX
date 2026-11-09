import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { AppProvider } from './lib/state.jsx';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AppProvider>
        <App />
      </AppProvider>
    </BrowserRouter>
  </React.StrictMode>
);

// PWA: register the service worker only in a production web build. Never in
// dev (vite HMR and a caching worker fight each other) and never inside
// Electron — the desktop shell ships its own bundled page and updates through
// desktop/updater.mjs, so a worker there only adds stale-cache risk. The
// preload bridge (desktop/preload.mjs) exposes window.anticodexDesktop; the
// user-agent check is the fallback for hosts that do not run the preload.
const inElectron = /Electron\//i.test(navigator.userAgent || '');
const inDesktopBridge = typeof window !== 'undefined' && 'anticodexDesktop' in window;
if (import.meta.env.PROD && !inElectron && !inDesktopBridge && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      // A failed registration must never break the app — the site simply
      // behaves like it did before the PWA existed.
      console.warn('ANTICODEX: service worker registration failed', err);
    });
  });
}
