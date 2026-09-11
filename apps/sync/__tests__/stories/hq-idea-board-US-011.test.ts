import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { citedLabel } from '../../src/lib/ideas-cited-label';

// hq-idea-board / US-011 — qmd indexing sidecar + agent citation counter.
//
// Scope note: the board card that renders the badge is US-009 and is not built
// yet, so "the card shows 'Cited 2× by agents'" is testable today only as the
// label helper's contract — that is what is asserted here. The rest of this
// file pins the Tauri/CLI wiring from disk (the `src-tauri` crate has no lib
// target, so its command cannot be linked from a test), while the persistence
// behaviour lives in
// crates/hq-desktop-core/tests/hq-idea-board-us-011-sidecar-citation.rs.

const appRoot = resolve(__dirname, '../..');

describe('hq-idea-board US-011: citation label and ideas_mark_cited wiring', () => {
  it('renders the agent citation badge label', () => {
    expect(citedLabel(2)).toBe('Cited 2× by agents');
    expect(citedLabel(1)).toBe('Cited 1× by agents');
    // U+00D7, not the ASCII letter x — matches the capture.md line.
    expect(citedLabel(2)).not.toBe('Cited 2x by agents');
  });

  it('shows no badge until an agent has actually cited the capture', () => {
    expect(citedLabel(0)).toBeNull();
    expect(citedLabel(-3)).toBeNull();
    expect(citedLabel(Number.NaN)).toBeNull();
  });

  it('declares ideas_mark_cited in the webview capability description', () => {
    const capability = JSON.parse(
      readFileSync(resolve(appRoot, 'src-tauri/capabilities/default.json'), 'utf8'),
    );
    expect(capability.description).toContain('ideas_mark_cited');
  });

  it('registers the command and the local CLI bridge flag', () => {
    const main = readFileSync(resolve(appRoot, 'src-tauri/src/main.rs'), 'utf8');
    expect(main).toContain('commands::capture::ideas_mark_cited');
    expect(main).toContain('ideas_mark_cited_id_from_argv');

    const capture = readFileSync(resolve(appRoot, 'src-tauri/src/commands/capture.rs'), 'utf8');
    expect(capture).toContain('IDEAS_MARK_CITED_FLAG');
    expect(capture).toContain('--ideas-mark-cited');
  });
});
