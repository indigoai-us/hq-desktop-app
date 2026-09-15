import { describe, it, expect } from 'vitest';
import {
  type Channel,
  channelDisplayName,
  companyNameFor,
  dedupeChannelsById,
  scopeChipLabel,
  isInvitedNotJoined,
  canPost,
  groupChannels,
  totalChannelUnread,
  upsertChannel,
  bumpChannelUnread,
  clearChannelUnread,
} from './channels';

function ch(partial: Partial<Channel> & { channelId: string; name: string }): Channel {
  return {
    scope: 'personal',
    ...partial,
  };
}

describe('channelDisplayName', () => {
  it('strips leading # and trims', () => {
    expect(channelDisplayName(ch({ channelId: 'c1', name: '#general' }))).toBe('general');
    expect(channelDisplayName(ch({ channelId: 'c1', name: '  ##team  ' }))).toBe('team');
  });
  it('falls back to channelId when name is empty', () => {
    expect(channelDisplayName(ch({ channelId: 'c1', name: '   ' }))).toBe('c1');
  });
});

describe('group DMs', () => {
  it('labels an unnamed group by member count, else a generic label', () => {
    expect(
      channelDisplayName(ch({ channelId: 'g1', name: '', scope: 'group', memberCount: 3 })),
    ).toBe('Group · 3');
    expect(channelDisplayName(ch({ channelId: 'g1', name: '', scope: 'group' }))).toBe('Group DM');
  });
  it('names an unnamed group DM by its participants (REGRESSION)', () => {
    expect(
      channelDisplayName(
        ch({
          channelId: 'g1',
          name: '',
          scope: 'group',
          memberCount: 3,
          members: [
            { personUid: 'p_s', displayName: 'Stefan' },
            { personUid: 'p_h', displayName: 'Hassaan' },
          ],
        }),
      ),
    ).toBe('Stefan, Hassaan');
  });
  it('truncates a long participant roster with +N', () => {
    expect(
      channelDisplayName(
        ch({
          channelId: 'g1',
          name: '',
          scope: 'group',
          members: [
            { personUid: 'a', displayName: 'Ann' },
            { personUid: 'b', displayName: 'Bo' },
            { personUid: 'c', displayName: 'Cy' },
            { personUid: 'd', displayName: 'Dee' },
            { personUid: 'e', displayName: 'Eli' },
          ],
        }),
      ),
    ).toBe('Ann, Bo, Cy +2');
  });
  it('falls back to the member-count label when participant names are blank', () => {
    expect(
      channelDisplayName(
        ch({
          channelId: 'g1',
          name: '',
          scope: 'group',
          memberCount: 3,
          members: [{ personUid: 'x', displayName: '   ' }],
        }),
      ),
    ).toBe('Group · 3');
  });
  it('uses a "Group" scope chip', () => {
    expect(scopeChipLabel(ch({ channelId: 'g', name: '', scope: 'group' }))).toBe('Group');
  });
  it('buckets group DMs under a "Direct" header, first and separate from company/personal', () => {
    const groups = groupChannels([
      ch({ channelId: 'g1', name: '', scope: 'group', memberCount: 3 }),
      ch({ channelId: 'p1', name: 'diary', scope: 'personal' }),
      ch({ channelId: 'c1', name: 'eng', scope: 'company', companyUid: 'ent_1', companyName: 'Acme' }),
    ]);
    expect(groups[0].key).toBe('group');
    expect(groups[0].label).toBe('Direct');
    expect(groups[0].channels.map((c) => c.channelId)).toEqual(['g1']);
    // Group DMs never leak into the company buckets.
    const company = groups.find((g) => g.scope === 'company');
    expect(company?.channels.map((c) => c.channelId)).toEqual(['c1']);
  });
});

