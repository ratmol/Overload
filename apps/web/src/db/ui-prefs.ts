/**
 * Reads and writes for `UiPrefs` — see its own comment in db.ts for why this
 * is a screen preference and not plan data.
 */
import { db } from './db.js';

/**
 * `baseOrder` (every known template id, in the order Today would show them
 * with no preference set — plan order, hand-added days last) rearranged by
 * whatever the user has manually moved.
 *
 * An id in the saved preference that is no longer in `baseOrder` (a template
 * a plan migration removed) is silently dropped rather than left dangling.
 * An id in `baseOrder` the preference has never seen — a new install, or a
 * day a later plan version added — is appended in `baseOrder`'s own order,
 * so nothing new is ever invisible just for not having been arranged yet.
 */
export async function orderedTemplateIds(baseOrder: readonly string[]): Promise<string[]> {
  const known = new Set(baseOrder);
  const saved = (await db.uiPrefs.get('current'))?.templateOrder ?? [];
  const custom = saved.filter((id) => known.has(id));
  const placed = new Set(custom);
  const rest = baseOrder.filter((id) => !placed.has(id));
  return [...custom, ...rest];
}

/**
 * Swaps a template with its neighbour one position up or down, and saves the
 * WHOLE resulting order (not just the moved id) — the simplest thing that
 * keeps every future `orderedTemplateIds` call a straight lookup rather than
 * a merge. A no-op at either edge of the list.
 */
export async function moveTemplateInDisplayOrder(
  currentDisplayOrder: readonly string[],
  templateId: string,
  direction: -1 | 1,
): Promise<void> {
  const i = currentDisplayOrder.indexOf(templateId);
  const j = i + direction;
  if (i === -1 || j < 0 || j >= currentDisplayOrder.length) return;
  const next = [...currentDisplayOrder];
  const moved = next[i]!;
  next[i] = next[j]!;
  next[j] = moved;
  await db.uiPrefs.put({ id: 'current', templateOrder: next });
}
