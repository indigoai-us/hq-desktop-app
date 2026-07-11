import { describe, it, expect } from 'vitest';
import {
  paneItems,
  rowUnread,
  defaultSelectedId,
  isAgentSender,
  conversationKey,
  conversationRows,
} from './quickWindowPane';
import type { Item, DmEvent, ShareEvent } from './notificationGroups';

function item(
  id: string,
  kind: Item['kind'],
  ts: number,
  extra: Partial<Item> = {},
): Item {
  return { id, kind, actor: 'A', summary: 's', ts, ...extra };
}

function dmItem(
  id: string,
  ts: number,
  opts: {
    actor?: string;
    summary?: string;
    fromPersonUid?: string;
    fromEmail?: string;
    body?: string;
  } = {},
): Item {
  const dm: DmEvent = {
    eventId: id.replace(/^dm:/, ''),
    fromPersonUid: opts.fromPersonUid ?? '',
    fromEmail: opts.fromEmail ?? '',
    fromDisplayName: opts.actor ?? 'A',
    body: opts.body ?? opts.summary ?? 's',
    createdAt: new Date(ts).toISOString(),
  };
  return {
    id,
    kind: 'dm',
    actor: opts.actor ?? 'A',
    summary: opts.summary ?? opts.body ?? 's',
    ts,
    dm,
  };
}

function shareItem(
  id: string,
  ts: number,
  opts: {
    actor?: string;
    summary?: string;
    issuerPersonUid?: string;
    issuerEmail?: string;
  } = {},
): Item {
  const share: ShareEvent = {
    eventId: id.replace(/^share:/, ''),
    issuerEmail: opts.issuerEmail ?? '',
    issuerDisplayName: opts.actor ?? 'A',
    issuerPersonUid: opts.issuerPersonUid,
    paths: ['x'],
    note: null,
    permission: 'read',
    createdAt: new Date(ts).toISOString(),
  };
  return {
    id,
    kind: 'share',
    actor: opts.actor ?? 'A',
    summary: opts.summary ?? 'shared',
    ts,
    share,
  };
}

describe('paneItems', () => {
  it('keeps only dm and share kinds, preserving order', () => {
    const items: Item[] = [
      item('dm:1', 'dm', 300),
      item('file:1', 'new-file', 200),
      item('share:1', 'share', 100),
      item('dm:2', 'dm', 50),
    ];
    expect(paneItems(items).map((i) => i.id)).toEqual(['dm:1', 'share:1', 'dm:2']);
  });

  it('caps at 30 items', () => {
    const items: Item[] = Array.from({ length: 40 }, (_, i) =>
      item(`dm:${i}`, 'dm', 1000 - i),
    );
    const out = paneItems(items);
    expect(out).toHaveLength(30);
    expect(out[0].id).toBe('dm:0');
    expect(out[29].id).toBe('dm:29');
  });

  it('returns empty when only new-file rows are present', () => {
    expect(paneItems([item('f:1', 'new-file', 1)])).toEqual([]);
  });
});

describe('rowUnread', () => {
  it('is true when newer than watermark and not viewed', () => {
    const it = item('dm:1', 'dm', 100);
    expect(rowUnread(it, 50, new Set())).toBe(true);
  });

  it('viewed overrides unread even when newer than watermark', () => {
    const it = item('dm:1', 'dm', 100);
    expect(rowUnread(it, 50, new Set(['dm:1']))).toBe(false);
  });

  it('watermark boundary: ts equal to lastRead is read', () => {
    const it = item('dm:1', 'dm', 100);
    expect(rowUnread(it, 100, new Set())).toBe(false);
  });

  it('watermark boundary: ts just above lastRead is unread', () => {
    const it = item('dm:1', 'dm', 101);
    expect(rowUnread(it, 100, new Set())).toBe(true);
  });
});

describe('defaultSelectedId', () => {
  it('builds share: and dm: ids', () => {
    expect(defaultSelectedId('share', 'abc')).toBe('share:abc');
    expect(defaultSelectedId('dm', 'xyz')).toBe('dm:xyz');
  });

  it('returns null when eventId is missing', () => {
    expect(defaultSelectedId('share', undefined)).toBeNull();
    expect(defaultSelectedId('dm', undefined)).toBeNull();
    expect(defaultSelectedId('share', '')).toBeNull();
  });
});