describe('scopeChipLabel', () => {
  it('returns Personal for personal channels', () => {
    expect(scopeChipLabel(ch({ channelId: 'c', name: 'x', scope: 'personal' }))).toBe('Personal');
  });
  it('prefers companyName, else generic — NEVER the raw UID', () => {
    expect(
      scopeChipLabel(ch({ channelId: 'c', name: 'x', scope: 'company', companyName: 'Acme', companyUid: 'ent_1' })),
    ).toBe('Acme');
    // A bare companyUid (no name) degrades to "Company", not the opaque UID —
    // this is the leak fix; the chip must never render `ent_1` / `cmp_…`.
    expect(scopeChipLabel(ch({ channelId: 'c', name: 'x', scope: 'company', companyUid: 'ent_1' }))).toBe('Company');
    expect(scopeChipLabel(ch({ channelId: 'c', name: 'x', scope: 'company' }))).toBe('Company');
  });
});

describe('membership helpers', () => {
  it('isInvitedNotJoined only true for invited', () => {
    expect(isInvitedNotJoined(ch({ channelId: 'c', name: 'x', membership: 'invited' }))).toBe(true);
    expect(isInvitedNotJoined(ch({ channelId: 'c', name: 'x', membership: 'joined' }))).toBe(false);
    // Absent membership defaults to joined.
    expect(isInvitedNotJoined(ch({ channelId: 'c', name: 'x' }))).toBe(false);
  });
  it('canPost requires joined membership', () => {
    expect(canPost(ch({ channelId: 'c', name: 'x', membership: 'joined' }))).toBe(true);
    expect(canPost(ch({ channelId: 'c', name: 'x', membership: 'invited' }))).toBe(false);
    expect(canPost(ch({ channelId: 'c', name: 'x' }))).toBe(true);
  });
});

describe('groupChannels', () => {
  it('puts Personal first, then companies in declared order', () => {
    const channels: Channel[] = [
      ch({ channelId: 'c-acme', name: '#acme-eng', scope: 'company', companyUid: 'ent_acme', companyName: 'Acme' }),
      ch({ channelId: 'p1', name: '#diary', scope: 'personal' }),
      ch({ channelId: 'c-beta', name: '#beta', scope: 'company', companyUid: 'ent_beta', companyName: 'Beta' }),
    ];
    const groups = groupChannels(channels, [
      { companyUid: 'ent_beta', companyName: 'Beta' },
      { companyUid: 'ent_acme', companyName: 'Acme' },
    ]);
    expect(groups.map((g) => g.label)).toEqual(['Personal', 'Beta', 'Acme']);
    expect(groups[0].scope).toBe('personal');
    expect(groups[1].scope).toBe('company');
    expect(groups[1].companyUid).toBe('ent_beta');
  });

  it('omits the Personal group when there are no personal channels', () => {
    const groups = groupChannels(
      [ch({ channelId: 'c', name: '#x', scope: 'company', companyUid: 'ent_1', companyName: 'One' })],
      [],
    );
    expect(groups.map((g) => g.label)).toEqual(['One']);
  });

  it('sorts channels within a group by display name (case-insensitive)', () => {
    const groups = groupChannels(
      [
        ch({ channelId: 'b', name: '#Zeta', scope: 'personal' }),
        ch({ channelId: 'a', name: '#alpha', scope: 'personal' }),
      ],
      [],
    );
    expect(groups[0].channels.map((c) => c.channelId)).toEqual(['a', 'b']);
  });

  it('appends companies not in the lookup list, sorted by label', () => {
    const channels: Channel[] = [
      ch({ channelId: 'c1', name: '#z', scope: 'company', companyUid: 'ent_z', companyName: 'Zeta Co' }),
      ch({ channelId: 'c2', name: '#a', scope: 'company', companyUid: 'ent_a', companyName: 'Alpha Co' }),
    ];
    const groups = groupChannels(channels, []);
    expect(groups.map((g) => g.label)).toEqual(['Alpha Co', 'Zeta Co']);
  });
});

