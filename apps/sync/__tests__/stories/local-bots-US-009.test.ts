/**
 * local-bots US-009 — Bot in the desktop app: DM presence, offline notice with
 * Start, and a Bots section in Settings that drives the hq CLI through the
 * host launch boundary (never a CLI command for the user).
 *
 * Source contracts over the real files (the shell's DM/presence behaviour is
 * exercised by @hq/ui's own component tests; this pins the wiring).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);
const source = (...parts: string[]) => readFileSync(root(...parts), 'utf8');

describe('US-009: Settings → Bots', () => {
  // The live desktop Settings surface is @hq/ui's ShellSettings (Work shell),
  // not the desktop-alt SettingsPage — the pane must be wired there or the
  // user never sees it (verified by opening the built app, 2026-09-11).
  const ui = (...parts: string[]) => source('..', '..', 'packages', 'ui', 'src', ...parts);

  it('every bot action shells to the hq CLI through the launch boundary, never hq-pro directly', () => {
    const rust = source('src-tauri/src/commands/bots.rs');
    expect(rust).toContain('paths::resolve_bin("hq")');
    expect(rust).toContain('paths::tokio_spawn_command');
    expect(rust).toContain('.env("PATH", paths::child_path())');
    expect(rust).toContain('argv.push("--json")');
    expect(rust).toContain('vec!["create".to_string(), name, "--runtime".to_string(), runtime.to_string()]');
    expect(rust).toContain('["rm", &name, "--yes"]');
    expect(rust).not.toContain('hq_pro_fetch');
    const main = source('src-tauri/src/main.rs');
    for (const cmd of ['local_bots_list', 'local_bots_create', 'local_bots_start', 'local_bots_stop', 'local_bots_remove']) {
      expect(main).toContain(`commands::bots::${cmd},`);
    }
  });
});

describe('US-009: bot presence in the DM list and thread', () => {
  const ui = (...parts: string[]) => source('..', '..', 'packages', 'ui', 'src', ...parts);

  it('the platform contract exposes bots as a desktop-only optional group backed by the Tauri commands', () => {
    const adapter = source('..', '..', 'packages', 'platform', 'src', 'adapter.ts');
    expect(adapter).toContain('export interface LocalBotsApi');
    expect(adapter).toContain('readonly bots?: LocalBotsApi;');
    const tauri = source('..', '..', 'packages', 'platform', 'src', 'tauri', 'index.ts');
    expect(tauri).toContain('this.call("local_bots_list")');
    expect(tauri).toContain('this.call("local_bots_create"');
  });
});
