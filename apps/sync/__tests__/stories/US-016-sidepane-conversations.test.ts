//
// US-016: Side pane groups by conversation + type/sender visual hierarchy.
// Source-contract (readFileSync) + pure-function behavioral tests.
// No Date.now() dependence — fixed numeric timestamps only.
//
// e2eTests from the PRD:
// 1. 3 messages from Izzy + 2 from Lizzie → exactly two rows, latest preview, unread 3/2.
// 2. Type distinction: badgeCount/agentActor wiring + share icon tint + unread-count testid.
// 3. Agent marking: isAgentSender + agent-badge gated on agentActor.
// Also: DmDetail/ShareDetail fold conversationIds into viewedIds.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  conversationRows,
  isAgentSender,
} from '../../src/lib/quickWindowPane';
import type { Item, DmEvent, ShareEvent } from '../../src/lib/notificationGroups';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);

const paneSource = readFileSync(root('src/components/QuickWindowSidePane.svelte'), 'utf8');
const rowSource = readFileSync(root('src/components/NotificationRow.svelte'), 'utf8');
const dmDetailSource = readFileSync(root('src/components/DmDetail.svelte'), 'utf8');
const shareDetailSource = readFileSync(root('src/components/ShareDetail.svelte'), 'utf8');

function dmItem(
  id: string,
  ts: number,
  opts: {
    actor?: string;
    fromPersonUid?: string;
    body?: string;
  } = {},
): Item {
  const dm: DmEvent = {
    eventId: id.replace(/^dm:/, ''),
    fromPersonUid: opts.fromPersonUid ?? '',
    fromEmail: '',
    fromDisplayName: opts.actor ?? 'A',
    body: opts.body ?? 's',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  return {
    id,
    kind: 'dm',
    actor: opts.actor ?? 'A',
    summary: opts.body ?? 's',
    ts,
    dm,
  };
}

function shareItem(
  id: string,
  ts: number,
  opts: { actor?: string; issuerPersonUid?: string; summary?: string } = {},
): Item {
  const share: ShareEvent = {
    eventId: id.replace(/^share:/, ''),
    issuerEmail: '',
    issuerDisplayName: opts.actor ?? 'A',
    issuerPersonUid: opts.issuerPersonUid,
    paths: ['x'],
    note: null,
    permission: 'read',
    createdAt: '2026-01-01T00:00:00.000Z',
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

describe('US-016: side pane conversation grouping', () => {
  describe('behavioral: conversationRows groups by sender', () => {
    it('3 from Izzy + 2 from Lizzie → two rows, latest preview each, unread 3 and 2', () => {
      const items: Item[] = [
        dmItem('dm:i3', 500, {
          fromPersonUid: 'prs_izzy',
          actor: 'Izzy',
          body: 'izzy newest',
        }),
        dmItem('dm:l2', 400, {
          fromPersonUid: 'prs_lizzie',
          actor: 'Lizzie',
          body: 'lizzie newest',
        }),
        dmItem('dm:i2', 300, {
          fromPersonUid: 'prs_izzy',
          actor: 'Izzy',
          body: 'izzy mid',
        }),
        dmItem('dm:l1', 200, {
          fromPersonUid: 'prs_lizzie',
          actor: 'Lizzie',
          body: 'lizzie older',
        }),
        dmItem('dm:i1', 100, {
          fromPersonUid: 'prs_izzy',
          actor: 'Izzy',
          body: 'izzy oldest',
        }),
      ];
      const rows = conversationRows(items, 0, new Set());
      expect(rows).toHaveLength(2);
      expect(rows[0].key).toBe('dm:prs_izzy');
      expect(rows[0].latest.dm?.body).toBe('izzy newest');
      expect(rows[0].unreadCount).toBe(3);
      expect(rows[1].key).toBe('dm:prs_lizzie');
      expect(rows[1].latest.dm?.body).toBe('lizzie newest');
      expect(rows[1].unreadCount).toBe(2);
    });
  });

  describe('type distinction (source-contract)', () => {
    it('QuickWindowSidePane wires conversation rows with unread badge, agent mark, and type map', () => {
      // Selected conversation reads as caught-up: badge suppressed on the
      // active row (covers the opening event's default selection too).
      expect(paneSource).toContain(
        '{@const isSelected = selectedId != null && row.ids.includes(selectedId)}',
      );
      expect(paneSource).toContain('{@const unread = !isSelected && row.unreadCount > 0}');
      // Selecting a row hands the whole conversation to the main pane.
      expect(paneSource).toContain('onselect(row.latest, row.ids, row.items)');
      expect(paneSource).toContain('row.agent');
      expect(paneSource).toContain("data-kind={row.kind}");
      expect(paneSource).toContain('data-testid="unread-count"');
      expect(paneSource).toContain('conversationRows');
      expect(paneSource).toContain('No conversations');
      // Lizzie-style avatar rail (not dense one-line NotificationRow).
      expect(paneSource).toContain('class="qw-av"');
      expect(paneSource).toContain('initials(row.actor)');
    });

    it('NotificationRow exposes unread-count pill and type icons via data-type', () => {
      expect(rowSource).toContain('data-testid="unread-count"');
      expect(rowSource).toContain('data-type={type}');
      expect(rowSource).toContain("t === 'message'");
      expect(rowSource).toContain("t === 'share'");
    });
  });

  describe('agent marking', () => {
    it('isAgentSender: agt_ true, prs_ false', () => {
      expect(isAgentSender(dmItem('dm:a', 100, { fromPersonUid: 'agt_bot' }))).toBe(true);
      expect(isAgentSender(dmItem('dm:h', 100, { fromPersonUid: 'prs_izzy' }))).toBe(false);
      expect(
        isAgentSender(shareItem('share:a', 100, { issuerPersonUid: 'agent_helper' })),
      ).toBe(true);
      expect(
        isAgentSender(shareItem('share:h', 100, { issuerPersonUid: 'prs_lizzie' })),
      ).toBe(false);
    });

    it('NotificationRow renders agent-badge gated on agentActor', () => {
      expect(rowSource).toContain('data-testid="agent-badge"');
      expect(rowSource).toContain('agentActor');
      // Glyph only when agentActor is truthy (collapsed branch).
      expect(rowSource).toMatch(/\{#if agentActor\}[\s\S]*?data-testid="agent-badge"/);
    });
  });

  describe('viewed conversation marking', () => {
    it('DmDetail and ShareDetail fold conversationIds into viewedIds', () => {
      expect(dmDetailSource).toContain('...(conversationIds ?? [])');
      expect(shareDetailSource).toContain('...(conversationIds ?? [])');
      expect(dmDetailSource).toContain(
        'function onselect(item: Item, conversationIds?: string[], conversationItems?: Item[]): void',
      );
      expect(shareDetailSource).toContain(
        'function onselect(item: Item, conversationIds?: string[], conversationItems?: Item[]): void',
      );
    });

    it('grouped share rows keep every share reachable in the main pane', () => {
      // Codex review P1: collapsing shares must not orphan older share cards —
      // both quick windows render the full grouped share list, not just latest.
      for (const src of [dmDetailSource, shareDetailSource]) {
        expect(src).toContain('let selectedShareEvents = $state<ShareEvent[]>([]);');
        expect(src).toContain(
          '{@const shareEvents = selectedShareEvents.length > 0 ? selectedShareEvents : [selected.share]}',
        );
        expect(src).toContain('<ShareMainPane events={shareEvents} />');
        // Count label lives in header subtitle (template const or derived `n`).
        expect(src).toMatch(/shareEvents\.length|selectedShareEvents\.length/);
        expect(src.includes('share') && (src.includes("'' : 's'") || src.includes("n === 1"))).toBe(
          true,
        );
      }
    });
  });
});