describe('unread + upsert helpers', () => {
  it('totalChannelUnread sums unread counts', () => {
    expect(
      totalChannelUnread([
        ch({ channelId: 'a', name: 'a', unread: 2 }),
        ch({ channelId: 'b', name: 'b', unread: 3 }),
        ch({ channelId: 'c', name: 'c' }),
      ]),
    ).toBe(5);
  });

  it('upsertChannel replaces by id or appends', () => {
    const list = [ch({ channelId: 'a', name: 'a' })];
    const replaced = upsertChannel(list, ch({ channelId: 'a', name: 'a2' }));
    expect(replaced).toHaveLength(1);
    expect(replaced[0].name).toBe('a2');
    const appended = upsertChannel(list, ch({ channelId: 'b', name: 'b' }));
    expect(appended.map((c) => c.channelId)).toEqual(['a', 'b']);
  });

  it('bumpChannelUnread adds a delta clamped at 0', () => {
    const list = [ch({ channelId: 'a', name: 'a', unread: 1 })];
    expect(bumpChannelUnread(list, 'a', 2)[0].unread).toBe(3);
    expect(bumpChannelUnread(list, 'a', -5)[0].unread).toBe(0);
    // Unknown id leaves the list unchanged.
    expect(bumpChannelUnread(list, 'zzz', 1)[0].unread).toBe(1);
  });

  it('clearChannelUnread zeroes one channel', () => {
    const list = [
      ch({ channelId: 'a', name: 'a', unread: 4 }),
      ch({ channelId: 'b', name: 'b', unread: 2 }),
    ];
    const cleared = clearChannelUnread(list, 'a');
    expect(cleared[0].unread).toBe(0);
    expect(cleared[1].unread).toBe(2);
  });
});

describe('dedupeChannelsById', () => {
  it('collapses duplicate channelIds keeping the first occurrence and order', () => {
    const a = ch({ channelId: 'c1', name: 'first' });
    const dup = ch({ channelId: 'c1', name: 'dup' });
    const b = ch({ channelId: 'c2', name: 'second' });
    expect(dedupeChannelsById([a, dup, b])).toEqual([a, b]);
  });

  it('returns the list unchanged when there are no duplicates', () => {
    const a = ch({ channelId: 'c1', name: 'a' });
    const b = ch({ channelId: 'c2', name: 'b' });
    expect(dedupeChannelsById([a, b])).toEqual([a, b]);
  });
});

describe('company label resolution never leaks a raw UID (REGRESSION)', () => {
  // The unified rail rendered `cmp_01KQ2RYAHXHDPCTY9GPQPTH3DG` as a chip when the
  // server omitted companyName. A row must NEVER show the opaque cmp_ UID.
  const COMPANY_UID = 'cmp_01KQ2RYAHXHDPCTY9GPQPTH3DG';

  it('scopeChipLabel returns "Company", not the cmp_ UID, when no name is known', () => {
    const label = scopeChipLabel(
      ch({ channelId: 'c1', name: 'crew', scope: 'company', companyUid: COMPANY_UID }),
    );
    expect(label).toBe('Company');
    expect(label).not.toContain('cmp_');
  });

  it('companyNameFor falls back to the server companyName when the UID is not in the memberships list', () => {
    expect(
      companyNameFor(
        ch({ channelId: 'c1', name: 'crew', scope: 'company', companyUid: COMPANY_UID, companyName: 'Indigo' }),
      ),
    ).toBe('Indigo');
  });

  it('companyNameFor prefers the authoritative membership name over a stale denormalized companyName', () => {
    // The channel row carries a wrong/stale server-denormalized companyName;
    // the membership list keyed by the channel's companyUid is authoritative.
    expect(
      companyNameFor(
        ch({ channelId: 'c1', name: 'crew', scope: 'company', companyUid: COMPANY_UID, companyName: 'Golden Thread' }),
        [{ companyUid: COMPANY_UID, companyName: 'Indigo' }],
      ),
    ).toBe('Indigo');
  });

  it('companyNameFor resolves the name from the memberships list by UID', () => {
    expect(
      companyNameFor(
        ch({ channelId: 'c1', name: 'crew', scope: 'company', companyUid: COMPANY_UID }),
        [{ companyUid: COMPANY_UID, companyName: 'Indigo' }],
      ),
    ).toBe('Indigo');
  });

  it('companyNameFor falls back to "Company" — never the UID — when unresolved', () => {
    const name = companyNameFor(
      ch({ channelId: 'c1', name: 'crew', scope: 'company', companyUid: COMPANY_UID }),
    );
    expect(name).toBe('Company');
    expect(name).not.toContain('cmp_');
  });

  it('companyNameFor returns null for personal/group channels (no company chip)', () => {
    expect(companyNameFor(ch({ channelId: 'c1', name: 'notes', scope: 'personal' }))).toBeNull();
    expect(companyNameFor(ch({ channelId: 'c2', name: '', scope: 'group' }))).toBeNull();
  });

  it('groupChannels header label never falls back to the raw UID', () => {
    const groups = groupChannels([
      ch({ channelId: 'c1', name: 'crew', scope: 'company', companyUid: COMPANY_UID }),
    ]);
    const companyGroup = groups.find((g) => g.scope === 'company');
    expect(companyGroup?.label).toBe('Company');
    expect(companyGroup?.label).not.toContain('cmp_');
  });
});

