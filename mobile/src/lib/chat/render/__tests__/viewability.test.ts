/**
 * work-2doq review: a frame taller than twice the viewport must still count as
 * shown. Exercises React Native's own ViewabilityHelper (the predicate FlatList
 * uses) with SHOWN_ON_SCREEN_CONFIGS, and the union that merges them.
 */

import { SHOWN_ON_SCREEN_CONFIGS, createViewableUnion } from '../viewability';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ViewabilityHelper = require('@react-native/virtualized-lists/Lists/ViewabilityHelper').default;

const VIEWPORT = 600;

/** Indices viewable under the union of the configs, for items laid out as [offset, length]. */
function shownIndices(cells: [number, number][], scrollOffset: number): number[] {
  const props = { data: cells, getItemCount: (d: unknown[]) => d.length };
  const listMetrics = {
    getCellMetrics: (i: number) => ({ offset: cells[i][0], length: cells[i][1], isMounted: true }),
  };
  const all = new Set<number>();
  for (const config of SHOWN_ON_SCREEN_CONFIGS) {
    const helper = new ViewabilityHelper(config);
    for (const i of helper.computeViewableItems(props, scrollOffset, VIEWPORT, listMetrics)) all.add(i);
  }
  return [...all].sort((a, b) => a - b);
}

describe('SHOWN_ON_SCREEN_CONFIGS (RN ViewabilityHelper)', () => {
  it('a frame taller than 2x the viewport that fills the screen counts as shown', () => {
    // item 1: 2000px tall starting at 100; scrolled so it covers the whole viewport
    const cells: [number, number][] = [
      [0, 100],
      [100, 2000],
      [2100, 100],
    ];
    expect(shownIndices(cells, 800)).toEqual([1]);
    // Item-relative alone would miss it: 600/2000 = 30% < 50%.
    const itemOnly = new ViewabilityHelper(SHOWN_ON_SCREEN_CONFIGS[0]).computeViewableItems(
      { data: cells, getItemCount: (d: unknown[]) => d.length },
      800,
      VIEWPORT,
      { getCellMetrics: (i: number) => ({ offset: cells[i][0], length: cells[i][1], isMounted: true }) },
    );
    expect(itemOnly).toEqual([]);
  });

  it('a tall frame covering under half the viewport and under half of itself is not shown', () => {
    const cells: [number, number][] = [
      [0, 1000],
      [1000, 2000],
    ];
    // item 1 shows its top 200px (of 2000) in the viewport: 10% of item, 33% of viewport
    expect(shownIndices(cells, 1000 - 400)).not.toContain(1);
  });

  it('a short frame half on screen counts; a sliver does not', () => {
    const cells: [number, number][] = [
      [0, 550],
      [550, 100],
    ];
    expect(shownIndices(cells, 0)).toContain(1); // 50 of 100px visible
    expect(shownIndices(cells, -40)).not.toContain(1); // 10 of 100px visible
  });
});

describe('createViewableUnion', () => {
  it('emits the de-duplicated union of each config’s latest set', () => {
    const emitted: string[][] = [];
    const union = createViewableUnion<{ id: string }>(2, (i) => i.id, (items) => emitted.push(items.map((i) => i.id)));
    union.update(0, [{ id: 'a' }, { id: 'b' }]);
    union.update(1, [{ id: 'b' }, { id: 'c' }]);
    union.update(0, []);
    expect(emitted).toEqual([['a', 'b'], ['a', 'b', 'c'], ['b', 'c']]);
  });
});
