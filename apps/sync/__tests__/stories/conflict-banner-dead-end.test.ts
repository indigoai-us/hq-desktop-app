import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Sync conflicts have no desktop surface (owner decision 2026-10-13). The
// cloud copy stays live and the local copy is parked by the runner, so an
// aborted run must not turn into a conflict tray icon, a conflict sync state,
// or a resolve prompt. The journal's conflict count stays diagnostic only.

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const normalize = (s: string) => s.replace(/\s+/g, ' ');

const app = read('src/App.svelte');

describe('parked conflicts: the aborted run has no conflict surface', () => {
  it('App never turns an aborted sync:complete into a conflict state or tray icon', () => {
    const a = normalize(app);
    expect(a).not.toContain("syncState = 'conflict'");
    expect(a).not.toContain("state: 'conflict'");
    expect(a).not.toContain('if (event.payload.aborted) {');
  });

  it('App no longer keeps a second copy of the conflict accounting', () => {
    // The desktop window reads the aggregate from `get_sync_status`, so a
    // renderer-side count here would be a second, drifting model of the same
    // fact (PL-01 / PL-02).
    expect(app).not.toContain('syncConflictCount');
    expect(app).not.toContain('syncConflictCompany');
  });
});