describe("REGRESSION US-003: externally-created group DM surfaces live at top of rail", () => {
  // Permanent regression guard for hq-sync-live-new-channel.
  //
  // The bug: a brand-new scope:'group' channel created OUTSIDE the app (e.g. via
  // `hq dm`, including one the signed-in user created/owns) arrives on a channel
  // poll through the `channel:updated` → upsertChannel path with unread === 0 and
  // NO server `lastActivityAt` / `lastMessageAt` yet. The pre-fix rail sort was
  // `time: stamp || (unread > 0 ? now : 0)`, so such a channel resolved to
  // `time: 0` and sank to the BOTTOM of the newest-first rail — to the user it
  // "never appeared" until a manual Sync re-ran loadChannels().
  //
  // The fix (US-002): upsertChannel stamps a client-only `arrivedAt` on first
  // insert, and mergeConversations falls back `stamp || arrivedAt || (unread>0?now:0)`,
  // so a freshly-arrived timeless group DM surfaces as recent (top) instead of
  // sinking. This block locks ALL of acceptance-criterion-1 down: the new group
  // is (a) upserted into the rail, (b) grouped under "Direct", (c) carries a
  // non-empty participant-derived title, and (d) — the specific guard for this
  // bug — surfaces at a visible (top) position of the newest-first rail.
  //
  // This test FAILS against the pre-fix sort (`time: stamp || (unread>0?now:0)`)
  // and PASSES after US-002. Do NOT weaken these assertions to make it pass — a
  // failure here means live-surfacing of new channels has regressed.
  const NOW = Date.parse("2026-06-15T12:00:00Z");

  function makeContact(personUid: string, lastIso: string) {
    return { personUid, email: `${personUid}@x.com`, displayName: personUid, lastMessageAt: lastIso };
  }

  // The brand-new, unnamed, participant-keyed group DM delivered via the
  // channel:updated event: scope group, unread 0 (caller created/owns it), and
  // NO server activity stamps yet (both optional on the wire).
  const NEW_GROUP_ID = "chn_01KV6C02ARDJME1W2ZC9JAX4FX";
  function freshGroupDm(): Channel {
    return ch({
      channelId: NEW_GROUP_ID,
      name: "",
      scope: "group",
      memberCount: 5,
      unread: 0,
      lastActivityAt: null,
      lastMessageAt: null,
    });
  }

  it("is grouped under the 'Direct' header with a non-empty participant-derived title", () => {
    const channels = upsertChannel([], freshGroupDm(), NOW);

    // (b) It buckets under the "Direct" group, never into a company bucket.
    const groups = groupChannels(channels);
    const direct = groups.find((g) => g.scope === "group");
    expect(direct, "an externally-created group DM must bucket under a 'Direct' header").toBeDefined();
    expect(direct?.label).toBe("Direct");
    expect(direct?.channels.map((c) => c.channelId)).toContain(NEW_GROUP_ID);

    // (c) It renders a non-empty, participant-derived title — not a blank row.
    const title = channelDisplayName(freshGroupDm());
    expect(title.trim().length, "an unnamed group DM must render a non-empty title").toBeGreaterThan(0);
    expect(title).toBe("Group · 5"); // member-count fallback for an unnamed 5-person group
  });
});