describe('isAgentSender', () => {
  it('detects agt_, agent_, and agent: prefixes', () => {
    expect(isAgentSender(dmItem('dm:1', 100, { fromPersonUid: 'agt_bot' }))).toBe(true);
    expect(isAgentSender(dmItem('dm:2', 100, { fromPersonUid: 'agent_helper' }))).toBe(true);
    expect(isAgentSender(dmItem('dm:3', 100, { fromPersonUid: 'agent:worker' }))).toBe(true);
    expect(
      isAgentSender(shareItem('share:1', 100, { issuerPersonUid: 'agt_share' })),
    ).toBe(true);
  });

  it('returns false for person uids and missing uid metadata', () => {
    expect(isAgentSender(dmItem('dm:1', 100, { fromPersonUid: 'prs_izzy' }))).toBe(false);
    expect(isAgentSender(dmItem('dm:2', 100, { fromPersonUid: '' }))).toBe(false);
    expect(isAgentSender(item('dm:3', 'dm', 100))).toBe(false);
    expect(isAgentSender(shareItem('share:1', 100, { issuerPersonUid: 'prs_lizzie' }))).toBe(
      false,
    );
    expect(isAgentSender(shareItem('share:2', 100, {}))).toBe(false);
  });
});

describe('conversationKey', () => {
  it('prefers person uid, then email, then actor', () => {
    expect(
      conversationKey(dmItem('dm:1', 100, { fromPersonUid: 'prs_izzy', fromEmail: 'i@x.y', actor: 'Izzy' })),
    ).toBe('dm:prs_izzy');
    expect(
      conversationKey(dmItem('dm:2', 100, { fromPersonUid: '', fromEmail: 'i@x.y', actor: 'Izzy' })),
    ).toBe('dm:i@x.y');
    expect(
      conversationKey(dmItem('dm:3', 100, { fromPersonUid: '', fromEmail: '', actor: 'Izzy' })),
    ).toBe('dm:Izzy');
    expect(
      conversationKey(
        shareItem('share:1', 100, {
          issuerPersonUid: 'prs_izzy',
          issuerEmail: 'i@x.y',
          actor: 'Izzy',
        }),
      ),
    ).toBe('share:prs_izzy');
    expect(
      conversationKey(
        shareItem('share:2', 100, { issuerPersonUid: '', issuerEmail: 'i@x.y', actor: 'Izzy' }),
      ),
    ).toBe('share:i@x.y');
    expect(
      conversationKey(
        shareItem('share:3', 100, { issuerPersonUid: '', issuerEmail: '', actor: 'Izzy' }),
      ),
    ).toBe('share:Izzy');
  });

  it('keeps dm and share from the same person as distinct keys', () => {
    const dm = dmItem('dm:1', 200, { fromPersonUid: 'prs_izzy', actor: 'Izzy' });
    const share = shareItem('share:1', 100, { issuerPersonUid: 'prs_izzy', actor: 'Izzy' });
    expect(conversationKey(dm)).toBe('dm:prs_izzy');
    expect(conversationKey(share)).toBe('share:prs_izzy');
    expect(conversationKey(dm)).not.toBe(conversationKey(share));
  });
});

