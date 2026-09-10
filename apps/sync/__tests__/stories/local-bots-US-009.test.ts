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
  it('is a routed Settings section next to Agents', () => {
    expect(SETTINGS_SECTIONS).toContainEqual({ id: 'bots', label: 'Bots' });
    expect(resolvePendingDesktopRoute('settings:bots')).toEqual({ kind: 'settings', tab: 'bots' });
    expect(source('src/desktop-alt/pages/SettingsPage.svelte')).toContain('<LocalBotsSettings />');
  });

  it('lists bots with runtime, online state and last heartbeat, and offers Create / Start / Stop / Remove', () => {
    const panel = source('src/desktop-alt/components/LocalBotsSettings.svelte');
    expect(panel).toContain('data-testid="settings-bots"');
    expect(panel).toContain("invoke<{ bots?: BotRow[] }>('local_bots_list')");
    expect(panel).toContain("invoke('local_bots_create'");
    expect(panel).toContain("'local_bots_start'");
    expect(panel).toContain("'local_bots_stop'");
    expect(panel).toContain("'local_bots_remove'");
    expect(panel).toContain('heartbeatLabel(bot)');
    expect(panel).toContain('runtimeLabel(bot.runtime)');
    expect(panel).toContain('presenceLabel(bot)');
    expect(panel).toContain('Really remove');
    expect(panel).toContain('const MAX_BOTS = 3');
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

  it('the platform contract exposes bots as a desktop-only optional group backed by the Tauri commands', () => {
    const adapter = source('..', '..', 'packages', 'platform', 'src', 'adapter.ts');
    expect(adapter).toContain('export interface LocalBotsApi');
    expect(adapter).toContain('readonly bots?: LocalBotsApi;');
    const tauri = source('..', '..', 'packages', 'platform', 'src', 'tauri', 'index.ts');
    expect(tauri).toContain('this.call("local_bots_list")');
    expect(tauri).toContain('this.call("local_bots_create"');
  });
});
