/**
 * signals-local-meetings-v1 US-010 acceptance tests (UI half): one describe
 * per acceptance criterion (ac0..ac5). The Rust half (store reading, citation
 * resolution, history) is in
 * src-tauri/src/local_signals/signals_local_meetings_v1_us010_acceptance.rs.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SIGNAL_TYPE_LABELS,
  SIGNAL_TYPE_ORDER,
  UPLOAD_BADGE_LABELS,
  citationError,
  emptyRowUi,
  resultGroupsView,
  resultItemView,
  signalsRowView,
  type MeetingSignalsStatus,
  type ResultItem,
  type ResultVersion,
  type UploadBadge,
} from './localMeetingSignals';

const SRC = readFileSync(resolve(__dirname, '../components/MeetingsWindow.svelte'), 'utf8');
const RESULTS_SNIPPETS = SRC.slice(SRC.indexOf('{#snippet signalsVersion'), SRC.indexOf('{#snippet companyAssign'));

function item(over: Partial<ResultItem> = {}): ResultItem {
  return {
    observationId: 'a'.repeat(64),
    signalType: 'decision',
    content: 'Ship the Atlas beta on November 3.',
    citations: [{ startMs: 0, endMs: 4000, label: '0:00', valid: true }],
    entities: [
      { name: 'Atlas', entityId: 'ent-project-atlas', provisional: false },
      { name: 'Globex', entityId: null, provisional: true },
    ],
    owner: null,
    reasoning: 'Legal cleared the beta terms.',
    speaker: null,
    provider: 'codex',
    model: 'gpt-5-codex',
    projectionState: 'stale',
    upload: 'uploaded',
    ...over,
  };
}

function version(items: ResultItem[], over: Partial<ResultVersion> = {}): ResultVersion {
  return {
    status: 'complete',
    promptVersion: 'local-signals-prompt/v1',
    schemaVersion: 'local-signal/v1',
    currentTranscript: true,
    groups: SIGNAL_TYPE_ORDER.map((t) => ({ signalType: t, items: items.filter((i) => i.signalType === t) })),
    missing: 0,
    ...over,
  };
}

const complete: MeetingSignalsStatus = {
  enabled: true,
  eligible: true,
  ineligibleReason: null,
  run: null,
  localComplete: true,
  upload: { total: 1, uploaded: 1, created: 1, unchanged: 0, repaired: 0, conflict: 0, ineligible: 0, blocked: 0, disabled: 0, retryable: 0, reasons: [], sent: 1 },
};

describe('US-010 ac0: results come from the personal store, grouped by all eight types', () => {
  it('renders every type in canonical order, including empty ones', () => {
    const groups = resultGroupsView(version([item(), item({ observationId: 'b'.repeat(64), signalType: 'risk', content: 'Risk.' })]));
    expect(groups.map((g) => g.signalType)).toEqual([...SIGNAL_TYPE_ORDER]);
    expect(groups.map((g) => g.label)).toEqual(SIGNAL_TYPE_ORDER.map((t) => SIGNAL_TYPE_LABELS[t]));
    expect(groups.find((g) => g.signalType === 'decision')!.items).toHaveLength(1);
    expect(groups.find((g) => g.signalType === 'summary')!.items).toHaveLength(0);
    expect(RESULTS_SNIPPETS).toContain('None found.');
  });

  it('the row reads results only through meeting_signals_results', () => {
    expect(SRC).toContain("invoke<MeetingResults>('meeting_signals_results', signalsArgs(bot))");
    expect(signalsRowView(complete, emptyRowUi()).actions.map((a) => a.label)).toContain('View signals');
    expect(signalsRowView(complete, emptyRowUi(), true).actions.map((a) => a.label)).toContain('Hide signals');
  });
});

describe('US-010 ac1: each result shows content, citations, entities, provider, projection, upload', () => {
  it('builds the visible fields', () => {
    const v = resultItemView(item());
    expect(v.content).toBe('Ship the Atlas beta on November 3.');
    expect(v.detail).toBe('Why: Legal cleared the beta terms.');
    expect(v.citations.map((c) => c.label)).toEqual(['0:00']);
    expect(v.entities).toEqual([
      { label: 'Atlas', title: 'ent-project-atlas', provisional: false },
      { label: 'Globex (new)', title: 'Not yet in your company’s records', provisional: true },
    ]);
    expect(v.source).toBe('Codex · stale company context');
    expect(v.upload).toBe('Shared with your company');
    expect(resultItemView(item({ provider: 'claude', projectionState: 'ready' })).source).toBe('Claude');
    expect(resultItemView(item({ signalType: 'action_item', owner: 'Ben' })).detail).toBe('Owner: Ben');
    expect(resultItemView(item({ signalType: 'participant_contribution', speaker: 'Ava' })).detail).toBe('Speaker: Ava');
  });

  it('the markup renders each field', () => {
    for (const part of ['item.content', 'item.detail', 'cite.label', 'entity.label', 'item.source', 'item.upload']) {
      expect(RESULTS_SNIPPETS).toContain(part);
    }
  });
});

describe('US-010 ac2: citations open the local transcript and never a raw path or URL', () => {
  it('only valid citations in the current version are selectable', () => {
    expect(RESULTS_SNIPPETS).toMatch(/\{#if live && cite\.valid\}\s*<button/);
    expect(RESULTS_SNIPPETS).toContain('onclick={() => showCitation(bot, item.observationId, index)}');
  });

  it('the citation call sends ids only and opens nothing outside Meetings', () => {
    const fn = SRC.slice(SRC.indexOf('async function showCitation'), SRC.indexOf('async function showCitation') + 900);
    expect(fn).toContain("invoke<string[]>('meeting_signals_citation', { ...signalsArgs(bot), observationId, index })");
    for (const bad of ['openExternal', 'openApprovedExternalUrl', 'open_cloud_file', 'reveal', 'path:', 'url']) {
      expect(fn).not.toContain(bad);
    }
    expect(citationError('citation_invalid: /etc/passwd')).toBe('This citation can’t be shown.');
  });
});

describe('US-010 ac3: superseded results stay in history, out of the default set', () => {
  it('history is collapsed by default and rendered without live citations', () => {
    expect(SRC).toMatch(/\{#if results\.current\}\s*\{@render signalsVersion\(bot, resultGroupsView\(results\.current\), true\)\}/);
    expect(SRC).toMatch(/\{#if signalsHistoryOpen\[bot\.botId\]\}\s*\{#each results\.history as version, i \(i\)\}\s*\{@render signalsVersion\(bot, resultGroupsView\(version\), false\)\}/);
    expect(SRC).toContain('`Earlier versions (${results.history.length})`');
  });
});

describe('US-010 ac4: upload states are distinguishable without raw errors or sanitizer removals', () => {
  it('every badge has distinct plain copy', () => {
    const badges: UploadBadge[] = ['pending', 'uploaded', 'private', 'ineligible', 'retry', 'off', 'conflict'];
    const labels = badges.map((b) => resultItemView(item({ upload: b })).upload);
    expect(new Set(labels).size).toBe(badges.length);
    expect(labels).toEqual(badges.map((b) => UPLOAD_BADGE_LABELS[b]));
    for (const l of labels) {
      expect(l).not.toMatch(/sanitiz|reason|error|422|403|409|source_ineligible|transport|removed/i);
    }
  });
});

describe('US-010 ac5: stays inside Meetings', () => {
  it('results render as a list item under the row, with no new surface or navigation', () => {
    const past = SRC.slice(SRC.indexOf('{#each pastMeetingRows as row'));
    expect(past).toMatch(/\{#if signalsExpanded\[row\.bot\.botId\]\}\s*\{@render signalsResults\(row\.bot\)\}/);
    expect(RESULTS_SNIPPETS).toContain('<li class="signals-results"');
    for (const bad of ['<dialog', 'modal', 'banner', 'goto(', 'navigate', 'open_destination', 'company view', 'team view', 'canonical']) {
      expect(RESULTS_SNIPPETS.toLowerCase()).not.toContain(bad);
    }
  });

  it('the result styles keep the Corey UI constraints', () => {
    const style = SRC.slice(SRC.indexOf('.signals-results {'));
    const css = style.slice(0, style.indexOf('.signals-excerpt {') + 220);
    expect(css).not.toMatch(/border-left|box-shadow|border-radius:\s*[1-9]/);
    for (const m of css.matchAll(/font-weight:\s*(\d+)/g)) expect(Number(m[1])).toBeLessThanOrEqual(500);
  });
});
