#!/usr/bin/env node

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const nativeParityDir = join(repo, "apps/native-macos/Parity");
const tauriMain = join(repo, "apps/sync/src-tauri/src/main.rs");
const frontendRoot = join(repo, "apps/sync/src");
const retainedContracts = JSON.parse(
  readFileSync(join(nativeParityDir, "retained-contracts.json"), "utf8"),
);

const walk = (directory, extensions) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path, extensions);
    return extensions.some((extension) => entry.name.endsWith(extension)) ? [path] : [];
  });

const readFrontend = () =>
  walk(frontendRoot, [".svelte", ".ts"]).map((path) => ({
    path,
    source: readFileSync(path, "utf8"),
  }));

const nativeCommandNames = new Set([
  "quit_app",
  "open_settings_window",
  "open_claude_code_link",
  "launch_claude_code",
  "launch_cli_in_terminal",
  "reveal_folder",
  "open_new_files_detail",
  "detail_window_ready",
  "pick_folder",
  "get_autostart_enabled",
  "set_autostart_enabled",
  "set_tray_state",
  "check_for_updates",
  "get_pending_update",
  "install_update",
  "available_channels",
  "open_drift_detail",
  "drift_window_ready",
  "open_packages_window",
  "packages_window_ready",
  "open_activity_log",
  "activity_window_ready",
  "open_meetings_window",
  "permissions_open_settings",
  "permissions_force_native_register",
  "meetings_permissions_state",
  "open_meeting_permissions_window",
  "meetings_set_prompt_badge",
  "open_desktop_alt_window",
  "open_share_detail",
  "share_detail_window_ready",
  "open_dm_detail",
  "open_inbox_window",
  "dm_detail_window_ready",
  "open_messages_window",
  "messages_window_ready",
  "open_notification_history",
  "notification_permission_state",
  "notification_request_permission",
  "banner_window_ready",
  "banner_action",
  "dismiss_banner",
  "resize_banner",
  "show_main_window",
  "preview_dm_banner",
  "preview_share_banner",
  "preview_update_banner",
  "preview_meeting_banner",
  "resize_widget",
  "set_widget_focusable",
  "widget_ready",
  "list_displays",
  "apply_widget_settings",
  "home_dir",
  "launch_menubar_app",
  "menubar_installed",
  "launch_claude_desktop",
  "launch_codex_desktop",
  "claude_desktop_installed",
  "open_developer_settings",
  "keychain_delete",
  "keychain_get",
  "keychain_set",
  "meetings_clear_prompt_badge",
  "meetings_take_pending_focus",
  "open_in_editor",
  "pick_avatar_file",
  "pick_pack_directory",
  "set_main_window_vibrancy",
  "show_main_window_at_tray",
]);

const nativeCommandReplacements = new Map([
  [
    "meetings_clear_prompt_badge",
    "HQNativeActionRegistry.clearMeetingPromptBadge + HQAppStore saturating badge state",
  ],
  [
    "meetings_take_pending_focus",
    "HQNativeActionRegistry.takePendingMeetingFocus + HQAppStore one-shot scene focus state",
  ],
  [
    "open_in_editor",
    "HQAppStore.validatedWorkspaceURL + NSWorkspace default application",
  ],
  [
    "pick_avatar_file",
    "HQNativeFilePicker NSOpenPanel file-only image UTI selection",
  ],
  [
    "pick_pack_directory",
    "HQNativeFilePicker NSOpenPanel folder-only selection",
  ],
  [
    "set_main_window_vibrancy",
    "HQAppStore.mainWindowVibrancyEnabled + NSVisualEffectView material",
  ],
  [
    "show_main_window_at_tray",
    "HQNativeApp MenuBarExtra + HQAppStore.showMainWindowAtTray activation",
  ],
]);

const windowsOnlyCommandNames = new Set([
  "is_long_paths_enabled",
  "enable_long_paths",
  "open_long_paths_settings",
  "install_pnpm",
  "install_rsync",
  "ensure_shims",
  "add_claude_trusted_folder",
]);

