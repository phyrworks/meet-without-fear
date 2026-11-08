/**
 * "Shown on screen" for chat list items (work-2doq).
 *
 * An item counts as shown when, for SHOWN_MIN_MS, at least half of it is
 * on screen OR it covers at least half of the viewport. The second test
 * matters for tall items: a frame taller than twice the viewport (small
 * phone, keyboard up) can never be 50% visible, yet it fills the screen.
 *
 * FlatList takes exactly one threshold per viewability config, so the list
 * runs one config per test (`viewabilityConfigCallbackPairs`), and
 * `createViewableUnion` merges their results into one viewable set.
 */

/** How long an item must stay shown before it counts. */
export const SHOWN_MIN_MS = 300;

/** The two FlatList viewability configs whose union is "shown on screen". */
export const SHOWN_ON_SCREEN_CONFIGS = [
  { itemVisiblePercentThreshold: 50, minimumViewTime: SHOWN_MIN_MS },
  { viewAreaCoveragePercentThreshold: 50, minimumViewTime: SHOWN_MIN_MS },
] as const;

/**
 * Merge the viewable sets reported by several viewability configs.
 * `update(i, items)` records config i's latest viewable items and calls
 * `emit` with the union (de-duplicated by `keyOf`, first occurrence wins).
 */
export function createViewableUnion<T>(
  count: number,
  keyOf: (item: T) => string,
  emit: (items: T[]) => void,
): { update(index: number, items: T[]): void } {
  const latest: T[][] = Array.from({ length: count }, () => []);
  return {
    update(index, items) {
      latest[index] = items;
      const seen = new Set<string>();
      const union: T[] = [];
      for (const list of latest) {
        for (const item of list) {
          const key = keyOf(item);
          if (seen.has(key)) continue;
          seen.add(key);
          union.push(item);
        }
      }
      emit(union);
    },
  };
}
