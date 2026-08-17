import { describe, expect, it } from 'vitest';
import { getVisibleSidebarRows } from './sidebar-visibility';

const rows = Array.from({ length: 12 }, (_, index) => ({ id: index + 1, active: index === 10 }));

describe('sidebar company visibility', () => {
  it('caps the collapsed list while keeping the active company visible', () => {
    expect(getVisibleSidebarRows(rows, false, 7).map((row) => row.id)).toEqual([
      1, 2, 3, 4, 5, 6, 11,
    ]);
  });

  it('returns every row when expanded', () => {
    expect(getVisibleSidebarRows(rows, true, 7)).toHaveLength(12);
  });
});