const protocolCommandNames = new Set([
  "desktop_alt_dev_audit_render",
  "desktop_alt_consume_pending_route",
]);

const retiredCommandReplacements = new Map([
  [
    "import_existing_setup",
    "Retired: the legacy command is an explicit unwired TODO/no-op",
  ],
  [
    "install_menubar_app",
    "Retired: the unified native app already ships its MenuBarExtra",
  ],
]);

const nativeEventReplacements = new Map([
  ["desktop:navigate", "HQAppAction + HQRouteParser"],
  ["dm:detail-event", "HQSecondaryWindowActionRegistry + HQAppStore scene state"],
  ["dm:inbox-open", "HQSecondaryWindowActionRegistry + HQAppStore scene state"],
  ["meetings-window:action", "HQSecondaryWindowActionRegistry + HQAppStore scene state"],
  ["meetings-window:request-snapshot", "HQSecondaryWindowActionRegistry + HQAppStore scene state"],
  ["meetings:focus-meeting", "HQSecondaryWindowActionRegistry + HQAppStore scene state"],
  ["messages:open-conversation", "HQSecondaryWindowActionRegistry + HQAppStore scene state"],
  ["notification:banner-action", "HQAppStore typed notification action reducer"],
  ["notification:dm-action", "HQAppStore typed notification action reducer"],
  ["notification:meeting-action", "HQAppStore typed notification action reducer"],
  ["notification:share-action", "HQAppStore typed notification action reducer"],
  ["popover:meetings-snapshot", "HQSecondaryWindowActionRegistry + HQAppStore scene state"],
  ["popover:opened", "MenuBarExtra scene lifecycle"],
  ["tray:check-for-updates", "HQAppAction + HQNativeUpdaterService"],
  ["tray:open-desktop", "HQAppAction + SwiftUI openWindow"],
  ["tray:open-settings", "HQAppAction + SwiftUI Settings scene"],
  ["tray:sign-out", "HQAppAction + HQAppStore"],
  ["tray:sync-now", "HQAppAction + HQAppStore"],
  ["update:available", "HQNativeUpdaterService.onStateChange"],
]);

const retiredEventReplacements = new Map([
  [
    "sync:conflict",
    "Retired: the current sync runner reports aggregate conflicts via sync:complete { conflicts, aborted } and no longer emits per-file hashes",
  ],
]);

