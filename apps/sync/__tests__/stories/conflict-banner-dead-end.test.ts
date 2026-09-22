import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Conflict dead-end fix: when a sync is conflict-aborted, this window reads
// conflicts in aggregate only (`sync:complete {conflicts, aborted}`) — it does
// not subscribe to the runner's per-file `sync:conflict` stream, so the
// per-file ConflictModal never populates here. Previously the conflict state was a silent dead-end: the
// tray went red and the UI showed NOTHING actionable.
//
// PL-07 moved the actionable half of this out of the tray window. The tray
// window still turns the aborted run into the conflict tray state; the
// resolve-in-Claude-Code / Copy-prompt notice lives in the desktop window's
// Core popover and is covered by packages/ui/src/home/CorePopover.sync-notices.test.ts
// ("renders the conflict notice with Resolve and Copy prompt") and
// core-popover-sync.test.ts ("reads Sync paused when conflicts exist").

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const normalize = (s: string) => s.replace(/\s+/g, ' ');

const app = read('src/App.svelte');

describe('conflict dead-end: the aborted run still reaches the user', () => {
  it('App turns an aborted sync:complete into the conflict state and the conflict tray icon', () => {
    const a = normalize(app);
    expect(a).toContain('if (event.payload.aborted) {');
    expect(a).toMatch(
      /if \(event\.payload\.aborted\) \{[^}]*syncState = 'conflict'; await invoke\('set_tray_state', \{ state: 'conflict' \}\);/,
    );
  });

  it('App no longer keeps a second copy of the conflict accounting', () => {
    // The desktop window reads the aggregate from `get_sync_status`, so a
    // renderer-side count here would be a second, drifting model of the same
    // fact (PL-01 / PL-02).
    expect(app).not.toContain('syncConflictCount');
    expect(app).not.toContain('syncConflictCompany');
  });
});
