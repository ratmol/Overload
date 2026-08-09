/**
 * Ask the browser not to evict the database.
 *
 * iOS Safari deletes IndexedDB after seven days without interaction unless the
 * site is installed to the home screen. For an app whose entire premise is that
 * there is no server, eviction is not a degraded experience — it is total,
 * silent data loss with nothing to restore from.
 *
 * `persist()` is a request, not a guarantee, and browsers grant it on their own
 * criteria (installed to home screen, bookmarked, high engagement). So the
 * result is reported rather than assumed: the Data screen shows what the
 * browser actually said, because "your data is safe" is not a claim to make on
 * the strength of a function call that returns false.
 */
export type PersistenceState = 'persisted' | 'not-persisted' | 'unsupported';

export async function requestPersistence(): Promise<PersistenceState> {
  if (!navigator.storage?.persist) return 'unsupported';
  try {
    // Already granted? Asking again can prompt on some browsers.
    if (await navigator.storage.persisted?.()) return 'persisted';
    return (await navigator.storage.persist()) ? 'persisted' : 'not-persisted';
  } catch {
    return 'unsupported';
  }
}

export async function persistenceState(): Promise<PersistenceState> {
  if (!navigator.storage?.persisted) return 'unsupported';
  try {
    return (await navigator.storage.persisted()) ? 'persisted' : 'not-persisted';
  } catch {
    return 'unsupported';
  }
}

/** Approximate bytes used, when the browser will say. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return usage === undefined || quota === undefined ? null : { usage, quota };
  } catch {
    return null;
  }
}
