import { useRoute, go } from './lib/route.js';
import { TodayScreen } from './features/today/TodayScreen.js';
import { SessionScreen } from './features/session/SessionScreen.js';
import { HistoryScreen } from './features/history/HistoryScreen.js';
import { VolumeScreen } from './features/volume/VolumeScreen.js';
import { BodyScreen } from './features/body/BodyScreen.js';
import { IntakeScreen } from './features/body/IntakeScreen.js';
import { SetupScreen } from './features/body/SetupScreen.js';
import { DataScreen } from './features/data/DataScreen.js';

/** Top-level tabs. Intake and setup hang off Body rather than sitting here. */
const TABS = [
  { path: '/', label: 'Today', routes: ['today', 'session', 'history'] },
  { path: '/volume', label: 'Volume', routes: ['volume'] },
  { path: '/body', label: 'Body', routes: ['body', 'intake', 'setup'] },
  { path: '/data', label: 'Data', routes: ['data'] },
] as const;

export function App() {
  const route = useRoute();

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => go('/')} aria-label="overload, home">
          overload
        </button>
        <nav className="nav">
          {TABS.map((tab) => (
            <button
              key={tab.path}
              onClick={() => go(tab.path)}
              aria-current={
                (tab.routes as readonly string[]).includes(route.name) ? 'page' : undefined
              }
            >
              {tab.label}
            </button>
          ))}
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
      {route.name === 'volume' && <VolumeScreen />}
      {route.name === 'body' && <BodyScreen />}
      {route.name === 'intake' && <IntakeScreen />}
      {route.name === 'setup' && <SetupScreen />}
      {route.name === 'data' && <DataScreen />}
    </div>
  );
}