function extractRegisteredCommands(source) {
  const startToken = ".invoke_handler(tauri::generate_handler![";
  const start = source.indexOf(startToken);
  if (start < 0) throw new Error("Could not find Tauri invoke handler");
  const end = source.indexOf("])", start);
  if (end < 0) throw new Error("Could not find end of Tauri invoke handler");

  return source
    .slice(start + startToken.length, end)
    .replace(/\/\/.*$/gm, "")
    .replace(/#\[cfg\([^\]]+\)\]/g, "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => /^(commands|tray|updater)::/.test(entry))
    .map((entry) => {
      const segments = entry.split("::");
      return {
        symbol: entry,
        module: segments.slice(0, -1).join("::"),
        name: segments.at(-1),
      };
    });
}

function extractFrontendContracts(frontend) {
  const commands = new Map();
  const events = new Map();

  for (const file of frontend) {
    const relativePath = relative(repo, file.path);
    const invokePattern = /\binvoke(?:<[^>]*>)?\(\s*["'`]([^"'`]+)["'`]/g;
    const listenPattern = /\blisten(?:<[^>]*>)?\(\s*["'`]([^"'`]+)["'`]/g;

    for (const match of file.source.matchAll(invokePattern)) {
      const paths = commands.get(match[1]) ?? new Set();
      paths.add(relativePath);
      commands.set(match[1], paths);
    }
    for (const match of file.source.matchAll(listenPattern)) {
      const paths = events.get(match[1]) ?? new Set();
      paths.add(relativePath);
      events.set(match[1], paths);
    }
  }

  return { commands, events };
}

const mainSource = readFileSync(tauriMain, "utf8");
const sourceRegistered = extractRegisteredCommands(mainSource);
const sourceRegisteredNames = new Set(
  sourceRegistered.map((command) => command.name),
);
const registered = [
  ...sourceRegistered,
  ...retainedContracts.commands.filter(
    (command) => !sourceRegisteredNames.has(command.name),
  ),
];
const frontend = extractFrontendContracts(readFrontend());
const retainedCommandsByName = new Map(
  retainedContracts.commands.map((command) => [command.name, command]),
);
const retainedEventsByName = new Map(
  retainedContracts.events.map((event) => [event.name, event]),
);

const commands = registered
  .map((command) => {
    const retained = retainedCommandsByName.get(command.name);
    const disposition =
      retained?.disposition ??
      (windowsOnlyCommandNames.has(command.name)
        ? "windows-only"
        : nativeCommandNames.has(command.name)
          ? "native"
          : protocolCommandNames.has(command.name) ||
              retiredCommandReplacements.has(command.name)
            ? "retired"
            : "engine");
    const frontendCallers = new Set([
      ...(frontend.commands.get(command.name) ?? []),
      ...(retained?.frontendCallers ?? []),
    ]);

    return {
      symbol: command.symbol,
      module: command.module,
      name: command.name,
      disposition,
      frontendCallers: [...frontendCallers].sort(),
      nativeReplacement:
        retained?.nativeReplacement ??
        retiredCommandReplacements.get(command.name) ??
        nativeCommandReplacements.get(command.name) ??
        (disposition === "native"
          ? "SwiftUI/AppKit platform service"
          : disposition === "retired"
            ? "Native navigation and test harness"
            : null),
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

const registeredNames = new Set(commands.map((command) => command.name));
const frontendOnlyCommands = [...frontend.commands.entries()]
  .filter(([name]) => !registeredNames.has(name))
  .map(([name, paths]) => ({
    name,
    disposition: "investigate",
    frontendCallers: [...paths].sort(),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

const eventNames = new Set([
  ...frontend.events.keys(),
  ...retainedContracts.events.map((event) => event.name),
]);
const events = [...eventNames]
  .map((name) => {
    const retained = retainedEventsByName.get(name);
    const paths = new Set([
      ...(frontend.events.get(name) ?? []),
      ...(retained?.frontendListeners ?? []),
    ]);
    return {
      name,
      disposition:
        retained?.disposition ??
        (retiredEventReplacements.has(name)
          ? "retired"
          : nativeEventReplacements.has(name) ||
              name.startsWith("tauri://") ||
              name.startsWith("window:") ||
              name.startsWith("banner:") ||
              name.startsWith("widget:")
            ? "native"
            : "engine"),
      frontendListeners: [...paths].sort(),
      nativeReplacement:
        retained?.nativeReplacement ??
        retiredEventReplacements.get(name) ??
        nativeEventReplacements.get(name) ??
        (name.startsWith("tauri://") ||
        name.startsWith("window:") ||
        name.startsWith("banner:") ||
        name.startsWith("widget:")
          ? "SwiftUI/AppKit platform event"
          : null),
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

mkdirSync(nativeParityDir, { recursive: true });
writeFileSync(
  join(nativeParityDir, "commands.json"),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source: "apps/sync/src-tauri/src/main.rs",
      retainedContracts: retainedContracts.provenance,
      registeredCount: commands.length,
      frontendOnlyCount: frontendOnlyCommands.length,
      commands,
      frontendOnlyCommands,
    },
    null,
    2,
  )}\n`,
);
writeFileSync(
  join(nativeParityDir, "events.json"),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source: "apps/sync/src/**/*.{svelte,ts}",
      retainedContracts: retainedContracts.provenance,
      listenerCount: events.length,
      events,
    },
    null,
    2,
  )}\n`,
);

console.log(
  JSON.stringify({
    registeredCommands: commands.length,
    frontendCommands: frontend.commands.size,
    frontendOnlyCommands: frontendOnlyCommands.length,
    frontendEvents: events.length,
    output: relative(repo, nativeParityDir),
  }),
);
