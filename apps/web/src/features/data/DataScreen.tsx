/**
 * Export, import, and the honest statement of where the data lives.
 *
 * There is no server, so there is no "restore from account". The export file is
 * the only backup that exists and the screen says so in those words.
 */
import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db.js';
import { eraseHistory } from '../../db/queries.js';
import { exportAll, downloadBackup, importAll, type ImportResult } from '../../db/backup.js';
import {
  persistenceState,
  requestPersistence,
  storageEstimate,
  type PersistenceState,
} from '../../lib/persistence.js';

export function DataScreen() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [persistence, setPersistence] = useState<PersistenceState | null>(null);
  const [used, setUsed] = useState<string | null>(null);

  useEffect(() => {
    void persistenceState().then(setPersistence);
    void storageEstimate().then((e) => {
      if (e) setUsed(`${(e.usage / 1024 / 1024).toFixed(1)} MB of ${Math.round(e.quota / 1024 / 1024)} MB`);
    });
  }, []);

  const counts = useLiveQuery(async () => ({
    sessions: await db.sessions.count(),
    sets: await db.sets.count(),
    weights: await db.weights.count(),
    intake: await db.intake.count(),
    exercises: await db.exercises.count(),
  }));

  async function onExport() {
    setError(null);
    downloadBackup(await exportAll());
    setMessage('Exported. Put that file somewhere that is not this phone.');
  }

  async function onImportFile(file: File) {
    setError(null);
    setMessage(null);
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const ok = window.confirm(
        'Import replaces everything currently in this browser. Export first if you have not. Continue?',
      );
      if (!ok) return;
      const result: ImportResult = await importAll(parsed);
      setMessage(
        `Imported ${result.sessions} sessions, ${result.sets} sets, ${result.weights} weigh-ins, ` +
          `${result.intake} intake rows, ${result.foodLog} food entries.` +
          (result.format < 3
            ? ` (Format ${result.format} backup — it predates ${result.format < 2 ? 'the calorie' : 'the food'} tables, so those are empty.)`
            : ''),
      );
    } catch (err) {
      // Nothing was written: importAll validates the whole file before the
      // transaction opens, so a rejected file leaves the database untouched.
      setError(`That file was not a valid overload export. Nothing was changed. (${String(err)})`);
    }
  }

  async function onErase() {
    if (
      !window.confirm(
        'Delete every session, set, weigh-in and intake row on this device? No undo.',
      )
    ) {
      return;
    }
    await eraseHistory();
    // The profile and the target survive: they are settings, not history, and
    // erasing them would silently switch the calorie side back off.
    setMessage('History erased. The program, your profile and your target are still here.');
  }

  return (
    <main>
      <section className="sheet">
        <p className="eyebrow">Data</p>
        <h1>On this device only</h1>
        <p className="hint">
          Everything is stored in this browser. No server, no account, nothing leaves the
          device — which also means clearing site data deletes it, and there is nowhere to
          restore it from. Export often.
        </p>

        <dl>
          <div className="stat-row">
            <dt>Sessions</dt>
            <dd>{counts?.sessions ?? '—'}</dd>
          </div>
          <div className="stat-row">
            <dt>Sets</dt>
            <dd>{counts?.sets ?? '—'}</dd>
          </div>
          <div className="stat-row">
            <dt>Weigh-ins</dt>
            <dd>{counts?.weights ?? '—'}</dd>
          </div>
          <div className="stat-row">
            <dt>Intake rows</dt>
            <dd>{counts?.intake ?? '—'}</dd>
          </div>
          <div className="stat-row">
            <dt>Exercises in program</dt>
            <dd>{counts?.exercises ?? '—'}</dd>
          </div>
        </dl>

        <div className="btn-row">
          <button className="btn" onClick={() => void onExport()}>
            Export JSON
          </button>
          <button className="btn" data-tone="quiet" onClick={() => fileInput.current?.click()}>
            Import JSON
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void onImportFile(file);
            }}
          />
        </div>

        {message && <p className="hint">{message}</p>}
        {error && <p className="hint" style={{ color: 'var(--mark)' }}>{error}</p>}
      </section>

      <section className="sheet">
        <p className="eyebrow">Storage</p>
        <dl>
          <div className="stat-row">
            <dt>Eviction protection</dt>
            <dd data-tone={persistence === 'persisted' ? undefined : 'mark'}>
              {persistence === null
                ? '—'
                : persistence === 'persisted'
                  ? 'Granted'
                  : persistence === 'not-persisted'
                    ? 'Not granted'
                    : 'Not supported'}
            </dd>
          </div>
          {used && (
            <div className="stat-row">
              <dt>Used</dt>
              <dd>{used}</dd>
            </div>
          )}
        </dl>

        {persistence !== 'persisted' && (
          <>
            <p className="hint">
              Without this the browser may delete everything to reclaim space. iOS Safari
              clears local storage after seven days without a visit unless the app is
              installed to the home screen. There is no server, so there is nothing to
              restore from — install it, and export regularly.
            </p>
            <div className="btn-row">
              <button
                className="btn"
                onClick={() => void requestPersistence().then(setPersistence)}
              >
                Ask again
              </button>
            </div>
          </>
        )}
      </section>

      <section className="sheet">
        <p className="eyebrow">Danger</p>
        <button className="btn" data-tone="danger" onClick={() => void onErase()}>
          Erase training history
        </button>
      </section>
    </main>
  );
}
