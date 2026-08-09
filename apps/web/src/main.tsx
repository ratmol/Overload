import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { seedIfNeeded } from './db/seed.js';
import { requestPersistence } from './lib/persistence.js';
import './ui/tokens.css';
import './ui/app.css';

const root = createRoot(document.getElementById('root')!);

// Fire and forget. The answer is surfaced on the Data screen rather than acted
// on here — a refused request is not a reason to block startup, but it is a
// reason to tell someone their only copy is evictable.
void requestPersistence();

// Seed before first paint so no screen ever renders an empty program and then
// pops. A failure here is fatal and says so rather than showing a blank page.
seedIfNeeded().then(
  () => root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
  (err: unknown) => {
    root.render(
      <div className="app">
        <div className="notice">
          <strong>Could not open the local database.</strong>
          <p className="hint">
            {String(err)}
            <br />
            Private browsing blocks IndexedDB in some browsers. Your data is stored only on
            this device, so there is nothing to recover from a server.
          </p>
        </div>
      </div>,
    );
  },
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
  });
}
