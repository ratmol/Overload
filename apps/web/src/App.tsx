import { useRoute, go } from './lib/route.js';
import { TodayScreen } from './features/today/TodayScreen.js';
import { SessionScreen } from './features/session/SessionScreen.js';
import { HistoryScreen } from './features/history/HistoryScreen.js';
import { DataScreen } from './features/data/DataScreen.js';

export function App() {
  const route = useRoute();

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => go('/')} aria-label="overload, home">
          overload
        </button>
        <nav className="nav">
          <button
            onClick={() => go('/')}
            aria-current={route.name === 'today' ? 'page' : undefined}
          >
            Today
          </button>
          <button
            onClick={() => go('/data')}
            aria-current={route.name === 'data' ? 'page' : undefined}
          >
            Data
          </button>
        </nav>
      </header>

      {route.name === 'today' && <TodayScreen />}
      {route.name === 'session' && (
        <SessionScreen
          key={`${route.templateId}:${route.date}`}
          templateId={route.templateId}
          date={route.date}
        />
      )}
      {route.name === 'history' && <HistoryScreen exerciseId={route.exerciseId} />}
      {route.name === 'data' && <DataScreen />}
    </div>
  );
}