describe('conversationRows', () => {
  it('groups 3+2 DMs from two people into exactly two rows with correct latest + unread', () => {
    // Newest-first feed: 3 from Izzy, 2 from Lizzie interleaved by time.
    const items: Item[] = [
      dmItem('dm:i3', 500, { fromPersonUid: 'prs_izzy', actor: 'Izzy', body: 'izzy newest' }),
      dmItem('dm:l2', 400, { fromPersonUid: 'prs_lizzie', actor: 'Lizzie', body: 'lizzie newest' }),
      dmItem('dm:i2', 300, { fromPersonUid: 'prs_izzy', actor: 'Izzy', body: 'izzy mid' }),
      dmItem('dm:l1', 200, { fromPersonUid: 'prs_lizzie', actor: 'Lizzie', body: 'lizzie older' }),
      dmItem('dm:i1', 100, { fromPersonUid: 'prs_izzy', actor: 'Izzy', body: 'izzy oldest' }),
    ];
    const rows = conversationRows(items, 0, new Set());
    expect(rows).toHaveLength(2);
    expect(rows[0].key).toBe('dm:prs_izzy');
    expect(rows[0].latest.id).toBe('dm:i3');
    expect(rows[0].latest.dm?.body).toBe('izzy newest');
    expect(rows[0].unreadCount).toBe(3);
    expect(rows[0].ids).toEqual(['dm:i3', 'dm:i2', 'dm:i1']);
    // Member items ride along (newest-first) so the main pane can render the
    // whole conversation, not just the latest event.
    expect(rows[0].items.map((i) => i.id)).toEqual(['dm:i3', 'dm:i2', 'dm:i1']);
    expect(rows[1].key).toBe('dm:prs_lizzie');
    expect(rows[1].latest.id).toBe('dm:l2');
    expect(rows[1].latest.dm?.body).toBe('lizzie newest');
    expect(rows[1].unreadCount).toBe(2);
    expect(rows[1].ids).toEqual(['dm:l2', 'dm:l1']);
  });

  it('keeps share + dm from the same person as two distinct rows', () => {
    const items: Item[] = [
      dmItem('dm:1', 200, { fromPersonUid: 'prs_izzy', actor: 'Izzy', body: 'hi' }),
      shareItem('share:1', 100, {
        issuerPersonUid: 'prs_izzy',
        actor: 'Izzy',
        summary: 'q2.xlsx',
      }),
    ];
    const rows = conversationRows(items, 0, new Set());
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.key)).toEqual(['dm:prs_izzy', 'share:prs_izzy']);
    expect(rows[0].kind).toBe('dm');
    expect(rows[1].kind).toBe('share');
  });

  it('reduces unreadCount when member ids are in viewedIds', () => {
    const items: Item[] = [
      dmItem('dm:i3', 300, { fromPersonUid: 'prs_izzy', actor: 'Izzy' }),
      dmItem('dm:i2', 200, { fromPersonUid: 'prs_izzy', actor: 'Izzy' }),
      dmItem('dm:i1', 100, { fromPersonUid: 'prs_izzy', actor: 'Izzy' }),
    ];
    const rows = conversationRows(items, 0, new Set(['dm:i3', 'dm:i1']));
    expect(rows).toHaveLength(1);
    expect(rows[0].unreadCount).toBe(1);
  });

  it('falls back to email then actor when uids are missing', () => {
    const items: Item[] = [
      dmItem('dm:e1', 300, { fromPersonUid: '', fromEmail: 'a@x.y', actor: 'A', body: 'email' }),
      dmItem('dm:e2', 200, { fromPersonUid: '', fromEmail: 'a@x.y', actor: 'A', body: 'email2' }),
      dmItem('dm:n1', 100, { fromPersonUid: '', fromEmail: '', actor: 'NoUid', body: 'actor' }),
    ];
    const rows = conversationRows(items, 0, new Set());
    expect(rows).toHaveLength(2);
    expect(rows[0].key).toBe('dm:a@x.y');
    expect(rows[0].ids).toEqual(['dm:e1', 'dm:e2']);
    expect(rows[1].key).toBe('dm:NoUid');
  });

  it('sets agent from isAgentSender(latest)', () => {
    const items: Item[] = [
      dmItem('dm:a1', 200, { fromPersonUid: 'agt_bot', actor: 'Bot' }),
      dmItem('dm:h1', 100, { fromPersonUid: 'prs_izzy', actor: 'Izzy' }),
    ];
    const rows = conversationRows(items, 0, new Set());
    expect(rows[0].agent).toBe(true);
    expect(rows[1].agent).toBe(false);
  });

  it('caps at 30 conversation rows', () => {
    const items: Item[] = Array.from({ length: 40 }, (_, i) =>
      dmItem(`dm:${i}`, 1000 - i, {
        fromPersonUid: `prs_person_${i}`,
        actor: `Person ${i}`,
      }),
    );
    const rows = conversationRows(items, 0, new Set());
    expect(rows).toHaveLength(30);
    expect(rows[0].key).toBe('dm:prs_person_0');
    expect(rows[29].key).toBe('dm:prs_person_29');
  });

  it('filters out non dm/share kinds before grouping', () => {
    const items: Item[] = [
      item('file:1', 'new-file', 300),
      dmItem('dm:1', 200, { fromPersonUid: 'prs_izzy' }),
      item('file:2', 'new-file', 100),
    ];
    const rows = conversationRows(items, 0, new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0].latest.id).toBe('dm:1');
  });
});
