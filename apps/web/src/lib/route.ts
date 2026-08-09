/**
 * Hash routing, hand-rolled.
 *
 * Three routes do not justify a router dependency, and the hash specifically
 * means the app works from any static host and any subdirectory without a
 * rewrite rule — including a file:// copy of the build, which is a real
 * fallback when the phone has no signal and the deploy is down.
 */
import { useEffect, useState } from 'react';
import type { IsoDate } from '@overload/engine';

export type Route =
  | { name: 'today' }
  | { name: 'session'; templateId: string; date: IsoDate }
  | { name: 'history'; exerciseId: string }
  | { name: 'volume' }
  | { name: 'body' }
  | { name: 'intake' }
  | { name: 'setup' }
  | { name: 'data' };

const SIMPLE = ['volume', 'body', 'intake', 'setup', 'data'] as const;

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'session' && parts[1] && parts[2]) {
    return { name: 'session', templateId: parts[1], date: parts[2] };
  }
  if (parts[0] === 'history' && parts[1]) return { name: 'history', exerciseId: parts[1] };
  const simple = SIMPLE.find((name) => name === parts[0]);
  if (simple) return { name: simple };
  return { name: 'today' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function go(path: string): void {
  window.location.hash = path;
}
