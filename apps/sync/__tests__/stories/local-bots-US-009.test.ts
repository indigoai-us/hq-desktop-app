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
import { SETTINGS_SECTIONS, resolvePendingDesktopRoute } from '../../src/desktop-alt/route';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);
const source = (...parts: string[]) => readFileSync(root(...parts), 'utf8');

describe('US-009: Settings → Bots', () => {
  // The live desktop Settings surface is @hq/ui's ShellSettings (Work shell),
  // not the desktop-alt SettingsPage — the pane must be wired there or the
  // user never sees it (verified by opening the built app, 2026-09-11).
  const ui = (...parts: string[]) => source('..', '..', 'packages', 'ui', 'src', ...parts);

  it('is a routable settings tab (the host parses settings:bots through desktop-alt route.ts)', () => {
    expect(SETTINGS_SECTIONS).toContainEqual({ id: 'bots', label: 'Bots' });
    expect(resolvePendingDesktopRoute('settings:bots')).toEqual({ kind: 'settings', tab: 'bots' });
  });

  it('is a first-class ShellSettings nav item right after Agents, gated on the desktop bots adapter', () => {
    const shell = ui('settings', 'ShellSettings.svelte');
    expect(shell).toContain('{ id: "agents", label: "Agents" },\n      { id: "bots", label: "Bots" },');
    expect(shell).toContain('if (section.id === "bots") return Boolean(adapter?.bots);');
    expect(shell).toContain('<BotsSettingsPane {adapter} />');
    expect(ui('shell', 'embedded-navigation.ts')).toContain("'bots',");
    expect(ui('settings', 'SettingsNavIcon.svelte')).toContain('name === "bots"');
  });

  it('lists bots with runtime, online state and last heartbeat, and offers Create / Start / Stop / Remove through the adapter', () => {
    const panel = ui('settings', 'BotsSettingsPane.svelte');
    expect(panel).toContain('data-testid="settings-bots"');
    expect(panel).toContain('await api.list()');
    expect(panel).toContain('await api.create({ name, runtime: newRuntime })');
    expect(panel).toContain('await api[verb](name)');
    expect(panel).toContain('act(bot.name, "start")');
    expect(panel).toContain('act(bot.name, "stop")');
    expect(panel).toContain('act(bot.name, "remove")');
    expect(panel).toContain('heartbeatLabel(bot)');
    expect(panel).toContain('runtimeLabel(bot.runtime)');
    expect(panel).toContain('presenceLabel(bot)');
    expect(panel).toContain('Really remove');
    expect(panel).toContain('const MAX_BOTS = 3');
    expect(panel).not.toContain("from '@tauri-apps/api/core'");
  });

  it('every bot action shells to the hq CLI through the launch boundary, never hq-pro directly', () => {
    const rust = source('src-tauri/src/commands/bots.rs');
    expect(rust).toContain('paths::resolve_bin("hq")');
    expect(rust).toContain('paths::tokio_spawn_command');
    expect(rust).toContain('.env("PATH", paths::child_path())');
    expect(rust).toContain('argv.push("--json")');
    expect(rust).toContain('["create", &name, "--runtime", runtime]');
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

  it('the sidebar shows an online/offline dot on a local bot DM row from the server verdict', () => {
    const sidebar = ui('chat', 'ChatSidebar.svelte');
    expect(sidebar).toContain('dmPresence?: (row: ConversationRow) => "online" | "offline" | null;');
    expect(sidebar).toContain('data-testid="chat-bot-presence-dot"');
    expect(sidebar).toContain('class:offline={botPresence === "offline"}');
    const shell = ui('shell', 'DesktopApp.svelte');
    expect(shell).toContain('dmPresence={(row) => localBotPresence(localBots, row)}');
    expect(shell).toContain('LOCAL_BOTS_POLL_MS');
  });

  it('an offline bot thread shows the one-line notice with a Start button that starts it via the host', () => {
    const shell = ui('shell', 'DesktopApp.svelte');
    expect(shell).toContain('data-testid="local-bot-offline-notice"');
    expect(shell).toContain('data-testid="local-bot-start"');
    expect(shell).toContain('localBotOfflineNotice(selectedLocalBot)');
    expect(shell).toContain('api.start(bot.name)');
    expect(shell).toContain('? localBotHeader');
  });

  it('the sync adapter the Work shell actually uses (createSyncPlatformAdapter) exposes bots', () => {
    // The shell is built on createSyncPlatformAdapter, not TauriPlatformAdapter —
    // without this group the Bots nav item is filtered out (seen live 2026-09-11).
    const sync = source('..', '..', 'packages', 'platform', 'src', 'tauri', 'sync-adapter.ts');
    expect(source('src/desktop-alt/HqWorkWorkShell.svelte')).toContain('createSyncPlatformAdapter');
    expect(sync).toContain("list: () => call('local_bots_list')");
    expect(sync).toContain("call('local_bots_create'");
    // Every create setting has to be forwarded: pinning the old two-field
    // one-liner here is what let `intro` and `memory` go missing unnoticed
    // (live 2026-09-12). The behavioural cover is
    // packages/platform/src/tauri/sync-adapter-bots.test.ts.
    for (const field of ['name', 'runtime', 'model', 'autoApprove', 'worker', 'intro', 'memory']) {
      expect(sync).toContain(`${field}: input.${field}`);
    }
    expect(sync).toContain("remove: (name) => call('local_bots_remove', { name })");
  });

  it('the platform contract exposes bots as a desktop-only optional group backed by the Tauri commands', () => {
    const adapter = source('..', '..', 'packages', 'platform', 'src', 'adapter.ts');
    expect(adapter).toContain('export interface LocalBotsApi');
    expect(adapter).toContain('readonly bots?: LocalBotsApi;');
    const tauri = source('..', '..', 'packages', 'platform', 'src', 'tauri', 'index.ts');
    expect(tauri).toContain('this.call("local_bots_list")');
    expect(tauri).toContain('this.call("local_bots_create"');
  });
});
