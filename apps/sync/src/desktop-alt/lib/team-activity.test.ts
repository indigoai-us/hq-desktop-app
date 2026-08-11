import { describe, expect, it } from 'vitest';
import {
  TEAM_ACTIVITY_WINDOW_DAYS,
  formatVaultBytes,
  hasTeamActivity,
  normalizeTeamActivity,
  teamActivitySummaryLine,
  teamActivityWindowLabel,
  teamMemberRows,
} from './team-activity';

describe('normalizeTeamActivity', () => {
  it('parses the extended US-019 payload with membersDetail + vaultBytes', () => {
    const a = normalizeTeamActivity({
      stats: {
        files7: 12,
        edits7: 34,
        members: 5,
        vaultSize: '1.2 GB',
        vaultBytes: 1_288_490_188,
      },
      sparkline: [0, 2, 4],
      top: [{ who: 'Ada Lovelace', edits: 20 }],
      membersDetail: [
        { who: 'ada@example.com', edits: 20, bytes: 900_000 },
        { who: 'grace@example.com', edits: 14, bytes: 400_000 },
      ],
    });

    expect(a.stats.edits7).toBe(34);
    expect(a.stats.vaultBytes).toBe(1_288_490_188);
    expect(a.membersDetail).toEqual([
      { who: 'ada@example.com', edits: 20, bytes: 900_000 },
      { who: 'grace@example.com', edits: 14, bytes: 400_000 },
    ]);
    expect(a.sparkline).toEqual([0, 2, 4]);
  });

  it('leaves membersDetail and vaultBytes undefined on today\'s production payload', () => {
    const a = normalizeTeamActivity({
      stats: {
        files7: 3,
        edits7: 8,
        members: 2,
        vaultSize: '512 KB',
      },
      sparkline: [0, 1, 0],
      top: [
        { who: '', edits: 3 },
        { who: 'Bob', edits: 5 },
      ],
    });

    expect(a.stats.vaultSize).toBe('512 KB');
    expect(a.stats.vaultBytes).toBeUndefined();
    expect(a.membersDetail).toBeUndefined();
    expect(a.top[0].who).toBe('');
    expect(a.top[1].who).toBe('Bob');
  });

  it('coerces garbage input to a clean empty activity without throwing', () => {
    expect(() => normalizeTeamActivity(null)).not.toThrow();
    expect(() => normalizeTeamActivity(undefined)).not.toThrow();
    expect(() => normalizeTeamActivity('nope')).not.toThrow();
    expect(() => normalizeTeamActivity({ stats: 'x', top: 1, sparkline: {} })).not.toThrow();

    const a = normalizeTeamActivity({
      stats: { files7: 'x', edits7: NaN, members: -1, vaultBytes: -5 },
      top: [{ who: 9, edits: 'y' }],
      membersDetail: 'not-an-array',
      sparkline: [1, '2', null],
    });

    expect(a.stats.files7).toBe(0);
    expect(a.stats.edits7).toBe(0);
    expect(a.stats.vaultBytes).toBeUndefined();
    expect(a.membersDetail).toBeUndefined();
    expect(a.top).toEqual([{ who: '', edits: 0 }]);
    expect(a.sparkline).toEqual([1, 0, 0]);
  });
});

