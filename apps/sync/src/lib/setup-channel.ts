import type { Channel } from './channels';

/** Wire id the backend / Slack support bridge routes on. */
export const SETUP_CHANNEL_ID = 'setup';

/**
 * Synthetic client-side pinned channel. `setup` is the wire `channelId` the
 * backend / Slack support bridge routes on — not a server-listed HQ channel
 * until one exists. The rail injects this row; the composer still sends
 * through `send_channel_message` with this id.
 */
export const SETUP_CHANNEL: Channel = {
  channelId: SETUP_CHANNEL_ID,
  name: 'setup',
  scope: 'personal',
  membership: 'joined',
};

/**
 * CONFIG — launch actions on the #setup pane. Adjust prompts here; keep
 * `grok.tool` inside the `launch_cli_in_terminal` allowlist.
 *
 * Terminal tools are interpolated into a shell by
 * `src-tauri/src/commands/launch.rs` (`cli_binary_for`). That allowlist is
 * currently `claude` | `codex` | `grok`. Widen the Rust match first if you
 * add another terminal tool here — the frontend constant is not the
 * security boundary.
 */
export const SETUP_LAUNCH_COMMANDS = {
  claude: { kind: 'claude' as const, prompt: '/setup' },
  codex: { kind: 'codex' as const, prompt: '/setup' },
  grok: { kind: 'terminal' as const, tool: 'grok' as const },
} as const;

export type SetupLaunchCommandKey = keyof typeof SETUP_LAUNCH_COMMANDS;

export interface SetupWelcomeLink {
  label: string;
  href: string;
}

export interface SetupWelcomeMessage {
  id: string;
  title?: string;
  body: string;
  links?: readonly SetupWelcomeLink[];
}

/** Prepopulated getting-started sequence rendered above the live #setup thread. */
export const SETUP_WELCOME_MESSAGES: readonly SetupWelcomeMessage[] = [
  {
    id: 'what-is-hq-desktop',
    title: 'What HQ Desktop is',
    body: 'HQ Desktop is the companion app for the HQ team AI operating system — messaging, sync, agents, and shared files in one place.',
  },
  {
    id: 'get-started',
    title: 'How to get started',
    body: 'Open your HQ folder, run /setup in Claude Code or Codex, then connect your team. The buttons below launch that prompt for you.',
  },
  {
    id: 'resources',
    title: 'Resources',
    body: 'Guides, concepts, and the rest of the HQ surface live in the docs.',
    links: [{ label: 'HQ Docs', href: 'https://docs.getindigo.ai' }],
  },
  {
    id: 'support-channel',
    title: 'This is a support channel',
    body: 'Messages typed here reach the HQ team. Ask anything about setup, sync, or getting your workspace running.',
  },
];

export function isSetupChannel(id: string | null | undefined): boolean {
  return id === SETUP_CHANNEL_ID;
}