describe('formatVaultBytes / teamActivitySummaryLine', () => {
  it('formats GB with one decimal when >= 0.95 GB, else MB/KB/B', () => {
    expect(formatVaultBytes(0)).toBe('');
    expect(formatVaultBytes(512)).toBe('512 B');
    expect(formatVaultBytes(2048)).toBe('2 KB');
    expect(formatVaultBytes(512 * 1024 * 1024)).toBe('512 MB');
    expect(formatVaultBytes(1.2 * 1024 ** 3)).toBe('1.2 GB');
    // Threshold: >= 0.95 GB uses the GB unit (one decimal).
    expect(formatVaultBytes(0.95 * 1024 ** 3)).toMatch(/^\d+\.\d GB$/);
    expect(formatVaultBytes(1024 ** 3)).toBe('1.0 GB');
  });

  it('composes the summary from non-zero parts and prefers vaultBytes', () => {
    expect(
      teamActivitySummaryLine({
        stats: { files7: 12, edits7: 34, members: 5, vaultSize: 'old', vaultBytes: 512 * 1024 * 1024 },
        sparkline: [],
        top: [],
      }),
    ).toBe('34 edits · 12 files · 5 members · 512 MB');

    expect(
      teamActivitySummaryLine({
        stats: { files7: 0, edits7: 0, members: 0, vaultSize: '1.2 MB' },
        sparkline: [],
        top: [],
      }),
    ).toBe('1.2 MB');

    expect(
      teamActivitySummaryLine({
        stats: { files7: 0, edits7: 0, members: 0, vaultSize: '' },
        sparkline: [],
        top: [],
      }),
    ).toBe('');
  });
});

describe('teamMemberRows', () => {
  it('prefers non-empty membersDetail over top', () => {
    const rows = teamMemberRows({
      stats: { files7: 0, edits7: 0, members: 0, vaultSize: '' },
      sparkline: [],
      top: [{ who: 'FromTop', edits: 99 }],
      membersDetail: [{ who: 'ada.lovelace@example.com', edits: 3, bytes: 100 }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Ada Lovelace');
    expect(rows[0].email).toBe('ada.lovelace@example.com');
    expect(rows[0].edits).toBe(3);
    expect(rows[0].meta).toBe('updated 3 files');
  });

  it('falls back to top when membersDetail is absent or empty', () => {
    const rows = teamMemberRows({
      stats: { files7: 0, edits7: 0, members: 0, vaultSize: '' },
      sparkline: [],
      top: [
        { who: 'grace_hopper@x.com', edits: 1 },
        { who: 'Bob', edits: 5 },
        { who: '', edits: 0 },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: 'Grace Hopper',
      email: 'grace_hopper@x.com',
      meta: 'updated 1 file',
      edits: 1,
    });
    expect(rows[1]).toMatchObject({ name: 'Bob', email: '', edits: 5 });
  });

  it('derives name from email local-part and uses Unknown for empty who', () => {
    const rows = teamMemberRows({
      stats: { files7: 0, edits7: 0, members: 0, vaultSize: '' },
      sparkline: [],
      top: [{ who: '', edits: 4 }],
    });
    expect(rows[0].name).toBe('Unknown');
    expect(rows[0].email).toBe('');
  });
});

describe('hasTeamActivity / window label', () => {
  it('detects activity from top, membersDetail, sparkline, or edits7', () => {
    expect(
      hasTeamActivity({
        stats: { files7: 0, edits7: 0, members: 0, vaultSize: '' },
        sparkline: [],
        top: [],
      }),
    ).toBe(false);

    expect(
      hasTeamActivity({
        stats: { files7: 0, edits7: 2, members: 0, vaultSize: '' },
        sparkline: [],
        top: [],
      }),
    ).toBe(true);

    expect(
      hasTeamActivity({
        stats: { files7: 0, edits7: 0, members: 0, vaultSize: '' },
        sparkline: [0, 1, 0],
        top: [],
      }),
    ).toBe(true);

    expect(
      hasTeamActivity({
        stats: { files7: 0, edits7: 0, members: 0, vaultSize: '' },
        sparkline: [],
        top: [{ who: 'x', edits: 1 }],
      }),
    ).toBe(true);

    expect(
      hasTeamActivity({
        stats: { files7: 0, edits7: 0, members: 0, vaultSize: '' },
        sparkline: [],
        top: [],
        membersDetail: [{ who: 'a@b.c', edits: 1, bytes: 0 }],
      }),
    ).toBe(true);
  });

  it('labels the window and exports the default day count', () => {
    expect(TEAM_ACTIVITY_WINDOW_DAYS).toBe(7);
    expect(teamActivityWindowLabel(7)).toBe('Team vault · last 7 days');
    expect(teamActivityWindowLabel(14)).toBe('Team vault · last 14 days');
  });
});
